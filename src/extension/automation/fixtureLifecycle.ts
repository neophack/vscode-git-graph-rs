import * as fs from 'fs';
import * as path from 'path';
import { FIXTURE_SUBMODULE_PATH, git, seedRepo } from './fixture';
import { HostBridge } from './hostBridge';

/**
 * The fixture clone's lifecycle: recognising a fixture clone (the `.gg-fixture` marker), removing
 * directory trees across Windows file locks, and the in-place reseed that resets a mutated clone
 * to its pristine seeded state. Kept separate from the suite runner's orchestration — the runner
 * only ever calls {@link reseedFixtureClone}; everything here is repository surgery.
 */

/** Is `repo` a fixture clone carrying the `.gg-fixture` marker? */
export function isAutomationFixtureClone(repo: string): boolean {
	try {
		return fs.existsSync(path.join(repo, '.gg-fixture'));
	} catch (_) {
		return false;
	}
}

/** Remove a directory tree across the Node versions this extension builds against. */
function rmRecursive(target: string): void {
	const f = fs as unknown as {
		rmSync?: (p: string, o: { recursive: boolean; force: boolean }) => void;
		rmdirSync: (p: string, o?: { recursive?: boolean }) => void;
	};
	if (f.rmSync !== undefined) {
		f.rmSync(target, { recursive: true, force: true });
	} else {
		f.rmdirSync(target, { recursive: true });
	}
}

/** Total budget for one directory-tree removal across every attempt (see {@see rmTreeAwaitingLocks}). */
const RM_TREE_DEADLINE_MS = 120000;
/** Pause between removal attempts, sized to outlast a short-lived git child's exit. */
const RM_TREE_ATTEMPT_INTERVAL_MS = 200;

/**
 * Remove a directory tree, waiting out transient Windows file locks within a bounded budget.
 * Used by the test harnesses to clean fixture directories after a run (the suite runner itself
 * never deletes repositories any more — its reseed resets them in place). The load pipeline's
 * fire-and-forget follow-ups (the remote-refs scan, the "Uncommitted Changes" status) spawn git
 * processes whose working directory — and the pack files they read — sit inside the clone:
 * deleting it while such a process lingers fails with EPERM until the process exits, and the
 * engine's warm repository handle keeps memory-mapped pack files undeletable until it is closed.
 *
 * Each attempt is a SYNCHRONOUS removal — a complete operation that leaves nothing running once
 * it returns. The awaited fs.promises.rm with maxRetries/retryDelay was tried here first, but on
 * Node 20 (the CI line) its Windows retry path can stall far beyond the nominal budget and, when
 * it raced a held file, its promise never settled at all — hanging the whole suite (and with it
 * the CI job) on a single await. This loop keeps what the awaited rm was chosen for (the thread
 * still breathes between attempts, locks get waited out) while guaranteeing termination: past
 * the deadline the last error propagates, so a stubborn lock fails the removal loudly instead of
 * hanging CI.
 */
export async function rmTreeAwaitingLocks(target: string): Promise<void> {
	const deadline = Date.now() + RM_TREE_DEADLINE_MS;
	for (;;) {
		try {
			rmRecursive(target);
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, RM_TREE_ATTEMPT_INTERVAL_MS));
	}
}

/** Read the fixture marker (NULL when the repository is not a fixture clone). */
export function readFixtureMarker(repo: string): { remote: string } | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(repo, '.gg-fixture'), 'utf8')) as { remote?: unknown };
		return typeof parsed.remote === 'string' ? { remote: parsed.remote } : null;
	} catch (_) {
		return null;
	}
}

/**
 * Reset a fixture repository to a pristine, seeded state WITHOUT EVER DELETING IT: the directory
 * may be the user's own folder (a VS Code workspace root is held open by the editor on Windows —
 * deleting it mid-run is the EPERM that used to abort the whole suite after the write phase, and
 * a partially-torn-down `.git` left the repository unusable). Everything under git's control is
 * forced back in place to the bare remote recorded in the marker: the remote set is rebuilt as
 * exactly `origin`, leftover worktrees are removed, stashes/untracked files cleared, `main` is
 * force-checked out to `origin/main`, every other branch and tag is dropped and the remote's
 * tags re-fetched (write actions add branches/tags of their own), the `.gg-fixture` marker is
 * restored (the clean removes it — it is untracked), and the volatile seed state (3 stashes, an
 * untracked file, the local-ahead branch) is replayed via fixture.ts's seedRepo.
 */
export async function reseedFixtureClone(repo: string): Promise<void> {
	const marker = readFixtureMarker(repo);
	if (marker === null) throw new Error(repo + ' is not a fixture clone (no .gg-fixture marker)');
	// Every git call below goes through fixture.ts's `git`: the per-call config it needs (a CI
	// runner has no global user identity — the seed's commit would fail with "Author identity
	// unknown"; the working tree must keep LF endings like the initial seed's checkout), plus the
	// lock-contention retry — VS Code's own git extension keeps probing this repository's index
	// even after the engine's warm handles are closed above.
	const lines = (out: { stdout: string }) => out.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');

	// The engine keeps one warm repository handle per path for the whole editor session, and its
	// pack reads are memory-mapped: an active mapping keeps the mapped files undeletable and can
	// serve the pre-reset state. Drop the handle first — the engine re-opens it on the next load.
	// The fixture submodule's handle too: on histories that predate the submodule its `sub/` tree
	// is untracked, so the clean below would otherwise try to delete a memory-mapped repository.
	new HostBridge().closeRepository(repo);
	new HostBridge().closeRepository(path.join(repo, FIXTURE_SUBMODULE_PATH));

	// Remotes first (fetch needs origin): write actions add/edit/remove remotes, so the set is
	// rebuilt as exactly origin -> the marker's bare remote.
	const remotes = await git(['-C', repo, 'remote']);
	for (const name of lines(remotes)) {
		await git(['-C', repo, 'remote', 'remove', name]);
	}
	await git(['-C', repo, 'remote', 'add', 'origin', marker.remote]);

	// A leftover worktree holds its branch checked out (branch -D below would refuse); remove the
	// registrations — the clean below takes care of any directories left inside the repository.
	const worktrees = await git(['-C', repo, 'worktree', 'list', '--porcelain']);
	const worktreePaths = lines(worktrees)
		.filter((line) => line.indexOf('worktree ') === 0)
		.map((line) => line.slice('worktree '.length));
	for (const worktreePath of worktreePaths.slice(1)) { // the first entry is the main worktree
		try {
			await git(['-C', repo, 'worktree', 'remove', '--force', worktreePath]);
		} catch (_) {
			// its directory is already gone; the registrations are dropped below
		}
	}
	await git(['-C', repo, 'worktree', 'prune']);
	// A registration whose DIRECTORY still exists (a Windows-held file survived `remove
	// --force`) is not pruned — and the branch it holds checked out then fails the branch
	// deletion below. Every registration under .git/worktrees belongs to a worktree this run
	// (or a previous one) created, and the reset is force-everything anyway: drop them directly.
	const worktreesAdmin = path.join(repo, '.git', 'worktrees');
	if (fs.existsSync(worktreesAdmin)) {
		await rmTreeAwaitingLocks(worktreesAdmin);
		await git(['-C', repo, 'worktree', 'prune']);
	}

	// In-progress operation state (a conflicted rebase/merge/cherry-pick a write action left
	// behind): reset --hard does not clear it, and it holds the branch it ran on — git then
	// refuses the branch deletion below with "cannot delete branch used by worktree". The reset
	// is force-everything anyway; drop the state files/directories directly.
	for (const opState of ['rebase-merge', 'rebase-apply', 'sequencer', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
		const opPath = path.join(repo, '.git', opState);
		if (fs.existsSync(opPath)) await rmTreeAwaitingLocks(opPath);
	}

	await git(['-C', repo, 'stash', 'clear']);
	await git(['-C', repo, 'fetch', '--prune', '--tags', 'origin']);
	await git(['-C', repo, 'checkout', '-f', '-B', 'main', 'origin/main']);

	// Every branch but main goes (write actions created some; local-ahead is re-seeded below).
	// The deletion goes by FULL refname: `%(refname:short)` renders refs/heads/HEAD (a local
	// branch literally named HEAD — a write action fetching a remote's HEAD ref into a local
	// branch creates exactly that) as the ambiguous short form "heads/HEAD", which `branch -D`
	// then cannot resolve ("branch not found"), failing the whole reseed. update-ref -d takes
	// the full ref and no name resolution at all.
	const branches = await git(['-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/heads']);
	for (const ref of lines(branches)) {
		if (ref !== 'refs/heads/main') await git(['-C', repo, 'update-ref', '-d', ref]);
	}

	// Tags: drop write-added ones by dropping all of them and re-fetching exactly the remote's set.
	const tags = await git(['-C', repo, 'tag', '-l']);
	const tagList = lines(tags);
	if (tagList.length > 0) {
		await git(['-C', repo, 'tag', '-d', ...tagList]);
		await git(['-C', repo, 'fetch', 'origin', '--tags']);
	}

	// Untracked leftovers of the write pass (archives, worktree directories, files a branch
	// switch stranded); also removes the marker, which is restored right after. The editor's own
	// workspace configuration directory (.vscode — launch/tasks/settings of the folder this
	// repository lives in) is EXCLUDED: deleting it mid-session silently rewrites the session's
	// configuration (an E2E run loses its enableLog/initialLoad settings the moment the reseed
	// runs, which once made every later failure undiagnosable) and VS Code keeps watching a file
	// that no longer exists.
	await git(['-C', repo, 'clean', '-fd', '-e', '.vscode']);
	fs.writeFileSync(path.join(repo, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');
	await seedRepo(repo);

	// Drop the engine's handle one final time. The close at the top only clears the way for the
	// mutations; the view's own change-driven refreshes keep running throughout (the watcher
	// fires the moment the first `git remote remove` lands), and a repository the engine
	// (re-)opens mid-reseed freezes the transient state into a fresh warm handle — an open
	// landing in the zero-remote window between the remove and the re-add serves remote_names()
	// as empty for the rest of the session, failing every remote-dependent action after the
	// reseed (the Add Tag dialog loses its push checkbox; the Settings widget shows no remotes).
	// Refs and commits are re-read live, so this single trailing close is enough: whatever
	// handle a racing refresh opened is dropped here, and the next host request re-opens the
	// repository in its final seeded state.
	new HostBridge().closeRepository(repo);
	new HostBridge().closeRepository(path.join(repo, FIXTURE_SUBMODULE_PATH));
}

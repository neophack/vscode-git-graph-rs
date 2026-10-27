import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildFastImportStream, buildSubmoduleStream, createRng,
	FIXTURE_SUBMODULE_PATH, FixtureOptions, SUBMODULE_GITMODULES
} from './fixtureContent';
import { countRepoCommits, fastImport, git, mkdirAll, rmFile, rmScratch, rmTree, RM_TREE_DEADLINE_MS } from './fixtureGit';

/**
 * The deterministic large-repository generator behind both automation entry points — the
 * repository materialization half: it turns the history that fixtureContent.ts builds as a
 * `git fast-import` stream (run through the process plumbing of fixtureGit.ts) into working
 * repositories, and seeds them with the volatile state the automation catalog expects. The
 * clone/restore lifecycle of an existing fixture clone (marker, reseed) lives in
 * fixtureLifecycle.ts.
 *
 * Two ways the history reaches a working repository:
 *   - `generate({ outDir, ... })` — the scripted path (scripts/automation/fixture.mjs, full-test):
 *     fast-import into a scratch repo, clone it bare as `<outDir>/fixture-remote.git`, clone a
 *     working `<outDir>/fixture` from it, and write the `.gg-fixture` marker.
 *   - `seedEmptyRepo(repo, ...)` — the in-process path (the "Run Automation Test" button): the
 *     active repository has NO commits at all, so it cannot hold real work in git terms — the
 *     history is fast-imported into a throwaway bare remote under the OS temp dir, fetched into
 *     the repository, `main` checked out, the `.gg-fixture` marker written, and the volatile seed
 *     state (stashes, untracked file, local-ahead branch) replayed. The marker's remote keeps the
 *     pristine history for the suite runner's between-phases reseed.
 *
 * `seedRepo(repoDir)` seeds a freshly-cloned (or freshly-generated) repository with the volatile
 * state the automation catalog expects: three stashes, one untracked file, and a local-ahead
 * branch one commit ahead of origin. Idempotent.
 */

/* Re-exported so the automation layer's import surface stays what it was before the
 * decomposition (`git`, `countRepoCommits` and `FIXTURE_SUBMODULE_PATH` are imported from here
 * across the automation module and the test harnesses). */
export { countRepoCommits, git } from './fixtureGit';
export { FIXTURE_SUBMODULE_PATH };
export type { FixtureOptions };

/**
 * What the "Run Automation Test" button generates into an empty repository: 2000+ commits in total.
 */
export const EMPTY_REPO_FIXTURE_OPTIONS: Readonly<FixtureOptions> = {
	commits: 2000, branches: 50, tags: 40, mergeRate: 0.12, authors: 20, seed: 12345
};

/**
 * Materialise the fixture submodule as a working nested repository at `dir` (init + fast-import +
 * hard reset to check the files out). Returns the submodule HEAD hash — identical on every import,
 * so it is also the gitlink the main history records.
 */
async function importSubmodule(dir: string): Promise<string> {
	mkdirAll(dir);
	await git(['init', dir]);
	await fastImport(dir, buildSubmoduleStream());
	await git(['-C', dir, 'reset', '--hard']);
	const head = await git(['-C', dir, 'rev-parse', 'HEAD']);
	return head.stdout.trim();
}

/**
 * Make sure the fixture's submodule exists in a repository: the nested repository is rebuilt
 * deterministically when missing (a write action's clean may have removed it), and `.gitmodules`
 * is written when the history predates the submodule (an old fixture clone: the file stays
 * untracked there — `main` must keep matching `origin/main` exactly). Idempotent.
 */
export async function ensureSubmodule(repoDir: string): Promise<void> {
	const subDir = path.join(repoDir, FIXTURE_SUBMODULE_PATH);
	let present = false;
	try {
		present = fs.existsSync(path.join(subDir, '.git'));
	} catch (_) {
		// fall through to a rebuild attempt
	}
	if (!present) {
		// Partial leftovers of a failed clean — best effort: a Windows-held file must not abort
		// the rebuild, and importSubmodule fails loudly if the leftovers truly block it.
		try {
			await rmTree(subDir, 15000);
		} catch (_) {
			// undeletable leftovers; the import below decides whether they matter
		}
		await importSubmodule(subDir);
	}
	const modules = path.join(repoDir, '.gitmodules');
	let hasModules = false;
	try {
		hasModules = fs.existsSync(modules);
	} catch (_) {
		// fall through to a rewrite
	}
	if (!hasModules) fs.writeFileSync(modules, SUBMODULE_GITMODULES);
}

function validatedOptions(options: Partial<FixtureOptions>): FixtureOptions {
	const opts: FixtureOptions = { ...EMPTY_REPO_FIXTURE_OPTIONS, ...options };
	if (!Number.isInteger(opts.commits) || opts.commits < 1) throw new Error('commits must be a positive integer, got ' + opts.commits);
	for (const key of ['branches', 'tags', 'authors', 'seed'] as const) {
		if (!Number.isInteger(opts[key]) || opts[key] < 0) {
			throw new Error(key + ' must be a non-negative integer, got ' + opts[key]);
		}
	}
	if (typeof opts.mergeRate !== 'number' || opts.mergeRate < 0 || opts.mergeRate > 1) {
		throw new Error('mergeRate must be between 0 and 1');
	}
	return opts;
}

function writeFixtureMarker(repoDir: string, remote: string, opts: FixtureOptions): void {
	const marker = {
		remote,
		commits: opts.commits,
		branches: opts.branches,
		tags: opts.tags,
		mergeRate: opts.mergeRate,
		seed: opts.seed
	};
	fs.writeFileSync(path.join(repoDir, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');
}

/**
 * Generate the fixture the scripted way: fast-import a fresh history into a scratch repo, clone
 * it bare as `<outDir>/fixture-remote.git`, clone a working `<outDir>/fixture` from the bare, and
 * write the `.gg-fixture` marker. If the fixture already exists and force is not set, prints the
 * existing path and returns without rebuilding.
 */
export async function generate(options: { outDir: string } & Partial<FixtureOptions> & { force?: boolean }): Promise<{ skipped: boolean; fixtureDir: string; remoteDir: string }> {
	if (typeof options.outDir !== 'string' || options.outDir === '') {
		throw new Error('generate requires { outDir: string }');
	}
	const opts = validatedOptions(options);
	const force = options.force === true;

	const outDir = path.resolve(options.outDir);
	const fixtureDir = path.join(outDir, 'fixture');
	const remoteDir = path.join(outDir, 'fixture-remote.git');
	if (fs.existsSync(fixtureDir) && !force) {
		return { skipped: true, fixtureDir, remoteDir };
	}

	mkdirAll(outDir);
	const workDir = fs.mkdtempSync(path.join(outDir, '.work-'));
	try {
		// The submodule's history first: its (deterministic) HEAD hash is the gitlink the main
		// stream records on the final main-line commit. The scratch copy lives inside workDir and
		// disappears with it — the working clone materialises its own copy (ensureSubmodule below).
		const submoduleSha = await importSubmodule(path.join(workDir, 'submodule-scratch'));
		await git(['init', workDir]);
		await fastImport(workDir, buildFastImportStream(opts, submoduleSha));

		// These may be held at re-generate time (the engine's warm handles memory-map the pack
		// files of a fixture a just-closed editor had open) — the same budget the reseed allows.
		await rmTree(remoteDir, RM_TREE_DEADLINE_MS);
		await rmTree(fixtureDir, RM_TREE_DEADLINE_MS);
		await git(['clone', '--bare', workDir, remoteDir]);
		await rmTree(workDir, RM_TREE_DEADLINE_MS);
		await git(['clone', remoteDir, fixtureDir]);
		await ensureSubmodule(fixtureDir);
	} catch (err) {
		await rmScratch(workDir);
		throw err;
	}

	writeFixtureMarker(fixtureDir, remoteDir, opts);
	return { skipped: false, fixtureDir, remoteDir };
}

/**
 * Generate the fixture history INTO a repository that has no commits at all (the "Run Automation
 * Test" button's empty-repository path). The history is fast-imported into a throwaway bare
 * remote under the OS temp dir — the path recorded in the `.gg-fixture` marker, so the suite
 * runner's reseed can keep rebuilding the repository from it — then fetched into the repository
 * and `main` checked out, leaving exactly the branch layout the scripted generate() produces
 * (local `main`, `feature-NNN` only as `origin/feature-NNN`, `v1.x.x` tags). Refuses — loudly,
 * without touching anything — a repository that has any commit anywhere.
 */
export async function seedEmptyRepo(repo: string, options: Partial<FixtureOptions> = {}): Promise<{ remote: string }> {
	const commitsPresent = await countRepoCommits(repo);
	if (commitsPresent !== 0) {
		throw new Error(repo + ' is not an empty repository (' + (commitsPresent < 0 ? 'not a git repository' : commitsPresent + ' commits found') + ') — the in-place fixture is only generated into a repository with no commits');
	}
	const opts = validatedOptions(options);

	// The submodule's deterministic HEAD is the gitlink the generated history records; the scratch
	// import lives only long enough to compute it (the repository gets its own working copy below).
	const subScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-automation-sub-'));
	let submoduleSha: string;
	try {
		submoduleSha = await importSubmodule(subScratch);
	} finally {
		// Best effort on purpose: a transient lock on the fresh pack file here used to abort the
		// whole run (and, had importSubmodule failed, mask its real error with the cleanup's EPERM).
		await rmScratch(subScratch);
	}

	const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-automation-remote-'));
	await git(['init', '--bare', remoteDir]);
	await fastImport(remoteDir, buildFastImportStream(opts, submoduleSha));

	// Wire the repository to the fresh remote (keeping the `origin` name the catalog expects) and
	// materialise the history: fetch creates origin/feature-NNN and the tags, the forced checkout
	// of origin/main gives the working tree and the local main branch. The submodule follows the
	// checkout as `.gitmodules` + gitlink — its nested repository is materialised in place.
	let originUrl: string;
	try {
		originUrl = (await git(['-C', repo, 'remote', 'get-url', 'origin'])).stdout.trim();
	} catch (_) {
		originUrl = '';
	}
	if (originUrl === '') await git(['-C', repo, 'remote', 'add', 'origin', remoteDir]);
	else await git(['-C', repo, 'remote', 'set-url', 'origin', remoteDir]);
	await git(['-C', repo, 'fetch', 'origin', '--prune', '--tags']);
	await git(['-C', repo, 'checkout', '-f', '-B', 'main', 'origin/main']);
	await ensureSubmodule(repo);

	writeFixtureMarker(repo, remoteDir, opts);
	await seedRepo(repo);
	return { remote: remoteDir };
}

/**
 * Seed a fixture repository with the volatile state the automation catalog expects: three
 * stashes, one untracked file, and a local-ahead branch one commit ahead of origin. Idempotent —
 * the repository is reset to origin/main, stashes are cleared and the seeded state recreated.
 */
export async function seedRepo(repoDir: string): Promise<void> {
	const rng = createRng(987654321);

	// The clone must be writable with NO global git identity: the extension's own write actions
	// (the Add Tag dialog's `git tag -a`, commits, ...) run plain git commands inside this
	// repository, and a machine without user.name/user.email configured (a CI runner) refuses
	// them with "Committer identity unknown". Local config is idempotent and survives every
	// reseed — nothing in the reset touches .git/config.
	await git(['-C', repoDir, 'config', 'user.name', 'Fixture']);
	await git(['-C', repoDir, 'config', 'user.email', 'fixture@fixture.dev']);

	await git(['-C', repoDir, 'stash', 'clear']);
	await git(['-C', repoDir, 'checkout', '-f', 'main']);
	await git(['-C', repoDir, 'reset', '--hard', 'origin/main']);
	const branches = await git(['-C', repoDir, 'branch', '--list', 'local-ahead']);
	if (branches.stdout.trim() !== '') {
		await git(['-C', repoDir, 'branch', '-D', 'local-ahead']);
	}
	rmFile(path.join(repoDir, 'untracked-fixture.txt'));

	const listed = await git(['-C', repoDir, 'ls-files']);
	const files = listed.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
	if (files.length === 0) throw new Error(repoDir + ' has no tracked files to stash');
	// Never a dotfile: the stash seed APPENDS content to the files it picks, and a pick of
	// `.gitmodules` (tracked and first in ls-files since the submodule landed) writes stash
	// markers INTO a git config file — one failed stash push later, every git invocation in the
	// suite dies on "bad config line". Plain source files are the stash substrate.
	const stashable = files.filter((f) => f.indexOf('.') !== 0);
	if (stashable.length < 3) throw new Error(repoDir + ' has too few non-dot tracked files to stash (needs 3, has ' + stashable.length + ')');
	const picks = [stashable[0], stashable[Math.floor(stashable.length / 3)], stashable[Math.floor((2 * stashable.length) / 3)]];

	for (let i = 0; i < 3; i++) {
		const file = picks[i];
		fs.appendFileSync(path.join(repoDir, file),
			'\n// fixture-stash-' + (i + 1) + '\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
		await git(['-C', repoDir, 'stash', 'push', '-m', 'fixture-stash-' + (i + 1), '--', file]);
	}

	fs.writeFileSync(path.join(repoDir, 'untracked-fixture.txt'),
		'fixture untracked file\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');

	await git(['-C', repoDir, 'checkout', '-b', 'local-ahead']);
	fs.writeFileSync(path.join(repoDir, 'local-ahead-note.txt'),
		'local-ahead is one commit ahead of origin/main\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
	await git(['-C', repoDir, 'add', 'local-ahead-note.txt']);
	await git(['-C', repoDir, 'commit', '-m', 'local-ahead fixture commit']);
	await git(['-C', repoDir, 'checkout', 'main']);

	// The submodule survives every reseed: rebuilt deterministically when a write action's clean
	// removed it, and `.gitmodules` restored for histories that predate it (untracked there, so
	// `main` keeps matching `origin/main` exactly).
	await ensureSubmodule(repoDir);
}

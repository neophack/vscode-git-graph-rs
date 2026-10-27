import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../platform/logger';
import { AutomationAction, AutomationMode, CATALOG } from './catalog';
import { countRepoCommits, ensureSubmodule, EMPTY_REPO_FIXTURE_OPTIONS, FIXTURE_SUBMODULE_PATH, FixtureOptions, git, seedEmptyRepo } from './fixture';
import type { SetupGitEnv } from './fixtureGit';
import { isAutomationFixtureClone, readFixtureMarker, reseedFixtureClone } from './fixtureLifecycle';
import { automationOpenTabs, automationTabKey, HostBridge } from './hostBridge';
import { AutomationServer } from './server';
import { installScriptedUiPort, ScriptedUiPort, uninstallScriptedUiPort } from './scriptedUiPort';
import { cleanupActionSurfaces, closeLeakedWidgets, ensureSuiteViewOptions, reloadViewAfterGeneration, syncViewAfterReseed } from './suiteViewSync';

/* The fixture clone's lifecycle mechanics (marker, reseed, lock-safe removal) live in
 * fixtureLifecycle.ts; re-exported so the runner's import surface stays what it was. */
export { isAutomationFixtureClone, readFixtureMarker, reseedFixtureClone, rmTreeAwaitingLocks } from './fixtureLifecycle';

/**
 * The in-process automation suite runner — the "Run Automation Test" button's engine. It drives
 * the automation engine directly (no sockets, no external driver) and runs the catalog's read
 * suite (safe on any repository) plus the write suite when the target is safe to mutate:
 *   - a fixture clone (a `.gg-fixture` marker — built by scripts/automation/fixture.mjs, the
 *     full-test script, or the button's own empty-repository generation), reset IN PLACE to its
 *     bare remote's state before the write phase AND once more after it (the directory itself is
 *     never deleted, and the run never ends leaving the write actions' commits behind); or
 *   - a repository with NO commits at all — it cannot hold real work in git terms, so the runner
 *     first writes the full fixture history into it in place (2000+ commits, a fresh bare remote
 *     under the OS temp dir recorded in the marker) and then treats it like any fixture clone.
 * A repository that already has commits and no marker is a real repository: only the read suite
 * runs, nothing is ever written to it. Whatever an action opens (editor tabs, terminals) is
 * closed again afterwards, leaving the user's workspace as it was.
 */

export interface SuiteProgress {
	readonly phase: 'read' | 'write';
	/** 1-based position within the phase. */
	readonly index: number;
	readonly total: number;
	readonly actionId: string;
	readonly mode: AutomationMode;
}

export interface ActionRunRecord {
	readonly id: string;
	readonly title: string;
	readonly group: string;
	readonly mode: AutomationMode;
	readonly ok: boolean;
	readonly skipped: boolean;
	readonly reason: string | null;
	readonly error: string | null;
	readonly totalMs: number | null;
	readonly responses: readonly { readonly command: string; readonly atMs: number }[];
	/** Native notifications the command raised (command mode), captured by the dialog auto-answer (e.g. a designed Gerrit refusal). */
	readonly notifications: readonly string[];
}

export interface SuiteReport {
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly repo: string;
	/** TRUE when the repository is (or became) a fixture clone — the write suite ran against it. */
	readonly fixture: boolean;
	/** TRUE when the repository started empty and the runner generated the fixture history into it. */
	readonly fixtureGenerated: boolean;
	readonly writeSuiteIncluded: boolean;
	readonly suites: readonly { readonly name: 'read' | 'write'; readonly runs: readonly ActionRunRecord[] }[];
	readonly totals: { readonly actions: number; readonly passed: number; readonly failed: number; readonly skipped: number };
}

export interface SuiteRunOptions {
	readonly logger: Logger;
	/** Repository to run against (defaults to the view's current repository). */
	readonly repo?: string;
	/** Progress callback invoked after each action completes. */
	readonly onProgress?: (progress: SuiteProgress) => void;
	readonly actionTimeoutMs?: number;
	/** Restrict the run to a subset of actions (the report and progress still cover the subset). */
	readonly filter?: (action: AutomationAction) => boolean;
	/** Force the write suite off (used by tests; the runner also skips it for non-fixture repos). */
	readonly skipWriteSuite?: boolean;
	/**
	 * Make a repository KNOWN to the editor's repo registry (the extension host's RepoManager) —
	 * the runner asks this of the fixture's submodule after seeding it, because a repository
	 * materialised mid-session is not discovered until the next activation. Only the real editor
	 * passes it; the node harness's registry already scans `.gitmodules` at boot.
	 */
	readonly registerRepo?: (repo: string) => Promise<void>;
	/** Fixture generation parameters for the empty-repository path (defaults: 2000 commits, 50 branches, 40 tags, 20 authors). */
	readonly fixtureOptions?: Partial<FixtureOptions>;
}

/* ---------------- The suite run ---------------- */

/**
 * Write actions whose real-world precondition is STAGED CHANGES — a state the editor's SCM UI
 * owns, not the Git Graph page. The runner establishes it directly before the action runs, the
 * same class of setup as the reseed's stashes: without it the actions' own commit is git's
 * "nothing to commit" refusal, and the catalog's real-outcome verify could never hold.
 */
const STAGED_PRECONDITION_ACTIONS: ReadonlySet<string> = new Set(['menu-commit/fixup', 'menu-commit/squash']);

/**
 * Git commands the runner runs AFTER a specific action to clear state its DESIGNED refusal
 * leaves behind: the remote-branch merge/pull entries conflict by construction (two diverged
 * feature branches), and an unmerged index would fail every later write action with "you need
 * to resolve your current index first". The commands are best-effort (logged, never thrown).
 */
const POST_ACTION_CLEANUP: ReadonlyMap<string, readonly string[][]> = new Map([
	// rebase --quit first: a pull configured for rebase leaves .git/rebase-merge behind on a
	// conflict, and neither merge --abort nor reset --hard clears it — the stale state then
	// fails every later checkout ("resolve your current index") and even the final reseed's
	// branch deletion ("cannot delete branch used by worktree").
	['menu-remote-branch/merge', [['rebase', '--quit'], ['merge', '--abort'], ['reset', '--hard']]],
	['menu-remote-branch/pull-into', [['rebase', '--quit'], ['merge', '--abort'], ['reset', '--hard']]]
]);

/**
 * Git commands the runner runs BEFORE a specific action to restore a precondition the earlier
 * write actions of the same pass consumed: the stash group's flows apply/pop seed stashes that
 * were recorded on MAIN, but by then the suite has checked out a feature branch (the
 * remote-branch group's create-branch) — applying a main-based stash onto a diverged branch
 * conflicts by construction. Checking main out first makes the actions' own semantics the
 * thing under test again ('main' is a fixture-stable fact, like the catalog's tag literals).
 */
const PRE_ACTION_SETUP: ReadonlyMap<string, readonly { args: readonly string[]; env?: Readonly<SetupGitEnv> }[]> = new Map([
	['menu-stash/apply', [{ args: ['checkout', '-f', 'main'] }]],
	['menu-stash/pop', [{ args: ['checkout', '-f', 'main'] }]],
	['menu-stash/branch-from-stash', [{ args: ['checkout', '-f', 'main'] }]],
	// The external-change action's precondition is a commit made OUTSIDE the view — the same way
	// a user's terminal would make it — which the action's page steps then wait to appear on its
	// own (the watcher-driven refresh chain; see the catalog entry). An empty commit needs no
	// staged changes, and the inline identity keeps it working on machines with no global Git
	// identity configured (the fixture clone seeds none). The E2E launcher pins every git date
	// for determinism, and the pins must NOT reach this commit: a terminal commit carries the
	// wall clock, making it the newest commit in the repository — the exact shape whose
	// watcher-driven appearance the scenario asserts. A date-pinned commit ties with the
	// fixture's whole history instead, and the row lands outside the rendered window (observed:
	// position 286 of 304 under an all-equal-date tie) however correctly the refresh chain
	// works.
	['external/commit-appears', [{
		args: ['-c', 'user.name=Automation', '-c', 'user.email=automation@example.com', 'commit', '--allow-empty', '-m', 'External automation commit'],
		env: { GIT_AUTHOR_DATE: undefined, GIT_COMMITTER_DATE: undefined }
	}]]
]);

/**
 * Stage one fresh modification of the first tracked file (each call its own line, so two
 * staged-precondition actions in one pass both find an index to commit). Never throws at the
 * caller: a failure here surfaces as the action's own failure moments later (nothing staged =>
 * the commit is refused => the error-payload gate fails the action with git's message).
 */
async function stageFreshChange(repo: string, logger: { log(message: string): void; logError(message: string): void }): Promise<void> {
	try {
		const listed = await git(['-C', repo, 'ls-files']);
		const files = listed.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '' && s.indexOf('.') !== 0);
		// Never a dotfile: `.gitmodules` (the fixture submodule) is a git CONFIG file — appending
		// a line to it corrupts every later config read (one bad staged change once poisoned the
		// whole write pass and the final reseed with it). And never one of the seed's stash-pick
		// files (fixture.ts picks non-dot indices 0, n/3 and 2n/3 to stash): committing a staged
		// change on a file a stash also touches makes the later Apply Stash auto-merge conflict.
		// The same indices over the SAME non-dot listing the seed picks from.
		const picks = new Set([0, Math.floor(files.length / 3), Math.floor((2 * files.length) / 3)]);
		const target = files.find((_file, index) => !picks.has(index)) ?? files[0];
		if (target === undefined) throw new Error('no tracked file to stage a change on');
		fs.appendFileSync(path.join(repo, target), '\n// automation staged change ' + Date.now() + '\n');
		await git(['-C', repo, 'add', '--', target]);
		logger.log('[fixture] staged a modification of ' + target + ' for the staged-change precondition');
	} catch (error) {
		logger.logError('staging the precondition change failed: ' + (error instanceof Error ? error.message : String(error)));
	}
}

export async function runAutomationSuite(options: SuiteRunOptions): Promise<SuiteReport> {
	const startedMs = Date.now();
	const bridge = new HostBridge();
	const server = new AutomationServer({ logger: options.logger, bridge, version: 'in-process' });
	// The scripted UiPort of the whole run (task 4.10): every native dialog any action raises —
	// the archive flows' save dialog above all — is answered from the lenient default script
	// (primary button / first item / a generated save path) and recorded, replacing both the
	// former nativeSaveDialog skip (those actions now RUN) and the stall a real modal would
	// cause. Scenario runs (the E2E entry) install their own strict per-scenario port on top.
	installScriptedUiPort(new ScriptedUiPort({ mode: 'lenient' }));
	server.start();
	try {
		const timeoutMs = options.actionTimeoutMs ?? 30000;
		const sameRepo = (a: string | null, b: string) =>
			a !== null && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
		const repo = options.repo ?? server.status().currentRepo;
		if (repo === null || repo === '') {
			throw new Error('No repository is active in the Git Graph view');
		}
		if (!sameRepo(server.status().currentRepo, repo)) {
			await server.openView({ repo });
			for (let i = 0; i < 600; i++) {
				if (sameRepo(server.status().currentRepo, repo)) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

		let fixture = isAutomationFixtureClone(repo);
		let fixtureGenerated = false;
		// The marker as the run started: the write suite's own `git clean` (menu-uncommitted/
		// clean-untracked) removes the UNTRACKED .gg-fixture marker, which the final cleanup
		// reseed keys off — the snapshot lets the cleanup restore it (the repository was a
		// fixture when the write phase was admitted, so the record is still the truth).
		let fixtureMarker = fixture ? readFixtureMarker(repo) : null;
		let includeWrite = !options.skipWriteSuite && fixture;
		if (!options.skipWriteSuite && !fixture && (await countRepoCommits(repo)) === 0) {
			// An empty repository (no commits on any ref) cannot hold real work in git terms, so the
			// button takes it over: the full fixture history (2000+ commits by default) is written
			// into it in place, and both suites then have a real graph to run against.
			const opts = options.fixtureOptions ?? EMPTY_REPO_FIXTURE_OPTIONS;
			options.logger.log('[fixture] ' + repo + ' has no commits - generating the fixture history ('
				+ opts.commits + ' main commits, ' + opts.branches + ' branches, ' + opts.tags + ' tags)');
			await seedEmptyRepo(repo, options.fixtureOptions);
			// The engine opened this repository while it was still empty (the view's first load),
			// and its warm handle can keep serving the pre-generation state (the authors read
			// walked the empty repository even after the history landed). Drop the handle - the
			// next host request re-opens the repository fresh, exactly like the reseed does.
			bridge.closeRepository(repo);
			fixture = true;
			fixtureGenerated = true;
			fixtureMarker = readFixtureMarker(repo);
			includeWrite = true;
			// The view still shows the repository as it loaded it (empty), and loadRepos skips a
			// repository it is already showing - drive the view's own controls to reload it onto
			// the generated history instead of racing the 5 s background change poll.
			try {
				await reloadViewAfterGeneration(server);
			} catch (error) {
				// One bounded retry. Nothing ever re-requests the repository config once the page
				// is up, so a read that raced the generation (a warm handle or a cached promise
				// still serving the pre-generation state - the exact hazard the close above
				// guards against) would fail the whole run on a state nothing re-reads. Drop the
				// handle and drive the reload once more; a real failure throws again, loudly.
				options.logger.logError('post-generation reload failed once - retrying: '
					+ (error instanceof Error ? error.message : String(error)));
				bridge.closeRepository(repo);
				await reloadViewAfterGeneration(server);
			}
		}
		// The fixture's submodule is the catalog's second known repository (`anotherRepo`, the
		// Repos dropdown). Seeding (or the previous run's final reseed) materialised it; a repo
		// created mid-session is invisible to the editor's registry until registered explicitly —
		// never discovered automatically here (both the workspace scan and the submodule scan skip
		// paths inside a known repository). A real repository (no fixture) is never touched.
		const submoduleDir = path.join(repo, FIXTURE_SUBMODULE_PATH);
		const registerSubmodule = async () => {
			if (options.registerRepo === undefined) return;
			try {
				await options.registerRepo(submoduleDir);
			} catch (error) {
				options.logger.logError('Registering the fixture submodule failed: ' + (error instanceof Error ? error.message : String(error)));
			}
		};
		if (fixture || fixtureGenerated) {
			await ensureSubmodule(repo);
			await registerSubmodule();
		}
		const filter = options.filter ?? (() => true);
		const readActions = CATALOG.filter((a) => !a.mutable && filter(a));
		const writeActions = includeWrite ? CATALOG.filter((a) => a.mutable && filter(a)) : [];
		const grandTotal = readActions.length + writeActions.length;

		const runPhase = async (phase: 'read' | 'write', actions: readonly AutomationAction[], offset: number): Promise<ActionRunRecord[]> => {
			const runs: ActionRunRecord[] = [];
			for (let i = 0; i < actions.length; i++) {
				const action = actions[i];
				// Command actions run the VS Code command a contributed menu item runs; UI actions
				// drive the real page controls; the rest inject requests into the host pipeline.
				const mode: AutomationMode = action.vscodeCommand !== undefined ? 'command' : action.ui !== undefined ? 'ui' : 'request';
				// The webview panel can disappear mid-suite (for example a host action opening a
				// document in the preview slot the view occupies); re-open it so one lost panel
				// cannot fail the rest of the suite.
				if (!sameRepo(server.status().currentRepo, repo)) {
					await server.openView({ repo });
					for (let j = 0; j < 600; j++) {
						if (sameRepo(server.status().currentRepo, repo)) break;
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
				}
				const beforeTabs = new Set(automationOpenTabs().map(automationTabKey));
				const beforeTerminals = new Set(Array.isArray(vscode.window.terminals) ? vscode.window.terminals : []);
				if (mode === 'ui' && STAGED_PRECONDITION_ACTIONS.has(action.id)) {
					// Establish the action's real-world precondition out-of-band (see
					// stageFreshChange): a fixup/squash commit commits the STAGED changes, which
					// the editor's SCM UI — not the Git Graph page — stages. The verification
					// contract (the catalog's headSubjectStartsWith verify) only holds with
					// something staged, exactly like the stash actions only hold with the seed's
					// stashes.
					await stageFreshChange(repo, options.logger);
				}
				const setupCommands = PRE_ACTION_SETUP.get(action.id);
				if (setupCommands !== undefined) {
					for (const command of setupCommands) {
						try {
							await git(['-C', repo, ...command.args], { env: command.env });
						} catch (error) {
							options.logger.logError('[automation] pre-action setup ' + JSON.stringify(command.args) + ' failed: ' + (error instanceof Error ? error.message : String(error)));
						}
					}
				}
				let record: ActionRunRecord;
				const runOnce = async (): Promise<ActionRunRecord> => {
					try {
						const outcome = await server.run({ id: action.id, mode, timeoutMs }) as {
							ok: boolean; skipped?: boolean; reason?: string; error?: string;
							timings?: { totalMs: number; responses: { command: string; atMs: number }[] };
							notifications?: string[];
						};
						return {
							id: action.id, title: action.title, group: action.group, mode,
							ok: outcome.ok, skipped: outcome.skipped === true,
							reason: outcome.reason ?? null, error: outcome.error ?? null,
							totalMs: outcome.timings?.totalMs ?? null,
							responses: outcome.timings?.responses ?? [],
							notifications: outcome.notifications ?? []
						};
					} catch (error) {
						return {
							id: action.id, title: action.title, group: action.group, mode,
							ok: false, skipped: false, reason: null,
							error: error instanceof Error ? error.message : String(error),
							totalMs: null, responses: [], notifications: []
						};
					}
				};
				record = await runOnce();
				// Windows transient-index retry: the view's own background status probes race a
				// write action's `git` child for .git/index.lock, and git does not wait — a stash
				// apply can fail "could not write index" against a lock held for milliseconds by
				// a reader. Exactly one retry after the lock is gone (the user's "try again"),
				// only for that signature: every other failure stands as recorded.
				if (!record.ok && !record.skipped && record.error !== null
					&& /could not write index|index\.lock|Another git process/.test(record.error)) {
					options.logger.log('[automation] transient index contention on ' + action.id + ' - retrying once');
					await new Promise((resolve) => setTimeout(resolve, 2000));
					record = await runOnce();
				}
				await closeLeakedWidgets(server);
				// The live terminal snapshot goes through as a getter: the read must happen after
				// the cleanup's own settle wait (late-opening surfaces), and the vscode seam stays
				// here — suiteRunner is where the automation layer's direct vscode import lives.
				await cleanupActionSurfaces(beforeTabs, beforeTerminals,
					() => (Array.isArray(vscode.window.terminals) ? vscode.window.terminals : []));
				const cleanupCommands = POST_ACTION_CLEANUP.get(action.id);
				if (cleanupCommands !== undefined) {
					// State a DESIGNED-refusal action leaves behind (a conflicted merge): without
					// this, the unmerged index fails every later write action ("you need to
					// resolve your current index first"). Bounded, failures logged not thrown.
					for (const args of cleanupCommands) {
						try {
							await git(['-C', repo, ...args]);
						} catch (error) {
							options.logger.logError('[automation] post-action cleanup ' + JSON.stringify(args) + ' failed: ' + (error instanceof Error ? error.message : String(error)));
						}
					}
				}
				runs.push(record);
				options.onProgress?.({ phase, index: i + 1, total: actions.length, actionId: action.id, mode });
				void offset; // phases report their own index; grand total is derivable from the report
			}
			return runs;
		};

		// A fixture repository's view options belong to the run (an older run's toggle may have
		// left tags or stashes hidden); a real repository's preferences are the user's and stay
		// untouched — a hidden-tags read suite there simply shows the tag actions failing.
		if (fixture || fixtureGenerated) await ensureSuiteViewOptions(server, options.logger);
		const readRuns = await runPhase('read', readActions, 0);
		options.logger.log('[fixture] read phase done: ' + readRuns.length + ' runs; includeWrite=' + includeWrite + ', writeActions=' + writeActions.length);
		let writeRuns: ActionRunRecord[] = [];
		if (includeWrite) {
			try {
				options.logger.log('[fixture] between-phases reseed starting');
				await reseedFixtureClone(repo);
				// The reseed's fresh stash/local-ahead hashes must be on the page before the first
				// write action resolves its placeholders against the engine (see syncViewAfterReseed).
				await syncViewAfterReseed(server, repo);
				options.logger.log('[fixture] between-phases reseed + view sync done');
			} catch (error) {
				// A failed reseed must not cost the user the whole report (it once aborted the run
				// after the read phase, leaving no report at all): record it as a failed write-suite
				// entry and run the write phase no further — its pristine starting state is gone.
				const message = error instanceof Error ? error.message : String(error);
				options.logger.logError('write-suite reseed failed: ' + message);
				writeRuns = [{
					id: 'write-suite/reseed', title: 'Reset the fixture repository to its seeded state', group: 'write',
					mode: 'request', ok: false, skipped: false, reason: null,
					error: message, totalMs: null, responses: [], notifications: []
				}];
			}
			if (writeRuns.length === 0) {
				// The write actions' tag/stash/remote-branch targets depend on the same canonical
				// options the read phase was ensured against (a poisoned override fails the whole
				// menu-tag / menu-stash / menu-remote-branch groups "row never rendered").
				options.logger.log('[fixture] ensuring view options before the write phase');
				await ensureSuiteViewOptions(server, options.logger);
				options.logger.log('[fixture] write phase starting: ' + writeActions.length + ' actions');
				// The read phase's Repos dropdown action may have loaded the submodule through the
				// engine (a fresh warm handle); on histories that predate the submodule its `sub/`
				// tree is untracked, and a memory-mapped handle would make the write phase's clean
				// fail to delete it on Windows. Drop the handle before any write action runs.
				bridge.closeRepository(submoduleDir);
				writeRuns = await runPhase('write', writeActions, readActions.length);
				options.logger.log('[fixture] write phase done: ' + writeRuns.length + ' runs');
				// The write phase leaves its own mutations in the repository — created branches and
				// tags, made commits, rewritten history. One final in-place reseed ends the run on
				// the same pristine seeded state it started from, so the user's repository does not
				// keep the test's commits once the report is shown. A failure here is recorded like
				// the pre-write one: as a failed write-suite entry, never at the cost of the report.
				try {
					// A write action's `git clean` may have removed the UNTRACKED .gg-fixture marker
					// the reseed keys off — restore the record the run started from first (write
					// actions also rewrite the remote set, so the configured origin cannot be
					// trusted to rebuild it here).
					if (readFixtureMarker(repo) === null && fixtureMarker !== null) {
						fs.writeFileSync(path.join(repo, '.gg-fixture'), JSON.stringify(fixtureMarker, null, 2) + '\n');
					}
					await reseedFixtureClone(repo);
					// The run must not end with the page disagreeing with the repository either —
					// a stale page is exactly what poisons whatever runs against the view next.
					await syncViewAfterReseed(server, repo);
					// Nor with a load option the write suite's toggles left off: the post-run
					// state is what the user (and the next run) inherits.
					await ensureSuiteViewOptions(server, options.logger);
					// The final reseed restored the submodule (a write action may have cleaned it
					// away, unregistering it) — leave the editor knowing both repositories again.
					await registerSubmodule();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					options.logger.logError('write-suite cleanup failed: ' + message);
					writeRuns.push({
						id: 'write-suite/cleanup', title: 'Restore the fixture repository after the write suite', group: 'write',
						mode: 'request', ok: false, skipped: false, reason: null,
						error: message, totalMs: null, responses: [], notifications: []
					});
				}
			}
		}

		const all = [...readRuns, ...writeRuns];
		const totals = {
			actions: all.length,
			passed: all.filter((r) => r.ok).length,
			failed: all.filter((r) => !r.ok && !r.skipped).length,
			skipped: all.filter((r) => r.skipped).length
		};
		const finishedMs = Date.now();
		void grandTotal;
		return {
			startedAt: new Date(startedMs).toISOString(),
			finishedAt: new Date(finishedMs).toISOString(),
			durationMs: finishedMs - startedMs,
			repo, fixture, fixtureGenerated, writeSuiteIncluded: includeWrite,
			suites: [{ name: 'read', runs: readRuns }, { name: 'write', runs: writeRuns }],
			totals
		};
	} finally {
		server.stop();
		uninstallScriptedUiPort();
	}
}

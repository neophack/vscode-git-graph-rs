import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import { AutomationAction, AutomationMode, CATALOG } from './catalog';
import { countRepoCommits, EMPTY_REPO_FIXTURE_OPTIONS, FixtureOptions, seedEmptyRepo, seedRepo } from './fixture';
import { automationOpenTabs, automationTabKey, HostBridge } from './hostBridge';
import { AutomationServer } from './server';

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

const execFileAsync = promisify(execFile);

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
	/** Fixture generation parameters for the empty-repository path (defaults: 2000 commits, 50 branches, 40 tags, 20 authors). */
	readonly fixtureOptions?: Partial<FixtureOptions>;
}

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
	const git = async (args: string[]): Promise<{ stdout: string }> => {
		// The same per-call config as fixture.ts's GIT_BASE_ARGS: a CI runner has no global user
		// identity (the seed's commit would fail with "Author identity unknown"), and the working
		// tree must keep LF endings like the initial seed's checkout.
		return execFileAsync('git', [
			'-c', 'core.autocrlf=false',
			'-c', 'user.name=Fixture',
			'-c', 'user.email=fixture@fixture.dev',
			...args
		], { timeout: 120000, windowsHide: true });
	};
	const lines = (out: { stdout: string }) => out.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');

	// The engine keeps one warm repository handle per path for the whole editor session, and its
	// pack reads are memory-mapped: an active mapping keeps the mapped files undeletable and can
	// serve the pre-reset state. Drop the handle first — the engine re-opens it on the next load.
	new HostBridge().closeRepository(repo);

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
			// its directory is already gone; the prune below clears the registration
		}
	}
	await git(['-C', repo, 'worktree', 'prune']);

	await git(['-C', repo, 'stash', 'clear']);
	await git(['-C', repo, 'fetch', '--prune', '--tags', 'origin']);
	await git(['-C', repo, 'checkout', '-f', '-B', 'main', 'origin/main']);

	// Every branch but main goes (write actions created some; local-ahead is re-seeded below).
	const branches = await git(['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
	for (const name of lines(branches)) {
		if (name !== 'main') await git(['-C', repo, 'branch', '-D', name]);
	}

	// Tags: drop write-added ones by dropping all of them and re-fetching exactly the remote's set.
	const tags = await git(['-C', repo, 'tag', '-l']);
	const tagList = lines(tags);
	if (tagList.length > 0) {
		await git(['-C', repo, 'tag', '-d', ...tagList]);
		await git(['-C', repo, 'fetch', 'origin', '--tags']);
	}

	// Untracked leftovers of the write pass (archives, worktree directories, files a branch
	// switch stranded); also removes the marker, which is restored right after.
	await git(['-C', repo, 'clean', '-fd']);
	fs.writeFileSync(path.join(repo, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');
	await seedRepo(repo);
}

/* ---------------- Per-action cleanup (pages and terminals an action opens) ---------------- */

/** The Git Graph view's webview panel type — the one tab the cleanup must never close. */
const GIT_GRAPH_VIEW_TYPE = 'git-graph-rs';

/** Tab snapshot helpers shared with the automation engine ({@see automationTabKey}). */
const tabKey = automationTabKey;
const openTabs = automationOpenTabs;

/**
 * Close every editor tab that appeared while the action ran (diff views, compare pages, opened
 * files, the settings page, …) and dispose terminals it created. Tabs that existed before and
 * the Git Graph view itself (which the runner may have re-opened) are left alone, so the user's
 * own editors are never touched.
 */
async function cleanupActionSurfaces(beforeTabs: ReadonlySet<string>, beforeTerminals: ReadonlySet<unknown>): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 150)); // let late-opening surfaces appear
	const tabGroups = (vscode.window as any).tabGroups;
	if (tabGroups !== undefined && typeof tabGroups.close === 'function') {
		for (const tab of openTabs()) {
			if (tab.input !== undefined && tab.input.viewType === GIT_GRAPH_VIEW_TYPE) continue;
			if (beforeTabs.has(tabKey(tab))) continue;
			try { await tabGroups.close(tab, true); } catch (_) { /* the tab is already gone */ }
		}
	}
	for (const terminal of (Array.isArray(vscode.window.terminals) ? vscode.window.terminals : [])) {
		if (beforeTerminals.has(terminal)) continue;
		const dispose = (terminal as { dispose?: () => void }).dispose;
		if (typeof dispose === 'function') {
			try { dispose.call(terminal); } catch (_) { /* already disposed */ }
		}
	}
}

/**
 * Close any find / settings / reflog / worktree widget an action left open in the page. Every
 * catalogued action that opens one of these already closes it as the last step of its own `ui`
 * path — but the in-page shim aborts its whole step batch at the first failure, so an action that
 * fails or times out *after* opening one (a `waitFor` that never resolves, an unexpectedly absent
 * row, ...) skips its own closing step and leaves the widget open, where it would otherwise
 * occlude selectors or steal focus in every action that runs after it. Idempotent — a widget the
 * action already closed itself is left alone — and best-effort: no active view (between
 * repositories) is not fatal.
 */
async function closeLeakedWidgets(server: AutomationServer): Promise<void> {
	const expr = '(function(){'
		+ 'var closed=[];'
		+ 'function closeIfActive(activeSelector,closeButtonId){'
		+ 'if(document.querySelector(activeSelector)!==null){'
		+ 'var btn=document.getElementById(closeButtonId);'
		+ 'if(btn!==null){btn.click();closed.push(closeButtonId);}'
		+ '}'
		+ '}'
		+ 'closeIfActive(".findWidget.active","findClose");'
		+ 'closeIfActive("#settingsWidget.active","settingsClose");'
		+ 'closeIfActive("#reflogWidget.active","reflogClose");'
		+ 'closeIfActive("#worktreeWidget.active","worktreeClose");'
		+ 'return closed;'
		+ '})()';
	try {
		await server.eval({ expr });
	} catch (_) {
		// No page to evaluate against right now (e.g. the view is between repositories) - nothing to clean up.
	}
}

/**
 * After the empty-repository fixture generation, bring the loaded view onto the generated
 * repository. The page still shows the repository as it loaded it (empty), and loadRepos skips a
 * repository it is already showing, so the reload is driven through the view's own controls
 * instead of racing the 5 s background change poll:
 *   1. click Refresh and wait for the first commit row (loadRepoInfo + loadCommits landed);
 *   2. open and close the Settings widget — the UI path that re-requests the repository config
 *      (the refresh flow never does) — and wait for the authors dropdown to offer a real author,
 *      so the suite's first action (author-dropdown) has a target to pick.
 */
async function reloadViewAfterGeneration(server: AutomationServer): Promise<void> {
	const refreshExpr = '(function(){'
		+ 'var b=document.getElementById("refreshBtn");'
		+ 'if(b===null)throw new Error("refresh button missing");'
		+ 'b.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'if(document.querySelector(\'tr.commit[data-id="0"]\')!==null)return resolve("reloaded");'
		+ 'if(++n>250)return reject(new Error("the view never rendered the generated commits"));'
		+ 'setTimeout(t,100);};t();});})()';
	const configExpr = '(function(){'
		+ 'var sb=document.getElementById("settingsBtn");'
		+ 'if(sb===null)throw new Error("settings button missing");'
		+ 'sb.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'var w=document.getElementById("settingsWidget");'
		+ 'var active=w!==null&&w.className.split(/\\s+/).indexOf("active")!==-1;'
		+ 'var authors=document.querySelectorAll("#authorDropdown .dropdownOption").length>1;'
		+ 'if(active&&authors){'
		+ 'var cb=document.getElementById("settingsClose");'
		+ 'if(cb!==null)cb.click();'
		+ 'return resolve("config reloaded");}'
		+ 'if(++n>250)return reject(new Error("the generated repository config never loaded"));'
		+ 'setTimeout(t,100);};t();});})()';
	for (const [what, expr] of [['view reload', refreshExpr], ['config reload', configExpr]] as const) {
		const outcome = await server.eval({ expr });
		if (!outcome.ok) throw new Error('post-generation ' + what + ' failed: ' + (outcome.error ?? 'eval failed'));
	}
}

/**
 * Re-sync the rendered page with the repository after a reseed. Every reseed rebuilds the seeded
 * volatile state, and those commits (the stashes, the local-ahead commit) carry fresh hashes each
 * time; the page still lists its pre-reseed commits — the view's cache has no notion of mutations
 * made behind its back — while an action's placeholders resolve against the engine's live state
 * (buildContext's hard probes). Until a refresh lands the two disagree, and the next ui action
 * fails its very first step ("row never rendered" for a commit the engine picked but the page has
 * already forgotten). The Refresh control is clicked and the wait is on the engine's own newest
 * commit appearing as a rendered row — that hash only exists after the reseed, a positive signal
 * that the fresh page arrived rather than just that some page rendered.
 */
async function syncViewAfterReseed(server: AutomationServer, repo: string): Promise<void> {
	const commits = await server.queryCommits(repo, 1);
	const newest = commits.length > 0 ? String(commits[0].hash) : '';
	if (newest === '') return; // an empty repository has nothing to wait for
	const expr = '(function(){'
		+ 'var b=document.getElementById("refreshBtn");'
		+ 'if(b===null)throw new Error("refresh button missing");'
		+ 'b.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'if(document.querySelector(\'tr.commit[data-hash="' + newest + '"]\')!==null)return resolve("reloaded");'
		+ 'if(++n>250)return reject(new Error("the view never rendered the reseeded repository"));'
		+ 'setTimeout(t,100);};t();});})()';
	const outcome = await server.eval({ expr });
	if (!outcome.ok) throw new Error('post-reseed view reload failed: ' + (outcome.error ?? 'eval failed'));
}

/* ---------------- The suite run ---------------- */

export async function runAutomationSuite(options: SuiteRunOptions): Promise<SuiteReport> {
	const startedMs = Date.now();
	const bridge = new HostBridge();
	const server = new AutomationServer({ logger: options.logger, bridge, version: 'in-process' });
	server.start();
	try {
		const timeoutMs = options.actionTimeoutMs ?? 30000;
		const sameRepo = (a: string | null, b: string) =>
			a !== null && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
		let repo = options.repo ?? server.status().currentRepo;
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
			await reloadViewAfterGeneration(server);
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
				if (action.nativeSaveDialog === true) {
					// Confirming this action opens the editor's native save dialog — a modal the
					// run can neither drive nor dismiss (in the real editor it stalls the whole
					// suite until clicked away). Report it as skipped in every mode; never run it.
					runs.push({
						id: action.id, title: action.title, group: action.group, mode,
						ok: false, skipped: true, reason: 'opens the editor\'s native save dialog — not run by the automation suite',
						error: null, totalMs: null, responses: []
					});
					options.onProgress?.({ phase, index: i + 1, total: actions.length, actionId: action.id, mode });
					continue;
				}
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
				const beforeTabs = new Set(openTabs().map(tabKey));
				const beforeTerminals = new Set(Array.isArray(vscode.window.terminals) ? vscode.window.terminals : []);
				let record: ActionRunRecord;
				try {
					const outcome = await server.run({ id: action.id, mode, timeoutMs }) as {
						ok: boolean; skipped?: boolean; reason?: string; error?: string;
						timings?: { totalMs: number; responses: { command: string; atMs: number }[] };
					};
					record = {
						id: action.id, title: action.title, group: action.group, mode,
						ok: outcome.ok, skipped: outcome.skipped === true,
						reason: outcome.reason ?? null, error: outcome.error ?? null,
						totalMs: outcome.timings?.totalMs ?? null,
						responses: outcome.timings?.responses ?? []
					};
				} catch (error) {
					record = {
						id: action.id, title: action.title, group: action.group, mode,
						ok: false, skipped: false, reason: null,
						error: error instanceof Error ? error.message : String(error),
						totalMs: null, responses: []
					};
				}
				await closeLeakedWidgets(server);
				await cleanupActionSurfaces(beforeTabs, beforeTerminals);
				runs.push(record);
				options.onProgress?.({ phase, index: i + 1, total: actions.length, actionId: action.id, mode });
				void offset; // phases report their own index; grand total is derivable from the report
			}
			return runs;
		};

		const readRuns = await runPhase('read', readActions, 0);
		let writeRuns: ActionRunRecord[] = [];
		if (includeWrite) {
			try {
				await reseedFixtureClone(repo);
				// The reseed's fresh stash/local-ahead hashes must be on the page before the first
				// write action resolves its placeholders against the engine (see syncViewAfterReseed).
				await syncViewAfterReseed(server, repo);
			} catch (error) {
				// A failed reseed must not cost the user the whole report (it once aborted the run
				// after the read phase, leaving no report at all): record it as a failed write-suite
				// entry and run the write phase no further — its pristine starting state is gone.
				const message = error instanceof Error ? error.message : String(error);
				options.logger.logError('write-suite reseed failed: ' + message);
				writeRuns = [{
					id: 'write-suite/reseed', title: 'Reset the fixture repository to its seeded state', group: 'write',
					mode: 'request', ok: false, skipped: false, reason: null,
					error: message, totalMs: null, responses: []
				}];
			}
			if (writeRuns.length === 0) {
				writeRuns = await runPhase('write', writeActions, readActions.length);
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
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					options.logger.logError('write-suite cleanup failed: ' + message);
					writeRuns.push({
						id: 'write-suite/cleanup', title: 'Restore the fixture repository after the write suite', group: 'write',
						mode: 'request', ok: false, skipped: false, reason: null,
						error: message, totalMs: null, responses: []
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
	}
}

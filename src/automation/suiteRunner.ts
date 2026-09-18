import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import { AutomationAction, AutomationMode, CATALOG } from './catalog';
import { HostBridge } from './hostBridge';
import { AutomationServer } from './server';

/**
 * The in-process automation suite runner — the "Run Automation Test" button's engine. It drives
 * the automation engine directly (no sockets, no external driver) and runs the catalog's read
 * suite (safe on any repository) and, when the active repository is a fixture clone
 * (`.gg-fixture` marker), the write suite — reseeding the clone from its bare remote first, so
 * the button never touches a real repo. Whatever an action opens (editor tabs, terminals) is
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
	/** TRUE when the active repository is a fixture clone (the write suite ran against it). */
	readonly fixture: boolean;
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
 * The load pipeline's fire-and-forget follow-ups (the remote-refs scan, the "Uncommitted
 * Changes" status) spawn git processes whose working directory — and the pack files they read —
 * sit inside the clone: deleting it while such a process lingers fails with EPERM until the
 * process exits. The PERSISTENT holder — the engine's warm repository handle, whose memory-mapped
 * pack reads keep the mapped files undeletable for as long as the handle lives — is released
 * explicitly by the reseed before this runs; this loop only rides out what is left.
 *
 * Each attempt is a SYNCHRONOUS removal — a complete operation that leaves nothing running once
 * it returns. The awaited fs.promises.rm with maxRetries/retryDelay was tried here first, but on
 * Node 20 (the CI line) its Windows retry path can stall far beyond the nominal budget and, when
 * it raced a held file, its promise never settled at all — hanging the whole suite (and with it
 * the CI job) on a single await. This loop keeps what the awaited rm was chosen for (the thread
 * still breathes between attempts, locks get waited out) while guaranteeing termination: past
 * the deadline the last error propagates, so a stubborn lock fails the reseed loudly instead of
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
 * Reset a fixture clone to a pristine, seeded state: delete it, re-clone from the bare remote
 * recorded in the marker, restore the marker (a fresh clone does not carry it), and replay the
 * seed routine (3 stashes, an untracked file, the local-ahead branch) so write actions have the
 * same starting state on every run. Mirrors scripts/automation/fixture.mjs's seedRepo.
 */
export async function reseedFixtureClone(repo: string): Promise<void> {
	const marker = readFixtureMarker(repo);
	if (marker === null) throw new Error(repo + ' is not a fixture clone (no .gg-fixture marker)');
	const git = async (args: string[]) => {
		// The same per-call config as scripts/automation/fixture.mjs (GIT_BASE_ARGS): a CI runner
		// has no global user identity (the commit below would fail with "Author identity unknown"),
		// and the clone's working tree must keep LF endings like the initial seed's clone.
		await execFileAsync('git', [
			'-c', 'core.autocrlf=false',
			'-c', 'user.name=Fixture',
			'-c', 'user.email=fixture@fixture.dev',
			...args
		], { timeout: 120000, windowsHide: true });
	};
	// The engine keeps one warm repository handle per path for the whole editor session, and its
	// pack reads are memory-mapped: on Windows an active mapping keeps every mapped file
	// undeletable, which is the EPERM the removal below kept dying on (reproducibly held by THIS
	// process, not by any git child). Drop the handle first — the engine re-opens it on the next
	// load of the re-cloned repository.
	new HostBridge().closeRepository(repo);
	await rmTreeAwaitingLocks(repo);
	await git(['clone', marker.remote, repo]);
	fs.writeFileSync(path.join(repo, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');

	const rng = (() => { let s = 987654321 >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
	await git(['-C', repo, 'stash', 'clear']);
	await git(['-C', repo, 'checkout', '-f', 'main']);
	await git(['-C', repo, 'reset', '--hard', 'origin/main']);
	const files = fs.readdirSync(path.join(repo, 'src', 'module-000')).filter((f) => f.endsWith('.ts'));
	if (files.length === 0) throw new Error(repo + ' has no seeded files to stash');
	const tracked = ['src/module-000/' + files[0]];
	for (let i = 0; i < 3; i++) {
		const file = tracked[0];
		fs.appendFileSync(path.join(repo, file),
			'\n// fixture-stash-' + (i + 1) + '\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
		await git(['-C', repo, 'stash', 'push', '-m', 'fixture-stash-' + (i + 1), '--', file]);
	}
	fs.writeFileSync(path.join(repo, 'untracked-fixture.txt'), 'fixture untracked file\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
	await git(['-C', repo, 'checkout', '-b', 'local-ahead']);
	fs.writeFileSync(path.join(repo, 'local-ahead-note.txt'), 'local-ahead is one commit ahead of origin/main\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
	await git(['-C', repo, 'add', 'local-ahead-note.txt']);
	await git(['-C', repo, 'commit', '-m', 'local-ahead fixture commit']);
	await git(['-C', repo, 'checkout', 'main']);
}

/* ---------------- Per-action cleanup (pages and terminals an action opens) ---------------- */

/** The Git Graph view's webview panel type — the one tab the cleanup must never close. */
const GIT_GRAPH_VIEW_TYPE = 'git-graph-rs';

/**
 * Identify a tab by its content (view type and/or document URIs) so a before/after snapshot can
 * diff it. Uses only `any` accesses: the Tab API is younger than the extension's supported VS
 * Code range, and every cleanup step is feature-detected and skipped where unavailable.
 */
function tabKey(tab: any): string {
	const input = tab.input;
	if (input === undefined) return 'label:' + tab.label;
	const parts = [input.viewType, input.uri?.toString(), input.original?.toString(), input.modified?.toString()]
		.filter((part) => part !== undefined && part !== '');
	return parts.length > 0 ? parts.join('|') : 'label:' + tab.label;
}

function openTabs(): any[] {
	const tabGroups = (vscode.window as any).tabGroups;
	if (tabGroups === undefined || !Array.isArray(tabGroups.all)) return [];
	// No flatMap here: src/tsconfig.json targets the es6 lib (the extension's VS Code floor).
	const tabs: any[] = [];
	for (const group of tabGroups.all as any[]) {
		if (Array.isArray(group.tabs)) tabs.push(...group.tabs);
	}
	return tabs;
}

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

/* ---------------- The suite run ---------------- */

export async function runAutomationSuite(options: SuiteRunOptions): Promise<SuiteReport> {
	const startedMs = Date.now();
	const server = new AutomationServer({ logger: options.logger, bridge: new HostBridge(), version: 'in-process' });
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

		const fixture = isAutomationFixtureClone(repo);
		const includeWrite = !options.skipWriteSuite && fixture;
		const filter = options.filter ?? (() => true);
		const readActions = CATALOG.filter((a) => !a.mutable && filter(a));
		const writeActions = includeWrite ? CATALOG.filter((a) => a.mutable && filter(a)) : [];
		const grandTotal = readActions.length + writeActions.length;

		const runPhase = async (phase: 'read' | 'write', actions: readonly AutomationAction[], offset: number): Promise<ActionRunRecord[]> => {
			const runs: ActionRunRecord[] = [];
			for (let i = 0; i < actions.length; i++) {
				const action = actions[i];
				const mode: AutomationMode = action.ui !== undefined ? 'ui' : 'request';
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
			await reseedFixtureClone(repo);
			writeRuns = await runPhase('write', writeActions, readActions.length);
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
			repo, fixture, writeSuiteIncluded: includeWrite,
			suites: [{ name: 'read', runs: readRuns }, { name: 'write', runs: writeRuns }],
			totals
		};
	} finally {
		server.stop();
	}
}

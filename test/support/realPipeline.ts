/**
 * Harness for the real-pipeline integration suites (tests/webviewRealPipelineHarness.mjs ported
 * for Vitest, REFACTOR-PLAN task 7.1): boot the REAL extension sources (the git layer +
 * RepoManager + GitGraphView, composed exactly like src/extension.ts) against a REAL throwaway
 * git repository and the REAL compiled webview (media/out.testbundle.js) inside jsdom, wired
 * together through the message pipeline of the editor.
 *
 * The legacy out/ compile tree is gone: the modules come from the TypeScript sources through
 * Vitest's `vscode` alias (test/support/vscodeAlias.ts). The harness re-points the shared alias
 * singleton in place per boot — the same trick the old process-wide Module._load stub used, so
 * the require-cached modules keep observing the live workspace folder.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { vscodeState } from './vscodeAlias';
import { vscodeMockOf } from './fakeVscode';
import type * as vscode from 'vscode';
import { EventEmitter } from '../../src/utils/event';
import type { GitExecutable } from '../../src/utils/findGit';
import { Logger } from '../../src/extension/platform/logger';
import { ExtensionState } from '../../src/extension/platform/storage';
import { AvatarManager } from '../../src/extension/integrations/avatars/avatarManager';
import { RepoManager } from '../../src/extension/repos/repoManager';
import { GitGraphView } from '../../src/extension/graphView/panel';
import { GitProcess } from '../../src/extension/git/process/gitProcess';
import { GitWriter } from '../../src/extension/git/write/gitWriter';
import { GitRepository } from '../../src/extension/git/gitRepository';
import { createBackend } from '../../src/extension/git/read/backendIndex';
import { createGitRunner } from '../../src/extension/graphView/gitRunner';
import type { LegacyViewPort } from '../../src/extension/graphView/gitRunner';
import { gerritDataSourceOver } from '../../src/extension/integrations/gerrit/gerrit';
import { AutomationServer } from '../../src/automation/server';
import { HostBridge } from '../../src/automation/hostBridge';
import * as suiteRunner from '../../src/automation/suiteRunner';
import * as reportView from '../../src/automation/reportView';
import { CommandManager } from '../../src/extension/commands';
import { ROW_HEIGHT, VIEWPORT_HEIGHT } from './webviewHost';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const TOTAL_COMMITS = 401;

/* ---------- a git repository with a long, linear history ---------- */

function git(repo: string, ...args: string[]) {
	return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

export function createRepo(repo: string) {
	fs.rmSync(repo, { recursive: true, force: true });
	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');

	// One fast-import stream: the base commit adds a tracked file, then 400 empty commits on top
	const message = (i: number) => 'commit ' + i;
	let stream = '';
	for (let i = 0; i < TOTAL_COMMITS; i++) {
		const msg = message(i);
		stream += 'commit refs/heads/main\n';
		stream += `committer Test <test@example.com> ${1700000000 + i * 60} +0000\n`;
		stream += `data ${msg.length}\n${msg}\n`;
		if (i === 0) stream += 'M 100644 inline tracked.txt\ndata 6\nhello\n';
	}
	execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: stream });
	git(repo, 'reset', '-q', '--hard'); // populate the index and the working tree
	return message;
}

/* ---------- the stubbed `vscode` API the extension runs against ---------- */

/* The extension's AskpassManager starts an HTTP server that keeps the test process alive:
 * record every server it creates so the harness can close it on cleanup. */
const createdServers: http.Server[] = [];
const originalCreateServer = http.createServer;
(http.createServer as any) = function (...args: unknown[]) {
	const server = originalCreateServer.apply(http, args as any);
	createdServers.push(server);
	return server;
};

let extensionToWebview: ((message: unknown) => void) | null = null; // set once the jsdom window exists: delivers the graph panel's postMessage into the DOM
/** Debug hook: called with every extension -> webview message. */
let onExtensionMessage: ((message: any) => void) | null = null;
export function setOnExtensionMessage(fn: ((message: any) => void) | null) { onExtensionMessage = fn; }
let afterDeliver: ((message: any) => void) | null = null;
/** Debug/test hook: invoked after every extension -> webview message was dispatched into the DOM. */
export function setAfterDeliver(fn: ((message: any) => void) | null) { afterDeliver = fn; }

function disposable() { return { dispose: () => { /* nothing */ } }; }
class FakeConfiguration {
	get(_key: string, defaultValue: unknown) { return defaultValue; }
	has() { return false; }
	update() { return Promise.resolve(); }
}

/* VS Code gives EVERY webview its own panel with its own message handler. A singleton stub
 * shared with other views (the Commit Comparison view opened by openCompareTab registers its
 * own onDidReceiveMessage) would let the later view's handler overwrite the graph view's and
 * silently swallow page->host traffic — so each createWebviewPanel call gets a fresh panel. */
function makePanel() {
	const viewStateHandlers: Array<(panel: unknown) => void> = [];
	const panel: any = {
		title: '', iconPath: null, visible: true, active: true,
		webview: {
			html: '', cspSource: 'https://stub.invalid',
			asWebviewUri: (uri: any) => 'media/' + path.basename(uri.fsPath || uri.path || String(uri)),
			postMessage: (msg: unknown) => {
				if (onExtensionMessage !== null) onExtensionMessage(msg);
				// Only the graph view's page exists in jsdom; other panels' messages go nowhere.
				if (extensionToWebview !== null && panel === graphPanel) extensionToWebview(msg);
				return Promise.resolve(true);
			},
			onDidReceiveMessage: (handler: (m: unknown) => void) => { panel.webview.__onDidReceive = handler; return disposable(); },
			__onDidReceive: null
		},
		onDidDispose: () => disposable(),
		onDidChangeViewState: (handler: (panel: unknown) => void) => { viewStateHandlers.push(handler); return disposable(); },
		reveal: () => { /* nothing */ }, dispose: () => { /* nothing */ },
		__fireViewState: () => { for (const handler of viewStateHandlers) handler(panel); }
	};
	return panel;
}
let graphPanel: any = null;

/* Every FileSystemWatcher the extension created, alive or disposed. Tests fire the events a real
 * repository change produces; disposed watchers stay silent, exactly like disposed VS Code watchers
 * (the extension's RepoFileWatcher.stop disposes them when a tab is hidden - the old behaviour the
 * hidden-commit regression test pins down). */
const fileWatchers: any[] = [];
function makeFileWatcher() {
	const watcher: any = { __handlers: { change: [] as Array<(uri: unknown) => void>, create: [] as Array<(uri: unknown) => void>, delete: [] as Array<(uri: unknown) => void> }, __disposed: false };
	watcher.onDidChange = (handler: (uri: unknown) => void) => { watcher.__handlers.change.push(handler); return disposable(); };
	watcher.onDidCreate = (handler: (uri: unknown) => void) => { watcher.__handlers.create.push(handler); return disposable(); };
	watcher.onDidDelete = (handler: (uri: unknown) => void) => { watcher.__handlers.delete.push(handler); return disposable(); };
	watcher.dispose = () => { watcher.__disposed = true; };
	fileWatchers.push(watcher);
	return watcher;
}

/** Fire one filesystem event into every watcher the extension still has registered. */
export function fireRepoFileEvent(kind: 'change' | 'create' | 'delete', absolutePath: string) {
	const uri = { fsPath: absolutePath };
	for (const watcher of fileWatchers) {
		if (watcher.__disposed) continue;
		for (const handler of watcher.__handlers[kind]) handler(uri);
	}
}

/** Flip the graph panel's visibility the way switching editor tabs does, notifying the extension. */
export function setGraphPanelVisible(visible: boolean) {
	if (graphPanel === null) return;
	graphPanel.visible = visible;
	graphPanel.active = visible;
	graphPanel.__fireViewState();
}

/* ---------- the pipeline stub, installed onto the shared vscode alias singleton ---------- */

/* One stub for the whole test file. The extension modules resolve the same alias singleton and
 * hold the exact stub object they were loaded with, so a fresh stub per boot would be invisible
 * to them: RepoManager would go on scanning the FIRST boot's workspace folder (deleted by that
 * test's cleanup) and never discover the second repository. Each boot re-points the folder in
 * place on the same object instead. */
let commandHandlers: Record<string, (...args: unknown[]) => unknown> = {};

function ensurePipelineStub() {
	// The alias singleton every src module already resolved: graft the pipeline-shaped members
	// onto it in place (never replace the member objects themselves - the modules hold them).
	const stub: any = vscodeMockOf(vscodeState);
	const uriFile = (p: string) => ({ scheme: 'file', fsPath: path.normalize(p), path: String(p).replace(/\\/g, '/'), with: () => uriFile(p) });
	stub.Uri.file = uriFile;
	stub.Uri.joinPath = (uri: any, ...segments: string[]) => uriFile(path.join(uri.fsPath, ...segments));
	stub.workspace.workspaceFolders = [{ uri: null, name: '', index: 0 }];
	stub.workspace.getConfiguration = () => new FakeConfiguration();
	stub.workspace.onDidChangeConfiguration = () => disposable();
	stub.workspace.onDidChangeWorkspaceFolders = () => disposable();
	stub.workspace.createFileSystemWatcher = () => makeFileWatcher();
	stub.workspace.openTextDocument = async () => ({ uri: uriFile('stub'), lineCount: 0 });
	stub.window.createWebviewPanel = () => {
		const panel = makePanel();
		if (graphPanel === null) graphPanel = panel; // the first panel is the graph view's
		return panel;
	};
	stub.window.showTextDocument = async () => undefined;
	stub.window.showSaveDialog = async () => undefined;
	// registerCommand RECORDS the handler (the real CommandManager registers through this
	// stub), so executeCommand dispatches to the extension's own command implementations —
	// command-mode automation actions (the contributed VS Code menus' commands) run the
	// real handlers exactly like the editor does.
	stub.commands.registerCommand = (name: string, handler: (...args: unknown[]) => unknown) => {
		commandHandlers[name] = handler;
		return disposable();
	};
	stub.commands.registerTextEditorCommand = () => disposable();
	// The automation host commands (openExtensionSettings, viewScm, vscode.diff, ...) resolve
	// through executeCommand; unimplemented commands stay no-ops so those request paths are
	// answerable in tests, while the registered ones (see commandHandlers) run for real.
	stub.commands.executeCommand = async (name: string, arg: unknown) => {
		const handler = commandHandlers[name];
		return handler === undefined ? undefined : handler(arg);
	};
	stub.RelativePattern = class RelativePattern { constructor(base: unknown, pattern: string) { (this as any).base = base; (this as any).pattern = pattern; } };
	return stub;
}
ensurePipelineStub();

export interface BootedPipeline {
	window: any;
	document: Document;
	viewElem: any;
	scrollTo: (row: number) => Promise<void>;
	rows: () => HTMLElement[];
	GitGraphView: typeof GitGraphView;
	dispose: () => void;
	sleep: typeof sleep;
	automation: {
		AutomationServer: typeof AutomationServer;
		HostBridge: typeof HostBridge;
		suiteRunner: typeof suiteRunner;
		reportView: typeof reportView;
	};
}

export async function bootRealView(repo: string): Promise<BootedPipeline> {
	const stub = ensurePipelineStub();
	graphPanel = null; // one live graph view per file: a fresh boot takes over the routing
	commandHandlers = {};
	stub.workspace.workspaceFolders[0] = { uri: stub.Uri.file(repo), name: path.basename(repo), index: 0 };

	const logger = new Logger();
	const gitExecutableEmitter = new EventEmitter<GitExecutable | null>();
	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();

	// A real in-memory memento: the extension persists per-repo state (code reviews, repository
	// preferences, ...) through workspaceState, and stateless stubs made every read forget every
	// write — an action that starts a code review and then updates it answered "not found" in the
	// harness while working in the real editor. Reads see writes, like the editor's memento.
	const makeMemento = () => {
		const values = new Map<string, unknown>();
		return {
			get: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
			set: async (key: string, value: unknown) => { values.set(key, value); },
			update: async (key: string, value: unknown) => { values.set(key, value); },
			keys: () => [...values.keys()]
		};
	};

	const context = {
		subscriptions: [] as Array<{ dispose(): void }>, extensionPath: rootDir, extensionUri: stub.Uri.file(rootDir),
		globalState: makeMemento(),
		workspaceState: makeMemento(),
		globalStoragePath: path.join(rootDir, 'target', 'harness-global-storage'),
		storagePath: path.join(rootDir, 'target', 'harness-storage'),
		asAbsolutePath: (p: string) => path.join(rootDir, p)
	};
	const extensionState = new ExtensionState(context as any, gitExecutableEmitter.subscribe);

	// The GitRepository facade the view reads and writes through, over the same real git binary
	// (engine preferred, CLI fallback - createBackend decides), and the raw runner the editor-
	// script flows use. Mirrors src/extension.ts composition-for-composition.
	const gitProcess = new GitProcess(() => ({ path: 'git', version: '2.50.0' }));
	const gitWriter = new GitWriter(gitProcess, () => ({ signCommits: false, signTags: false }), (key: string) => key);
	const viewReader = createBackend({ gitPath: 'git' });
	const viewRepo = new GitRepository(viewReader, gitWriter, runTextOf(gitProcess));
	const gitRunner = createGitRunner(gitProcess, null, (key: string) => key);
	const legacyViews: LegacyViewPort = { openCompareTab: () => { /* nothing */ }, openBinaryCompare: () => { /* nothing */ } };

	const avatarManager = new AvatarManager(viewReader, extensionState, logger);
	const repoManager = new RepoManager(viewRepo, gitRunner, extensionState, configurationEmitter.subscribe, logger);

	for (let i = 0; i < 600 && Object.keys(repoManager.getRepos()).length === 0; i++) await sleep(100);
	if (Object.keys(repoManager.getRepos()).length === 0) throw new Error('the repository was discovered');

	// The REAL command registry: every `git-graph-rs.*` command registers through the stub's
	// recording registerCommand (see above), so executeCommand dispatches to the compiled
	// CommandManager's handlers — command-mode automation actions (the contributed VS Code menus'
	// commands, e.g. filterByFile, view, amendLastCommit) run the same code the editor's menus
	// run, and the host bridge's openView keeps switching repositories as before.
	const commandGerrit = gerritDataSourceOver(gitRunner);
	// The deferred Git resolution (OPTIMIZATION-PLAN V1): a settled port standing in for the
	// composition root's — current() is always the known executable, never restricted.
	const commandGitResolution = { current: () => ({ path: 'git', version: '2.50.0' }), restricted: () => false, ready: () => Promise.resolve({ path: 'git', version: '2.50.0' }) };
	const commandManager = new CommandManager(context as any, avatarManager, viewRepo, gitRunner, commandGerrit, legacyViews, extensionState, repoManager, commandGitResolution, configurationEmitter.subscribe, logger as any);

	GitGraphView.createOrShow(rootDir, viewRepo, gitRunner, legacyViews, extensionState, avatarManager, repoManager, new Logger(), null);
	if (graphPanel.webview.html.length <= 0) throw new Error('the webview html was generated');

	// The extension (and its AskpassManager HTTP servers) is live from here on: anything that
	// fails below must still tear it down, or the open servers keep the test worker alive.
	const dispose = () => {
		commandHandlers = {};
		commandManager.dispose();
		if (GitGraphView.currentPanel !== undefined) GitGraphView.currentPanel.dispose();
		// Release the engine's repository handles (the inverse of what the suite asserts must stay
		// open across requests): the harness owns this RepoManager, nobody else will close it —
		// EVERY known repository, not just the boot one, because a runAutomationSuite({ repo })
		// call registers and engine-opens further repositories whose memory-mapped pack files
		// would otherwise hold the after-hook's cleanup hostage on Windows (EPERM past the whole
		// bounded-removal budget).
		for (const known of Object.keys(repoManager.getRepos())) repoManager['removeRepo'](known);
		try { viewReader.closeAllRepositories(); } catch { /* nothing opened yet */ }
		for (const server of createdServers.splice(0)) server.close();
	};

	/* Boot the html in jsdom: the inline initialState script runs during parsing (acquireVsCodeApi
	 * is injected beforehand via beforeParse); the compiled webview bundle is then evaluated
	 * manually, exactly like the standalone harness does. */
	let window: any;
	let document: Document;
	let scrollTopValue = 0;
	try {
		const dom = new JSDOM(graphPanel.webview.html, {
			runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.invalid/',
			beforeParse: (w: any) => {
				w.acquireVsCodeApi = () => w.__api;
			}
		});
		window = dom.window;
		document = window.document;
		window.__api = {
			getState: () => null,
			setState: () => { /* nothing */ },
			postMessage: (message: unknown) => { graphPanel.webview.__onDidReceive(message); }
		};
		// Host → page: the harness delivers extension messages by dispatching a window
		// MessageEvent (as a real webview does).
		extensionToWebview = (message: unknown) => {
			setTimeout(() => {
				window.dispatchEvent(new window.MessageEvent('message', { data: message }));
				if (afterDeliver !== null) afterDeliver(message);
			}, 5);
		};

		// jsdom has no layout engine: emulate the scroll container (same model as the standalone
		// harness, plus the windowed renderer's spacer rows). scrollHeight grows with the rendered
		// commit rows PLUS the #virtSpacerTop/Bottom placeholders, which in a real browser keep the
		// scroll bar proportional to the whole loaded commit list — without them the height would
		// only ever cover the rendered window, and no test could scroll past it (deep branch
		// labels, stash rows, pinned rows).
		const viewElem = document.getElementById('view')!;
		const spacerHeight = (selector: string) => {
			const td = document.querySelector(selector + ' td') as HTMLElement | null;
			return td !== null ? parseFloat(td.style.height) || 0 : 0;
		};
		Object.defineProperty(viewElem, 'scrollTop', { get: () => scrollTopValue, set: (v: number) => { scrollTopValue = Math.max(0, v); } });
		Object.defineProperty(viewElem, 'scrollHeight', {
			get: () => document.querySelectorAll('#commitTable tr.commit').length * ROW_HEIGHT
				+ spacerHeight('#virtSpacerTop') + spacerHeight('#virtSpacerBottom')
		});
		Object.defineProperty(viewElem, 'clientHeight', { get: () => VIEWPORT_HEIGHT });
		Object.defineProperty(viewElem, 'clientWidth', { get: () => 1200 });
		window.Element.prototype.scroll = function () { /* nothing */ };
		window.Element.prototype.scrollTo = function () { /* nothing */ };

		/* The webview entry is an ES module (window.eval cannot run it): execute the build's
		 * single-file IIFE variant of the same entry instead (identical module graph, the
		 * on-demand imports inlined rather than chunked). */
		window.eval(fs.readFileSync(path.join(rootDir, 'media', 'out.testbundle.js'), 'utf8'));
		window.dispatchEvent(new window.Event('load'));
	} catch (error) {
		extensionToWebview = null;
		dispose();
		if (window !== undefined) window.close(); // drop the jsdom timers
		throw error;
	}

	const viewElem = document.getElementById('view')!;
	const scrollTo = async (row: number) => {
		scrollTopValue = row * ROW_HEIGHT;
		viewElem.dispatchEvent(new window.Event('scroll'));
		await sleep(120); // let the rAF-debounced window update run
	};
	const rows = () => Array.from(document.querySelectorAll('#commitTable tr.commit')) as HTMLElement[];
	return { window, document, viewElem, scrollTo, rows, GitGraphView, dispose, sleep, automation: { AutomationServer, HostBridge, suiteRunner, reportView } };
}

/** The facade's plain text runner (src/extension.ts runTextOf, mirrored for the harness). */
function runTextOf(process: GitProcess) {
	const eol = /\r\n|\r|\n/;
	return (argv: ReadonlyArray<string>, repo: string) => process.run(argv, { cwd: repo }).then((result) => {
		if (result.code !== 0) {
			const lines = (result.stderr + result.stdout.toString('utf8')).split(eol);
			lines.pop();
			throw lines.join('\n');
		}
		return result.stdout.toString('utf8');
	});
}

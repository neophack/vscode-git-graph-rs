/**
 * Harness for the real-pipeline integration test (see webviewRealPipeline.test.mjs): boot the
 * REAL compiled extension (DataSource + RepoManager + GitGraphView) against a REAL throwaway git
 * repository and the REAL compiled webview (media/out.min.js) inside jsdom, wired together
 * through the message pipeline of the editor.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Module } from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { JSDOM } from 'jsdom';
import { ROW_HEIGHT, VIEWPORT_HEIGHT } from './webviewHarness.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const TOTAL_COMMITS = 401;


/* ---------- a git repository with a long, linear history ---------- */

function git(repo, ...args) {
	return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

export function createRepo(repo) {
	fs.rmSync(repo, { recursive: true, force: true });
	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'user.email', 'test@example.com');
	git(repo, 'config', 'user.name', 'Test');

	// One fast-import stream: the base commit adds a tracked file, then 400 empty commits on top
	const message = (i) => 'commit ' + i;
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
const createdServers = [];
const originalCreateServer = http.createServer;
http.createServer = function (...args) {
	const server = originalCreateServer.apply(this, args);
	createdServers.push(server);
	return server;
};

let extensionToWebview = null; // set once the jsdom window exists: delivers the graph panel's postMessage into the DOM
/** Debug hook: called with every extension -> webview message. */
let onExtensionMessage = null;
export function setOnExtensionMessage(fn) { onExtensionMessage = fn; }
let afterDeliver = null;
/** Debug/test hook: invoked after every extension -> webview message was dispatched into the DOM. */
export function setAfterDeliver(fn) { afterDeliver = fn; }

function disposable() { return { dispose: () => {} }; }
class FakeConfiguration {
	get(_key, defaultValue) { return defaultValue; }
	has() { return false; }
	update() { return Promise.resolve(); }
}

/* VS Code gives EVERY webview its own panel with its own message handler. A singleton stub
 * shared with other views (the Commit Comparison view opened by openCompareTab registers its
 * own onDidReceiveMessage) would let the later view's handler overwrite the graph view's and
 * silently swallow page->host traffic — so each createWebviewPanel call gets a fresh panel. */
function makePanel() {
	const viewStateHandlers = [];
	const panel = {
		title: '', iconPath: null, visible: true, active: true,
		webview: {
			html: '', cspSource: 'https://stub.invalid',
			asWebviewUri: (uri) => 'media/' + path.basename(uri.fsPath || uri.path || String(uri)),
			postMessage: (msg) => {
				if (onExtensionMessage !== null) onExtensionMessage(msg);
				// Only the graph view's page exists in jsdom; other panels' messages go nowhere.
				if (extensionToWebview !== null && panel === graphPanel) extensionToWebview(msg);
				return Promise.resolve(true);
			},
			onDidReceiveMessage: (handler) => { panel.webview.__onDidReceive = handler; return disposable(); },
			__onDidReceive: null
		},
		onDidDispose: () => disposable(),
		onDidChangeViewState: (handler) => { viewStateHandlers.push(handler); return disposable(); },
		reveal: () => {}, dispose: () => {},
		__fireViewState: () => { for (const handler of viewStateHandlers) handler(panel); }
	};
	return panel;
}
let graphPanel = null;

/* Every FileSystemWatcher the extension created, alive or disposed. Tests fire the events a real
 * repository change produces; disposed watchers stay silent, exactly like disposed VS Code watchers
 * (the extension's RepoFileWatcher.stop disposes them when a tab is hidden - the old behaviour the
 * hidden-commit regression test pins down). */
const fileWatchers = [];
function makeFileWatcher() {
	const watcher = { __handlers: { change: [], create: [], delete: [] }, __disposed: false };
	watcher.onDidChange = (handler) => { watcher.__handlers.change.push(handler); return disposable(); };
	watcher.onDidCreate = (handler) => { watcher.__handlers.create.push(handler); return disposable(); };
	watcher.onDidDelete = (handler) => { watcher.__handlers.delete.push(handler); return disposable(); };
	watcher.dispose = () => { watcher.__disposed = true; };
	fileWatchers.push(watcher);
	return watcher;
}

/** Fire one filesystem event into every watcher the extension still has registered. */
export function fireRepoFileEvent(kind, absolutePath) {
	const uri = { fsPath: absolutePath };
	for (const watcher of fileWatchers) {
		if (watcher.__disposed) continue;
		for (const handler of watcher.__handlers[kind]) handler(uri);
	}
}

/** Flip the graph panel's visibility the way switching editor tabs does, notifying the extension. */
export function setGraphPanelVisible(visible) {
	if (graphPanel === null) return;
	graphPanel.visible = visible;
	graphPanel.active = visible;
	graphPanel.__fireViewState();
}

/* ---------- boot the real extension + the real webview, wired together ---------- */

/* One `vscode` stub for the whole process. The extension modules are require-cached after the
 * first boot and hold the exact stub object they were loaded with, so a fresh stub per boot
 * would be invisible to them: RepoManager would go on scanning the FIRST boot's workspace
 * folder (deleted by that test's cleanup) and never discover the second repository. Each boot
 * re-points the folder in place on the same object instead. */
let vscodeStub = null;
/* Commands the harness actually implements (currently only git-graph-rs.view, mirroring
 * commands.ts's view() so the automation host bridge's openView can switch repositories in
 * tests); anything else resolves to undefined like the previous no-op stub. */
let commandHandlers = {};

export async function bootRealView(repo) {
	graphPanel = null; // one live graph view per process: a fresh boot takes over the routing
	if (vscodeStub === null) vscodeStub = {
		Uri: {
			file: (p) => ({ scheme: 'file', fsPath: path.normalize(p), path: String(p).replace(/\\/g, '/'), with: () => vscodeStub.Uri.file(p) }),
			joinPath: (uri, ...segments) => vscodeStub.Uri.file(path.join(uri.fsPath, ...segments))
		},
		workspace: {
			workspaceFolders: [{ uri: null, name: path.basename(repo), index: 0 }],
			getConfiguration: () => new FakeConfiguration(),
			onDidChangeConfiguration: () => disposable(),
			onDidChangeWorkspaceFolders: () => disposable(),
			createFileSystemWatcher: () => makeFileWatcher(),
			openTextDocument: async () => ({ uri: vscodeStub.Uri.file('stub'), lineCount: 0 }),
			fs: { stat: async () => { throw new Error('not available'); }, readFile: async () => { throw new Error('not available'); } }
		},
		window: {
			createWebviewPanel: () => {
				const panel = makePanel();
				if (graphPanel === null) graphPanel = panel; // the first panel is the graph view's
				return panel;
			},
			createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
			showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
			createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
			createTerminal: () => ({ show: () => {}, dispose: () => {}, sendText: () => {} }),
			showTextDocument: async () => undefined,
			showSaveDialog: async () => undefined,
			withProgress: (_options, task) => task({ report: () => {} }),
			activeTextEditor: undefined
		},
		commands: {
			// registerCommand RECORDS the handler (the real CommandManager registers through this
			// stub), so executeCommand dispatches to the extension's own command implementations —
			// command-mode automation actions (the contributed VS Code menus' commands) run the
			// real handlers exactly like the editor does.
			registerCommand: (name, handler) => { commandHandlers[name] = handler; return disposable(); },
			registerTextEditorCommand: () => disposable(),
			// The automation host commands (openExtensionSettings, viewScm, vscode.diff, ...) resolve
			// through executeCommand; unimplemented commands stay no-ops so those request paths are
			// answerable in tests, while the registered ones (see commandHandlers) run for real.
			executeCommand: async (name, arg) => {
				const handler = commandHandlers[name];
				return handler === undefined ? undefined : handler(arg);
			}
		},
		RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		env: { appName: 'VS Code', clipboard: { writeText: async () => {} }, openExternal: async () => false, language: 'en' },
		version: '1.90.0',
		ViewColumn: { Active: -1, Beside: -2, One: 1 },
		ConfigurationTarget: { Global: 1, Workspace: 2 }
	};
	vscodeStub.workspace.workspaceFolders[0] = { uri: vscodeStub.Uri.file(repo), name: path.basename(repo), index: 0 };

	const originalLoad = Module._load;
	let vscodeStubActive = false;
	Module._load = function (request, ...rest) {
		if (request === 'vscode' && vscodeStubActive) return vscodeStub;
		return originalLoad.apply(this, [request, ...rest]);
	};

	// The webview harness module also hooks 'vscode' (for out/config.js): activate ours only while
	// the extension modules load, then hand control back by resolving each module eagerly
	vscodeStubActive = true;
	const { EventEmitter } = require(path.join(rootDir, 'out', 'utils', 'event.js'));
	const { Logger } = require(path.join(rootDir, 'out', 'logger.js'));
	const { ExtensionState } = require(path.join(rootDir, 'out', 'extensionState.js'));
	const { DataSource } = require(path.join(rootDir, 'out', 'dataSource.js'));
	const { AvatarManager } = require(path.join(rootDir, 'out', 'avatarManager.js'));
	const { RepoManager } = require(path.join(rootDir, 'out', 'repoManager.js'));
	const { GitGraphView } = require(path.join(rootDir, 'out', 'gitGraphView.js'));
	// The automation server + bridge resolve 'vscode' and gitGraphView too: load them inside the
	// stub window so tests can drive the real pipeline over the real socket protocol.
	const { AutomationServer } = require(path.join(rootDir, 'out', 'automation', 'server.js'));
	const { HostBridge } = require(path.join(rootDir, 'out', 'automation', 'hostBridge.js'));
	// The in-process suite runner + report page (the "Run Automation Test" button's engine).
	const suiteRunner = require(path.join(rootDir, 'out', 'automation', 'suiteRunner.js'));
	const reportView = require(path.join(rootDir, 'out', 'automation', 'reportView.js'));
	// The real command registry: loaded inside the stub window so commands.ts's conditional
	// automation requires resolve against the same stub.
	const { CommandManager } = require(path.join(rootDir, 'out', 'commands.js'));
	vscodeStubActive = false;

	const logger = new Logger();
	const gitExecutableEmitter = new EventEmitter();
	const configurationEmitter = new EventEmitter();

	// A real in-memory memento: the extension persists per-repo state (code reviews, repository
	// preferences, ...) through workspaceState, and stateless stubs made every read forget every
	// write — an action that starts a code review and then updates it answered "not found" in the
	// harness while working in the real editor. Reads see writes, like the editor's memento.
	const makeMemento = () => {
		const values = new Map();
		return {
			get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
			set: async (key, value) => { values.set(key, value); },
			update: async (key, value) => { values.set(key, value); },
			keys: () => [...values.keys()]
		};
	};

	const context = {
		subscriptions: [], extensionPath: rootDir, extensionUri: vscodeStub.Uri.file(rootDir),
		globalState: makeMemento(),
		workspaceState: makeMemento(),
		globalStoragePath: path.join(rootDir, 'target', 'harness-global-storage'),
		storagePath: path.join(rootDir, 'target', 'harness-storage'),
		asAbsolutePath: (p) => path.join(rootDir, p)
	};
	const extensionState = new ExtensionState(context, gitExecutableEmitter.subscribe);
	const dataSource = new DataSource({ path: 'git', version: '2.50.0' }, configurationEmitter.subscribe, gitExecutableEmitter.subscribe, logger);
	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, configurationEmitter.subscribe, logger);

	for (let i = 0; i < 100 && Object.keys(repoManager.getRepos()).length === 0; i++) await sleep(100);
	assert.ok(Object.keys(repoManager.getRepos()).length > 0, 'the repository was discovered');

	// The REAL command registry: every `git-graph-rs.*` command registers through the stub's
	// recording registerCommand (see above), so executeCommand dispatches to the compiled
	// CommandManager's handlers — command-mode automation actions (the contributed VS Code menus'
	// commands, e.g. filterByFile, view, amendLastCommit) run the same code the editor's menus
	// run, and the host bridge's openView keeps switching repositories as before.
	const commandManager = new CommandManager(context, avatarManager, dataSource, extensionState, repoManager, { path: 'git', version: '2.50.0' }, gitExecutableEmitter.subscribe, configurationEmitter.subscribe, logger);

	GitGraphView.createOrShow(rootDir, dataSource, extensionState, avatarManager, repoManager, new Logger(), null);
	assert.ok(graphPanel.webview.html.length > 0, 'the webview html was generated');

	// The extension (and its AskpassManager HTTP servers) is live from here on: anything that
	// fails below must still tear it down, or the open servers keep the test process alive and
	// `node --test` never exits (CI then hangs on an already-failed test file).
	const dispose = () => {
		commandHandlers = {};
		commandManager.dispose();
		if (GitGraphView.currentPanel !== undefined) GitGraphView.currentPanel.dispose();
		// Release the engine's repository handles (the inverse of what suite 29 asserts must stay
		// open across requests): the harness owns this RepoManager, nobody else will close it —
		// EVERY known repository, not just the boot one, because a runAutomationSuite({ repo })
		// call registers and engine-opens further repositories whose memory-mapped pack files
		// would otherwise hold the after-hook's cleanup hostage on Windows (EPERM past the whole
		// bounded-removal budget).
		for (const known of Object.keys(repoManager.getRepos())) repoManager.removeRepo(known);
		for (const server of createdServers.splice(0)) server.close();
	};

	/* Boot the html in jsdom: the inline initialState script runs during parsing (acquireVsCodeApi
	 * is injected beforehand via beforeParse); the external out.min.js is then evaluated manually,
	 * exactly like the standalone harness does. */
	let window, document;
	let scrollTopValue = 0;
	try {
		const dom = new JSDOM(graphPanel.webview.html, {
			runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.invalid/',
			beforeParse: (w) => {
				w.acquireVsCodeApi = () => w.__api;
			}
		});
		window = dom.window;
		document = window.document;
		window.__api = {
			getState: () => null,
			setState: () => {},
			postMessage: (message) => { graphPanel.webview.__onDidReceive(message); }
		};
		// Host → page: the harness delivers extension messages by dispatching a window
		// MessageEvent (as a real webview does).
		extensionToWebview = (message) => {
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
		const viewElem = document.getElementById('view');
		const spacerHeight = (selector) => {
			const td = document.querySelector(selector + ' td');
			return td !== null ? parseFloat(td.style.height) || 0 : 0;
		};
		Object.defineProperty(viewElem, 'scrollTop', { get: () => scrollTopValue, set: (v) => { scrollTopValue = Math.max(0, v); } });
		Object.defineProperty(viewElem, 'scrollHeight', {
			get: () => document.querySelectorAll('#commitTable tr.commit').length * ROW_HEIGHT
				+ spacerHeight('#virtSpacerTop') + spacerHeight('#virtSpacerBottom')
		});
		Object.defineProperty(viewElem, 'clientHeight', { get: () => VIEWPORT_HEIGHT });
		Object.defineProperty(viewElem, 'clientWidth', { get: () => 1200 });
		window.Element.prototype.scroll = function () {};
		window.Element.prototype.scrollTo = function () {};

		window.eval(fs.readFileSync(path.join(rootDir, 'media', 'out.min.js'), 'utf8'));
		window.dispatchEvent(new window.Event('load'));
	} catch (error) {
		extensionToWebview = null;
		dispose();
		if (window !== undefined) window.close(); // drop the jsdom timers
		throw error;
	}

	const viewElem = document.getElementById('view');
	const scrollTo = async (row) => {
		scrollTopValue = row * ROW_HEIGHT;
		viewElem.dispatchEvent(new window.Event('scroll'));
		await sleep(120); // let the rAF-debounced window update run
	};
	const rows = () => Array.from(document.querySelectorAll('#commitTable tr.commit'));
	return { window, document, viewElem, scrollTo, rows, GitGraphView, dispose, sleep, automation: { AutomationServer, HostBridge, suiteRunner, reportView } };
}


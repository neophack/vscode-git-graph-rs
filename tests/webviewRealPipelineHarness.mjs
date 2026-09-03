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

let onDidReceiveMessageHandler = null; // set by the panel stub: the extension's message handler
let extensionToWebview = null; // set once the jsdom window exists: delivers panel.postMessage into the DOM
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

function makePanel() {
	return {
		title: '', iconPath: null, visible: true, active: true,
		webview: {
			html: '', cspSource: 'https://stub.invalid',
			asWebviewUri: (uri) => 'media/' + path.basename(uri.fsPath || uri.path || String(uri)),
			postMessage: (msg) => { if (onExtensionMessage !== null) onExtensionMessage(msg); if (extensionToWebview !== null) extensionToWebview(msg); return Promise.resolve(true); },
			onDidReceiveMessage: (handler) => { onDidReceiveMessageHandler = handler; return disposable(); }
		},
		onDidDispose: () => disposable(),
		onDidChangeViewState: () => disposable(),
		reveal: () => {}, dispose: () => {}
	};
}

/* ---------- boot the real extension + the real webview, wired together ---------- */

export async function bootRealView(repo) {
	const panel = makePanel();
	const vscodeStub = {
		Uri: {
			file: (p) => ({ scheme: 'file', fsPath: path.normalize(p), path: String(p).replace(/\\/g, '/'), with: () => vscodeStub.Uri.file(p) }),
			joinPath: (uri, ...segments) => vscodeStub.Uri.file(path.join(uri.fsPath, ...segments))
		},
		workspace: {
			workspaceFolders: [{ uri: null, name: path.basename(repo), index: 0 }],
			getConfiguration: () => new FakeConfiguration(),
			onDidChangeConfiguration: () => disposable(),
			onDidChangeWorkspaceFolders: () => disposable(),
			createFileSystemWatcher: () => ({ onDidChange: () => disposable(), onDidCreate: () => disposable(), onDidDelete: () => disposable(), dispose: () => {} }),
			fs: { stat: async () => { throw new Error('not available'); }, readFile: async () => { throw new Error('not available'); } }
		},
		window: {
			createWebviewPanel: () => panel,
			createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
			showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
			createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
			withProgress: (_options, task) => task({ report: () => {} }),
			activeTextEditor: undefined
		},
		commands: { registerCommand: () => disposable(), registerTextEditorCommand: () => disposable() },
		RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		env: { appName: 'VS Code', clipboard: { writeText: async () => {} }, openExternal: async () => false, language: 'en' },
		ViewColumn: { Active: -1, Beside: -2, One: 1 },
		ConfigurationTarget: { Global: 1, Workspace: 2 }
	};
	vscodeStub.workspace.workspaceFolders[0].uri = vscodeStub.Uri.file(repo);

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
	vscodeStubActive = false;

	const logger = new Logger();
	const gitExecutableEmitter = new EventEmitter();
	const configurationEmitter = new EventEmitter();
	const context = {
		subscriptions: [], extensionPath: rootDir, extensionUri: vscodeStub.Uri.file(rootDir),
		globalState: { get: (_k, d) => d, set: async () => {}, update: async () => {}, keys: () => [] },
		workspaceState: { get: (_k, d) => d, set: async () => {}, update: async () => {}, keys: () => [] },
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

	GitGraphView.createOrShow(rootDir, dataSource, extensionState, avatarManager, repoManager, new Logger(), null);
	assert.ok(panel.webview.html.length > 0, 'the webview html was generated');

	// The extension (and its AskpassManager HTTP servers) is live from here on: anything that
	// fails below must still tear it down, or the open servers keep the test process alive and
	// `node --test` never exits (CI then hangs on an already-failed test file).
	const dispose = () => {
		if (GitGraphView.currentPanel !== undefined) GitGraphView.currentPanel.dispose();
		// Release the engine's repository handle (the inverse of what suite 29 asserts must stay
		// open across requests): the harness owns this RepoManager, nobody else will close it.
		repoManager.removeRepo(repo);
		for (const server of createdServers.splice(0)) server.close();
	};

	/* Boot the html in jsdom: the inline initialState script runs during parsing (acquireVsCodeApi
	 * is injected beforehand via beforeParse); the external out.min.js is then evaluated manually,
	 * exactly like the standalone harness does. */
	let window, document;
	let scrollTopValue = 0;
	try {
		const dom = new JSDOM(panel.webview.html, {
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
			postMessage: (message) => { onDidReceiveMessageHandler(message); }
		};
		extensionToWebview = (message) => {
			setTimeout(() => {
				window.dispatchEvent(new window.MessageEvent('message', { data: message }));
				if (afterDeliver !== null) afterDeliver(message);
			}, 5);
		};

		// jsdom has no layout engine: emulate the scroll container (same model as the standalone harness)
		const viewElem = document.getElementById('view');
		Object.defineProperty(viewElem, 'scrollTop', { get: () => scrollTopValue, set: (v) => { scrollTopValue = Math.max(0, v); } });
		Object.defineProperty(viewElem, 'scrollHeight', { get: () => document.querySelectorAll('#commitTable tr.commit').length * ROW_HEIGHT });
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
	return { window, document, viewElem, scrollTo, rows, GitGraphView, dispose, sleep };
}


/**
 * Load the built extension host the way VS Code does - require dist/extension.js against a
 * stubbed `vscode` and run activate() - to surface load/activation errors with a stack trace.
 *
 *   node scripts/dev/loadHost.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Module } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function disposable() { return { dispose() {} }; }

const stubUri = (p) => ({ scheme: 'file', fsPath: path.normalize(p), path: String(p).replace(/\\/g, '/'), with: () => stubUri(p) });

const vscodeStub = {
	Uri: {
		file: (p) => stubUri(p),
		joinPath: (uri, ...segments) => stubUri(path.join(uri.fsPath, ...segments))
	},
	workspace: {
		workspaceFolders: [{ uri: stubUri(root), name: path.basename(root), index: 0 }],
		getConfiguration: () => ({ get: (_s, d) => d, has: () => false, inspect: () => undefined, update: async () => {} }),
		onDidChangeConfiguration: () => disposable(),
		onDidChangeWorkspaceFolders: () => disposable(),
		createFileSystemWatcher: () => {
			const watcher = {};
			for (const kind of ['DidChange', 'DidCreate', 'DidDelete']) watcher['on' + kind] = () => disposable();
			watcher.dispose = () => {};
			return watcher;
		},
		openTextDocument: async () => ({ uri: vscodeStub.Uri.file('stub'), lineCount: 0 }),
		fs: { stat: async () => { throw new Error('not available'); }, readFile: async () => { throw new Error('not available'); } },
		asRelativePath: (p) => String(p),
		getWorkspaceFolder: () => null,
		name: path.basename(root)
	},
	window: {
		createWebviewPanel: () => ({ title: '', webview: { html: '', postMessage: async () => true, onDidReceiveMessage: () => disposable(), asWebviewUri: (u) => String(u) }, onDidDispose: () => disposable(), onDidChangeViewState: () => disposable(), reveal() {}, dispose() {} }),
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showErrorMessage: async (...a) => { console.log('[showErrorMessage]', ...a); return undefined; },
		showInformationMessage: async (...a) => { console.log('[showInformationMessage]', ...a); return undefined; },
		showWarningMessage: async () => undefined,
		createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
		createTerminal: () => ({ show() {}, dispose() {}, sendText() {} }),
		showTextDocument: async () => undefined,
		showSaveDialog: async () => undefined,
		withProgress: (_o, task) => task({ report() {} }),
		activeTextEditor: undefined
	},
	commands: {
		registerCommand: () => disposable(),
		registerTextEditorCommand: () => disposable(),
		executeCommand: async () => undefined
	},
	RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
	env: { appName: 'VS Code', clipboard: { writeText: async () => {} }, openExternal: async () => false, language: 'en' },
	version: '1.100.0',
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ConfigurationTarget: { Global: 1, Workspace: 2 },
	EventEmitter
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, [request, ...rest]);
};

const makeMemento = () => {
	const values = new Map();
	return { get: (k, f) => (values.has(k) ? values.get(k) : f), set: async (k, v) => { values.set(k, v); }, update: async (k, v) => { values.set(k, v); }, keys: () => [...values.keys()] };
};

try {
	const extension = await import(pathToFileURL(path.join(root, 'dist', 'extension.js')).href);
	console.log('loaded dist/extension.js; exports:', Object.keys(extension));
	if (typeof extension.activate !== 'function') throw new Error('activate is not exported');
	const context = {
		subscriptions: [],
		extensionPath: root,
		extensionUri: vscodeStub.Uri.file(root),
		globalState: makeMemento(),
		workspaceState: makeMemento(),
		globalStoragePath: path.join(root, 'target', 'load-host-global'),
		storagePath: path.join(root, 'target', 'load-host-storage'),
		asAbsolutePath: (p) => path.join(root, p)
	};
	await extension.activate(context);
	console.log('activate() completed');
	if (typeof extension.deactivate === 'function') await extension.deactivate();
	console.log('LOAD CHECK PASSED');
} catch (error) {
	console.error('\nLOAD CHECK FAILED:');
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
} finally {
	process.exit(0);
}

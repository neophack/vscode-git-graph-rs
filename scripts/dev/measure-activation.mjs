/**
 * Measures the host bundle's activation cost on this machine: module evaluation (require)
 * and the synchronous phase of activate() up to its first await. This is the P3 evidence
 * probe (OPTIMIZATION-PLAN §7): the entry bundle is only split into lazily required
 * entries when module evaluation is measured over the 20 ms budget (§3.8.1), so the
 * number this script prints is the decision input — not a gate.
 *
 * The probe loads `dist/extension.js` under plain Node with a `vscode` stub injected
 * through Module._load, so no extension host is needed. The stub returns recording
 * no-ops for every surface the bundle touches; the .node engine addon loads for real if
 * the bundle reaches it. Durations are CPU-bound JS time, comparable across runs on the
 * same machine but not a substitute for the in-host event-loop probe planned for P4.
 *
 * Usage: node scripts/dev/measure-activation.mjs [--samples N] [--activate]
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = path.join(repoRoot, 'dist', 'extension.js');
if (!fs.existsSync(bundle)) {
	console.error('dist/extension.js not found — run `npm run build:dist -- --production` first.');
	process.exit(1);
}

const args = process.argv.slice(2);
const samples = Math.max(1, Number(args[args.indexOf('--samples') + 1]) || 21);
const alsoActivate = args.includes('--activate');
// The stubbed context's storage directories: under the OS temp dir, removed before exit.
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-act-probe-'));

	/** Records calls and returns permissive no-ops for every vscode surface the bundle uses. */
	function makeVscodeStub() {
		const disposables = [];
		const disposable = () => {
			const d = { dispose() { disposables.splice(disposables.indexOf(d), 1); } };
			disposables.push(d);
			return d;
		};
		class Disposable {
			constructor(callOnDispose) { if (callOnDispose) disposables.push(callOnDispose); }
			dispose() {}
			static from(...items) { return new Disposable(() => items.forEach((i) => i.dispose && i.dispose())); }
		}
	const event = () => disposable();
	const stub = {
		// The surfaces activate() touches synchronously; everything else is permissive.
		version: '1.143.0',
		extensions: { getExtension: () => undefined, all: [] },
		env: { appName: 'probe', uriScheme: 'vscode', language: 'en', machineId: 'probe' },
		workspace: {
			workspaceFolders: [],
			name: 'probe',
			onDidChangeWorkspaceFolders: event,
			onDidChangeConfiguration: event,
			onDidSaveTextDocument: event,
			onDidOpenTextDocument: event,
			onDidCloseTextDocument: event,
			createFileSystemWatcher: () => ({ onDidCreate: event, onDidChange: event, onDidDelete: event, dispose() {} }),
			getConfiguration: () => new Proxy({}, {
				get: (t, k) => (k === 'get' ? (_key, fallback) => fallback : k === 'inspect' ? () => undefined : k === 'update' ? async () => {} : k === 'has' ? () => false : undefined),
			}),
			findFiles: async () => [],
			fs: { readFile: async () => new Uint8Array(), writeFile: async () => {}, stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }) },
		},
		window: {
			createStatusBarItem: () => ({ text: '', tooltip: undefined, command: undefined, show() {}, hide() {}, dispose() {} }),
			createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, hide() {}, dispose() {} }),
			createWebviewPanel: () => { throw new Error('probe: no panel'); },
			activeTextEditor: undefined,
			showInformationMessage: async () => undefined,
			showWarningMessage: async () => undefined,
			showErrorMessage: async () => undefined,
			showQuickPick: async () => undefined,
			showInputBox: async () => undefined,
			withProgress: async (_o, task) => task({ report() {} }),
			registerWebviewViewProvider: () => disposable(),
			onDidChangeActiveTextEditor: event,
			onDidChangeVisibleTextEditors: event,
			createTextEditorDecorationType: () => { throw new Error('probe: no editor'); },
		},
		commands: { registerCommand: () => disposable(), registerTextEditorCommand: () => disposable(), executeCommand: async () => undefined },
		languages: { registerCodeLensProvider: () => disposable(), createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }) },
		tasks: { registerTaskProvider: () => disposable(), taskExecutions: [] },
		Uri: { file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }), parse: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }), joinPath: (_b, p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }) },
		RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		ViewColumn: { Active: 1, Beside: 2 },
		ThemeIcon: class { constructor(id) { this.id = id; } },
		ThemeColor: class { constructor(id) { this.id = id; } },
		MarkdownString: class { constructor(v) { this.value = v; } },
		WorkspaceEdit: class { constructor() {} },
		Range: class {}, Position: class {}, Selection: class {}, Location: class {},
		Disposable,
		EventEmitter: class { constructor() { this.event = event; } fire() {} dispose() {} },
		CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: event }; } cancel() {} dispose() {} },
		ExtensionMode: { Production: 1, Development: 2, Test: 3 },
		ExtensionKind: { UI: 1, Workspace: 2 },
		FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
		ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
		 DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	};
	return { stub, disposables };
}

/** Median of an array of numbers (average of the two middle values for even lengths). */
function median(a) {
	const s = [...a].sort((x, y) => x - y);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const requireTimes = [];
const activateSyncTimes = [];

for (let i = 0; i < samples; i++) {
	const { stub } = makeVscodeStub();
	const Module = await import('node:module');
	const origLoad = Module.default._load;
	Module.default._load = function (request, parent, isMain) {
		if (request === 'vscode') return stub;
		return origLoad.call(this, request, parent, isMain);
	};
	try {
		// Fresh module registry per sample: require through a new require chain so the
		// bundle's top-level code re-runs every time.
		const req = createRequire(path.join(repoRoot, 'noop.js'));
		const cacheStub = new Map();
		const origGet = Module.default._cache;
		Object.defineProperty(Module.default, '_cache', { configurable: true, get: () => {
			const real = origGet;
			return new Proxy(real, {
				get: (t, k) => (cacheStub.has(k) ? cacheStub.get(k) : t[k]),
				set: (t, k, v) => (cacheStub.set(k, v), true),
				deleteProperty: (t, k) => (cacheStub.delete(k), t && delete t[k], true),
			});
		} });
		const t0 = performance.now();
		const ext = req(bundle);
		requireTimes.push(performance.now() - t0);
		Object.defineProperty(Module.default, '_cache', { value: origGet, configurable: true, writable: true });

		if (alsoActivate && i === samples - 1) {
			const ctx = {
				extensionPath: repoRoot,
				extensionUri: { fsPath: repoRoot, path: repoRoot, scheme: 'file' },
				extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) },
				globalState: { get: () => undefined, update: async () => {} },
				workspaceState: { get: () => undefined, update: async () => {} },
				secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
				subscriptions: [],
				storagePath: fs.mkdtempSync(path.join(probeRoot, 'storage-')),
				globalStoragePath: fs.mkdtempSync(path.join(probeRoot, 'global-')),
				logUri: { fsPath: repoRoot },
				extensionMode: 1,
			};
			const s0 = performance.now();
			const r = ext.activate(ctx);
			activateSyncTimes.push(performance.now() - s0);
			if (r && typeof r.then === 'function') {
				r.then(() => {}, (e) => console.error('activate rejected (probe stub limits):', String(e).slice(0, 200)));
			}
		}
	} finally {
		Module.default._load = origLoad;
	}
}

const kib = (n) => Math.round(n / 1024);
console.log('Host activation cost — ' + samples + ' samples, dist/extension.js ' + kib(fs.statSync(bundle).size) + ' KB');
console.log('  module evaluation (require): median ' + median(requireTimes).toFixed(2) + ' ms  (min ' + Math.min(...requireTimes).toFixed(2) + ', max ' + Math.max(...requireTimes).toFixed(2) + ')');
if (activateSyncTimes.length > 0) {
	console.log('  activate() sync phase:       median ' + median(activateSyncTimes).toFixed(2) + ' ms  (min ' + Math.min(...activateSyncTimes).toFixed(2) + ', max ' + Math.max(...activateSyncTimes).toFixed(2) + ')');
}
console.log('  P3 budget: module evaluation \u2264 20 ms \u2014 ' + (median(requireTimes) <= 20 ? 'WITHIN, no entry split on this evidence' : 'OVER \u2014 the entry split is triggered'));
// activate() arms real timers (prewarm, watchers); the measurements are already taken.
fs.rmSync(probeRoot, { recursive: true, force: true });
process.exit(0);

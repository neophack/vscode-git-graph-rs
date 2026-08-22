/**
 * Reproduce the "stuck at Loading ..." view without VS Code: wire the REAL compiled extension
 * (DataSource + RepoManager + GitGraphView) against a stubbed `vscode` API and a real repository,
 * then play the same messages the webview sends on start-up and wait for each response.
 *
 *   node scripts/repro-view.mjs [repo-path]
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import Module from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || 'D:/DK033-A';

/* ---------- A minimal `vscode` API stub, enough for the extension's start-up path ---------- */

function disposable() { return { dispose: () => {} }; }

class FakeConfiguration {
	get(_key, defaultValue) { return defaultValue; }
	update() {}
}

let onDidReceiveMessageHandler = null;
const sentMessages = [];
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

const panel = {
	title: '', iconPath: null, visible: true, active: true,
	webview: {
		html: '',
		cspSource: 'https://stub.invalid',
		asWebviewUri: (uri) => 'media/' + path.basename(uri.fsPath || uri.path || String(uri)),
		postMessage: (msg) => {
			sentMessages.push(msg);
			console.log(`[${stamp()}] extension -> webview: ${msg.command}` + (msg.command === 'loadRepos' ? ` (${Object.keys(msg.repos || {}).length} repos)` : ''));
			return Promise.resolve(true);
		},
		onDidReceiveMessage: (handler) => {
			onDidReceiveMessageHandler = handler;
			return disposable();
		}
	},
	onDidDispose: () => disposable(),
	onDidChangeViewState: () => disposable(),
	reveal: () => {}, dispose: () => {}
};

const stateBag = () => ({ get: (_k, d) => d, set: async () => {}, update: async () => {}, keys: () => [] });

const vscodeStub = {
	Uri: {
		file: (p) => ({ scheme: 'file', fsPath: path.normalize(p), path: p.replace(/\\/g, '/'), toString: () => pathToFileURL(p).toString(), with: () => this }),
		joinPath: (uri, ...segments) => vscodeStub.Uri.file(path.join(uri.fsPath, ...segments))
	},
	workspace: {
		workspaceFolders: [{ uri: null, name: path.basename(repo), index: 0 }],
		getConfiguration: () => new FakeConfiguration(),
		onDidChangeConfiguration: () => disposable(),
		onDidChangeWorkspaceFolders: () => disposable(),
		createFileSystemWatcher: () => ({ onDidChange: () => disposable(), onDidCreate: () => disposable(), onDidDelete: () => disposable(), dispose: () => {} })
	},
	window: {
		createWebviewPanel: () => panel,
		createOutputChannel: () => ({
			appendLine: (line) => console.log(`[${stamp()}] [channel] ${line}`),
			show: () => {}, dispose: () => {}
		}),
		showErrorMessage: (...args) => { console.log(`[${stamp()}] showErrorMessage: ${args[0]}`); return Promise.resolve(undefined); },
		showInformationMessage: (...args) => { console.log(`[${stamp()}] showInformationMessage: ${args[0]}`); return Promise.resolve(undefined); },
		showWarningMessage: (...args) => console.log(`[${stamp()}] showWarningMessage: ${args[0]}`),
		createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
		withProgress: (_options, task) => task({ report: () => {} })
	},
	commands: { registerCommand: () => disposable(), registerTextEditorCommand: () => disposable() },
	RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
	env: { appName: 'VS Code', clipboard: { writeText: async () => {} }, openExternal: async () => false },
	ViewColumn: { Active: -1, Beside: -2, One: 1 },
	ConfigurationTarget: { Global: 1, Workspace: 2 }
};
// The workspace folder URI needs the (already defined) Uri.file; resolve the placeholder.
vscodeStub.workspace.workspaceFolders[0].uri = vscodeStub.Uri.file(repo);

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, [request, ...rest]);
};

/* ---------- Wire the real modules, the way extension.ts does ---------- */

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { EventEmitter } = require(path.join(root, 'out', 'utils', 'event.js'));
const { Logger } = require(path.join(root, 'out', 'logger.js'));
const { ExtensionState } = require(path.join(root, 'out', 'extensionState.js'));
const { DataSource } = require(path.join(root, 'out', 'dataSource.js'));
const { AvatarManager } = require(path.join(root, 'out', 'avatarManager.js'));
const { RepoManager } = require(path.join(root, 'out', 'repoManager.js'));
const { GitGraphView } = require(path.join(root, 'out', 'gitGraphView.js'));

const logger = new Logger();
const gitExecutableEmitter = new EventEmitter();
const configurationEmitter = new EventEmitter();

const context = {
	subscriptions: [],
	extensionPath: root,
	extensionUri: vscodeStub.Uri.file(root),
	globalState: stateBag(),
	workspaceState: stateBag(),
	globalStoragePath: path.join(root, 'target', 'harness-global-storage'),
	storagePath: path.join(root, 'target', 'harness-storage'),
	asAbsolutePath: (p) => path.join(root, p)
};

const extensionState = new ExtensionState(context, gitExecutableEmitter.subscribe);
const dataSource = new DataSource({ path: 'git', version: '2.50.0' }, configurationEmitter.subscribe, gitExecutableEmitter.subscribe, logger);
const avatarManager = new AvatarManager(dataSource, extensionState, logger);
const repoManager = new RepoManager(dataSource, extensionState, configurationEmitter.subscribe, logger);

console.log(`repo: ${repo}`);
// Wait for the initial workspace scan, the way a real editor does before the view is opened:
// the view must be created with the repositories already known, so the app HTML is generated.
for (let i = 0; i < 100 && Object.keys(repoManager.getRepos()).length === 0; i++) await sleep(100);
console.log(`[${stamp()}] creating the Git Graph View (${Object.keys(repoManager.getRepos()).length} repos known) ...`);
GitGraphView.createOrShow(root, dataSource, extensionState, avatarManager, repoManager, logger, null);
console.log(`[${stamp()}] view created; html length: ${panel.webview.html.length}`);

await sleep(1500);
const repos = repoManager.getRepos();
const repoKeys = Object.keys(repos);
console.log(`[${stamp()}] repos known to the manager: ${repoKeys.join(', ') || '(none)'}`);

function send(msg) {
	console.log(`[${stamp()}] webview -> extension: ${msg.command}`);
	return onDidReceiveMessageHandler(msg);
}

async function awaitResponse(command, ms) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (sentMessages.some((m) => m.command === command)) return true;
		await sleep(100);
	}
	return false;
}

await send({ command: 'loadRepos', check: true });
if (await awaitResponse('loadRepos', 10000)) {
	console.log(`[${stamp()}] loadRepos answered`);
} else {
	console.log(`[${stamp()}] !! loadRepos NEVER ANSWERED`);
}

const targetRepo = repoKeys[0] || repo;
await send({ command: 'loadRepoInfo', repo: targetRepo, refreshId: 1, showRemoteBranches: true, showStashes: true, hideRemotes: [] });
if (await awaitResponse('loadRepoInfo', 20000)) {
	console.log(`[${stamp()}] loadRepoInfo answered`);
} else {
	console.log(`[${stamp()}] !! loadRepoInfo NEVER ANSWERED`);
}

await send({
	command: 'loadCommits', repo: targetRepo, refreshId: 2, branches: null, authors: null, maxCommits: 300,
	showTags: true, showRemoteBranches: true, includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false,
	commitOrdering: 'date', remotes: [], hideRemotes: []
});
if (await awaitResponse('loadCommits', 30000)) {
	console.log(`[${stamp()}] loadCommits answered`);
} else {
	console.log(`[${stamp()}] !! loadCommits NEVER ANSWERED`);
}

console.log(`[${stamp()}] all messages sent by the extension: ${sentMessages.map((m) => m.command).join(', ')}`);

/* ---------- Dump the real webview HTML + response transcript for a browser reproduction ---------- */

if (process.argv.includes('--dump')) {
	const fs = await import('node:fs');
	const dumpDir = path.join(root, 'target', 'webview-dump');
	fs.mkdirSync(path.join(dumpDir, 'media'), { recursive: true });
	fs.copyFileSync(path.join(root, 'media', 'out.min.js'), path.join(dumpDir, 'media', 'out.min.js'));
	fs.copyFileSync(path.join(root, 'media', 'out.min.css'), path.join(dumpDir, 'media', 'out.min.css'));

	const transcript = {};
	for (const m of sentMessages) transcript[m.command] = m; // last response per command wins

	const html = panel.webview.html;
	const patched = html
		.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '')
		.replace(
			/<script nonce="[^"]*" src="media\/out\.min\.js[^"]*"><\/script>/,
			`<script>window.__transcript = ${JSON.stringify(JSON.stringify(transcript))};</script>\n` +
				'<script>var __sent = [];\n' +
				'function acquireVsCodeApi() { return {' +
				'  postMessage: function (m) { __sent.push(m); console.log("[webview -> ext] " + m.command + " " + JSON.stringify(m).slice(0, 200)); var r = JSON.parse(window.__transcript)[m.command]; if (r) { setTimeout(function () { window.postMessage(r, "*"); }, 40); } else { console.warn("NO TRANSCRIPT RESPONSE FOR " + m.command); } },' +
				'  getState: function () { return null; },' +
				'  setState: function (s) { return s; }' +
				'}; }</script>\n' +
				'<script src="media/out.min.js"></script>'
		);
	if (patched === html || !patched.includes('acquireVsCodeApi')) {
		console.error('!! failed to patch the webview html for the browser harness');
	} else {
		fs.writeFileSync(path.join(dumpDir, 'index.html'), patched);
		console.log(`dumped target/webview-dump/index.html (html ${html.length} chars) + transcript keys: ${Object.keys(transcript).join(', ')}`);
	}
}
console.log('harness finished');
process.exit(0);

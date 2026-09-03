/* Generate a standalone real-browser reproduction page for the mid-history vertical jump:
 * the REAL compiled webview bundle (media/out.min.{js,css}) in a REAL layout engine, with a
 * stub extension host answering loadRepoInfo / loadCommits from an in-page state. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Module } from 'node:module';

const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2 },
	window: { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
	workspace: { getConfiguration: () => ({ get: (_s, d) => d, has: () => false, inspect: () => undefined, update: () => Promise.resolve() }) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { pathToFileURL } = await import('node:url');
const { getConfig } = await import(pathToFileURL(rootDir + '/out/config.js'));
const { DEFAULT_REPO_STATE } = await import(pathToFileURL(rootDir + '/out/extensionState.js'));

const ROW_HEIGHT = 24;
const REPO = 'C:\repo';
const configInstance = getConfig();
const settings = {};
for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(configInstance))) {
	if (key === 'constructor') continue;
	const value = configInstance[key];
	if (typeof value !== 'function') settings[key] = JSON.parse(JSON.stringify(value));
}
const config = { ...settings, commitOrdering: settings.commitOrder, mute: settings.muteCommits };
config.graph.rowHeight = ROW_HEIGHT;
config.fetchAvatars = false;
config.pullRequests.enabled = false;
config.showCommitBodyInline = false;
config.showBodyInline = false;

const TOTAL = 300;
const commit = (i) => ({
	hash: 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	parents: i + 1 < TOTAL ? ['c' + String(i + 1).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] : [],
	author: 'Author ' + i, email: 'author' + i + '@example.com',
	date: 1700000000 + (TOTAL - i) * 60, message: 'commit ' + i,
	heads: i === 0 ? ['main'] : [], tags: [], remotes: [], stash: null
});
const history = [];
for (let i = 0; i < TOTAL; i++) history.push(commit(i));

const hostScript = `
window.__state = { history: ${JSON.stringify(history)}, head: ${JSON.stringify(history[0].hash)}, uncommitted: null, uncommittedCount: null };
const state = window.__state;
const sent = [];
window.VSCODE_API = { getState: () => null, setState: () => {}, postMessage: (m) => { sent.push(m); } };
window.acquireVsCodeApi = () => window.VSCODE_API;
window.initialState = { config: ${JSON.stringify(config)}, lastActiveRepo: ${JSON.stringify(REPO)}, loadViewTo: null,
	repos: { ${JSON.stringify(REPO)}: ${JSON.stringify(DEFAULT_REPO_STATE)} }, loadRepoInfoRefreshId: 0, loadCommitsRefreshId: 0,
	backend: { platform: 'test', engineAvailable: true, engineVersion: 'test', gitCliAvailable: true, capabilities: [] } };
window.globalState = {}; window.workspaceState = {};
const dispatch = (message) => window.dispatchEvent(new MessageEvent('message', { data: message }));
window.__dispatch = dispatch;
window.__respond = async function () {
	for (let round = 0; round < 20; round++) {
		const queue = sent.splice(0);
		for (const message of queue) {
			if (message.command === 'loadRepoInfo') {
				dispatch({ command: 'loadRepoInfo', refreshId: message.refreshId, branches: ['main'], head: state.head, remotes: [], stashes: [], isRepo: true, error: null });
			} else if (message.command === 'loadCommits') {
				const commits = state.uncommitted === null ? state.history.slice() : [state.uncommitted, ...state.history.slice()];
				dispatch({ command: 'loadCommits', refreshId: message.refreshId, commits, head: state.head, tags: [],
					moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, uncommittedPending: false, error: null, uncommittedCount: state.uncommittedCount });
			}
		}
		await new Promise((r) => setTimeout(r, 30));
		if (sent.length === 0 && document.querySelectorAll('#commitTable tr.commit').length > 0) return;
	}
};
window.addEventListener('load', async () => { await window.__respond(); });
const rowText = (tr) => { const d = tr.querySelector('.description .text'); return d ? d.textContent : null; };
const measure = () => {
	const out = { scrollTop: Math.round(document.getElementById('view').scrollTop) };
	for (const tr of document.querySelectorAll('#commitTable tr.commit')) {
		const t = rowText(tr);
		if (t === 'commit 150' || t === 'commit 160') out[t] = Math.round(tr.getBoundingClientRect().top);
	}
	return out;
};
window.__measure = measure;
document.getElementById('btnJump').addEventListener('click', async () => {
	const view = document.getElementById('view');
	view.scrollTop = 150 * 24 + 10;
	view.dispatchEvent(new Event('scroll'));
	await new Promise((r) => setTimeout(r, 300));
	document.getElementById('result').textContent = 'AFTER_JUMP ' + JSON.stringify(measure());
});
document.getElementById('btnRewrite').addEventListener('click', async () => {
	const before = measure();
	const rewritten = { ...state.history[150], hash: 'f0150aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
	state.history[150] = rewritten;
	state.history[149].parents = [rewritten.hash];
	window.__dispatch({ command: 'refresh' });
	await window.__respond();
	await new Promise((r) => setTimeout(r, 300));
	const after = measure();
	document.getElementById('result').textContent = 'REWRITE before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after);
});
document.getElementById('btnFetch').addEventListener('click', async () => {
	const before = measure();
	const nc = { ...state.history[0], hash: 'new00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message: 'commit NEW', heads: ['main'] };
	state.history[0].heads = [];
	state.history = [nc, ...state.history];
	state.head = nc.hash;
	window.__dispatch({ command: 'refresh' });
	await window.__respond();
	await new Promise((r) => setTimeout(r, 300));
	const after = measure();
	document.getElementById('result').textContent = 'FETCH before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after);
});
`;

const html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="/media/out.min.css">
<style>html,body{margin:0;padding:0}#view{height:100vh}</style></head><body>
<div id="view" tabindex="-1">
	<div id="headerRow">
		<div id="controls">
			<span id="repoControl"><span id="repoControlLabel" class="unselectable"></span><div id="repoDropdown" class="dropdown"></div></span>
			<span id="branchControl"><span id="branchControlLabel" class="unselectable"></span><div id="branchDropdown" class="dropdown"></div></span>
			<span id="authorControl"><span id="authorControlLabel" class="unselectable"></span><div id="authorDropdown" class="dropdown"></div></span>
		</div>
		<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span><span id="showRemoteBranchesLabel"></span></label>
		<div><div id="currentBtn"></div><div id="findBtn"></div><div id="filterBtn"></div><div id="terminalBtn"></div><div id="settingsBtn"></div><div id="fetchBtn"></div><div id="refreshBtn"></div></div>
		<div id="prStatus" style="display:none"></div>
		<div id="pinnedControls" style="display:none"></div>
	</div>
	<div id="content">
		<div id="commitGraph"></div>
		<div id="commitTable"></div>
	</div>
</div>
<div id="footer"></div>
<div id="testControls" style="position:fixed;right:0;top:0;z-index:9999;background:#fff">
	<button id="btnJump">scroll to 150</button>
	<button id="btnRewrite">rewrite mid commit + refresh</button>
	<button id="btnFetch">new commit on top (prepend)</button>
	<div id="result"></div>
</div>
<script>${hostScript}</script>
<script src="/media/out.min.js"></script>
</body></html>`;
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), html);
console.log('written tests/browserRepro/index.html');

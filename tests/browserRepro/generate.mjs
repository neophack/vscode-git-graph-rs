/* Generate a standalone real-browser test page for the git graph webview layout:
 * the REAL compiled webview bundle (media/out.min.{js,css}) in a REAL layout engine, with a
 * stub extension host answering loadRepoInfo / loadCommits from an in-page mutable state.
 *
 * The page exposes window.__run(name) which mutates the state, refreshes the view and returns
 * before/after measurements (row tops, description x positions, ref pill rects, graph column
 * width, scrollTop). tests/browserRepro/run.mjs drives it and asserts the invariants.
 *
 * Config variants are selected with ?cfg= (default | angular | aligned): the host script reads
 * location.search before out.min.js loads and adjusts the initial config accordingly, so the
 * graph column width / ref pill placement can be compared across graph settings. */
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
const h = (prefix, i) => prefix + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const commit = (i) => ({
	hash: h('c', i),
	parents: i + 1 < TOTAL ? [h('c', i + 1)] : [],
	author: 'Author ' + i, email: 'author' + i + '@example.com',
	date: 1700000000 + (TOTAL - i) * 60, message: 'commit ' + i,
	heads: i === 0 ? ['main'] : [], tags: [], remotes: [], stash: null
});
const history = [];
for (let i = 0; i < TOTAL; i++) history.push(commit(i));

const hostScript = `
window.__state = { history: ${JSON.stringify(history)}, head: ${JSON.stringify(history[0].hash)}, uncommitted: null, uncommittedCount: null, pendingCount: null, pipeline: null, pipelineCycle: 0, pipelineCounts: null };
const state = window.__state;
const sent = [];
window.VSCODE_API = { getState: () => null, setState: () => {}, postMessage: (m) => { sent.push(m); } };
window.acquireVsCodeApi = () => window.VSCODE_API;
const cfgVariant = new URLSearchParams(location.search).get('cfg') || 'default';
const cfg = ${JSON.stringify(config)};
if (cfgVariant === 'angular') cfg.graph.style = 1;
if (cfgVariant === 'aligned') cfg.referenceLabels.branchLabelsAlignedToGraph = true;
window.__cfgVariant = cfgVariant;
window.initialState = { config: cfg, lastActiveRepo: ${JSON.stringify(REPO)}, loadViewTo: null,
	repos: { ${JSON.stringify(REPO)}: ${JSON.stringify(DEFAULT_REPO_STATE)} }, loadRepoInfoRefreshId: 0, loadCommitsRefreshId: 0,
	backend: { platform: 'test', engineAvailable: true, engineVersion: 'test', gitCliAvailable: true, capabilities: [] } };
window.globalState = {}; window.workspaceState = {};
const dispatch = (message) => { const t0 = performance.now(); window.dispatchEvent(new MessageEvent('message', { data: message })); const dt = performance.now() - t0; if (dt > 500) console.log('SLOW DISPATCH ' + message.command + ' ' + Math.round(dt) + 'ms'); };
window.__dispatch = dispatch;
window.__respond = async function () {
	for (let round = 0; round < 20; round++) {
		const queue = sent.splice(0);
		for (const message of queue) {
			if (message.command === 'loadRepoInfo') {
				dispatch({ command: 'loadRepoInfo', refreshId: message.refreshId, branches: ['main'], head: state.head, remotes: [], stashes: [], isRepo: true, error: null });
			} else if (message.command === 'loadCommits') {
				/* deep-copy: a synthetic MessageEvent does NOT structured-clone its data, so the
				 * response's commit objects would alias __state and every mutation the scenarios
				 * make would be invisible to the webview's old-vs-new comparison */
				const commits = JSON.parse(JSON.stringify(state.uncommitted === null ? state.history : [state.uncommitted, ...state.history]));
				if (state.pipeline === 'real') {
					/* the REAL extension pipeline, three responses per refresh with the same refresh id:
					 * 1. commits WITHOUT the uncommitted row, uncommittedPending, no remotes
					 * 2. remote refs follow-up: commits WITH remote pills + the branches array
					 * 3. uncommitted follow-up: the row (fresh Date.now() date, like the host sends) + count */
					const count = state.pipelineCounts[state.pipelineCycle % state.pipelineCounts.length];
					const clone = () => JSON.parse(JSON.stringify(state.history));
					const base = { command: 'loadCommits', refreshId: message.refreshId, head: state.head, tags: [],
						moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, error: null };
					dispatch({ ...base, commits: clone(), uncommittedPending: true });
					if (window.__onStage) window.__onStage('stage1', count);
					const withRemotes = clone();
					const headCommit = withRemotes.find((c) => c.hash === state.head);
					if (headCommit) headCommit.remotes = [{ name: 'origin/' + (headCommit.heads[0] || 'main'), remote: 'origin' }];
					dispatch({ ...base, commits: withRemotes, uncommittedPending: true, branches: ['main', 'origin/main'] });
					if (window.__onStage) window.__onStage('stage2', count);
					const withRow = clone();
					const rowHead = withRow.find((c) => c.hash === state.head);
					if (rowHead) rowHead.remotes = [{ name: 'origin/main', remote: 'origin' }];
					if (count > 0) withRow.unshift({ hash: '*', parents: [state.head], author: '*', email: '',
						date: Math.round(Date.now() / 1000), message: 'Uncommitted Changes (' + count + ')', heads: [], tags: [], remotes: [], stash: null });
					dispatch({ ...base, commits: withRow, uncommittedCount: count, branches: ['main', 'origin/main'] });
					if (window.__onStage) window.__onStage('stage3', count);
					state.pipelineCycle++;
				} else 				if (state.pendingCount !== null) {
					/* real-pipeline deferred flow (a file was just saved): the commit list arrives
					 * first WITHOUT the uncommitted row (uncommittedPending), the count follows in
					 * a second response with the same refresh id */
					dispatch({ command: 'loadCommits', refreshId: message.refreshId, commits, head: state.head, tags: [],
						moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, uncommittedPending: true, error: null });
					dispatch({ command: 'loadCommits', refreshId: message.refreshId, commits, head: state.head, tags: [],
						moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, uncommittedPending: true, error: null, uncommittedCount: state.pendingCount });
				} else {
					dispatch({ command: 'loadCommits', refreshId: message.refreshId, commits, head: state.head, tags: [],
						moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, uncommittedPending: false, error: null, uncommittedCount: state.uncommittedCount });
				}
			} else if (message.command === 'commitDetails') {
				/* Answering this is what actually OPENS the Commit Details View, which switches the
				 * table out of windowed rendering (canVirtualize is false while it is open) - the
				 * configuration the user reported the horizontal jitter in. */
				const c = state.history.find((x) => x.hash === message.commitHash);
				dispatch({
					command: 'commitDetails', repo: ${JSON.stringify(REPO)}, error: null, avatar: null, codeReview: null,
					refresh: message.refresh,
					commitDetails: {
						hash: message.commitHash, parents: c ? c.parents : [],
						author: c ? c.author : 'Author', authorEmail: c ? c.email : '', authorDate: c ? c.date : 0,
						committer: c ? c.author : 'Author', committerEmail: c ? c.email : '', committerDate: c ? c.date : 0,
						signature: null, body: 'Body of ' + (c ? c.message : ''),
						/* For the Uncommitted Changes row the file list is exactly the working-tree
						 * change set, so it GROWS AND SHRINKS with the file count - and its rows live
						 * in a colspan cell inside the same table. */
						fileChanges: message.commitHash === '*'
							? Array.from({ length: state.uncommittedCount || 0 }, (_, i) => ({
								oldFilePath: 'src/' + 'nested/'.repeat(i % 5) + 'file' + i + '.ts',
								newFilePath: 'src/' + 'nested/'.repeat(i % 5) + 'file' + i + '.ts',
								type: 'M', additions: i, deletions: i
							}))
							: [
								{ oldFilePath: 'src/index.ts', newFilePath: 'src/index.ts', type: 'M', additions: 4, deletions: 2 },
								{ oldFilePath: 'README.md', newFilePath: 'README.md', type: 'M', additions: 1, deletions: 1 }
							]
					}
				});
			}
		}
		await new Promise((r) => setTimeout(r, 30));
		if (sent.length === 0 && document.querySelectorAll('#commitTable tr.commit').length > 0) return;
	}
};
window.addEventListener('load', async () => { await window.__respond(); });

/* ---------- measurement ---------- */
const TRACK = ['commit 145', 'commit 150', 'commit 160', 'commit 0'];
const rowText = (tr) => { const d = tr.querySelector('.description .text'); return d ? d.textContent : null; };
window.__measure = function () {
	const svg = document.querySelector('#commitGraph svg');
	const out = { scrollTop: Math.round(document.getElementById('view').scrollTop),
		graphWidth: svg !== null ? Math.round(parseFloat(svg.getAttribute('width')) || 0) : 0,
		rows: document.querySelectorAll('#commitTable tr.commit').length, tracked: {}, uncommittedRow: null };
	for (const tr of document.querySelectorAll('#commitTable tr.commit')) {
		const t = rowText(tr);
		if (tr.id === 'uncommittedChanges') {
			out.uncommittedRow = { top: Math.round(tr.getBoundingClientRect().top),
				text: tr.textContent, refs: tr.querySelectorAll('.gitRef').length };
			continue;
		}
		if (!TRACK.includes(t)) continue;
		const rec = { top: Math.round(tr.getBoundingClientRect().top) };
		const text = tr.querySelector('.description .text');
		if (text !== null) rec.textLeft = Math.round(text.getBoundingClientRect().left);
		rec.refs = [];
		for (const ref of tr.querySelectorAll('.gitRef')) {
			rec.refs.push({ name: ref.querySelector('.gitRefName') ? ref.querySelector('.gitRefName').textContent : null,
				left: Math.round(ref.getBoundingClientRect().left) });
		}
		out.tracked[t] = rec;
	}
	return out;
};
window.__refNames = function () { const names = []; for (const r of document.querySelectorAll('#commitTable tr.commit .gitRefName')) names.push(r.textContent); return names; };

/* adjacent rendered (non-spacer) commit rows must keep the uniform row pitch */
window.__rowPitch = function () {
	const tops = [];
	for (const tr of document.querySelectorAll('#commitTable tr.commit')) tops.push(Math.round(tr.getBoundingClientRect().top));
	tops.sort((a, b) => a - b);
	const pitches = [];
	for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > 0 && tops[i] - tops[i - 1] < 100) pitches.push(tops[i] - tops[i - 1]);
	return pitches;
};
window.__settle = () => new Promise((r) => setTimeout(r, 320));

/* ---------- scenario runner ---------- */
const refresh = async () => { dispatch({ command: 'refresh' }); await window.__respond(); await window.__settle(); };
const uncommitted = (count) => ({ hash: '*', parents: [state.head], author: 'Me', email: 'me@example.com',
	date: 1700000000, message: 'Uncommitted Changes (' + count + ')', heads: [], tags: [], remotes: [], stash: null });
const sideCommit = (i, parent) => ({ hash: 's' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', parents: [parent],
	author: 'Author S' + i, email: 's' + i + '@example.com', date: 1700000000 + (300 - i) * 60 + 30,
	message: 'side ' + i, heads: [], tags: [], remotes: [], stash: null });

window.__run = async function (name) {
	const before = window.__measure();
	const extra = {};
	if (name === 'openCdv') {
		/* Click the row the user is looking at to expand the Commit Details View. While it is open
		 * the table drops out of windowed rendering: EVERY loaded commit row is in the DOM, so the
		 * browser's automatic column layout is computed over all of them. */
		const row = Array.from(document.querySelectorAll('#commitTable tr.commit'))
			.find((r) => { const t = r.querySelector('.description .text'); return t !== null && t.textContent === 'commit 150'; });
		if (row !== undefined) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await window.__respond();
		await window.__settle();
		await window.__settle();
	} else if (name === 'cdvCountChange') {
		/* With the Commit Details View open, the number of uncommitted files keeps changing - the
		 * exact situation reported as "the columns keep shifting left and right". Every count is
		 * applied through a full refresh and the layout is measured after each one. */
		extra.rounds = [];
		for (const count of [3, 12, 4, 7, 3, 12]) {
			state.uncommittedCount = count;
			state.uncommitted = uncommitted(count);
			await refresh();
			extra.rounds.push({ count: count, ...window.__measure() });
		}
	} else if (name === 'jump') {
		const view = document.getElementById('view');
		view.scrollTop = 150 * 24 + 10;
		view.dispatchEvent(new Event('scroll'));
		await window.__settle();
	} else if (name === 'scrollTop') {
		const view = document.getElementById('view');
		view.scrollTop = 0;
		view.dispatchEvent(new Event('scroll'));
		await window.__settle();
	} else if (name === 'uncommittedAppear') {
		state.uncommittedCount = 3; state.uncommitted = uncommitted(3);
		await refresh();
	} else if (name === 'uncommittedCountChange') {
		state.uncommittedCount = 2; state.uncommitted = { ...state.uncommitted, message: 'Uncommitted Changes (2)' };
		await refresh();
	} else if (name === 'uncommittedClear') {
		state.uncommittedCount = null; state.uncommitted = null;
		await refresh();
	} else if (name === 'commitPrepend') {
		const nc = { ...state.history[0], hash: 'new00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message: 'commit NEW', heads: ['main'] };
		state.history[0].heads = [];
		state.history = [nc, ...state.history];
		state.head = nc.hash;
		await refresh();
	} else if (name === 'commitInsertMid') {
		const c150 = state.history.find((x) => x.message === 'commit 150');
		const c151 = state.history.find((x) => x.message === 'commit 151');
		if (c150 && c151) {
			const nc = { ...c150, hash: 'insrt' + c150.hash.substring(5), message: 'commit INSERTED', heads: [], parents: [c151.hash] };
			c150.parents = [nc.hash];
			state.history.splice(state.history.indexOf(c150) + 1, 0, nc);
		}
		await refresh();
	} else if (name === 'commitRemoveMid') {
		const c160 = state.history.find((x) => x.message === 'commit 160');
		const c161 = state.history.find((x) => x.message === 'commit 161');
		if (c160 && c161) { c160.parents = [c161.hash]; state.history.splice(state.history.indexOf(c161), 1); }
		await refresh();
	} else if (name === 'rewriteMid') {
		const c150 = state.history.find((x) => x.message === 'commit 150');
		const c149 = state.history.find((x) => x.message === 'commit 149');
		if (c150 && c149) {
			const rewritten = { ...c150, hash: 'f0150aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
			state.history[state.history.indexOf(c150)] = rewritten;
			c149.parents = [rewritten.hash];
		}
		await refresh();
	} else if (name === 'lanesWiden') {
		/* fork a side chain off commit 161's parent that merges back into 155: rows 155..160 grow
		 * a second parallel lane, so the graph column must become wider around the viewport.
		 * The side commits are spliced in newest-first (same order as the main history: every
		 * parent must appear BELOW its child, or the layout cannot resolve the branch). */
		const at = (msg) => state.history.find((x) => x.message === msg);
		const c155 = at('commit 155'), fork = at('commit 162');
		if (c155 && fork) {
			const sideHash = (i) => 's' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
			const sides = [];
			for (let i = 155; i <= 160; i++) sides.push(sideCommit(i, i === 160 ? fork.parents[0] : sideHash(i + 1)));
			c155.parents = [c155.parents[0], sideHash(155)];
			state.history.splice(state.history.indexOf(c155) + 1, 0, ...sides);
		}
		await refresh();
} else if (name === 'fileSavedDirty') {
		state.pendingCount = 3;
		await refresh();
	} else if (name === 'fileSavedCountChange') {
		state.pendingCount = 1;
		await refresh();
	} else if (name === 'watcherLoop') {
		/* every file save re-triggers the watcher: five consecutive deferred refreshes with the
		 * uncommitted count flickering between 2 and 1 (each save touches one file) */
		const rounds = [];
		for (let i = 0; i < 5; i++) {
			state.pendingCount = i % 2 === 0 ? 2 : 1;
			dispatch({ command: 'refresh' });
			await window.__respond();
			await window.__settle();
			rounds.push(window.__measure());
		}
		state.pendingCount = null;
		extra.rounds = rounds;
	} else if (name === 'branchMoved') {
		const from = state.history[0];
		const c150 = state.history.find((x) => x.message === 'commit 150');
		if (from && c150) { from.heads = from.heads.filter((b) => b !== 'main'); c150.heads = [...c150.heads, 'main']; state.head = c150.hash; }
		await refresh();
	} else if (name === 'commitInsertAbove') {
		const c149 = state.history.find((x) => x.message === 'commit 149');
		const c150 = state.history.find((x) => x.message === 'commit 150');
		if (c149 && c150) {
			const nc = { ...c150, hash: 'abov0' + c150.hash.substring(4), message: 'commit ABOVE', heads: [], parents: [c150.hash] };
			c149.parents = [nc.hash];
			state.history.splice(state.history.indexOf(c150), 0, nc);
		}
		await refresh();
	} else if (name === 'commitDropAbove') {
		const c148 = state.history.find((x) => x.message === 'commit 148');
		const c149 = state.history.find((x) => x.message === 'commit 149');
		if (c148 && c149) { c148.parents = [c149.hash]; state.history.splice(state.history.indexOf(c149), 1); }
		await refresh();
	} else if (name === 'realPipelineLoop') {
		/* the full 3-stage host pipeline, six refresh cycles with the working tree going dirty ->
		 dirty -> clean -> dirty -> clean -> dirty (each cycle = one file-save watcher event) */
		state.pipeline = 'real';
		state.pipelineCounts = [3, 3, 0, 2, 0, 3];
		const stages = [];
		window.__onStage = (stage, count) => { const m = window.__measure(); m.stage = stage; m.count = count; stages.push(m); };
		for (let i = 0; i < state.pipelineCounts.length; i++) {
			dispatch({ command: 'refresh' });
			await window.__respond();
			await window.__settle();
		}
		window.__onStage = null;
		state.pipeline = null;
		extra.stages = stages;
	} else if (name === 'skewedDates') {
		/* clock-skewed repository: commit 150's parent sits ABOVE it in the (date-ordered) list -
		 * the layout must terminate instead of freezing the view (regression: infinite loop) */
		const c150 = state.history.find((x) => x.message === 'commit 150');
		const c140 = state.history.find((x) => x.message === 'commit 140');
		if (c150 && c140) c150.parents = [c140.hash];
		await refresh();
	} else if (name.startsWith('pill')) {
		const c150 = state.history.find((x) => x.message === 'commit 150');
		const head = state.history[0];
		if (name === 'pillAddBoth' && c150) { c150.heads = [...c150.heads, 'feature-y']; c150.tags = [{ name: 'v2.0.0', annotated: false }]; c150.remotes = [{ name: 'origin/main', remote: 'origin' }]; }
		if (name === 'pillRemove' && c150) { c150.heads = []; c150.tags = []; c150.remotes = []; }
		if (name === 'pillOnHead') head.heads = [...head.heads, 'wip'];
		await refresh();
	}
	const after = window.__measure();
	/* a second read after another settle: a flickering layout would report different positions */
	await window.__settle();
	const again = window.__measure();
	return JSON.stringify({ scenario: name, before, after, again, extra });
};
window.__errors = [];

/* keep the manual buttons working for interactive debugging */
const runToResult = async (name) => { document.getElementById('result').textContent = name + ' ' + await window.__run(name); };
document.getElementById('btnJump').addEventListener('click', () => runToResult('jump'));
document.getElementById('btnRewrite').addEventListener('click', () => runToResult('rewriteMid'));
document.getElementById('btnFetch').addEventListener('click', () => runToResult('commitPrepend'));
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

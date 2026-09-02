/**
 * Seamless (flicker-free) updates of the commit table while the user is viewing a commit in the
 * middle of the history, driven through the REAL compiled webview bundle (`media/out.min.js`)
 * inside a jsdom document.
 *
 * The scenario the user sees in the editor: the graph is open, the user has scrolled down and is
 * looking at some historical commit, and the repository moves underneath them - a commit is made
 * on the checked-out branch, or files are edited so the "Uncommitted Changes" row appears / its
 * count changes / it disappears again. None of this may disturb the viewport:
 *
 *   - only the scroll bar adjusts (by exactly the height the top rows add or remove),
 *   - the visible rows stay put: same commits in the same order at the same position,
 *   - the new rows stay HIDDEN above the viewport until the user scrolls back up,
 *   - the already rendered rows are not rebuilt (DOM node identity is preserved outside the
 *     windowed-render window, which only ever holds the small viewport slice).
 *
 * These tests boot the full webview (html skeleton + initialState + acquireVsCodeApi stub),
 * answer its requests like the extension host would, and assert on the resulting DOM.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

/* The stand-in for the extension host: out/config.js and out/extensionState.js transitively
 * require 'vscode' for their defaults, which the test reuses to build a valid initialState. */
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined
	},
	workspace: {
		getConfiguration: () => ({
			get: (_section, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getConfig } = await import('../out/config.js');
const { DEFAULT_REPO_STATE } = await import('../out/extensionState.js');

const ROW_HEIGHT = 24;
const VIEWPORT_HEIGHT = 600;
const REPO = 'C:\\repo';
const UNCOMMITTED_HASH = '*';

/* The html skeleton of the webview (see getHtmlForWebview in src/gitGraphView.ts): every element
 * id the view looks up at boot, with the scripts and the vscode api stubbed in by the harness. */
const VIEW_HTML = `<!DOCTYPE html><html><head></head><body>
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
	<div id="footer"></div>
</div>
</body></html>`;

/** A linear history commit: `i` = 0 is the newest. */
function commit(i, total, heads = []) {
	const hash = 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
	return {
		hash: hash,
		parents: i + 1 < total ? ['c' + String(i + 1).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] : [],
		author: 'Author ' + i,
		email: 'author' + i + '@example.com',
		date: 1700000000 + (total - i) * 60,
		message: 'commit ' + i,
		heads: heads,
		tags: [],
		remotes: [],
		stash: null
	};
}

function uncommittedRow(headHash, count) {
	return {
		hash: UNCOMMITTED_HASH,
		parents: [headHash],
		author: '*',
		email: '',
		date: Math.round(Date.now() / 1000),
		message: 'Uncommitted Changes (' + count + ')',
		heads: [],
		tags: [],
		remotes: [],
		stash: null
	};
}

/**
 * Boot the webview with a fresh history of `total` commits (newest first, `heads` on commit 0)
 * and scroll it to the middle of the list, exactly like a user viewing a historical entry.
 */
async function bootView(total) {
	// Materialise the view config the extension passes to the webview: a Config instance exposes
	// every setting as a prototype getter over the (stubbed, all-default) workspace configuration;
	// the few fields the extension renames on the way into initialState are mapped explicitly
	// (see getHtmlForWebview in src/gitGraphView.ts)
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

	const history = [];
	for (let i = 0; i < total; i++) history.push(commit(i, total, i === 0 ? ['main'] : []));

	const state = {
		history: history,
		head: history[0].hash,
		uncommitted: null, // null => working tree clean, no Uncommitted Changes row
		uncommittedCount: null
	};

	const dom = new JSDOM(VIEW_HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.invalid/' });
	const { window } = dom;
	const document = window.document;

	const sent = [];
	window.initialState = {
		config: config,
		lastActiveRepo: REPO,
		loadViewTo: null,
		repos: { [REPO]: JSON.parse(JSON.stringify(DEFAULT_REPO_STATE)) },
		loadRepoInfoRefreshId: 0,
		loadCommitsRefreshId: 0,
		backend: { platform: 'test', engineAvailable: true, engineVersion: 'test', gitCliAvailable: true, capabilities: [] }
	};
	window.globalState = {};
	window.workspaceState = {};
	window.VSCODE_API = {
		getState: () => null,
		setState: () => {},
		postMessage: (message) => { sent.push(message); }
	};
	window.acquireVsCodeApi = () => window.VSCODE_API;

	/* jsdom has no layout engine: emulate the scroll container of the view. scrollTop is a plain
	 * stored value clamped at 0; scrollHeight grows with the rendered commit rows (uniform row
	 * height, the same model the windowed renderer uses); clientHeight is the fixed viewport. */
	const viewElem = document.getElementById('view');
	let scrollTopValue = 0;
	Object.defineProperty(viewElem, 'scrollTop', {
		get: () => scrollTopValue,
		set: (value) => { scrollTopValue = Math.max(0, value); }
	});
	Object.defineProperty(viewElem, 'scrollHeight', {
		get: () => document.querySelectorAll('#commitTable tr.commit').length * ROW_HEIGHT
	});
	Object.defineProperty(viewElem, 'clientHeight', { get: () => VIEWPORT_HEIGHT });
	Object.defineProperty(viewElem, 'clientWidth', { get: () => 1200 });

	// jsdom implements neither Element.scroll nor scrollTo (used by the view's scroll-to-commit
	// paths); scrollTop emulation above already covers what the tests assert
	window.Element.prototype.scroll = function () {};
	window.Element.prototype.scrollTo = function () {};

	window.eval(fs.readFileSync(path.join(rootDir, 'media', 'out.min.js'), 'utf8'));
	window.dispatchEvent(new window.Event('load'));

	const dispatch = (message) => {
		window.dispatchEvent(new window.MessageEvent('message', { data: message }));
	};
	const respond = (message) => {
		if (message.command === 'loadRepoInfo') {
			dispatch({ command: 'loadRepoInfo', refreshId: message.refreshId, branches: ['main'], head: state.head, remotes: [], stashes: [], isRepo: true, error: null });
		} else if (message.command === 'loadCommits') {
			const commits = state.uncommitted === null ? state.history.slice() : [uncommittedRow(state.head, state.uncommitted), ...state.history];
			dispatch({
				command: 'loadCommits', refreshId: message.refreshId, commits: commits, head: state.head, tags: [],
				moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null,
				uncommittedPending: false, uncommittedCount: state.uncommittedCount, error: null
			});
		}
		// every other request (loadConfig, fetchPullRequest, avatars, ...) is left unanswered:
		// the view tolerates a pending request, and none of them affect the commit table
	};

	/* Answer every request the view sends until it falls quiet (each response can trigger the
	 * next request, e.g. loadRepoInfo -> loadCommits). */
	const pump = async () => {
		for (let round = 0; round < 20; round++) {
			const queue = sent.splice(0);
			for (const message of queue) respond(message);
			await new Promise((resolve) => setTimeout(resolve, 30));
			if (sent.length === 0 && document.querySelectorAll('#commitTable tr.commit').length > 0) return;
		}
	};

	const scrollTo = async (row) => {
		scrollTopValue = row * ROW_HEIGHT;
		viewElem.dispatchEvent(new window.Event('scroll'));
		await new Promise((resolve) => setTimeout(resolve, 60)); // let the rAF-debounced window update run
	};

	await pump();
	const rows = () => Array.from(document.querySelectorAll('#commitTable tr.commit'));
	const headerRow = () => document.getElementById('tableColHeaders');

	return { window, document, viewElem, state, dispatch, pump, scrollTo, rows, headerRow };
}

describe('seamless updates while viewing a commit in the middle of the history', () => {
	it('boots, virtualizes a 300-commit history and settles at the scrolled position', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);
		assert.ok(h.document.querySelector('tr.virtSpacer') !== null, 'the windowed renderer is active');
		const anchor = h.rows().find((row) => row.dataset.id === '150');
		assert.ok(anchor !== undefined, 'the row the user is looking at is rendered');
		assert.match(anchor.textContent, /commit 150/);
	});

	it('keeps the viewport perfectly still when a commit lands on the checked-out branch (virtualized)', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);

		// The commit list the user is looking at, before the repository moves
		const before = h.rows().map((row) => row.dataset.id + ':' + row.textContent);
		const scrollTopBefore = h.viewElem.scrollTop;

		// A commit is made on the checked-out branch: new head, the 'main' label moves to it
		const newCommit = commit(0, 1, ['main']);
		newCommit.hash = 'n00000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		newCommit.message = 'commit NEW';
		newCommit.parents = [h.state.history[0].hash];
		h.state.history[0].heads = [];
		h.state.history.unshift(newCommit);
		h.state.head = newCommit.hash;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		// The scroll bar shifted by exactly one row height - nothing else in the viewport moved
		assert.equal(h.viewElem.scrollTop, scrollTopBefore + ROW_HEIGHT);
		// The same commits are in the rendered window, at the same visual position (id + 1)
		const after = h.rows().map((row) => (parseInt(row.dataset.id) - 1) + ':' + row.textContent);
		assert.deepEqual(after, before);
		// The new commit is HIDDEN above the viewport: it is not among the rendered rows
		assert.ok(!h.rows().some((row) => /commit NEW/.test(row.textContent)), 'the new commit is not in view');
		// Scrolling back up to the top reveals it
		await h.scrollTo(0);
		const topRow = h.rows().find((row) => row.dataset.id === '0');
		assert.ok(topRow !== undefined && /commit NEW/.test(topRow.textContent), 'the new commit appears at the top');
	});

	it('keeps every rendered DOM row node when the Uncommitted Changes row appears, updates and vanishes (full render)', async () => {
		const h = await bootView(60); // <= 100 commits: full render, every row is in the DOM
		await h.scrollTo(30);
		assert.equal(h.document.querySelector('tr.virtSpacer'), null, 'the full renderer is active');

		const nodesBefore = h.rows();
		const scrollTopBefore = h.viewElem.scrollTop;

		// Files are edited: the Uncommitted Changes row appears at the very top
		h.state.uncommitted = 3;
		h.state.uncommittedCount = 3;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		let rows = h.rows();
		assert.equal(rows.length, 61);
		assert.equal(h.viewElem.scrollTop, scrollTopBefore + ROW_HEIGHT, 'the scroll bar shifted by exactly one row');
		assert.match(rows[0].textContent, /Uncommitted Changes \(3\)/);
		// Every previously rendered row keeps its DOM node (only the new row was inserted)
		assert.deepEqual(rows.slice(1), nodesBefore);
		// The visible rows did not move: row N of the old list is still at the same offset from the
		// (shifted) scroll position - here checked as data-id + 1 for every old row
		rows.forEach((row, i) => assert.equal(row.dataset.id, String(i)));

		// More files are edited: only the number changes, patched in place
		const nodesWithRow = h.rows();
		h.state.uncommitted = 5;
		h.state.uncommittedCount = 5;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		rows = h.rows();
		assert.deepEqual(rows, nodesWithRow, 'not a single row node was rebuilt');
		assert.match(rows[0].textContent, /Uncommitted Changes \(5\)/);
		assert.equal(rows[0].dataset.id, '0');

		// Everything is committed: the row vanishes and a new commit takes its place at the top
		const scrollTopBeforeCommit = h.viewElem.scrollTop;
		const newCommit = commit(0, 1, ['main']);
		newCommit.hash = 'n00000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		newCommit.message = 'commit NEW';
		newCommit.parents = [h.state.history[0].hash];
		h.state.history[0].heads = [];
		h.state.history.unshift(newCommit);
		h.state.head = newCommit.hash;
		h.state.uncommitted = null;
		h.state.uncommittedCount = null;
		h.dispatch({ command: 'refresh' });
		await h.pump();

		rows = h.rows();
		assert.equal(rows.length, 61);
		assert.match(rows[0].textContent, /commit NEW/);
		// One row removed (Uncommitted) and one added (the commit): the scroll bar nets out
		assert.equal(h.viewElem.scrollTop, scrollTopBeforeCommit, 'the scroll bar did not move');
		// The old rows keep their nodes AND their positions (the top swap nets out to zero shift)
		assert.deepEqual(rows.slice(1), nodesBefore);
	});
});

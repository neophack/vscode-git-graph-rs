/**
 * Shared harness: boot the REAL compiled webview bundle (`media/out.min.js`) inside a jsdom
 * document, answer its requests like the extension host would, and expose the DOM, the message
 * dispatch and scroll helpers for the seamless-update / row-coordinate tests.
 *
 * jsdom has no layout engine, so the scroll container (#view) is emulated: scrollTop is a stored
 * clamped value, scrollHeight grows with the rendered commit rows (uniform row height, the same
 * model the windowed renderer uses), clientHeight is the fixed viewport. Row positions on screen
 * are therefore derived from the DOM structure itself (see rowTop / viewportTop in the tests):
 * header + top spacer + uniform-height commit rows - scrollTop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/**
 * The on-screen Y coordinate of every rendered commit row, derived from the DOM itself (the
 * windowed renderer's top spacer + uniform row heights), relative to the top of the viewport.
 * The (sticky, constant-height) table header row is excluded - a constant offset cannot cause a
 * relative jump. `h` is any object exposing document/viewElem like the harness result.
 */
export function measureRowCoordinates(h) {
	const coords = new Map();
	let y = 0;
	for (const tr of h.document.querySelectorAll('#commitTable tr')) {
		if (tr.id === 'tableColHeaders') continue;
		if (tr.classList.contains('virtSpacer')) {
			y += parseInt(tr.querySelector('td').style.height, 10) || 0;
		} else if (tr.classList.contains('commit')) {
			// Identify the row by its description cell (the message); textContent as a whole would
			// glue the message to the digits of the following date column
			const description = tr.querySelector('.description .text');
			coords.set(description !== null ? description.textContent : 'UNCOMMITTED', y - h.viewElem.scrollTop);
			y += ROW_HEIGHT;
		}
	}
	return coords;
}

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

export const ROW_HEIGHT = 24;
export const VIEWPORT_HEIGHT = 600;
export const REPO = 'C:\\repo';
export const UNCOMMITTED_HASH = '*';

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
export function commit(i, total, heads = []) {
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

export function uncommittedRow(headHash, count) {
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
 * and leave it at the top; use the returned `scrollTo(row)` to move into the history like a user
 * viewing a historical entry.
 */
export async function bootView(total, options = {}) {
	const staged = options.staged === true;
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
		uncommittedCount: null,
		/* Non-null: the repository is LONGER than the loaded window (initialLoadCommits, 300 by
		 * default) - every loadCommits response carries only the newest `window` commits and
		 * moreCommitsAvailable=true, so a new commit at the top pushes the oldest LOADED commit
		 * out of the window (the classic big-repository situation). */
		window: null
	};
	if (typeof options.window === 'number') state.window = options.window;

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
	// Optional hook invoked after EVERY response was dispatched (including each stage of the
	// staged pipeline): lets a test observe - and reject - transient jumps BETWEEN responses
	let afterEachResponse = null;
	const respond = async (message) => {
		if (message.command === 'loadRepoInfo') {
			dispatch({ command: 'loadRepoInfo', refreshId: message.refreshId, branches: ['main'], head: state.head, remotes: [], stashes: [], isRepo: true, error: null });
		} else if (message.command === 'loadCommits') {
			/* Realistic pipeline (see the loadCommits case in src/gitGraphView.ts): the FIRST
			 * response deliberately excludes the working-tree status (a `git status` can be slow),
			 * so it never carries the Uncommitted Changes row and is marked uncommittedPending -
			 * the row and its exact count only arrive in a final follow-up response. `staged`
			 * reproduces that two-step delivery; otherwise both responses are merged into one. */
			const loadCommitsMessage = (pending, commits) => ({
				command: 'loadCommits', refreshId: message.refreshId, commits: commits, head: state.head, tags: [],
				moreCommitsAvailable: state.window !== null, onlyFollowFirstParent: false, gerritStates: null,
				uncommittedPending: pending, error: null
			});
			const visibleHistory = state.window !== null ? state.history.slice(0, state.window) : state.history.slice();
			const finalCommits = state.uncommitted === null ? visibleHistory : [uncommittedRow(state.head, state.uncommitted), ...visibleHistory];
		if (!staged) {
			dispatch({ ...loadCommitsMessage(false, finalCommits), uncommittedCount: state.uncommittedCount });
			if (afterEachResponse !== null) afterEachResponse();
			return;
		}
			dispatch(loadCommitsMessage(true, visibleHistory));
		if (afterEachResponse !== null) afterEachResponse();
		await new Promise((resolve) => setTimeout(resolve, 10));
		dispatch({ ...loadCommitsMessage(false, finalCommits), uncommittedCount: state.uncommittedCount });
		if (afterEachResponse !== null) afterEachResponse();
		} else if (message.command === 'commitDetails') {
			const c = state.history.find((x) => x.hash === message.commitHash);
			dispatch({
				command: 'commitDetails', repo: REPO, error: null, avatar: null, codeReview: null, refresh: message.refresh,
				commitDetails: {
					hash: message.commitHash,
					parents: c !== undefined ? c.parents : [],
					author: c !== undefined ? c.author : 'Author',
					authorEmail: c !== undefined ? c.email : '',
					authorDate: c !== undefined ? c.date : 0,
					committer: c !== undefined ? c.author : 'Author',
					committerEmail: c !== undefined ? c.email : '',
					committerDate: c !== undefined ? c.date : 0,
					signature: null,
					body: '',
					fileChanges: []
				}
			});
			if (afterEachResponse !== null) afterEachResponse();
		}
		// every other request (loadConfig, fetchPullRequest, avatars, ...) is left unanswered:
		// the view tolerates a pending request, and none of them affect the commit table
	};

	/* Answer every request the view sends until it falls quiet (each response can trigger the
	 * next request, e.g. loadRepoInfo -> loadCommits). */
	const pump = async () => {
		for (let round = 0; round < 20; round++) {
			const queue = sent.splice(0);
			for (const message of queue) await respond(message);
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

	return { window, document, viewElem, state, dispatch, pump, scrollTo, rows, setAfterResponse: (fn) => { afterEachResponse = fn; }, ROW_HEIGHT };
}

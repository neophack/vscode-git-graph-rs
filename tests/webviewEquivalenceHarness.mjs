/**
 * Harness for the v1.0 equivalence test: boot ANY webview bundle (the frozen v1.0 bundle kept in
 * tests/fixtures/v1.0, or the freshly built media/out.min.js) in jsdom under a scripted extension
 * host, drive it like a user, and capture the document and the requests it sends - so the two
 * bundles can be compared checkpoint by checkpoint.
 *
 * jsdom has no layout engine, so the scroll container (#view) and the row geometry are emulated
 * with the same uniform-row model webviewHarness.mjs uses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { importDefaults, REPO, ROW_HEIGHT, VIEWPORT_HEIGHT } from './webviewHarness.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const V1_BUNDLE = path.join(rootDir, 'tests', 'fixtures', 'v1.0', 'out.min.js');
export const NEW_BUNDLE = path.join(rootDir, 'media', 'out.min.js');
export { REPO };

/* The skeleton the extension host renders (see getHtmlForWebview in src/gitGraphView.ts). */
const VIEW_HTML = `<!DOCTYPE html><html><head></head><body>
<div id="view" tabindex="-1">
	<div id="headerRow">
		<div id="controls">
			<span id="repoControl"><span id="repoControlLabel" class="unselectable"></span><div id="repoDropdown" class="dropdown"></div></span>
			<span id="branchControl"><span id="branchControlLabel" class="unselectable"></span><div id="branchDropdown" class="dropdown"></div></span>
			<span id="authorControl"><span id="authorControlLabel" class="unselectable"></span><div id="authorDropdown" class="dropdown"></div></span>

		<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span><span id="showRemoteBranchesLabel"></span></label>
		<span id="controlBtns">
			<div id="currentBtn"></div>
			<div id="findBtn"></div>
			<div id="filterBtn"></div>
			<div id="statisticsBtn"></div>
			<div id="terminalBtn"></div>
			<div id="settingsBtn"></div>
			<div id="fetchBtn"></div>
			<div id="refreshBtn"></div>
		</span>
		</div>
		<div id="pinnedControls" style="display:none">
			<span id="pinnedRowLabel" class="unselectable pinnedRowLabel"></span>
		</div>
	</div>
	<div id="conflictBanner" style="display:none"></div>
	<div id="content">
		<div id="commitGraph"></div>
		<div id="commitTable"></div>
	</div>
	<div id="footer"></div>
</div>
</body></html>`;

/** The wall-clock stand-in: a date far enough from every fixture timestamp that "x ago" text is stable. */
const FROZEN_NOW = Date.UTC(2025, 5, 15, 12, 0, 0);

/**
 * Boot a bundle.
 * @param {object} options
 * @param {string} options.bundle Path of the bundle to evaluate.
 * @param {(config: object) => void} [options.configure] Adjust the materialised Extension Settings.
 * @param {(repos: object) => void} [options.configureRepos] Adjust the repository set.
 * @param {(message: object, host: object) => (object[]|undefined)} options.respond Answer a request: return the responses to dispatch.
 * @param {number} [options.width] The simulated width of the view (px).
 * @param {object} [options.state] The persisted webview state VS Code hands back (a reload).
 * @param {object} [options.globalState] Override the global view state.
 */
export async function bootBundle(options) {
	const { getConfig, DEFAULT_REPO_STATE, DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE } = await importDefaults();
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
	config.dateFormat = { type: 0, iso: true };
	if (options.configure) options.configure(config);

	const repos = { [REPO]: JSON.parse(JSON.stringify(DEFAULT_REPO_STATE)) };
	if (options.configureRepos) options.configureRepos(repos);

	const dom = new JSDOM(VIEW_HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.invalid/' });
	const { window } = dom;
	const document = window.document;

	// A frozen clock: relative dates and any Date.now() default stay identical between the two runs
	const RealDate = window.Date;
	class FrozenDate extends RealDate {
		constructor(...args) { if (args.length === 0) super(FROZEN_NOW); else super(...args); }
		static now() { return FROZEN_NOW; }
	}
	window.Date = FrozenDate;

	const sent = [];
	window.initialState = {
		config: config,
		lastActiveRepo: REPO,
		loadViewTo: options.loadViewTo !== undefined ? options.loadViewTo : null,
		repos: repos,
		loadRepoInfoRefreshId: 0,
		loadCommitsRefreshId: 0,
		loadConfigRefreshId: 0,
		backend: options.backend !== undefined ? options.backend : {
			platform: 'win32-x64', engineAvailable: true, engineVersion: '1.2.3', gitCliAvailable: true,
			capabilities: [{ area: 'repoInfo', provider: 'rust' }, { area: 'commits', provider: 'hybrid' }, { area: 'writes', provider: 'git-cli' }]
		},
		restoredSnapshot: options.restoredSnapshot !== undefined ? options.restoredSnapshot : null
	};
	window.globalState = { ...DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE, ...(options.globalState || {}) };
	window.workspaceState = { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false };
	let persistedState = options.state !== undefined ? options.state : null;
	const states = [];
	window.VSCODE_API = {
		getState: () => persistedState,
		setState: (state) => { persistedState = state; states.push(JSON.parse(JSON.stringify(state))); },
		postMessage: (message) => { sent.push(JSON.parse(JSON.stringify(message))); }
	};
	window.acquireVsCodeApi = () => window.VSCODE_API;

	/* Emulated scroll container and row geometry (see webviewHarness.mjs) */
	const viewElem = document.getElementById('view');
	let scrollTopValue = 0;
	Object.defineProperty(viewElem, 'scrollTop', { get: () => scrollTopValue, set: (value) => { scrollTopValue = Math.max(0, value); } });
	Object.defineProperty(viewElem, 'scrollHeight', { get: () => document.querySelectorAll('#commitTable tr.commit').length * ROW_HEIGHT, configurable: true });
	Object.defineProperty(viewElem, 'clientHeight', { get: () => VIEWPORT_HEIGHT });
	const viewWidth = options.width !== undefined ? options.width : 1200;
	Object.defineProperty(viewElem, 'clientWidth', { get: () => viewWidth, configurable: true });
	window.Element.prototype.scroll = function (x, y) { if (this === viewElem && typeof y === 'number') scrollTopValue = Math.max(0, y); };
	window.Element.prototype.scrollTo = function () { };
	window.Element.prototype.scrollIntoView = function () { };
	const HEADER_HEIGHT = 96;
	window.Element.prototype.getBoundingClientRect = function () {
		if (this.classList !== undefined && this.classList.contains('commit') && this.closest !== undefined && this.closest('#commitTable') !== null) {
			let y = 0;
			for (const tr of document.querySelectorAll('#commitTable tr')) {
				if (tr === this) break;
				if (tr.id === 'tableColHeaders') continue;
				if (tr.classList.contains('virtSpacer')) y += parseInt(tr.querySelector('td').style.height, 10) || 0;
				else if (tr.classList.contains('commit')) y += ROW_HEIGHT;
			}
			const top = HEADER_HEIGHT + y - scrollTopValue;
			return { top: top, right: viewWidth, bottom: top + ROW_HEIGHT, left: 0, width: viewWidth, height: ROW_HEIGHT, x: 0, y: top, toJSON() { return this; } };
		}
		if (this === viewElem) return { top: 0, right: viewWidth, bottom: VIEWPORT_HEIGHT, left: 0, width: viewWidth, height: VIEWPORT_HEIGHT, x: 0, y: 0, toJSON() { return this; } };
		return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0, toJSON() { return this; } };
	};
	try {
		Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
			get() { return this.classList !== undefined && this.classList.contains('commit') ? ROW_HEIGHT : 0; },
			configurable: true
		});
	} catch (e) { /* the rect emulation above carries the tests */ }

	const errors = [];
	window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));

	window.eval(fs.readFileSync(options.bundle, 'utf8'));
	window.dispatchEvent(new window.Event('load'));

	const dispatch = (message) => {
		window.dispatchEvent(new window.MessageEvent('message', { data: JSON.parse(JSON.stringify(message)) }));
	};
	const host = { dispatch, window, document };
	const answered = new Set();

	/** Answer every request sent so far (each answer can trigger the next request). */
	const pump = async (rounds = 12) => {
		for (let round = 0; round < rounds; round++) {
			const pending = sent.filter((message) => !answered.has(message));
			if (pending.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 15));
				if (sent.every((message) => answered.has(message))) return;
				continue;
			}
			for (const message of pending) {
				answered.add(message);
				if (message.command === 'ready') {
					/* The push-based boot (REFACTOR-PLAN task 4.7): the page installs its router,
					 * sends `ready` and waits for the merged loadView push. Harvest the scenario's
					 * answers for the two pull requests and push them merged, as the host does. */
					const info = (options.respond({ command: 'loadRepoInfo', refreshId: 1 }, host) || [])[0];
					const page = (options.respond({ command: 'loadCommits', refreshId: 1, maxCommits: 300 }, host) || [])[0];
					if (info !== undefined && page !== undefined) {
						const { command: _ic, refreshId: _ir, ...infoBody } = info;
						const { command: _pc, refreshId: _pr, ...pageBody } = page;
						dispatch({ command: 'loadView', repo: REPO, refreshId: 1, repoInfo: infoBody, commits: pageBody });
					}
					continue;
				}
				const responses = options.respond(message, host);
				if (responses) for (const response of responses) dispatch(response);
			}
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
	};

	const settle = async (ms = 60) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		await pump();
	};

	await pump();
	await settle(30);

	const click = (target, init = {}) => {
		const elem = typeof target === 'string' ? document.querySelector(target) : target;
		if (!elem) throw new Error('click: nothing matches ' + target);
		elem.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
	};
	const rightClick = (target, init = {}) => {
		const elem = typeof target === 'string' ? document.querySelector(target) : target;
		if (!elem) throw new Error('rightClick: nothing matches ' + target);
		elem.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200, ...init }));
	};
	const dblClick = (target) => {
		const elem = typeof target === 'string' ? document.querySelector(target) : target;
		if (!elem) throw new Error('dblClick: nothing matches ' + target);
		elem.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
	};
	const key = (target, k, init = {}) => {
		const elem = typeof target === 'string' ? document.querySelector(target) : (target || document);
		elem.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
	};
	const type = (selector, text) => {
		const elem = document.querySelector(selector);
		elem.value = text;
		elem.dispatchEvent(new window.Event('input', { bubbles: true }));
		elem.dispatchEvent(new window.KeyboardEvent('keyup', { key: text.slice(-1), bubbles: true }));
	};
	const menuItem = (text) => Array.from(document.querySelectorAll('.contextMenuItem')).find((li) => li.textContent.startsWith(text));
	const clickMenuItem = (text) => {
		const item = menuItem(text);
		if (!item) throw new Error('menu item not found: ' + text + ' in ' + Array.from(document.querySelectorAll('.contextMenuItem')).map((li) => li.textContent).join(' | '));
		click(item);
	};

	return {
		window, document, viewElem, sent, states, errors, dispatch, pump, settle, click, rightClick, dblClick, key, type, menuItem, clickMenuItem,
		setScrollTop: (value) => { scrollTopValue = value; viewElem.dispatchEvent(new window.Event('scroll')); },
		html: () => canonicalHtml(document.body)
	};
}


/**
 * A canonical serialisation of a DOM subtree for comparison: attributes sorted, class tokens
 * sorted, inline style declarations sorted - so two documents compare equal exactly when they
 * render the same elements, text and attribute values.
 */
export function canonicalHtml(node) {
	const parts = [];
	const walk = (n, depth) => {
		if (n.nodeType === 3) {
			parts.push('\t'.repeat(depth) + JSON.stringify(n.data));
			return;
		}
		if (n.nodeType !== 1) return;
		const attrs = Array.from(n.attributes).map((attr) => {
			let value = attr.value;
			if (attr.name === 'class') value = value.split(/\s+/).filter(Boolean).sort().join(' ');
			if (attr.name === 'style') value = value.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.replace(/\s*:\s*/, ':')).sort().join(';');
			return attr.name + '=' + JSON.stringify(value);
		}).sort();
		parts.push('\t'.repeat(depth) + '<' + n.localName + (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
		for (const child of Array.from(n.childNodes)) walk(child, depth + 1);
	};
	walk(node, 0);
	return parts.join('\n');
}

/**
 * P3 — the webview rendering gate (REFACTOR-PLAN §6.7, row P3): loads the BUILT webview
 * artifact (media/out.min.js, the exact bytes a VSIX ships) in a real headless Chromium
 * through playwright-core, with a fake host bridge answering the page's requests from fixture
 * data, and measures what only a real layout engine can measure:
 *
 *   t2t5-s / t2t5-10k    T2 -> T5: script start -> the first rAF after commit rows are
 *                        rendered (§3.8.1's "own time"). The s case is the REAL merged
 *                        loadView response of the S-tier fixture through the real pipeline
 *                        (P2's wiring); the 10k case is a deterministic 10,000-row history —
 *                        the scroll-stress population of the scrolling budget.
 *   scroll-p99-10k       frame-time P99 while auto-scrolling the 10k list (rAF deltas), with
 *                        the §3.8.5 frame budget (<= 16 ms) as the absolute reference
 *   longtasks-10k        long tasks (> 50 ms) observed during one scroll pass
 *   muts-refs-only       DOM mutations under the commit table for one refs-only update
 *                        (branch/tag pills moved between commits — nothing re-walked)
 *   heap-10k             the webview's JS heap with the 10k rows loaded (§3.8.1 memory budget)
 *
 * Browser selection: `--channel msedge|chrome|chromium` or GG_PERF_CHANNEL; by default the
 * locally installed Edge/Chrome is used (channel 'msedge' then 'chrome'), so no browser
 * download is needed on a dev machine. CI installs Chromium and passes --channel chromium.
 *
 * `node test/perf/p3-webview.mjs [--samples N] [--channel msedge]`
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { commitStamp, ensureResultsDir, loadVscodeModule, mediaDir, parseArguments, writeJson } from './lib/env.mjs';
import { percentile, summarize } from './lib/stats.mjs';
import { createLoader, composeRepository, ensureFixturePair, loadPipeline, runLoaderRequest, viewRequest } from './lib/host-pipeline.mjs';

/* ---------- the initialState the real extension embeds (defaults of every setting) ---------- */

/**
 * The real config/extensionState modules require 'vscode' for their defaults; the same
 * default-answering stub shape the jsdom webview harness uses serves them through the harness
 * loader (lib/env.mjs's loadVscodeModule). The configuration model builds its snapshot from the
 * schema table (platform/config/) and graphView/html.ts maps it to the exact GitGraphViewConfig
 * the page boots on — the harness loads both, so it cannot drift from the real mapping.
 */
async function importDefaults() {
	const stub = {
		Uri: { file: (p) => ({ fsPath: p, path: p }) },
		env: { language: 'en', uriScheme: 'vscode' },
		ViewColumn: { Active: 1, Beside: 2, One: 3, Two: 4, Three: 5, Four: 6, Five: 7, Six: 8, Seven: 9, Eight: 10, Nine: 11 },
		window: { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
		workspace: { getConfiguration: () => ({ get: (_s, d) => d, has: () => false, inspect: () => undefined, update: () => Promise.resolve() }) }
	};
	const config = loadVscodeModule('extension/platform/config/index.ts', stub);
	const html = loadVscodeModule('extension/graphView/html.ts', stub);
	const state = loadVscodeModule('extension/platform/storage.ts', stub);
	return { takeSnapshot: config.takeSnapshot, workspace: stub.workspace, getWebviewConfig: html.getWebviewConfig, defaults: state };
}

/** The global state the page boots on (the extension's persisted defaults). */
export async function buildGlobalState() {
	const { defaults } = await importDefaults();
	return { ...defaults.DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE };
}

/** The initialState object the page boots on (the real getWebviewConfig mapping). */
export async function buildInitialState(repoPath) {
	const { takeSnapshot, workspace, getWebviewConfig, defaults } = await importDefaults();
	const config = { ...getWebviewConfig(takeSnapshot(workspace), 'en', true) };
	config.fetchAvatars = false; // no network in the gate
	config.pullRequests.enabled = false;
	return {
		config: config,
		lastActiveRepo: repoPath,
		loadViewTo: null,
		repos: { [repoPath]: JSON.parse(JSON.stringify(defaults.DEFAULT_REPO_STATE)) },
		loadRepoInfoRefreshId: 0,
		loadCommitsRefreshId: 0,
		loadConfigRefreshId: 0,
		backend: { platform: 'test', engineAvailable: true, engineVersion: 'test', gitCliAvailable: true, capabilities: [] },
		restoredSnapshot: null
	};
}

/* ---------- the fixture data the fake host answers with ---------- */

/** The REAL merged open response of the S-tier fixture through the real pipeline. */
export async function realFixtureView(workDir, tier) {
	const modules = loadPipeline();
	const { repoA } = await ensureFixturePair(modules, tier, workDir);
	const backend = modules.createBackend();
	await backend.openRepository(repoA);
	const loader = createLoader(modules, composeRepository(modules, backend));
	const { responses } = await runLoaderRequest(loader, viewRequest(repoA, { hard: true }));
	loader.dispose();
	backend.closeAllRepositories();
	const view = responses.find((r) => r.command === 'loadView');
	if (view === undefined) throw new Error('the pipeline produced no loadView response for the fixture');
	return { repo: repoA, view: view };
}

/** A deterministic 10,000-commit linear history in the wire's GitCommit shape. */
export function syntheticHistory(total) {
	const hash = (i) => 'c' + String(i).padStart(5, '0') + 'a'.repeat(26);
	const commits = [];
	for (let i = 0; i < total; i++) {
		commits.push({
			hash: hash(i),
			parents: i + 1 < total ? [hash(i + 1)] : [],
			author: 'Author ' + (i % 40),
			email: 'author' + (i % 40) + '@example.com',
			date: 1700000000 + (total - i) * 60,
			message: 'commit ' + i,
			heads: i === 0 ? ['main'] : [],
			tags: i % 500 === 0 && i > 0 ? ['v' + (i / 1000).toFixed(1)] : [],
			remotes: i % 250 === 0 && i > 0 ? ['origin/main~' + i] : [],
			stash: null
		});
	}
	return {
		repo: '/perf/synthetic-10k',
		view: {
			command: 'loadView',
			repo: '/perf/synthetic-10k',
			refreshId: 1,
			repoInfo: { branches: ['main'], head: 'main', remotes: ['origin'], stashes: [], tags: [], error: null, isRepo: true, operationState: { type: null, conflictedFiles: [], progress: null } },
			commits: { commits: commits, head: hash(0), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, uncommittedPending: false, branches: null, error: null }
		}
	};
}

/* ---------- the page, served over a loopback HTTP server ---------- */

const VIEW_SKELETON = `<div id="view" tabindex="-1">
	<div id="headerRow">
		<div id="controls">
			<span id="repoControl"><span id="repoControlLabel" class="unselectable"></span><div id="repoDropdown" class="dropdown"></div></span>
			<span id="branchControl"><span id="branchControlLabel" class="unselectable"></span><div id="branchDropdown" class="dropdown"></div></span>
			<span id="authorControl"><span id="authorControlLabel" class="unselectable"></span><div id="authorDropdown" class="dropdown"></div></span>
			<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span><span id="showRemoteBranchesLabel"></span></label>
			<span id="controlBtns"><div id="currentBtn"></div><div id="findBtn"></div><div id="filterBtn"></div><div id="statisticsBtn"></div><div id="terminalBtn"></div><div id="settingsBtn"></div><div id="fetchBtn"></div><div id="refreshBtn"></div></span>
		</div>
		<div id="pinnedControls" style="display:none"></div>
	</div>
	<div id="conflictBanner" style="display:none"></div>
	<div id="content"><div id="commitGraph"></div><div id="commitTable"></div></div>
	<div id="footer"></div>
</div>`;

/** The page's inline harness: the fake vscode api, the T2/T5 marks, and the measurement hooks. */
function pageHarnessScript() {
	return `(function () {
	'use strict';
	var state = window.__ggData;
	var view = state.view;
	var sent = [];
	window.__ggSent = sent;
	window.__perf = { t2: performance.now(), t5: null, painted: false };
	// The fake host bridge: acquireVsCodeApi records every request; 'ready' is answered with the
	// fixture's real merged loadView response, exactly what the panel pushes on boot.
	window.acquireVsCodeApi = function () {
		return {
			getState: function () { return null; },
			setState: function () {},
			postMessage: function (m) {
				sent.push(m);
				try { window.__ggAnswer(m); } catch (e) { window.__ggError = String(e); }
			}
		};
	};
	function dispatch(message) { window.dispatchEvent(new MessageEvent('message', { data: message })); }
	function headAndTags() {
		var c = view.commits.commits;
		return { head: c.length > 0 ? c[0].hash : null, tags: [] };
	}
	window.__ggAnswer = function (message) {
		if (message.command === 'ready') { dispatch(view); return; }
		if (message.command === 'loadRepoInfo') {
			dispatch({ command: 'loadRepoInfo', refreshId: message.refreshId, branches: view.repoInfo.branches, head: view.repoInfo.head, remotes: view.repoInfo.remotes, stashes: view.repoInfo.stashes, tags: view.repoInfo.tags, isRepo: true, error: null, remoteRefsPending: undefined, operationState: view.repoInfo.operationState });
			return;
		}
		if (message.command === 'loadCommits') {
			var ht = headAndTags();
			dispatch({ command: 'loadCommits', refreshId: message.refreshId, commits: view.commits.commits, head: ht.head, tags: ht.tags, branches: null, moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, uncommittedPending: false, uncommittedCount: 0, error: null });
			return;
		}
		if (message.command === 'loadConfig') {
			dispatch({ command: 'loadConfig', repo: message.repo, refreshId: message.refreshId, configs: {}, eligibleLevels: [], error: null });
			return;
		}
		if (message.command === 'commitDetails') {
			var c = null;
			for (var i = 0; i < view.commits.commits.length; i++) if (view.commits.commits[i].hash === message.commitHash) c = view.commits.commits[i];
			dispatch({ command: 'commitDetails', repo: message.repo, error: null, avatar: null, codeReview: null, refresh: message.refresh, commitDetails: { hash: message.commitHash, parents: c ? c.parents : [], author: c ? c.author : 'a', authorEmail: c ? c.email : '', authorDate: c ? c.date : 0, committer: c ? c.author : 'a', committerEmail: c ? c.email : '', committerDate: c ? c.date : 0, subject: c ? c.message : '', body: '', notes: '', signature: null, fileChanges: [] } });
		}
	};
	// T5: the first rAF callback that observes rendered commit rows (§3.8.1's definition).
	function watchPaint() {
		requestAnimationFrame(function () {
			if (window.__perf.painted) return;
			var rows = document.querySelectorAll('#commitTable tr.commit').length;
			if (rows > 0 && window.__perf.t5 === null) {
				window.__perf.t5 = performance.now() - window.__perf.t2;
				window.__perf.painted = true;
				window.__perf.rows = rows;
			}
			if (!window.__perf.painted) watchPaint();
		});
	}
	watchPaint();
	// The refs-only update: branch/tag pills moved between existing commits; nothing re-walked.
	var mutator = null;
	window.__ggRefsOnly = function (step) {
		return new Promise(function (resolve) {
			var table = document.getElementById('commitTable');
			var added = 0, removed = 0, changed = 0;
			var observer = new MutationObserver(function (records) {
				for (var i = 0; i < records.length; i++) {
					added += records[i].addedNodes.length;
					removed += records[i].removedNodes.length;
					if (records[i].type === 'characterData') changed++;
				}
			});
			observer.observe(table, { childList: true, subtree: true, characterData: true });
			var commits = view.commits.commits;
			var next = JSON.parse(JSON.stringify(commits));
			// Move the branch head and a tag to different commits (the pills re-render in place).
			for (var i = 0; i < next.length; i++) {
				next[i].heads = [];
				next[i].tags = [];
			}
			next[step % next.length].heads = ['main'];
			next[(step * 7 + 3) % next.length].heads = ['feature/perf'];
			next[(step * 11 + 5) % next.length].tags = ['v1.perf'];
			// The boot's loadView response made the view ADOPT its refresh id (repoLoader's
			// processLoadView); a response stamped with any other id is dropped as stale.
			dispatch({ command: 'loadCommits', refreshId: view.refreshId, commits: next, head: view.commits.head, tags: [], branches: null, moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, uncommittedPending: false, uncommittedCount: 0, error: null });
			requestAnimationFrame(function () {
				requestAnimationFrame(function () {
					observer.disconnect();
					resolve({ added: added, removed: removed, changed: changed, total: added + removed + changed });
				});
			});
		});
	};
	// The scroll pass: rAF-driven continuous scrolling, collecting frame deltas + long tasks.
	window.__ggScrollPass = function (steps) {
		return new Promise(function (resolve) {
			var frames = [];
			var longTasks = 0;
			var po = new PerformanceObserver(function (list) { longTasks += list.getEntries().length; });
			po.observe({ entryTypes: ['longtask'] });
			var scroller = document.getElementById('view');
			function tick(ts) {
				frames.push(ts);
				scroller.scrollTop += 40;
				if (frames.length < steps) requestAnimationFrame(tick);
				else {
					po.disconnect();
					var deltas = [];
					for (var i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
					resolve({ frames: frames.length, deltas: deltas, longTasks: longTasks, scrollTop: scroller.scrollTop, height: scroller.scrollHeight });
				}
			}
			scroller.scrollTop = 0;
			requestAnimationFrame(tick);
		});
	};
	window.__ggHeap = function () { return performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null; };
	window.addEventListener('message', function () {});
})();`;
}

/** Serve the page + the built webview assets from a loopback server; returns the base URL. */
export function startServer(cases) {
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		/* The page mirrors the real one (task 5.9): the entry is an ES MODULE whose static import
		   closure (the shared chunks) and dynamic import() calls (the on-demand chunks) all resolve
		   under /chunks/ - every file the browser may ask for is served from media/, so the page
		   exercises exactly the artifact graph a VSIX ships. */
		const mediaPaths = new Map([['/out.min.js', 'out.min.js'], ['/out.min.css', 'out.min.css']]);
		if (mediaPaths.has(url.pathname)) {
			response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
			response.end(fs.readFileSync(path.join(mediaDir, mediaPaths.get(url.pathname))));
			return;
		}
		if (url.pathname.startsWith('/chunks/') && /^\/chunks\/[\w.-]+\.js$/.test(url.pathname)) {
			response.setHeader('Content-Type', 'text/javascript');
			response.end(fs.readFileSync(path.join(mediaDir, 'chunks', url.pathname.slice('/chunks/'.length))));
			return;
		}
		const data = cases[url.searchParams.get('case') ?? 's'];
		if (data === undefined) {
			response.statusCode = 404;
			response.end('unknown case');
			return;
		}
		const colours = data.initialState.config.graph.colours;
		let vars = '', params = '';
		for (let i = 0; i < colours.length; i++) {
			vars += '--git-graph-color' + i + ':' + colours[i] + '; ';
			params += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ');} ';
		}
		response.setHeader('Content-Type', 'text/html');
		response.end('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
			'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
			'<link rel="stylesheet" type="text/css" href="/out.min.css">' +
			'<title>Git Graph (perf)</title>' +
			'<style>html,body{margin:0;padding:0;height:100%}#view{height:100vh;overflow-y:auto}body{' + vars + '} ' + params + '</style>' +
			'</head><body>' + VIEW_SKELETON +
			'<script>var initialState = ' + JSON.stringify(data.initialState) + ', globalState = ' + JSON.stringify(data.globalState) + ', workspaceState = {};</script>' +
			'<script>window.__ggData = ' + JSON.stringify(data) + ';</script>' +
			'<script>' + pageHarnessScript() + '</script>' +
			'<script type="module" src="/out.min.js"></script>' +
			'</body></html>');
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port })));
}

import fs from 'node:fs';

/* ---------- the browser ---------- */

/** Resolve playwright-core's chromium, preferring installed browser channels (no download). */
async function launchBrowser(channel) {
	const { chromium } = await import('playwright-core');
	const order = channel !== undefined ? [channel] : (process.env.GG_PERF_CHANNEL ? [process.env.GG_PERF_CHANNEL] : ['msedge', 'chrome', 'none']);
	let lastError = null;
	for (const candidate of order) {
		const options = { headless: true };
		if (candidate !== 'none' && candidate !== 'chromium') options.channel = candidate;
		try {
			return await chromium.launch(options);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error('No usable Chromium found for P3 (tried: ' + order.join(', ') + '): ' + (lastError ? lastError.message.split('\n')[0] : 'unknown error'));
}

/* ---------- the gate ---------- */

/**
 * Run the whole P3 gate.
 * @param options `{ tier, samples, channel?, workDir? }`
 */
export async function runP3(options) {
	const samples = options.samples ?? 21;
	const workDir = options.workDir ?? path.join(os.tmpdir(), 'gg-perf-p3-' + options.tier);
	console.log('[p3] tier=' + options.tier + ' samples=' + samples + ' — fixture data through the real pipeline...');
	const real = await realFixtureView(workDir, options.tier);
	const initialState = await buildInitialState(real.repo);
	const globalState = await buildGlobalState();
	const cases = {
		s: { initialState: initialState, globalState: globalState, view: real.view },
		'10k': { initialState: { ...initialState, lastActiveRepo: '/perf/synthetic-10k', repos: { '/perf/synthetic-10k': initialState.repos[Object.keys(initialState.repos)[0]] } }, globalState: globalState, view: syntheticHistory(10000).view }
	};
	const { server, base } = await startServer(cases);
	const browser = await launchBrowser(options.channel);
	const items = [];
	try {
		const record = (id, values, unit, extra = {}) => {
			items.push({ gate: 'p3', id: id, backend: 'webview', ...summarize(values, unit), samples: values.map((v) => Math.round(v * 1000) / 1000), ...extra });
			const item = items[items.length - 1];
			console.log('      ' + pad(id, 18) + ' median ' + item.median.toFixed(1).padStart(8) + ' ' + unit + '   p95 ' + item.p95.toFixed(1).padStart(8) + ' ' + unit + '   n=' + item.n);
		};

		/* T2 -> T5, fresh page per sample (the open journey, both populations). */
		for (const caseName of ['s', '10k']) {
			const values = [];
			// Two warm-ups: browser + JS parse + shader caches, excluded like every gate's warm-up.
			for (let i = 0; i < samples + 2; i++) {
				const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
				const page = await context.newPage();
				await page.goto(base + '/?case=' + caseName, { waitUntil: 'load' });
				await page.waitForFunction(() => window.__perf !== undefined && window.__perf.t5 !== null, null, { timeout: 60000 });
				const value = await page.evaluate(() => ({ t5: window.__perf.t5, rows: window.__perf.rows }));
				if (value.rows === 0 || value.t5 <= 0) throw new Error('t2t5 case ' + caseName + ': no rows painted');
				if (i >= 2) values.push(value.t5);
				await context.close();
			}
			record('t2t5-' + caseName, values, 'ms');
		}

		/* One 10k page for the scroll, mutation and heap measurements. */
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		await page.goto(base + '/?case=10k', { waitUntil: 'load' });
		await page.waitForFunction(() => window.__perf !== undefined && window.__perf.t5 !== null, null, { timeout: 60000 });

		const p99s = [];
		const longTasks = [];
		for (let i = 0; i < samples + 1; i++) {
			const pass = await page.evaluate((steps) => window.__ggScrollPass(steps), 120);
			if (pass.deltas.length < 20) throw new Error('scroll pass produced ' + pass.deltas.length + ' frames');
			if (i >= 1) {
				p99s.push(percentile(pass.deltas, 99));
				longTasks.push(pass.longTasks);
			}
		}
		record('scroll-p99-10k', p99s, 'ms');
		record('longtasks-10k', longTasks, 'count');

		/* Refs-only updates on the S population (the 300-row window users actually look at). */
		const sContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		const sPage = await sContext.newPage();
		await sPage.goto(base + '/?case=s', { waitUntil: 'load' });
		await sPage.waitForFunction(() => window.__perf !== undefined && window.__perf.t5 !== null, null, { timeout: 60000 });
		const mutations = [];
		for (let i = 0; i < samples + 1; i++) {
			const result = await sPage.evaluate((step) => window.__ggRefsOnly(step), i);
			if (i >= 1) mutations.push(result.total);
		}
		record('muts-refs-only', mutations, 'count');
		await sContext.close();

		const heap = await page.evaluate(() => window.__ggHeap());
		if (heap === null) throw new Error('performance.memory is unavailable (a Chromium flag changed)');
		// Single sample by nature (one heap reading after the pass): reported as information
		// against the §3.8.1 absolute budget, never gated relatively (GC timing swings it far
		// more than any code change under test would).
		items.push({ gate: 'p3', id: 'heap-10k', backend: 'webview', n: 1, unit: 'MB', gating: false, median: heap.used / 1024 / 1024, p95: heap.used / 1024 / 1024, mean: heap.used / 1024 / 1024, best: heap.used / 1024 / 1024, worst: heap.used / 1024 / 1024 });
		console.log('      heap-10k              median ' + (heap.used / 1024 / 1024).toFixed(1).padStart(8) + ' MB');

		await context.close();
	} finally {
		await browser.close();
		server.close();
	}

	return { gate: 'p3', tier: options.tier, commit: commitStamp(), items: items };
}

function pad(text, width) {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/* Standalone entry: `node test/perf/p3-webview.mjs [--samples N] [--channel msedge|chrome|chromium]` */
if (process.argv[1] && process.argv[1].endsWith('p3-webview.mjs')) {
	const args = parseArguments(process.argv.slice(2));
	const tier = args.options.tier ?? 's';
	const result = await runP3({ tier: tier, samples: Number(args.options.samples ?? 21), channel: args.options.channel, workDir: args.options.workDir });
	ensureResultsDir();
	const file = path.join(import.meta.dirname, 'results', 'p3-' + tier + '.json');
	writeJson(file, result);
	console.log('\n[p3] wrote ' + file);
}

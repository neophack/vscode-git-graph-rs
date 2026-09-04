/* Real-browser (Chrome/Edge, real layout engine) layout tests for the compiled webview bundle.
 *
 * Self-contained: regenerates tests/browserRepro/index.html, serves the repo root on a local
 * port, drives every scenario through window.__run (see generate.mjs) and asserts the layout
 * invariants. Exits non-zero if any check fails.
 *
 * Usage: node tests/browserRepro/run.mjs [--keep]   (--keep: keep browser/server for debugging)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const keep = process.argv.includes('--keep');

/* regenerate the page from the current bundle + config defaults */
const gen = spawnSync(process.execPath, [path.join(rootDir, 'tests/browserRepro/generate.mjs')], { stdio: 'inherit' });
if (gen.status !== 0) process.exit(1);

/* static server for the repo root */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
	const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
	let file = path.join(rootDir, urlPath);
	if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
	res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
	fs.createReadStream(file).pipe(res);
});
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const BROWSERS = [
	process.env.CHROME_PATH,
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);
const executablePath = BROWSERS.find((p) => fs.existsSync(p));
if (executablePath === undefined) { console.error('ERROR: no Chrome/Edge executable found'); server.close(); process.exit(1); }

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--window-size=1280,760'] });
let failures = 0;
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR:', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });

const load = async (query) => {
	await page.goto(`http://127.0.0.1:${port}/tests/browserRepro/index.html${query || ''}`, { waitUntil: 'load' });
	await page.waitForSelector('#commitTable tr.commit');
	await new Promise((r) => setTimeout(r, 400));
};
const run = async (name) => JSON.parse(await page.evaluate((n) => window.__run(n), name));
const check = (ok, label, detail) => {
	console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || detail === undefined ? '' : '  [' + JSON.stringify(detail) + ']'));
	if (!ok) failures++;
};
const near = (a, b, tol) => a !== undefined && b !== undefined && Math.abs(a - b) <= (tol === undefined ? 2 : tol);
const diffKeys = (a, b, tol) => {
	const out = [];
	for (const k of Object.keys(a)) if (!near(a[k], b[k], tol)) out.push(k);
	return out;
};

const session = async (variant, scenarios) => {
	await load(variant === 'default' ? '' : '?cfg=' + variant);
	const variantLabel = variant === 'default' ? '' : ' [' + variant + ']';
	const results = {};
	for (const [name, fn] of scenarios) {
		const r = await run(name);
		results[name] = r;
		await fn(r, variantLabel);
	}
	return results;
};

/* ---------------- main session (default config) ---------------- */
const mainChecks = [];

/* 1. scroll anchor: jump into mid-history, everything is measured relative to the viewport */
await session('default', [
	['jump', (r, tag) => mainChecks.push([r.after.tracked['commit 150'] !== undefined, 'jump: commit 150 rendered in viewport' + tag, r.after.tracked])],
	/* 2. uncommitted changes appear (count 3) while scrolled mid-history: the row is prepended
	 * above everything (off-screen), the scroll shifts by exactly one row so commit 150 stays
	 * where it was, and the graph width must not change */
	['uncommittedAppear', (r, tag) => {
		mainChecks.push([r.after.scrollTop - r.before.scrollTop === 24, 'uncommittedAppear: scroll follows the row inserted above by exactly its height' + tag, { before: r.before.scrollTop, after: r.after.scrollTop }]);
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'uncommittedAppear: commit 150 viewport position anchored' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
		mainChecks.push([near(r.before.graphWidth, r.after.graphWidth), 'uncommittedAppear: graph column width unchanged' + tag, { before: r.before.graphWidth, after: r.after.graphWidth }]);
	}],
	/* 3. count 3 -> 2: only the off-screen uncommitted row's text may change, nothing may move */
	['uncommittedCountChange', (r, tag) => {
		mainChecks.push([diffKeys(r.before.tracked['commit 150'], r.after.tracked['commit 150'], 1).length === 0, 'uncommittedCountChange: commit 150 row fully stable' + tag, { before: r.before.tracked['commit 150'], after: r.after.tracked['commit 150'] }]);
		mainChecks.push([diffKeys(r.before.tracked['commit 160'], r.after.tracked['commit 160'], 1).length === 0, 'uncommittedCountChange: commit 160 row fully stable' + tag, { before: r.before.tracked['commit 160'], after: r.after.tracked['commit 160'] }]);
	}],
	/* 4. uncommitted cleared while scrolled mid-history: the row vanishes above, viewport keeps
	 * its place (scroll shifts back by one row) */
	['uncommittedClear', (r, tag) => {
		mainChecks.push([r.before.scrollTop - r.after.scrollTop === 24, 'uncommittedClear: scroll follows the row removed above by exactly its height' + tag, { before: r.before.scrollTop, after: r.after.scrollTop }]);
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'uncommittedClear: commit 150 viewport position anchored' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
	}],
	/* 5. new commit on top (fetch): anchor keeps the viewport */
	['commitPrepend', (r, tag) => {
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'commitPrepend: commit 150 anchored' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
	}],
	/* 6. commit inserted below the viewport rows: nothing moves at all */
	['commitInsertMid', (r, tag) => {
		mainChecks.push([diffKeys(r.before.tracked['commit 150'], r.after.tracked['commit 150'], 1).length === 0, 'commitInsertMid: commit 150 fully stable' + tag, { before: r.before.tracked['commit 150'], after: r.after.tracked['commit 150'] }]);
	}],
	/* 7. commit removed below the viewport rows: nothing moves at all */
	['commitRemoveMid', (r, tag) => {
		mainChecks.push([diffKeys(r.before.tracked['commit 150'], r.after.tracked['commit 150'], 1).length === 0, 'commitRemoveMid: commit 150 fully stable' + tag, { before: r.before.tracked['commit 150'], after: r.after.tracked['commit 150'] }]);
	}],
	/* 8. commit rewritten in mid-history (rebase): anchor keeps the viewport */
	['rewriteMid', (r, tag) => {
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'rewriteMid: commit 150 anchored' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
	}],
	/* 8b. a file was saved while scrolled mid-history: the deferred "Uncommitted Changes"
	 * response (list without the row + count follow-up) synthesizes the row above the viewport
	 * - the view must NOT jump up (or anywhere): the scroll shifts by exactly one row so the
	 * commit the user is looking at stays put */
	['fileSavedDirty', (r, tag) => {
		mainChecks.push([r.after.tracked['commit 150'] !== undefined && near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'fileSavedDirty: commit 150 anchored (no upward jump)' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
		mainChecks.push([r.after.scrollTop - r.before.scrollTop === 24, 'fileSavedDirty: scroll follows the row inserted above, so nothing on screen moves' + tag, { before: r.before.scrollTop, after: r.after.scrollTop }]);
		mainChecks.push([near(r.before.graphWidth, r.after.graphWidth), 'fileSavedDirty: graph column width unchanged' + tag, null]);
	}],
	/* 8c. another save changes only the count: nothing may move at all */
	['fileSavedCountChange', (r, tag) => {
		mainChecks.push([diffKeys(r.before.tracked['commit 150'], r.after.tracked['commit 150'], 1).length === 0, 'fileSavedCountChange: commit 150 fully stable' + tag, null]);
		mainChecks.push([r.before.scrollTop === r.after.scrollTop, 'fileSavedCountChange: scrollTop unchanged' + tag, { before: r.before.scrollTop, after: r.after.scrollTop }]);
	}],
	/* 8d. the watcher firing on EVERY save (five refreshes in a row, count flickering 2/1):
	 * every single round must leave the viewport byte-identical - no cumulative drift, no jump */
	['watcherLoop', (r, tag) => {
		const rounds = r.extra.rounds || [];
		mainChecks.push([rounds.length === 5, 'watcherLoop: five refresh rounds executed' + tag, rounds.length]);
		for (let i = 1; i < rounds.length; i++) {
			const a = rounds[i - 1], b = rounds[i];
			mainChecks.push([a.scrollTop === b.scrollTop && near(a.tracked['commit 150'].top, b.tracked['commit 150'].top, 1) && near(a.tracked['commit 160'].textLeft, b.tracked['commit 160'].textLeft, 1),
				'watcherLoop: round ' + i + ' viewport identical to round ' + (i - 1) + tag, { scrollTop: [a.scrollTop, b.scrollTop], top150: [a.tracked['commit 150'].top, b.tracked['commit 150'].top] }]);
		}
	}],
	/* 8e. the checked-out branch moves to another commit (pill moves between rows) */
	['branchMoved', (r, tag) => {
		const refs = (r.after.tracked['commit 150'].refs || []).map((x) => x.name);
		mainChecks.push([refs.includes('main'), 'branchMoved: main pill moved to commit 150' + tag, refs]);
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'branchMoved: no vertical jump' + tag, null]);
		mainChecks.push([near(r.before.tracked['commit 160'].textLeft, r.after.tracked['commit 160'].textLeft, 1), 'branchMoved: other rows horizontally stable' + tag, null]);
	}],
	/* 8f. commit inserted ABOVE the viewport (between 149 and 150): anchor keeps commit 150 */
	['commitInsertAbove', (r, tag) => {
		mainChecks.push([near(r.before.tracked['commit 145'].top, r.after.tracked['commit 145'].top), 'commitInsertAbove: top-of-viewport row (145) anchored' + tag, { before: r.before.tracked['commit 145'].top, after: r.after.tracked['commit 145'].top }]);
		mainChecks.push([r.after.tracked['commit 150'].top - r.before.tracked['commit 150'].top === 24, 'commitInsertAbove: rows below the insertion shift down by exactly one row' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
	}],
	/* 8g. commit removed ABOVE the viewport (drop/rebase): anchor keeps commit 150 */
	['commitDropAbove', (r, tag) => {
		mainChecks.push([near(r.before.tracked['commit 145'].top, r.after.tracked['commit 145'].top), 'commitDropAbove: top-of-viewport row (145) anchored' + tag, { before: r.before.tracked['commit 145'].top, after: r.after.tracked['commit 145'].top }]);
		mainChecks.push([r.before.tracked['commit 150'].top - r.after.tracked['commit 150'].top === 24, 'commitDropAbove: rows below the removal shift up by exactly one row' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
	}],
	/* 8h. the REAL host pipeline end-to-end: six refresh cycles, each delivered as the three
	 * staged responses the extension really sends (list without the row + pending, remote refs
	 * follow-up, uncommitted row with a fresh date + count), with the working tree going dirty ->
	 * dirty -> clean -> dirty -> clean -> dirty. Measured after EVERY stage: the tracked rows
	 * must never move; scrollTop may only compensate by exactly one row when the uncommitted
	 * row appears/disappears. This is the regression test for "文件修改界面往上跳 / 没操作一直跳". */
	['realPipelineLoop', (r, tag) => {
		const stages = r.extra.stages || [];
		const baseTop = stages.length > 0 && stages[0].tracked['commit 150'] !== undefined ? stages[0].tracked['commit 150'].top : 86;
		mainChecks.push([stages.length === 18, 'realPipelineLoop: 6 cycles x 3 stages executed' + tag, stages.length]);
		for (let i = 0; i < stages.length; i++) {
			const st = stages[i];
			mainChecks.push([st.tracked['commit 150'] !== undefined && Math.abs(st.tracked['commit 150'].top - baseTop) <= 2,
				'realPipelineLoop: stage ' + i + ' (' + st.stage + ', count ' + st.count + ') commit 150 anchored' + tag, st.tracked['commit 150']]);
		}
		/* the row appearing/disappearing must shift scrollTop by exactly +- one row (following the
		 * row that entered/left above the viewport, which is what keeps the rows on screen still),
		 * never by anything else - and never cumulatively: the scroll returns to the same value
		 * every time the tree returns to the same state */
		for (let i = 1; i < stages.length; i++) {
			const d = stages[i].scrollTop - stages[i - 1].scrollTop;
			mainChecks.push([d === 0 || Math.abs(d) === 24, 'realPipelineLoop: stage ' + i + ' scrollTop delta is 0 or exactly one row' + tag, d]);
		}
		/* no cumulative drift: across all 18 stages the scroll may only ever sit at one of two
		 * values - with the Uncommitted Changes row above the viewport, or without it - one row
		 * apart. A leak in any path would keep adding rows' worth of scroll and show up as a third. */
		const seen = [...new Set(stages.map((st) => st.scrollTop))].sort((a, b) => a - b);
		mainChecks.push([seen.length <= 2 && (seen.length < 2 || seen[1] - seen[0] === 24),
			'realPipelineLoop: no cumulative drift (scroll only ever takes the with-row / without-row value)' + tag,
			{ distinct: seen, sequence: stages.map((st) => st.stage + '/' + st.count + '=' + st.scrollTop) }]);
	}],
	/* 9. parallel lanes appear around the viewport: the graph column must widen, rows must
	 *    keep the uniform pitch and the anchored commit must stay put */
	['lanesWiden', async (r, tag) => {
		mainChecks.push([r.after.graphWidth > r.before.graphWidth, 'lanesWiden: graph column grew' + tag, { before: r.before.graphWidth, after: r.after.graphWidth }]);
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'lanesWiden: commit 150 anchored' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
		const pitch = await page.evaluate(() => window.__rowPitch());
		mainChecks.push([pitch.length === 0 || pitch.every((p) => Math.abs(p - 24) <= 1), 'lanesWiden: uniform row pitch' + tag, pitch]);
	}],
	/* 10-12. ref pills: a row's labels changing re-renders THAT row and must move nothing else,
	 * vertically or horizontally. Three cases cover it - gaining labels, losing them, and a label
	 * change on a row outside the viewport (which must not touch the visible rows at all). The
	 * add/remove variants per label KIND are not separate cases: the row is rebuilt from its own
	 * HTML either way, so branch vs tag vs remote exercises the same path. */
	['pillAddBoth', (r, tag) => {
		const refs = r.after.tracked['commit 150'].refs.map((x) => x.name);
		mainChecks.push([refs.includes('feature-y') && refs.includes('v2.0.0'), 'pillAddBoth: branch+tag pills rendered (remote combines into the branch label)' + tag, refs]);
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'pillAddBoth: no vertical jump of the pill row' + tag, null]);
		mainChecks.push([near(r.before.tracked['commit 160'].textLeft, r.after.tracked['commit 160'].textLeft, 1), 'pillAddBoth: no horizontal shift of other rows' + tag, { before: r.before.tracked['commit 160'].textLeft, after: r.after.tracked['commit 160'].textLeft }]);
	}],
	['pillRemove', (r, tag) => {
		mainChecks.push([r.after.tracked['commit 150'].refs.length === 0, 'pillRemove: pills removed' + tag, r.after.tracked['commit 150'].refs]);
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'pillRemove: no vertical jump' + tag, null]);
		mainChecks.push([near(r.before.tracked['commit 160'].textLeft, r.after.tracked['commit 160'].textLeft, 1), 'pillRemove: other rows horizontally stable' + tag, null]);
	}],
	['pillOnHead', (r, tag) => {
		mainChecks.push([near(r.before.tracked['commit 150'].top, r.after.tracked['commit 150'].top), 'pillOnHead: a label change outside the viewport does not shift it' + tag, { before: r.before.tracked['commit 150'].top, after: r.after.tracked['commit 150'].top }]);
	}],
	/* 8i. clock-skewed repository (a parent ordered above its child): the layout must terminate
	 * and the page must stay responsive instead of freezing (regression: infinite layout loop) */
	['skewedDates', (r, tag) => {
		mainChecks.push([r.after.tracked['commit 150'] !== undefined && r.after.rows > 0, 'skewedDates: layout terminated, rows still rendered' + tag, r.after.rows]);
	}],
	/* 16-18. the uncommitted-changes row in the visible area (scrolled to the top): the row
	 * itself appears, updates its count and clears - while every commit row stays put */
	['scrollTop', (r, tag) => {
		mainChecks.push([r.after.scrollTop === 0 && r.after.tracked['commit 0'] !== undefined, 'scrollTop: back at the top, HEAD row visible' + tag, r.after.tracked['commit 0']]);
	}],
	['uncommittedAppear', (r, tag) => {
		mainChecks.push([r.after.uncommittedRow !== null && ((r.after.uncommittedRow || {}).text || '').indexOf('Uncommitted Changes') === 0, 'uncommittedAppear@top: uncommitted row rendered at top' + tag, r.after.uncommittedRow]);
		mainChecks.push([r.after.uncommittedRow !== null && ((r.after.uncommittedRow || {}).text || '').indexOf('(3)') >= 0, 'uncommittedAppear@top: count (3) shown' + tag, r.after.uncommittedRow]);
		mainChecks.push([r.after.tracked['commit 0'] !== undefined && r.after.tracked['commit 0'].top - r.before.tracked['commit 0'].top === 24, 'uncommittedAppear@top: row slides in above the first commit (content shifts down one row)' + tag, { before: r.before.tracked['commit 0'] && r.before.tracked['commit 0'].top, after: r.after.tracked['commit 0'] && r.after.tracked['commit 0'].top }]);
	}],
	['uncommittedCountChange', (r, tag) => {
		mainChecks.push([r.after.uncommittedRow !== null && ((r.after.uncommittedRow || {}).text || '').indexOf('(2)') >= 0, 'uncommittedCountChange@top: count text updated to (2)' + tag, r.after.uncommittedRow]);
		mainChecks.push([diffKeys(r.before.tracked['commit 0'], r.after.tracked['commit 0'], 1).length === 0, 'uncommittedCountChange@top: HEAD row fully stable' + tag, { before: r.before.tracked['commit 0'], after: r.after.tracked['commit 0'] }]);
	}],
	['uncommittedClear', (r, tag) => {
		mainChecks.push([r.after.uncommittedRow === null, 'uncommittedClear@top: uncommitted row removed' + tag, r.after.uncommittedRow]);
		mainChecks.push([r.before.tracked['commit 0'].top - r.after.tracked['commit 0'].top === 24, 'uncommittedClear@top: rows shift back up by one row' + tag, null]);
	}]
]);

/* stability across consecutive reads for the whole final state (flicker detection) */
const stability = await page.evaluate(async () => { const a = window.__measure(); await window.__settle(); return { a, b: window.__measure() }; });
check(JSON.stringify(stability.a) === JSON.stringify(stability.b), 'final state stable across consecutive reads (no flicker)', { a: stability.a.tracked, b: stability.b.tracked });
check(pageErrors.length === 0, 'no page errors during main session', pageErrors);
for (const [ok, label, detail] of mainChecks) check(ok, label, detail);

/* ---------------- the row far outside the rendered window: scrolled away, appears, scroll back ----------------
 * The Uncommitted Changes row is an ordinary row: while the user is deep in the history it is
 * simply not rendered (it sits far above the window), and its arrival moves nothing on screen.
 * Scrolling back to the top brings it into the window like any other row. */
await load('');
{
	await run('jump');
	const appear = await run('uncommittedAppear');
	check(appear.after.uncommittedRow === null && near(appear.before.tracked['commit 150'].top, appear.after.tracked['commit 150'].top),
		'offscreen row: arrives outside the rendered window and moves no visible row', { row: appear.after.uncommittedRow, top: [appear.before.tracked['commit 150'].top, appear.after.tracked['commit 150'].top] });
	const top = await run('scrollTop');
	check(top.after.uncommittedRow !== null && top.after.tracked['commit 0'] !== undefined,
		'offscreen row: scrolling back to the top reveals it above the first commit', { row: top.after.uncommittedRow, commit0: top.after.tracked['commit 0'] });
	const cleared = await run('uncommittedClear');
	check(cleared.after.uncommittedRow === null && cleared.after.tracked['commit 0'] !== undefined && cleared.after.tracked['commit 0'].top === top.after.tracked['commit 0'].top - 24,
		'offscreen row: clearing the tree while at the top removes it, rows shift back up', { row: cleared.after.uncommittedRow });
}

/* ---------------- config variants: graph width follows the graph settings ---------------- */
const variantWidths = {};
for (const variant of ['angular', 'aligned']) {
	await load('?cfg=' + variant);
	await run('jump');
	const m = JSON.parse(await page.evaluate(() => JSON.stringify(window.__measure())));
	variantWidths[variant] = m;
	check(m.tracked['commit 150'] !== undefined && m.graphWidth > 0, 'variant ' + variant + ': rows rendered, graph column present', m.graphWidth);
	const pitch = await page.evaluate(() => window.__rowPitch());
	check(pitch.every((p) => Math.abs(p - 24) <= 1), 'variant ' + variant + ': uniform row pitch', pitch);
	/* pills still render in each variant */
	await run('pillAddBoth');
	const after = JSON.parse(await page.evaluate(() => JSON.stringify(window.__measure())));
	check(after.tracked['commit 150'].refs.some((x) => x.name === 'feature-y'), 'variant ' + variant + ': branch pill rendered', after.tracked['commit 150'].refs);
}
/* the aligned-branch-labels setting must place the pill at a different x than the inline mode */
const defaultAligned = variantWidths.aligned.tracked['commit 150'];
console.log('graphWidth angular=' + variantWidths.angular.graphWidth + ' aligned=' + variantWidths.aligned.graphWidth);

/* after every scenario above (dozens of re-renders on the KEPT table skeleton), each header cell
 * must still carry exactly one pair of resize handles and the graph header exactly one 'right'
 * handle - the reconciling render keeps the header row, so an unguarded re-decoration in
 * makeTableResizable would stack one pair per render (regression: accumulated .resizeCol spans
 * and stacked mousedown/contextmenu listeners holding stale column-width closures) */
const handleCounts = await page.evaluate(() => Array.from(document.querySelectorAll('#tableColHeaders > th')).map((th) => th.querySelectorAll('.resizeCol').length));
check(handleCounts.length > 0 && handleCounts.every((n, i) => n === (i === 0 || i === handleCounts.length - 1 ? 1 : 2)), 'resize handles: exactly one pair per header cell after all re-renders', handleCounts);


console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
if (!keep) { await browser.close(); server.close(); }
process.exit(failures === 0 ? 0 : 1);

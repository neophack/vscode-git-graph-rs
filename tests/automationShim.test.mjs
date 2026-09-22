/**
 * Tests for the in-page automation shim (resources/automation/shim.js) in an isolated jsdom
 * window with a fake acquireVsCodeApi: step execution order, per-step results, error reporting,
 * and the context-menu helper.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shimSource = fs.readFileSync(path.join(rootDir, 'resources', 'automation', 'shim.js'), 'utf8');

function makeWindow(html) {
	const posted = [];
	const dom = new JSDOM(html, {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://example.invalid/',
		beforeParse: (w) => {
			// Real webviews allow one acquireVsCodeApi() call per page and throw on the second —
			// model that guard, or a shim that acquires its own instance passes these tests and
			// then stays silent forever inside VS Code.
			let acquired = false;
			w.acquireVsCodeApi = () => {
				if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
				acquired = true;
				return { getState: () => null, setState: () => { }, postMessage: (m) => posted.push(m) };
			};
		}
	});
	dom.window.eval(shimSource);
	return { window: dom.window, posted, dom };
}

/** Dispatch a step batch and wait for the shim's result message. */
async function runSteps(window, posted, steps) {
	window.dispatchEvent(new window.MessageEvent('message', { data: { __automation: { runId: 7, steps } } }));
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const result = posted.find((m) => m.__ggAutomationResult !== undefined && m.__ggAutomationResult.runId === 7);
		if (result !== undefined) return result.__ggAutomationResult;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('the shim never posted a result');
}

test('executes the step ops in order and reports per-step results', async () => {
	const { window, posted } = makeWindow(`<body>
		<button id="btn"></button>
		<input id="field" />
		<div id="label">hello world</div>
	</body>`);
	let clicks = 0, inputValue = null;
	const document = window.document;
	document.getElementById('btn').addEventListener('click', () => { clicks++; window.__clicks = clicks; });
	document.getElementById('field').addEventListener('input', (e) => { inputValue = e.target.value; });

	const result = await runSteps(window, posted, [
		{ op: 'click', selector: '#btn' },
		{ op: 'set', selector: '#field', value: 'typed', event: 'input' },
		{ op: 'expectText', selector: '#label', contains: 'world' },
		{ op: 'eval', expr: '({ sum: 1 + 2, clicked: window.__clicks })' },
		{ op: 'waitForGone', selector: '#never-existed' }
	]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(clicks, 1);
	assert.equal(inputValue, 'typed');
	assert.equal(result.results[2], 'hello world');
	assert.equal(result.results[3].sum, 3);
	assert.equal(result.results[3].clicked, 1);
});

test('a failing step reports its index and error', async () => {
	const { window, posted } = makeWindow('<body></body>');
	const result = await runSteps(window, posted, [
		{ op: 'waitFor', selector: '#missing', timeoutMs: 200 },
		{ op: 'click', selector: '#btn' }
	]);
	assert.equal(result.ok, false);
	assert.equal(result.failedStep, 0);
	assert.ok(result.error.indexOf('#missing') !== -1);
	assert.equal(result.results.length, 0);
});

test('contextmenu dispatches the event and clicks the matching menu item', async () => {
	const { window, posted } = makeWindow('<body><div id="row">row</div></body>');
	const document = window.document;
	let contextMenuSeen = false, itemClicked = false;
	document.getElementById('row').addEventListener('contextmenu', (e) => {
		contextMenuSeen = true;
		const menu = document.createElement('ul');
		menu.className = 'contextMenu';
		const item = document.createElement('li');
		item.className = 'contextMenuItem';
		item.textContent = 'Do It';
		item.addEventListener('click', () => { itemClicked = true; });
		menu.appendChild(item);
		document.body.appendChild(menu);
	});

	const result = await runSteps(window, posted, [
		{ op: 'contextmenu', selector: '#row', item: 'Do It' }
	]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.ok(contextMenuSeen);
	assert.ok(itemClicked);
});

test('an unknown menu item fails the step', async () => {
	const { window, posted } = makeWindow('<body><div id="row">row</div></body>');
	const document = window.document;
	document.getElementById('row').addEventListener('contextmenu', () => {
		const menu = document.createElement('ul');
		menu.className = 'contextMenu';
		const item = document.createElement('li');
		item.className = 'contextMenuItem';
		item.textContent = 'Something Else';
		menu.appendChild(item);
		document.body.appendChild(menu);
	});
	const result = await runSteps(window, posted, [{ op: 'contextmenu', selector: '#row', item: 'Do It' }]);
	assert.equal(result.ok, false);
	assert.ok(result.error.indexOf('Do It') !== -1);
});

test('a context menu lost to a concurrent re-render is retried', async () => {
	const { window, posted } = makeWindow('<body><div id="row">row</div></body>');
	const document = window.document;
	// The first right-click lands while the view is mid-refresh: the handler shows nothing (a
	// zero-item menu). The refresh settles, the next dispatch opens the menu and the item is
	// clicked — the report's menu-stash/branch-from-stash failure mode.
	let dispatches = 0, itemClicked = false;
	document.getElementById('row').addEventListener('contextmenu', () => {
		dispatches++;
		if (dispatches === 1) return;
		const menu = document.createElement('ul');
		menu.className = 'contextMenu';
		const item = document.createElement('li');
		item.className = 'contextMenuItem';
		item.textContent = 'Do It';
		item.addEventListener('click', () => { itemClicked = true; });
		menu.appendChild(item);
		document.body.appendChild(menu);
	});
	const result = await runSteps(window, posted, [{ op: 'contextmenu', selector: '#row', item: 'Do It' }]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.ok(dispatches >= 2);
	assert.ok(itemClicked);
});

test('a context menu that never opens fails after the retries', async () => {
	const { window, posted } = makeWindow('<body><div id="row">row</div></body>');
	const document = window.document;
	let dispatches = 0;
	document.getElementById('row').addEventListener('contextmenu', () => { dispatches++; });
	const result = await runSteps(window, posted, [{ op: 'contextmenu', selector: '#row', item: 'Do It' }]);
	assert.equal(result.ok, false);
	assert.ok(result.error.indexOf('0 items shown') !== -1);
	assert.equal(dispatches, 5); // the initial attempt plus four retries
});

test('contextmenu accepts one candidate per interface language', async () => {
	const { window, posted } = makeWindow('<body><div id="row">row</div><div id="label">第 1 个，共 5 个</div></body>');
	const document = window.document;
	let clicked = null;
	document.getElementById('row').addEventListener('contextmenu', () => {
		const menu = document.createElement('ul');
		menu.className = 'contextMenu';
		for (const text of ['检出分支', 'Something Else']) {
			const item = document.createElement('li');
			item.className = 'contextMenuItem';
			item.textContent = text;
			item.addEventListener('click', () => { clicked = text; });
			menu.appendChild(item);
		}
		document.body.appendChild(menu);
	});

	// The zh-CN item is the one rendered; the English candidate must not shadow it.
	const result = await runSteps(window, posted, [
		{ op: 'contextmenu', selector: '#row', item: ['Checkout Branch', '检出分支'] },
		{ op: 'expectText', selector: '#label', contains: [' of ', '，共'] }
	]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(clicked, '检出分支');
	assert.equal(result.results[1], '第 1 个，共 5 个');
});

test('expectText with candidates fails only when none of them is present', async () => {
	const okWindow = makeWindow('<body><div id="label">1 of 5</div></body>');
	const ok = await runSteps(okWindow.window, okWindow.posted, [{ op: 'expectText', selector: '#label', contains: [' of ', '，共'] }]);
	assert.equal(ok.ok, true);
	// A separate window: runSteps polls for runId 7, so a second batch in the same page would
	// observe the first batch's stale result.
	const badWindow = makeWindow('<body><div id="label">1 of 5</div></body>');
	const bad = await runSteps(badWindow.window, badWindow.posted, [{ op: 'expectText', selector: '#label', contains: ['zzz', '，共'] }]);
	assert.equal(bad.ok, false);
	assert.ok(bad.error.indexOf('zzz') !== -1);
});

test('skipIfAbsent ends the batch as skipped when the element never appears', async () => {
	const { window, posted } = makeWindow('<body><button id="btn"></button></body>');
	const document = window.document;
	let clicks = 0;
	document.getElementById('btn').addEventListener('click', () => { clicks++; });

	const result = await runSteps(window, posted, [
		{ op: 'click', selector: '#btn' },
		{ op: 'skipIfAbsent', selector: '#missing', timeoutMs: 150 },
		{ op: 'click', selector: '#btn' } // must not run after the skip
	]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.skipped, true);
	assert.ok((result.skipReason ?? '').includes('#missing'), JSON.stringify(result));
	assert.equal(clicks, 1, 'the steps after a skip must not run');
});

test('skipIfAbsent continues the batch when the element appears', async () => {
	const { window, posted } = makeWindow('<body><button id="btn"></button><div id="target"></div></body>');
	const document = window.document;
	let clicks = 0;
	document.getElementById('btn').addEventListener('click', () => { clicks++; });

	const result = await runSteps(window, posted, [
		{ op: 'skipIfAbsent', selector: '#target', timeoutMs: 2000 },
		{ op: 'click', selector: '#btn' }
	]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.skipped, undefined);
	assert.equal(clicks, 1);
});

test('the shim installs its marker and ignores non-automation messages', async () => {
	const { window, posted } = makeWindow('<body></body>');
	assert.equal(window.__ggAutomation.ready, true);
	window.dispatchEvent(new window.MessageEvent('message', { data: { command: 'refresh' } }));
	window.dispatchEvent(new window.MessageEvent('message', { data: null }));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(posted.length, 0);
});

test('posts through the bundle\'s shared API instance instead of acquiring a second one', async () => {
	const { window, posted } = makeWindow('<body><button id="btn"></button></body>');
	// Model the booted bundle (web/utils.ts): it consumed the only acquireVsCodeApi() call and
	// published the instance — the exact state of a real webview when a step batch arrives. A
	// shim that tries to acquire its own instance here throws inside its result callback, the
	// host never hears from it again, and every UI-mode run times out.
	const bundleApi = window.acquireVsCodeApi();
	window.__ggVscodeApi = bundleApi;
	assert.throws(() => window.acquireVsCodeApi(), /already been acquired/);

	const result = await runSteps(window, posted, [{ op: 'click', selector: '#btn' }]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.results.length, 1);
});

test('publishes its own instance under the shared handle when it acquires first', async () => {
	const { window, posted } = makeWindow('<body></body>');
	// No bundle has run yet: the shim's first post acquires the API and publishes it, so a
	// bundle booted afterwards can reuse the handle instead of hitting the once-only guard.
	const result = await runSteps(window, posted, [{ op: 'eval', expr: '1 + 1' }]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.ok(window.__ggVscodeApi !== undefined);
	assert.throws(() => window.acquireVsCodeApi(), /already been acquired/); // it really acquired
	window.__ggVscodeApi.postMessage({ probe: true });
	assert.deepEqual(posted[posted.length - 1], { probe: true }); // ...and the handle is live
});

/* ---------- the assertion ops (expectSize / expectCount / expectChecked) ---------- */

/** A window whose getBoundingClientRect reports a laid-out box for the elements that matter. */
function makeLayoutWindow(html, boxes) {
	const made = makeWindow(html);
	const original = made.window.Element.prototype.getBoundingClientRect;
	made.window.document.body.getBoundingClientRect = () => ({ width: 1200, height: 800 }); // the layout-engine probe
	made.window.Element.prototype.getBoundingClientRect = function () {
		const id = this.id !== '' ? this.id : null;
		if (id !== null && Object.prototype.hasOwnProperty.call(boxes, id)) return boxes[id];
		return original.call(this);
	};
	return made;
}

test('expectSize asserts the rendered box within its bounds and reports the measurement', async () => {
	const { window, posted } = makeLayoutWindow('<body><button id="ctl"></button></body>', { ctl: { width: 24, height: 24 } });
	const ok = await runSteps(window, posted, [{ op: 'expectSize', selector: '#ctl', minW: 20, maxW: 30, minH: 20, maxH: 30 }]);
	assert.equal(ok.ok, true, JSON.stringify(ok));
	assert.equal(ok.results[0], '24.0x24.0');

	const small = makeLayoutWindow('<body><button id="ctl"></button></body>', { ctl: { width: 3, height: 24 } });
	const failW = await runSteps(small.window, small.posted, [{ op: 'expectSize', selector: '#ctl', minW: 20 }]);
	assert.equal(failW.ok, false);
	assert.ok(failW.error.indexOf('3.0px wide') !== -1 && failW.error.indexOf('>= 20px') !== -1, failW.error);

	const huge = makeLayoutWindow('<body><button id="ctl"></button></body>', { ctl: { width: 24, height: 900 } });
	const failH = await runSteps(huge.window, huge.posted, [{ op: 'expectSize', selector: '#ctl', maxH: 40 }]);
	assert.equal(failH.ok, false);
	assert.ok(failH.error.indexOf('900.0px tall') !== -1, failH.error);
});

test('expectSize bounds width in vw of the webview layout width (the window-size-independent currency)', async () => {
	// The layout stub measures the webview at 1200px, so 240px is 20vw, 400px is 33.3vw and
	// 100px is 8.3vw. These bounds are for elements the stylesheet sizes in vw units: absolute
	// px bounds on them would break as the user resizes the window.
	const mid = makeLayoutWindow('<body><button id="ctl"></button></body>', { ctl: { width: 240, height: 24 } });
	const ok = await runSteps(mid.window, mid.posted, [{ op: 'expectSize', selector: '#ctl', minWVw: 15, maxWVw: 25 }]);
	assert.equal(ok.ok, true, JSON.stringify(ok));

	const wide = makeLayoutWindow('<body><button id="ctl"></button></body>', { ctl: { width: 400, height: 24 } });
	const failMax = await runSteps(wide.window, wide.posted, [{ op: 'expectSize', selector: '#ctl', maxWVw: 25 }]);
	assert.equal(failMax.ok, false);
	assert.ok(failMax.error.indexOf('33.3vw') !== -1 && failMax.error.indexOf('<= 25vw') !== -1, failMax.error);

	const narrow = makeLayoutWindow('<body><button id="ctl"></button></body>', { ctl: { width: 100, height: 24 } });
	const failMin = await runSteps(narrow.window, narrow.posted, [{ op: 'expectSize', selector: '#ctl', minWVw: 15 }]);
	assert.equal(failMin.ok, false);
	assert.ok(failMin.error.indexOf('8.3vw') !== -1 && failMin.error.indexOf('>= 15vw') !== -1, failMin.error);
});

test('expectSize resolves as unassertable where no layout engine exists (jsdom)', async () => {
	// The Node harness renders the real DOM with no layout: every box is 0x0. Size assertions
	// must SKIP (not fail) there — the real editor has a layout engine and asserts for real.
	const { window, posted } = makeWindow('<body><button id="ctl"></button></body>');
	const result = await runSteps(window, posted, [{ op: 'expectSize', selector: '#ctl', minW: 20, maxW: 30 }]);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.results[0], 'sizes unassertable (no layout engine)');
});

test('expectSize fails a genuinely unrendered element where a layout engine exists', async () => {
	const { window, posted } = makeLayoutWindow('<body><button id="ctl"></button></body>', { ctl: { width: 0, height: 0 } });
	const result = await runSteps(window, posted, [{ op: 'expectSize', selector: '#ctl', minW: 20 }]);
	assert.equal(result.ok, false);
	assert.ok(result.error.indexOf('0x0') !== -1, result.error);
});

test('expectCount asserts how many elements the selector matches', async () => {
	const make = () => makeWindow('<body><div class="row"></div><div class="row"></div><div class="row"></div></body>');
	const okBounds = await runSteps2(make(), [{ op: 'expectCount', selector: '.row', min: 2, max: 4 }]);
	assert.equal(okBounds.ok, true, JSON.stringify(okBounds));
	assert.equal(okBounds.results[0], 3);

	const tooFew = await runSteps2(make(), [{ op: 'expectCount', selector: '.row', min: 5 }]);
	assert.equal(tooFew.ok, false);
	assert.ok(tooFew.error.indexOf('expected at least 5') !== -1, tooFew.error);

	const tooMany = await runSteps2(make(), [{ op: 'expectCount', selector: '.row', max: 2 }]);
	assert.equal(tooMany.ok, false);
	assert.ok(tooMany.error.indexOf('expected 1-2') !== -1, tooMany.error); // the default min is 1

	const zeroAllowed = await runSteps2(make(), [{ op: 'expectCount', selector: '.absent', min: 0, max: 0 }]);
	assert.equal(zeroAllowed.ok, true, JSON.stringify(zeroAllowed));
});

/** runSteps for a freshly made window (unpacking the {window, posted} pair). */
async function runSteps2(made, steps) {
	return runSteps(made.window, made.posted, steps);
}

test('expectChecked asserts a checkbox\'s rendered state', async () => {
	const make = () => makeWindow('<body><input type="checkbox" id="cb" checked></body>');
	const on = await runSteps2(make(), [{ op: 'expectChecked', selector: '#cb', checked: true }]);
	assert.equal(on.ok, true, JSON.stringify(on));
	const wrongOn = await runSteps2(make(), [{ op: 'expectChecked', selector: '#cb', checked: false }]);
	assert.equal(wrongOn.ok, false);
	assert.ok(wrongOn.error.indexOf('checked') !== -1, wrongOn.error);
	const off = await runSteps2(makeWindow('<body><input type="checkbox" id="cb"></body>'), [{ op: 'expectChecked', selector: '#cb', checked: false }]);
	assert.equal(off.ok, true, JSON.stringify(off));
});

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
			w.acquireVsCodeApi = () => ({ getState: () => null, setState: () => { }, postMessage: (m) => posted.push(m) });
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

test('the shim installs its marker and ignores non-automation messages', async () => {
	const { window, posted } = makeWindow('<body></body>');
	assert.equal(window.__ggAutomation.ready, true);
	window.dispatchEvent(new window.MessageEvent('message', { data: { command: 'refresh' } }));
	window.dispatchEvent(new window.MessageEvent('message', { data: null }));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(posted.length, 0);
});

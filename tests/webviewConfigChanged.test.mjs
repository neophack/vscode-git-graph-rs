/**
 * Live application of Extension Settings (the `configChanged` message): the host no longer
 * regenerates the webview's HTML when a setting changes (a full page reload that flashed the
 * view and dropped the open Commit Details View) - it sends the new configuration and the view
 * applies it in place, keeping the rendered commits, the scroll position and the open CDV.
 *
 * These tests boot the full webview (see webviewHarness.mjs), dispatch `configChanged` with a
 * modified configuration, and assert on what moved and what did not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

/** The view's configuration as the harness embedded it, deep-cloned for modification. */
function clonedConfig(h) {
	return JSON.parse(JSON.stringify(h.window.initialState.config));
}

/** Record the requests the view sends from now on (without breaking the harness's pump). */
function spyOnRequests(h) {
	const requests = [];
	const originalPostMessage = h.window.VSCODE_API.postMessage;
	h.window.VSCODE_API.postMessage = (message) => {
		requests.push(message);
		originalPostMessage(message);
	};
	return requests;
}

describe('a configChanged message applies the settings live', () => {
	it('re-applies the derived DOM state without disturbing the rendered commits', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);
		const rowsBefore = h.rows();
		const scrollTopBefore = h.viewElem.scrollTop;
		const fetchTitleBefore = h.document.getElementById('fetchBtn').title;

		const config = clonedConfig(h);
		config.referenceLabels.branchLabelsAlignedToGraph = true;
		config.graph.fontSize = 13;
		config.graph.colours[0] = '#123456';
		config.stickyHeader = true;
		config.fetchAndPrune = true;

		const requests = spyOnRequests(h);
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();

		// What the generated HTML would have baked in is applied to the running page
		assert.ok(h.document.body.classList.contains('branchLabelsAlignedToGraph'), 'the branch-labels body class was applied');
		assert.equal(h.document.body.style.getPropertyValue('--git-graph-fontSize'), '13px', 'the font size variable was applied');
		assert.equal(h.document.body.style.getPropertyValue('--git-graph-color0'), '#123456', 'the graph colour variable was applied');
		assert.ok(h.document.getElementById('headerRow').classList.contains('sticky'), 'the sticky header class was applied');
		assert.notEqual(h.document.getElementById('fetchBtn').title, fetchTitleBefore, 'the fetch button reflects fetchAndPrune');

		// The commits were reloaded under the new settings - by a SOFT refresh (no skeleton flash)
		const loadCommitsRequests = requests.filter((message) => message.command === 'loadCommits');
		assert.ok(loadCommitsRequests.length > 0, 'a commits reload was requested');
		assert.ok(loadCommitsRequests.every((message) => message.hard === false), 'the reload is soft');

		// The rendered rows kept their DOM nodes and the viewport its position
		const rowsAfter = h.rows();
		assert.deepEqual(rowsAfter.map((row) => row.textContent), rowsBefore.map((row) => row.textContent), 'same rows rendered');
		rowsAfter.forEach((row, i) => {
			assert.strictEqual(row, rowsBefore[i], 'row ' + i + ' kept its DOM node');
		});
		assert.equal(h.viewElem.scrollTop, scrollTopBefore, 'the scroll position is unchanged');
	});

	it('keeps the open Commit Details View', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);
		const row = h.rows().find((r) => r.dataset.id === '155');
		row.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		await h.pump(); // the click sends a 'commitDetails' request, answered like every other
		const cdvBefore = h.document.getElementById('cdv');
		assert.ok(cdvBefore !== null, 'the Commit Details View is open');

		const config = clonedConfig(h);
		config.graph.fontSize = 12;
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();

		const cdvAfter = h.document.getElementById('cdv');
		assert.ok(cdvAfter !== null, 'the Commit Details View is still open');
		assert.strictEqual(cdvAfter, cdvBefore, 'the Commit Details View element was not rebuilt');
	});
});

/**
 * The Repository Tools wiring still needing the full compiled webview (see webviewHarness.mjs):
 * the Settings Widget's Repository column entries and the handoff that closes the Settings
 * Widget when a tool overlay opens, plus the toolbar skeleton the extension host renders.
 *
 * The rest of the former file drained into colocated component tests (REFACTOR-PLAN Appendix B):
 * the overlay lifecycles (open / request / close-clears-content) and the heatmap and worktree
 * badge tooltips live in src/webview/graph/widgets/{reflogView,statisticsView,worktreeDialog}.test.ts,
 * and the Statistics toolbar button's click wiring lives in
 * src/webview/graph/widgets/statisticsView.test.ts (ControlBar.initToolbar).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

function click(h, elem) {
	elem.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
}

describe('the Repository Tools entries in the Settings Widget', () => {
	it('renders them as section buttons in the Repository column', async () => {
		const h = await bootView(5);
		click(h, h.document.getElementById('settingsBtn'));
		assert.ok(h.document.getElementById('settingsWidget').classList.contains('active'));

		for (const id of ['openReflogView', 'openWorktreeDialog']) {
			const btn = h.document.getElementById(id);
			assert.ok(btn !== null, id + ' exists');
			assert.match(btn.className, /(^| )toolBtn( |$)/, id + ' is styled like the other section buttons');
			assert.equal(btn.parentElement.className, 'settingsSectionButtons');
		}
	});

	it('opens the tool overlay and closes the Settings Widget instead of stacking both', async () => {
		const h = await bootView(5);
		click(h, h.document.getElementById('settingsBtn'));
		click(h, h.document.getElementById('openReflogView'));

		assert.ok(!h.document.getElementById('settingsWidget').classList.contains('active'), 'the Settings Widget closed');
		assert.ok(h.document.getElementById('reflogWidget').classList.contains('active'), 'the Reflog overlay opened');

		// The same handoff applies to the other tool
		click(h, h.document.getElementById('reflogClose'));
		click(h, h.document.getElementById('settingsBtn'));
		click(h, h.document.getElementById('openWorktreeDialog'));
		assert.ok(!h.document.getElementById('settingsWidget').classList.contains('active'));
		assert.ok(h.document.getElementById('worktreeWidget').classList.contains('active'));
		click(h, h.document.getElementById('worktreeClose'));
	});

	it('leaves no toolbar buttons behind for the Settings Widget entries (Statistics excepted)', async () => {
		const h = await bootView(5);
		for (const id of ['reflogBtn', 'worktreeBtn']) {
			assert.equal(h.document.getElementById(id), null, id + ' was removed from the toolbar');
		}
	});

	it('renders the Statistics button in the toolbar, between the filter and terminal buttons', async () => {
		const h = await bootView(5);
		const btn = h.document.getElementById('statisticsBtn');
		assert.ok(btn !== null, 'statisticsBtn exists');
		assert.equal(btn.previousElementSibling && btn.previousElementSibling.id, 'filterBtn', 'it follows the filter button');
		assert.equal(btn.nextElementSibling && btn.nextElementSibling.id, 'terminalBtn', 'it precedes the terminal button');
		assert.ok(btn.querySelector('svg') !== null, 'it renders the statistics icon');
	});
});

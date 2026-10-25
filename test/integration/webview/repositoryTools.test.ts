/**
 * The Repository Tools wiring still needing the full compiled webview (see
 * test/support/webviewHost.ts): the Settings Widget's Repository column entries and the handoff
 * that closes the Settings Widget when a tool overlay opens, plus the toolbar skeleton the
 * extension host renders.
 *
 * Ported from tests/webviewTools.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged.
 *
 * The rest of the former file drained into colocated component tests (REFACTOR-PLAN Appendix B):
 * the overlay lifecycles (open / request / close-clears-content) and the heatmap and worktree
 * badge tooltips live in src/webview/graph/widgets/{reflogView,statisticsView,worktreeDialog}.test.ts,
 * and the Statistics toolbar button's click wiring lives in
 * src/webview/graph/widgets/statisticsView.test.ts (ControlBar.initToolbar).
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { bootView } from '../../support/webviewHost';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Booted = Awaited<ReturnType<typeof bootView>>;

function click(h: Booted, elem: Element | null) {
	elem!.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
}

/** The settings widget mounts on demand (an async chunk import): wait for it to appear and
 * activate instead of querying synchronously after the click. */
async function waitForSettingsWidget(h: Booted) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const widget = h.document.getElementById('settingsWidget');
		if (widget !== null && widget.classList.contains('active')) return widget;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('the settings widget never opened');
}

/** The tool overlays mount on demand too: wait until the overlay with this id is active. */
async function waitForOverlay(h: Booted, id: string) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const overlay = h.document.getElementById(id);
		if (overlay !== null && overlay.classList.contains('active')) return overlay;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('the ' + id + ' overlay never opened');
}

describe('the Repository Tools entries in the Settings Widget', () => {
	it('renders them as section buttons in the Repository column', async () => {
		const h = await bootView(5);
		click(h, h.document.getElementById('settingsBtn'));
		await waitForSettingsWidget(h);

		for (const id of ['openReflogView', 'openWorktreeDialog']) {
			const btn = h.document.getElementById(id)!;
			assert.ok(btn !== null, id + ' exists');
			assert.match(btn.className, /(^| )toolBtn( |$)/, id + ' is styled like the other section buttons');
			assert.equal(btn.parentElement!.className, 'settingsSectionButtons');
		}
	});

	it('opens the tool overlay and closes the Settings Widget instead of stacking both', async () => {
		const h = await bootView(5);
		click(h, h.document.getElementById('settingsBtn'));
		await waitForSettingsWidget(h);
		click(h, h.document.getElementById('openReflogView'));

		assert.ok(!h.document.getElementById('settingsWidget')!.classList.contains('active'), 'the Settings Widget closed');
		await waitForOverlay(h, 'reflogWidget');

		// The same handoff applies to the other tool
		click(h, h.document.getElementById('reflogClose'));
		click(h, h.document.getElementById('settingsBtn'));
		await waitForSettingsWidget(h);
		click(h, h.document.getElementById('openWorktreeDialog'));
		assert.ok(!h.document.getElementById('settingsWidget')!.classList.contains('active'));
		await waitForOverlay(h, 'worktreeWidget');
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
		const btn = h.document.getElementById('statisticsBtn')!;
		assert.ok(btn !== null, 'statisticsBtn exists');
		assert.equal(btn.previousElementSibling && (btn.previousElementSibling as HTMLElement).id, 'filterBtn', 'it follows the filter button');
		assert.equal(btn.nextElementSibling && (btn.nextElementSibling as HTMLElement).id, 'terminalBtn', 'it precedes the terminal button');
		assert.ok(btn.querySelector('svg') !== null, 'it renders the statistics icon');
	});
});

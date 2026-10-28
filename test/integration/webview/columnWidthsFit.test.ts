/**
 * The frozen column widths' fit fallback (src/webview/graph/render/columns.ts): a repository
 * whose columns were dragged wide on a large monitor must not clip when the same repository is
 * viewed on a narrower window - #view clips overflow instead of scrolling it, so the right-most
 * frozen columns would simply disappear. Once the widths no longer fit, the table renders the
 * automatic layout (whose Date/Author widths shrink with the window), and returns to the frozen
 * layout when the window is wide enough again - without a re-render in between, because the
 * resize observer asks fixedLayoutFitChanged() when the layout itself did not change.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { bootView, REPO } from '../../support/webviewHost';
import { DEFAULT_REPO_STATE } from '../../../src/extension/platform/storage';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

/** Graph + Date + Author + Commit as dragged on a wide monitor: ~1060px with padding, > a 1000px view. */
const FROZEN_WIDTHS = [480, 200, 160, 120];

type Booted = Awaited<ReturnType<typeof bootView>>;

function tableClass(h: Booted) {
	return h.document.getElementById('commitTable')!.className;
}

function setViewWidth(h: Booted, width: number) {
	Object.defineProperty(h.viewElem, 'clientWidth', { get: () => width, configurable: true });
	h.window.dispatchEvent(new h.window.Event('resize'));
}

describe('frozen column widths against a narrower window', () => {
	it('renders the automatic layout while the frozen widths do not fit, and freezes them again when they do', async () => {
		const h = await bootView(30, { repos: { [REPO]: Object.assign({}, DEFAULT_REPO_STATE, { columnWidths: FROZEN_WIDTHS }) } });
		await h.pump();
		// The stubbed view is 1200px wide: the frozen columns (~1060px) fit
		assert.match(tableClass(h), /(^| )fixedLayout( |$)/, 'a wide window renders the frozen widths');

		// Still the wide layout (the layout breakpoints sit at 600/900), but the frozen columns no
		// longer fit: the table falls back to the automatic layout
		setViewWidth(h, 1000);
		await h.pump();
		assert.match(tableClass(h), /(^| )autoLayout( |$)/, 'a window narrower than the widths falls back to automatic');

		// Widening past the widths freezes them right back - the repository's saved widths survive
		setViewWidth(h, 1200);
		await h.pump();
		assert.match(tableClass(h), /(^| )fixedLayout( |$)/, 'a wide enough window freezes them again');
	});

	it('keeps the automatic layout of a repository whose widths were never frozen', async () => {
		const h = await bootView(10);
		await h.pump();
		assert.match(tableClass(h), /(^| )autoLayout( |$)/);
		setViewWidth(h, 700);
		await h.pump();
		// 700px is the tablet layout (below the 900px breakpoint): two columns, still automatic
		assert.match(tableClass(h), /(^| )autoLayout( |$)/);
	});
});

/**
 * The windowed render's fast-scroll behaviour: the two reported scrolling defects of the Git
 * Graph view.
 *
 * Ported from tests/webviewScrollWindow.test.mjs (REFACTOR-PLAN task 7.1); assertions are
 * unchanged.
 *
 * 1. "Scrolling shows content that has not loaded" - a scroll jump that carries the viewport past
 *    the rendered window leaves the newly exposed region empty until the next animation frame
 *    re-renders it (and the browser paints whatever the DOM holds at the moment the exposure
 *    happens). The scroll listener must therefore re-render SYNCHRONOUSLY when a jump lands
 *    outside the rendered rows, and the window must extend in the direction of travel (the
 *    velocity lead) so a fling's per-frame exposures stay covered.
 *
 * 2. "Scrolled to the middle, the view suddenly returns to the very front" - an update that
 *    clears the table while the commit query stays the same (the refresh button, the "Show Remote
 *    Branches" toggle, a transient load error) collapses the scroll height; the browser clamps
 *    scrollTop to 0 and the anchor the eventual re-render captures live then reads "at the very
 *    top", pinning the reloaded view there. The pre-collapse anchor must be remembered and
 *    re-applied when the same commits render again.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { ROW_HEIGHT, VIEWPORT_HEIGHT, bootView } from '../../support/webviewHost';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Booted = Awaited<ReturnType<typeof bootView>>;

/** The first/last rendered commit index (data-id of the rendered tr.commit rows). */
function renderedExtent(h: Booted) {
	const ids = h.rows().map((row) => parseInt(row.dataset.id!, 10));
	return { first: Math.min(...ids), last: Math.max(...ids) };
}

/** Set the scroll position and dispatch the scroll event, WITHOUT waiting for any rAF/timer. */
function jumpSync(h: Booted, scrollTop: number) {
	h.viewElem.scrollTop = scrollTop;
	h.viewElem.dispatchEvent(new h.window.Event('scroll'));
}

describe('fast scrolling keeps the newly exposed rows rendered (windowed rendering)', () => {
	it('a jump beyond the fixed buffer re-renders the window synchronously, inside the scroll event', async () => {
		const h = await bootView(300);
		// settle at a known position first
		await h.scrollTo(50);

		// One 150-row jump. Synchronously after the dispatch - before any animation frame - the
		// rows of the jumped-to position must already be in the DOM.
		jumpSync(h, 200 * ROW_HEIGHT);
		const extent = renderedExtent(h);
		const firstVisible = 200, lastVisible = 200 + Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT);
		assert.ok(extent.first <= firstVisible, 'the first visible row is rendered synchronously (extent ' + extent.first + '..' + extent.last + ')');
		assert.ok(extent.last >= lastVisible, 'the last visible row is rendered synchronously (extent ' + extent.first + '..' + extent.last + ')');
	});

	it('the rendered window extends in the direction of travel while a fling is under way', async () => {
		const h = await bootView(500);
		await h.scrollTo(20);

		// A downward fling: successive scroll events, each a few rows further down, with real time
		// between them so the velocity tracker sees motion (events <8ms apart fold together).
		for (let i = 0; i < 8; i++) {
			jumpSync(h, (25 + i * 9) * ROW_HEIGHT);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const scrollTop = h.viewElem.scrollTop;
		const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
		const lastVisible = Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT);
		const extent = renderedExtent(h);
		// The static buffer alone would end the window at ~lastVisible + 10; the velocity lead
		// must extend meaningfully beyond it in the direction of travel (downwards)
		assert.ok(extent.last > lastVisible + 12, 'the window leads the fling downwards (window ends at ' + extent.last + ', viewport ends at ' + lastVisible + ')');
		assert.ok(extent.first <= firstVisible, 'the viewport top stays covered (window starts at ' + extent.first + ', viewport starts at ' + firstVisible + ')');

		// After the fling rests, the window re-tightens (the lead decays away and the one-shot
		// re-tighten timer fires)
		await new Promise((resolve) => setTimeout(resolve, 600));
		await h.scrollTo(firstVisible); // a slow repositioning scroll (one event, far from the last)
		const settled = renderedExtent(h);
		assert.ok(settled.last <= lastVisible + 14, 'an idle view keeps the tight window (window ends at ' + settled.last + ', viewport ends at ' + lastVisible + ')');
	});
});

describe('a table-collapsing update restores the reading position once the same commits render again', () => {
	/** Click the refresh button (the hard refresh that clears the table), emulating the browser's
	 * scroll clamp to 0 the collapse causes, then serve the reload. */
	async function hardRefreshWithCollapse(h: Booted) {
		h.document.getElementById('refreshBtn')!.click();
		// The real browser clamps scrollTop when the table empties; the harness's scrollTop is a
		// plain stored value, so emulate the clamp the collapse causes
		jumpSync(h, 0);
		await h.pump();
		await new Promise((resolve) => setTimeout(resolve, 80));
	}

	it('the refresh button returns the view to the commit the user was reading', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);
		assert.equal(h.viewElem.scrollTop, 150 * ROW_HEIGHT);

		await hardRefreshWithCollapse(h);
		assert.ok(Math.abs(h.viewElem.scrollTop - 150 * ROW_HEIGHT) <= ROW_HEIGHT,
			'the scroll position is restored around row 150 (got ' + h.viewElem.scrollTop + ')');
		// The top of the viewport shows the same commit as before the refresh
		const extent = renderedExtent(h);
		assert.ok(extent.first <= 150 && extent.last >= 150, 'row 150 is rendered again (extent ' + extent.first + '..' + extent.last + ')');
	});

	it('a load error followed by the retry restores the reading position', async () => {
		const h = await bootView(300);
		await h.scrollTo(150);

		// Answer the next loadCommits with an error (a transient git failure), then a successful
		// retry - the dialog's Retry button runs refresh(true), the same path the refresh button
		// takes. The error response needs the refresh id the outgoing request carried.
		const sent: any[] = [];
		const origPost = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => {
			if (message.command === 'loadCommits') {
				sent.push(message);
				h.dispatch({ command: 'loadCommits', refreshId: message.refreshId, commits: [], head: null, tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, error: 'index.lock: Cannot lock ref' });
				return;
			}
			origPost(message);
		};
		h.dispatch({ command: 'refresh' });
		await h.pump(); // serve the loadRepoInfo request; the loadCommits error answers inline
		await new Promise((resolve) => setTimeout(resolve, 120));
		h.window.VSCODE_API.postMessage = origPost;

		// The error cleared the table (the collapse clamped the scroll); the retry reloads
		const retryBtn = h.document.getElementById('dialogAction');
		assert.ok(retryBtn !== null, 'the error dialog offers its retry action');
		retryBtn!.click();
		jumpSync(h, 0);
		await h.pump();
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.ok(Math.abs(h.viewElem.scrollTop - 150 * ROW_HEIGHT) <= ROW_HEIGHT,
			'the retry restores the reading position (got ' + h.viewElem.scrollTop + ')');
	});

	it('a pending anchor never leaks into a different repository the user switches to', async () => {
		const h = await bootView(300, { repos: { 'C:\\repo': null, 'C:\\other': null } });
		await h.scrollTo(150);

		// Leave a pending anchor behind: a load error captures one (see displayLoadDataError)
		const origPost = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => {
			if (message.command === 'loadCommits') {
				h.dispatch({ command: 'loadCommits', refreshId: message.refreshId, commits: [], head: null, tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: false, gerritStates: null, error: 'index.lock: Cannot lock ref' });
				return;
			}
			origPost(message);
		};
		h.dispatch({ command: 'refresh' });
		await h.pump(); // serve the loadRepoInfo request; the loadCommits error answers inline
		await new Promise((resolve) => setTimeout(resolve, 120));
		h.window.VSCODE_API.postMessage = origPost;

		// Instead of retrying, the user switches to the other repository: an unrelated history -
		// whatever position it renders at, the stale anchor must not yank it back to row 150
		h.document.querySelector('#repoDropdown .dropdownBtn')?.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const options = Array.from(h.document.querySelectorAll('#repoDropdown .dropdownOption')) as HTMLElement[];
		const other = options.find((option) => option.textContent!.includes('other'));
		assert.ok(other !== undefined, 'the repo dropdown lists the other repository');
		other!.dispatchEvent(new h.window.MouseEvent('mousedown', { bubbles: true }));
		other!.dispatchEvent(new h.window.MouseEvent('mouseup', { bubbles: true }));
		other!.click();
		// The real browser clamps the scroll when the switched-to repository's table collapses or
		// renders shorter; emulate that clamp the same way the collapse tests do
		jumpSync(h, 0);
		await h.pump();
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.equal(h.viewElem.scrollTop, 0, 'the new repository starts at the top, not at the old repository\'s reading position');
	});
});

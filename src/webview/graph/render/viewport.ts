/**
 * The viewport of the commit table: which rows are rendered (windowed / "virtualized" rendering),
 * where the user is reading (viewport anchors), and scrolling to commits.
 *
 * Windowed rendering: when the loaded commit list is large, only the rows in and near the
 * viewport are rendered, with spacer rows above and below preserving the scroll height and the
 * graph alignment. `renderedRange` is NULL when all rows are rendered (small lists, or any state
 * with variable row heights: an open inline Commit Details View, an active find query).
 */

import { GraphContext } from '../context';
import { ViewportAnchor } from '../state/types';

const VIRTUAL_ROW_BUFFER = 10;
/** The velocity lead's cap, in rows (~2 viewports at the default row height). */
const VIRTUAL_ROW_MAX_LEAD = 50;
/** The scroll speed (px/ms) at which the velocity lead saturates: 4 px/ms = 4000 px/s. */
const VIRTUAL_LEAD_FULL_SPEED = 4;
/** How long (ms) after the last scroll event the lead keeps decaying before it is gone. */
const VIRTUAL_LEAD_DECAY_MS = 250;

export class Viewport {
	/** The rows currently rendered, or NULL when all of them are. */
	public renderedRange: { start: number, end: number } | null = null;
	/**
	 * The viewport anchor captured just BEFORE a table-collapsing update (a hard refresh, an error
	 * clearing the view) clears the rendered rows. Collapsing the table collapses the scroll height
	 * with it, the browser clamps scrollTop to 0, and the anchor the next loadCommits would capture
	 * live is then "at the very top" - pinning the view there even though the same commit list
	 * reloads. This pre-collapse anchor is preferred over the live capture when the data renders
	 * again; its hash lookup drops it naturally when the commits genuinely changed (a repository or
	 * branch switch), which is exactly when a reset to the top is wanted. NULL => nothing pending.
	 */
	public pendingViewportAnchor: ViewportAnchor | null = null;
	/**
	 * The scroll position saved before a webview reload, to be re-applied after the repository's
	 * commits have been rendered (the view is still empty when the state is restored, so applying
	 * it immediately would be clamped to 0). NULL => no scroll position is pending restoration.
	 */
	public restoreScrollTop: number | null = null;

	/**
	 * The scroll motion tracker behind the windowed render's velocity lead: the last scroll
	 * position/time pair and an exponentially smoothed velocity (px per ms, positive downwards).
	 * Fast scrolling - a wheel fling, a scrollbar drag - moves the viewport further per frame than
	 * the fixed row buffer covers, and the rows only appear after the main thread re-renders; the
	 * lead extends the rendered window in the direction of travel so the exposure stays covered.
	 */
	private readonly scrollMotion = { lastTop: 0, lastTime: 0, velocity: 0 };
	private leadRetightenTimer: number | null = null;
	private lastScrollToStash: { time: number, hash: string | null } = { time: 0, hash: null };

	constructor(private readonly ctx: () => GraphContext) { }

	private get store() {
		return this.ctx().store;
	}

	private get viewElem() {
		return this.ctx().dom.view;
	}

	/**
	 * Should the commit table be rendered windowed (only the rows in and near the viewport, with
	 * spacer rows preserving the scroll height)? Requires uniform row heights, so any state with
	 * variable-height rows (open Commit Details View) or that needs every row in the DOM (an
	 * active find query) falls back to a full render.
	 */
	public canVirtualize() {
		const ctx = this.ctx();
		if (ctx.store.commits.length <= 100) return false; // small lists: not worth the window churn
		if (!(ctx.layout.getRowHeight() > 0)) return false; // no uniform row height available
		if (ctx.store.expandedCommit !== null) return false;
		if (ctx.widgets.find.isSearching()) return false;
		if (this.viewElem.clientHeight <= 0) return false; // unmeasured (e.g. hidden view): keep a full render
		return true;
	}

	/**
	 * Compute the range of commit rows to render (viewport plus a buffer). The base is exact -
	 * `getRowTop(0)` is where row 0's top actually sits, sticky column headers included - and the
	 * buffer is extended in the direction of travel by the scroll velocity lead, so a fast wheel
	 * fling or scrollbar drag keeps the newly exposed region covered with rendered rows instead of
	 * showing the spacers until the main thread catches up.
	 */
	public computeVisibleRange() {
		const rowHeight = this.ctx().layout.getRowHeight(), numCommits = this.store.commits.length;
		let start = Math.max(0, Math.floor((this.viewElem.scrollTop - this.getRowTop(0)) / rowHeight) - VIRTUAL_ROW_BUFFER);
		const count = Math.ceil(this.viewElem.clientHeight / rowHeight) + 1 + 2 * VIRTUAL_ROW_BUFFER;
		let end = Math.min(numCommits, start + count);
		const lead = this.getScrollLeadRows();
		if (lead > 0) {
			if (this.scrollMotion.velocity >= 0) end = Math.min(numCommits, end + lead);
			else start = Math.max(0, start - lead); // scrolling upwards: extend above (end keeps covering the viewport)
		}
		return { start: start, end: end };
	}

	/**
	 * Record a scroll position from the scroll listener to keep the velocity estimate current.
	 * Events closer than 8 ms apart are folded into the next one (browsers can fire several scroll
	 * events per frame); after a pause of 200 ms the estimate restarts from the instantaneous
	 * value, so a fresh gesture never inherits the previous one's direction.
	 */
	public recordScrollMotion(scrollTop: number) {
		const now = performance.now();
		const motion = this.scrollMotion;
		const dt = now - motion.lastTime;
		if (dt < 8) return;
		const instantaneous = (scrollTop - motion.lastTop) / dt;
		motion.velocity = dt > 200 ? instantaneous : motion.velocity * 0.6 + instantaneous * 0.4;
		motion.lastTop = scrollTop;
		motion.lastTime = now;
	}

	/**
	 * How many rows the rendered window should extend beyond the fixed buffer in the direction of
	 * travel: proportional to the (decaying) scroll speed, saturating at VIRTUAL_ROW_MAX_LEAD and
	 * reaching zero VIRTUAL_LEAD_DECAY_MS after the last scroll event - an idle view keeps the
	 * tight window, so ordinary re-renders stay cheap.
	 */
	public getScrollLeadRows() {
		const idleMs = performance.now() - this.scrollMotion.lastTime;
		if (idleMs > VIRTUAL_LEAD_DECAY_MS) return 0;
		const speed = Math.abs(this.scrollMotion.velocity) * Math.max(0, 1 - idleMs / VIRTUAL_LEAD_DECAY_MS);
		return Math.min(VIRTUAL_ROW_MAX_LEAD, Math.ceil(speed / VIRTUAL_LEAD_FULL_SPEED * VIRTUAL_ROW_MAX_LEAD));
	}

	/**
	 * Has a scroll jump already carried the viewport outside the rows the windowed render
	 * currently holds? Re-rendering then cannot wait for the next animation frame: the browser
	 * paints the newly exposed region from the DOM as it is, and the spacers standing in for the
	 * unrendered rows are empty - the "blank content while scrolling" of a fast fling or a
	 * scrollbar drag. The caller re-renders synchronously, inside the scroll event itself.
	 */
	public viewportOutsideRenderedWindow() {
		if (this.renderedRange === null || !this.canVirtualize()) return false;
		const base = this.getRowTop(0), rowHeight = this.ctx().layout.getRowHeight();
		const firstVisible = Math.floor((this.viewElem.scrollTop - base) / rowHeight);
		const lastVisible = Math.ceil((this.viewElem.scrollTop + this.viewElem.clientHeight - base) / rowHeight);
		return firstVisible < this.renderedRange.start || lastVisible > this.renderedRange.end;
	}

	/**
	 * The total height of the header rows (the main controls row + the Pinned row).
	 */
	public getHeaderHeight() {
		const dom = this.ctx().dom;
		return dom.controls.clientHeight
			+ (dom.pinnedControls !== null && dom.pinnedControls.style.display !== 'none' ? dom.pinnedControls.clientHeight : 0);
	}

	/**
	 * The scroll position at which commit row `index` sits exactly at the top of the viewport,
	 * while windowed rendering is active: rows then have a uniform height, so the position is pure
	 * arithmetic and holds whether or not that row is currently in the DOM. Unlike
	 * `computeVisibleRange` - which only has to pick a window and is deliberately generous - this
	 * is exact, and includes the sticky table column headers `getHeaderHeight()` leaves out.
	 */
	public getRowTop(index: number) {
		const colHeadersElem = this.ctx().dom.table.querySelector<HTMLElement>('#tableColHeaders'), rowHeight = this.ctx().layout.getRowHeight();
		return this.getHeaderHeight()
			+ (colHeadersElem !== null ? colHeadersElem.offsetHeight : rowHeight)
			+ index * rowHeight;
	}

	/** The index of the commit row at the top of the viewport (arithmetic, so it holds for rows windowing left out of the DOM), or -1 with no commits. */
	public getTopVisibleCommitIndex() {
		const commits = this.store.commits;
		if (commits.length === 0) return -1;
		return Math.min(commits.length - 1, Math.max(0, Math.floor((this.viewElem.scrollTop - this.getRowTop(0)) / this.ctx().layout.getRowHeight())));
	}


	/* Viewport anchors */

	/**
	 * The commit the user is currently looking at: the topmost commit row intersecting the
	 * viewport, plus how far it is scrolled past the top edge.
	 *
	 * This - not `scrollTop` - is the thing that must survive an update. `scrollTop` is a pixel
	 * offset into a document whose shape changes underneath it: insert or remove k rows above the
	 * viewport and the same `scrollTop` points k rows away from what the user was reading, which
	 * is exactly what "the view jumps" means. An anchor is immune to that by construction, because
	 * it names a commit rather than a distance.
	 */
	public captureViewportAnchor(): ViewportAnchor | null {
		const commits = this.store.commits, layout = this.ctx().layout;
		if (this.viewElem.clientHeight <= 0 || commits.length === 0) return null;
		const atTop = this.viewElem.scrollTop <= 0;

		if (this.canVirtualize()) {
			// Windowed rendering: row heights are uniform (that is its precondition), so which
			// commit sits at the top of the viewport is exact arithmetic - the inverse of
			// getRowTop(). Preferred over measuring the DOM because it also holds for a row that
			// windowing left out of the DOM entirely.
			const index = Math.min(commits.length - 1, Math.max(0, Math.floor((this.viewElem.scrollTop - this.getRowTop(0)) / layout.getRowHeight())));
			return { hash: commits[index].hash, offset: this.viewElem.scrollTop - this.getRowTop(index), atTop: atTop };
		}

		// Full render: rows may have any height (an open Commit Details View), so the topmost
		// visible row has to be found by measuring
		const viewTop = this.viewElem.getBoundingClientRect().top;
		const rows = this.ctx().dom.table.querySelectorAll<HTMLElement>('tr.commit');
		for (let i = 0; i < rows.length; i++) {
			const rect = rows[i].getBoundingClientRect();
			if (rect.bottom > viewTop + 1) { // the first row intersecting the viewport
				const index = parseInt(rows[i].dataset.id!);
				if (isNaN(index) || index < 0 || index >= commits.length) return null;
				return { hash: commits[index].hash, offset: viewTop - rect.top, atTop: atTop };
			}
		}
		return null;
	}

	/**
	 * Capture the current viewport anchor as the pending one, for an update that is about to clear
	 * the rendered table while the commit query stays the same (the refresh button, the "Show
	 * Remote Branches" toggle, a load error awaiting retry). The collapse clamps the browser's
	 * scrollTop to 0, so the anchor the eventual re-render would capture live is "at the very
	 * top" - this pre-collapse capture is what lets loadCommits put the user back where they were
	 * reading once the same commits render again. A null capture (nothing measurable) keeps the
	 * anchor already pending: a hard refresh that fails to load reaches displayLoadDataError with
	 * the table already cleared, and must not overwrite the refresh's own capture with nothing.
	 */
	public capturePendingViewportAnchor() {
		const anchor = this.captureViewportAnchor();
		if (anchor !== null) this.pendingViewportAnchor = anchor;
	}

	/**
	 * Put the anchored commit back at the exact on-screen position it had, whatever the update did
	 * to the list: rows inserted or removed above it, history rewritten, the "Uncommitted Changes"
	 * row appearing or vanishing, even the header growing by a Pinned row. Rows below the viewport
	 * cannot affect it by construction.
	 *
	 * Nothing here is a delta, so nothing can accumulate: the position is restored absolutely,
	 * measured from the DOM where the row is rendered (correct with variable row heights, e.g. an
	 * open Commit Details View) and computed arithmetically where windowed rendering left it out
	 * of the DOM. Must run once the DOM already represents the new list.
	 */
	public applyViewportAnchor(anchor: ViewportAnchor | null) {
		if (anchor === null) return;

		if (anchor.atTop) {
			// At the very top of the history the user is following the newest commits, so rows
			// arriving above must be SEEN: the list stays pinned to the top and the content below
			// slides down, rather than the view scrolling to keep the old first row still. Pinning
			// to the edge IS the anchor here - the same rule the browser's own scroll anchoring
			// applies, and the only place where the visible rows are expected to move.
			this.viewElem.scrollTop = 0;
			return;
		}

		const index = this.store.commitLookup[anchor.hash];
		if (typeof index !== 'number') return; // the anchored commit is gone (e.g. it was rewritten)

		let target: number;
		if (this.canVirtualize()) {
			// Windowed: exact arithmetic, needing neither layout nor the row to be in the DOM -
			// which is what lets this run BEFORE the rows are rendered, so the window is computed
			// at the final scroll position and the rows in it are reconciled exactly once.
			target = this.getRowTop(index) + anchor.offset;
		} else {
			// Full render: measured, so it is correct with variable row heights too (the Commit
			// Details View inserts a <tr> of its own height above the rows below it). Only valid
			// once the DOM already shows the new list.
			const elem = this.ctx().table.findCommitElem(index);
			if (elem === null) return;
			target = this.viewElem.scrollTop + (elem.getBoundingClientRect().top - this.viewElem.getBoundingClientRect().top) + anchor.offset;
		}

		this.viewElem.scrollTop = Math.max(0, Math.round(target));
	}


	/* Windowed rendering */

	/**
	 * Re-render the visible window after the view was scrolled (no-op unless windowed rendering is
	 * active and the window actually moved).
	 */
	public updateVirtualWindow() {
		const ctx = this.ctx();
		if (this.renderedRange === null) {
			// No windowed render is active — but it may have become ALLOWED again since (e.g.
			// the find query that forced the full render was just cleared): re-render, which
			// re-arms windowed rendering when canVirtualize() now holds. Without this, the
			// whole commit list stays in the DOM until the next data change re-renders it.
			if (this.canVirtualize()) ctx.renderScheduler.renderSync();
			return;
		}
		if (!this.canVirtualize()) {
			// Windowed rendering is no longer allowed (e.g. a find query became active): fall back
			// to a full render, otherwise scrolling would keep swapping the windowed rows in and out
			ctx.renderScheduler.renderSync();
			return;
		}
		const range = this.computeVisibleRange();
		if (range.start === this.renderedRange.start && range.end === this.renderedRange.end) return;
		// Synchronous (inside the scroll event's frame callback, where the caller already coalesced
		// the scroll burst): the newly exposed rows must exist when this frame paints
		ctx.renderScheduler.renderSync();
		if (this.getScrollLeadRows() > 0) this.scheduleLeadRetighten();
	}

	/**
	 * A lead-extended window must not stay extended forever: once the scrolling rests and the
	 * velocity lead has decayed, re-render the tight window so ordinary updates stay cheap. Each
	 * lead render re-arms this, so the shrink only ever runs after the motion truly ended.
	 */
	private scheduleLeadRetighten() {
		if (this.leadRetightenTimer !== null) window.clearTimeout(this.leadRetightenTimer);
		this.leadRetightenTimer = window.setTimeout(() => {
			this.leadRetightenTimer = null;
			if (this.renderedRange !== null && this.getScrollLeadRows() === 0) this.updateVirtualWindow();
		}, VIRTUAL_LEAD_DECAY_MS + 60);
	}

	/**
	 * Switch from windowed rendering to a full render if it is currently active. Used by the Find
	 * Widget before scanning for matches: matching only sees rows that are in the DOM, so every
	 * commit row must be rendered (see `canVirtualize`).
	 */
	public exitWindowedRender() {
		if (this.renderedRange === null) return;
		// Synchronous: the caller scans the rendered rows the moment this returns
		this.ctx().renderScheduler.renderSync();
	}


	/* Scrolling */

	/**
	 * Scroll the view to the previous or next stash.
	 * @param next TRUE => Jump to the next stash, FALSE => Jump to the previous stash.
	 */
	public scrollToStash(next: boolean) {
		const stashCommits = this.store.commits.filter((commit) => commit.stash !== null);
		if (stashCommits.length > 0) {
			const curTime = (new Date()).getTime();
			if (this.lastScrollToStash.time < curTime - 5000) {
				// Reset the lastScrollToStash hash if it was more than 5 seconds ago
				this.lastScrollToStash.hash = null;
			}

			const lastScrollToStashCommitIndex = this.lastScrollToStash.hash !== null
				? stashCommits.findIndex((commit) => commit.hash === this.lastScrollToStash.hash)
				: -1;
			let scrollToStashCommitIndex = lastScrollToStashCommitIndex + (next ? 1 : -1);
			if (scrollToStashCommitIndex >= stashCommits.length) {
				scrollToStashCommitIndex = 0;
			} else if (scrollToStashCommitIndex < 0) {
				scrollToStashCommitIndex = stashCommits.length - 1;
			}
			this.scrollToCommit(stashCommits[scrollToStashCommitIndex].hash, true, true);
			this.lastScrollToStash.time = curTime;
			this.lastScrollToStash.hash = stashCommits[scrollToStashCommitIndex].hash;
		}
	}

	/**
	 * Scroll the view to a commit (if it exists).
	 * @param hash The hash of the commit to scroll to.
	 * @param alwaysCenterCommit TRUE => Always scroll the view to be centered on the commit. FALSE => Don't scroll the view if the commit is already within the visible portion of commits.
	 * @param flash Should the commit flash after it has been scrolled to.
	 */
	public scrollToCommit(hash: string, alwaysCenterCommit: boolean, flash: boolean = false) {
		const id = this.store.getCommitId(hash);
		if (id === null) return;
		const table = this.ctx().table;

		if (this.renderedRange !== null) {
			// Windowed rendering: the row's position derives from its index (uniform row heights),
			// then the window is re-rendered around the new scroll position so the row exists
			const elemTop = this.getRowTop(id);
			if (alwaysCenterCommit || elemTop - 8 < this.viewElem.scrollTop || elemTop + 32 - this.viewElem.clientHeight > this.viewElem.scrollTop) {
				this.viewElem.scroll(0, Math.max(0, elemTop + 12 - this.viewElem.clientHeight / 2));
			}
			this.updateVirtualWindow();
			const virtualElem = table.findCommitElem(id);
			if (flash && virtualElem !== null && !virtualElem.classList.contains('flash')) {
				virtualElem.classList.add('flash');
				window.setTimeout(() => {
					virtualElem.classList.remove('flash');
				}, 850);
			}
			return;
		}

		const elem = table.findCommitElem(id);
		if (elem === null) return;

		const elemTop = this.getHeaderHeight() + elem.offsetTop;
		if (alwaysCenterCommit || elemTop - 8 < this.viewElem.scrollTop || elemTop + 32 - this.viewElem.clientHeight > this.viewElem.scrollTop) {
			this.viewElem.scroll(0, this.getHeaderHeight() + elem.offsetTop + 12 - this.viewElem.clientHeight / 2);
		}

		if (flash && !elem.classList.contains('flash')) {
			elem.classList.add('flash');
			window.setTimeout(() => {
				elem.classList.remove('flash');
			}, 850);
		}
	}
}

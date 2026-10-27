/**
 * The commit table: renders the loaded commits as rows (windowed when the list is large),
 * reconciling them with the DOM so that only rows whose own content changed are rebuilt, and
 * keeps the commit graph next to it in step. The rows' model (the per-render RowContext, the row
 * seed, the formatted-text cache) is built by rowModel.ts; reconciling the rows and spacer rows
 * with the DOM is rowPatcher.ts (the keyed patcher).
 */

import { formatCompactDate, formatShortDate } from '../../common/dates';
import { insertAfter, makeKeyboardActivatable } from '../../common/dom';
import { html, parseHtmlRow, SafeHtml, setHtml } from '../../common/html';
import { strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { measureGraphRender } from './measure';
import { TableKeyboard } from './tableKeyboard';
import { RowModelFactory } from './rowModel';
import { RowPatcher } from './rowPatcher';

export class CommitTable {
	/** Which columns the rendered header row was built for (see renderTable). */
	private renderedHeaderKey: string | null = null;
	/** The markup the footer was last set to (see setFooter): unchanged content is never swapped. */
	private footerHtml: string | null = null;
	/** The grid's keyboard behaviour (roving tabindex, arrow navigation, Enter, Shift+F10). */
	private readonly keyboard = new TableKeyboard(() => this.ctx());
	/** The element the keyboard listeners are delegated to (attached on the first render; NULL until then). */
	private keyboardAttachedTo: HTMLElement | null = null;
	/** Builds the rows' model: the per-render RowContext, the row seed, the formatted-text cache. */
	private readonly rowModel = new RowModelFactory(() => this.ctx());
	/** The keyed patcher: reconciles the rows and spacer rows of a render with the DOM. */
	private readonly rowPatcher = new RowPatcher(() => this.ctx(), this.rowModel);

	constructor(private readonly ctx: () => GraphContext) { }

	private get store() {
		return this.ctx().store;
	}

	private get tableElem() {
		return this.ctx().dom.table;
	}


	/* Rendering */

	/**
	 * Render the pinned row, the table and the graph. This is the ONE render pass of the view:
	 * callers reach it through the render scheduler, which merges every request made before the
	 * next frame into a single invocation of this method.
	 */
	public render() {
		const ctx = this.ctx();
		ctx.pinned.render();
		this.renderTable();
		this.renderGraph();
		// The graph column's automatic width follows the lanes the graph just drew, so it can only
		// be measured once renderGraph() has run - makeTableResizable() applies it from inside
		// renderTable(), which is one step too early to see newly opened branch lanes.
		ctx.columns.applyGraphColumnAutoLayout();
	}

	/**
	 * Re-render when a resize (or the setting) switched the layout: the phone layout hides the
	 * Date, Author and Commit columns, and each layout places the Commit Details View differently.
	 * Called by the resize observer, where a plain render would never run (ordinary resizes only
	 * reflow the graph).
	 */
	public updateNarrowWindowLayout() {
		const ctx = this.ctx(), next = ctx.layout.decide(), previous = ctx.layout.getRenderedLayout();
		if (next === previous) {
			// Same layout, new window size: the tablet side pane tracks the window width
			if (next === 'tablet') ctx.layout.apply(next);
			return;
		}
		// Each layout has its own Commit Details View: a full-screen sheet on a phone, the side pane
		// on a tablet, inline in the table (or docked to the bottom, as configured) in the wide
		// layout. Only the docked bottom panel and the phone sheet share an element (the stylesheet
		// alone moves it); otherwise the open view's element belongs to the old layout, so close it
		// rather than leave a docked <div> in the table, a sheet beside the list, or vice versa
		const configuredDocked = ctx.store.config.commitDetailsView.location === GG.CommitDetailsViewLocation.DockedToBottom;
		const sharesElement = configuredDocked && ((previous === 'wide' && next === 'phone') || (previous === 'phone' && next === 'wide'));
		if (ctx.store.expandedCommit !== null && !sharesElement) ctx.details.close(false);
		this.render();
	}

	/** Render the commit graph. */
	public renderGraph() {
		const ctx = this.ctx(), store = ctx.store;
		if (!store.hasCurrentRepo()) {
			// Only render the graph if a repo is loaded (or a repo is currently being loaded)
			return;
		}

		const cdvHeight = store.repoState.cdvHeight;
		const expandedCommit = ctx.layout.isCdvDocked() ? null : store.expandedCommit;
		// The details panel is CommitDetails' element (F3): it is asked for, not re-queried from the document
		const expandedCommitElem = expandedCommit !== null ? ctx.details.openElem : null;

		// Every layout READ this pass needs, batched in one place (measure.ts) BEFORE the graph - a
		// pure write phase - runs: interleaving reads with the writes below would force a layout
		// per read instead of one for the whole batch
		const metrics = measureGraphRender(store, this.tableElem, expandedCommitElem, cdvHeight, expandedCommit !== null);
		const grid = store.config.graph.grid;

		// Update the graph's grid dimensions. A measured row height of 0 (a hidden view - a
		// backgrounded tab measures every clientHeight as 0 - or a table not yet laid out) must not
		// overwrite the last good grid: the graph's total height is reconstructed from these values,
		// and reconstructing it from a zero measurement leaves floating point noise around zero,
		// which SVG rejects outright once it tips negative. Keep the current grid (the configured
		// one before the first measurable render) until a real layout is seen.
		grid.expandY = metrics.expandY;
		if (metrics.measuredRowHeight > 0) {
			grid.y = metrics.measuredRowHeight;
			grid.offsetY = metrics.headerHeight + metrics.measuredRowHeight / 2;
		}

		ctx.graph.render(expandedCommit, [], ctx.viewport.renderedRange);
	}

	/**
	 * Render the commit table: the header row, the commit rows in the rendered range, the spacers
	 * and the footer, and re-attach the open Commit Details View.
	 */
	public renderTable() {
		const ctx = this.ctx(), store = ctx.store, viewport = ctx.viewport;
		// The keyboard routing is delegated onto the table's container element (which exists from
		// the start; only the <table> inside it is created below): attaching once, on the first
		// render, keeps every later reconciliation free of listener bookkeeping
		if (this.keyboardAttachedTo === null) {
			this.keyboard.attach(ctx.dom.table);
			this.keyboardAttachedTo = ctx.dom.table;
		}
		// The expanded Commit Details View is a <tr> living inside this table (non-docked layout).
		// Detach it while the rows are reconciled and put it back afterwards: it must not be
		// treated as one of the commit rows, and re-creating it would discard its scroll position,
		// its file-tree open/closed state and every event listener - which is what makes an
		// unrelated background refresh look like the commit "closing and reopening".
		const cdvElem = store.expandedCommit !== null && !ctx.layout.isCdvDocked() ? ctx.details.openElem : null;
		if (cdvElem !== null && cdvElem.parentNode !== null) cdvElem.parentNode.removeChild(cdvElem);

		// The layout (wide, phone or tablet) is re-evaluated on every render, before any row is
		// built; the resize observer compares against this record to re-render exactly when a
		// resize crosses the breakpoint
		ctx.layout.apply(ctx.layout.decide());

		const rowContext = this.rowModel.createRowContext();
		const colVisibility = rowContext.colVisibility;

		const headerHtml = html`<tr id="tableColHeaders" role="row" aria-rowindex="1"><th id="tableHeaderGraphCol" class="tableColHeader" role="columnheader" data-col="0">${strings.columnGraph}</th><th class="tableColHeader" role="columnheader" data-col="1">${strings.columnDescription}</th>${colVisibility.date ? html`<th class="tableColHeader dateCol" role="columnheader" data-col="2">${strings.columnDate}</th>` : ''}${colVisibility.author ? html`<th class="tableColHeader authorCol" role="columnheader" data-col="3">${strings.columnAuthor}</th>` : ''}${colVisibility.commit ? html`<th class="tableColHeader commitCol" role="columnheader" data-col="4">${strings.columnCommit}</th>` : ''}</tr>`;

		// A full re-render can shrink the commit list (e.g. applying a path filter). A stale scroll
		// position beyond the shrunken list is clamped BEFORE the rendered window is computed,
		// otherwise it selects an empty window (start beyond the list) and no rows or graph vertices
		// are rendered at all. The clamp only acts in that case: the #footer ("Load More Commits")
		// also contributes to the scrollable height, so clamping to the table's height alone would
		// nudge the view up on every re-render while the user is scrolled to the very bottom.
		const viewElem = ctx.dom.view;
		if (viewport.canVirtualize() && viewport.computeVisibleRange().start >= store.commits.length) {
			const maxScroll = Math.max(0, viewport.getHeaderHeight() + store.commits.length * ctx.layout.getRowHeight() - viewElem.clientHeight);
			if (viewElem.scrollTop > maxScroll) viewElem.scrollTop = maxScroll;
		}
		viewport.renderedRange = viewport.canVirtualize() ? viewport.computeVisibleRange() : null;
		const from = viewport.renderedRange !== null ? viewport.renderedRange.start : 0;
		const to = viewport.renderedRange !== null ? viewport.renderedRange.end : store.commits.length;

		// The table skeleton (<tbody>, the column header row, and the two spacers standing in for
		// the rows outside the window) is created once and then kept - never rebuilt - so that
		// reconciling the rows below can reuse the DOM nodes that did not change.
		let tableBody = <HTMLElement | null>this.tableElem.querySelector('table > tbody');
		if (tableBody === null) {
			setHtml(this.tableElem, html`<table role="grid"><tbody></tbody></table>`);
			tableBody = <HTMLElement>this.tableElem.querySelector('table > tbody')!;
		}
		// The grid's row count covers the rendered header row plus every loaded commit, rendered or
		// not (the windowed render keeps only a slice in the DOM): this is what lets a screen reader
		// announce "row 97 of 1001" instead of the DOM row's position in the rendered window.
		const gridElem = <HTMLElement | null>this.tableElem.querySelector('table');
		if (gridElem !== null) {
			const rowCount = String(store.commits.length + 1);
			if (gridElem.getAttribute('aria-rowcount') !== rowCount) gridElem.setAttribute('aria-rowcount', rowCount);
		}
		// Rebuild the header row only when the set of visible columns actually changes - never by
		// comparing its markup, which the column-resizing code decorates with inline widths, so it
		// would never match what is generated here and the header (and the widths on it) would be
		// thrown away on every single refresh.
		const headerKey = String(colVisibility.date) + String(colVisibility.author) + String(colVisibility.commit);
		const headerElem = tableBody.querySelector('#tableColHeaders');
		if (headerElem === null) {
			tableBody.insertBefore(parseHtmlRow(headerHtml), tableBody.firstChild);
			this.renderedHeaderKey = headerKey;
		} else if (this.renderedHeaderKey !== headerKey) {
			tableBody.replaceChild(parseHtmlRow(headerHtml), headerElem);
			this.renderedHeaderKey = headerKey;
		}
		this.rowPatcher.syncSpacerRow(tableBody, true, viewport.renderedRange !== null ? from : 0);
		this.rowPatcher.syncCommitRows(rowContext, from, to);
		this.rowPatcher.syncSpacerRow(tableBody, false, viewport.renderedRange !== null ? store.commits.length - to : 0);
		// The reconciliation above may have built, moved or dropped rows: re-establish the grid's
		// single roving tab stop afterwards (it follows the focused commit's hash)
		this.keyboard.syncRovingTabindex();

		if (cdvElem !== null) {
			// Re-attach it now, before the expandedCommit handling below runs: the details view
			// finds it via document.getElementById('cdv') and reuses it in place (only repositioning
			// it if its row moved) instead of creating a new one.
			const commitElem = this.findCommitElem(store.getCommitId(store.expandedCommit!.commitHash));
			if (commitElem !== null) insertAfter(cdvElem, commitElem);
		}
		const footerSwapped = this.setFooter(store.moreCommitsAvailable ? html`<div id="loadMoreCommitsBtn" class="roundedBtn" role="button" tabindex="0">${strings.loadMoreCommits}</div>` : html``);
		ctx.columns.makeTableResizable();
		ctx.widgets.find.refresh();
		store.slices.commits.markRenderedHead(store.gitBranchHead);

		if (store.moreCommitsAvailable && footerSwapped) {
			// Only a freshly swapped footer needs the listener: an untouched button keeps the one
			// attached when it was created. The button is a <div> (not a native <button>), so it is
			// also made keyboard activatable (Enter / Space, on top of the markup's role/tabindex)
			// The button lives in the view's #footer, not the table (F3: scoped to the owner's subtree)
			const loadMoreBtn = this.ctx().dom.footer.querySelector<HTMLElement>('#loadMoreCommitsBtn')!;
			makeKeyboardActivatable(loadMoreBtn);
			loadMoreBtn.addEventListener('click', () => {
				ctx.loader.loadMoreCommits();
			});
		}

		if (store.expandedCommit !== null) {
			const expandedCommit = store.expandedCommit, details = ctx.details;
			const commitElem = this.findCommitElem(store.getCommitId(expandedCommit.commitHash));
			const compareWithElem = expandedCommit.compareWithHash !== null ? this.findCommitElem(store.getCommitId(expandedCommit.compareWithHash)) : null;

			if (commitElem === null || (expandedCommit.compareWithHash !== null && compareWithElem === null)) {
				details.close(false);
				ctx.persistence.saveState();
			} else {
				store.slices.details.relink(parseInt(commitElem.dataset.id!), commitElem, compareWithElem);
				ctx.persistence.saveState();
				if (expandedCommit.compareWithHash === null) {
					// Commit Details View is open
					if (!expandedCommit.loading && expandedCommit.commitDetails !== null && expandedCommit.fileTree !== null) {
						details.showDetails(expandedCommit.commitDetails, expandedCommit.fileTree, expandedCommit.avatar, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED) {
							details.requestCommitDetails(expandedCommit.commitHash, true);
						}
					} else {
						details.load(commitElem);
					}
				} else {
					// Commit Comparison is open
					if (!expandedCommit.loading && expandedCommit.fileChanges !== null && expandedCommit.fileTree !== null) {
						details.showComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, expandedCommit.fileChanges, expandedCommit.fileTree, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED || expandedCommit.compareWithHash === UNCOMMITTED) {
							details.requestCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, true);
						}
					} else {
						details.loadComparison(commitElem, compareWithElem!);
					}
				}
			}
		}

		ctx.commitBodies.requestForRows(from, to);
	}

	/**
	 * Patch the "Uncommitted Changes" row in place: the row was built by the row builder, so only
	 * the two things a working-tree status can change are touched - the count in the message and
	 * the date. A background refresh with an identical status leaves the row's DOM (structure,
	 * resize handles, find highlights) completely alone.
	 */
	public renderUncommittedChanges() {
		const store = this.store, dateFormat = store.config.dateFormat;
		const uncommittedElem = this.tableElem.querySelector<HTMLElement>('#uncommittedChanges');
		if (uncommittedElem === null) return; // not rendered (e.g. outside the windowed render range)
		const row = store.commits[0];
		const date = formatShortDate(row.date, dateFormat);
		const messageElem = uncommittedElem.querySelector('.description .text');
		if (messageElem !== null && messageElem.textContent !== row.message) {
			messageElem.textContent = row.message;
		}
		const mobileDateElem = <HTMLElement | null>uncommittedElem.querySelector('.mobileMetaDate');
		if (mobileDateElem !== null) {
			const compact = formatCompactDate(row.date, dateFormat);
			if (mobileDateElem.title !== date.title) mobileDateElem.title = date.title;
			if (mobileDateElem.textContent !== compact) mobileDateElem.textContent = compact;
		}
		const dateElem = <HTMLElement | null>uncommittedElem.querySelector('.dateCol');
		if (dateElem !== null) {
			if (dateElem.title !== date.title) dateElem.title = date.title;
			// The formatted date is the trailing text node after the column-resize handle
			const dateText = dateElem.lastChild;
			if (dateText !== null && dateText.nodeType === 3 && dateText.textContent !== date.formatted) {
				dateText.textContent = date.formatted;
			}
		}
	}


	/* Rows */

	/** The rendered row of the commit at an index (NULL if it isn't rendered). */
	public findCommitElem(id: number | null) {
		if (id === null) return null;
		// Use an attribute selector (backed by the browser's query engine) instead of scanning every
		// commit row: with many loaded commits this lookup runs on every vertex hover / interaction
		return this.tableElem.querySelector('tr.commit[data-id="' + id.toString() + '"]') as HTMLElement | null;
	}


	/* Footer */

	/**
	 * Set the footer's content, leaving the DOM untouched when it is already showing exactly this
	 * (a re-render that swaps identical nodes would only reset whatever the user is doing with
	 * them - e.g. hovering the "Load More Commits" button). Every footer write goes through here,
	 * so the cached content can never go stale.
	 * @returns Whether the footer was actually swapped.
	 */
	public setFooter(content: SafeHtml) {
		if (this.footerHtml === content.html) return false;
		this.footerHtml = content.html;
		setHtml(this.ctx().dom.footer, content);
		return true;
	}

	/** The "loading" header shown in the footer while more commits load. */
	public setFooterLoading() {
		this.setFooter(html`<h2 id="loadingHeader">${SVG_ICONS.loading}${strings.loading}</h2>`);
	}

	/** Empty the table (a hard refresh, an error), keeping the footer cache coherent. */
	public clear() {
		setHtml(this.tableElem, html``);
		this.renderedHeaderKey = null;
	}

	/** The loading header and skeleton rows shown while the commits of a repository first load. */
	public showLoadingSkeleton() {
		setHtml(this.tableElem, html`<h2 id="loadingHeader">${SVG_ICONS.loading}${strings.loading}</h2><div class="skeletonRows">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => html`<div class="skeletonRow"></div>`)}</div>`);
		this.renderedHeaderKey = null;
	}
}

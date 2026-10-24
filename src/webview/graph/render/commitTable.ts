/**
 * The commit table: renders the loaded commits as rows (windowed when the list is large),
 * reconciling them with the DOM so that only rows whose own content changed are rebuilt, and
 * keeps the commit graph next to it in step.
 */

import { formatCompactDate, formatShortDate } from '../../common/dates';
import { insertAfter } from '../../common/dom';
import { html, parseHtmlRow, raw, SafeHtml, setHtml } from '../../common/html';
import { strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { TextFormatter } from '../text/textFormatter';
import { getCommitRowHtml, RowContext } from './commitRow';

const FORMATTED_TEXT_CACHE_LIMIT = 5000;

export class CommitTable {
	/**
	 * The markup each rendered row was built from, minus the parts that are patched in place (its
	 * index, its lane colour, the checked-out marker). A row is rebuilt only when this changes, so
	 * an update that does not affect a row leaves its DOM node completely alone. Held outside the
	 * elements themselves so the nodes stay pristine.
	 */
	private readonly rowSignatures = new WeakMap<HTMLElement, string>();
	/** Which columns the rendered header row was built for (see renderTable). */
	private renderedHeaderKey: string | null = null;
	/** The markup the footer was last set to (see setFooter): unchanged content is never swapped. */
	private footerHtml: string | null = null;

	/**
	 * Cache of formatted message texts (keyed by the raw text): commit subjects repeat heavily in
	 * large repositories (merges, reverts, chores), and the regex-heavy formatting is a major
	 * per-row render cost. Bounded, and simply cleared when the bound is exceeded.
	 */
	private readonly formattedTextCache = new Map<string, SafeHtml>();
	private formattedTextCacheSignature = '';

	constructor(private readonly ctx: () => GraphContext) { }

	private get store() {
		return this.ctx().store;
	}

	private get tableElem() {
		return this.ctx().dom.table;
	}


	/* Rendering */

	/** Render the pinned row, the table and the graph. */
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
	 * Re-render when a resize crossed the narrow window breakpoint: the Date, Author and Commit
	 * columns are hidden below it and restored above it. Called by the resize observer, where a
	 * plain render would never run (ordinary resizes only reflow the graph).
	 */
	public updateNarrowWindowLayout() {
		const ctx = this.ctx();
		if (ctx.layout.isNarrowWindow() === ctx.layout.isMobileLayout()) return;
		if (ctx.store.expandedCommit !== null && ctx.store.config.commitDetailsView.location !== GG.CommitDetailsViewLocation.DockedToBottom) {
			// The mobile layout always shows the Commit Details View as a full-screen sheet (docked),
			// the wide layout inline in the table (as configured): the open view's element is of the
			// other kind, so close it rather than leave a docked <div> in the table or vice versa
			ctx.details.close(false);
		}
		this.render();
	}

	/** Render the commit graph. */
	public renderGraph() {
		const ctx = this.ctx(), store = ctx.store;
		if (!store.hasCurrentRepo()) {
			// Only render the graph if a repo is loaded (or a repo is currently being loaded)
			return;
		}

		const colHeadersElem = document.getElementById('tableColHeaders');
		const cdvHeight = store.repoState.cdvHeight;
		// (+1 for its bottom border; the mobile layout hides the header row, which then adds nothing)
		const headerHeight = colHeadersElem !== null && colHeadersElem.clientHeight > 0 ? colHeadersElem.clientHeight + 1 : 0;
		const expandedCommit = ctx.layout.isCdvDocked() ? null : store.expandedCommit;
		const expandedCommitElem = expandedCommit !== null ? document.getElementById('cdv') : null;
		const grid = store.config.graph.grid;

		// Update the graph's grid dimensions
		grid.expandY = expandedCommitElem !== null
			? expandedCommitElem.getBoundingClientRect().height
			: cdvHeight;
		// The row height is MEASURED from the rendered table (real rows can deviate from the
		// configured graph.rowHeight), but a layout reporting no height - a hidden view
		// (a backgrounded tab measures every clientHeight as 0) or a table not yet laid out -
		// must not overwrite the last good grid: the graph's total height is reconstructed from
		// these values, and reconstructing it from a zero measurement leaves floating point noise
		// around zero, which SVG rejects outright once it tips negative. Keep the current grid
		// (the configured one before the first measurable render) until a real layout is seen.
		const measuredRowHeight = store.commits.length > 0 && this.tableElem.children.length > 0
			? (this.tableElem.children[0].clientHeight - headerHeight - (expandedCommit !== null ? cdvHeight : 0)) / store.commits.length
			: 0;
		if (measuredRowHeight > 0) {
			grid.y = measuredRowHeight;
			grid.offsetY = headerHeight + measuredRowHeight / 2;
		}

		ctx.graph.render(expandedCommit, [], ctx.viewport.renderedRange);
	}

	/**
	 * Render the commit table: the header row, the commit rows in the rendered range, the spacers
	 * and the footer, and re-attach the open Commit Details View.
	 */
	public renderTable() {
		const ctx = this.ctx(), store = ctx.store, viewport = ctx.viewport;
		// The expanded Commit Details View is a <tr> living inside this table (non-docked layout).
		// Detach it while the rows are reconciled and put it back afterwards: it must not be
		// treated as one of the commit rows, and re-creating it would discard its scroll position,
		// its file-tree open/closed state and every event listener - which is what makes an
		// unrelated background refresh look like the commit "closing and reopening".
		const cdvElem = store.expandedCommit !== null && !ctx.layout.isCdvDocked() ? document.getElementById('cdv') : null;
		if (cdvElem !== null && cdvElem.parentNode !== null) cdvElem.parentNode.removeChild(cdvElem);

		// The narrow window (mobile) layout is re-evaluated on every render, before any row is
		// built; the resize observer compares against this record to re-render exactly when a
		// resize crosses the breakpoint
		ctx.layout.apply(ctx.layout.isNarrowWindow());

		const rowContext = this.createRowContext();
		const colVisibility = rowContext.colVisibility;

		const headerHtml = html`<tr id="tableColHeaders"><th id="tableHeaderGraphCol" class="tableColHeader" data-col="0">${strings.columnGraph}</th><th class="tableColHeader" data-col="1">${strings.columnDescription}</th>${colVisibility.date ? html`<th class="tableColHeader dateCol" data-col="2">${strings.columnDate}</th>` : ''}${colVisibility.author ? html`<th class="tableColHeader authorCol" data-col="3">${strings.columnAuthor}</th>` : ''}${colVisibility.commit ? html`<th class="tableColHeader commitCol" data-col="4">${strings.columnCommit}</th>` : ''}</tr>`;

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
			setHtml(this.tableElem, html`<table><tbody></tbody></table>`);
			tableBody = <HTMLElement>this.tableElem.querySelector('table > tbody')!;
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
		this.syncSpacerRow(tableBody, true, viewport.renderedRange !== null ? from : 0);
		this.syncCommitRows(rowContext, from, to);
		this.syncSpacerRow(tableBody, false, viewport.renderedRange !== null ? store.commits.length - to : 0);

		if (cdvElem !== null) {
			// Re-attach it now, before the expandedCommit handling below runs: the details view
			// finds it via document.getElementById('cdv') and reuses it in place (only repositioning
			// it if its row moved) instead of creating a new one.
			const commitElem = this.findCommitElem(store.getCommitId(store.expandedCommit!.commitHash));
			if (commitElem !== null) insertAfter(cdvElem, commitElem);
		}
		const footerSwapped = this.setFooter(store.moreCommitsAvailable ? html`<div id="loadMoreCommitsBtn" class="roundedBtn">${strings.loadMoreCommits}</div>` : html``);
		ctx.columns.makeTableResizable();
		ctx.widgets.find.refresh();
		store.renderedGitBranchHead = store.gitBranchHead;

		if (store.moreCommitsAvailable && footerSwapped) {
			// Only a freshly swapped footer needs the listener: an untouched button keeps the one
			// attached when it was created
			document.getElementById('loadMoreCommitsBtn')!.addEventListener('click', () => {
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
				expandedCommit.index = parseInt(commitElem.dataset.id!);
				expandedCommit.commitElem = commitElem;
				expandedCommit.compareWithElem = compareWithElem;
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
		const uncommittedElem = document.getElementById('uncommittedChanges');
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
		return document.querySelector('tr.commit[data-id="' + id.toString() + '"]') as HTMLElement | null;
	}

	/**
	 * Context shared by the commit row rendering: computed once per render (full or incremental)
	 * and consumed once per rendered commit row.
	 */
	private createRowContext(): RowContext {
		const ctx = this.ctx(), store = ctx.store, config = store.config;
		const currentHash = store.commits.length > 0 && store.commits[0].hash === UNCOMMITTED ? UNCOMMITTED : store.commitHead;
		const textFormatter = new TextFormatter(store.commits, store.getIssueLinkingConfig(), {
			emoji: true,
			issueLinking: true,
			markdown: config.markdown
		});
		return {
			config: config,
			commits: store.commits,
			commitHead: store.commitHead,
			gitBranchHead: store.gitBranchHead,
			narrow: ctx.layout.isMobileLayout(),
			colVisibility: ctx.layout.getColumnVisibility(),
			currentHash: currentHash,
			vertexColours: ctx.graph.getVertexColours(),
			widthsAtVertices: config.referenceLabels.branchLabelsAlignedToGraph ? ctx.graph.getWidthsAtVertices() : [],
			mutedCommits: ctx.graph.getMutedCommits(currentHash),
			pinnedCommitHashes: new Set(store.getPinnedCommits().map((pinned) => pinned.hash)),
			gerritStates: store.gerritStates,
			// The Gerrit badges displayable under the fetch limit: computed once per render, so the
			// rows built and the rows reconciled during the same render check the same set
			gerritVisibleChanges: store.getGerritVisibleChanges(),
			pullRequestsByHead: store.pullRequestsByHead,
			avatars: store.avatars,
			commitBodies: ctx.commitBodies.bodies,
			textFormatter: textFormatter,
			formatText: (text) => this.formatText(textFormatter, text)
		};
	}

	private formatText(textFormatter: TextFormatter, text: string): SafeHtml {
		const store = this.store;
		// The cache is only valid for the current formatting configuration (markdown setting and
		// the issue linking configuration): bust it when either changes
		const signature = (store.config.markdown ? '1' : '0') + '|' + JSON.stringify(store.getIssueLinkingConfig());
		if (signature !== this.formattedTextCacheSignature) {
			this.formattedTextCache.clear();
			this.formattedTextCacheSignature = signature;
		}
		const cached = this.formattedTextCache.get(text);
		if (cached !== undefined) return cached;
		const formatted = textFormatter.format(text);
		if (this.formattedTextCache.size >= FORMATTED_TEXT_CACHE_LIMIT) {
			this.formattedTextCache.clear();
		}
		this.formattedTextCache.set(text, formatted);
		return formatted;
	}

	/**
	 * Make the rendered commit rows match `commits[from..to)` exactly, reusing the existing DOM
	 * node of every row that has not changed.
	 *
	 * This is what makes the virtual table's contract true: rows are matched by COMMIT HASH, not
	 * by index, and re-rendered only when their own markup actually differs. A commit inserted or
	 * removed outside the window therefore touches nothing inside it - the rows keep their very
	 * DOM nodes, and with them the column widths the browser already laid out, the find-widget
	 * highlights and the open Commit Details View. Only the `data-id` index label is restamped.
	 */
	private syncCommitRows(rowContext: RowContext, from: number, to: number) {
		// Rows live inside the <tbody> (implicit or explicit), not directly under the <table>
		const tableBody = <HTMLElement | null>(this.tableElem.querySelector('table > tbody') || this.tableElem.querySelector('table'));
		if (tableBody === null) return;

		const existing = new Map<string, HTMLElement>();
		const existingRows = tableBody.querySelectorAll<HTMLElement>('tr.commit');
		for (let i = 0; i < existingRows.length; i++) {
			const hash = existingRows[i].dataset.hash;
			if (typeof hash === 'string' && !existing.has(hash)) existing.set(hash, existingRows[i]);
		}

		// Walk the desired rows in order, keeping a cursor on the node each one should sit before
		const headerRow = tableBody.querySelector('#tableColHeaders');
		const topSpacer = tableBody.querySelector('#tableColHeaders + tr.virtSpacer');
		let cursor: Node | null = (topSpacer !== null ? topSpacer : headerRow) as Node | null;
		cursor = cursor !== null ? cursor.nextSibling : tableBody.firstChild;

		const commits = rowContext.commits;
		const kept = new Set<HTMLElement>();
		for (let i = from; i < to; i++) {
			const rowHtml = getCommitRowHtml(i, rowContext);
			// Three things change without the ROW changing - its index label, its graph lane colour
			// and whether it is the checked-out commit - and all three can be applied to an existing
			// node in place. Keeping them out of the comparison is what lets a row survive a commit
			// arriving above it, or HEAD moving elsewhere, as the very same DOM node.
			const signature = rowHtml.html
				.replace(/ data-id="\d+"/, '')
				.replace(/ data-color="\d+"/, '')
				.replace(/^<tr class="commit current/, '<tr class="commit');
			const hash = commits[i].hash;
			let row = existing.get(hash);

			if (row === undefined || this.rowSignatures.get(row) !== signature) {
				// The row's own content changed (or it was not rendered at all): build it, put it in
				// place, and only then drop the stale node - which may be the very node `cursor`
				// points at, so it must not be detached while the cursor still needs it.
				const fresh = parseHtmlRow(rowHtml);
				this.rowSignatures.set(fresh, signature);
				tableBody.insertBefore(fresh, cursor);
				if (row !== undefined && row.parentNode !== null) row.remove();
				row = fresh;
			} else {
				// Unchanged: keep the node, restamping only what is allowed to differ. Moving it is
				// what absorbs rows inserted or removed above without rebuilding anything.
				if (row.dataset.id !== String(i)) row.dataset.id = String(i);
				if (row.dataset.color !== String(rowContext.vertexColours[i])) row.dataset.color = String(rowContext.vertexColours[i]);
				row.classList.toggle('current', hash === rowContext.currentHash);
				if (row !== cursor) tableBody.insertBefore(row, cursor);
			}

			// The next row goes immediately after this one, whatever just happened to the nodes
			cursor = row.nextSibling;
			kept.add(row);
			existing.delete(hash);
		}

		// Whatever is left is no longer in the window (scrolled out, or the commit is gone)
		const remainingRows = tableBody.querySelectorAll<HTMLElement>('tr.commit');
		for (let i = 0; i < remainingRows.length; i++) {
			if (!kept.has(remainingRows[i])) remainingRows[i].remove();
		}
	}

	/**
	 * Keep the spacer row that stands in for the `rows` unrendered commit rows above (`top`) or
	 * below the window, so the scroll height - and with it the scroll bar and the "Load More
	 * Commits" bottom detection - stays proportional to the whole commit list. The element is
	 * created once and afterwards only resized, so the rows around it are never disturbed.
	 */
	private syncSpacerRow(tableBody: HTMLElement, top: boolean, rows: number) {
		const ctx = this.ctx();
		let spacer = <HTMLElement | null>tableBody.querySelector(top ? '#virtSpacerTop' : '#virtSpacerBottom');
		if (ctx.viewport.renderedRange === null) {
			// Full render: every row is in the DOM, nothing to stand in for
			if (spacer !== null) spacer.remove();
			return;
		}
		if (spacer === null) {
			spacer = parseHtmlRow(raw('<tr id="' + (top ? 'virtSpacerTop' : 'virtSpacerBottom') + '" class="virtSpacer" aria-hidden="true"><td style="height:0;padding:0"></td></tr>'));
			if (top) {
				tableBody.querySelector('#tableColHeaders')!.insertAdjacentElement('afterend', spacer);
			}
		}
		if (!top) tableBody.appendChild(spacer); // always the last row, whatever was appended before it
		const td = <HTMLElement | null>spacer.querySelector('td');
		if (td !== null) {
			const height = Math.max(0, rows) * ctx.layout.getRowHeight() + 'px';
			if (td.style.height !== height) td.style.height = height;
			const colspan = String(ctx.layout.getNumColumns());
			if (td.getAttribute('colspan') !== colspan) td.setAttribute('colspan', colspan);
		}
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

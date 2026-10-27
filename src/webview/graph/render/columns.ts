/**
 * The columns of the commit table: the automatic width of the Graph column (limited relative to
 * the view width), and the resizable columns with their header context menu (column visibility,
 * commit ordering, reset widths).
 */

import { handledEvent, ListenerGroup } from '../../common/dom';
import { html, insertHtml } from '../../common/html';
import { strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { measureGraphColumn } from './measure';
import { getCommitOrdering } from '../state/repoSettings';
import { COLUMN_AUTO, COLUMN_HIDDEN } from './layoutMode';

const COLUMN_MIN_WIDTH = 40;
const COLUMN_LEFT_RIGHT_PADDING = 24;
const CSS_PROP_LIMIT_GRAPH_WIDTH = '--limitGraphWidth';

export class ColumnLayout {
	/* The elements and repository the .resizeCol handles and listeners were last attached to (see makeTableResizable). */
	private wiredTable: HTMLElement | null = null;
	private wiredHeader: HTMLElement | null = null;
	private wiredRepo: unknown = undefined;
	private readonly wiredListeners = new ListenerGroup();

	constructor(private readonly ctx: () => GraphContext) { }

	/**
	 * Apply the automatic graph column layout, limiting the graph column width relative to the
	 * current view width. Called when the table is rendered, and when the view is resized while the
	 * graph column has an automatic width.
	 */
	public applyGraphColumnAutoLayout() {
		const ctx = this.ctx(), tableElem = ctx.dom.table;
		if (!ctx.store.hasCurrentRepo() || tableElem.className.indexOf('autoLayout') === -1) return; // only the automatic layout depends on the view width

		// Only the Graph column header is needed here: look it up directly by id (its class-based
		// collection is scanned separately - and more expensively, on a large table - by makeTableResizable).
		const graphColElem = tableElem.querySelector<HTMLElement>('#tableHeaderGraphCol');
		if (graphColElem === null) return;

		// Reset any padding this function applied on a previous call before measuring: otherwise
		// colWidth reflects that stale, JS-inflated padding instead of the column's base CSS
		// padding, and deriving new padding from it makes the graph column width oscillate between
		// calls while the window is being resized.
		graphColElem.style.padding = '';
		// The two layout READS of this pass, batched (measure.ts) before the writes below
		const metrics = measureGraphColumn(graphColElem, ctx.dom.view);
		const colWidth = metrics.graphColumnWidth;
		let graphWidth = ctx.graph.getContentWidth();
		const maxWidth = Math.round(metrics.viewWidth * 0.333);
		if (Math.max(graphWidth, colWidth) > maxWidth) {
			ctx.graph.limitMaxWidth(maxWidth);
			graphWidth = maxWidth;
			tableElem.className = 'autoLayout limitGraphWidth';
			tableElem.style.setProperty(CSS_PROP_LIMIT_GRAPH_WIDTH, maxWidth + 'px');
		} else {
			ctx.graph.limitMaxWidth(-1);
			tableElem.className = 'autoLayout';
			tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
		}

		// The mobile layout has no column header text to fit, so a single-lane graph keeps its own width
		const minWidth = ctx.layout.isTwoLineRows() ? 32 : 64;
		if (colWidth < Math.max(graphWidth, minWidth)) {
			graphColElem.style.padding = '6px ' + Math.floor((Math.max(graphWidth, minWidth) - (colWidth - COLUMN_LEFT_RIGHT_PADDING)) / 2) + 'px';
		} else {
			graphColElem.style.padding = '';
		}
	}

	/**
	 * Make the columns of the table resizable (the Graph, Date, Author and Commit columns), and
	 * wire the header's context menu.
	 */
	public makeTableResizable() {
		const ctx = this.ctx(), store = ctx.store, tableElem = ctx.dom.table;
		// Every .tableColHeader element is a direct child of colHeadersElem, so read them from there
		// instead of document.getElementsByClassName: that searches the whole document (every cell of
		// every commit row) for a handful of matches, and - being a live HTMLCollection - would also
		// re-run that document-wide scan on every .length/indexed access below if captured directly.
		const colHeadersElem = tableElem.querySelector<HTMLElement>('#tableColHeaders')!, cols = Array.from(colHeadersElem.children) as HTMLElement[];

		let columnWidths: GG.ColumnWidth[], mouseX = -1, col = -1, colIndex = -1;

		// Whether the currently pressed resize handle has actually been DRAGGED (the mouse moved
		// while pressing it). The switch from the automatic column layout to a fixed one - and the
		// saving of the widths - must only happen for a real drag, never for a stray click.
		let dragMoved = false;

		const makeTableFixedLayout = () => {
			cols[0].style.width = columnWidths[0] + 'px';
			cols[0].style.padding = '';
			for (let i = 2; i < cols.length; i++) {
				cols[i].style.width = columnWidths[parseInt(cols[i].dataset.col!)] + 'px';
			}
			tableElem.className = 'fixedLayout';
			tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
			ctx.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
		};

		// The resize handles and their listeners are wired ONCE per table/header element and
		// repository - not on every call. The table skeleton and the header row are KEPT across
		// renders (the reconciling render rebuilds neither), so re-running the decoration and the
		// addEventListener calls on every renderTable would stack another pair of .resizeCol handles
		// onto each header cell and another mousedown/contextmenu listener (holding a stale closure
		// over columnWidths) onto the same elements on every refresh. The wiring is redone only when
		// one of its anchors changes: the <table> or header row element was replaced, or the current
		// repository switched (columnWidths are per-repository, and a stale closure would read one
		// repo's widths while writing them into another).
		const tableRootElem = <HTMLElement>tableElem.firstElementChild;
		const wiringChanged = this.wiredTable !== tableRootElem || this.wiredHeader !== colHeadersElem || this.wiredRepo !== store.currentRepo;
		if (wiringChanged) {
			this.wiredListeners.removeAll();
			this.wiredTable = tableRootElem;
			this.wiredHeader = colHeadersElem;
			this.wiredRepo = store.currentRepo;

			for (let i = 0; i < cols.length; i++) {
				const colId = parseInt(cols[i].dataset.col!);
				insertHtml(cols[i], 'beforeend', html`${i > 0 ? html`<span class="resizeCol left" data-col="${colId - 1}"></span>` : ''}${i < cols.length - 1 ? html`<span class="resizeCol right" data-col="${colId}"></span>` : ''}`);
			}
		}

		const cWidths = store.repoState.columnWidths;
		if (cWidths === null) { // Initialise auto column layout if it is the first time viewing the repo.
			const defaults = store.config.defaultColumnVisibility;
			columnWidths = [COLUMN_AUTO, COLUMN_AUTO, defaults.date ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.author ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.commit ? COLUMN_AUTO : COLUMN_HIDDEN];
			ctx.persistence.saveColumnWidths(columnWidths);
		} else {
			columnWidths = [cWidths[0], COLUMN_AUTO, cWidths[1], cWidths[2], cWidths[3]];
		}

		if (columnWidths[0] !== COLUMN_AUTO) {
			// Table should have fixed layout
			makeTableFixedLayout();
		} else {
			// Table should have automatic layout
			tableElem.className = 'autoLayout';
			this.applyGraphColumnAutoLayout();
		}

		const processResizingColumn: EventListener = (e) => {
			if (col > -1) {
				const mouseEvent = <MouseEvent>e;
				let mouseDeltaX = mouseEvent.clientX - mouseX;
				if (mouseDeltaX === 0) return; // the mouse has not moved (yet): nothing to resize

				if (!dragMoved) {
					dragMoved = true;
					if (columnWidths[0] === COLUMN_AUTO) {
						// The drag began on the automatic layout: capture the columns' current widths
						// and switch the table to a fixed layout - but only now, on the first actual
						// movement. Converting on mousedown instead meant that one stray click on a
						// handle (they line every cell boundary of every row, full column height, so
						// they are easy to hit accidentally) permanently froze the column widths: the
						// Graph column never tracked the graph again, and a graph wider than the
						// frozen width was cut off at the column boundary.
						for (let i = 0; i < cols.length; i++) {
							const curCol = parseInt(cols[i].dataset.col!);
							if (curCol !== 1) columnWidths[curCol] = cols[i].clientWidth - COLUMN_LEFT_RIGHT_PADDING;
						}
						makeTableFixedLayout();
					}
				}

				if (col === 0) {
					if (columnWidths[0] + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -columnWidths[0] + COLUMN_MIN_WIDTH;
					if (cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - COLUMN_MIN_WIDTH;
					columnWidths[0] += mouseDeltaX;
					cols[0].style.width = columnWidths[0] + 'px';
					ctx.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
				} else {
					const colWidth = col !== 1 ? columnWidths[col] : cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING;

					// The right neighbour is the next VISIBLE column: when every column to the right
					// is hidden, the scan must stop at the end of the table — running past it made
					// columnWidths[nextCol] (and cols[colIndex + 1]) undefined, throwing on every
					// mousemove and writing a NaN into the widths. With no neighbour to shrink, the
					// drag only clamps the dragged column to its minimum.
					let nextCol = col + 1;
					while (nextCol < columnWidths.length && columnWidths[nextCol] === COLUMN_HIDDEN) nextCol++;
					const hasRightNeighbour = nextCol < columnWidths.length;

					if (colWidth + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -colWidth + COLUMN_MIN_WIDTH;
					if (hasRightNeighbour && columnWidths[nextCol] - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = columnWidths[nextCol] - COLUMN_MIN_WIDTH;
					if (col !== 1) {
						columnWidths[col] += mouseDeltaX;
						cols[colIndex].style.width = columnWidths[col] + 'px';
					}
					if (hasRightNeighbour) {
						columnWidths[nextCol] -= mouseDeltaX;
						cols[colIndex + 1].style.width = columnWidths[nextCol] + 'px';
					}
				}

				mouseX = mouseEvent.clientX;
			}
		};

		const stopResizingColumn: EventListener = () => {
			if (col > -1) {
				const resized = dragMoved;
				col = -1;
				colIndex = -1;
				mouseX = -1;
				dragMoved = false;
				ctx.eventOverlay.remove();
				// A click without any movement must not save anything: the widths are unchanged, and
				// saving would write the mousedown state (or a stale closure's state) as if the user
				// had chosen it
				if (resized) ctx.persistence.saveColumnWidths(columnWidths);
			}
		};

		// Every commit row (not just the header) carries its own pair of .resizeCol handles, so the
		// hit area spans the table's full height - with hundreds/thousands of loaded commits that's
		// thousands of elements. A single delegated listener on the <table> replaces what was
		// previously one addEventListener call per handle, and was the dominant cost of a full render.
		// Attached inside the wiring guard: the <table> is kept across renders, so an unguarded
		// attach would stack one listener per renderTable call.
		if (!wiringChanged) return;
		this.wiredListeners.add(tableRootElem, 'mousedown', (e) => {
			const resizeColElem = e.target !== null ? (<HTMLElement>e.target).closest('.resizeCol') : null;
			if (resizeColElem === null) return;

			col = parseInt((<HTMLElement>resizeColElem).dataset.col!);
			while (columnWidths[col] === COLUMN_HIDDEN) col--;
			mouseX = (<MouseEvent>e).clientX;
			dragMoved = false;
			for (let i = 0; i < cols.length; i++) {
				if (parseInt(cols[i].dataset.col!) === col) colIndex = i;
			}
			ctx.eventOverlay.create('colResize', processResizingColumn, stopResizingColumn);
		});

		this.wiredListeners.add(colHeadersElem, 'contextmenu', (e) => {
			handledEvent(e);

			const toggleColumnState = (col: number, defaultWidth: number) => {
				columnWidths[col] = columnWidths[col] !== COLUMN_HIDDEN ? COLUMN_HIDDEN : columnWidths[0] === COLUMN_AUTO ? COLUMN_AUTO : defaultWidth - COLUMN_LEFT_RIGHT_PADDING;
				ctx.persistence.saveColumnWidths(columnWidths);
				ctx.renderScheduler.request();
			};

			const commitOrdering = getCommitOrdering(store.repoState.commitOrdering, store.config);
			const changeCommitOrdering = (repoCommitOrdering: GG.RepoCommitOrdering) => {
				ctx.persistence.saveRepoStateValue(store.currentRepo, 'commitOrdering', repoCommitOrdering);
				ctx.loader.refresh(true);
			};

			ctx.contextMenu.show([
				[
					{ title: strings.columnDate, visible: true, checked: columnWidths[2] !== COLUMN_HIDDEN, onClick: () => toggleColumnState(2, 128) },
					{ title: strings.columnAuthor, visible: true, checked: columnWidths[3] !== COLUMN_HIDDEN, onClick: () => toggleColumnState(3, 128) },
					{ title: strings.columnCommit, visible: true, checked: columnWidths[4] !== COLUMN_HIDDEN, onClick: () => toggleColumnState(4, 80) }
				],
				[
					{ title: strings.orderCommitTimestamp, visible: true, checked: commitOrdering === GG.CommitOrdering.Date, onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Date) },
					{ title: strings.orderAuthorTimestamp, visible: true, checked: commitOrdering === GG.CommitOrdering.AuthorDate, onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.AuthorDate) },
					{ title: strings.orderTopological, visible: true, checked: commitOrdering === GG.CommitOrdering.Topological, onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Topological) }
				],
				[
					{
						// Recovery for a layout that was frozen at one point's widths (e.g. by the
						// stray-click freeze, or a drag the user no longer wants): back to automatic.
						title: strings.columnResetWidths,
						visible: columnWidths[0] !== COLUMN_AUTO,
						onClick: () => {
							for (let i = 0; i < cols.length; i++) cols[i].style.width = '';
							for (let i = 2; i < columnWidths.length; i++) columnWidths[i] = columnWidths[i] === COLUMN_HIDDEN ? COLUMN_HIDDEN : COLUMN_AUTO;
							columnWidths[0] = COLUMN_AUTO;
							ctx.persistence.saveColumnWidths(columnWidths);
							ctx.renderScheduler.request();
						}
					}
				]
			], true, null, <MouseEvent>e, ctx.dom.view);
		});
	}
}

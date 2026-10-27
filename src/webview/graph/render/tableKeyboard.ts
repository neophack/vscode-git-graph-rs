/**
 * Keyboard interaction with the commit table (F5 accessibility): the grid's roving tabindex and
 * the row-level keys. The commit table is the view's primary data grid, so it must be operable
 * with the keyboard alone:
 *
 *   - Tab enters the grid at the row carrying the roving tab stop (exactly one rendered row has
 *     tabindex="0"; every other row is tabindex="-1"), and Tab / Shift+Tab leave it again. The
 *     tab stop survives re-renders: it follows the focused commit by HASH (the same key the
 *     keyed row patches use), and when that commit is not rendered the stop falls to the first
 *     rendered row so Tab always enters the grid.
 *   - ArrowUp / ArrowDown move focus one commit, PageUp / PageDown one page, Home / End to the
 *     first / last commit - across the windowed render's boundary: moving to a commit outside
 *     the rendered window scrolls it into view first (which re-renders the window around it), so
 *     navigation spans the whole loaded history, not just the rendered rows.
 *   - Enter activates the focused row (opens or closes its Commit Details View) by dispatching
 *     the same click event the mouse uses, so keyboard and mouse share one behaviour.
 *   - Shift+F10 / the ContextMenu key open the row's context menu by dispatching the same
 *     context menu event a right-click uses, positioned at the row.
 *
 * The listeners are delegated onto the table's container element, so they survive every row
 * reconciliation without re-binding; keys the table does not own (Ctrl+Arrow with an open
 * Commit Details View, the configured Ctrl+ shortcuts, Escape) are left to the existing
 * document-level handler untouched.
 */

import { handledEvent } from '../../common/dom';
import { GraphContext } from '../context';
import { measureBoundingClientRect, measureClientSize } from '../render/measure';

/** The rows of the grid: one per commit (the header row and the window spacers are not rows of it). */
const ROW_SELECTOR = 'tr.commit';

export class TableKeyboard {
	/** The commit (by hash) that carries the roving tab stop; NULL until a row was focused. */
	private tabStopHash: string | null = null;

	constructor(private readonly ctx: () => GraphContext) { }

	/** Attach the delegated listeners to the table's container element (once per view). */
	public attach(container: HTMLElement) {
		container.addEventListener('keydown', (e) => this.onKeyDown(e));
		container.addEventListener('focusin', (e) => this.onFocusIn(e));
	}

	/**
	 * After a table reconciliation, keep exactly one rendered commit row as the grid's tab stop:
	 * the focused commit's row when it is rendered, otherwise the first rendered row (so Tab still
	 * enters the grid after the focused commit scrolled out of the windowed render).
	 */
	public syncRovingTabindex() {
		const rows = this.ctx().dom.table.querySelectorAll<HTMLElement>(ROW_SELECTOR);
		if (rows.length === 0) return;
		let tabStop: HTMLElement | null = null;
		if (this.tabStopHash !== null) {
			for (let i = 0; i < rows.length; i++) {
				if (rows[i].dataset.hash === this.tabStopHash) {
					tabStop = rows[i];
					break;
				}
			}
		}
		if (tabStop === null) {
			tabStop = rows[0];
			this.tabStopHash = tabStop.dataset.hash !== undefined ? tabStop.dataset.hash : null;
		}
		for (let i = 0; i < rows.length; i++) rows[i].tabIndex = rows[i] === tabStop ? 0 : -1;
	}


	/* Events */

	private onKeyDown(e: KeyboardEvent) {
		const target = <Element | null>e.target;
		if (target === null) return;
		const row = <HTMLElement | null>target.closest(ROW_SELECTOR);
		if (row === null || row.dataset.id === undefined) return;
		const store = this.ctx().store;
		const from = parseInt(row.dataset.id, 10);
		if (isNaN(from) || from < 0 || from >= store.commits.length) return;

		// Ctrl/Cmd+Arrow and the Ctrl/Cmd shortcuts keep their existing meanings (walking the
		// details view along the graph, refresh, find, ...): the grid owns the unmodified keys.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		switch (e.key) {
			case 'ArrowDown': this.moveFocus(from, from + 1); break;
			case 'ArrowUp': this.moveFocus(from, from - 1); break;
			case 'PageDown': this.moveFocus(from, from + this.pageRows()); break;
			case 'PageUp': this.moveFocus(from, from - this.pageRows()); break;
			case 'Home': this.moveFocus(from, 0); break;
			case 'End': this.moveFocus(from, store.commits.length - 1); break;
			case 'Enter':
				// Activate the row exactly as a mouse click would (opens the Commit Details View,
				// closes it again when this row's is already open): the click handlers of the table
				// own the behaviour, the grid only routes the key to them
				row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				break;
			case 'F10':
				if (e.shiftKey) this.openRowContextMenu(row);
				else return; // plain F10 stays with the application menu
				break;
			case 'ContextMenu': this.openRowContextMenu(row); break;
			default: return; // a key the grid does not own: leave it to whoever else handles it
		}
		// The grid acted on the key: don't let it also scroll the page or reach the other handlers
		handledEvent(e);
	}

	private onFocusIn(e: FocusEvent) {
		const target = <Element | null>e.target;
		if (target === null) return;
		const row = <HTMLElement | null>target.closest(ROW_SELECTOR);
		if (row === null) return;
		this.tabStopHash = row.dataset.hash !== undefined ? row.dataset.hash : null;
		if (row.tabIndex !== 0) this.applyRovingTabindex(row);
	}


	/* Focus movement */

	/** Move the row focus from commit `from` to commit `to` (clamped to the loaded history). */
	private moveFocus(from: number, to: number) {
		const store = this.ctx().store;
		to = Math.min(store.commits.length - 1, Math.max(0, to));
		if (to === from) return; // an edge of the history: swallow the key, move nothing
		this.focusCommit(to);
	}

	/** Focus the commit at `index`, scrolling it into the rendered window first when needed. */
	private focusCommit(index: number) {
		const ctx = this.ctx(), store = ctx.store;
		if (index < 0 || index >= store.commits.length) return;
		let elem = ctx.table.findCommitElem(index);
		if (elem === null) {
			// Outside the rendered window (windowed rendering): bring the commit in. The scroll
			// re-renders the window around it synchronously, so the row exists right after.
			ctx.viewport.scrollToCommit(store.commits[index].hash, false);
			elem = ctx.table.findCommitElem(index);
		}
		if (elem === null) return;
		this.tabStopHash = store.commits[index].hash;
		this.applyRovingTabindex(elem);
		elem.focus();
	}

	/** Make `focused` the grid's only tabbable row. */
	private applyRovingTabindex(focused: HTMLElement) {
		const rows = this.ctx().dom.table.querySelectorAll<HTMLElement>(ROW_SELECTOR);
		for (let i = 0; i < rows.length; i++) rows[i].tabIndex = rows[i] === focused ? 0 : -1;
	}

	/** The number of commits one PageUp / PageDown moves: the visible rows minus the row stayed on. */
	private pageRows() {
		const ctx = this.ctx();
		const rowHeight = ctx.layout.getRowHeight();
		if (!(rowHeight > 0)) return 1;
		return Math.max(1, Math.floor(measureClientSize(ctx.dom.view).height / rowHeight) - 1);
	}

	/** Open the focused row's context menu where the row sits on screen (the right-click path). */
	private openRowContextMenu(row: HTMLElement) {
		const rect = measureBoundingClientRect(row);
		row.dispatchEvent(new MouseEvent('contextmenu', {
			bubbles: true,
			cancelable: true,
			clientX: Math.round(rect.left + rect.width / 2),
			clientY: Math.round(rect.top + rect.height / 2)
		}));
	}
}

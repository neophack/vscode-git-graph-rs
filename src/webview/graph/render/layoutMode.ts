/**
 * The layout the commit table is rendered in: the wide (desktop) layout, or the narrow window
 * (mobile) layout the `mobileAdaptation` Extension Setting enables below NARROW_WINDOW_MAX_WIDTH.
 * The layout is decided once per render, so everything that reasons about the rows in the DOM -
 * their height, the Commit Details View placement - agrees with what is actually on screen, even
 * mid-resize.
 */

import { alterClass, CLASS_MOBILE_MODE } from '../../common/dom';
import * as GG from '../../common/protocol';
import { Store } from '../state/store';

const NARROW_WINDOW_MAX_WIDTH = 600;
/** The two-line commit row of the mobile layout: subject + meta line, above the 48px touch minimum. */
const MOBILE_ROW_HEIGHT = 52;

export const COLUMN_HIDDEN = -100;
export const COLUMN_AUTO = -101;

export interface ColumnVisibility {
	readonly date: boolean;
	readonly author: boolean;
	readonly commit: boolean;
}

export class LayoutMode {
	/** Whether the last render used the narrow window (mobile) layout. */
	private renderedNarrowWindow = false;

	constructor(private readonly store: Store, private readonly viewElem: HTMLElement) { }

	/**
	 * Should the commit table use the narrow window (mobile) layout? Active only while the
	 * `mobileAdaptation` Extension Setting is enabled and the view is at most
	 * NARROW_WINDOW_MAX_WIDTH pixels wide. An unmeasured view (width 0: a hidden background tab)
	 * keeps the wide layout, so the columns don't flash away and back on the next show.
	 */
	public isNarrowWindow() {
		if (!this.store.config.mobileAdaptation) return false;
		const width = this.viewElem.clientWidth || document.documentElement.clientWidth;
		return width > 0 && width <= NARROW_WINDOW_MAX_WIDTH;
	}

	/** Is the mobile layout currently rendered. */
	public isMobileLayout() {
		return this.renderedNarrowWindow;
	}

	/**
	 * The uniform height of a commit row in the current layout: the configured graph.rowHeight,
	 * or the taller two-line row of the mobile layout (a 48px+ touch target).
	 */
	public getRowHeight() {
		return this.renderedNarrowWindow ? MOBILE_ROW_HEIGHT : this.store.config.graph.rowHeight;
	}

	/**
	 * Switch the rendered layout between the wide and the mobile one: the <body> classes the
	 * mobile styles key on, the row height CSS variable, and - when the layout actually changes -
	 * the graph grid, so the vertices line up with the new rows before the next render gets to
	 * measure them.
	 */
	public apply(narrow: boolean) {
		const changed = narrow !== this.renderedNarrowWindow;
		this.renderedNarrowWindow = narrow;
		alterClass(document.body, 'narrowWindow', narrow);
		alterClass(document.body, CLASS_MOBILE_MODE, narrow);
		document.body.style.setProperty('--git-graph-rowHeight', this.getRowHeight() + 'px');
		if (changed) this.resetGraphRowGrid();
	}

	/** Set the graph grid's row pitch to the current layout's row height (until a render measures it). */
	public resetGraphRowGrid() {
		const rowHeight = this.getRowHeight(), grid = this.store.config.graph.grid;
		grid.y = rowHeight;
		grid.offsetY = rowHeight / 2;
	}

	/** Which of the optional columns (Date, Author, Commit) are visible. */
	public getColumnVisibility(): ColumnVisibility {
		if (this.isNarrowWindow()) {
			// Narrow window (mobile) layout: the Date, Author and Commit columns are hidden so the
			// graph and the commit messages fit a phone-width view; the wide layout is unchanged
			return { date: false, author: false, commit: false };
		}
		const colWidths = this.store.repoState.columnWidths;
		if (colWidths !== null) {
			return { date: colWidths[1] !== COLUMN_HIDDEN, author: colWidths[2] !== COLUMN_HIDDEN, commit: colWidths[3] !== COLUMN_HIDDEN };
		} else {
			const defaults = this.store.config.defaultColumnVisibility;
			return { date: defaults.date, author: defaults.author, commit: defaults.commit };
		}
	}

	/** The number of columns of the commit table. */
	public getNumColumns() {
		const colVisibility = this.getColumnVisibility();
		return 2 + (colVisibility.date ? 1 : 0) + (colVisibility.author ? 1 : 0) + (colVisibility.commit ? 1 : 0);
	}

	/** Is the Commit Details View docked to the bottom (always in the mobile layout, where it is a full-screen sheet). */
	public isCdvDocked() {
		return this.store.config.commitDetailsView.location === GG.CommitDetailsViewLocation.DockedToBottom || this.isMobileLayout();
	}
}

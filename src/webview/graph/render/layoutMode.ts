/**
 * The layout the commit table is rendered in. Narrow windows take the touch layouts on their own:
 * up to NARROW_WINDOW_MAX_WIDTH the phone layout (nothing of the wide layout fits a phone-width
 * view), up to TABLET_LAYOUT_MAX_WIDTH the tablet layout (the wide toolbar's fixed furniture -
 * three dropdowns pinned at their 138px minimum plus the absolutely positioned button strip -
 * needs ~900px to stop covering the centered controls), and a touch-primary screen (a tablet at
 * any width, `pointer: coarse`) the tablet layout too. The `mobileAdaptation` Extension Setting
 * opts IN everywhere: with it on, every width above the phone breakpoint gets the tablet layout.
 *
 * The layout is decided once per render, so everything that reasons about the rows in the DOM -
 * their height, the Commit Details View placement - agrees with what is actually on screen, even
 * mid-resize.
 */

import { alterClass, CLASS_MOBILE_MODE, CLASS_TABLET_MODE, CLASS_TOUCH_MODE } from '../../common/dom';
import * as GG from '../../common/protocol';
import { Store } from '../state/store';
import { measureClientSize } from './measure';

/** The wide (desktop) layout, or one of the two touch layouts (narrow windows, coarse pointers, the setting). */
export type LayoutKind = 'wide' | 'phone' | 'tablet';

const NARROW_WINDOW_MAX_WIDTH = 600;
/**
 * Below this width the wide layout cannot hold together: the centered toolbar controls and the
 * absolutely positioned button cluster start covering each other, and the Date/Author columns'
 * shrunk 80-100px widths still leave the description too little room. The tablet layout - which
 * measures its toolbar and overflows what does not fit into the "More actions" sheet - takes over.
 */
const TABLET_LAYOUT_MAX_WIDTH = 900;
/** The two-line commit row of the phone layout: subject + meta line, above the 48px touch minimum. */
const MOBILE_ROW_HEIGHT = 52;
/** The single-line commit row of the tablet layout: compact, yet a comfortable full-width touch target. */
const TABLET_ROW_HEIGHT = 40;
/** The bounds of the tablet layout's Commit Details side pane, and its share of the window width. */
const SIDE_PANE_MIN_WIDTH = 320, SIDE_PANE_MAX_WIDTH = 460, SIDE_PANE_SHARE = 0.4;
/** The <body> class the tablet stylesheet keys on while the side pane is open. */
const CLASS_SIDE_PANE_OPEN = 'sidePaneOpen';

export const COLUMN_HIDDEN = -100;
export const COLUMN_AUTO = -101;

/** The coarse-pointer media query, resolved once and re-read on every decision (a detachable
 *  tablet can switch its primary pointer while the view lives). */
let coarsePointerQuery: MediaQueryList | null | undefined;

/** Is the screen's PRIMARY pointer coarse (a finger: a tablet or phone screen, not mouse desktops)? */
function isCoarsePrimaryPointer(): boolean {
	if (coarsePointerQuery === undefined) {
		coarsePointerQuery = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
	}
	return coarsePointerQuery !== null && coarsePointerQuery.matches;
}

export interface ColumnVisibility {
	readonly date: boolean;
	readonly author: boolean;
	readonly commit: boolean;
}

export class LayoutMode {
	/** The layout the last render used. */
	private rendered: LayoutKind = 'wide';
	/** The width the open side pane takes from the view (0 while it is closed). */
	private sidePaneWidth = 0;
	/** Whether the last render used the two-line rows (see isTwoLineRows). */
	private renderedTwoLine = false;

	constructor(private readonly store: Store, private readonly viewElem: HTMLElement) { }

	/**
	 * The layout the view should use now. An unmeasured view (width 0: a hidden background tab)
	 * keeps the wide layout, so the columns don't flash away and back on the next show. The open
	 * side pane narrows the view, so its width is added back: the layout follows the window,
	 * never the pane it opened itself.
	 */
	public decide(): LayoutKind {
		const width = this.getWindowWidth();
		if (width <= 0) return 'wide';
		if (width <= NARROW_WINDOW_MAX_WIDTH) return 'phone';
		if (this.store.config.mobileAdaptation || width <= TABLET_LAYOUT_MAX_WIDTH || isCoarsePrimaryPointer()) return 'tablet';
		return 'wide';
	}

	/** Should the commit table use the narrow window (phone) layout? */
	public isNarrowWindow() {
		return this.decide() === 'phone';
	}

	/** The layout currently rendered. */
	public getRenderedLayout(): LayoutKind {
		return this.rendered;
	}

	/** Is the phone layout currently rendered. */
	public isMobileLayout() {
		return this.rendered === 'phone';
	}

	/** Is the tablet layout currently rendered. */
	public isTabletLayout() {
		return this.rendered === 'tablet';
	}

	/**
	 * Are the commit rows the two-line rows (subject + date, then refs, author and hash): always on
	 * a phone, and on a tablet while the side pane is open - the pane leaves the description column
	 * too little room for the single-line row's Date, Author and Commit columns.
	 */
	public isTwoLineRows() {
		return this.rendered === 'phone' || (this.rendered === 'tablet' && this.sidePaneWidth > 0);
	}

	/** Is one of the touch layouts (phone or tablet) currently rendered. */
	public isTouchLayout() {
		return this.rendered !== 'wide';
	}

	/**
	 * The uniform height of a commit row in the current layout: the configured graph.rowHeight,
	 * the taller two-line row of the phone layout, or the single-line touch row of the tablet layout.
	 */
	public getRowHeight() {
		switch (this.rendered) {
			case 'phone':
				return MOBILE_ROW_HEIGHT;
			case 'tablet':
				if (this.sidePaneWidth > 0) return MOBILE_ROW_HEIGHT;
				return Math.max(TABLET_ROW_HEIGHT, this.store.config.graph.rowHeight);
			default:
				return this.store.config.graph.rowHeight;
		}
	}

	/**
	 * Switch the rendered layout: the <body> classes the touch styles key on, the row height CSS
	 * variable, the side pane width, and - when the layout actually changes - the graph grid, so the
	 * vertices line up with the new rows before the next render gets to measure them.
	 */
	public apply(kind: LayoutKind) {
		const changed = kind !== this.rendered;
		this.rendered = kind;
		if (kind !== 'tablet') this.closeSidePane();
		alterClass(document.body, 'narrowWindow', kind === 'phone');
		alterClass(document.body, CLASS_MOBILE_MODE, kind === 'phone');
		alterClass(document.body, CLASS_TABLET_MODE, kind === 'tablet');
		alterClass(document.body, CLASS_TOUCH_MODE, kind !== 'wide');
		const twoLine = this.isTwoLineRows();
		const rowsChanged = twoLine !== this.renderedTwoLine;
		this.renderedTwoLine = twoLine;
		document.body.style.setProperty('--git-graph-rowHeight', this.getRowHeight() + 'px');
		if (kind === 'tablet') {
			const paneWidth = Math.round(Math.min(SIDE_PANE_MAX_WIDTH, Math.max(SIDE_PANE_MIN_WIDTH, this.getWindowWidth() * SIDE_PANE_SHARE)));
			document.body.style.setProperty('--gg-pane-width', paneWidth + 'px');
			if (this.sidePaneWidth > 0) this.sidePaneWidth = paneWidth;
		}
		if (changed || rowsChanged) this.resetGraphRowGrid();
	}

	/** Set the graph grid's row pitch to the current layout's row height (until a render measures it). */
	public resetGraphRowGrid() {
		const rowHeight = this.getRowHeight(), grid = this.store.config.graph.grid;
		grid.y = rowHeight;
		grid.offsetY = rowHeight / 2;
	}

	/** Which of the optional columns (Date, Author, Commit) are visible. */
	public getColumnVisibility(): ColumnVisibility {
		if (this.isNarrowWindow() || this.isTwoLineRows()) {
			// Two-line rows (phone layout, or the tablet with its side pane open): the Date, Author and Commit columns are hidden so the graph and the
			// commit messages fit a phone-width view; the wide and tablet layouts are unchanged
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

	/**
	 * Is the Commit Details View docked rather than inline in the table: as configured, and always
	 * in the touch layouts - a full-screen sheet on a phone, the side pane on a tablet.
	 */
	public isCdvDocked() {
		return this.store.config.commitDetailsView.location === GG.CommitDetailsViewLocation.DockedToBottom || this.isTouchLayout();
	}

	/** Is the docked Commit Details View the tablet layout's side pane (beside the list, not below it). */
	public isCdvSidePane() {
		return this.isTabletLayout();
	}

	/** Reserve the side pane's width beside the commit list (the tablet layout's list-detail split). */
	public openSidePane() {
		const paneWidth = parseInt(document.body.style.getPropertyValue('--gg-pane-width'), 10);
		this.sidePaneWidth = paneWidth > 0 ? paneWidth : SIDE_PANE_MIN_WIDTH;
		alterClass(document.body, CLASS_SIDE_PANE_OPEN, true);
	}

	/** Give the side pane's width back to the commit list. */
	public closeSidePane() {
		this.sidePaneWidth = 0;
		alterClass(document.body, CLASS_SIDE_PANE_OPEN, false);
	}

	/** The width the view would have without the side pane: the window the layout is chosen for. */
	private getWindowWidth() {
		const viewWidth = measureClientSize(this.viewElem).width;
		return viewWidth > 0 ? viewWidth + this.sidePaneWidth : measureClientSize(document.documentElement).width;
	}
}

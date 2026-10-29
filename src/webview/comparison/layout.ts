/**
 * The layout decision of the Commit Comparison View page: the same breakpoints and signals the
 * graph view uses (see src/webview/graph/render/layoutMode.ts), so the two pages never disagree
 * about what "phone" and "tablet" mean. Narrow windows take the touch layouts on their own: up
 * to PHONE_MAX_WIDTH the phone layout (the sidebar becomes the full-screen files sheet, nothing
 * of the side-by-side split fits a phone-width view), up to TABLET_MAX_WIDTH the tablet layout
 * (touch-sized rows and controls over the unchanged split), and a touch-primary screen
 * (`pointer: coarse`, a tablet at any width) the tablet layout too. The `mobileAdaptation`
 * Extension Setting — delivered by the boot `init` message, read at open time — opts IN
 * everywhere above the breakpoints.
 *
 * The decision is re-taken at boot, when the `init` message delivers the setting, and on every
 * window resize, so a rotated or resized window moves between the layouts live. The
 * coarse-pointer media query is re-read per decision; a pointer switch with no accompanying
 * resize therefore takes effect at the next decision, not the moment it happens (this page
 * renders once, unlike the graph view's per-render decision).
 */

import { alterClass, CLASS_MOBILE_MODE, CLASS_TABLET_MODE, CLASS_TOUCH_MODE } from '../common/dom';

/** The wide (desktop) layout, or one of the two touch layouts (narrow windows, coarse pointers, the setting). */
export type ComparisonLayoutKind = 'wide' | 'phone' | 'tablet';

const PHONE_MAX_WIDTH = 600;
const TABLET_MAX_WIDTH = 900;
/** The <body> class the phone stylesheet keys on while the files sheet is open. */
const CLASS_FILES_SHEET_OPEN = 'filesSheetOpen';

/** The coarse-pointer media query, resolved once and re-read on every decision (see layoutMode.ts). */
let coarsePointerQuery: MediaQueryList | null | undefined;

/** Is the screen's PRIMARY pointer coarse (a finger: a tablet or phone screen, not mouse desktops)? */
function isCoarsePrimaryPointer(): boolean {
	if (coarsePointerQuery === undefined) {
		coarsePointerQuery = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
	}
	return coarsePointerQuery !== null && coarsePointerQuery.matches;
}

export class ComparisonLayout {
	/** The `mobileAdaptation` Extension Setting as the boot `init` message delivered it. */
	private mobileAdaptation = false;
	/** The layout currently applied. */
	private rendered: ComparisonLayoutKind = 'wide';

	public constructor() {
		this.apply(this.decide());
		// A rotated or resized window crosses the breakpoints live; the diff view's own
		// side-by-side breakpoint is watched separately (see DiffView's ResizeObserver).
		window.addEventListener('resize', () => this.apply(this.decide()));
	}

	/**
	 * The layout the page should use now: an unmeasured window (width 0) keeps the wide layout,
	 * so nothing flashes away before the first measure.
	 */
	public decide(): ComparisonLayoutKind {
		const width = window.innerWidth;
		if (width <= 0) return 'wide';
		if (width <= PHONE_MAX_WIDTH) return 'phone';
		if (this.mobileAdaptation || width <= TABLET_MAX_WIDTH || isCoarsePrimaryPointer()) return 'tablet';
		return 'wide';
	}

	/** The layout currently applied. */
	public isPhoneLayout() {
		return this.rendered === 'phone';
	}

	/**
	 * Take the setting the boot `init` message delivered and re-decide: above the breakpoints it
	 * opts the page into the tablet layout, exactly as it does in the graph view.
	 */
	public setMobileAdaptation(enabled: boolean) {
		this.mobileAdaptation = enabled;
		this.apply(this.decide());
	}

	/**
	 * Switch the applied layout: the <body> classes the touch styles key on. Leaving the phone
	 * layout closes the files sheet (the sheet is phone-only furniture).
	 */
	public apply(kind: ComparisonLayoutKind) {
		this.rendered = kind;
		if (kind !== 'phone') this.closeFilesSheet();
		alterClass(document.body, CLASS_MOBILE_MODE, kind === 'phone');
		alterClass(document.body, CLASS_TABLET_MODE, kind === 'tablet');
		alterClass(document.body, CLASS_TOUCH_MODE, kind !== 'wide');
	}

	/** Open the phone layout's full-screen files sheet (the file tree sidebar). */
	public openFilesSheet() {
		if (!this.isPhoneLayout()) return;
		alterClass(document.body, CLASS_FILES_SHEET_OPEN, true);
	}

	/** Close the files sheet (a no-op when it is closed, or the layout is not the phone's). */
	public closeFilesSheet() {
		alterClass(document.body, CLASS_FILES_SHEET_OPEN, false);
	}
}

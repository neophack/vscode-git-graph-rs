// @vitest-environment jsdom
/**
 * The narrow-window layout decision (src/webview/graph/render/layoutMode.ts), ported
 * from the layout cases of tests/webviewMobileAdaptation.test.mjs: narrow windows take the
 * touch layouts on their own - at most 600 pixels wide the phone layout, at most 900 the tablet
 * layout - and a touch-primary (coarse pointer) screen gets the tablet layout at any width. The
 * `mobileAdaptation` Extension Setting opts IN everywhere above the phone breakpoint. The
 * decision drives the <body> classes the mobile styles key on, the row height CSS variable, the
 * visibility of the Date / Author / Commit columns and where the Commit Details View lives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as GG from '../../common/protocol';
import type { Store } from '../state/store';
import { LayoutMode } from './layoutMode';

const ROW_HEIGHT = 24;
const MOBILE_ROW_HEIGHT = 52;
const TABLET_ROW_HEIGHT = 40;

/** The coarse-pointer answer the (jsdom-absent) matchMedia stub gives; flipped per test. */
let coarsePointer = false;
vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
	media: query,
	get matches() { return query === '(pointer: coarse)' ? coarsePointer : false; },
	onchange: null,
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
	addListener: () => undefined,
	removeListener: () => undefined,
	dispatchEvent: () => false
}));

/** A store carrying only the settings the layout decision reads. */
function makeStore(mobileAdaptation: boolean) {
	return {
		config: {
			mobileAdaptation: mobileAdaptation,
			graph: { rowHeight: ROW_HEIGHT, grid: { x: 10, y: ROW_HEIGHT, offsetX: 8, offsetY: ROW_HEIGHT / 2, expandY: 100 } },
			defaultColumnVisibility: { date: true, author: true, commit: true },
			commitDetailsView: { location: GG.CommitDetailsViewLocation.Inline }
		},
		repoState: { columnWidths: null }
	} as unknown as Store;
}

/** A view element whose emulated width jsdom cannot measure itself. */
function makeViewElem(width: number) {
	const elem = document.createElement('div');
	Object.defineProperty(elem, 'clientWidth', { get: () => width, configurable: true });
	return elem;
}

beforeEach(() => {
	document.body.textContent = '';
	document.body.className = '';
	document.body.removeAttribute('style');
	coarsePointer = false;
});

describe('the phone and tablet (narrow window) layout decision', () => {
	it('adapts narrow windows while the setting is disabled: phone, then tablet, then wide', () => {
		const phone = new LayoutMode(makeStore(false), makeViewElem(400));
		expect(phone.decide()).toBe('phone');
		expect(phone.isNarrowWindow()).toBe(true);

		const tablet = new LayoutMode(makeStore(false), makeViewElem(700));
		expect(tablet.decide()).toBe('tablet');
		expect(tablet.isNarrowWindow()).toBe(false);

		// A wide window with a fine (mouse) pointer keeps the wide layout while the setting is off
		const wide = new LayoutMode(makeStore(false), makeViewElem(1200));
		expect(wide.decide()).toBe('wide');
		wide.apply('wide');
		expect(document.body.className).toBe('');
		expect(wide.isTouchLayout()).toBe(false);
		expect(wide.getRowHeight()).toBe(ROW_HEIGHT);
		expect(wide.getColumnVisibility()).toEqual({ date: true, author: true, commit: true });
		expect(wide.getNumColumns()).toBe(5);
		expect(wide.isCdvDocked()).toBe(false); // as configured (inline)
	});

	it('gives a touch-primary (coarse pointer) screen the tablet layout at any width', () => {
		coarsePointer = true;
		expect(new LayoutMode(makeStore(false), makeViewElem(1200)).decide()).toBe('tablet');
		expect(new LayoutMode(makeStore(false), makeViewElem(2400)).decide()).toBe('tablet');
		// the phone breakpoint wins over the pointer: a phone-width window is a phone
		expect(new LayoutMode(makeStore(false), makeViewElem(400)).decide()).toBe('phone');
	});

	it('switches to the phone layout in a narrow view: classes, row height, hidden columns, docked details', () => {
		const store = makeStore(true);
		const layout = new LayoutMode(store, makeViewElem(400));
		expect(layout.decide()).toBe('phone');
		expect(layout.isNarrowWindow()).toBe(true);
		layout.apply('phone');

		expect(document.body.classList.contains('narrowWindow')).toBe(true);
		expect(document.body.classList.contains('mobileMode')).toBe(true);
		expect(document.body.classList.contains('touchMode')).toBe(true);
		expect(document.body.classList.contains('tabletMode')).toBe(false);
		expect(document.body.style.getPropertyValue('--git-graph-rowHeight')).toBe(MOBILE_ROW_HEIGHT + 'px');
		expect(layout.getRowHeight()).toBe(MOBILE_ROW_HEIGHT);
		expect(layout.getColumnVisibility()).toEqual({ date: false, author: false, commit: false });
		expect(layout.getNumColumns()).toBe(2);
		// The Commit Details View is always a full-screen (docked) sheet in the mobile layout
		expect(layout.isCdvDocked()).toBe(true);
		// The graph grid follows the new row pitch until a render measures it
		expect(store.config.graph.grid.y).toBe(MOBILE_ROW_HEIGHT);
		expect(store.config.graph.grid.offsetY).toBe(MOBILE_ROW_HEIGHT / 2);
	});

	it('switches to the tablet layout above the breakpoint: classes, touch row height, every column, the side pane', () => {
		const store = makeStore(true);
		const layout = new LayoutMode(store, makeViewElem(1000));
		expect(layout.decide()).toBe('tablet');
		expect(layout.isNarrowWindow()).toBe(false);
		layout.apply('tablet');

		expect(document.body.classList.contains('tabletMode')).toBe(true);
		expect(document.body.classList.contains('touchMode')).toBe(true);
		expect(document.body.classList.contains('mobileMode')).toBe(false);
		expect(document.body.classList.contains('narrowWindow')).toBe(false);
		expect(layout.isTabletLayout()).toBe(true);
		expect(layout.isMobileLayout()).toBe(false);
		expect(layout.getRowHeight()).toBe(TABLET_ROW_HEIGHT);
		expect(document.body.style.getPropertyValue('--git-graph-rowHeight')).toBe(TABLET_ROW_HEIGHT + 'px');
		// A tablet keeps every column on one line, as the wide layout does
		expect(layout.getColumnVisibility()).toEqual({ date: true, author: true, commit: true });
		expect(layout.getNumColumns()).toBe(5);
		// The Commit Details View is the side pane, 40% of the window (within its bounds)
		expect(layout.isCdvDocked()).toBe(true);
		expect(layout.isCdvSidePane()).toBe(true);
		expect(document.body.style.getPropertyValue('--gg-pane-width')).toBe('400px');
		expect(store.config.graph.grid.y).toBe(TABLET_ROW_HEIGHT);
	});

	it('keeps a taller configured row height in the tablet layout', () => {
		const store = makeStore(true);
		(store.config.graph as { rowHeight: number }).rowHeight = 48;
		const layout = new LayoutMode(store, makeViewElem(1000));
		layout.apply('tablet');
		expect(layout.getRowHeight()).toBe(48);
	});

	it('bounds the side pane width on very narrow and very wide windows', () => {
		new LayoutMode(makeStore(true), makeViewElem(640)).apply('tablet');
		expect(document.body.style.getPropertyValue('--gg-pane-width')).toBe('320px');
		new LayoutMode(makeStore(true), makeViewElem(2400)).apply('tablet');
		expect(document.body.style.getPropertyValue('--gg-pane-width')).toBe('460px');
	});

	it('decides by the window, not by the list the open side pane narrowed', () => {
		const viewElem = makeViewElem(900);
		const layout = new LayoutMode(makeStore(true), viewElem);
		layout.apply('tablet');
		layout.openSidePane();
		expect(document.body.classList.contains('sidePaneOpen')).toBe(true);

		// The pane takes 360px of the 900px window: the 540px list must not flip the view to the phone layout
		Object.defineProperty(viewElem, 'clientWidth', { get: () => 540, configurable: true });
		expect(layout.decide()).toBe('tablet');

		layout.closeSidePane();
		expect(document.body.classList.contains('sidePaneOpen')).toBe(false);
	});

	it('moves between the phone and tablet layouts as the view crosses the breakpoint', () => {
		const viewElem = makeViewElem(400);
		const layout = new LayoutMode(makeStore(true), viewElem);
		layout.apply(layout.decide());
		expect(layout.isMobileLayout()).toBe(true);

		Object.defineProperty(viewElem, 'clientWidth', { get: () => 1200, configurable: true });
		expect(layout.decide()).toBe('tablet');
		layout.apply('tablet');

		expect(document.body.classList.contains('narrowWindow')).toBe(false);
		expect(document.body.classList.contains('mobileMode')).toBe(false);
		expect(document.body.classList.contains('tabletMode')).toBe(true);
		expect(document.body.style.getPropertyValue('--git-graph-rowHeight')).toBe(TABLET_ROW_HEIGHT + 'px');
		expect(layout.getColumnVisibility()).toEqual({ date: true, author: true, commit: true });
	});

	it('restores the original layout when the setting is turned off', () => {
		const store = makeStore(true);
		const layout = new LayoutMode(store, makeViewElem(1200));
		layout.apply(layout.decide());
		layout.openSidePane();

		(store.config as { mobileAdaptation: boolean }).mobileAdaptation = false;
		expect(layout.decide()).toBe('wide');
		layout.apply('wide');

		expect(document.body.className).toBe('');
		expect(layout.getRowHeight()).toBe(ROW_HEIGHT);
		expect(layout.isCdvDocked()).toBe(false);
	});

	it('keeps the tablet layout at every width while the setting is on (a tablet at any size)', () => {
		expect(new LayoutMode(makeStore(true), makeViewElem(2400)).decide()).toBe('tablet');
	});

	it('keeps the wide layout for an unmeasured view (width 0, a hidden background tab)', () => {
		const layout = new LayoutMode(makeStore(true), makeViewElem(0));
		expect(layout.decide()).toBe('wide');
		expect(layout.isNarrowWindow()).toBe(false);
	});

	it('honours the per-repository column widths in the wide layout', () => {
		const store = makeStore(false);
		store.repoState.columnWidths = [-100, 200, 150, -100]; // Graph, Date, Author, Commit
		const layout = new LayoutMode(store, makeViewElem(1200));
		expect(layout.getColumnVisibility()).toEqual({ date: true, author: true, commit: false });
		expect(layout.getNumColumns()).toBe(4);
	});
});

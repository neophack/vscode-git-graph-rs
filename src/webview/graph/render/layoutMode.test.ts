// @vitest-environment jsdom
/**
 * The narrow-window (mobile) layout decision (src/webview/graph/render/layoutMode.ts), ported
 * from the layout cases of tests/webviewMobileAdaptation.test.mjs: the `mobileAdaptation`
 * Extension Setting switches the view to a touch-first phone layout while it is at most 600
 * pixels wide, and back when it widens again - while the setting is disabled the display never
 * changes. The decision drives the <body> classes the mobile styles key on, the row height CSS
 * variable, the visibility of the Date / Author / Commit columns and where the Commit Details
 * View lives.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import * as GG from '../../common/protocol';
import type { Store } from '../state/store';
import { LayoutMode } from './layoutMode';

const ROW_HEIGHT = 24;
const MOBILE_ROW_HEIGHT = 52;

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
});

describe('the narrow window (mobileAdaptation) layout decision', () => {
	it('leaves the display untouched while the setting is disabled, even below the breakpoint', () => {
		const layout = new LayoutMode(makeStore(false), makeViewElem(400));
		expect(layout.isNarrowWindow()).toBe(false);
		layout.apply(layout.isNarrowWindow());

		expect(document.body.classList.contains('narrowWindow')).toBe(false);
		expect(document.body.classList.contains('mobileMode')).toBe(false);
		expect(layout.getRowHeight()).toBe(ROW_HEIGHT);
		expect(layout.getColumnVisibility()).toEqual({ date: true, author: true, commit: true });
		expect(layout.getNumColumns()).toBe(5);
		expect(layout.isCdvDocked()).toBe(false); // as configured (inline)
	});

	it('switches to the mobile layout in a narrow view: classes, row height, hidden columns, docked details', () => {
		const store = makeStore(true);
		const layout = new LayoutMode(store, makeViewElem(400));
		expect(layout.isNarrowWindow()).toBe(true);
		layout.apply(true);

		expect(document.body.classList.contains('narrowWindow')).toBe(true);
		expect(document.body.classList.contains('mobileMode')).toBe(true);
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

	it('restores the wide layout when the view widens past the breakpoint', () => {
		const viewElem = makeViewElem(400);
		const layout = new LayoutMode(makeStore(true), viewElem);
		layout.apply(layout.isNarrowWindow());

		Object.defineProperty(viewElem, 'clientWidth', { get: () => 1200, configurable: true });
		expect(layout.isNarrowWindow()).toBe(false);
		layout.apply(false);

		expect(document.body.classList.contains('narrowWindow')).toBe(false);
		expect(document.body.classList.contains('mobileMode')).toBe(false);
		expect(document.body.style.getPropertyValue('--git-graph-rowHeight')).toBe(ROW_HEIGHT + 'px');
		expect(layout.getColumnVisibility()).toEqual({ date: true, author: true, commit: true });
	});

	it('keeps the wide layout for an unmeasured view (width 0, a hidden background tab)', () => {
		const layout = new LayoutMode(makeStore(true), makeViewElem(0));
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

/**
 * The commit table as a keyboard-operable grid (OPTIMIZATION-PLAN F5): grid semantics with
 * ABSOLUTE row indices across the windowed render, the roving tabindex, the arrow / page / Home /
 * End navigation (including across the virtual window's boundary), Enter opening the Commit
 * Details View through the same message the mouse's click produces, and Shift+F10 opening the
 * row's context menu.
 *
 * These tests drive the real compiled bundle in jsdom (test/support/webviewHost.ts, like the
 * other journeys): `npm run build:dist` must have run first.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { bootView } from '../../support/webviewHost';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Booted = Awaited<ReturnType<typeof bootView>>;

const hashOf = (i: number) => 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The rendered commit rows in DOM order. */
const rowsOf = (h: Booted) => Array.from(h.document.querySelectorAll<HTMLElement>('#commitTable tr.commit'));

/** The commit rows carrying the grid's tab stop (exactly one is expected). */
const tabStopsOf = (h: Booted) => rowsOf(h).filter((row) => row.tabIndex === 0);

function key(h: Booted, elem: Element, keyName: string, modifiers: { shift?: boolean, ctrl?: boolean } = {}) {
	elem.dispatchEvent(new h.window.KeyboardEvent('keydown', {
		key: keyName,
		bubbles: true,
		cancelable: true,
		shiftKey: modifiers.shift === true,
		ctrlKey: modifiers.ctrl === true
	}));
}

describe('the commit table\'s grid semantics', () => {
	it('exposes the table as a grid whose row indices are absolute (header row first)', async () => {
		const h = await bootView(6);
		const grid = h.document.querySelector('#commitTable table');
		assert.ok(grid !== null, 'the table skeleton exists');
		assert.equal(grid.getAttribute('role'), 'grid');
		assert.equal(grid.getAttribute('aria-rowcount'), '7', 'the header row plus the six commits');

		const header = h.document.getElementById('tableColHeaders')!;
		assert.equal(header.getAttribute('role'), 'row');
		assert.equal(header.getAttribute('aria-rowindex'), '1');
		assert.equal(header.querySelectorAll('[role="columnheader"]').length, header.querySelectorAll('th').length);

		const rows = rowsOf(h);
		assert.equal(rows.length, 6);
		rows.forEach((row, i) => {
			assert.equal(row.getAttribute('role'), 'row', 'row ' + i + ' is a grid row');
			assert.equal(row.getAttribute('aria-rowindex'), String(i + 2), 'row ' + i + ' carries its absolute index');
		});
	});

	it('keeps exactly one roving tab stop, on the first row before any focus', async () => {
		const h = await bootView(6);
		const stops = tabStopsOf(h);
		assert.equal(stops.length, 1, 'exactly one rendered row is tabbable');
		assert.equal(stops[0].dataset.id, '0', 'the tab stop starts on the first row');
	});
});

describe('the commit table\'s roving tabindex and row navigation', () => {
	it('moves the tab stop and the focus with the arrow keys, stopping at the ends', async () => {
		const h = await bootView(6);
		const rows = rowsOf(h);
		rows[1].focus();
		assert.equal(h.document.activeElement, rows[1]);

		key(h, rows[1], 'ArrowDown');
		assert.equal(h.document.activeElement, rows[2], 'ArrowDown moved the focus one commit down');
		assert.deepEqual(tabStopsOf(h).map((row) => row.dataset.id), ['2'], 'the tab stop followed');

		key(h, rows[2], 'ArrowUp');
		assert.equal(h.document.activeElement, rows[1], 'ArrowUp moved the focus back');
		key(h, rows[1], 'ArrowUp');
		key(h, rows[0], 'ArrowUp');
		assert.equal(h.document.activeElement, rows[0], 'ArrowUp stops at the first commit');

		// The clamped key is consumed: it must not scroll the page or reach other handlers
		const event = new h.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
		rows[0].dispatchEvent(event);
		assert.equal(event.defaultPrevented, true, 'a handled navigation key is preventDefault-ed');
	});

	it('jumps with Home and End and moves a page with PageUp / PageDown', async () => {
		const h = await bootView(30);
		const rows = rowsOf(h);
		rows[3].focus();

		key(h, h.document.activeElement!, 'End');
		assert.equal((<HTMLElement>h.document.activeElement).dataset.id, '29', 'End focused the last commit');

		key(h, h.document.activeElement!, 'Home');
		assert.equal((<HTMLElement>h.document.activeElement).dataset.id, '0', 'Home focused the first commit');

		// The view is 600px tall with 24px rows: a page is 25 rows, minus the row stayed on
		key(h, h.document.activeElement!, 'PageDown');
		assert.equal((<HTMLElement>h.document.activeElement).dataset.id, '24', 'PageDown moved a page');
		key(h, h.document.activeElement!, 'PageUp');
		assert.equal((<HTMLElement>h.document.activeElement).dataset.id, '0', 'PageUp moved back a page');
	});

	it('opens the Commit Details View on Enter, through the click path\'s message', async () => {
		const h = await bootView(6);
		// Capture everything the view sends (the bundle holds the API object it acquired at boot)
		const sent: any[] = [];
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => {
			sent.push(message);
			return originalPostMessage.call(h.window.VSCODE_API, message);
		};

		const row = h.rows().find((r) => r.dataset.id === '2')!;
		row.focus();
		key(h, row, 'Enter');
		await h.pump(); // the click's 'commitDetails' request, answered like every other

		const request = sent.find((m) => m.command === 'commitDetails');
		assert.ok(request !== undefined, 'Enter dispatched the details request');
		assert.equal(request.commitHash, hashOf(2), 'for the focused row\'s commit');
		assert.ok(h.document.getElementById('cdv') !== null, 'the Commit Details View opened');

		// Enter again on the same row closes it (the same toggle a mouse click performs)
		key(h, row, 'Enter');
		await h.pump();
		assert.equal(h.document.getElementById('cdv'), null, 'the second Enter closed the details view');
	});

	it('opens the row\'s context menu with Shift+F10, as a menu of menuitems', async () => {
		const h = await bootView(6);
		const row = h.rows().find((r) => r.dataset.id === '1')!;
		row.focus();
		key(h, row, 'F10', { shift: true });

		const menu = h.document.querySelector('.contextMenu');
		assert.ok(menu !== null, 'the context menu opened');
		assert.equal(menu.getAttribute('role'), 'menu');
		const items = Array.from(menu.querySelectorAll<HTMLElement>('.contextMenuItem'));
		assert.ok(items.length > 0, 'the commit context menu has items');
		assert.ok(items.every((item) => item.getAttribute('role') === 'menuitem'), 'every item is a menuitem');
		assert.equal(h.document.activeElement, items[0], 'the focus moved to the first item');

		// ArrowDown walks the items
		key(h, items[0], 'ArrowDown');
		assert.equal(h.document.activeElement, items[1], 'ArrowDown moved the menu focus');

		// Escape closes the menu and returns the focus to the invoker row
		h.document.activeElement!.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		assert.equal(h.document.querySelector('.contextMenu'), null, 'Escape closed the menu');
		assert.equal(h.document.activeElement, row, 'the focus returned to the row');
	});
});

describe('the commit table\'s keyboard across the windowed render', () => {
	it('carries absolute aria-rowindex values while only a window of rows is rendered', async () => {
		const h = await bootView(300);
		const rows = rowsOf(h);
		assert.ok(rows.length < 300, 'the render is windowed');
		assert.equal(h.document.querySelector('#commitTable table')!.getAttribute('aria-rowcount'), '301');

		const first = rows[0], last = rows[rows.length - 1];
		assert.equal(first.getAttribute('aria-rowindex'), String(parseInt(first.dataset.id!) + 2));
		assert.equal(last.getAttribute('aria-rowindex'), String(parseInt(last.dataset.id!) + 2));

		// Scrolling moves the window: the indices follow the ABSOLUTE commits, not the DOM order
		await h.scrollTo(100);
		const moved = rowsOf(h);
		assert.ok(parseInt(moved[0].dataset.id!) > 0, 'the window moved down');
		moved.forEach((row) => {
			assert.equal(row.getAttribute('aria-rowindex'), String(parseInt(row.dataset.id!) + 2), 'row ' + row.dataset.id + ' kept its absolute index');
		});
	});

	it('navigates across the window\'s boundary, scrolling the next commit into the render', async () => {
		const h = await bootView(300);
		// The webview scrolls its view element; jsdom has no layout engine, so the harness's
		// no-op scroll stub is replaced by one that moves the emulated scrollTop (and fires the
		// scroll event, like the real element would)
		h.viewElem.scroll = (_x: number, y: number) => {
			h.viewElem.scrollTop = y;
			h.viewElem.dispatchEvent(new h.window.Event('scroll'));
		};

		await h.scrollTo(100); // the window sits somewhere in the middle of the history
		const rendered = rowsOf(h);
		const last = rendered[rendered.length - 1];
		const lastIndex = parseInt(last.dataset.id!);
		last.focus();

		key(h, last, 'ArrowDown');
		const focused = <HTMLElement>h.document.activeElement;
		assert.equal(focused.dataset.id, String(lastIndex + 1), 'ArrowDown moved past the rendered window');
		assert.equal(focused.getAttribute('aria-rowindex'), String(lastIndex + 3), 'the new row carries its absolute index');
		assert.deepEqual(tabStopsOf(h).map((row) => row.dataset.id), [focused.dataset.id], 'and it is the grid\'s only tab stop');

		key(h, focused, 'Home');
		const home = <HTMLElement>h.document.activeElement;
		assert.equal(home.dataset.id, '0', 'Home came back to the first commit');
	});
});

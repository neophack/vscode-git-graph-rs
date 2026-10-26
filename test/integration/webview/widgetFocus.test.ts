/**
 * Widget focus semantics (OPTIMIZATION-PLAN F5): the context menu takes the focus when it opens,
 * is arrow-key navigable, and returns the focus to its invoker when it closes; the dialog is a
 * named modal (role="dialog" + aria-modal) whose focus is trapped while it is open and restored
 * to its invoker when it closes.
 *
 * These tests drive the real compiled bundle in jsdom (test/support/webviewHost.ts, like the
 * other journeys): `npm run build:dist` must have run first.
 */

import assert from 'node:assert/strict';
import { beforeAll, describe, it, vi } from 'vitest';
import { bootView, type BootedView } from '../../support/webviewHost';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Booted = Awaited<ReturnType<typeof bootView>>;

const hashOf = (i: number) => 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function key(h: Booted, elem: Element, keyName: string, modifiers: { shift?: boolean } = {}) {
	elem.dispatchEvent(new h.window.KeyboardEvent('keydown', {
		key: keyName,
		bubbles: true,
		cancelable: true,
		shiftKey: modifiers.shift === true
	}));
}

/** The dialog's focusable elements in tab order (the trap's own definition, mirrored here). */
function dialogFocusables(h: Booted) {
	const dialog = h.document.querySelector('.dialog:not(.closing)')!;
	return Array.from(dialog.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]'))
		.filter((elem) => !elem.matches(':disabled'))
		.filter((elem) => {
			const display = elem.style.display;
			return display !== 'none';
		});
}

describe('the context menu\'s focus', () => {
	it('returns to the focused row when the menu closes via Escape, opened from the keyboard', async () => {
		const h = await bootView(4);
		const row = h.rows().find((r) => r.dataset.id === '1')!;
		row.focus();

		key(h, row, 'ContextMenu'); // the ContextMenu key opens it like Shift+F10 does
		const menu = h.document.querySelector('.contextMenu');
		assert.ok(menu !== null, 'the context menu opened');
		assert.equal(h.document.activeElement, menu.querySelector('.contextMenuItem'), 'the menu took the focus');

		// Escape bubbles to the document-level handler, which closes the menu; the close returns
		// the focus to where the menu was opened from
		key(h, <Element>h.document.activeElement, 'Escape');
		assert.equal(h.document.querySelector('.contextMenu'), null);
		assert.equal(h.document.activeElement, row, 'the focus returned to the invoker row');
	});

	it('walks the items with the arrow keys, wrapping at both ends', async () => {
		const h = await bootView(4);
		const row = h.rows().find((r) => r.dataset.id === '0')!;
		row.focus();
		key(h, row, 'F10', { shift: true });

		const items = Array.from(h.document.querySelectorAll<HTMLElement>('.contextMenuItem'));
		assert.ok(items.length > 2, 'the commit context menu has several items');
		assert.equal(h.document.activeElement, items[0]);

		key(h, items[0], 'ArrowUp');
		assert.equal(h.document.activeElement, items[items.length - 1], 'ArrowUp wrapped to the last item');
		key(h, <Element>h.document.activeElement, 'ArrowDown');
		assert.equal(h.document.activeElement, items[0], 'ArrowDown wrapped back to the first item');
		key(h, items[2], 'End');
		assert.equal(h.document.activeElement, items[items.length - 1], 'End jumped to the last item');
	});

	it('keeps the menu items out of the tab order (tabindex=-1)', async () => {
		const h = await bootView(4);
		const row = h.rows().find((r) => r.dataset.id === '0')!;
		row.focus();
		key(h, row, 'F10', { shift: true });
		const items = Array.from(h.document.querySelectorAll<HTMLElement>('.contextMenuItem'));
		assert.ok(items.every((item) => item.tabIndex === -1));
		key(h, items[0], 'Escape');
	});
});

describe('the dialog\'s focus', () => {
	let h!: BootedView;
	const sent: any[] = [];

	beforeAll(async () => {
		h = await bootView(4);
		// Capture everything the view sends (the bundle holds the API object it acquired at boot)
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => {
			sent.push(message);
			return originalPostMessage.call(h.window.VSCODE_API, message);
		};
	});

	/** Open the Edit Message dialog of a commit (its form opens after the body fetch resolves).
	 * The row is focused first, mirroring the real browser: right-clicking a cell of a
	 * tabindex-carrying row focuses the row, which is the invoker the focus returns to. */
	async function openEditMessageDialog(index: number) {
		// The tests share one booted view: close a dialog a previous test left open
		const stale = h.document.getElementById('dialogSecondaryAction');
		if (stale !== null) {
			stale.click();
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		const row = h.rows().find((r) => r.dataset.id === String(index))!;
		row.focus();
		const cell = h.document.querySelector(`#commitTable tr.commit[data-hash="${hashOf(index)}"] .description`)!;
		cell.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		const item = Array.from(h.document.querySelectorAll<HTMLElement>('.contextMenuItem'))
			.find((li) => li.textContent!.includes('Edit Message'));
		assert.ok(item !== undefined, 'the commit context menu offers "Edit Message"');
		item.click();

		// The dialog fetches the body first: answer the request like the extension host would
		const deadline = Date.now() + 5000;
		for (;;) {
			const request = sent.filter((m) => m.command === 'commitBodies').at(-1);
			if (request !== undefined) {
				h.dispatch({ command: 'commitBodies', bodies: { [hashOf(index)]: 'commit ' + index + '\n\nthe body' }, requestId: request.requestId });
				break;
			}
			if (Date.now() > deadline) throw new Error('the dialog never fetched the body');
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const deadline2 = Date.now() + 5000;
		for (;;) {
			if (h.document.querySelector('.dialog:not(.closing)') !== null) return;
			if (Date.now() > deadline2) throw new Error('the dialog never opened');
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	it('is a named modal: role=dialog, aria-modal=true, an accessible name, and the focus inside', async () => {
		await openEditMessageDialog(0);
		const dialog = h.document.querySelector<HTMLElement>('.dialog:not(.closing)')!;
		assert.equal(dialog.getAttribute('role'), 'dialog');
		assert.equal(dialog.getAttribute('aria-modal'), 'true');
		const label = dialog.getAttribute('aria-label');
		assert.ok(typeof label === 'string' && label.length > 0, 'the dialog is named for screen readers');

		const active = <HTMLElement>h.document.activeElement;
		assert.ok(dialog.contains(active), 'the focus sits inside the dialog, not on the page behind it');
		// The form's first input is a textarea (not a text field), so the primary action button is
		// where the initial focus lands - the dialog never opens with the focus on <body>
		assert.equal(active.id, 'dialogAction');
	});

	it('traps Tab: forward from the last focusable wraps to the first, backward from the first to the last', async () => {
		const focusables = dialogFocusables(h);
		assert.ok(focusables.length >= 2, 'the dialog has focusable controls');
		const first = focusables[0], last = focusables[focusables.length - 1];

		last.focus();
		key(h, last, 'Tab');
		assert.equal(h.document.activeElement, first, 'Tab from the last control wrapped to the first');

		key(h, first, 'Tab', { shift: true });
		assert.equal(h.document.activeElement, last, 'Shift+Tab from the first control wrapped to the last');

		// A plain Tab inside walks forward normally (no wrapping mid-list)
		key(h, last, 'Tab');
		assert.equal(h.document.activeElement, first);
	});

	it('returns the focus to the invoker row when it closes', async () => {
		// The dialog was opened from the row of commit 0 (through the context menu, which returned
		// the focus to that row on its own close): the dialog's restore target is that row
		const invokerRow = h.rows().find((r) => r.dataset.id === '0')!;
		h.document.getElementById('dialogSecondaryAction')!.click();
		assert.equal(h.document.activeElement, invokerRow, 'the focus returned to the row the dialog was opened from');
		await new Promise((resolve) => setTimeout(resolve, 250)); // let the closing fade remove the dialog
		assert.equal(h.document.querySelector('.dialog'), null, 'the dialog left the DOM');
	});
});

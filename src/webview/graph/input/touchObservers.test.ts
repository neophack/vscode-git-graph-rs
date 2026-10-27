// @vitest-environment jsdom
/**
 * The touch support of the mobile layout (src/webview/graph/input/touchObservers.ts), ported
 * from tests/webviewMobileAdaptation.test.mjs: a long press opens the same context menus a right
 * click does (and cancels the click the lifted finger would cause, so it never also selects the
 * row), a moving finger is a scroll, not a long press, and the wide layout keeps long presses
 * inert. The fast scroller appears on the right edge while a long list scrolls - only in the
 * mobile layout. (The mobile stylesheet's hiding of the view's native scrollbar stays in the
 * full-page integration tests (test/integration/webview/mobileAdaptation.test.ts): jsdom applies
 * no CSS, and reading the shipped stylesheet source needs the fs module the
 * webview layer must not import.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphContext } from '../context';
import type { Store } from '../state/store';
import { observeFastScroller, observeLongPress } from './touchObservers';

/* The observer registers its listeners on the shared document once; whether the mobile layout is
 * rendered is decided at event time, so a mutable flag drives both layouts. */
let mobileLayout = false;
observeLongPress({ layout: { isMobileLayout: () => mobileLayout, isTouchLayout: () => mobileLayout } } as unknown as GraphContext);

beforeEach(() => {
	document.body.textContent = '';
	mobileLayout = false;
	vi.useFakeTimers();
});

/** Dispatch a single-finger touch event (jsdom has no Touch constructor: the list is stubbed). */
function touch(type: string, target: Element, x = 20, y = 20) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y, target: target }];
	Object.defineProperty(event, 'touches', { value: touches });
	target.dispatchEvent(event);
	return event;
}

describe('the long press', () => {
	it('opens the context menu of the pressed element, without also selecting it', () => {
		mobileLayout = true;
		const target = document.createElement('span');
		document.body.appendChild(target);
		const contextMenus: Event[] = [];
		target.addEventListener('contextmenu', (event) => { contextMenus.push(event); });

		touch('touchstart', target);
		vi.advanceTimersByTime(600);
		expect(contextMenus.length).toBe(1); // holding still opened the context menu

		// The click the lifted finger would cause must be cancelled (a long press never also
		// opens the Commit Details View or taps the action sheet item now under the finger)
		const end = touch('touchend', target);
		expect(end.defaultPrevented).toBe(true);
	});

	it('treats a moving finger as a scroll, not a long press', () => {
		mobileLayout = true;
		const target = document.createElement('span');
		document.body.appendChild(target);
		const contextMenus: Event[] = [];
		target.addEventListener('contextmenu', (event) => { contextMenus.push(event); });

		touch('touchstart', target, 20, 20);
		touch('touchmove', target, 20, 60); // beyond the 10px move tolerance
		vi.advanceTimersByTime(600);
		expect(contextMenus.length).toBe(0); // no context menu while scrolling
		expect(touch('touchend', target).defaultPrevented).toBe(false); // the touch ends normally
	});

	it('keeps long presses inert in the wide layout', () => {
		mobileLayout = false;
		const target = document.createElement('span');
		document.body.appendChild(target);
		const contextMenus: Event[] = [];
		target.addEventListener('contextmenu', (event) => { contextMenus.push(event); });

		touch('touchstart', target);
		vi.advanceTimersByTime(600);
		expect(contextMenus.length).toBe(0);
		touch('touchend', target);
	});
});

describe('the fast scroller', () => {
	/** A view element whose emulated scroll geometry jsdom cannot measure itself. */
	function makeViewElem(screens: number) {
		const elem = document.createElement('div');
		Object.defineProperty(elem, 'clientHeight', { get: () => 600, configurable: true });
		Object.defineProperty(elem, 'scrollHeight', { get: () => screens * 600, configurable: true });
		Object.defineProperty(elem, 'scrollTop', { value: 0, writable: true, configurable: true });
		return elem;
	}

	function observe(mobile: boolean, screens: number) {
		const viewElem = makeViewElem(screens);
		observeFastScroller({
			dom: { view: viewElem },
			layout: { isMobileLayout: () => mobile },
			viewport: { getHeaderHeight: () => 96, getTopVisibleCommitIndex: () => 0 },
			store: { commits: [{ hash: 'c000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', date: 1700000000 }], config: { dateFormat: { type: 0, iso: false } } } as unknown as Store
		} as unknown as GraphContext);
		return viewElem;
	}

	it('becomes visible while a long list scrolls', () => {
		const viewElem = observe(true, 40);
		viewElem.dispatchEvent(new Event('scroll'));
		expect(document.getElementById('fastScroller')!.classList.contains('visible')).toBe(true);
	});

	it('stays hidden for a list of a couple of screens', () => {
		const viewElem = observe(true, 2);
		viewElem.dispatchEvent(new Event('scroll'));
		expect(document.getElementById('fastScroller')!.classList.contains('visible')).toBe(false);
	});

	it('is never shown by the wide layout', () => {
		const viewElem = observe(false, 40);
		viewElem.dispatchEvent(new Event('scroll'));
		expect(document.getElementById('fastScroller')!.classList.contains('visible')).toBe(false);
	});
});

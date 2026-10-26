/* Touch support of the mobile layout: long press as a right click, and the fast scroller. */

import { html, setHtml } from '../../common/html';
import { formatDayDate } from '../../common/dates';
import { formatStr, strings } from '../../common/i18n/index';
import { GraphContext } from '../context';
import { UNCOMMITTED } from '../../common/util';

/**
 * Touch screens have no right click: in the phone and tablet layouts a long press - one finger held
 * still for LONG_PRESS_MS - dispatches a `contextmenu` event at the pressed element, so every
 * context menu the view offers (commits, refs, files, the column headers) opens from a long press
 * exactly as it does from a right click: a bottom action sheet on a phone, a popover on a tablet.
 *
 * Mobile browsers differ: Android raises its own `contextmenu` for a long press (possibly before
 * this timer), iOS Safari never does. Whichever comes first wins and the other is suppressed, and
 * the click the browser would deliver when the finger lifts is cancelled, so a long press never
 * also opens the Commit Details View (or taps the action sheet item under the finger).
 */
export function observeLongPress(ctx: GraphContext) {
	const LONG_PRESS_MS = 500, MOVE_TOLERANCE_PX = 10;
	let timer: number | null = null, touchActive = false, menuOpened = false, startX = 0, startY = 0, target: Element | null = null;

	const cancelTimer = () => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
	};

	document.addEventListener('touchstart', (e: TouchEvent) => {
		cancelTimer();
		touchActive = true;
		menuOpened = false;
		if (!ctx.layout.isTouchLayout() || e.touches.length !== 1) return;
		if (e.target instanceof Element && e.target.closest('#fastScroller') !== null) return; // holding the scroller still is not a long press
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		target = <Element | null>e.target;
		timer = window.setTimeout(() => {
			timer = null;
			if (!touchActive || target === null || !target.isConnected) return;
			menuOpened = true;
			target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: startX, clientY: startY, screenX: startX, screenY: startY }));
		}, LONG_PRESS_MS);
	}, { passive: true });

	document.addEventListener('touchmove', (e: TouchEvent) => {
		// Scrolling (or any drag) is not a long press
		if (timer === null || e.touches.length === 0) return;
		if (Math.abs(e.touches[0].clientX - startX) > MOVE_TOLERANCE_PX || Math.abs(e.touches[0].clientY - startY) > MOVE_TOLERANCE_PX) cancelTimer();
	}, { passive: true });

	const endTouch = (e: TouchEvent) => {
		cancelTimer();
		touchActive = false;
		target = null;
		// The menu opened while the finger was down: the click this touch would turn into must not
		// select the row or the action sheet item that is now under the finger
		if (menuOpened && e.cancelable) e.preventDefault();
	};
	document.addEventListener('touchend', endTouch, { passive: false });
	document.addEventListener('touchcancel', endTouch, { passive: false });

	document.addEventListener('contextmenu', (e: MouseEvent) => {
		if (!e.isTrusted || !touchActive) return; // a right click, or the event dispatched above
		if (menuOpened) {
			// The browser's own long press menu, after this one already opened the view's
			e.preventDefault();
			e.stopImmediatePropagation();
		} else {
			// The browser raised it first: let it through to the view's handlers, and drop the timer
			cancelTimer();
			menuOpened = true;
		}
	}, true);
}

/**
 * The mobile layout's fast scroller: flicking through tens of thousands of commits a screen at a
 * time is hopeless on a phone, so - as in a phone's contacts or photos app - a thumb appears on the
 * right edge while the list scrolls, and dragging it maps its position straight onto the scroll
 * range. While dragging, a bubble beside it names the day of the commit at the top of the screen
 * and its position in the list. Only offered when the list is at least MIN_PAGES screens long; the
 * windowed rendering keeps every jump cheap (only the rows around the new position are built).
 */
export function observeFastScroller(ctx: GraphContext) {
	const MIN_PAGES = 6, HIDE_AFTER_MS = 1500, THUMB_HEIGHT = 44, EDGE_GAP = 8;
	const viewElem = ctx.dom.view, store = ctx.store;
	const scroller = document.createElement('div');
	scroller.id = 'fastScroller';
	setHtml(scroller, html`<div id="fastScrollerBubble"></div><div id="fastScrollerThumb"></div>`);
	document.body.appendChild(scroller);
	const thumb = <HTMLElement>scroller.lastChild, bubble = <HTMLElement>scroller.firstChild;
	let hideTimer: number | null = null, dragging = false, grabOffset = 0;

	const enabled = () => ctx.layout.isMobileLayout() && viewElem.scrollHeight > MIN_PAGES * viewElem.clientHeight;
	// The track runs from below the app bar to the bottom of the view
	const track = () => {
		const headerHeight = ctx.viewport.getHeaderHeight();
		const top = viewElem.getBoundingClientRect().top + headerHeight + EDGE_GAP;
		return { top: top, length: Math.max(1, viewElem.clientHeight - headerHeight - THUMB_HEIGHT - 2 * EDGE_GAP), max: Math.max(1, viewElem.scrollHeight - viewElem.clientHeight) };
	};
	const place = () => {
		const t = track();
		const y = t.top + Math.min(1, viewElem.scrollTop / t.max) * t.length;
		thumb.style.transform = 'translateY(' + y + 'px)';
		bubble.style.transform = 'translateY(' + (y + THUMB_HEIGHT / 2) + 'px) translateY(-50%)';
	};
	const updateBubble = () => {
		const index = ctx.viewport.getTopVisibleCommitIndex();
		if (index < 0) return;
		const commit = store.commits[index];
		setHtml(bubble, html`<span class="fastScrollerDate">${commit.hash === UNCOMMITTED ? strings.mobileUncommittedTitle : formatDayDate(commit.date, true, store.config.dateFormat)}</span><span class="fastScrollerPos">${formatStr(strings.mobileCommitPosition, (index + 1).toLocaleString(), store.commits.length.toLocaleString())}</span>`);
	};
	const scheduleHide = () => {
		if (hideTimer !== null) window.clearTimeout(hideTimer);
		hideTimer = window.setTimeout(() => {
			hideTimer = null;
			if (!dragging) scroller.classList.remove('visible');
		}, HIDE_AFTER_MS);
	};

	viewElem.addEventListener('scroll', () => {
		if (!enabled()) {
			scroller.classList.remove('visible');
			return;
		}
		place();
		if (dragging) updateBubble();
		scroller.classList.add('visible');
		scheduleHide();
	}, { passive: true });

	thumb.addEventListener('pointerdown', (e: PointerEvent) => {
		if (!scroller.classList.contains('visible') || !enabled()) return;
		e.preventDefault();
		e.stopPropagation();
		dragging = true;
		grabOffset = e.clientY - thumb.getBoundingClientRect().top;
		if (thumb.setPointerCapture) thumb.setPointerCapture(e.pointerId);
		scroller.classList.add('dragging');
		updateBubble();
	});
	thumb.addEventListener('pointermove', (e: PointerEvent) => {
		if (!dragging) return;
		e.preventDefault();
		const t = track();
		const offset = Math.min(t.length, Math.max(0, e.clientY - grabOffset - t.top));
		viewElem.scrollTop = Math.round(offset / t.length * t.max);
	});
	const endDrag = () => {
		if (!dragging) return;
		dragging = false;
		scroller.classList.remove('dragging');
		scheduleHide();
	};
	thumb.addEventListener('pointerup', endDrag);
	thumb.addEventListener('pointercancel', endDrag);
	// The thumb's own taps must not reach the table (or the document listener closing menus)
	scroller.addEventListener('click', (e) => e.stopPropagation());
}

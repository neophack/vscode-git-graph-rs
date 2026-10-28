/**
 * The shared help tooltip: every non-clickable help indicator (`.gg-helpTooltip`, see
 * `helpTooltipAttrs`) shows its `data-tooltip` text immediately on hover and on keyboard focus,
 * unlike the browser's native `title` tooltip. Observed once for the whole document, so elements
 * rendered later work too.
 */

import { measureBoundingClientRect } from './measure';

let tooltipElem: HTMLElement | null = null;
let tooltipTarget: HTMLElement | null = null;
let observed = false;

function getTooltipTarget(target: EventTarget | null) {
	return target instanceof Element ? <HTMLElement | null>target.closest('.gg-helpTooltip') : null;
}

/** Hide the help tooltip (if one is shown). */
export function hideHelpTooltip() {
	if (tooltipTarget !== null && tooltipTarget.getAttribute('aria-describedby') === 'ggHelpTooltip') {
		tooltipTarget.removeAttribute('aria-describedby');
	}
	tooltipTarget = null;
	if (tooltipElem !== null) {
		tooltipElem.remove();
		tooltipElem = null;
	}
}

function positionTooltip() {
	if (tooltipElem === null || tooltipTarget === null) return;
	const targetRect = measureBoundingClientRect(tooltipTarget);
	const tooltipRect = measureBoundingClientRect(tooltipElem);
	const maxLeft = Math.max(8, window.innerWidth - tooltipRect.width - 8);
	const left = Math.min(Math.max(8, targetRect.left + (targetRect.width - tooltipRect.width) / 2), maxLeft);
	let top = targetRect.bottom + 6;
	if (top + tooltipRect.height > window.innerHeight - 8) top = targetRect.top - tooltipRect.height - 6;
	tooltipElem.style.left = Math.round(left) + 'px';
	tooltipElem.style.top = Math.round(Math.max(8, top)) + 'px';
}

function showTooltip(target: HTMLElement) {
	const message = target.dataset.tooltip;
	if (typeof message !== 'string' || message === '') return;
	if (tooltipTarget === target) {
		if (tooltipElem !== null && tooltipElem.textContent !== message) {
			tooltipElem.textContent = message;
			positionTooltip();
		}
		return;
	}
	hideHelpTooltip();

	const tooltip = document.createElement('div');
	tooltip.id = 'ggHelpTooltip';
	tooltip.className = 'gg-helpTooltipPopup';
	tooltip.setAttribute('role', 'tooltip');
	tooltip.textContent = message;
	document.body.appendChild(tooltip);
	tooltipElem = tooltip;
	tooltipTarget = target;
	target.setAttribute('aria-describedby', 'ggHelpTooltip');
	positionTooltip();
}

/** Observe the help indicators of the document (idempotent). */
export function observeHelpTooltips() {
	if (observed) return;
	observed = true;

	document.addEventListener('mouseover', (e) => {
		const target = getTooltipTarget(e.target);
		if (target === null || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) return;
		showTooltip(target);
	});
	document.addEventListener('mouseout', (e) => {
		const target = getTooltipTarget(e.target);
		if (target === null || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) return;
		if (target === tooltipTarget) hideHelpTooltip();
	});
	document.addEventListener('focusin', (e) => {
		const target = getTooltipTarget(e.target);
		if (target !== null) showTooltip(target);
	});
	document.addEventListener('focusout', (e) => {
		const target = getTooltipTarget(e.target);
		if (target !== null && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) hideHelpTooltip();
	});
	window.addEventListener('scroll', hideHelpTooltip, { capture: true, passive: true });
	window.addEventListener('resize', hideHelpTooltip);
}

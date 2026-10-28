// @vitest-environment jsdom
/**
 * The tablet toolbar's overflow (ControlBar.updateToolbarOverflow): the bar keeps every control
 * its width has room for and moves only the rest into the ⋯ menu, the less-used actions first.
 * jsdom has no layout engine, so the measured geometry is stubbed per element.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { GraphContext } from '../context';
import { ControlBar } from './controlBar';

const ITEM_IDS = ['authorControl', 'showRemoteBranchesControl'];
const BUTTON_IDS = ['currentBtn', 'findBtn', 'filterBtn', 'statisticsBtn', 'terminalBtn', 'settingsBtn', 'fetchBtn', 'refreshBtn'];
const BUTTON_WIDTH = 30, ITEM_WIDTH = 100, BAR_RIGHT = 800;

/** A toolbar whose actions end `excess` pixels past the bar's end. */
function makeToolbar(excess: number) {
	const controls = document.createElement('div');
	controls.id = 'controls';
	for (const id of ITEM_IDS) controls.appendChild(Object.assign(document.createElement('span'), { id: id }));
	const controlBtns = Object.assign(document.createElement('span'), { id: 'controlBtns' });
	for (const id of BUTTON_IDS) controlBtns.appendChild(Object.assign(document.createElement('div'), { id: id }));
	controls.appendChild(controlBtns);
	document.body.appendChild(controls);

	const rect = (right: number, width: number) => () => ({ right: right, width: width }) as DOMRect;
	Object.defineProperty(controls, 'clientWidth', { get: () => BAR_RIGHT });
	controls.getBoundingClientRect = rect(BAR_RIGHT, BAR_RIGHT);
	controlBtns.getBoundingClientRect = rect(BAR_RIGHT + excess, BUTTON_WIDTH * BUTTON_IDS.length);
	for (const id of ITEM_IDS) controls.querySelector<HTMLElement>('#' + id)!.getBoundingClientRect = rect(0, ITEM_WIDTH);
	for (const id of BUTTON_IDS) controls.querySelector<HTMLElement>('#' + id)!.getBoundingClientRect = rect(0, BUTTON_WIDTH);

	const bar = new ControlBar(() => ({ dom: { controls: controls } }) as unknown as GraphContext);
	const overflowed = () => Array.from(controls.querySelectorAll('[data-overflowed]')).map((elem) => elem.id);
	return { bar: bar, controls: controls, overflowed: overflowed };
}

beforeEach(() => {
	document.body.textContent = '';
	document.body.className = 'touchMode tabletMode';
});

describe('the tablet toolbar overflow', () => {
	it('keeps every control in a bar wide enough for them', () => {
		const toolbar = makeToolbar(0);
		toolbar.bar.updateToolbarOverflow();
		expect(toolbar.overflowed()).toEqual([]);
		expect(toolbar.controls.hasAttribute('data-overflowing')).toBe(false);
	});

	it('moves only as many actions as the missing width (plus the ⋯ button) needs, the less-used first', () => {
		// 20px missing + 30px for ⋯ = 50px: two 30px buttons
		const toolbar = makeToolbar(20);
		toolbar.bar.updateToolbarOverflow();
		expect(toolbar.overflowed()).toEqual(['statisticsBtn', 'terminalBtn']);
		expect(toolbar.controls.hasAttribute('data-overflowing')).toBe(true);
	});

	it('keeps an active path filter in the bar, and moves the filters once the actions are gone', () => {
		const toolbar = makeToolbar(200);
		toolbar.controls.querySelector('#filterBtn')!.classList.add('active');
		toolbar.bar.updateToolbarOverflow();
		// 230px: five 30px actions (150px), then the Remote chip (100px)
		expect(toolbar.overflowed()).toEqual(['showRemoteBranchesControl', 'currentBtn', 'statisticsBtn', 'terminalBtn', 'settingsBtn', 'fetchBtn']);
	});

	it('puts everything back when the bar grows again, and leaves the other layouts alone', () => {
		const toolbar = makeToolbar(20);
		toolbar.bar.updateToolbarOverflow();
		expect(toolbar.overflowed().length).toBeGreaterThan(0);
		document.body.className = 'touchMode mobileMode';
		toolbar.bar.updateToolbarOverflow();
		expect(toolbar.overflowed()).toEqual([]);
		expect(toolbar.controls.hasAttribute('data-overflowing')).toBe(false);
	});
});

// @vitest-environment jsdom
/**
 * The shared help tooltip (src/webview/common/helpTooltip.ts), ported from
 * tests/helpTooltip.test.mjs: help text must not depend on the browser's delayed native `title`
 * tooltip - it appears immediately on hover and focus, follows a changed tooltip text without a
 * leave/enter cycle, and disappears (with its aria-describedby) when the pointer or focus leaves
 * the target.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { hideHelpTooltip, observeHelpTooltips } from './helpTooltip';

beforeEach(() => {
	document.body.textContent = '';
	hideHelpTooltip();
});

/** A help indicator as any component renders it: the class hook plus the tooltip text. */
function makeTarget(tooltip: string) {
	const target = document.createElement('span');
	target.className = 'gg-helpTooltip';
	target.dataset.tooltip = tooltip;
	target.tabIndex = 0;
	document.body.appendChild(target);
	return target;
}

describe('the shared help tooltip', () => {
	it('shows immediately on hover and hides when the target is left', () => {
		observeHelpTooltips();
		const target = makeTarget('Explain this icon');

		target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		expect(document.getElementById('ggHelpTooltip')!.textContent).toBe('Explain this icon');
		expect(target.getAttribute('aria-describedby')).toBe('ggHelpTooltip');

		// A re-hover with a changed tooltip text updates the visible tooltip in place
		target.dataset.tooltip = 'Updated explanation';
		target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		expect(document.getElementById('ggHelpTooltip')!.textContent).toBe('Updated explanation');

		target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
		expect(document.getElementById('ggHelpTooltip')).toBe(null);
		expect(target.getAttribute('aria-describedby')).toBe(null);
	});

	it('shows on keyboard focus', () => {
		observeHelpTooltips();
		const target = makeTarget('Keyboard explanation');

		target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
		expect(document.getElementById('ggHelpTooltip')!.textContent).toBe('Keyboard explanation');
	});

	it('ignores a target without tooltip text (the hook alone opens nothing)', () => {
		observeHelpTooltips();
		const target = makeTarget('');

		target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		expect(document.getElementById('ggHelpTooltip')).toBe(null);
	});
});

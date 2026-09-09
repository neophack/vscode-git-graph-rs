/**
 * Regression tests for the shared tooltip used by non-clickable help indicators.
 *
 * Help text must not depend on the browser's delayed native `title` tooltip: it should appear
 * immediately on hover and focus, and disappear when the pointer/focus leaves the target.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

describe('help tooltip', () => {
	it('shows immediately on hover and hides when the target is left', async () => {
		const h = await bootView(1);
		const target = h.document.createElement('span');
		target.className = 'gg-helpTooltip';
		target.dataset.tooltip = 'Explain this icon';
		target.tabIndex = 0;
		h.document.body.appendChild(target);

		target.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
		assert.equal(h.document.getElementById('ggHelpTooltip').textContent, 'Explain this icon');
		assert.equal(target.getAttribute('aria-describedby'), 'ggHelpTooltip');

		target.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true }));
		assert.equal(h.document.getElementById('ggHelpTooltip'), null);
		assert.equal(target.getAttribute('aria-describedby'), null);
	});

	it('shows on keyboard focus', async () => {
		const h = await bootView(1);
		const target = h.document.createElement('span');
		target.className = 'gg-helpTooltip';
		target.dataset.tooltip = 'Keyboard explanation';
		target.tabIndex = 0;
		h.document.body.appendChild(target);

		target.dispatchEvent(new h.window.FocusEvent('focusin', { bubbles: true }));
		assert.equal(h.document.getElementById('ggHelpTooltip').textContent, 'Keyboard explanation');
	});
});

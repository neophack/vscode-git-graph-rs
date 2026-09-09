/**
 * Regression test for the dialog validation tooltip.
 *
 * While a TextRef input is invalid, hovering the action button explains why through the shared
 * help tooltip. Fixing the input from the keyboard while the pointer stays on the button must
 * remove that tooltip again: the hide path is the delegated mouseout/focusout listener, which can
 * no longer match the button once its .gg-helpTooltip class has been cleared, so the validation
 * code itself has to hide the visible tooltip (and its aria-describedby).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

describe('dialog validation tooltip', () => {
	it('is removed when the input becomes valid while the action button is hovered', async () => {
		const h = await bootView(1);
		h.window.Element.prototype.scrollIntoView = function () {};

		/* Open the Create Branch dialog (its name field is a TextRef input) via the commit context menu. */
		const row = h.document.querySelector('#commitTable tr.commit .description');
		row.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		const createBranch = [...h.document.querySelectorAll('.contextMenuItem')]
			.find((li) => li.textContent.includes('Create Branch'));
		assert.ok(createBranch, 'the commit context menu should offer "Create Branch..."');
		createBranch.click();

		const input = h.document.getElementById('dialogInput0');
		const action = h.document.getElementById('dialogAction');
		assert.ok(input !== null && action !== null, 'the dialog should be open with a text input and an action button');

		/* An invalid reference arms the tooltip target on the action button; hovering shows it. */
		input.value = 'feature~bad';
		input.dispatchEvent(new h.window.Event('keyup', { bubbles: true }));
		assert.ok(action.classList.contains('gg-helpTooltip'), 'an invalid input should arm the tooltip target');

		action.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
		const tooltip = h.document.getElementById('ggHelpTooltip');
		assert.ok(tooltip !== null, 'the shared tooltip should be visible while the button is hovered');
		assert.match(tooltip.textContent, /invalid characters/);
		assert.equal(action.getAttribute('aria-describedby'), 'ggHelpTooltip');

		/* Focus never left the input, so the input can be fixed from the keyboard while the pointer stays on the button. */
		input.value = 'feature';
		input.dispatchEvent(new h.window.Event('keyup', { bubbles: true }));
		assert.ok(!action.classList.contains('gg-helpTooltip'), 'a valid input should disarm the tooltip target');

		/* Moving the pointer away afterwards must leave nothing behind. */
		action.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true }));

		assert.equal(h.document.getElementById('ggHelpTooltip'), null, 'the shared tooltip must not remain on screen');
		assert.equal(action.getAttribute('aria-describedby'), null, 'aria-describedby must be cleaned up');
	});
});

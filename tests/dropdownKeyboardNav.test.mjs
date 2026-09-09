/**
 * Regression test for the keyboard-accessible dropdown added in f65d1e8 ("make toolbar buttons,
 * dropdowns and dialogs keyboard-accessible...").
 *
 * The filter input wires up two listeners:
 *   - 'keydown' handles ArrowUp/ArrowDown (moves `this.highlighted`) and Enter (selects
 *     `this.highlighted` if >-1).
 *   - 'keyup' (pre-existing, for live filtering as the user types) calls filter(), which
 *     unconditionally resets `this.highlighted = -1` at the end - but never removes the DOM
 *     '.highlighted' class that moveHighlighted() just added.
 *
 * A real key press fires keydown THEN keyup for the same key. So pressing ArrowDown highlights
 * the next option visually, but its keyup immediately clears the internal `highlighted` index
 * back to -1 - even though the CSS class stays on the option. The next Enter press therefore
 * finds `this.highlighted === -1` and silently does nothing: the visibly-highlighted option is
 * never selected and the dropdown never closes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

describe('dropdown keyboard navigation (repoDropdown)', () => {
	it('selects the arrow-key-highlighted option on Enter', async () => {
		const h = await bootView(3, { repos: { '/ws/a': null, '/ws/b': null } });
		// jsdom has no layout engine and doesn't implement scrollIntoView (used when the keyboard
		// highlight moves); stub it like the harness already does for scroll/scrollTo.
		h.window.Element.prototype.scrollIntoView = function () {};
		const dropdownElem = h.document.getElementById('repoDropdown');
		const currentValueElem = dropdownElem.querySelector('.dropdownCurrentValue');
		const filterInput = dropdownElem.querySelector('.dropdownFilterInput');

		// Open the dropdown (mouse click on the current value, as main.ts wires it up)
		currentValueElem.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		assert.ok(dropdownElem.classList.contains('dropdownOpen'), 'dropdown should be open after clicking the current value');

		const options = Array.from(dropdownElem.querySelectorAll('.dropdownOption'));
		assert.equal(options.length, 2, 'test expects exactly two repo options');
		const initiallySelected = options.find((o) => o.classList.contains('selected'));
		const other = options.find((o) => o !== initiallySelected);
		assert.ok(initiallySelected && other, 'one option should start selected, the other not');
		const otherTitle = other.title;

		// Press ArrowDown once: keydown moves the highlight, keyup fires right after (as a browser
		// does for every real key press) and must not silently undo it.
		const fireKey = (type, key) => filterInput.dispatchEvent(new h.window.KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
		fireKey('keydown', 'ArrowDown');
		fireKey('keyup', 'ArrowDown');

		assert.ok(other.classList.contains('highlighted'), 'ArrowDown should visually highlight the other option');

		// Press Enter: the visually-highlighted option should be selected and the dropdown closed.
		fireKey('keydown', 'Enter');
		fireKey('keyup', 'Enter');

		// Selecting an option re-renders .dropdownOptions' innerHTML, replacing the DOM nodes -
		// re-query rather than reusing the (now detached) `other`/`initiallySelected` references.
		const optionsAfter = Array.from(dropdownElem.querySelectorAll('.dropdownOption'));
		const otherAfter = optionsAfter.find((o) => o.title === otherTitle);

		assert.ok(!dropdownElem.classList.contains('dropdownOpen'), 'Enter should close the dropdown once an option is chosen');
		assert.ok(otherAfter.classList.contains('selected'), 'Enter should select the arrow-key-highlighted option');
		assert.equal(optionsAfter.filter((o) => o.classList.contains('selected')).length, 1, 'exactly one option should end up selected');
		assert.equal(currentValueElem.title, otherTitle, 'the current value display should reflect the newly-selected option');
	});
});

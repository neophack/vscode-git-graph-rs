/**
 * Regression test for the repository dropdown information button.
 *
 * The information icon must be an independent action: clicking it shows the repository path
 * without selecting the option that contains it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

describe('repository dropdown information button', () => {
	it('shows the full repository path without changing the selection', async () => {
		const h = await bootView(3, { repos: { '/ws/main': null, '/ws/other': null } });
		h.window.Element.prototype.scrollIntoView = function () {};
		const dropdownElem = h.document.getElementById('repoDropdown');
		const currentValueElem = dropdownElem.querySelector('.dropdownCurrentValue');
		currentValueElem.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

		const initialValue = currentValueElem.title;
		const infoButton = dropdownElem.querySelector('.dropdownOption[data-id="1"] .dropdownOptionInfo');
		assert.ok(infoButton, 'repository options should render an information button');
		assert.equal(infoButton.getAttribute('aria-label'), 'Show more information for other');

		infoButton.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

		assert.ok(!dropdownElem.classList.contains('dropdownOpen'), 'clicking the information button should close the dropdown');
		assert.equal(currentValueElem.title, initialValue, 'clicking the information button should not select the repository');
		assert.match(h.document.querySelector('.dialog').textContent, /Path: \/ws\/other/);
	});
});

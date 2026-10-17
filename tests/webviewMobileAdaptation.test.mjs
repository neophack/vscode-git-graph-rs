/**
 * The narrow window (mobile) layout of the commit table: the `mobileAdaptation` Extension
 * Setting hides the Date, Author and Commit columns while the view is at most 600 pixels wide
 * (so the graph and the commit messages fit a phone-sized window), and restores them when the
 * view widens again. While the setting is disabled the display never changes.
 *
 * These tests boot the full webview (see webviewHarness.mjs), set the emulated view width, and
 * assert on the rendered column header row and commit rows.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

const headerTitles = (h) => Array.from(h.document.querySelectorAll('#tableColHeaders th')).map((th) => th.textContent);
const WIDE_HEADER = ['Graph', 'Description', 'Date', 'Author', 'Commit'];
const NARROW_HEADER = ['Graph', 'Description'];

/** Emulate a view width: jsdom has no layout engine, so the harness stubs clientWidth (1200). */
function setViewWidth(h, width) {
	Object.defineProperty(h.viewElem, 'clientWidth', { get: () => width, configurable: true });
}

function clonedConfig(h) {
	return JSON.parse(JSON.stringify(h.window.initialState.config));
}

describe('the narrow window (mobileAdaptation) layout', () => {
	it('leaves the display untouched while the setting is disabled, even below the breakpoint', async () => {
		const h = await bootView(300);
		setViewWidth(h, 400); // narrower than the breakpoint, but the setting is off
		const config = clonedConfig(h);
		config.mobileAdaptation = false;
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();

		assert.deepEqual(headerTitles(h), WIDE_HEADER, 'all columns stay visible');
		assert.ok(h.rows().every((row) => row.querySelectorAll('td').length === 5), 'rows keep all five cells');
		assert.ok(!h.document.body.classList.contains('narrowWindow'), 'the narrow window body class is absent');
	});

	it('hides the Date, Author and Commit columns in a narrow view, and restores them when it widens', async () => {
		const h = await bootView(300);
		setViewWidth(h, 400);
		const config = clonedConfig(h);
		config.mobileAdaptation = true;
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();

		assert.deepEqual(headerTitles(h), NARROW_HEADER, 'the Date, Author and Commit columns are hidden');
		assert.ok(h.rows().every((row) => row.querySelectorAll('td').length === 2), 'rows carry only the graph and description cells');
		assert.ok(h.document.body.classList.contains('narrowWindow'), 'the narrow window body class was set');

		// Widen the view past the breakpoint: the (rAF-debounced) resize observer must re-render
		// and bring the columns back - the wide display is exactly as it was before
		setViewWidth(h, 1200);
		h.window.dispatchEvent(new h.window.Event('resize'));
		await new Promise((resolve) => setTimeout(resolve, 100)); // let the debounced resize run
		await h.pump();

		assert.deepEqual(headerTitles(h), WIDE_HEADER, 'all columns returned');
		assert.ok(h.rows().every((row) => row.querySelectorAll('td').length === 5), 'rows carry all five cells again');
		assert.ok(!h.document.body.classList.contains('narrowWindow'), 'the narrow window body class was cleared');
	});

	it('exposes the switch in the Settings Widget\'s Global Settings column, saving to the User Settings', async () => {
		const h = await bootView(300);
		h.document.getElementById('settingsBtn').click();

		const toggle = h.document.getElementById('settingsMobileAdaptationCheckbox');
		assert.ok(toggle !== null, 'the switch is rendered in the settings widget');
		assert.ok(toggle.closest('#settingsGlobalColumn') !== null, 'the switch lives in the Global Settings column');
		assert.equal(toggle.checked, false, 'the switch defaults to off');
		assert.match(toggle.closest('#settingsMobileAdaptation').textContent, /Narrow window \(mobile\) adaptation/, 'the switch is labelled');

		// Toggling it sends a setGlobalSetting request, which the extension host writes to the
		// VS Code User Settings (WRITABLE_GLOBAL_SETTINGS whitelists 'mobileAdaptation')
		const requests = [];
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message) => { requests.push(message); originalPostMessage(message); };
		toggle.checked = true;
		toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));

		const save = requests.find((message) => message.command === 'setGlobalSetting');
		assert.ok(save !== undefined, 'toggling the switch sends a setGlobalSetting request');
		assert.equal(save.setting, 'mobileAdaptation');
		assert.equal(save.value, true);
	});
});

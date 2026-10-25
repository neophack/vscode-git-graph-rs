/**
 * The mobile layout's remaining full-page cases (docs/MOBILE-DESIGN.md; see webviewHarness.mjs):
 * the Settings Widget's switch over the Extension Setting, the app bar's "More actions" sheet,
 * and the Commit Details View as a full-screen sheet.
 *
 * The rest of the former file drained into colocated component tests (REFACTOR-PLAN Appendix B):
 * the narrow-window decision and switching (body classes, row height, hidden columns, docked
 * details) live in src/webview/graph/render/layoutMode.test.ts, the two-line row and its refs in
 * src/webview/graph/render/commitRow.test.ts, the long press and the fast scroller in
 * src/webview/graph/input/touchObservers.test.ts, and the native-scrollbar hiding in the mobile
 * stylesheet keeps its assertion against the shipped out.min.css until the rendered-css
 * assertion moves to the webview journey / rendering tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Emulate a view width: jsdom has no layout engine, so the harness stubs clientWidth (1200). */
function setViewWidth(h, width) {
	Object.defineProperty(h.viewElem, 'clientWidth', { get: () => width, configurable: true });
}

function clonedConfig(h) {
	return JSON.parse(JSON.stringify(h.window.initialState.config));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the narrow window (mobileAdaptation) layout', () => {
	it('exposes the switch in the Settings Widget\'s Global Settings column, saving to the User Settings', async () => {
		const h = await bootView(300);
		h.document.getElementById('settingsBtn').click();

		const toggle = h.document.getElementById('settingsMobileAdaptationCheckbox');
		assert.ok(toggle !== null, 'the switch is rendered in the settings widget');
		assert.ok(toggle.closest('#settingsGlobalColumn') !== null, 'the switch lives in the Global Settings column');
		assert.equal(toggle.checked, false, 'the switch defaults to off');
		assert.match(toggle.closest('#settingsMobileAdaptation').textContent, /Mobile layout for narrow windows/, 'the switch is labelled');

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

	it('gathers the toolbar into a "More actions" sheet, with Show Remote Branches as a switch', async () => {
		const h = await bootView(300);
		setViewWidth(h, 400);
		const config = clonedConfig(h);
		config.mobileAdaptation = true;
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();

		const moreBtn = h.document.getElementById('mobileMoreBtn');
		assert.ok(moreBtn !== null, 'the app bar has a "More actions" button');
		moreBtn.click();
		const menu = h.document.querySelector('.contextMenu.mobileOverflowMenu');
		assert.ok(menu !== null, 'the button opened the overflow sheet');
		const labels = Array.from(menu.querySelectorAll('.mobileMenuLabel')).map((label) => label.textContent);
		for (const label of ['Show Remote Branches', 'Statistics', 'Settings']) assert.ok(labels.includes(label), 'the sheet offers ' + label);

		const checkbox = h.document.getElementById('showRemoteBranchesCheckbox');
		const before = checkbox.checked;
		const switchItem = menu.querySelector('.mobileMenuSwitch').closest('.contextMenuItem');
		assert.equal(switchItem.querySelector('.mobileMenuSwitch').classList.contains('on'), before, 'the switch shows the checkbox state');
		switchItem.click();
		assert.equal(checkbox.checked, !before, 'the switch toggled Show Remote Branches');
	});

	it('shows the commit details as a full-screen sheet whose "More actions" opens the commit menu', async () => {
		const h = await bootView(30);
		setViewWidth(h, 400);
		const config = clonedConfig(h);
		config.mobileAdaptation = true;
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();

		h.rows()[1].click();
		await h.pump();
		await sleep(50);

		const cdv = h.document.getElementById('cdv');
		assert.ok(cdv !== null, 'the commit details view opened');
		assert.ok(cdv.classList.contains('docked'), 'it is docked (the sheet), not inline in the table');
		assert.equal(cdv.parentElement, h.document.body, 'it lives on <body>, over the commit list');

		const row = h.rows()[1];
		assert.equal(h.document.getElementById('cdvMobileTitle').textContent, row.dataset.hash.substring(0, 8), 'the title bar names the commit');
		assert.ok(h.document.querySelector('#cdvSummary .cdvmTitle') !== null, 'the summary leads with the subject as its title');
		assert.ok(h.document.querySelector('#cdvSummary .cdvmFacts') !== null, 'and lists the commit facts');
		const listBtn = h.document.getElementById('cdvFileViewTypeList');
		assert.ok(listBtn !== null && listBtn.closest('#cdvFilesHeader') !== null, 'the file view controls sit in the Files header');
		assert.equal(h.document.querySelector('#cdvControls #cdvFileViewTypeList'), null, 'not in the title bar');

		const moreActions = h.document.getElementById('cdvMobileActions');
		assert.ok(moreActions !== null, 'the sheet offers a "More actions" button');
		moreActions.click();
		const menu = h.document.querySelector('.contextMenu');
		assert.ok(menu !== null, '"More actions" opened the commit context menu');
		assert.ok(menu.querySelectorAll('.contextMenuItem').length > 3, 'with the commit actions');

		// A tap on the scrim (the menu element itself, outside its items) dismisses the sheet
		menu.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		assert.equal(h.document.querySelector('.contextMenu'), null, 'tapping the scrim closed the menu');
	});

	it('hides the view\'s native scrollbar in the mobile layout — the fast scroller is the one indicator (no two bars while scrolling)', () => {
		// jsdom applies no CSS, so the rule is asserted on the stylesheet the build ships
		const sheet = fs.readFileSync(path.join(root, 'media', 'out.min.css'), 'utf8');
		const viewRule = sheet.match(/body\.mobileMode #view\{[^}]*\}/);
		assert.ok(viewRule !== null, 'a body.mobileMode #view rule block exists');
		assert.match(viewRule[0], /scrollbar-width\s*:\s*none/, 'the standard scrollbar is hidden');
		assert.match(viewRule[0], /-ms-overflow-style\s*:\s*none/, 'the legacy IE/Edge scrollbar is hidden');
		const webkitRule = sheet.match(/body\.mobileMode #view::-webkit-scrollbar\s*\{[^}]*\}/);
		assert.ok(webkitRule !== null, 'the WebKit/Chromium pseudo-element rule exists');
		assert.match(webkitRule[0], /display\s*:\s*none/, 'the WebKit/Chromium scrollbar is hidden');
		// The hiding is scoped: the wide layout (no body.mobileMode) keeps its native scrollbar
		const withoutScoped = sheet.replace(/body\.mobileMode #view(\{|::-webkit-scrollbar\s*\{)[^}]*\}/g, '');
		assert.ok(!/(^|[^.\w-])#view\s*\{[^}]*scrollbar-width/.test(withoutScoped), 'no unscoped #view rule hides the wide layout\'s scrollbar');
	});
});

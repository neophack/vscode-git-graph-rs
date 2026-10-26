/**
 * The mobile layout's remaining full-page cases (see test/support/webviewHost.ts): the Settings
 * Widget's switch over the Extension Setting, the app bar's "More actions" sheet, and the Commit
 * Details View as a full-screen sheet.
 *
 * Ported from tests/webviewMobileAdaptation.test.mjs (REFACTOR-PLAN task 7.1); assertions are
 * unchanged.
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
import { describe, it, vi } from 'vitest';
import { bootView } from '../../support/webviewHost';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

type Booted = Awaited<ReturnType<typeof bootView>>;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Emulate a view width: jsdom has no layout engine, so the harness stubs clientWidth (1200). */
function setViewWidth(h: Booted, width: number) {
	Object.defineProperty(h.viewElem, 'clientWidth', { get: () => width, configurable: true });
}

function clonedConfig(h: Booted) {
	return JSON.parse(JSON.stringify(h.window.initialState.config));
}

describe('the narrow window (mobileAdaptation) layout', () => {
	it('exposes the switch in the Settings Widget\'s Global Settings column, saving to the User Settings', async () => {
		const h = await bootView(300);
		h.document.getElementById('settingsBtn')!.click();
		// The settings widget mounts on demand: the click starts an async import, so the switch
		// appears a tick later - wait for it instead of querying synchronously.
		let toggle: HTMLInputElement | null = null;
		for (let i = 0; i < 100 && toggle === null; i++) { await sleep(10); toggle = h.document.getElementById('settingsMobileAdaptationCheckbox') as HTMLInputElement; }

		assert.ok(toggle !== null, 'the switch is rendered in the settings widget');
		assert.ok(toggle!.closest('#settingsGlobalColumn') !== null, 'the switch lives in the Global Settings column');
		assert.equal(toggle!.checked, false, 'the switch defaults to off');
		assert.match(toggle!.closest('#settingsMobileAdaptation')!.textContent!, /Use phone and tablet layouts/, 'the switch is labelled');

		// Toggling it sends a setGlobalSetting request, which the extension host writes to the
		// VS Code User Settings (WRITABLE_GLOBAL_SETTINGS whitelists 'mobileAdaptation')
		const requests: any[] = [];
		const originalPostMessage = h.window.VSCODE_API.postMessage;
		h.window.VSCODE_API.postMessage = (message: any) => { requests.push(message); originalPostMessage(message); };
		toggle!.checked = true;
		toggle!.dispatchEvent(new h.window.Event('change', { bubbles: true }));

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

		const moreBtn = h.document.getElementById('mobileMoreBtn')!;
		assert.ok(moreBtn !== null, 'the app bar has a "More actions" button');
		moreBtn.click();
		const menu = h.document.querySelector('.contextMenu.mobileOverflowMenu')!;
		assert.ok(menu !== null, 'the button opened the overflow sheet');
		const labels = Array.from(menu.querySelectorAll('.mobileMenuLabel')).map((label) => label.textContent);
		for (const label of ['Show Remote Branches', 'Statistics', 'Settings']) assert.ok(labels.includes(label), 'the sheet offers ' + label);

		const checkbox = h.document.getElementById('showRemoteBranchesCheckbox') as HTMLInputElement;
		const before = checkbox.checked;
		const switchItem = (menu.querySelector('.mobileMenuSwitch') as HTMLElement)!.closest('.contextMenuItem')!;
		assert.equal((switchItem.querySelector('.mobileMenuSwitch') as HTMLElement)!.classList.contains('on'), before, 'the switch shows the checkbox state');
		(switchItem as HTMLElement).click();
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

		const cdv = h.document.getElementById('cdv')!;
		assert.ok(cdv !== null, 'the commit details view opened');
		assert.ok(cdv.classList.contains('docked'), 'it is docked (the sheet), not inline in the table');
		assert.equal(cdv.parentElement, h.document.body, 'it lives on <body>, over the commit list');

		const row = h.rows()[1];
		assert.equal(h.document.getElementById('cdvMobileTitle')!.textContent, (row as HTMLElement).dataset.hash!.substring(0, 8), 'the title bar names the commit');
		assert.ok(h.document.querySelector('#cdvSummary .cdvmTitle') !== null, 'the summary leads with the subject as its title');
		assert.ok(h.document.querySelector('#cdvSummary .cdvmFacts') !== null, 'and lists the commit facts');
		const listBtn = h.document.getElementById('cdvFileViewTypeList')!;
		assert.ok(listBtn !== null && listBtn.closest('#cdvFilesHeader') !== null, 'the file view controls sit in the Files header');
		assert.equal(h.document.querySelector('#cdvControls #cdvFileViewTypeList'), null, 'not in the title bar');

		const moreActions = h.document.getElementById('cdvMobileActions')!;
		assert.ok(moreActions !== null, 'the sheet offers a "More actions" button');
		moreActions.click();
		const menu = h.document.querySelector('.contextMenu')!;
		assert.ok(menu !== null, '"More actions" opened the commit context menu');
		assert.ok(menu.querySelectorAll('.contextMenuItem').length > 3, 'with the commit actions');

		// A tap on the scrim (the menu element itself, outside its items) dismisses the sheet
		menu.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
		assert.equal(h.document.querySelector('.contextMenu'), null, 'tapping the scrim closed the menu');
	});

	it('hides the view\'s native scrollbar in the mobile layout — the fast scroller is the one indicator (no two bars while scrolling)', () => {
		// jsdom applies no CSS, so the rule is asserted on the stylesheet the build ships
		const sheet = fs.readFileSync(path.join(rootDir, 'media', 'out.min.css'), 'utf8');
		const viewRule = sheet.match(/body\.mobileMode #view\{[^}]*\}/);
		assert.ok(viewRule !== null, 'a body.mobileMode #view rule block exists');
		assert.match(viewRule![0], /scrollbar-width\s*:\s*none/, 'the standard scrollbar is hidden');
		assert.match(viewRule![0], /-ms-overflow-style\s*:\s*none/, 'the legacy IE/Edge scrollbar is hidden');
		const webkitRule = sheet.match(/body\.mobileMode #view::-webkit-scrollbar\s*\{[^}]*\}/);
		assert.ok(webkitRule !== null, 'the WebKit/Chromium pseudo-element rule exists');
		assert.match(webkitRule![0], /display\s*:\s*none/, 'the WebKit/Chromium scrollbar is hidden');
		// The hiding is scoped: the wide layout (no body.mobileMode) keeps its native scrollbar
		const withoutScoped = sheet.replace(/body\.mobileMode #view(\{|::-webkit-scrollbar\s*\{)[^}]*\}/g, '');
		assert.ok(!/(^|[^.\w-])#view\s*\{[^}]*scrollbar-width/.test(withoutScoped), 'no unscoped #view rule hides the wide layout\'s scrollbar');
	});
});

describe('the tablet (mobileAdaptation, wide view) layout', () => {
	async function bootTablet(total: number) {
		const h = await bootView(total);
		setViewWidth(h, 1000);
		const config = clonedConfig(h);
		config.mobileAdaptation = true;
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();
		return h;
	}

	it('renders single-line rows with every column, and no overflow sheet', async () => {
		const h = await bootTablet(30);
		const body = h.document.body;
		assert.ok(body.classList.contains('tabletMode'), 'the tablet layout is rendered');
		assert.ok(body.classList.contains('touchMode'), 'with the shared touch tokens');
		assert.ok(!body.classList.contains('mobileMode'), 'not the phone layout');
		assert.equal(body.style.getPropertyValue('--git-graph-rowHeight'), '40px', 'rows are 40px touch rows');
		assert.ok(h.document.querySelector('#tableColHeaders .dateCol') !== null, 'the Date column is kept');
		assert.ok(h.document.querySelector('#tableColHeaders .authorCol') !== null, 'the Author column is kept');
		assert.equal(h.rows()[0].querySelector('.mobileMeta'), null, 'rows are single-line (no phone meta line)');
	});

	it('opens the commit details in a side pane beside the list, and gives the width back on close', async () => {
		const h = await bootTablet(30);
		h.rows()[1].click();
		await h.pump();
		await sleep(50);

		const cdv = h.document.getElementById('cdv')!;
		assert.ok(cdv !== null && cdv.classList.contains('docked'), 'the details opened docked');
		assert.equal(cdv.parentElement, h.document.body, 'on <body>, beside the list');
		assert.ok(h.document.body.classList.contains('sidePaneOpen'), 'the list makes room for the side pane');
		assert.equal(h.viewElem.style.bottom, '', 'nothing is reserved below the list');
		assert.ok(h.document.getElementById('cdvMobileTitle') !== null, 'the pane has a title bar naming the commit');
		assert.ok(h.document.querySelector('#cdvSummary .cdvmTitle') !== null, 'the summary card leads with the subject');
		assert.ok(h.document.querySelector('#cdvFilesHeader #cdvFileViewTypeList') !== null, 'the file view controls sit in the Files header');

		// "More actions" opens the commit's menu as a popover on <body> (beside the pane, not in #view)
		h.document.getElementById('cdvMobileActions')!.click();
		const menu = h.document.querySelector('.contextMenu')!;
		assert.ok(menu !== null && menu.parentElement === h.document.body, 'the commit menu opened, framed by the page');

		h.document.getElementById('cdvClose')!.click();
		await h.pump();
		assert.equal(h.document.getElementById('cdv'), null, 'the pane closed');
		assert.ok(!h.document.body.classList.contains('sidePaneOpen'), 'the list took its width back');
	});

	it('returns to the original layout when the setting is unchecked', async () => {
		const h = await bootTablet(30);
		const config = clonedConfig(h);
		config.mobileAdaptation = false;
		h.dispatch({ command: 'configChanged', config: config });
		await h.pump();

		const body = h.document.body;
		for (const name of ['tabletMode', 'touchMode', 'mobileMode', 'narrowWindow']) assert.ok(!body.classList.contains(name), 'no ' + name + ' class');
		assert.equal(body.style.getPropertyValue('--git-graph-rowHeight'), h.ROW_HEIGHT + 'px', 'the configured row height is back');
	});
});

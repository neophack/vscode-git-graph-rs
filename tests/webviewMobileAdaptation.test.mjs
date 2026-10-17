/**
 * The mobile layout (docs/MOBILE-DESIGN.md): the `mobileAdaptation` Extension Setting switches
 * the view to a touch-first phone layout while it is at most 600 pixels wide, and back when it
 * widens again. While the setting is disabled the display never changes.
 *
 * - the Date, Author and Commit columns are dropped: the date sits right of the subject, the refs,
 *   author and hash on a second line, in rows of a uniform 52px (the windowed rendering and the
 *   graph follow it)
 * - the app bar keeps Find and Refresh; the other controls move into a "More actions" sheet
 * - the Commit Details View is a full-screen sheet (docked): a title bar with a "More actions"
 *   button that opens the commit's context menu, the subject as its title, a "Files" header
 *   holding the file view controls
 * - a fast scroller appears on the right edge while a long list scrolls
 * - a long press opens the same context menus a right click does
 *
 * These tests boot the full webview (see webviewHarness.mjs), set the emulated view width, and
 * assert on the rendered DOM.
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

/** Boot a view already switched to the mobile layout (setting on, 400px wide). */
async function bootMobileView(total = 300) {
	const h = await bootView(total);
	setViewWidth(h, 400);
	const config = clonedConfig(h);
	config.mobileAdaptation = true;
	h.dispatch({ command: 'configChanged', config: config });
	await h.pump();
	return h;
}

/** Dispatch a single-finger touch event (jsdom has no Touch constructor: the list is stubbed). */
function touch(h, type, target, x = 20, y = 20) {
	const event = new h.window.Event(type, { bubbles: true, cancelable: true });
	const touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y, target: target }];
	Object.defineProperty(event, 'touches', { value: touches });
	target.dispatchEvent(event);
	return event;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

	it('renders two-line rows: the dropped columns move beside and under the subject, in 52px rows', async () => {
		const h = await bootMobileView();

		assert.ok(h.document.body.classList.contains('mobileMode'), 'the mobile layout body class was set');
		assert.equal(h.document.body.style.getPropertyValue('--git-graph-rowHeight'), '52px', 'rows use the mobile row height');
		const row = h.rows()[0];
		const meta = row.querySelector('td:nth-child(2) .mobileMeta');
		assert.ok(meta !== null, 'the description cell carries the meta line');
		assert.equal(meta.querySelector('.mobileMetaHash').textContent, row.dataset.hash.substring(0, 8), 'the meta line names the abbreviated commit');
		assert.ok(meta.querySelector('.mobileMetaAuthor').textContent.length > 0, 'the meta line names the author');
		const date = row.querySelector('td:nth-child(2) .description .mobileMetaDate');
		assert.ok(date !== null && date.textContent.length > 0, 'the subject line carries the date');
		assert.ok(date.title.length > 0, 'with the full date as its tooltip');

		// Windowed rendering spaces its rows with the mobile row height
		const spacer = h.document.querySelector('#virtSpacerBottom td');
		if (spacer !== null) {
			const height = parseInt(spacer.style.height, 10);
			assert.equal(height % 52, 0, 'the bottom spacer covers a whole number of 52px rows');
		}

		// Widening restores the wide layout: no meta line, the configured row height
		setViewWidth(h, 1200);
		h.window.dispatchEvent(new h.window.Event('resize'));
		await sleep(100);
		await h.pump();
		assert.ok(!h.document.body.classList.contains('mobileMode'), 'the mobile layout body class was cleared');
		assert.equal(h.document.body.style.getPropertyValue('--git-graph-rowHeight'), h.ROW_HEIGHT + 'px', 'the configured row height is back');
		assert.equal(h.document.querySelector('.mobileMeta'), null, 'no row carries the meta line');
	});

	it('moves the refs of a commit onto its second line', async () => {
		const h = await bootMobileView();
		const refRow = h.rows().find((row) => row.querySelector('.gitRef') !== null);
		assert.ok(refRow !== undefined, 'a rendered row carries a ref');
		assert.equal(refRow.querySelector('.description .gitRef'), null, 'no ref is left on the subject line');
		assert.ok(refRow.querySelector('.mobileMeta .mobileRefs .gitRef') !== null, 'the refs lead the meta line');
	});

	it('gathers the toolbar into a "More actions" sheet, with Show Remote Branches as a switch', async () => {
		const h = await bootMobileView(30);
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
		const h = await bootMobileView(30);
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

	it('opens the context menu of a commit on a long press, without also selecting the row', async () => {
		const h = await bootMobileView(30);
		const target = h.rows()[2].querySelector('td:nth-child(2) .text');

		touch(h, 'touchstart', target);
		await sleep(600);
		assert.ok(h.document.querySelector('.contextMenu') !== null, 'holding still opened the context menu');
		const end = touch(h, 'touchend', target);
		assert.ok(end.defaultPrevented, 'the click the lifted finger would cause is cancelled');
		assert.equal(h.document.getElementById('cdv'), null, 'the commit details did not open');
	});

	it('treats a moving finger as a scroll, not a long press', async () => {
		const h = await bootMobileView(30);
		const target = h.rows()[2].querySelector('td:nth-child(2) .text');

		touch(h, 'touchstart', target, 20, 20);
		touch(h, 'touchmove', target, 20, 60);
		await sleep(600);
		assert.equal(h.document.querySelector('.contextMenu'), null, 'no context menu while scrolling');
		assert.ok(!touch(h, 'touchend', target).defaultPrevented, 'the touch ends normally');
	});

	it('shows the fast scroller while a long list scrolls, only in the mobile layout', async () => {
		const h = await bootMobileView(300);
		const scroller = h.document.getElementById('fastScroller');
		assert.ok(scroller !== null, 'the fast scroller is on the page');
		// The harness measures only the rendered (windowed) rows: model the list's full height
		const setListScreens = (screens) => Object.defineProperty(h.viewElem, 'scrollHeight', { get: () => screens * h.viewElem.clientHeight, configurable: true });

		setListScreens(40);
		h.viewElem.dispatchEvent(new h.window.Event('scroll'));
		assert.ok(scroller.classList.contains('visible'), 'scrolling a long list reveals it');

		setListScreens(2);
		h.viewElem.dispatchEvent(new h.window.Event('scroll'));
		assert.ok(!scroller.classList.contains('visible'), 'a list of a couple of screens does without it');

		setListScreens(40);
		setViewWidth(h, 1200);
		h.window.dispatchEvent(new h.window.Event('resize'));
		await sleep(100);
		await h.pump();
		h.viewElem.dispatchEvent(new h.window.Event('scroll'));
		assert.ok(!scroller.classList.contains('visible'), 'the wide layout never shows it');
	});

	it('keeps long presses inert in the wide layout', async () => {
		const h = await bootView(30);
		const target = h.rows()[2].querySelector('td:nth-child(2) .text');

		touch(h, 'touchstart', target);
		await sleep(600);
		assert.equal(h.document.querySelector('.contextMenu'), null, 'the wide layout has no long press menu');
		touch(h, 'touchend', target);
	});
});

/**
 * The Repository Tools (the Reflog / Worktrees overlays, opened from the Settings Widget's
 * Repository column) and the Statistics toolbar button (between the path filter and the
 * terminal buttons).
 *
 * The overlays are hidden by sliding up to top:-158px, so their content must be CLEARED on close
 * to collapse the widget below that offset - otherwise the lower part of a tall list stays
 * visible on screen. These tests pin that close() clears the content, that the Settings
 * Widget entries open the Reflog / Worktrees overlays (closing the Settings Widget first, so
 * the two overlays never stack), and that the Statistics button opens its overlay.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootView } from './webviewHarness.mjs';

/** Record the requests the view sends from now on (without breaking the harness's pump). */
function spyOnRequests(h) {
	const requests = [];
	const originalPostMessage = h.window.VSCODE_API.postMessage;
	h.window.VSCODE_API.postMessage = (message) => {
		requests.push(message);
		originalPostMessage(message);
	};
	return requests;
}

function click(h, elem) {
	elem.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
}

/** A minimal reflog page the extension host could have answered with. */
function reflogResponse(entries, moreAvailable = false) {
	return {
		command: 'reflog',
		ref: 'HEAD',
		entries: entries.map((i) => ({
			hash: 'c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			abbrevHash: 'c' + String(i).padStart(4, '0'),
			selector: 'HEAD@{' + i + '}',
			date: 1700000000 - i,
			message: i === 0 ? 'checkout: moving from main to feature' : 'commit: message ' + i,
			dangling: false
		})),
		moreAvailable: moreAvailable,
		error: null
	};
}

describe('the Repository Tools entries in the Settings Widget', () => {
	it('renders them as section buttons in the Repository column', async () => {
		const h = await bootView(5);
		click(h, h.document.getElementById('settingsBtn'));
		assert.ok(h.document.getElementById('settingsWidget').classList.contains('active'));

		for (const id of ['openReflogView', 'openWorktreeDialog']) {
			const btn = h.document.getElementById(id);
			assert.ok(btn !== null, id + ' exists');
			assert.match(btn.className, /(^| )toolBtn( |$)/, id + ' is styled like the other section buttons');
			assert.equal(btn.parentElement.className, 'settingsSectionButtons');
		}
	});

	it('opens the tool overlay and closes the Settings Widget instead of stacking both', async () => {
		const h = await bootView(5);
		const requests = spyOnRequests(h);
		click(h, h.document.getElementById('settingsBtn'));
		click(h, h.document.getElementById('openReflogView'));

		assert.ok(!h.document.getElementById('settingsWidget').classList.contains('active'), 'the Settings Widget closed');
		assert.ok(h.document.getElementById('reflogWidget').classList.contains('active'), 'the Reflog overlay opened');
		assert.ok(requests.some((m) => m.command === 'reflog' && m.ref === 'HEAD'), 'a reflog request was sent');

		// The same handoff applies to the other two tools
		click(h, h.document.getElementById('reflogClose'));
		click(h, h.document.getElementById('settingsBtn'));
		click(h, h.document.getElementById('openWorktreeDialog'));
		assert.ok(!h.document.getElementById('settingsWidget').classList.contains('active'));
		assert.ok(h.document.getElementById('worktreeWidget').classList.contains('active'));
		click(h, h.document.getElementById('worktreeClose'));
	});

	it('leaves no toolbar buttons behind for the Settings Widget entries (Statistics excepted)', async () => {
		const h = await bootView(5);
		for (const id of ['reflogBtn', 'worktreeBtn']) {
			assert.equal(h.document.getElementById(id), null, id + ' was removed from the toolbar');
		}
	});

	it('renders the Statistics button in the toolbar, between the filter and terminal buttons', async () => {
		const h = await bootView(5);
		const btn = h.document.getElementById('statisticsBtn');
		assert.ok(btn !== null, 'statisticsBtn exists');
		assert.equal(btn.previousElementSibling && btn.previousElementSibling.id, 'filterBtn', 'it follows the filter button');
		assert.equal(btn.nextElementSibling && btn.nextElementSibling.id, 'terminalBtn', 'it precedes the terminal button');
		assert.ok(btn.querySelector('svg') !== null, 'it renders the statistics icon');
	});

	it('opens the Statistics overlay from the toolbar button', async () => {
		const h = await bootView(5);
		const requests = spyOnRequests(h);
		click(h, h.document.getElementById('statisticsBtn'));

		assert.ok(h.document.getElementById('statisticsWidget').classList.contains('active'), 'the Statistics overlay opened');
		assert.ok(requests.some((m) => m.command === 'repoStatistics'), 'a repoStatistics request was sent');

		click(h, h.document.getElementById('statisticsClose'));
		assert.ok(!h.document.getElementById('statisticsWidget').classList.contains('active'), 'the Statistics overlay closed');
	});
});

describe('closing a tool overlay clears its content', () => {
	it('clears rendered reflog entries, not just the active class', async () => {
		const h = await bootView(5);
		click(h, h.document.getElementById('settingsBtn'));
		click(h, h.document.getElementById('openReflogView'));

		h.dispatch(reflogResponse([0, 1, 2]));
		assert.equal(h.document.querySelectorAll('#reflogContent .reflogRow').length, 3, 'the entries rendered');

		click(h, h.document.getElementById('reflogClose'));
		assert.ok(!h.document.getElementById('reflogWidget').classList.contains('active'));
		assert.equal(h.document.getElementById('reflogContent').innerHTML, '', 'the content was cleared so the widget collapses off-screen');
	});

	it('clears the Worktrees and Statistics overlays as well', async () => {
		const h = await bootView(5);
		// Worktrees opens from the Settings Widget, Statistics from its toolbar button
		click(h, h.document.getElementById('settingsBtn'));
		click(h, h.document.getElementById('openWorktreeDialog'));
		const worktreeContent = h.document.getElementById('worktreeContent');
		assert.notEqual(worktreeContent.innerHTML, '', 'the loading state rendered');
		click(h, h.document.getElementById('worktreeClose'));
		assert.ok(!h.document.getElementById('worktreeWidget').classList.contains('active'));
		assert.equal(worktreeContent.innerHTML, '', 'the content was cleared so the widget collapses off-screen');

		click(h, h.document.getElementById('statisticsBtn'));
		const statisticsContent = h.document.getElementById('statisticsContent');
		assert.notEqual(statisticsContent.innerHTML, '', 'the loading state rendered');
		click(h, h.document.getElementById('statisticsClose'));
		assert.ok(!h.document.getElementById('statisticsWidget').classList.contains('active'));
		assert.equal(statisticsContent.innerHTML, '', 'the content was cleared so the widget collapses off-screen');
	});
});

describe('the Statistics heatmap tooltips', () => {
	/** Boot the view and render the overlay with one active cell (Mon 09:00, 4 commits). */
	async function bootWithHeatmap() {
		const h = await bootView(5);
		click(h, h.document.getElementById('statisticsBtn'));
		h.dispatch({
			command: 'repoStatistics',
			authors: [{ name: 'Alice', email: 'alice@example.com', commits: 4 }],
			activity: [{ weekday: 1, hour: 9, count: 4 }]
		});
		return h;
	}

	function heatmapCell(h, weekday, hour) {
		const row = h.document.querySelectorAll('#statisticsContent .statisticsHeatmapRow')[weekday];
		return row.querySelectorAll('.statisticsHeatmapCell')[hour];
	}

	it('gives every cell (empty ones included) the date and commit count as tooltip', async () => {
		const h = await bootWithHeatmap();

		const cells = h.document.querySelectorAll('#statisticsContent .statisticsHeatmapCell');
		assert.equal(cells.length, 7 * 24, 'the grid is weekday x hour');
		for (const cell of cells) {
			assert.match(cell.className, /(^| )gg-helpTooltip( |$)/, 'the tooltip hook is on the single class attribute');
			assert.notEqual(cell.getAttribute('data-tooltip'), '', 'every cell has tooltip text');
			assert.equal(cell.getAttribute('tabindex'), null, 'the 168 cells stay out of the tab order');
		}

		assert.match(heatmapCell(h, 1, 9).getAttribute('data-tooltip'), /Mon/);
		assert.match(heatmapCell(h, 1, 9).getAttribute('data-tooltip'), /\b4\b/);
		assert.match(heatmapCell(h, 0, 0).getAttribute('data-tooltip'), /\b0\b/, 'empty cells report zero commits');
	});

	it('pops the shared tooltip when the mouse enters a cell', async () => {
		const h = await bootWithHeatmap();
		const cell = heatmapCell(h, 1, 9);
		cell.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));

		const popup = h.document.getElementById('ggHelpTooltip');
		assert.ok(popup !== null, 'the tooltip popup rendered');
		assert.equal(popup.textContent, cell.getAttribute('data-tooltip'));

		cell.dispatchEvent(new h.window.MouseEvent('mouseout', { bubbles: true }));
		assert.equal(h.document.getElementById('ggHelpTooltip'), null, 'the tooltip popup closed');
	});
});

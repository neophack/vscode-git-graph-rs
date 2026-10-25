// @vitest-environment jsdom
/**
 * The Statistics Widget (src/webview/graph/widgets/statisticsView.ts), ported from the
 * statistics cases of tests/webviewTools.test.mjs: the overlay the toolbar button opens (and the
 * request it sends), that closing it CLEARS the content (the widget hides by sliding up to
 * top:-158px, so leftover content would stay visible on screen), and the commit-activity
 * heatmap's tooltips - every cell (empty ones included) carries the date and commit count, with
 * the tooltip hook on the single class attribute (a second class attribute would be dropped by
 * the HTML parser, silently disabling the tooltip) and the 168 cells out of the tab order.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { observeHelpTooltips } from '../../common/helpTooltip';
import { ControlBar } from '../controlBar/controlBar';
import type { GraphContext } from '../context';
import { StatisticsView } from './statisticsView';

/** A context holding only what the Statistics Widget touches. */
function makeContext() {
	const sent: Array<{ command: string, [key: string]: unknown }> = [];
	const ctx = {
		bridge: { send: (message: { command: string }) => { sent.push(message); } },
		store: { currentRepo: '/repo' }
	};
	return { ctx: ctx as unknown as GraphContext, sent: sent };
}

beforeEach(() => {
	document.body.textContent = '';
});

describe('the Statistics overlay', () => {
	it('is opened by the toolbar button, which sends the repoStatistics request', () => {
		// The skeleton of the toolbar the extension host renders (the button placement itself is
		// the host's markup; the wiring of the button is the control bar's)
		for (const id of ['currentBtn', 'fetchBtn', 'findBtn', 'filterBtn', 'statisticsBtn', 'terminalBtn', 'settingsBtn']) {
			document.body.appendChild(Object.assign(document.createElement('div'), { id: id }));
		}
		document.body.appendChild(Object.assign(document.createElement('div'), { id: 'controlBtns' }));

		const context = makeContext();
		const statistics = new StatisticsView(() => context.ctx);
		const ctx = { ...context.ctx, widgets: { statistics: statistics }, store: { ...context.ctx.store, commitHead: null, commitPathFilter: null, config: { fetchAndPrune: false } } };
		const controls = new ControlBar(() => ctx as unknown as GraphContext);
		controls.initToolbar();

		document.getElementById('statisticsBtn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(document.getElementById('statisticsWidget')!.classList.contains('active')).toBe(true);
		expect(context.sent.some((message) => message.command === 'repoStatistics' && message.repo === '/repo')).toBe(true);
		expect(document.getElementById('statisticsContent')!.innerHTML).not.toBe(''); // the loading state rendered
	});

	it('close clears the content, not just the active class', () => {
		const context = makeContext();
		const statistics = new StatisticsView(() => context.ctx);
		statistics.show();
		const content = document.getElementById('statisticsContent')!;
		expect(content.innerHTML).not.toBe('');

		statistics.close();
		expect(document.getElementById('statisticsWidget')!.classList.contains('active')).toBe(false);
		expect(content.innerHTML).toBe('');
	});
});

describe('the Statistics heatmap tooltips', () => {
	/** The overlay rendered with one active cell (Mon 09:00, 4 commits). */
	function bootWithHeatmap() {
		const context = makeContext();
		const statistics = new StatisticsView(() => context.ctx);
		statistics.show();
		statistics.processResponse(<never>{
			command: 'repoStatistics',
			authors: [{ name: 'Alice', email: 'alice@example.com', commits: 4 }],
			activity: [{ weekday: 1, hour: 9, count: 4 }]
		});
		return statistics;
	}

	function heatmapCell(weekday: number, hour: number) {
		const row = document.querySelectorAll('#statisticsContent .statisticsHeatmapRow')[weekday];
		return row.querySelectorAll('.statisticsHeatmapCell')[hour];
	}

	it('gives every cell (empty ones included) the date and commit count as tooltip', () => {
		bootWithHeatmap();

		const cells = Array.from(document.querySelectorAll<HTMLElement>('#statisticsContent .statisticsHeatmapCell'));
		expect(cells.length).toBe(7 * 24); // the grid is weekday x hour
		for (const cell of cells) {
			expect(cell.className, 'the tooltip hook is on the single class attribute').toMatch(/(^| )gg-helpTooltip( |$)/);
			expect(cell.getAttribute('data-tooltip'), 'every cell has tooltip text').not.toBe('');
			expect(cell.getAttribute('tabindex'), 'the 168 cells stay out of the tab order').toBe(null);
		}

		expect(heatmapCell(1, 9).getAttribute('data-tooltip')).toMatch(/Mon/);
		expect(heatmapCell(1, 9).getAttribute('data-tooltip')).toMatch(/\b4\b/);
		expect(heatmapCell(0, 0).getAttribute('data-tooltip')).toMatch(/\b0\b/); // empty cells report zero commits
	});

	it('pops the shared tooltip when the mouse enters a cell', () => {
		bootWithHeatmap();
		observeHelpTooltips();
		const cell = heatmapCell(1, 9);
		cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

		const popup = document.getElementById('ggHelpTooltip');
		expect(popup).not.toBe(null);
		expect(popup!.textContent).toBe(cell.getAttribute('data-tooltip'));

		cell.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
		expect(document.getElementById('ggHelpTooltip')).toBe(null);
	});
});

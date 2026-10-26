/**
 * The Statistics Widget: an overlay (matching the Settings, Reflog and Worktree widgets) showing a
 * commit-activity heatmap (weekday x hour, binned by each commit author's own local time) above
 * commits-by-author. Read-only - no actions.
 */

import { CLASS_ACTIVE, makeKeyboardActivatable } from '../../common/dom';
import { html, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { injectOnDemandStyles } from '../../common/onDemandStyles';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { StatisticsViewSurface } from './surfaces';
import statisticsCss from '../../styles/statisticsView.css';
import tabletPanelsCss from '../../styles/tablet/panels.css';

// This module sits in an on-demand chunk (task 5.9): its stylesheet rides the chunk as text
// (the sheet carries its own phone-layout section; the tablet sheet follows it)
injectOnDemandStyles(statisticsCss);
injectOnDemandStyles(tabletPanelsCss);

const STATISTICS_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class StatisticsView implements StatisticsViewSurface {
	private readonly widgetElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private isOpen: boolean = false;

	constructor(private readonly ctx: () => GraphContext) {
		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'statisticsWidget';
		setHtml(this.widgetElem, html`<h2>${strings.statisticsTitle}</h2><div id="statisticsContent"></div><div id="statisticsClose"></div>`);
		document.body.appendChild(this.widgetElem);

		this.contentElem = document.getElementById('statisticsContent')!;

		const closeBtn = document.getElementById('statisticsClose')!;
		setHtml(closeBtn, SVG_ICONS.close);
		makeKeyboardActivatable(closeBtn);
		closeBtn.addEventListener('click', () => this.close());
	}

	public show() {
		if (this.isOpen) return;
		const ctx = this.ctx();
		this.isOpen = true;
		this.widgetElem.classList.add(CLASS_ACTIVE);
		setHtml(this.contentElem, html`<div class="statisticsLoading">${SVG_ICONS.loading}</div>`);
		ctx.bridge.send({ command: 'repoStatistics', repo: ctx.store.currentRepo });
	}

	public close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		// The widget is hidden by sliding up to top:-158px: the content must be cleared so the
		// widget collapses below that offset, otherwise the lower part stays visible on screen
		// (the same approach the Settings Widget takes)
		setHtml(this.contentElem, html``);
	}

	public isVisible() {
		return this.isOpen;
	}

	public processResponse(msg: GG.ResponseRepoStatistics) {
		// A response for another repository is stale: the host serves requests concurrently, so
		// a slow answer for the previous repo can arrive after the switch — it must not replace
		// this (re-opened) view's data. A response without the repo echo (a mismatched build)
		// is accepted, like the conflict banner treats its omitted fields.
		if (!this.isOpen || (msg.repo !== undefined && msg.repo !== this.ctx().store.currentRepo)) return;
		setHtml(this.contentElem, html`<h3>${strings.statisticsHeatmapTitle}</h3>${this.renderHeatmap(msg.activity)}<h3>${strings.statisticsAuthorsTitle}</h3>${this.renderAuthors(msg.authors)}`);
	}

	private renderAuthors(authors: ReadonlyArray<GG.GitAuthorStat>) {
		if (authors.length === 0) {
			return html`<div class="statisticsEmpty">${strings.statisticsNoData}</div>`;
		}
		const sorted = authors.slice().sort((a, b) => b.commits - a.commits);
		const max = sorted[0].commits;

		return html`<table class="statisticsAuthorsTable"><tbody>${sorted.map((author) => {
			const widthPercent = max > 0 ? Math.max(2, Math.round((author.commits / max) * 100)) : 0;
			return html`<tr><td class="statisticsAuthorName" title="${author.name + ' <' + author.email + '>'}">${author.name}</td><td class="statisticsAuthorBarCol"><div class="statisticsAuthorBar" style="width:${widthPercent}%"></div></td><td class="statisticsAuthorCount">${author.commits}</td></tr>`;
		})}</tbody></table>`;
	}

	private renderHeatmap(activity: ReadonlyArray<GG.GitActivityCell>) {
		if (activity.length === 0) {
			return html`<div class="statisticsEmpty">${strings.statisticsNoData}</div>`;
		}
		const counts: number[][] = [];
		for (let w = 0; w < 7; w++) counts.push(new Array(24).fill(0));
		let max = 0;
		for (const cell of activity) {
			if (cell.weekday >= 0 && cell.weekday < 7 && cell.hour >= 0 && cell.hour < 24) {
				counts[cell.weekday][cell.hour] = cell.count;
				if (cell.count > max) max = cell.count;
			}
		}

		const rows = [];
		for (let w = 0; w < 7; w++) {
			const cells = [];
			for (let h = 0; h < 24; h++) {
				const count = counts[w][h];
				const opacity = max > 0 && count > 0 ? Math.max(0.12, count / max) : 0;
				// The tooltip hook must share the cell's single class attribute (a second class
				// attribute would be dropped by the HTML parser, disabling the tooltip), and the
				// cells must not carry helpTooltipAttrs' tabindex: 168 cells would become 168 tab
				// stops. Every cell gets the tooltip, including zero-count ones.
				const info = formatStr(strings.statisticsHeatmapCellInfo, count.toString(), STATISTICS_WEEKDAYS[w], h.toString());
				cells.push(html`<span class="statisticsHeatmapCell gg-helpTooltip" data-tooltip="${info}" aria-label="${info}" style="opacity:${opacity.toFixed(2)}"></span>`);
			}
			rows.push(html`<div class="statisticsHeatmapRow"><span class="statisticsHeatmapLabel">${STATISTICS_WEEKDAYS[w]}</span>${cells}</div>`);
		}
		return html`<div class="statisticsHeatmap">${rows}</div>`;
	}
}

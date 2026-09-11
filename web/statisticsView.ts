/**
 * Implements the Git Graph View's Statistics Widget: an overlay (matching the SettingsWidget /
 * ReflogView / WorktreeDialog pattern) showing a commit-activity heatmap (weekday x hour, binned
 * by each commit author's own local time) above commits-by-author. Read-only - no actions.
 */

const STATISTICS_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class StatisticsView {
	private readonly view: GitGraphView;
	private readonly widgetElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private isOpen: boolean = false;

	constructor(view: GitGraphView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'statisticsWidget';
		this.widgetElem.innerHTML = '<h2>' + escapeHtml(strings.statisticsTitle) + '</h2><div id="statisticsContent"></div><div id="statisticsClose"></div>';
		document.body.appendChild(this.widgetElem);

		this.contentElem = document.getElementById('statisticsContent')!;

		const closeBtn = document.getElementById('statisticsClose')!;
		closeBtn.innerHTML = SVG_ICONS.close;
		makeKeyboardActivatable(closeBtn);
		closeBtn.addEventListener('click', () => this.close());
	}

	public show() {
		if (this.isOpen) return;
		this.isOpen = true;
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.contentElem.innerHTML = '<div class="statisticsLoading">' + SVG_ICONS.loading + '</div>';
		sendMessage({ command: 'repoStatistics', repo: this.view.currentRepo });
	}

	public close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		// The widget is hidden by sliding up to top:-158px: the content must be cleared so the
		// widget collapses below that offset, otherwise the lower part stays visible on screen
		// (the same approach SettingsWidget.close takes)
		this.contentElem.innerHTML = '';
	}

	public isVisible() {
		return this.isOpen;
	}

	public processResponse(msg: GG.ResponseRepoStatistics) {
		if (!this.isOpen) return;
		this.render(msg.authors, msg.activity);
	}

	private render(authors: ReadonlyArray<GG.GitAuthorStat>, activity: ReadonlyArray<GG.GitActivityCell>) {
		this.contentElem.innerHTML = '<h3>' + escapeHtml(strings.statisticsHeatmapTitle) + '</h3>' + this.renderHeatmap(activity)
			+ '<h3>' + escapeHtml(strings.statisticsAuthorsTitle) + '</h3>' + this.renderAuthors(authors);
	}

	private renderAuthors(authors: ReadonlyArray<GG.GitAuthorStat>): string {
		if (authors.length === 0) {
			return '<div class="statisticsEmpty">' + escapeHtml(strings.statisticsNoData) + '</div>';
		}
		const sorted = [...authors].sort((a, b) => b.commits - a.commits);
		const max = sorted[0].commits;

		let html = '<table class="statisticsAuthorsTable"><tbody>';
		for (const author of sorted) {
			const widthPercent = max > 0 ? Math.max(2, Math.round((author.commits / max) * 100)) : 0;
			html += '<tr>'
				+ '<td class="statisticsAuthorName" title="' + escapeHtml(author.name + ' <' + author.email + '>') + '">' + escapeHtml(author.name) + '</td>'
				+ '<td class="statisticsAuthorBarCol"><div class="statisticsAuthorBar" style="width:' + widthPercent + '%"></div></td>'
				+ '<td class="statisticsAuthorCount">' + author.commits + '</td>'
				+ '</tr>';
		}
		html += '</tbody></table>';
		return html;
	}

	private renderHeatmap(activity: ReadonlyArray<GG.GitActivityCell>): string {
		if (activity.length === 0) {
			return '<div class="statisticsEmpty">' + escapeHtml(strings.statisticsNoData) + '</div>';
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

		let html = '<div class="statisticsHeatmap">';
		for (let w = 0; w < 7; w++) {
			html += '<div class="statisticsHeatmapRow">'
				+ '<span class="statisticsHeatmapLabel">' + STATISTICS_WEEKDAYS[w] + '</span>';
			for (let h = 0; h < 24; h++) {
				const count = counts[w][h];
				const opacity = max > 0 && count > 0 ? Math.max(0.12, count / max) : 0;
				// The tooltip hook must share the cell's single class attribute (a second class
				// attribute would be dropped by the HTML parser, disabling the tooltip), and the
				// cells must not carry helpTooltipAttrs' tabindex: 168 cells would become 168 tab
				// stops. Every cell gets the tooltip, including zero-count ones.
				const info = escapeHtml(formatStr(strings.statisticsHeatmapCellInfo, count.toString(), STATISTICS_WEEKDAYS[w], h.toString()));
				html += '<span class="statisticsHeatmapCell gg-helpTooltip" data-tooltip="' + info + '" aria-label="' + info + '" style="opacity:' + opacity.toFixed(2) + '"></span>';
			}
			html += '</div>';
		}
		html += '</div>';
		return html;
	}
}

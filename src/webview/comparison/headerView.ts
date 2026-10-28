/**
 * The header of the Commit Comparison View: the one or two commit description cards (collapsed by
 * default, expanding together), the divider with the commits-between count, and the overall
 * statistics line above the file tree.
 */

import { escapeHtml, html, joinHtml, raw, setHtml } from '../common/html';
import { abbrevCommit } from '../common/util';
import type { ComparisonCommitSummary } from '../../shared/protocol/comparison';
import { ComparisonFileModel } from './model';
import { compareMarkup, compareStrings as s, format } from './../binaryCompare/strings';

/** The hash that stands for the working tree in a comparison (the host's UNCOMMITTED). */
const UNCOMMITTED = '*';

/** One commit description card. The role 'single' (the "Open Changes" presentation) carries no
 *  data-role, so the card keeps its standalone borders instead of the joined halves of a
 *  comparison pair, and shows the commit's subject line between the author and the date
 *  (ellipsized to the available width, so the collapsed card identifies the commit without
 *  expanding its full message). */
function commitCardHtml(hash: string, summaries: { readonly [hash: string]: ComparisonCommitSummary }, role: 'base' | 'compare' | 'single') {
	const roleAttr = role === 'single' ? '' : ' data-role="' + role + '"';
	if (hash === '' || hash === UNCOMMITTED) {
		return html`<div class="commitCard hasMessage"${raw(roleAttr)}><div class="firstLine"><span class="chip">${s.comparePresentLabel}</span><span class="author">${s.compareUncommittedLabel}</span><span class="toggle">&#9656;</span></div><p class="message">${s.compareWorkingTreeLabel}</p></div>`;
	}
	const summary = summaries[hash];
	if (summary === undefined) {
		return html`<div class="commitCard"${raw(roleAttr)}><div class="firstLine"><span class="chip" title="${hash}">${abbrevCommit(hash)}</span></div></div>`;
	}
	const subject = summary.message.split(/\r?\n/)[0];
	return html`<div class="commitCard hasMessage"${raw(roleAttr)}>
		<div class="firstLine">
			<span class="chip" title="${summary.hash}">${abbrevCommit(summary.hash)}</span>
			<span class="author">${summary.author}</span>
			${role === 'single' ? html`<span class="subject" title="${subject}">${subject}</span>` : null}
			<span class="date">${new Date(summary.date * 1000).toLocaleString()}</span>
			<span class="toggle">&#9656;</span>
		</div>
		<p class="message">${summary.message}</p>
	</div>`;
}

export class ComparisonHeader {
	public constructor(private readonly commitCards: HTMLElement, private readonly filesChangedLabel: HTMLElement) {
		// Both commit messages are collapsed by default so they take no vertical space, and expand
		// together (one "expanded" state on the shared container) - clicking either card's header
		// line, or the divider between them, toggles both at once. (In the single-commit
		// presentation there is no divider, only the one card's header line.)
		const toggle = () => { this.commitCards.classList.toggle('expanded'); };
		this.commitCards.addEventListener('click', (event) => {
			const target = <Element>event.target;
			if (target.closest('.commitCard.hasMessage .firstLine') !== null || target.closest('#compareDivider') !== null) toggle();
		});
	}

	/** Render the header's commit cards. In the single-commit presentation only the commit itself
	 *  is shown; otherwise the two ends of the comparison are paired around a divider with the
	 *  commits-between count. */
	public renderCards(fromHash: string, toHash: string, singleCommit: boolean, summaries: { readonly [hash: string]: ComparisonCommitSummary }, commitsBetween: number | null) {
		const commitsBetweenHtml = commitsBetween === null ? html`` : escapeHtml(commitsBetween === 1 ? s.compareCommitsBetweenOne : format(s.compareCommitsBetween, commitsBetween));
		const cards = singleCommit
			? [commitCardHtml(toHash, summaries, 'single')]
			: [
				commitCardHtml(fromHash, summaries, 'base'),
				html`<div class="compareDivider" id="compareDivider" title="${s.compareToggleMessagesTitle}"><span class="arrow">&#8594;</span><span class="count">${commitsBetweenHtml}</span></div>`,
				commitCardHtml(toHash, summaries, 'compare')
			];
		setHtml(this.commitCards, joinHtml(cards));
	}

	/** The statistics line: how many files changed, with the total additions and deletions. */
	public renderStats(changes: ReadonlyArray<ComparisonFileModel>) {
		if (changes.length === 0) return;
		let totalAdditions = 0, totalDeletions = 0;
		for (const file of changes) {
			if (file.additions !== null) totalAdditions += file.additions;
			if (file.deletions !== null) totalDeletions += file.deletions;
		}
		const parts = [
			changes.length === 1 ? s.compareOneFileChanged : format(s.compareFilesChanged, changes.length),
			totalAdditions > 0 ? format(compareMarkup('compareStatsAdditions'), totalAdditions) : '',
			totalDeletions > 0 ? format(compareMarkup('compareStatsDeletions'), totalDeletions) : ''
		];
		setHtml(this.filesChangedLabel, html`${raw(parts[0])}${raw(parts[1])}${raw(parts[2])}`);
	}

	/** The sidebar's heading: the error label when the comparison failed, else the files-changed
	 *  label (renderStats fills in the statistics once the changes arrive). */
	public renderLabel(error: string | null) {
		setHtml(this.filesChangedLabel, escapeHtml(error !== null ? s.compareErrorLabel : s.compareFilesChangedLabel));
	}
}

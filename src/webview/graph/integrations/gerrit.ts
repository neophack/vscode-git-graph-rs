/* The Gerrit integration of the view: the change badge of a commit, and the review information dialog. */

import { formatShortDate } from '../../common/dates';
import { html, joinHtml, SafeHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { arraysEqual } from '../../common/util';
import { CLASS_EXTERNAL_URL } from '../text/textFormatter';
import { Dialog } from '../widgets/dialog';

export const CLASS_REF_GERRIT = 'gerrit';

const GERRIT_EVENT_ICONS: { [type: string]: string } = { 'created': '✎', 'patchset': '○', 'vote': '✓', 'merged': '⏹', 'abandoned': '⊘', 'restored': '↺', 'wip': '⏸', 'ready': '▶', 'comment': '•' };

/** Format a Gerrit vote/score value with an explicit '+' sign for positive values (e.g. "+2", "-1", "0"). */
function formatGerritScore(value: number) {
	return (value > 0 ? '+' : '') + value;
}

/** A Gerrit event's summary text, with its labels (if any) appended (e.g. "Patch Set 2: (Code-Review+2)"). */
function formatGerritEventText(event: GG.GerritChangeEvent) {
	return event.raw + (event.labels !== undefined ? ' (' + event.labels.map((label) => label.name + formatGerritScore(label.value)).join(', ') + ')' : '');
}

function gerritChangeEventsEqual(a: ReadonlyArray<GG.GerritChangeEvent>, b: ReadonlyArray<GG.GerritChangeEvent>) {
	return arraysEqual(a, b, (x, y) =>
		x.type === y.type && x.patchset === y.patchset && x.reviewer === y.reviewer &&
		x.timestamp === y.timestamp && x.raw === y.raw && x.rawFull === y.rawFull &&
		(x.labels === undefined || y.labels === undefined
			? x.labels === y.labels
			: arraysEqual(x.labels, y.labels, (p, q) => p.name === q.name && p.value === q.value))
	);
}

/**
 * Are two Gerrit change state maps equal. Short-circuits on the first difference found, avoiding
 * the cost of JSON.stringify-ing the full (potentially large) event history of every change just
 * to detect whether anything actually changed.
 *
 * The event timelines can be left out of the comparison (`compareEvents` FALSE): the staged Gerrit
 * load delivers them separately from the light part the badges render, and a timeline-only change
 * must not re-render the commit table.
 */
export function gerritStatesEqual(a: { [hash: string]: GG.GerritChangeState }, b: { [hash: string]: GG.GerritChangeState }, compareEvents: boolean = true) {
	const aHashes = Object.keys(a);
	if (aHashes.length !== Object.keys(b).length) return false;
	return aHashes.every((hash) => {
		const x = a[hash], y = b[hash];
		return typeof y !== 'undefined' &&
			x.change === y.change && x.patchset === y.patchset && x.codeReview === y.codeReview &&
			x.verified === y.verified && x.status === y.status && x.wip === y.wip &&
			x.headHash === y.headHash && x.url === y.url &&
			(!compareEvents || gerritChangeEventsEqual(x.events, y.events));
	});
}

/**
 * The Gerrit change badge of a commit: the change number / patchset, the Code-Review and Verified
 * scores (when enabled), and the merged / abandoned / WIP status. Clicking the badge opens the
 * review information dialog of the change.
 */
export function getGerritBadgeHtml(state: GG.GerritChangeState, showReviewProgress: boolean): SafeHtml {
	const score = formatGerritScore;
	let progress: SafeHtml | string = '';
	if (showReviewProgress) {
		progress = html`<span class="gg-label cr${state.codeReview}">CR${score(state.codeReview)}</span>${state.verified !== 0 ? html`<span class="gg-label v${state.verified}">V${score(state.verified)}</span>` : ''}`;
	}
	let status: SafeHtml | string = '';
	if (state.status === 'merged') status = html`<span class="gg-status merged">${strings.gerritStatusMerged}</span>`;
	else if (state.status === 'abandoned') status = html`<span class="gg-status abandoned">${strings.gerritStatusAbandoned}</span>`;
	else if (state.wip) status = html`<span class="gg-status wip">${strings.gerritStatusWip}</span>`;

	const name = '#' + state.change + '/' + state.patchset;
	const title = formatStr(strings.gerritBadgeTitle, String(state.change), String(state.patchset)) + (state.url !== null ? ' — ' + state.url : '');
	return html`<span class="gitRef gerrit" data-name="${name}" data-change="${state.change}" data-ps="${state.patchset}" data-hash="${state.headHash}" title="${title}">${SVG_ICONS.review}<span class="gitRefName" data-fullref="${name}">${name}</span>${progress}${status}</span>`;
}

/**
 * Show the review information dialog of the Gerrit change whose head commit is `hash` (the badge
 * click target). Only commits of changes whose meta ref was parsed have review information.
 */
export function showGerritReviewInfo(dialog: Dialog, gerritStates: { [hash: string]: GG.GerritChangeState }, hash: string, dateFormat: GG.DateFormat) {
	const state = gerritStates[hash];
	if (state === undefined) {
		dialog.showError(strings.gerritReviewDialogTitle, strings.gerritNoReviewInfo, null, null);
		return;
	}
	showGerritDialog(dialog, state, dateFormat);
}

function showGerritDialog(dialog: Dialog, state: GG.GerritChangeState, dateFormat: GG.DateFormat) {
	const score = formatGerritScore;
	const statusClass = state.status === 'merged' ? 'st-merged' : state.status === 'abandoned' ? 'st-abandoned' : (state.wip ? 'st-wip' : 'st-open');
	const statusText = statusClass === 'st-merged' ? strings.gerritStatusMerged : statusClass === 'st-abandoned' ? strings.gerritStatusAbandoned : (statusClass === 'st-wip' ? strings.gerritStatusWip : strings.gerritStatusOpen);

	// state.events is newest → oldest: the change author is the actor of the oldest "Create change" event
	const createdEvent = state.events.slice().reverse().find((event) => event.type === 'created');
	const owner = createdEvent !== undefined && createdEvent.reviewer !== undefined ? createdEvent.reviewer : null;

	let hasDetails = false;
	const timeline = state.events.map((event) => {
		// Older webview states (persisted before rawFull existed) may lack the full record
		const hasFull = typeof event.rawFull === 'string' && event.rawFull.trim() !== '';
		if (hasFull) hasDetails = true;
		return html`<div class="gg-event${hasFull ? ' gg-event-expandable' : ''}"${hasFull ? html` title="${strings.gerritToggleNoteDb}"` : ''}><div class="gg-event-row">${hasFull ? html`<span class="gg-event-toggle">${SVG_ICONS.chevronDown}</span>` : ''}<span class="gg-event-icon">${GERRIT_EVENT_ICONS[event.type] || '•'}</span><span class="gg-event-text">${formatGerritEventText(event)}</span>${event.reviewer !== undefined ? html`<span class="gg-event-reviewer">${event.reviewer}</span>` : ''}<span class="gg-event-date">${formatShortDate(event.timestamp, dateFormat).formatted}</span></div>${hasFull ? html`<pre class="gg-event-detail">${event.rawFull}</pre>` : ''}</div>`;
	});
	// The staged Gerrit load sends the badges' part of the states first and the timelines last: a
	// dialog opened in between says so, rather than showing a silently empty timeline
	const timelinePending = state.events.length === 0 && state.eventsPending === true;

	dialog.showMessage(html`<div class="gg-dialog" data-change="${state.change}"><div class="gg-head"><span class="gg-head-icon">${SVG_ICONS.review}</span><div class="gg-head-main"><div class="gg-title">${formatStr(strings.gerritChangeHeader, String(state.change))}</div><div class="gg-meta"><span class="gg-pill ${statusClass}">${statusText}</span><span class="gg-meta-item">${formatStr(strings.gerritPatchSetLabel, String(state.patchset))}</span>${owner !== null ? html`<span class="gg-meta-item">${formatStr(strings.gerritOwnerLabel, owner)}</span>` : ''}</div></div>${state.url !== null ? html`<a class="gg-open-btn ${CLASS_EXTERNAL_URL}" href="${state.url}" tabindex="-1">${SVG_ICONS.linkExternal}${strings.gerritOpenInGerrit}</a>` : ''}</div><div class="gg-scores"><div class="gg-score"><span class="gg-score-name">${strings.gerritCodeReviewLabel}</span><span class="gg-score-value cr${state.codeReview}">${score(state.codeReview)}</span></div><div class="gg-score"><span class="gg-score-name">${strings.gerritVerifiedLabel}</span><span class="gg-score-value v${state.verified}">${score(state.verified)}</span></div></div><div class="gg-section">${strings.gerritTimelineLabel}</div><div class="gg-timeline">${timelinePending ? html`<span class="gg-hint">${SVG_ICONS.loading}${strings.gerritEventsPending}</span>` : joinHtml(timeline)}</div>${hasDetails && !timelinePending ? html`<span class="gg-hint">${strings.gerritEventsHint}</span>` : ''}</div>`);

	// Show an ✕ close icon in the top-right corner instead of the bottom Close button
	dialog.useCloseIcon();

	// Expand/collapse the detailed NoteDb record of an event when its row is clicked
	dialog.onClick('.gg-event-expandable', (elem) => elem.classList.toggle('expanded'));
}

/**
 * Refresh the review information dialog of a change whose events just arrived (the last stage of
 * the Gerrit load), in place. Does nothing when no review dialog is open: any other dialog that
 * replaced it removed its marker element from the DOM.
 */
export function refreshGerritReviewDialog(dialog: Dialog, gerritStates: { [hash: string]: GG.GerritChangeState }, dateFormat: GG.DateFormat) {
	const elem = document.querySelector<HTMLElement>('.dialog .gg-dialog[data-change]');
	if (elem === null) return;
	const change = parseInt(elem.dataset.change!, 10);
	const hashes = Object.keys(gerritStates);
	for (let i = 0; i < hashes.length; i++) {
		const state = gerritStates[hashes[i]];
		if (state.change === change && !state.eventsPending) {
			showGerritDialog(dialog, state, dateFormat);
			return;
		}
	}
}

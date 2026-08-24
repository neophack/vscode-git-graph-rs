/* Gerrit View (badge + review info dialog) */

const CLASS_REF_GERRIT = 'gerrit';

const GERRIT_EVENT_ICONS: { [type: string]: string } = { 'created': '✎', 'patchset': '○', 'vote': '✓', 'merged': '⏹', 'abandoned': '⊘', 'restored': '↺', 'wip': '⏸', 'ready': '▶', 'comment': '•' };

/** Format a Gerrit vote/score value with an explicit '+' sign for positive values (e.g. "+2", "-1", "0"). */
function formatGerritScore(value: number) {
	return (value > 0 ? '+' : '') + value;
}

/** Format a Gerrit event's summary text, with its labels (if any) appended (e.g. "Patch Set 2: (Code-Review+2)"). */
function formatGerritEventText(event: GG.GerritChangeEvent) {
	return escapeHtml(event.raw) + (event.labels !== undefined ? ' (' + event.labels.map((label) => escapeHtml(label.name) + formatGerritScore(label.value)).join(', ') + ')' : '');
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
 */
function gerritStatesEqual(a: { [hash: string]: GG.GerritChangeState }, b: { [hash: string]: GG.GerritChangeState }) {
	const aHashes = Object.keys(a);
	if (aHashes.length !== Object.keys(b).length) return false;
	return aHashes.every((hash) => {
		const x = a[hash], y = b[hash];
		return typeof y !== 'undefined' &&
			x.change === y.change && x.patchset === y.patchset && x.codeReview === y.codeReview &&
			x.verified === y.verified && x.status === y.status && x.wip === y.wip &&
			x.headHash === y.headHash && x.url === y.url &&
			gerritChangeEventsEqual(x.events, y.events);
	});
}

/**
 * The Gerrit change badge of a commit: the change number / patchset, the Code-Review and Verified
 * scores (when enabled), and the merged / abandoned / WIP status. Clicking the badge opens the
 * review information dialog of the change.
 */
function getGerritBadgeHtml(view: GitGraphView, state: GG.GerritChangeState) {
	const score = formatGerritScore;
	let progress = '';
	if (view.config.gerrit.showReviewProgress) {
		progress = '<span class="gg-label cr' + state.codeReview + '">CR' + score(state.codeReview) + '</span>';
		if (state.verified !== 0) progress += '<span class="gg-label v' + state.verified + '">V' + score(state.verified) + '</span>';
	}
	let status = '';
	if (state.status === 'merged') status = '<span class="gg-status merged">' + strings.gerritStatusMerged + '</span>';
	else if (state.status === 'abandoned') status = '<span class="gg-status abandoned">' + strings.gerritStatusAbandoned + '</span>';
	else if (state.wip) status = '<span class="gg-status wip">' + strings.gerritStatusWip + '</span>';

	const name = '#' + state.change + '/' + state.patchset;
	const title = escapeHtml(formatStr(strings.gerritBadgeTitle, String(state.change), String(state.patchset)) + (state.url !== null ? ' — ' + state.url : ''));
	return '<span class="gitRef gerrit" data-name="' + escapeHtml(name) + '" data-change="' + state.change + '" data-ps="' + state.patchset + '" data-hash="' + escapeHtml(state.headHash) + '" title="' + title + '">' + SVG_ICONS.review + '<span class="gitRefName" data-fullref="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' + progress + status + '</span>';
}

/**
 * Show the review information dialog of the Gerrit change whose head commit is `hash` (the badge
 * click target). Only commits of changes whose meta ref was parsed have review information.
 */
function showGerritReviewInfo(view: GitGraphView, hash: string) {
	const state = view.gerritStates[hash];
	if (state === undefined) {
		dialog.showError(strings.gerritReviewDialogTitle, strings.gerritNoReviewInfo, strings.dialogClose, null);
		return;
	}
	showGerritDialog(state);
}

function showGerritDialog(state: GG.GerritChangeState) {
	const score = formatGerritScore;
	const statusText = state.status === 'merged' ? strings.gerritStatusMerged : state.status === 'abandoned' ? strings.gerritStatusAbandoned : (state.wip ? strings.gerritStatusWip : strings.gerritStatusOpen);
	const icons = GERRIT_EVENT_ICONS;

	// state.events is newest → oldest: the change author is the actor of the oldest "Create change" event
	const createdEvent = state.events.slice().reverse().find((event) => event.type === 'created');
	const owner = createdEvent !== undefined && createdEvent.reviewer !== undefined ? createdEvent.reviewer : null;

	let timeline = '', hasDetails = false;
	for (const event of state.events) {
		// Older webview states (persisted before rawFull existed) may lack the full record
		const hasFull = typeof event.rawFull === 'string' && event.rawFull.trim() !== '';
		if (hasFull) hasDetails = true;
		const detail = hasFull ? '<pre class="gg-event-detail">' + escapeHtml(event.rawFull) + '</pre>' : '';
		timeline += '<div class="gg-event' + (hasFull ? ' gg-event-expandable' : '') + '"' + (hasFull ? ' title="' + strings.gerritToggleNoteDb + '"' : '') + '>' +
			'<div class="gg-event-row">' +
			(detail !== '' ? '<span class="gg-event-toggle">' + SVG_ICONS.chevronDown + '</span>' : '') +
			'<span class="gg-event-icon">' + (icons[event.type] || '•') + '</span>' +
			'<span class="gg-event-text">' + formatGerritEventText(event) + '</span>' +
			(event.reviewer !== undefined ? '<span class="gg-event-reviewer">' + escapeHtml(event.reviewer) + '</span>' : '') +
			'<span class="gg-event-date">' + formatShortDate(event.timestamp).formatted + '</span>' +
			'</div>' +
			detail +
			'</div>';
	}

	dialog.showMessage(
		'<b>' + formatStr(strings.gerritChangeHeader, String(state.change)) + '</b> &middot; ' + formatStr(strings.gerritPatchSetLabel, String(state.patchset)) + ' &middot; <b>' + statusText + '</b>' +
		(owner !== null ? ' &middot; ' + formatStr(strings.gerritOwnerLabel, escapeHtml(owner)) : '') +
		(state.url !== null ? ' &middot; <a class="' + CLASS_EXTERNAL_URL + '" href="' + escapeHtml(state.url) + '" tabindex="-1">' + strings.gerritOpenInGerrit + '</a>' : '') +
		'<br><b>' + strings.gerritCodeReviewLabel + ':</b> ' + score(state.codeReview) + ' &nbsp; <b>' + strings.gerritVerifiedLabel + ':</b> ' + score(state.verified) +
		'<div class="gg-timeline">' + timeline + '</div>' +
		(hasDetails ? '<span class="gg-hint">' + strings.gerritEventsHint + '</span>' : '')
	);

	// Show an ✕ close icon in the top-right corner instead of the bottom Close button
	dialog.useCloseIcon();

	// Expand/collapse the detailed NoteDb record of an event when its row is clicked
	dialog.onClick('.gg-event-expandable', (elem) => elem.classList.toggle('expanded'));
}

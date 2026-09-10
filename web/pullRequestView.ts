/* Pull Request View (badge + details dialog), modelled after the Gerrit change badge and its
   review information dialog. The dialog reuses the Gerrit dialog's styles (gg-*) so both code
   review integrations present the same capsule and dialog look. */

/** Map a pull request state onto the status chip class of the badge and the dialog's status pill. */
function getPullRequestStatusClass(state: GG.PullRequestState) {
	return state === 'open' ? 'open' : state === 'draft' ? 'wip' : state === 'merged' ? 'merged' : 'abandoned';
}

function getPullRequestStatusText(state: GG.PullRequestState) {
	return state === 'merged' ? strings.prStateMerged : state === 'closed' ? strings.prStateClosed : state === 'draft' ? strings.prStateDraft : strings.prStateOpen;
}

/**
 * The pull request badge of a commit: the request number with a status chip (open / draft /
 * merged / closed), styled like the Gerrit change badge. Clicking the badge opens the details
 * dialog of the request.
 */
function getPullRequestBadgeHtml(pr: GG.PullRequestInfo) {
	const name = 'PR #' + pr.number;
	return '<span class="gitRef pr" data-name="' + escapeHtml(name) + '" data-hash="' + escapeHtml(pr.headHash) + '" title="' + escapeHtml(formatStr(strings.prStatusTitle, '#' + pr.number, pr.title)) + '">' + SVG_ICONS.pullRequest + '<span class="gitRefName" data-fullref="' + escapeHtml(name) + '">#' + pr.number + '</span><span class="gg-status ' + getPullRequestStatusClass(pr.state) + '">' + getPullRequestStatusText(pr.state) + '</span></span>';
}

/**
 * Show the details dialog of the pull request whose head commit is `hash` (the badge click
 * target): the title, state, author and branches, the description, and a link that opens the
 * request on its hosting platform (GitHub / GitLab).
 */
function showPullRequestDetails(view: GitGraphView, hash: string) {
	const pr = view.pullRequestsByHead[hash];
	if (pr === undefined) return;
	dialog.showMessage(
		'<div class="gg-dialog pr-dialog" data-number="' + pr.number + '">' +
		'<div class="gg-head">' +
		'<span class="gg-head-icon">' + SVG_ICONS.pullRequest + '</span>' +
		'<div class="gg-head-main">' +
		'<div class="gg-title">' + escapeHtml(pr.title) + '</div>' +
		'<div class="gg-meta">' +
		'<span class="gg-meta-item">#' + pr.number + '</span>' +
		'<span class="gg-pill ' + getPullRequestStatusClass(pr.state) + '">' + getPullRequestStatusText(pr.state) + '</span>' +
		(pr.author !== '' ? '<span class="gg-meta-item">' + escapeHtml(formatStr(strings.prAuthorLabel, pr.author)) + '</span>' : '') +
		'</div>' +
		'</div>' +
		(pr.url !== ''
			? '<a class="gg-open-btn ' + CLASS_EXTERNAL_URL + '" href="' + escapeHtml(pr.url) + '" tabindex="-1">' + SVG_ICONS.linkExternal + strings.prOpenOnHost + '</a>'
			: '') +
		'</div>' +
		'<div class="gg-scores">' +
		'<div class="gg-score"><span class="gg-score-name">' + strings.prBranchesLabel + '</span><span class="gg-score-value">' + escapeHtml(pr.sourceBranch) + ' → ' + escapeHtml(pr.targetBranch) + '</span></div>' +
		'<div class="gg-score"><span class="gg-score-name">' + strings.prHeadCommitLabel + '</span><span class="gg-score-value">' + escapeHtml(abbrevCommit(pr.headHash)) + '</span></div>' +
		'</div>' +
		(pr.body !== '' ? '<div class="gg-section">' + strings.prDescriptionSection + '</div><div class="pr-body">' + escapeHtml(pr.body) + '</div>' : '') +
		'</div>'
	);
	dialog.useCloseIcon();
}

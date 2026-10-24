/* The pull request integration of the view (badge + details dialog), modelled after the Gerrit
   change badge and its review information dialog. The dialog reuses the Gerrit dialog's styles
   (gg-*) so both code review integrations present the same capsule and dialog look. */

import { html, SafeHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { abbrevCommit } from '../../common/util';
import { CLASS_EXTERNAL_URL } from '../text/textFormatter';
import { Dialog } from '../widgets/dialog';

/** The status chip class of the badge (and the dialog's status pill) of a pull request state. */
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
export function getPullRequestBadgeHtml(pr: GG.PullRequestInfo): SafeHtml {
	const name = 'PR #' + pr.number;
	return html`<span class="gitRef pr" data-name="${name}" data-hash="${pr.headHash}" title="${formatStr(strings.prStatusTitle, '#' + pr.number, pr.title)}">${SVG_ICONS.pullRequest}<span class="gitRefName" data-fullref="${name}">#${pr.number}</span><span class="gg-status ${getPullRequestStatusClass(pr.state)}">${getPullRequestStatusText(pr.state)}</span></span>`;
}

/** Whether two pull request indexes (keyed by the commit each request points at) carry the same requests. */
export function pullRequestMapsEqual(a: { [hash: string]: GG.PullRequestInfo }, b: { [hash: string]: GG.PullRequestInfo }) {
	const aHashes = Object.keys(a), bHashes = Object.keys(b);
	return aHashes.length === bHashes.length && aHashes.every((hash) => {
		const x = a[hash], y = b[hash];
		// every field, not only the badge's: the details dialog reads the map too, and must not
		// keep showing a stale description, author or branches after the request was updated
		return typeof y !== 'undefined' && x.number === y.number && x.state === y.state && x.title === y.title &&
			x.author === y.author && x.url === y.url && x.sourceBranch === y.sourceBranch && x.targetBranch === y.targetBranch && x.body === y.body;
	});
}

/**
 * Show the details dialog of the pull request whose head commit is `hash` (the badge click
 * target): the title, state, author and branches, the description, and a link that opens the
 * request on its hosting platform (GitHub / GitLab).
 */
export function showPullRequestDetails(dialog: Dialog, pullRequestsByHead: { [hash: string]: GG.PullRequestInfo }, hash: string) {
	const pr = pullRequestsByHead[hash];
	if (pr === undefined) return;
	const statusClass = getPullRequestStatusClass(pr.state);
	dialog.showMessage(html`<div class="gg-dialog pr-dialog" data-number="${pr.number}"><div class="gg-head"><span class="gg-head-icon">${SVG_ICONS.pullRequest}</span><div class="gg-head-main"><div class="gg-title">${pr.title}</div><div class="gg-meta"><span class="gg-meta-item">#${pr.number}</span><span class="gg-pill ${statusClass}">${getPullRequestStatusText(pr.state)}</span>${pr.author !== '' ? html`<span class="gg-meta-item">${formatStr(strings.prAuthorLabel, pr.author)}</span>` : ''}</div></div>${pr.url !== '' ? html`<a class="gg-open-btn ${CLASS_EXTERNAL_URL}" href="${pr.url}" tabindex="-1">${SVG_ICONS.linkExternal}${strings.prOpenOnHost}</a>` : ''}</div><div class="gg-scores"><div class="gg-score"><span class="gg-score-name">${strings.prBranchesLabel}</span><span class="gg-score-value">${pr.sourceBranch} → ${pr.targetBranch}</span></div><div class="gg-score"><span class="gg-score-name">${strings.prHeadCommitLabel}</span><span class="gg-score-value">${abbrevCommit(pr.headHash)}</span></div></div>${pr.body !== '' ? html`<div class="gg-section">${strings.prDescriptionSection}</div><div class="pr-body">${pr.body}</div>` : ''}</div>`);
	dialog.useCloseIcon();
}

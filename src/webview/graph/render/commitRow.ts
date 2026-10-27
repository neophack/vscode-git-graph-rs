/**
 * The markup of one commit row of the commit table, built from a RowContext (everything a row
 * depends on, computed once per render). Pure: the table (commitTable.ts) decides which rows to
 * build; the keyed patcher (rowPatcher.ts) reconciles them with the DOM.
 */

import { formatCompactDate, formatShortDate } from '../../common/dates';
import { helpTooltipAttrs, html, raw, SafeHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { abbrevCommit, UNCOMMITTED } from '../../common/util';
import { getGerritBadgeHtml } from '../integrations/gerrit';
import { getPullRequestBadgeHtml } from '../integrations/pullRequests';
import { getBranchLabels, getTagLabels } from '../layout/refLabels';
import { TextFormatter } from '../text/textFormatter';
import { ColumnVisibility } from './layoutMode';

/** Everything the rows of one render depend on. */
export interface RowContext {
	readonly config: GG.GitGraphViewConfig;
	readonly commits: ReadonlyArray<GG.GitCommit>;
	readonly commitHead: string | null;
	readonly gitBranchHead: string | null;
	readonly narrow: boolean;
	readonly colVisibility: ColumnVisibility;
	readonly currentHash: string | null;
	readonly vertexColours: ReadonlyArray<number>;
	readonly widthsAtVertices: ReadonlyArray<number>;
	readonly mutedCommits: ReadonlyArray<boolean>;
	readonly pinnedCommitHashes: ReadonlySet<string>;
	readonly gerritStates: { readonly [hash: string]: GG.GerritChangeState };
	readonly gerritVisibleChanges: ReadonlySet<number>;
	readonly pullRequestsByHead: { readonly [hash: string]: GG.PullRequestInfo };
	readonly avatars: { readonly [email: string]: string };
	/** The full message bodies fetched so far (for "Show Commit Body Inline"). */
	readonly commitBodies: { readonly [hash: string]: string };
	readonly textFormatter: TextFormatter;
	/** Format a message text (cached by the table). */
	formatText(text: string): SafeHtml;
}

function resizeColHtml(col: number): SafeHtml {
	return html`${col > 0 ? html`<span class="resizeCol left" data-col="${col - 1}"></span>` : ''}${col < 4 ? html`<span class="resizeCol right" data-col="${col}"></span>` : ''}`;
}

/**
 * Build the row of the commit at index `i`.
 */
export function getCommitRowHtml(i: number, ctx: RowContext): SafeHtml {
	const config = ctx.config, colVisibility = ctx.colVisibility;
	const commit = ctx.commits[i];
	let subject = commit.message.split(/\r?\n/)[0];
	let body = '';

	if (config.showBodyInline) {
		// The full body is fetched on demand (the commit list only carries subjects)
		const fullMessage = ctx.commitBodies[commit.hash];
		if (typeof fullMessage === 'string') {
			const splitMessage = fullMessage.split(/\r?\n/);
			if (splitMessage.length > 1) {
				subject = splitMessage[0];
				splitMessage.shift();
				body = splitMessage.join(' ').replace(/\s+/g, ' ').trim();
			}
		}
	}

	const message = html`<span class="text">${ctx.formatText(subject)}${body !== '' && config.showBodyInline ? html` <span class="commitbody">${ctx.formatText(body)}</span>` : ''}</span>`;
	const date = formatShortDate(commit.date, config.dateFormat);
	const branchLabels = getBranchLabels(commit.heads, commit.remotes, config.referenceLabels.combineLocalAndRemoteBranchLabels);
	let refBranches: SafeHtml = html``, branchCheckedOutAtCommit: string | null = null;

	// The ref labels' accessible names (F5 accessibility): the icon-plus-abbreviated-text spans
	// read as just the ref name, which loses what kind of ref it is - the aria-label says it
	// ("branch main"; the checked-out branch is marked ", HEAD"). Git's own vocabulary, not UI
	// prose, so it is not part of the string tables.
	const branchRefAttrs = (name: string, active: boolean) => html`aria-label="branch ${name}${active ? ', HEAD' : ''}"`;
	for (let j = 0; j < branchLabels.heads.length; j++) {
		const head = branchLabels.heads[j];
		const refActive = head.name === ctx.gitBranchHead;
		const refHtml = html`<span class="gitRef head${refActive ? ' active' : ''}" data-name="${head.name}" ${branchRefAttrs(head.name, refActive)}>${SVG_ICONS.branch}<span class="gitRefName" data-fullref="${head.name}">${head.name}</span>${head.remotes.map((remote) =>
			html`<span class="gitRefHeadRemote" data-remote="${remote}" data-fullref="${remote + '/' + head.name}">${remote}</span>`)}</span>`;
		refBranches = refActive ? html`${refHtml}${refBranches}` : html`${refBranches}${refHtml}`;
		if (refActive) branchCheckedOutAtCommit = ctx.gitBranchHead;
	}
	for (let j = 0; j < branchLabels.remotes.length; j++) {
		const remote = branchLabels.remotes[j];
		refBranches = html`${refBranches}<span class="gitRef remote" data-name="${remote.name}" data-remote="${remote.remote !== null ? remote.remote : ''}" ${branchRefAttrs(remote.name, false)}>${SVG_ICONS.branch}<span class="gitRefName" data-fullref="${remote.name}">${remote.name}</span></span>`;
	}

	const refTags = getTagLabels(commit.tags).map((tag) =>
		html`<span class="gitRef tag" data-name="${tag.name}" data-tagtype="${tag.annotated ? 'annotated' : 'lightweight'}" aria-label="tag ${tag.name}">${SVG_ICONS.tag}<span class="gitRefName" data-fullref="${tag.name}">${tag.name}</span>${tag.remotes.map((remote) =>
			html`<span class="gitRefHeadRemote" data-remote="${remote}" data-fullref="${remote + '/tags/' + tag.name}">${remote}</span>`)}</span>`);

	let refGerrit: SafeHtml | string = '';
	const gerritState = ctx.gerritStates[commit.hash];
	if (typeof gerritState !== 'undefined' && ctx.gerritVisibleChanges.has(gerritState.change)) {
		refGerrit = getGerritBadgeHtml(gerritState, config.gerrit.showReviewProgress);
	}

	const pullRequest = ctx.pullRequestsByHead[commit.hash];
	const refPullRequest: SafeHtml | string = typeof pullRequest !== 'undefined' ? getPullRequestBadgeHtml(pullRequest) : '';

	if (commit.stash !== null) {
		refBranches = html`<span class="gitRef stash" data-name="${commit.stash.selector}" aria-label="stash ${commit.stash.selector.substring(5)}">${SVG_ICONS.stash}<span class="gitRefName" data-fullref="${commit.stash.selector}">${commit.stash.selector.substring(5)}</span></span>${refBranches}`;
	}

	const commitDot = commit.hash === ctx.commitHead
		? html`<span ${helpTooltipAttrs(branchCheckedOutAtCommit !== null
			? formatStr(strings.checkedOutBranchAtCommit, branchCheckedOutAtCommit)
			: strings.commitCurrentlyCheckedOut, 'commitHeadDot')}></span>`
		: '';
	const pinnedBadge = ctx.pinnedCommitHashes.has(commit.hash)
		? html`<span ${helpTooltipAttrs(strings.pinnedBadgeTitle, 'pinnedBadge')}>📌</span>`
		: '';
	// The "Open Changes" action shown at the end of the description: it opens the commit's
	// changes (diffed against its first parent) in a Commit Comparison View tab. Root commits
	// have nothing to diff against, so they don't get the button. The tooltip carries the
	// commit's subject, capped at 32 characters, so the target of the action is identifiable.
	const openChangesSubject = subject.length > 32 ? subject.substring(0, 32) + '…' : subject;
	const openChangesBtn = commit.parents.length > 0
		? html`<span class="openChangesBtn" title="${formatStr(strings.openChangesTitleWithSubject, openChangesSubject)}">${SVG_ICONS.openChanges}</span>`
		: '';
	// The grid row semantics (F5 accessibility): role="row" under the table's role="grid", the
	// ABSOLUTE row index (the header row is 1, the first commit 2 - the windowed render keeps only
	// a slice of the rows in the DOM, so the DOM position is not the grid position), and
	// tabindex="-1" - the table's roving tabindex (render/tableKeyboard.ts) makes exactly one row
	// the Tab stop. The markup values are restamped in place when a row's position changes without
	// the row changing (the keyed patch), so they must not take part in the signature comparison.
	const rowOpen = (rest: SafeHtml) => html`<tr class="commit${commit.hash === ctx.currentHash ? ' current' : ''}${ctx.mutedCommits[i] ? ' mute' : ''}" role="row" aria-rowindex="${i + 2}" tabindex="-1"${commit.hash !== UNCOMMITTED ? '' : raw(' id="uncommittedChanges"')} data-id="${i}" data-hash="${commit.hash}" data-color="${ctx.vertexColours[i]}">${rest}</tr>`;

	if (ctx.narrow) {
		// The mobile layout drops the Date, Author and Commit columns. Its two-line row reads
		// like a mail list: the subject with a compact date on the right, then the refs, the
		// author and the abbreviated hash. Refs moved off the first line keep the subject
		// readable on a phone; the full date stays in the date's tooltip.
		const refs = html`${refBranches}${refTags}${refGerrit}${refPullRequest}`;
		const hasRefs = refs.html !== '';
		return rowOpen(html`<td>${resizeColHtml(0)}</td><td>${resizeColHtml(1)}<span class="description">${commitDot}${pinnedBadge}${message}<span class="mobileMetaDate" title="${date.title}">${formatCompactDate(commit.date, config.dateFormat)}</span></span><span class="mobileMeta">${hasRefs ? html`<span class="mobileRefs">${refs}</span>` : ''}${commit.hash !== UNCOMMITTED ? html`<span class="mobileMetaAuthor">${commit.author}</span><span class="mobileMetaHash">${abbrevCommit(commit.hash)}</span>` : ''}</span></td>`);
	}

	const tagsOnRight = config.referenceLabels.tagLabelsOnRight;
	const descriptionRefs = tagsOnRight
		? html`${refGerrit}${refPullRequest}${message}${openChangesBtn}${refTags.length > 0 ? html`<span class="tagsWrapper">${refTags}</span>` : ''}`
		: html`${refTags}${refGerrit}${refPullRequest}${message}${openChangesBtn}`;
	const graphAndDescription = config.referenceLabels.branchLabelsAlignedToGraph
		? html`<td>${resizeColHtml(0)}${refBranches.html !== '' ? raw('<span style="margin-left:' + (ctx.widthsAtVertices[i] - 4) + 'px"' + refBranches.html.substring(5)) : ''}</td><td>${resizeColHtml(1)}<span class="description">${commitDot}${pinnedBadge}`
		: html`<td>${resizeColHtml(0)}</td><td>${resizeColHtml(1)}<span class="description">${commitDot}${pinnedBadge}${refBranches}`;

	return rowOpen(html`${graphAndDescription}${descriptionRefs}</span></td>${colVisibility.date ? html`<td class="dateCol text" title="${date.title}">${resizeColHtml(2)}${date.formatted}</td>` : ''}${colVisibility.author ? html`<td class="authorCol text" title="${commit.author + ' <' + commit.email + '>'}">${resizeColHtml(3)}${config.fetchAvatars ? html`<span class="avatar" data-email="${commit.email}">${typeof ctx.avatars[commit.email] === 'string' ? html`<img class="avatarImg" decoding="sync" src="${ctx.avatars[commit.email]}">` : ''}</span>` : ''}${commit.author}</td>` : ''}${colVisibility.commit ? html`<td class="text" title="${commit.hash}">${resizeColHtml(4)}${abbrevCommit(commit.hash)}</td>` : ''}`);
}

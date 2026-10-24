/* The mobile layout's Commit Details sheet: the commit summary laid out like a message in a phone
   app, the "Files" section header and the title bar text. */

import { formatLongDate, formatMediumDate } from '../../common/dates';
import { generateSignatureHtml } from '../../common/gitNames';
import { html, HtmlValue, SafeHtml } from '../../common/html';
import { formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { abbrevCommit, UNCOMMITTED } from '../../common/util';
import { CLASS_EXTERNAL_URL, CLASS_INTERNAL_URL, TextFormatter } from '../text/textFormatter';
import { ExpandedCommit } from '../state/types';

/** The sheet's title bar text: the abbreviated commit, or what is being compared. */
export function getMobileCdvTitle(expandedCommit: ExpandedCommit, commitOrder: { from: string, to: string }) {
	if (expandedCommit.compareWithHash !== null) return abbrevCommit(commitOrder.from) + ' → ' + (commitOrder.to !== UNCOMMITTED ? abbrevCommit(commitOrder.to) : strings.mobileUncommittedTitle);
	return expandedCommit.commitHash !== UNCOMMITTED ? abbrevCommit(expandedCommit.commitHash) : strings.mobileUncommittedTitle;
}

/** The commit message as the message block shows it: whole in the wide layout; in the mobile sheet without its subject, which is the sheet's title there. */
export function getCdvMessageBody(body: string, isMobile: boolean) {
	if (!isMobile) return body;
	const newline = body.indexOf('\n');
	return newline < 0 ? '' : body.substring(newline + 1).replace(/^\s*\n/, '').replace(/\s+$/, '');
}

/** A round avatar: the fetched one, else the author's initials on a colour derived from the name. */
function getMobileAvatarHtml(name: string, avatar: string | null): SafeHtml {
	if (avatar !== null) return html`<span class="cdvmAvatar"><img src="${avatar}"></span>`;
	const words = name.trim().split(/\s+/).filter((w) => w !== '');
	// A CJK name is written without spaces: its first character stands for it. (Code point ranges
	// rather than a regex: the minifier would turn a regex's escapes into literal characters,
	// which break the bundle wherever it is not decoded as UTF-8.)
	const isCjk = Array.from(name).some((ch) => {
		const cp = ch.codePointAt(0)!;
		return (cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x3400 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7AF);
	});
	const initials = words.length === 0 ? '?'
		: isCjk ? Array.from(words[0])[0]
			: words.slice(0, 2).map((w) => Array.from(w)[0]).join('').toUpperCase();
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return html`<span class="cdvmAvatar" style="--cdvm-avatar-hue:${Math.abs(hash) % 360}">${initials}</span>`;
}

/** The "+A −D" line totals of the mobile "Files" header: empty until every file's counts have arrived. */
export function getMobileFilesStatHtml(fileChanges: ReadonlyArray<GG.GitFileChange>, pendingCounts: ReadonlySet<string> | null): SafeHtml {
	if (pendingCounts !== null && pendingCounts.size > 0) return html``;
	let additions = 0, deletions = 0;
	for (const file of fileChanges) {
		if (file.additions !== null) additions += file.additions;
		if (file.deletions !== null) deletions += file.deletions;
	}
	return additions + deletions > 0 ? html`<span class="cdvmAdd">+${additions.toLocaleString()}</span><span class="cdvmDel">−${deletions.toLocaleString()}</span>` : html``;
}

/** The mobile sheet's "Files" section header: how many files changed, the line totals, the file view controls. */
export function renderMobileFilesHeader(fileChanges: ReadonlyArray<GG.GitFileChange>, pendingCounts: ReadonlySet<string> | null, fileViewBtns: SafeHtml): SafeHtml {
	return html`<div id="cdvFilesHeader"><span class="cdvmFilesCount">${fileChanges.length === 1 ? strings.mobileFileChanged : formatStr(strings.mobileFilesChanged, fileChanges.length.toLocaleString())}</span><span class="cdvmFilesStat">${getMobileFilesStatHtml(fileChanges, pendingCounts)}</span><span class="cdvmFileViewBtns">${fileViewBtns}</span></div>`;
}

/** What the mobile summary needs from the view. */
export interface MobileSummaryInput {
	readonly commitDetails: GG.GitCommitDetails;
	readonly avatar: string | null;
	readonly textFormatter: TextFormatter;
	readonly dateFormat: GG.DateFormat;
	/** Is a position known for a parent commit in the loaded commits. */
	isParentLoaded(parent: string): boolean;
	/** The message block (body + Markdown toggle) markup, or NULL when the message has no body to show. */
	renderMessageBlock(): SafeHtml | null;
}

/**
 * The commit summary of the mobile sheet, laid out like a message in a phone app: the subject as
 * the title, a byline (avatar, author, date), the rest of the message, then the commit's facts as
 * a grouped list. The parents keep the internal links of the wide layout (tapping one opens it).
 */
export function renderMobileCommitSummary(input: MobileSummaryInput): SafeHtml {
	const commitDetails = input.commitDetails, dateFormat = input.dateFormat;
	const label = (labelHtml: SafeHtml) => labelHtml.html.replace(/<[^>]*>/g, '').replace(/\s*[:：]\s*$/, '');
	const fact = (labelHtml: SafeHtml, valueHtml: HtmlValue, className: string = '') => html`<div class="cdvmFact"><span class="cdvmFactLabel">${label(labelHtml)}</span><span class="cdvmFactValue${className !== '' ? ' ' + className : ''}">${valueHtml}</span></div>`;
	const person = (name: string, email: string) => html`${name}${email !== '' ? html`<a class="cdvmEmail ${CLASS_EXTERNAL_URL}" href="mailto:${email}" tabindex="-1">${email}</a>` : ''}`;
	const subject = commitDetails.body.split(/\r?\n/)[0];
	const parents = commitDetails.parents.length > 0
		? commitDetails.parents.map((parent) => input.isParentLoaded(parent)
			? html`<span class="cdvmChip ${CLASS_INTERNAL_URL}" data-type="commit" data-value="${parent}" tabindex="-1" title="${parent}">${abbrevCommit(parent)}</span>`
			: html`<span class="cdvmChip" title="${parent}">${abbrevCommit(parent)}</span>`)
		: strings.noneValue;
	const sameCommitter = commitDetails.committer === commitDetails.author && commitDetails.committerEmail === commitDetails.authorEmail;
	const messageBlock = input.renderMessageBlock();
	return html`<div class="cdvmHeader"><div class="cdvmTitle">${input.textFormatter.format(subject)}</div><div class="cdvmByline">${getMobileAvatarHtml(commitDetails.author, input.avatar)}<span class="cdvmByText"><span class="cdvmAuthor">${commitDetails.author}</span><span class="cdvmDate" title="${formatLongDate(commitDetails.authorDate, dateFormat)}">${formatMediumDate(commitDetails.authorDate, dateFormat)}</span></span></div></div>${messageBlock !== null ? html`<div class="cdvmMessage">${messageBlock}</div>` : ''}<div class="cdvmFacts">${fact(markup.cdvCommitLabel, commitDetails.hash, 'cdvmMono')}${fact(markup.cdvParentsLabel, parents)}${fact(markup.cdvAuthorLabel, person(commitDetails.author, commitDetails.authorEmail))}${!sameCommitter || commitDetails.signature !== null ? fact(markup.cdvCommitterLabel, html`${person(commitDetails.committer, commitDetails.committerEmail)}${commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : ''}`) : ''}${commitDetails.authorDate !== commitDetails.committerDate ? fact(markup.cdvCommitterDateLabel, formatMediumDate(commitDetails.committerDate, dateFormat)) : ''}</div>`;
}

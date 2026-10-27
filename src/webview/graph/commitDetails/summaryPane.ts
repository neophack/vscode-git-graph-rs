/* The Commit Details View's summary pane: the summary card of the open commit (the mobile sheet's
   message-style card, or the wide layout's key-value block) and the commit message body with its
   Markdown / Plain toggle. */

import { formatLongDate } from '../../common/dates';
import { generateSignatureHtml } from '../../common/gitNames';
import { html, SafeHtml, setHtml } from '../../common/html';
import { formatStr, markup, strings } from '../../common/i18n/index';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import type { Store } from '../state/store';
import { ExpandedCommit } from '../state/types';
import { hasMarkdown, isMarkdownLoaded, loadMarkdown, renderMarkdown } from '../text/markdown';
import { CLASS_EXTERNAL_URL, CLASS_INTERNAL_URL, TextFormatter } from '../text/textFormatter';
import { getCdvMessageBody, renderMobileCommitSummary } from './mobileSummary';
import { PanelSurface } from './panelSurface';

/** The element with the given id under the panel's scope, or NULL (the shell's scoped lookup). */
function byId(scope: ParentNode, id: string): HTMLElement | null {
	return scope.querySelector<HTMLElement>('#' + id);
}

/** The formatter of the commit message body (the summary card's title and message text). */
export function createMessageFormatter(store: Store): TextFormatter {
	return new TextFormatter(store.commits, store.getIssueLinkingConfig(), {
		commits: true,
		emoji: true,
		issueLinking: true,
		markdown: store.config.markdown,
		multiline: true,
		urls: true
	});
}

/**
 * Render a commit message body: as block-level Markdown (with a toggle to switch to the plain
 * inline-formatted view) when the `git-graph-rs.markdown` setting is on and the message looks
 * like it contains Markdown, otherwise exactly as before (inline formatting only).
 */
export function renderCommitMessageBody(ctx: GraphContext, getScope: () => ParentNode, expandedCommit: ExpandedCommit, body: string, textFormatter: TextFormatter): SafeHtml {
	const offerToggle = ctx.store.config.markdown && hasMarkdown(body);
	const showMarkdown = offerToggle && expandedCommit.showMarkdown;
	if (showMarkdown && !isMarkdownLoaded()) {
		// The Markdown renderer's on-demand chunk has not landed yet (task 5.9): paint the
		// plain inline-formatted body now - never blank, never blocked - and swap in the
		// rendered Markdown the moment the module resolves, provided this same commit is
		// still the open one.
		void loadMarkdown().then(() => {
			if (ctx.store.expandedCommit !== expandedCommit) return;
			const bodyElem = byId(getScope(), 'cdvMessageBody');
			if (bodyElem !== null) setHtml(bodyElem, renderMarkdown(body));
		}, () => undefined);
		return html`<span id="cdvMessageBody">${textFormatter.format(body)}</span>${offerToggle ? html`<span id="cdvMarkdownToggle" class="cdvMarkdownToggle" role="button" tabindex="0">${strings.plainTextToggleLabel}</span>` : ''}`;
	}
	return html`<span id="cdvMessageBody">${showMarkdown ? renderMarkdown(body) : textFormatter.format(body)}</span>${offerToggle ? html`<span id="cdvMarkdownToggle" class="cdvMarkdownToggle" role="button" tabindex="0">${showMarkdown ? strings.plainTextToggleLabel : strings.markdownToggleLabel}</span>` : ''}`;
}

/** Wrap standalone note content in the mobile sheet's note style; the wide layout takes it bare. */
function mobileNote(ctx: GraphContext, content: SafeHtml | string): SafeHtml {
	return ctx.layout.isTouchLayout() ? html`<div class="cdvmNote">${content}</div>` : html`${content}`;
}

/** Render the summary of the open commit (or of the comparison, or the uncommitted-changes note). */
export function renderSummary(ctx: GraphContext, getScope: () => ParentNode, expandedCommit: ExpandedCommit, commitOrder: { from: string, to: string }): SafeHtml {
	// The phone sheet and the tablet side pane share the stacked summary card
	const store = ctx.store, isMobile = ctx.layout.isTouchLayout();
	if (expandedCommit.compareWithHash !== null) {
		// Commit comparison should be shown
		return mobileNote(ctx, formatStr(markup.displayingChangesFromTo, commitOrder.from, commitOrder.to !== UNCOMMITTED ? commitOrder.to : strings.uncommittedChangesLabel));
	}
	if (expandedCommit.commitHash === UNCOMMITTED) {
		return mobileNote(ctx, strings.displayingUncommitted);
	}

	// Commit details should be shown
	const textFormatter = createMessageFormatter(store);
	const commitDetails = expandedCommit.commitDetails!;
	const dateFormat = store.config.dateFormat;
	if (isMobile) {
		const body = getCdvMessageBody(commitDetails.body, true);
		return renderMobileCommitSummary({
			commitDetails: commitDetails,
			avatar: expandedCommit.avatar,
			textFormatter: textFormatter,
			dateFormat: dateFormat,
			isParentLoaded: (parent) => store.getCommitId(parent) !== null,
			renderMessageBlock: () => body !== '' || (store.config.markdown && hasMarkdown(commitDetails.body))
				? renderCommitMessageBody(ctx, getScope, expandedCommit, body, textFormatter)
				: null
		});
	}

	const parents: Array<SafeHtml | string> = [];
	commitDetails.parents.forEach((parent, i) => {
		if (i > 0) parents.push(', ');
		parents.push(store.getCommitId(parent) !== null
			? html`<span class="${CLASS_INTERNAL_URL}" data-type="commit" data-value="${parent}" tabindex="-1">${parent}</span>`
			: parent);
	});
	const person = (name: string, email: string) => html`${name}${email !== '' ? html` &lt;<a class="${CLASS_EXTERNAL_URL}" href="mailto:${email}" tabindex="-1">${email}</a>&gt;` : ''}`;
	return html`<span class="cdvSummaryTop${expandedCommit.avatar !== null ? ' withAvatar' : ''}"><span class="cdvSummaryTopRow"><span class="cdvSummaryKeyValues">${markup.cdvCommitLabel}${commitDetails.hash}<br>${markup.cdvParentsLabel}${commitDetails.parents.length > 0 ? parents : strings.noneValue}<br>${markup.cdvAuthorLabel}${person(commitDetails.author, commitDetails.authorEmail)}<br>${commitDetails.authorDate !== commitDetails.committerDate ? html`${markup.cdvAuthorDateLabel}${formatLongDate(commitDetails.authorDate, dateFormat)}<br>` : ''}${markup.cdvCommitterLabel}${person(commitDetails.committer, commitDetails.committerEmail)}${commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : ''}<br>${commitDetails.authorDate !== commitDetails.committerDate ? markup.cdvCommitterDateLabel : markup.cdvDateLabel}${formatLongDate(commitDetails.committerDate, dateFormat)}</span>${expandedCommit.avatar !== null ? html`<span class="cdvSummaryAvatar"><img src="${expandedCommit.avatar}"></span>` : ''}</span></span><br><br>${renderCommitMessageBody(ctx, getScope, expandedCommit, commitDetails.body, textFormatter)}`;
}

/**
 * Flip the Markdown / Plain toggle of the open commit, re-rendering only the message body and its toggle (no full re-render, so nothing scrolls or flashes).
 */
export function toggleMessageMarkdown(ctx: GraphContext, getScope: () => ParentNode) {
	const store = ctx.store, expandedCommit = store.expandedCommit;
	if (expandedCommit === null || expandedCommit.commitDetails === null || expandedCommit.commitHash === UNCOMMITTED) return;
	store.slices.details.toggleMarkdown();
	const textFormatter = createMessageFormatter(store);
	const bodyElem = byId(getScope(), 'cdvMessageBody'), toggleElem = byId(getScope(), 'cdvMarkdownToggle');
	if (bodyElem === null || toggleElem === null) return;
	const body = getCdvMessageBody(expandedCommit.commitDetails.body, ctx.layout.isTouchLayout());
	const renderBody = () => setHtml(bodyElem, expandedCommit.showMarkdown ? renderMarkdown(body) : textFormatter.format(body));
	if (expandedCommit.showMarkdown && !isMarkdownLoaded()) {
		// Flipping to Markdown before the on-demand renderer landed (task 5.9): keep the
		// toggle's label in sync immediately and paint the rendered body once it resolves
		void loadMarkdown().then(renderBody, () => undefined);
	} else {
		renderBody();
	}
	toggleElem.textContent = expandedCommit.showMarkdown ? strings.plainTextToggleLabel : strings.markdownToggleLabel;
}

/** Wire the Markdown / Plain toggle of the rendered message body (its listeners live on the current render's surface store, F3). */
export function wireMessageBodyControls(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode) {
	const markdownToggle = byId(getScope(), 'cdvMarkdownToggle');
	if (markdownToggle !== null) {
		surface.makeKeyboardActivatable(markdownToggle);
		surface.listen(markdownToggle, 'click', () => toggleMessageMarkdown(ctx, getScope));
	}
}

/** Observe the summary pane's scrolling: record its position, and close its context menu if one is open. */
export function wireSummaryScroll(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode, expandedCommit: ExpandedCommit) {
	surface.observeScroll(byId(getScope(), 'cdvSummary'), expandedCommit.scrollTop.summary, (scrollTop) => {
		const store = ctx.store;
		if (store.expandedCommit === null) return;
		store.slices.details.setScroll('summary', scrollTop);
		if (store.expandedCommit.contextMenuOpen.summary) {
			store.slices.details.setContextMenuSummaryOpen(false);
			ctx.contextMenu.close();
		}
	}, () => ctx.persistence.saveState());
}

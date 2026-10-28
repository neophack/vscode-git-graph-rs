/**
 * The Reflog Widget: an overlay (matching the Settings and Find widgets) that browses the reflog
 * of `HEAD`, colour-codes entries by a client-side classification of the reflog message (no extra
 * Git call), and flags dangling (unreachable) commits. Per-row actions (checkout, reset, copy)
 * are built here rather than reusing the commit context menu, because that looks the commit up in
 * the currently loaded / filtered commit graph - which a reflog entry, especially a dangling one,
 * is frequently NOT part of.
 */

import { formatShortDate } from '../../common/dates';
import { CLASS_ACTIVE } from '../../common/dom';
import { helpTooltipAttrs, html, setHtml } from '../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { injectOnDemandStyles } from '../../common/onDemandStyles';
import * as GG from '../../common/protocol';
import { abbrevCommit } from '../../common/util';
import { currentBranchHtml } from '../actions/dialogActions';
import { Component } from '../component';
import { GraphContext } from '../context';
import { ContextMenuActions } from './contextMenu';
import { ReflogViewSurface } from './surfaces';
import reflogCss from '../../styles/reflogView.css';

// This module sits in an on-demand chunk: its stylesheet rides the chunk as text
// (the sheet carries its own phone-layout section; the tablet sheet follows it)
injectOnDemandStyles(reflogCss);

const REFLOG_PAGE_SIZE = 200;

/**
 * Classify a reflog message into a colour group, purely by string matching (no extra Git call) -
 * the "semantic colour grouping" idea, simplified to the leading action verb and any
 * `(sub-action)` in parentheses.
 */
export function classifyReflogAction(message: string): string {
	const verbMatch = message.match(/^([a-zA-Z-]+)/);
	const verb = verbMatch !== null ? verbMatch[1].toLowerCase() : '';
	const subMatch = message.match(/\(([^)]+)\)/);
	const sub = subMatch !== null ? subMatch[1].toLowerCase() : '';

	if (sub === 'amend') return 'reflogEdit';
	if (sub === 'squash' || sub === 'fixup') return 'reflogCombine';
	if (sub === 'abort') return 'reflogAbort';
	if (verb === 'reset') return 'reflogAbort';
	if (verb === 'rebase' || verb === 'branch') return 'reflogFlow';
	if (verb === 'merge' || verb === 'pull' || verb === 'checkout' || verb === 'cherry-pick' || verb === 'revert') return 'reflogIntegrate';
	return 'reflogDefault';
}

export class ReflogView extends Component implements ReflogViewSurface {
	private readonly widgetElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private isOpen: boolean = false;
	private ref: string = 'HEAD';
	private limit: number = REFLOG_PAGE_SIZE;

	constructor(private readonly ctx: () => GraphContext) {
		super(document.createElement('div'));
		this.widgetElem = <HTMLElement>this.root;
		this.widgetElem.id = 'reflogWidget';
		setHtml(this.widgetElem, html`<h2>${strings.reflogTitle}</h2><div id="reflogContent"></div><div id="reflogClose"></div>`);
		document.body.appendChild(this.widgetElem);

		this.contentElem = this.byId('reflogContent')!;

		const closeBtn = this.byId('reflogClose')!;
		setHtml(closeBtn, SVG_ICONS.close);
		this.makeKeyboardActivatable(closeBtn);
		this.listen(closeBtn, 'click', () => this.close());
	}

	public isVisible() {
		return this.isOpen;
	}

	public show() {
		if (this.isOpen) return;
		this.isOpen = true;
		this.ref = 'HEAD';
		this.limit = REFLOG_PAGE_SIZE;
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.load();
	}

	public close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		// The widget is hidden by sliding up to top:-158px: the content must be cleared so the
		// widget collapses below that offset, otherwise the lower part of a tall entry list stays
		// visible on screen (the same approach the Settings Widget takes)
		setHtml(this.contentElem, html``);
	}

	private load() {
		const ctx = this.ctx();
		setHtml(this.contentElem, html`<div class="reflogLoading">${SVG_ICONS.loading}</div>`);
		ctx.bridge.send({ command: 'reflog', repo: ctx.store.currentRepo, ref: this.ref, limit: this.limit });
	}

	public processResponse(msg: GG.ResponseReflog) {
		// A response for another repository is stale: the host serves requests concurrently, so
		// a slow answer for the previous repo can arrive after the switch (and after this widget
		// was re-opened for the current one) — rendering it would offer the other repo's hashes.
		// A response without the repo echo (a mismatched build) is accepted, like the conflict
		// banner treats its omitted fields.
		if (!this.isOpen || (msg.repo !== undefined && msg.repo !== this.ctx().store.currentRepo) || msg.ref !== this.ref) return;
		if (msg.error !== null) {
			setHtml(this.contentElem, html`<div class="reflogError">${msg.error}</div>`);
			return;
		}
		this.render(msg.entries, msg.moreAvailable);
	}

	private render(entries: ReadonlyArray<GG.GitReflogEntry>, moreAvailable: boolean) {
		const dateFormat = this.ctx().store.config.dateFormat;
		if (entries.length === 0) {
			setHtml(this.contentElem, html`<div class="reflogEmpty">${strings.reflogEmpty}</div>`);
			return;
		}

		// The previous render's rows and button go with their markup (F3)
		this.clearSurfaceListeners();
		setHtml(this.contentElem, html`<table class="reflogTable"><tbody>${entries.map((entry, i) => {
			const date = formatShortDate(entry.date, dateFormat);
			return html`<tr class="reflogRow" tabindex="0" data-index="${i}"><td class="reflogDotCol"><span class="reflogDot ${classifyReflogAction(entry.message)}"></span></td><td class="reflogHashCol">${entry.abbrevHash}</td><td class="reflogMessageCol">${entry.message}${entry.dangling ? html` <span ${helpTooltipAttrs(strings.reflogDangling)}>${SVG_ICONS.alert}</span>` : ''}</td><td class="reflogDateCol" title="${date.title}">${date.formatted}</td></tr>`;
		})}</tbody></table>${moreAvailable ? html`<div id="reflogLoadMoreBtn" class="roundedBtn" role="button" tabindex="0">${strings.reflogLoadMore}</div>` : ''}`);

		const rows = this.contentElem.querySelectorAll('.reflogRow');
		for (let i = 0; i < rows.length; i++) {
			const row = <HTMLElement>rows[i];
			const entry = entries[i];
			this.makeSurfaceKeyboardActivatable(row);
			this.listenOnSurface(row, 'click', (e) => this.showRowActions(entry, row, <MouseEvent>e));
		}

		if (moreAvailable) {
			const loadMoreBtn = this.byId('reflogLoadMoreBtn')!;
			this.makeSurfaceKeyboardActivatable(loadMoreBtn);
			this.listenOnSurface(loadMoreBtn, 'click', () => {
				this.limit += REFLOG_PAGE_SIZE;
				this.load();
			});
		}
	}

	private showRowActions(entry: GG.GitReflogEntry, row: HTMLElement, e: MouseEvent) {
		const ctx = this.ctx(), store = ctx.store, hash = entry.hash, selector = entry.selector;
		const actions: ContextMenuActions = [[
			{
				title: strings.menuCheckout + ELLIPSIS,
				visible: true,
				onClick: () => {
					const checkoutCommit = () => ctx.actions.run({ command: 'checkoutCommit', repo: store.currentRepo, commitHash: hash }, strings.checkingOutCommit);
					if (store.globalViewState.alwaysAcceptCheckoutCommit) {
						checkoutCommit();
					} else {
						ctx.dialog.showCheckbox(formatStr(markup.checkoutCommitConfirm, abbrevCommit(hash)), strings.alwaysAcceptCheckbox, false, strings.yesCheckout, (alwaysAccept) => {
							if (alwaysAccept) ctx.persistence.updateGlobalViewState('alwaysAcceptCheckoutCommit', true);
							checkoutCommit();
						}, null);
					}
				}
			}, {
				title: strings.reflogMenuReset + ELLIPSIS,
				visible: true,
				onClick: () => {
					ctx.dialog.showSelect(formatStr(markup.resetToCommitConfirm, currentBranchHtml(store.gitBranchHead), abbrevCommit(hash)), store.config.dialogDefaults.resetCommit.mode, [
						{ name: strings.resetModeSoft, value: GG.GitResetMode.Soft },
						{ name: strings.resetModeMixed, value: GG.GitResetMode.Mixed },
						{ name: strings.resetModeHard, value: GG.GitResetMode.Hard }
					], strings.yesReset, (mode) => {
						ctx.actions.run({ command: 'resetToCommit', repo: store.currentRepo, commit: hash, resetMode: <GG.GitResetMode>mode }, strings.resettingToCommit);
					}, null);
				}
			}
		], [
			{
				title: strings.menuCopyCommitHash,
				visible: true,
				onClick: () => ctx.bridge.send({ command: 'copyToClipboard', type: 'Commit Hash', data: hash })
			}, {
				title: strings.reflogMenuCopySelector,
				visible: true,
				onClick: () => ctx.bridge.send({ command: 'copyToClipboard', type: 'Reflog Selector', data: selector })
			}
		]];
		ctx.contextMenu.show(actions, false, null, e, this.widgetElem);
		row.focus();
	}
}

/**
 * Implements the Git Graph View's Reflog Widget: an overlay (matching the SettingsWidget /
 * FindWidget pattern) that browses the reflog of `HEAD`, colour-codes entries by a client-side
 * classification of the reflog message (no extra Git call), and flags dangling (unreachable)
 * commits. Per-row actions (checkout, reset, copy) are hand-built here rather than reusing
 * `getCommitContextMenuActions`, because that function looks the commit up in the currently
 * loaded/filtered commit graph (`view.commitLookup`) - which a reflog entry, especially a
 * dangling one, is frequently NOT part of.
 */

const REFLOG_PAGE_SIZE = 200;

/**
 * Classify a reflog message into a colour group, purely by string matching (no extra Git call) -
 * mirroring the "semantic colour grouping" idea, simplified to the leading action verb and any
 * `(sub-action)` in parentheses.
 */
function classifyReflogAction(message: string): string {
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

class ReflogView {
	private readonly view: GitGraphView;
	private readonly widgetElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private isOpen: boolean = false;
	private ref: string = 'HEAD';
	private limit: number = REFLOG_PAGE_SIZE;

	constructor(view: GitGraphView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'reflogWidget';
		this.widgetElem.innerHTML = '<h2>' + escapeHtml(strings.reflogTitle) + '</h2><div id="reflogContent"></div><div id="reflogClose"></div>';
		document.body.appendChild(this.widgetElem);

		this.contentElem = document.getElementById('reflogContent')!;

		const closeBtn = document.getElementById('reflogClose')!;
		closeBtn.innerHTML = SVG_ICONS.close;
		makeKeyboardActivatable(closeBtn);
		closeBtn.addEventListener('click', () => this.close());
	}

	public isActive() {
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
	}

	/** Re-request the currently shown page, e.g. after a refresh-triggering action. */
	public refresh() {
		if (this.isOpen) this.load();
	}

	private load() {
		this.contentElem.innerHTML = '<div class="reflogLoading">' + SVG_ICONS.loading + '</div>';
		sendMessage({ command: 'reflog', repo: this.view.currentRepo, ref: this.ref, limit: this.limit });
	}

	public processResponse(msg: GG.ResponseReflog) {
		if (!this.isOpen || msg.ref !== this.ref) return;
		if (msg.error !== null) {
			this.contentElem.innerHTML = '<div class="reflogError">' + escapeHtml(msg.error) + '</div>';
			return;
		}
		this.render(msg.entries, msg.moreAvailable);
	}

	private render(entries: ReadonlyArray<GG.GitReflogEntry>, moreAvailable: boolean) {
		if (entries.length === 0) {
			this.contentElem.innerHTML = '<div class="reflogEmpty">' + escapeHtml(strings.reflogEmpty) + '</div>';
			return;
		}

		let html = '<table class="reflogTable"><tbody>';
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const colourClass = classifyReflogAction(entry.message);
			html += '<tr class="reflogRow" tabindex="0" data-index="' + i + '">'
				+ '<td class="reflogDotCol"><span class="reflogDot ' + colourClass + '"></span></td>'
				+ '<td class="reflogHashCol">' + entry.abbrevHash + '</td>'
				+ '<td class="reflogMessageCol">' + escapeHtml(entry.message)
				+ (entry.dangling ? ' <span ' + helpTooltipAttrs(strings.reflogDangling) + '>' + SVG_ICONS.alert + '</span>' : '')
				+ '</td>'
				+ '<td class="reflogDateCol" title="' + escapeHtml(formatShortDate(entry.date).title) + '">' + escapeHtml(formatShortDate(entry.date).formatted) + '</td>'
				+ '</tr>';
		}
		html += '</tbody></table>';
		if (moreAvailable) {
			html += '<div id="reflogLoadMoreBtn" class="roundedBtn" role="button" tabindex="0">' + escapeHtml(strings.reflogLoadMore) + '</div>';
		}
		this.contentElem.innerHTML = html;

		const rows = this.contentElem.querySelectorAll('.reflogRow');
		for (let i = 0; i < rows.length; i++) {
			const row = <HTMLElement>rows[i];
			const entry = entries[i];
			makeKeyboardActivatable(row);
			row.addEventListener('click', (e) => this.showRowActions(entry, row, <MouseEvent>e));
		}

		if (moreAvailable) {
			const loadMoreBtn = document.getElementById('reflogLoadMoreBtn')!;
			makeKeyboardActivatable(loadMoreBtn);
			loadMoreBtn.addEventListener('click', () => {
				this.limit += REFLOG_PAGE_SIZE;
				this.load();
			});
		}
	}

	private showRowActions(entry: GG.GitReflogEntry, row: HTMLElement, e: MouseEvent) {
		const hash = entry.hash, selector = entry.selector, view = this.view;
		const actions: ContextMenuActions = [[
			{
				title: strings.menuCheckout + ELLIPSIS,
				visible: true,
				onClick: () => {
					const checkoutCommit = () => runAction({ command: 'checkoutCommit', repo: view.currentRepo, commitHash: hash }, strings.checkingOutCommit);
					if (globalState.alwaysAcceptCheckoutCommit) {
						checkoutCommit();
					} else {
						dialog.showCheckbox(formatStr(strings.checkoutCommitConfirm, abbrevCommit(hash)), strings.alwaysAcceptCheckbox, false, strings.yesCheckout, (alwaysAccept) => {
							if (alwaysAccept) updateGlobalViewState('alwaysAcceptCheckoutCommit', true);
							checkoutCommit();
						}, null);
					}
				}
			}, {
				title: strings.reflogMenuReset + ELLIPSIS,
				visible: true,
				onClick: () => {
					dialog.showSelect(formatStr(strings.resetToCommitConfirm, view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b>' + strings.currentBranchSuffix : strings.currentBranchPlain, abbrevCommit(hash)), view.config.dialogDefaults.resetCommit.mode, [
						{ name: strings.resetModeSoft, value: GG.GitResetMode.Soft },
						{ name: strings.resetModeMixed, value: GG.GitResetMode.Mixed },
						{ name: strings.resetModeHard, value: GG.GitResetMode.Hard }
					], strings.yesReset, (mode) => {
						runAction({ command: 'resetToCommit', repo: view.currentRepo, commit: hash, resetMode: <GG.GitResetMode>mode }, strings.resettingToCommit);
					}, null);
				}
			}
		], [
			{
				title: strings.menuCopyCommitHash,
				visible: true,
				onClick: () => sendMessage({ command: 'copyToClipboard', type: 'Commit Hash', data: hash })
			}, {
				title: strings.reflogMenuCopySelector,
				visible: true,
				onClick: () => sendMessage({ command: 'copyToClipboard', type: 'Reflog Selector', data: selector })
			}
		]];
		contextMenu.show(actions, false, null, e, this.widgetElem);
		row.focus();
	}
}

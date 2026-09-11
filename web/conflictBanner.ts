/**
 * Implements the Git Graph View's Conflict Banner: shown whenever a merge, rebase, cherry-pick
 * or revert is left in progress in the repository (most commonly because it hit a conflict),
 * offering Continue / Abort actions and listing the files still needing resolution.
 *
 * The banner's visibility is driven entirely by `GG.GitOperationState`, which rides along every
 * `loadRepoInfo` response (see `GitGraphView.processLoadRepoInfoResponse`), so it reflects the
 * repository's real state on every view load, periodic refresh, and after every action.
 */
class ConflictBanner {
	private readonly view: GitGraphView;
	private readonly elem: HTMLElement;
	private type: GG.GitOperationType | null = null;

	constructor(view: GitGraphView) {
		this.view = view;
		this.elem = document.getElementById('conflictBanner')!;
	}

	/**
	 * Update the banner to reflect the repository's current Git operation state.
	 * @param state The operation state from the last `loadRepoInfo` response.
	 */
	public update(state: GG.GitOperationState) {
		// A response from an older/mismatched build (or a test double) may omit this field entirely.
		this.type = state ? state.type : null;

		if (state === undefined || state === null || state.type === null) {
			this.elem.style.display = 'none';
			this.elem.innerHTML = '';
			return;
		}

		const title = this.titleFor(state.type) + (state.progress !== null
			? ' (' + formatStr(strings.conflictBannerRebaseProgress, state.progress.step.toString(), state.progress.total.toString()) + ')'
			: '');

		let html = '<span class="conflictBannerIcon">' + SVG_ICONS.alert + '</span>';
		html += '<span class="conflictBannerTitle">' + escapeHtml(title) + '</span>';
		if (state.conflictedFiles.length > 0) {
			html += '<span class="conflictBannerFiles"><b>' + escapeHtml(strings.conflictBannerFilesLabel) + '</b> ' + state.conflictedFiles.map((file) => escapeHtml(file)).join(', ') + '</span>';
		}
		html += '<div id="conflictBannerContinueBtn" class="roundedBtn" role="button" tabindex="0">' + escapeHtml(strings.conflictBannerContinue) + '</div>';
		html += '<div id="conflictBannerAbortBtn" class="roundedBtn" role="button" tabindex="0">' + escapeHtml(strings.conflictBannerAbort) + '</div>';
		this.elem.innerHTML = html;
		this.elem.style.display = 'flex';

		const continueBtn = document.getElementById('conflictBannerContinueBtn')!;
		const abortBtn = document.getElementById('conflictBannerAbortBtn')!;
		makeKeyboardActivatable(continueBtn);
		makeKeyboardActivatable(abortBtn);
		continueBtn.addEventListener('click', () => this.continueOperation());
		abortBtn.addEventListener('click', () => this.abortOperation());
	}

	private continueOperation() {
		if (this.type === null) return;
		runAction({ command: 'continueOperation', repo: this.view.currentRepo, type: this.type }, strings.conflictBannerContinue);
	}

	private abortOperation() {
		if (this.type === null) return;
		const type = this.type;
		dialog.showConfirmation(formatStr(strings.conflictBannerAbortConfirm, this.titleFor(type)), strings.conflictBannerAbort, () => {
			runAction({ command: 'abortOperation', repo: this.view.currentRepo, type: type }, strings.conflictBannerAbort);
		}, null);
	}

	private titleFor(type: GG.GitOperationType) {
		switch (type) {
			case GG.GitOperationType.Merge: return strings.conflictBannerTitleMerge;
			case GG.GitOperationType.Rebase: return strings.conflictBannerTitleRebase;
			case GG.GitOperationType.CherryPick: return strings.conflictBannerTitleCherryPick;
			default: return strings.conflictBannerTitleRevert;
		}
	}
}

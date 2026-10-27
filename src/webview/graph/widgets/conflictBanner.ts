/**
 * The Conflict Banner: shown whenever a merge, rebase, cherry-pick or revert is left in progress
 * in the repository (most commonly because it hit a conflict), offering Continue / Abort actions
 * and listing the files still needing resolution.
 *
 * The banner's visibility is driven entirely by `GG.GitOperationState`, which rides along every
 * `loadRepoInfo` response, so it reflects the repository's real state on every view load,
 * periodic refresh, and after every action.
 */

import { html, joinHtml, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { Component } from '../component';
import { GraphContext } from '../context';

/**
 * The Conflict Banner's component (F3): the banner owns its element subtree, and the buttons'
 * listeners of one update live on the surface store, replaced with the next update.
 */
export class ConflictBanner extends Component {
	private type: GG.GitOperationType | null = null;

	private readonly elem: HTMLElement;

	constructor(private readonly ctx: () => GraphContext, elem: HTMLElement) {
		super(elem);
		this.elem = elem;
	}

	/**
	 * Update the banner to reflect the repository's current Git operation state.
	 * @param state The operation state from the last `loadRepoInfo` response.
	 */
	public update(state: GG.GitOperationState) {
		// A response from an older/mismatched build (or a test double) may omit any of these
		// fields entirely — default them before reading, the same version-skew case the guard
		// below already anticipates for `state` itself.
		const type = state != null && state.type != null ? state.type : null;
		const progress = state != null && state.progress != null ? state.progress : null;
		const conflictedFiles = state != null && state.conflictedFiles != null ? state.conflictedFiles : [];
		this.type = type;

		if (type === null) {
			this.elem.style.display = 'none';
			setHtml(this.elem, html``);
			return;
		}

		const title = this.titleFor(type) + (progress !== null
			? ' (' + formatStr(strings.conflictBannerRebaseProgress, progress.step.toString(), progress.total.toString()) + ')'
			: '');

		// The previous update's buttons go with their markup (F3)
		this.clearSurfaceListeners();
		setHtml(this.elem, html`<span class="conflictBannerIcon">${SVG_ICONS.alert}</span><span class="conflictBannerTitle">${title}</span>${conflictedFiles.length > 0 ? html`<span class="conflictBannerFiles"><b>${strings.conflictBannerFilesLabel}</b> ${joinHtml(conflictedFiles, ', ')}</span>` : ''}<div id="conflictBannerContinueBtn" class="roundedBtn" role="button" tabindex="0">${strings.conflictBannerContinue}</div><div id="conflictBannerAbortBtn" class="roundedBtn" role="button" tabindex="0">${strings.conflictBannerAbort}</div>`);
		this.elem.style.display = 'flex';

		const continueBtn = this.byId('conflictBannerContinueBtn')!;
		const abortBtn = this.byId('conflictBannerAbortBtn')!;
		this.makeSurfaceKeyboardActivatable(continueBtn);
		this.makeSurfaceKeyboardActivatable(abortBtn);
		this.listenOnSurface(continueBtn, 'click', () => this.continueOperation());
		this.listenOnSurface(abortBtn, 'click', () => this.abortOperation());
	}

	private continueOperation() {
		if (this.type === null) return;
		const ctx = this.ctx();
		ctx.actions.run({ command: 'continueOperation', repo: ctx.store.currentRepo, type: this.type }, strings.conflictBannerContinue);
	}

	private abortOperation() {
		if (this.type === null) return;
		const ctx = this.ctx(), type = this.type;
		ctx.dialog.showConfirmation(formatStr(strings.conflictBannerAbortConfirm, this.titleFor(type)), strings.conflictBannerAbort, () => {
			ctx.actions.run({ command: 'abortOperation', repo: ctx.store.currentRepo, type: type }, strings.conflictBannerAbort);
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

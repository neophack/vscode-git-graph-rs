/* The Commit Details View's review pane: the toolbar's review actions - the code review of the
   open commit's files (its state, its button, the per-file reviewed bookkeeping) and opening the
   changes in the configured external diff tool. */

import { alterClass, CLASS_ACTIVE, CLASS_ENABLED, insertBeforeFirstChildWithClass } from '../../common/dom';
import { setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { SVG_ICONS } from '../../common/icons';
import { GraphContext } from '../context';
import { alterFileTreeFileReviewed, getFilesInTree, setFileTreeReviewed, updateFileTreeHtml, updateFileTreeHtmlFileReviewed } from './fileTree';
import { PanelSurface } from './panelSurface';

/** The element with the given id under the panel's scope, or NULL (the shell's scoped lookup). */
function byId(scope: ParentNode, id: string): HTMLElement | null {
	return scope.querySelector<HTMLElement>('#' + id);
}

/**
 * Update the state of a file in the Commit Details View.
 * @param file The file that was affected.
 * @param fileElem The element of the file.
 * @param isReviewed TRUE/FALSE => set the file's reviewed state accordingly, NULL => don't update it.
 * @param fileWasViewed Was the file viewed - if so, set it to be the last viewed file.
 */
export function updateFileState(ctx: GraphContext, getScope: () => ParentNode, file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean) {
	const store = ctx.store, expandedCommit = store.expandedCommit, filesElem = byId(getScope(), 'cdvFiles'), filePath = file.newFilePath;
	if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

	if (fileWasViewed) {
		store.slices.details.setLastViewedFile(filePath);
		let lastViewedElem = byId(getScope(), 'cdvLastFileViewed');
		if (lastViewedElem !== null) lastViewedElem.remove();
		lastViewedElem = document.createElement('span');
		lastViewedElem.id = 'cdvLastFileViewed';
		lastViewedElem.className = 'gg-helpTooltip';
		lastViewedElem.dataset.tooltip = strings.lastFileViewedTitle;
		lastViewedElem.setAttribute('aria-label', strings.lastFileViewedTitle);
		lastViewedElem.tabIndex = 0;
		setHtml(lastViewedElem, SVG_ICONS.eyeOpen);
		insertBeforeFirstChildWithClass(lastViewedElem, fileElem, 'fileTreeFileAction');
	}

	if (expandedCommit.codeReview !== null) {
		if (isReviewed !== null) {
			if (isReviewed) {
				expandedCommit.codeReview.remainingFiles = expandedCommit.codeReview.remainingFiles.filter((path: string) => path !== filePath);
			} else {
				expandedCommit.codeReview.remainingFiles.push(filePath);
			}

			alterFileTreeFileReviewed(expandedCommit.fileTree, filePath, isReviewed);
			updateFileTreeHtmlFileReviewed(filesElem, expandedCommit.fileTree, filePath);
		}

		ctx.bridge.send({
			command: 'updateCodeReview',
			repo: store.currentRepo,
			id: expandedCommit.codeReview.id,
			remainingFiles: expandedCommit.codeReview.remainingFiles,
			lastViewedFile: expandedCommit.lastViewedFile
		});

		if (expandedCommit.codeReview.remainingFiles.length === 0) {
			store.slices.details.setCodeReview(null);
			renderCodeReviewBtn(ctx, getScope);
		}
	}

	ctx.persistence.saveState();
}

/** A code review was started (a `startCodeReview` response). */
export function startCodeReview(ctx: GraphContext, getScope: () => ParentNode, commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview) {
	const expandedCommit = ctx.store.expandedCommit;
	if (expandedCommit === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash) return;
	saveAndRenderCodeReview(ctx, getScope, codeReview);
}

function endCodeReview(ctx: GraphContext, getScope: () => ParentNode) {
	const expandedCommit = ctx.store.expandedCommit;
	if (expandedCommit === null || expandedCommit.codeReview === null) return;
	saveAndRenderCodeReview(ctx, getScope, null);
}

function saveAndRenderCodeReview(ctx: GraphContext, getScope: () => ParentNode, codeReview: GG.CodeReview | null) {
	const store = ctx.store, expandedCommit = store.expandedCommit, filesElem = byId(getScope(), 'cdvFiles');
	if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

	store.slices.details.setCodeReview(codeReview);
	setFileTreeReviewed(expandedCommit.fileTree, codeReview === null);
	ctx.persistence.saveState();
	renderCodeReviewBtn(ctx, getScope);
	updateFileTreeHtml(filesElem, expandedCommit.fileTree);
}

function renderCodeReviewBtn(ctx: GraphContext, getScope: () => ParentNode) {
	const expandedCommit = ctx.store.expandedCommit;
	if (expandedCommit === null) return;
	const btnElem = byId(getScope(), 'cdvCodeReview');
	if (btnElem === null) return;

	const active = expandedCommit.codeReview !== null;
	alterClass(btnElem, CLASS_ACTIVE, active);
	btnElem.title = active ? strings.endCodeReviewTitle : strings.startCodeReviewTitle;
	btnElem.setAttribute('aria-label', btnElem.title);
}

/** Wire the code review button: reflect the open review on it, and start or end the review on click (the listener lives on the current render's surface store, F3). */
export function wireCodeReviewBtn(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode) {
	renderCodeReviewBtn(ctx, getScope);
	const store = ctx.store;
	surface.listen(byId(getScope(), 'cdvCodeReview')!, 'click', (e) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || e.target === null) return;
		const sourceElem = <HTMLElement>(<Element>e.target).closest('#cdvCodeReview')!;
		if (sourceElem.classList.contains(CLASS_ACTIVE)) {
			ctx.bridge.send({ command: 'endCodeReview', repo: store.currentRepo, id: expandedCommit.codeReview!.id });
			endCodeReview(ctx, getScope);
		} else {
			const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
			const id = expandedCommit.compareWithHash !== null ? commitOrder.from + '-' + commitOrder.to : expandedCommit.commitHash;
			ctx.bridge.send({
				command: 'startCodeReview',
				repo: store.currentRepo,
				id: id,
				commitHash: expandedCommit.commitHash,
				compareWithHash: expandedCommit.compareWithHash,
				files: getFilesInTree(expandedCommit.fileTree!, expandedCommit.fileChanges!),
				lastViewedFile: expandedCommit.lastViewedFile
			});
		}
	});
}

/** Reflect the configured external diff tool on the external diff button. */
export function renderExternalDiffBtn(ctx: GraphContext, getScope: () => ParentNode) {
	const store = ctx.store;
	if (store.expandedCommit === null) return;
	const externalDiffBtnElem = byId(getScope(), 'cdvExternalDiff');
	if (externalDiffBtnElem === null) return;

	alterClass(externalDiffBtnElem, CLASS_ENABLED, store.gitConfig !== null && (store.gitConfig.diffTool !== null || store.gitConfig.guiDiffTool !== null));
	const toolName = store.gitConfig !== null
		? store.gitConfig.guiDiffTool !== null
			? store.gitConfig.guiDiffTool
			: store.gitConfig.diffTool
		: null;
	externalDiffBtnElem.title = strings.externalDiffTitle + (toolName !== null ? formatStr(strings.externalDiffWithTool, toolName) : '');
	externalDiffBtnElem.setAttribute('aria-label', externalDiffBtnElem.title);
}

/** Wire the external diff button: open the changes in the configured external diff tool (the listener lives on the current render's surface store, F3). */
export function wireExternalDiffBtn(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode) {
	const store = ctx.store;
	surface.listen(byId(getScope(), 'cdvExternalDiff')!, 'click', () => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || store.gitConfig === null || (store.gitConfig.diffTool === null && store.gitConfig.guiDiffTool === null)) return;
		const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		ctx.actions.run({
			command: 'openExternalDirDiff',
			repo: store.currentRepo,
			fromHash: commitOrder.from,
			toHash: commitOrder.to,
			isGui: store.gitConfig.guiDiffTool !== null
		}, strings.openingExternalDirDiff);
	});
}

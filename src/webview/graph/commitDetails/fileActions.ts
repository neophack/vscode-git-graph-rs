/* The interactions of the Commit Details View's file list: opening folders, viewing diffs, copying
   paths, opening files, resetting a file, marking files reviewed - and the file context menu. */

import { addListenerToClass, handledEvent } from '../../common/dom';
import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { abbrevCommit, UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { ContextMenuTarget, ExpandedCommit, TargetType } from '../state/types';
import { alterFileTreeFolderOpen, fileIsBinary } from './fileTree';

/**
 * Wire the rendered file list (after each render of the file view): folder toggles, repository
 * links, the file row and its action buttons, and the file context menu.
 */
export function makeFileViewInteractive(ctx: GraphContext) {
	const store = ctx.store, details = ctx.details;
	const getFileElemOfEventTarget = (target: EventTarget) => <HTMLElement>(<Element>target).closest('.fileTreeFileRecord');
	const getFileOfFileElem = (fileChanges: ReadonlyArray<GG.GitFileChange>, fileElem: HTMLElement) => fileChanges[parseInt(fileElem.dataset.index!)];
	// Whether this file's line counts have not settled yet — a still-loading file must be treated
	// as (optimistically) text, exactly like the file tree's own row rendering does, so a click
	// racing the background batch never mistakes "not known yet" for "known to be binary".
	const isFileCountsPending = (file: GG.GitFileChange, expandedCommit: ExpandedCommit) => expandedCommit.lineCounts.pending !== null && expandedCommit.lineCounts.pending.has(file.newFilePath);

	const getCommitHashForFile = (file: GG.GitFileChange, expandedCommit: ExpandedCommit) => {
		const commit = store.getCommit(expandedCommit.commitHash)!;
		if (expandedCommit.compareWithHash !== null) {
			return store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash).to;
		} else if (commit.stash !== null && file.type === GG.GitFileStatus.Untracked) {
			return commit.stash.untrackedFilesHash!;
		} else {
			return expandedCommit.commitHash;
		}
	};

	// A stash's untracked file is diffed as though it were freshly Added against the stash's
	// synthetic untracked-files commit (see triggerViewFileDiff below), rather than taking
	// viewDiff's "just open the file" shortcut for Untracked - so binary detection must key off
	// that effective status, not the file's own Untracked type, or a binary untracked file in a
	// stash slips past fileIsBinary's Untracked exclusion and opens a garbled native diff.
	const effectiveDiffFileType = (expandedCommit: ExpandedCommit, file: GG.GitFileChange): GG.GitFileStatus => {
		if (file.type !== GG.GitFileStatus.Untracked || expandedCommit.compareWithHash !== null) return file.type;
		const commit = store.getCommit(expandedCommit.commitHash);
		return commit !== undefined && commit.stash !== null ? GG.GitFileStatus.Added : file.type;
	};
	const triggerViewFileDiff = (file: GG.GitFileChange, fileElem: HTMLElement) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return;

		const commit = store.getCommit(expandedCommit.commitHash);
		let fromHash: string, toHash: string, fileStatus = file.type;
		// A stash's untracked files are diffed against the stash's untracked-files tree, which
		// no line counts are ever requested for (Untracked files never carry counts): the
		// counts-based binary heuristic below can never decide them, so it must not be asked.
		let isStashUntracked = false;
		if (expandedCommit.compareWithHash !== null) {
			// Commit Comparison
			const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash);
			fromHash = commitOrder.from;
			toHash = commitOrder.to;
		} else if (commit !== undefined && commit.stash !== null) {
			// Stash Commit
			if (fileStatus === GG.GitFileStatus.Untracked) {
				fromHash = commit.stash.untrackedFilesHash!;
				toHash = commit.stash.untrackedFilesHash!;
				fileStatus = GG.GitFileStatus.Added;
				isStashUntracked = true;
			} else {
				fromHash = commit.stash.baseHash;
				toHash = expandedCommit.commitHash;
			}
		} else {
			// Single Commit
			fromHash = expandedCommit.commitHash;
			toHash = expandedCommit.commitHash;
		}

		details.updateFileState(file, fileElem, true, true);
		// A binary/image file has no textual diff for the native Diff View: it opens the
		// standalone Binary Compare tab instead (the same one the Commit Comparison View uses).
		// Checked against `fileStatus` (not `file.type`): a stash's untracked file is remapped to
		// Added above and no longer takes viewDiff's "just open the file" shortcut for Untracked.
		// A stash's untracked file skips the heuristic entirely — its counts never settle, so
		// "counts are null" would misroute every one of them (text files included) into the hex
		// comparison, which cannot show a text diff.
		if (!isStashUntracked && fileIsBinary(file, fileStatus, isFileCountsPending(file, expandedCommit), toHash === UNCOMMITTED)) {
			ctx.bridge.send({ command: 'viewDiffBinary', repo: store.currentRepo, fromHash: fromHash, toHash: toHash, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath, type: fileStatus });
		} else {
			ctx.bridge.send({ command: 'viewDiff', repo: store.currentRepo, fromHash: fromHash, toHash: toHash, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath, type: fileStatus });
		}
	};

	const triggerCopyFilePath = (file: GG.GitFileChange, absolute: boolean) => {
		ctx.bridge.send({ command: 'copyFilePath', repo: store.currentRepo, filePath: file.newFilePath, absolute: absolute });
	};

	const triggerResetFileToRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return;

		const commitHash = getCommitHashForFile(file, expandedCommit);
		ctx.dialog.showConfirmation(formatStr(markup.resetFileConfirm, file.newFilePath, abbrevCommit(commitHash)), strings.yesResetFile, () => {
			ctx.actions.run({ command: 'resetFileToRevision', repo: store.currentRepo, commitHash: commitHash, filePath: file.newFilePath }, strings.resettingFile);
		}, {
			type: TargetType.CommitDetailsView,
			hash: commitHash,
			elem: fileElem
		});
	};

	const triggerViewFileAtRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return;

		details.updateFileState(file, fileElem, true, true);
		ctx.bridge.send({ command: 'viewFileAtRevision', repo: store.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
	};

	const triggerViewFileDiffWithWorkingFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return;

		details.updateFileState(file, fileElem, null, true);
		ctx.bridge.send({ command: 'viewDiffWithWorkingFile', repo: store.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
	};

	const triggerOpenFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return;

		details.updateFileState(file, fileElem, true, true);
		ctx.bridge.send({ command: 'openFile', repo: store.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
	};

	addListenerToClass(document, 'fileTreeFolder', 'click', (e) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileTree === null || e.target === null) return;

		const sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFolder');
		details.toggleFolder(sourceElem);
		const isOpen = !sourceElem.parentElement!.classList.contains('closed');
		alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath!), isOpen);
		ctx.persistence.saveState();
		details.lineCounts.scheduleVisible();
	});

	addListenerToClass(document, 'fileTreeRepo', 'click', (e) => {
		if (e.target === null) return;
		ctx.loader.loadRepos(store.repos, null, {
			repo: decodeURIComponent((<HTMLElement>(<Element>e.target).closest('.fileTreeRepo')).dataset.path!)
		});
	});

	addListenerToClass(document, 'fileTreeFile', 'click', (e) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

		const sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFile'), fileElem = getFileElemOfEventTarget(e.target);
		if (!sourceElem.classList.contains('gitDiffPossible')) return;
		triggerViewFileDiff(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
	});

	addListenerToClass(document, 'copyGitFile', 'click', (e) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

		const fileElem = getFileElemOfEventTarget(e.target);
		triggerCopyFilePath(getFileOfFileElem(expandedCommit.fileChanges, fileElem), true);
	});

	addListenerToClass(document, 'viewGitFileAtRevision', 'click', (e) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

		const fileElem = getFileElemOfEventTarget(e.target);
		triggerViewFileAtRevision(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
	});

	addListenerToClass(document, 'openGitFile', 'click', (e) => {
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

		const fileElem = getFileElemOfEventTarget(e.target);
		triggerOpenFile(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
	});

	addListenerToClass(document, 'fileTreeFileRecord', 'contextmenu', (e: Event) => {
		handledEvent(e);
		const expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;
		const fileElem = getFileElemOfEventTarget(e.target);
		const file = getFileOfFileElem(expandedCommit.fileChanges, fileElem);
		const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		const isUncommitted = commitOrder.to === UNCOMMITTED;

		details.closeContextMenuIfOpen(expandedCommit);
		expandedCommit.contextMenuOpen.fileView = parseInt(fileElem.dataset.index!);

		const target: ContextMenuTarget = {
			type: TargetType.CommitDetailsView,
			hash: expandedCommit.commitHash,
			index: store.commitLookup[expandedCommit.commitHash],
			elem: fileElem
		};
		// "View Diff" now covers every file (as a text or a binary/image comparison); the other
		// two actions below still only understand text, so they stay hidden for a binary file.
		const isBinary = fileIsBinary(file, effectiveDiffFileType(expandedCommit, file), isFileCountsPending(file, expandedCommit), isUncommitted);
		const fileExistsAtThisRevision = file.type !== GG.GitFileStatus.Deleted && !isUncommitted;
		const fileExistsAtThisRevisionAndDiffPossible = fileExistsAtThisRevision && !isBinary;
		const codeReviewInProgressAndNotReviewed = expandedCommit.codeReview !== null && expandedCommit.codeReview.remainingFiles.includes(file.newFilePath);
		const visibility = store.config.contextMenuActionsVisibility.commitDetailsViewFile;

		ctx.contextMenu.show([
			[
				{
					title: strings.cdvMenuViewDiff,
					visible: visibility.viewDiff,
					onClick: () => triggerViewFileDiff(file, fileElem)
				},
				{
					title: strings.cdvMenuViewFileAtRevision,
					visible: visibility.viewFileAtThisRevision && fileExistsAtThisRevisionAndDiffPossible,
					onClick: () => triggerViewFileAtRevision(file, fileElem)
				},
				{
					title: strings.cdvMenuViewDiffWithWorkingFile,
					visible: visibility.viewDiffWithWorkingFile && fileExistsAtThisRevisionAndDiffPossible,
					onClick: () => triggerViewFileDiffWithWorkingFile(file, fileElem)
				},
				{
					title: strings.cdvMenuOpenFile,
					visible: visibility.openFile && file.type !== GG.GitFileStatus.Deleted,
					onClick: () => triggerOpenFile(file, fileElem)
				}
			],
			[
				{
					title: strings.cdvMenuMarkReviewed,
					visible: visibility.markAsReviewed && codeReviewInProgressAndNotReviewed,
					onClick: () => details.updateFileState(file, fileElem, true, false)
				},
				{
					title: strings.cdvMenuMarkNotReviewed,
					visible: visibility.markAsNotReviewed && expandedCommit.codeReview !== null && !codeReviewInProgressAndNotReviewed,
					onClick: () => details.updateFileState(file, fileElem, false, false)
				}
			],
			[
				{
					title: strings.cdvMenuResetFileToRevision + ELLIPSIS,
					visible: visibility.resetFileToThisRevision && fileExistsAtThisRevision && expandedCommit.compareWithHash === null,
					onClick: () => triggerResetFileToRevision(file, fileElem)
				}
			],
			[
				{
					title: strings.cdvMenuCopyAbsolutePath,
					visible: visibility.copyAbsoluteFilePath,
					onClick: () => triggerCopyFilePath(file, true)
				},
				{
					title: strings.cdvMenuCopyRelativePath,
					visible: visibility.copyRelativeFilePath,
					onClick: () => triggerCopyFilePath(file, false)
				}
			]
		], false, target, <MouseEvent>e, ctx.layout.isCdvDocked() ? document.body : ctx.dom.view, () => {
			expandedCommit.contextMenuOpen.fileView = -1;
		});
	});
}

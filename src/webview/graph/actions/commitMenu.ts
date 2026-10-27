/* The context menu of a commit. */

import { html } from '../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { abbrevCommit, UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { IndexedCommitTarget } from '../state/types';
import { ContextMenuActions } from '../widgets/contextMenu';
import { DialogInput, DialogInputType } from '../widgets/dialog';
import { addTagAction, createBranchAction, currentBranchHtml, editCommitMessageAction, mergeAction, rebaseAction } from './dialogActions';

export function getCommitContextMenuActions(ctx: GraphContext, target: IndexedCommitTarget): ContextMenuActions {
	const store = ctx.store, hash = target.hash, visibility = store.config.contextMenuActionsVisibility.commit;
	const commit = store.getCommit(hash);
	if (commit === undefined) return []; // The commit is no longer loaded (e.g. after a refresh)

	const parentOptions = () => commit.parents.map((parentHash: string, index: number) => ({
		name: abbrevCommit(parentHash) + (store.getCommitId(parentHash) !== null ? ': ' + store.getCommit(parentHash)!.message : ''),
		value: (index + 1).toString()
	}));

	return [[
		{
			title: strings.menuAddTag + ELLIPSIS,
			visible: visibility.addTag,
			onClick: () => addTagAction(ctx, hash, '', store.config.dialogDefaults.addTag.type, '', null, target)
		}, {
			title: strings.menuCreateBranch + ELLIPSIS,
			visible: visibility.createBranch,
			onClick: () => createBranchAction(ctx, hash, '', store.config.dialogDefaults.createBranch.checkout, target)
		}
	], [
		{
			title: strings.menuCheckout + (store.globalViewState.alwaysAcceptCheckoutCommit ? '' : ELLIPSIS),
			visible: visibility.checkout,
			onClick: () => {
				const checkoutCommit = () => ctx.actions.run({ command: 'checkoutCommit', repo: store.currentRepo, commitHash: hash }, strings.checkingOutCommit);
				if (store.globalViewState.alwaysAcceptCheckoutCommit) {
					checkoutCommit();
				} else {
					ctx.dialog.showCheckbox(formatStr(markup.checkoutCommitConfirm, abbrevCommit(hash)), strings.alwaysAcceptCheckbox, false, strings.yesCheckout, (alwaysAccept) => {
						if (alwaysAccept) {
							ctx.persistence.updateGlobalViewState('alwaysAcceptCheckoutCommit', true);
						}
						checkoutCommit();
					}, target);
				}
			}
		}, {
			title: strings.menuCherryPick + ELLIPSIS,
			visible: visibility.cherrypick,
			onClick: () => {
				const isMerge = commit.parents.length > 1;
				const inputs: DialogInput[] = [];
				if (isMerge) {
					inputs.push({
						type: DialogInputType.Select,
						name: strings.parentHashInput,
						options: parentOptions(),
						default: '1',
						info: strings.parentHashCherryPickInfo
					});
				}
				inputs.push({
					type: DialogInputType.Checkbox,
					name: strings.recordOriginCheckbox,
					value: store.config.dialogDefaults.cherryPick.recordOrigin,
					info: strings.recordOriginInfo
				}, {
					type: DialogInputType.Checkbox,
					name: strings.noCommitCheckbox,
					value: store.config.dialogDefaults.cherryPick.noCommit,
					info: strings.noCommitCherryPickInfo
				});

				ctx.dialog.showForm(formatStr(markup.cherryPickConfirm, abbrevCommit(hash)), inputs, strings.yesCherryPick, (values) => {
					const parentIndex = isMerge ? parseInt(<string>values.shift()) : 0;
					ctx.actions.run({
						command: 'cherrypickCommit',
						repo: store.currentRepo,
						commitHash: hash,
						parentIndex: parentIndex,
						recordOrigin: <boolean>values[0],
						noCommit: <boolean>values[1]
					}, strings.cherryPickingCommit);
				}, target);
			}
		}, {
			title: strings.menuCreateFixupCommit,
			visible: visibility.fixup,
			onClick: () => {
				ctx.dialog.showConfirmation(formatStr(strings.fixupConfirm, abbrevCommit(hash)), strings.yesFixup, () => {
					ctx.actions.run({ command: 'commitFixup', repo: store.currentRepo, commitHash: hash }, strings.creatingFixupCommit);
				}, target);
			}
		}, {
			title: strings.menuCreateSquashCommit,
			visible: visibility.squash,
			onClick: () => {
				ctx.dialog.showConfirmation(formatStr(strings.squashConfirm, abbrevCommit(hash)), strings.yesSquash, () => {
					ctx.actions.run({ command: 'commitSquash', repo: store.currentRepo, commitHash: hash }, strings.creatingSquashCommit);
				}, target);
			}
		}, {
			title: strings.menuRevert + ELLIPSIS,
			visible: visibility.revert,
			onClick: () => {
				if (commit.parents.length > 1) {
					ctx.dialog.showSelect(formatStr(markup.revertMergeCommitConfirm, abbrevCommit(hash)), '1', parentOptions(), strings.yesRevert, (parentIndex) => {
						ctx.actions.run({ command: 'revertCommit', repo: store.currentRepo, commitHash: hash, parentIndex: parseInt(parentIndex) }, strings.revertingCommit);
					}, target);
				} else {
					ctx.dialog.showConfirmation(formatStr(markup.revertCommitConfirm, abbrevCommit(hash)), strings.yesRevert, () => {
						ctx.actions.run({ command: 'revertCommit', repo: store.currentRepo, commitHash: hash, parentIndex: 0 }, strings.revertingCommit);
					}, target);
				}
			}
		}, {
			title: strings.menuResetLastCommitSoft + ELLIPSIS,
			visible: visibility.undo && hash === store.commitHead,
			onClick: () => {
				ctx.dialog.showConfirmation(strings.resetLastCommitConfirm, strings.yesResetLastCommit, () => {
					ctx.actions.run({ command: 'undoLastCommit', repo: store.currentRepo }, strings.resettingLastCommit);
				}, target);
			}
		}, {
			title: strings.menuEditMessage + ELLIPSIS,
			// One entry for every amendable commit: the host serves HEAD with a plain
			// git commit --amend and any earlier commit through an automated rebase reword;
			// merge commits can't be reworded, and commits already published to a remote
			// (or whose state is unknown) get no button at all - the host re-validates the
			// local-only requirement (git branch -r --contains) before rewriting anything,
			// so a stale graph cannot cause a published commit to be rewritten
			visible: visibility.editMessage && commit.parents.length < 2 && !ctx.graph.commitOnRemote(store.getCommitId(hash) !== null ? <number>store.getCommitId(hash) : Number.NaN),
			onClick: () => editCommitMessageAction(ctx, target)
		}, {
			title: strings.menuDrop + ELLIPSIS,
			visible: visibility.drop && ctx.graph.dropCommitPossible(store.getCommitId(hash) !== null ? <number>store.getCommitId(hash) : Number.NaN),
			onClick: () => {
				ctx.dialog.showConfirmation(html`${formatStr(markup.dropCommitConfirm, abbrevCommit(hash))}${store.onlyFollowFirstParent ? markup.dropCommitFirstParentNote : ''}`, strings.yesDrop, () => {
					ctx.actions.run({ command: 'dropCommit', repo: store.currentRepo, commitHash: hash }, strings.droppingCommit);
				}, target);
			}
		}
	], [
		{
			title: strings.menuMergeIntoCurrentBranch + ELLIPSIS,
			visible: visibility.merge,
			onClick: () => mergeAction(ctx, hash, abbrevCommit(hash), GG.MergeActionOn.Commit, target)
		}, {
			title: strings.menuRebaseOnCommit + ELLIPSIS,
			visible: visibility.rebase,
			onClick: () => rebaseAction(ctx, hash, abbrevCommit(hash), GG.RebaseActionOn.Commit, target)
		}, {
			title: strings.menuResetToCommit + ELLIPSIS,
			visible: visibility.reset,
			onClick: () => {
				ctx.dialog.showSelect(formatStr(markup.resetToCommitConfirm, currentBranchHtml(store.gitBranchHead), abbrevCommit(hash)), store.config.dialogDefaults.resetCommit.mode, [
					{ name: strings.resetModeSoft, value: GG.GitResetMode.Soft },
					{ name: strings.resetModeMixed, value: GG.GitResetMode.Mixed },
					{ name: strings.resetModeHard, value: GG.GitResetMode.Hard }
				], strings.yesReset, (mode) => {
					ctx.actions.run({ command: 'resetToCommit', repo: store.currentRepo, commit: hash, resetMode: <GG.GitResetMode>mode }, strings.resettingToCommit);
				}, target);
			}
		}
	], [
		{
			title: strings.menuCopyCommitHash,
			visible: visibility.copyHash,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: 'Commit Hash', data: hash });
			}
		},
		{
			title: strings.menuCopyCommitSubject,
			visible: visibility.copySubject,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: 'Commit Subject', data: commit.message });
			}
		}
	], [
		{
			title: strings.menuSelectForCompare,
			visible: hash !== UNCOMMITTED,
			onClick: () => {
				store.slices.ui.setCompareSourceHash(hash);
				ctx.persistence.saveState();
			}
		}, {
			title: strings.menuCompareWithSelected + (store.compareSourceHash !== null ? ' (' + abbrevCommit(store.compareSourceHash) + ')' : '') + ELLIPSIS,
			visible: store.compareSourceHash !== null && store.compareSourceHash !== hash,
			onClick: () => {
				const compareSourceHash = store.compareSourceHash;
				if (compareSourceHash === null) return;
				ctx.details.openCompareTab(hash, compareSourceHash);
			}
		}, {
			title: strings.menuDiffWithWorkingTree + ELLIPSIS,
			visible: hash !== UNCOMMITTED && store.gitConfig !== null && (store.gitConfig.diffTool !== null || store.gitConfig.guiDiffTool !== null),
			onClick: () => {
				if (store.gitConfig === null) return;
				ctx.actions.run({
					command: 'openExternalDirDiff',
					repo: store.currentRepo,
					fromHash: hash,
					toHash: UNCOMMITTED,
					isGui: store.gitConfig.guiDiffTool !== null
				}, strings.openingExternalDirDiff);
			}
		}
	], [
		{
			title: store.isCommitPinned(hash) ? strings.unpinCommit : strings.pinCommit,
			visible: hash !== UNCOMMITTED,
			onClick: () => ctx.pinned.togglePinCommit(hash, commit)
		}
	]];
}

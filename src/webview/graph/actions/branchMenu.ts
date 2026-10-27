/* The context menu of a local branch. */

import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { formatCommaSeparatedList } from '../../common/util';
import { GraphContext } from '../context';
import { IndexedRefTarget } from '../state/types';
import { ContextMenuActions } from '../widgets/contextMenu';
import { DialogInput, DialogInputType } from '../widgets/dialog';
import { checkoutBranchAction, createBranchAction, mergeAction, rebaseAction } from './dialogActions';
import { getViewIssueAction } from './viewIssueAction';

export function getBranchContextMenuActions(ctx: GraphContext, target: IndexedRefTarget): ContextMenuActions {
	const store = ctx.store, refName = target.ref, visibility = store.config.contextMenuActionsVisibility.branch;
	const isSelectedInBranchesDropdown = ctx.controls.branchDropdown.isSelected(refName);

	return [[
		{
			title: strings.menuCheckoutBranch,
			visible: visibility.checkout && store.gitBranchHead !== refName,
			onClick: () => checkoutBranchAction(ctx, refName, null, null, target)
		}, {
			title: strings.menuCompareWith,
			visible: true,
			onClick: () => {
				const options = store.gitBranches.filter((b) => b !== refName && !b.startsWith('remotes/')).map((b) => ({ name: b, value: b }));
				if (options.length === 0) {
					ctx.dialog.showError(strings.compareBranchTitle, strings.compareNoOtherBranches, null, null);
					return;
				}
				ctx.dialog.showSelect(formatStr(markup.selectBranchToCompare, refName), options[0].value, options, strings.compareAction, (compareBranch) => {
					const refCommitIndex = store.commits.findIndex((c) => c.heads.includes(refName));
					const compareCommitIndex = store.commits.findIndex((c) => c.heads.includes(compareBranch));
					if (refCommitIndex > -1 && compareCommitIndex > -1) {
						ctx.details.openCompareTab(store.commits[refCommitIndex].hash, store.commits[compareCommitIndex].hash);
					} else {
						ctx.dialog.showError(strings.compareBranchTitle, strings.compareCommitsNotLoaded, null, null);
					}
				}, target);
			}
		}, {
			title: strings.menuRenameBranch + ELLIPSIS,
			visible: visibility.rename,
			onClick: () => {
				ctx.dialog.showRefInput(formatStr(markup.renameBranchPrompt, refName), refName, strings.actionRenameBranch, (newName) => {
					ctx.actions.run({ command: 'renameBranch', repo: store.currentRepo, oldName: refName, newName: newName }, strings.renamingBranch);
				}, target);
			}
		}, {
			title: strings.menuCreateBranch + ELLIPSIS,
			visible: visibility.createBranch,
			onClick: () => createBranchAction(ctx, target.hash, '', true, target)
		}, {
			title: strings.menuDeleteBranch + ELLIPSIS,
			visible: visibility.delete && store.gitBranchHead !== refName,
			onClick: () => {
				const remotesWithBranch = store.gitRemotes.filter((remote) => store.gitBranches.includes('remotes/' + remote + '/' + refName));
				const inputs: DialogInput[] = [{ type: DialogInputType.Checkbox, name: strings.forceDeleteCheckbox, value: store.config.dialogDefaults.deleteBranch.forceDelete }];
				if (remotesWithBranch.length > 0) {
					inputs.push({
						type: DialogInputType.Checkbox,
						name: store.gitRemotes.length > 1 ? strings.deleteOnRemotesCheckbox : strings.deleteOnRemoteCheckbox,
						value: false,
						info: formatStr(remotesWithBranch.length > 1 ? strings.branchOnRemotesInfo : strings.branchOnRemoteInfo, formatCommaSeparatedList(remotesWithBranch.map((remote) => '"' + remote + '"')))
					});
				}
				ctx.dialog.showForm(formatStr(markup.deleteBranchConfirm, refName), inputs, strings.yesDelete, (values) => {
					ctx.actions.run({ command: 'deleteBranch', repo: store.currentRepo, branchName: refName, forceDelete: <boolean>values[0], deleteOnRemotes: remotesWithBranch.length > 0 && <boolean>values[1] ? remotesWithBranch : [] }, strings.deletingBranch);
				}, target);
			}
		}, {
			title: strings.menuMergeIntoCurrentBranch + ELLIPSIS,
			visible: visibility.merge && store.gitBranchHead !== refName,
			onClick: () => mergeAction(ctx, refName, refName, GG.MergeActionOn.Branch, target)
		}, {
			title: strings.menuRebaseOnBranch + ELLIPSIS,
			visible: visibility.rebase && store.gitBranchHead !== refName,
			onClick: () => rebaseAction(ctx, refName, refName, GG.RebaseActionOn.Branch, target)
		}, {
			title: strings.menuPushBranch + ELLIPSIS,
			visible: visibility.push && store.gitRemotes.length > 0,
			onClick: () => {
				const multipleRemotes = store.gitRemotes.length > 1;
				const inputs: DialogInput[] = [
					{ type: DialogInputType.Checkbox, name: strings.setUpstreamCheckbox, value: true },
					{
						type: DialogInputType.Radio,
						name: strings.pushModeInput,
						options: [
							{ name: strings.pushModeNormal, value: GG.GitPushBranchMode.Normal },
							{ name: strings.pushModeForceWithLease, value: GG.GitPushBranchMode.ForceWithLease },
							{ name: strings.pushModeForce, value: GG.GitPushBranchMode.Force }
						],
						default: GG.GitPushBranchMode.Normal
					}
				];

				if (multipleRemotes) {
					inputs.unshift({
						type: DialogInputType.Select,
						name: strings.pushToRemotesInput,
						defaults: [store.getPushRemote(refName)],
						options: store.gitRemotes.map((remote) => ({ name: remote, value: remote })),
						multiple: true
					});
				}

				ctx.dialog.showForm(formatStr(markup.pushBranchConfirm, refName, multipleRemotes ? '' : formatStr(markup.pushToRemoteOf, store.gitRemotes[0])), inputs, strings.yesPush, (values) => {
					const remotes = multipleRemotes ? <string[]>values.shift() : [store.gitRemotes[0]];
					const setUpstream = <boolean>values[0];
					ctx.actions.run({
						command: 'pushBranch',
						repo: store.currentRepo,
						branchName: refName,
						remotes: remotes,
						setUpstream: setUpstream,
						mode: <GG.GitPushBranchMode>values[1],
						willUpdateBranchConfig: setUpstream && remotes.length > 0 && (store.gitConfig === null || typeof store.gitConfig.branches[refName] === 'undefined' || store.gitConfig.branches[refName].remote !== remotes[remotes.length - 1])
					}, strings.pushingBranch);
				}, target);
			}
		}, {
			title: strings.menuPullBranch + ELLIPSIS,
			visible: visibility.pull && store.gitRemotes.length > 0,
			onClick: () => {
				ctx.dialog.showForm(formatStr(markup.updateBranchConfirm, refName, store.gitRemotes[0] + '/' + refName), [{
					type: DialogInputType.Checkbox,
					name: strings.forceUpdateCheckbox,
					value: store.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,
					info: strings.forceUpdateInfo
				}], strings.yesUpdate, (values) => {
					ctx.actions.run({ command: 'fetchIntoLocalBranch', repo: store.currentRepo, remote: store.gitRemotes[0], remoteBranch: refName, localBranch: refName, force: <boolean>values[0] }, strings.updatingBranch);
				}, target);
			}
		}
	], [
		getViewIssueAction(ctx, refName, visibility.viewIssue, target),
		{
			title: strings.menuCreatePullRequest + ELLIPSIS,
			visible: visibility.createPullRequest && store.repoState.pullRequestConfig !== null,
			onClick: () => {
				const config = store.repoState.pullRequestConfig;
				if (config === null) return;
				ctx.dialog.showCheckbox(formatStr(markup.createPullRequestConfirm, refName), strings.pushBeforePullRequestCheckbox, true, strings.yesCreatePullRequest, (push) => {
					ctx.actions.run({ command: 'createPullRequest', repo: store.currentRepo, config: config, sourceRemote: config.sourceRemote, sourceOwner: config.sourceOwner, sourceRepo: config.sourceRepo, sourceBranch: refName, push: push }, strings.creatingPullRequest);
				}, target);
			}
		}
	], [
		{
			title: strings.menuCreateArchive,
			visible: visibility.createArchive,
			onClick: () => {
				ctx.actions.run({ command: 'createArchive', repo: store.currentRepo, ref: refName }, strings.creatingArchive);
			}
		},
		{
			title: strings.menuSelectInBranchesDropdown,
			visible: visibility.selectInBranchesDropdown && !isSelectedInBranchesDropdown,
			onClick: () => ctx.controls.branchDropdown.selectOption(refName)
		},
		{
			title: strings.menuUnselectInBranchesDropdown,
			visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
			onClick: () => ctx.controls.branchDropdown.unselectOption(refName)
		}
	], [
		{
			title: strings.menuCopyBranchName,
			visible: visibility.copyName,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeBranchName, data: refName });
			}
		}
	], [
		{
			title: store.getPinnedBranches().includes(refName) ? strings.unpinBranch : strings.pinBranch,
			visible: true,
			onClick: () => ctx.pinned.togglePinBranch(refName)
		}
	]];
}

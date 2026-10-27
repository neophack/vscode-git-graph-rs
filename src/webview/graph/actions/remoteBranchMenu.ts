/* The context menu of a remote branch. */

import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { IndexedRefTarget } from '../state/types';
import { ContextMenuActions } from '../widgets/contextMenu';
import { DialogInputType } from '../widgets/dialog';
import { checkoutBranchAction, createBranchAction, currentBranchHtml, mergeAction } from './dialogActions';
import { getViewIssueAction } from './viewIssueAction';

export function getRemoteBranchContextMenuActions(ctx: GraphContext, remote: string, target: IndexedRefTarget): ContextMenuActions {
	const store = ctx.store, refName = target.ref, visibility = store.config.contextMenuActionsVisibility.remoteBranch;
	const branchName = remote !== '' ? refName.substring(remote.length + 1) : '';
	const prefixedRefName = 'remotes/' + refName;
	const isSelectedInBranchesDropdown = ctx.controls.branchDropdown.isSelected(prefixedRefName);

	return [[
		{
			title: strings.menuCheckoutBranch + ELLIPSIS,
			visible: visibility.checkout,
			onClick: () => checkoutBranchAction(ctx, refName, remote, null, target)
		}, {
			title: strings.menuCreateBranch + ELLIPSIS,
			visible: visibility.createBranch,
			onClick: () => createBranchAction(ctx, target.hash, branchName, true, target)
		}, {
			title: strings.menuDeleteRemoteBranch + ELLIPSIS,
			visible: visibility.delete && remote !== '',
			onClick: () => {
				ctx.dialog.showConfirmation(formatStr(markup.deleteRemoteBranchConfirm, refName), strings.yesDelete, () => {
					ctx.actions.run({ command: 'deleteRemoteBranch', repo: store.currentRepo, branchName: branchName, remote: remote }, strings.deletingRemoteBranch);
				}, target);
			}
		}, {
			title: strings.menuFetchIntoLocalBranch + ELLIPSIS,
			visible: visibility.fetch && remote !== '' && store.gitBranches.includes(branchName) && store.gitBranchHead !== branchName,
			onClick: () => {
				ctx.dialog.showForm(formatStr(markup.fetchIntoLocalConfirm, refName, branchName), [{
					type: DialogInputType.Checkbox,
					name: strings.forceFetchCheckbox,
					value: store.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,
					info: strings.forceFetchInfo
				}], strings.yesFetch, (values) => {
					ctx.actions.run({ command: 'fetchIntoLocalBranch', repo: store.currentRepo, remote: remote, remoteBranch: branchName, localBranch: branchName, force: <boolean>values[0] }, strings.fetchingBranch);
				}, target);
			}
		}, {
			title: strings.menuMergeIntoCurrentBranch + ELLIPSIS,
			visible: visibility.merge,
			onClick: () => mergeAction(ctx, refName, refName, GG.MergeActionOn.RemoteTrackingBranch, target)
		}, {
			title: strings.menuPullIntoCurrentBranch + ELLIPSIS,
			visible: visibility.pull && remote !== '',
			onClick: () => {
				ctx.dialog.showForm(formatStr(markup.pullBranchConfirm, refName, currentBranchHtml(store.gitBranchHead)), [
					{ type: DialogInputType.Checkbox, name: strings.noFastForwardCheckbox, value: store.config.dialogDefaults.pullBranch.noFastForward },
					{ type: DialogInputType.Checkbox, name: strings.squashCommitsCheckbox, value: store.config.dialogDefaults.pullBranch.squash, info: strings.squashRemoteBranchInfo }
				], strings.yesPull, (values) => {
					ctx.actions.run({ command: 'pullBranch', repo: store.currentRepo, branchName: branchName, remote: remote, createNewCommit: <boolean>values[0], squash: <boolean>values[1] }, strings.pullingBranch);
				}, target);
			}
		}
	], [
		getViewIssueAction(ctx, refName, visibility.viewIssue, target),
		{
			title: strings.menuCreatePullRequest,
			visible: visibility.createPullRequest && store.repoState.pullRequestConfig !== null && branchName !== 'HEAD' &&
				(store.repoState.pullRequestConfig!.sourceRemote === remote || store.repoState.pullRequestConfig!.destRemote === remote),
			onClick: () => {
				const config = store.repoState.pullRequestConfig;
				if (config === null) return;
				const isDestRemote = config.destRemote === remote;
				ctx.actions.run({
					command: 'createPullRequest',
					repo: store.currentRepo,
					config: config,
					sourceRemote: isDestRemote ? config.destRemote! : config.sourceRemote,
					sourceOwner: isDestRemote ? config.destOwner : config.sourceOwner,
					sourceRepo: isDestRemote ? config.destRepo : config.sourceRepo,
					sourceBranch: branchName,
					push: false
				}, strings.creatingPullRequest);
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
			onClick: () => ctx.controls.branchDropdown.selectOption(prefixedRefName)
		},
		{
			title: strings.menuUnselectInBranchesDropdown,
			visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
			onClick: () => ctx.controls.branchDropdown.unselectOption(prefixedRefName)
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
			// Pins are stored under the branches-dropdown value (what a pinned chip selects), which
			// for a remote branch is its `remotes/<remote>/<branch>` form — pinning the bare short
			// name would silently filter to a LOCAL branch of the same name on click, or do nothing.
			title: store.getPinnedBranches().includes(prefixedRefName) ? strings.unpinBranch : strings.pinBranch,
			visible: true,
			onClick: () => ctx.pinned.togglePinBranch(prefixedRefName)
		}
	]];
}

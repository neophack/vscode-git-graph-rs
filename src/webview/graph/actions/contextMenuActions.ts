/* Context menu actions: the menus of branches, commits, remote branches, stashes, tags and the
   uncommitted changes. */

import { html } from '../../common/html';
import { ELLIPSIS, formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { abbrevCommit, formatCommaSeparatedList, UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { findIssueLinks, parseIssueLinkingConfig } from '../text/issueLinking';
import { IndexedCommitTarget, IndexedRefTarget } from '../state/types';
import { ContextMenuAction, ContextMenuActions } from '../widgets/contextMenu';
import { DialogInput, DialogInputType } from '../widgets/dialog';
import { addTagAction, checkoutBranchAction, createBranchAction, currentBranchHtml, deleteTagAction, editCommitMessageAction, mergeAction, rebaseAction } from './dialogActions';

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

export function getCommitContextMenuActions(ctx: GraphContext, target: IndexedCommitTarget): ContextMenuActions {
	const store = ctx.store, hash = target.hash, visibility = store.config.contextMenuActionsVisibility.commit;
	const commit = store.getCommit(hash);
	if (commit === undefined) return []; // The commit is no longer loaded (e.g. after a refresh)

	const parentOptions = () => commit.parents.map((parentHash: string, index: number) => ({
		name: abbrevCommit(parentHash) + (typeof store.commitLookup[parentHash] === 'number' ? ': ' + store.commits[store.commitLookup[parentHash]].message : ''),
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
			visible: visibility.editMessage && commit.parents.length < 2 && !ctx.graph.commitOnRemote(store.commitLookup[hash]),
			onClick: () => editCommitMessageAction(ctx, target)
		}, {
			title: strings.menuDrop + ELLIPSIS,
			visible: visibility.drop && ctx.graph.dropCommitPossible(store.commitLookup[hash]),
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
				store.compareSourceHash = hash;
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

export function getStashContextMenuActions(ctx: GraphContext, target: IndexedRefTarget): ContextMenuActions {
	const store = ctx.store, hash = target.hash, selector = target.ref, visibility = store.config.contextMenuActionsVisibility.stash;
	const stashName = selector.substring(5);

	return [[
		{
			title: strings.menuApplyStash + ELLIPSIS,
			visible: visibility.apply,
			onClick: () => {
				ctx.dialog.showForm(formatStr(markup.applyStashConfirm, stashName), [{
					type: DialogInputType.Checkbox,
					name: strings.reinstateIndexCheckbox,
					value: store.config.dialogDefaults.applyStash.reinstateIndex,
					info: strings.reinstateIndexInfo
				}], strings.yesApplyStash, (values) => {
					ctx.actions.run({ command: 'applyStash', repo: store.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, strings.applyingStash);
				}, target);
			}
		}, {
			title: strings.menuCreateBranchFromStash + ELLIPSIS,
			visible: visibility.createBranch,
			onClick: () => {
				ctx.dialog.showRefInput(formatStr(markup.branchFromStashPrompt, stashName), '', strings.actionCreateBranch, (branchName) => {
					ctx.actions.run({ command: 'branchFromStash', repo: store.currentRepo, selector: selector, branchName: branchName }, strings.creatingBranch);
				}, target);
			}
		}, {
			title: strings.menuPopStash + ELLIPSIS,
			visible: visibility.pop,
			onClick: () => {
				ctx.dialog.showForm(formatStr(markup.popStashConfirm, stashName), [{
					type: DialogInputType.Checkbox,
					name: strings.reinstateIndexCheckbox,
					value: store.config.dialogDefaults.popStash.reinstateIndex,
					info: strings.reinstateIndexInfo
				}], strings.yesPopStash, (values) => {
					ctx.actions.run({ command: 'popStash', repo: store.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, strings.poppingStash);
				}, target);
			}
		}, {
			title: strings.menuDropStash + ELLIPSIS,
			visible: visibility.drop,
			onClick: () => {
				ctx.dialog.showConfirmation(formatStr(markup.dropStashConfirm, stashName), strings.yesDrop, () => {
					ctx.actions.run({ command: 'dropStash', repo: store.currentRepo, selector: selector }, strings.droppingStash);
				}, target);
			}
		}
	], [
		{
			title: strings.menuCopyStashName,
			visible: visibility.copyName,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeStashName, data: selector });
			}
		}, {
			title: strings.menuCopyStashHash,
			visible: visibility.copyHash,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeStashHash, data: hash });
			}
		}
	]];
}

export function getTagContextMenuActions(ctx: GraphContext, isAnnotated: boolean, target: IndexedRefTarget): ContextMenuActions {
	const store = ctx.store, hash = target.hash, tagName = target.ref, visibility = store.config.contextMenuActionsVisibility.tag;

	return [[
		{
			title: strings.menuViewDetails,
			visible: visibility.viewDetails && isAnnotated,
			onClick: () => {
				ctx.actions.run({ command: 'tagDetails', repo: store.currentRepo, tagName: tagName, commitHash: hash }, strings.retrievingTagDetails);
			}
		}, {
			title: strings.menuDeleteTag + ELLIPSIS,
			visible: visibility.delete,
			onClick: () => {
				const message = formatStr(markup.deleteTagConfirm, tagName);
				if (store.gitRemotes.length > 1) {
					const options = [{ name: strings.dontDeleteOnRemote, value: '-1' }];
					store.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
					ctx.dialog.showSelect(html`${message}${markup.alsoDeleteTagOnRemote}`, '-1', options, strings.yesDelete, (remoteIndex) => {
						deleteTagAction(ctx, tagName, remoteIndex !== '-1' ? store.gitRemotes[parseInt(remoteIndex)] : null);
					}, target);
				} else if (store.gitRemotes.length === 1) {
					ctx.dialog.showCheckbox(message, strings.alsoDeleteOnRemoteCheckbox, false, strings.yesDelete, (deleteOnRemote) => {
						deleteTagAction(ctx, tagName, deleteOnRemote ? store.gitRemotes[0] : null);
					}, target);
				} else {
					ctx.dialog.showConfirmation(message, strings.yesDelete, () => {
						deleteTagAction(ctx, tagName, null);
					}, target);
				}
			}
		}, {
			title: strings.menuPushTag + ELLIPSIS,
			visible: visibility.push && store.gitRemotes.length > 0,
			onClick: () => {
				const runPushTagAction = (remotes: string[]) => {
					ctx.actions.run({
						command: 'pushTag',
						repo: store.currentRepo,
						tagName: tagName,
						remotes: remotes,
						commitHash: hash,
						skipRemoteCheck: store.globalViewState.pushTagSkipRemoteCheck
					}, strings.pushingTag);
				};

				if (store.gitRemotes.length === 1) {
					ctx.dialog.showConfirmation(formatStr(markup.pushTagToRemoteConfirm, tagName, store.gitRemotes[0]), strings.yesPush, () => {
						runPushTagAction([store.gitRemotes[0]]);
					}, target);
				} else if (store.gitRemotes.length > 1) {
					const defaults = [store.getPushRemote()];
					const options = store.gitRemotes.map((remote) => ({ name: remote, value: remote }));
					ctx.dialog.showMultiSelect(formatStr(markup.pushTagSelectRemotes, tagName), defaults, options, strings.yesPush, (remotes) => {
						runPushTagAction(remotes);
					}, target);
				}
			}
		}
	], [
		{
			title: strings.menuCreateArchive,
			visible: visibility.createArchive,
			onClick: () => {
				ctx.actions.run({ command: 'createArchive', repo: store.currentRepo, ref: tagName }, strings.creatingArchive);
			}
		},
		{
			title: strings.menuCopyTagName,
			visible: visibility.copyName,
			onClick: () => {
				ctx.bridge.send({ command: 'copyToClipboard', type: strings.copyTypeTagName, data: tagName });
			}
		}
	]];
}

export function getUncommittedChangesContextMenuActions(ctx: GraphContext, target: IndexedCommitTarget): ContextMenuActions {
	const store = ctx.store, visibility = store.config.contextMenuActionsVisibility.uncommittedChanges;

	return [[
		{
			title: strings.menuStashUncommitted + ELLIPSIS,
			visible: visibility.stash,
			onClick: () => {
				ctx.dialog.showForm(markup.stashUncommittedConfirm, [
					{ type: DialogInputType.Text, name: strings.messageInput, default: '', placeholder: strings.optionalPlaceholder },
					{ type: DialogInputType.Checkbox, name: strings.includeUntrackedCheckbox, value: store.config.dialogDefaults.stashUncommittedChanges.includeUntracked, info: strings.includeUntrackedInfo }
				], strings.yesStash, (values) => {
					ctx.actions.run({ command: 'pushStash', repo: store.currentRepo, message: <string>values[0], includeUntracked: <boolean>values[1] }, strings.stashingUncommitted);
				}, target);
			}
		}
	], [
		{
			title: strings.menuResetUncommitted + ELLIPSIS,
			visible: visibility.reset,
			onClick: () => {
				ctx.dialog.showSelect(markup.resetUncommittedConfirm, store.config.dialogDefaults.resetUncommitted.mode, [
					{ name: strings.resetModeMixed, value: GG.GitResetMode.Mixed },
					{ name: strings.resetModeHard, value: GG.GitResetMode.Hard }
				], strings.yesReset, (mode) => {
					ctx.actions.run({ command: 'resetToCommit', repo: store.currentRepo, commit: 'HEAD', resetMode: <GG.GitResetMode>mode }, strings.resettingUncommitted);
				}, target);
			}
		}, {
			title: strings.menuCleanUntracked + ELLIPSIS,
			visible: visibility.clean,
			onClick: () => {
				ctx.dialog.showCheckbox(strings.cleanUntrackedConfirm, strings.cleanDirectoriesCheckbox, true, strings.yesClean, (directories) => {
					ctx.actions.run({ command: 'cleanUntrackedFiles', repo: store.currentRepo, directories: directories }, strings.cleaningUntracked);
				}, target);
			}
		}
	], [
		{
			title: strings.menuOpenSourceControlView,
			visible: visibility.openSourceControlView,
			onClick: () => {
				ctx.bridge.send({ command: 'viewScm' });
			}
		}
	]];
}

/** The "View Issue" action of a branch: it links to the issues named in the branch name. */
function getViewIssueAction(ctx: GraphContext, refName: string, visible: boolean, target: IndexedRefTarget): ContextMenuAction {
	const store = ctx.store;
	let issueLinks: Array<{ url: string, displayText: string }> = [];
	const issueLinking = visible ? parseIssueLinkingConfig(store.repoState.issueLinkingConfig) : null;
	if (issueLinking !== null) issueLinks = findIssueLinks(refName, issueLinking);

	return {
		title: strings.menuViewIssue + (issueLinks.length > 1 ? ELLIPSIS : ''),
		visible: issueLinks.length > 0,
		onClick: () => {
			if (issueLinks.length > 1) {
				ctx.dialog.showSelect(strings.selectIssueToView, '0', issueLinks.map((issueLink, i) => ({ name: issueLink.displayText, value: i.toString() })), strings.menuViewIssue, (value) => {
					ctx.bridge.send({ command: 'openExternalUrl', url: issueLinks[parseInt(value)].url });
				}, target);
			} else if (issueLinks.length === 1) {
				ctx.bridge.send({ command: 'openExternalUrl', url: issueLinks[0].url });
			}
		}
	};
}

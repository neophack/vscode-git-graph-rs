/* Context Menu Actions (branch / commit / remote / stash / tag / uncommitted) */

function getBranchContextMenuActions(view: GitGraphView, target: DialogTarget & RefTarget): ContextMenuActions {

	const refName = target.ref, visibility = view.config.contextMenuActionsVisibility.branch;

	const isSelectedInBranchesDropdown = view.branchDropdown.isSelected(refName);



	return [[

		{

			title: strings.menuCheckoutBranch,

			visible: visibility.checkout && view.gitBranchHead !== refName,

			onClick: () => checkoutBranchAction(view, refName, null, null, target)

		}, {

			title: strings.menuCompareWith,

			visible: true,

			onClick: () => {

				const options = view.gitBranches.filter(b => b !== refName && !b.startsWith('remotes/')).map(b => ({ name: b, value: b }));

				if (options.length === 0) {

					dialog.showError(strings.compareBranchTitle, strings.compareNoOtherBranches, strings.dialogClose, null);

					return;

				}

				dialog.showSelect(formatStr(strings.selectBranchToCompare, escapeHtml(refName)), options[0].value, options, strings.compareAction, (compareBranch) => {

					let refCommitIndex = view.commits.findIndex(c => c.heads.includes(refName));

					let compareCommitIndex = view.commits.findIndex(c => c.heads.includes(compareBranch));

					if (refCommitIndex > -1 && compareCommitIndex > -1) {

						view.openCompareTab(view.commits[refCommitIndex].hash, view.commits[compareCommitIndex].hash);

					} else {

						dialog.showError(strings.compareBranchTitle, strings.compareCommitsNotLoaded, strings.dialogClose, null);

					}

				}, target);

			}

		}, {

			title: strings.menuRenameBranch + ELLIPSIS,

			visible: visibility.rename,

			onClick: () => {

				dialog.showRefInput(formatStr(strings.renameBranchPrompt, escapeHtml(refName)), refName, strings.actionRenameBranch, (newName) => {

					runAction({ command: 'renameBranch', repo: view.currentRepo, oldName: refName, newName: newName }, strings.renamingBranch);

				}, target);

			}

		}, {

			title: strings.menuCreateBranch + ELLIPSIS,

			visible: visibility.createBranch,

			onClick: () => createBranchAction(view, target.hash, '', true, target)

		}, {

			title: strings.menuDeleteBranch + ELLIPSIS,

			visible: visibility.delete && view.gitBranchHead !== refName,

			onClick: () => {

				let remotesWithBranch = view.gitRemotes.filter(remote => view.gitBranches.includes('remotes/' + remote + '/' + refName));

				let inputs: DialogInput[] = [{ type: DialogInputType.Checkbox, name: strings.forceDeleteCheckbox, value: view.config.dialogDefaults.deleteBranch.forceDelete }];

				if (remotesWithBranch.length > 0) {

					inputs.push({

						type: DialogInputType.Checkbox,

						name: view.gitRemotes.length > 1 ? strings.deleteOnRemotesCheckbox : strings.deleteOnRemoteCheckbox,

						value: false,

						info: formatStr(remotesWithBranch.length > 1 ? strings.branchOnRemotesInfo : strings.branchOnRemoteInfo, formatCommaSeparatedList(remotesWithBranch.map((remote) => '"' + remote + '"')))

					});

				}

				dialog.showForm(formatStr(strings.deleteBranchConfirm, escapeHtml(refName)), inputs, strings.yesDelete, (values) => {

					runAction({ command: 'deleteBranch', repo: view.currentRepo, branchName: refName, forceDelete: <boolean>values[0], deleteOnRemotes: remotesWithBranch.length > 0 && <boolean>values[1] ? remotesWithBranch : [] }, strings.deletingBranch);

				}, target);

			}

		}, {

			title: strings.menuMergeIntoCurrentBranch + ELLIPSIS,

			visible: visibility.merge && view.gitBranchHead !== refName,

			onClick: () => mergeAction(view, refName, refName, GG.MergeActionOn.Branch, target)

		}, {

			title: strings.menuRebaseOnBranch + ELLIPSIS,

			visible: visibility.rebase && view.gitBranchHead !== refName,

			onClick: () => rebaseAction(view, refName, refName, GG.RebaseActionOn.Branch, target)

		}, {

			title: strings.menuPushBranch + ELLIPSIS,

			visible: visibility.push && view.gitRemotes.length > 0,

			onClick: () => {

				const multipleRemotes = view.gitRemotes.length > 1;

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

						defaults: [view.getPushRemote(refName)],

						options: view.gitRemotes.map((remote) => ({ name: remote, value: remote })),

						multiple: true

					});

				}



				dialog.showForm(formatStr(strings.pushBranchConfirm, escapeHtml(refName), multipleRemotes ? '' : formatStr(strings.pushToRemoteOf, escapeHtml(view.gitRemotes[0]))), inputs, strings.yesPush, (values) => {

					const remotes = multipleRemotes ? <string[]>values.shift() : [view.gitRemotes[0]];

					const setUpstream = <boolean>values[0];

					runAction({

						command: 'pushBranch',

						repo: view.currentRepo,

						branchName: refName,

						remotes: remotes,

						setUpstream: setUpstream,

						mode: <GG.GitPushBranchMode>values[1],

						willUpdateBranchConfig: setUpstream && remotes.length > 0 && (view.gitConfig === null || typeof view.gitConfig.branches[refName] === 'undefined' || view.gitConfig.branches[refName].remote !== remotes[remotes.length - 1])

					}, strings.pushingBranch);

				}, target);

			}

		}, {

			title: strings.menuPullBranch + ELLIPSIS,

			visible: visibility.pull && view.gitRemotes.length > 0,

			onClick: () => {

				dialog.showForm(formatStr(strings.updateBranchConfirm, escapeHtml(refName), escapeHtml(view.gitRemotes[0] + '/' + refName)), [{

					type: DialogInputType.Checkbox,

					name: strings.forceUpdateCheckbox,

					value: view.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,

					info: strings.forceUpdateInfo

				}], strings.yesUpdate, (values) => {

					runAction({ command: 'fetchIntoLocalBranch', repo: view.currentRepo, remote: view.gitRemotes[0], remoteBranch: refName, localBranch: refName, force: <boolean>values[0] }, strings.updatingBranch);

				}, target);

			}

		}

	], [

		getViewIssueAction(view, refName, visibility.viewIssue, target),

		{

			title: strings.menuCreatePullRequest + ELLIPSIS,

			visible: visibility.createPullRequest && view.gitRepos[view.currentRepo].pullRequestConfig !== null,

			onClick: () => {

				const config = view.gitRepos[view.currentRepo].pullRequestConfig;

				if (config === null) return;

				dialog.showCheckbox(formatStr(strings.createPullRequestConfirm, escapeHtml(refName)), strings.pushBeforePullRequestCheckbox, true, strings.yesCreatePullRequest, (push) => {

					runAction({ command: 'createPullRequest', repo: view.currentRepo, config: config, sourceRemote: config.sourceRemote, sourceOwner: config.sourceOwner, sourceRepo: config.sourceRepo, sourceBranch: refName, push: push }, strings.creatingPullRequest);

				}, target);

			}

		}

	], [

		{

			title: strings.menuCreateArchive,

			visible: visibility.createArchive,

			onClick: () => {

				runAction({ command: 'createArchive', repo: view.currentRepo, ref: refName }, strings.creatingArchive);

			}

		},

		{

			title: strings.menuSelectInBranchesDropdown,

			visible: visibility.selectInBranchesDropdown && !isSelectedInBranchesDropdown,

			onClick: () => view.branchDropdown.selectOption(refName)

		},

		{

			title: strings.menuUnselectInBranchesDropdown,

			visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,

			onClick: () => view.branchDropdown.unselectOption(refName)

		}

	], [

		{

			title: strings.menuCopyBranchName,

			visible: visibility.copyName,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: strings.copyTypeBranchName, data: refName });

			}

		}

	], [

		{

			title: view.getPinnedBranches().includes(refName) ? strings.unpinBranch : strings.pinBranch,

			visible: true,

			onClick: () => view.togglePinBranch(refName)

		}

	]];

}


function getCommitContextMenuActions(view: GitGraphView, target: DialogTarget & CommitTarget): ContextMenuActions {

	const hash = target.hash, visibility = view.config.contextMenuActionsVisibility.commit;

	const commit = view.commits[view.commitLookup[hash]];

	if (commit === undefined) return []; // The commit is no longer loaded (e.g. after a refresh)

	return [[

		{

			title: strings.menuAddTag + ELLIPSIS,

			visible: visibility.addTag,

			onClick: () => addTagAction(view, hash, '', view.config.dialogDefaults.addTag.type, '', null, target)

		}, {

			title: strings.menuCreateBranch + ELLIPSIS,

			visible: visibility.createBranch,

			onClick: () => createBranchAction(view, hash, '', view.config.dialogDefaults.createBranch.checkout, target)

		}

	], [

		{

			title: strings.menuCheckout + (globalState.alwaysAcceptCheckoutCommit ? '' : ELLIPSIS),

			visible: visibility.checkout,

			onClick: () => {

				const checkoutCommit = () => runAction({ command: 'checkoutCommit', repo: view.currentRepo, commitHash: hash }, strings.checkingOutCommit);

				if (globalState.alwaysAcceptCheckoutCommit) {

					checkoutCommit();

				} else {

					dialog.showCheckbox(formatStr(strings.checkoutCommitConfirm, abbrevCommit(hash)), strings.alwaysAcceptCheckbox, false, strings.yesCheckout, (alwaysAccept) => {

						if (alwaysAccept) {

							updateGlobalViewState('alwaysAcceptCheckoutCommit', true);

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

				let inputs: DialogInput[] = [];

				if (isMerge) {

					let options = commit.parents.map((hash: string, index: number) => ({

						name: abbrevCommit(hash) + (typeof view.commitLookup[hash] === 'number' ? ': ' + view.commits[view.commitLookup[hash]].message : ''),

						value: (index + 1).toString()

					}));

					inputs.push({

						type: DialogInputType.Select,

						name: strings.parentHashInput,

						options: options,

						default: '1',

						info: strings.parentHashCherryPickInfo

					});

				}

				inputs.push({

					type: DialogInputType.Checkbox,

						name: strings.recordOriginCheckbox,

					value: view.config.dialogDefaults.cherryPick.recordOrigin,

						info: strings.recordOriginInfo

				}, {

					type: DialogInputType.Checkbox,

						name: strings.noCommitCheckbox,

					value: view.config.dialogDefaults.cherryPick.noCommit,

						info: strings.noCommitCherryPickInfo

				});



				dialog.showForm(formatStr(strings.cherryPickConfirm, abbrevCommit(hash)), inputs, strings.yesCherryPick, (values) => {

					let parentIndex = isMerge ? parseInt(<string>values.shift()) : 0;

					runAction({

						command: 'cherrypickCommit',

						repo: view.currentRepo,

						commitHash: hash,

						parentIndex: parentIndex,

						recordOrigin: <boolean>values[0],

						noCommit: <boolean>values[1]

					}, strings.cherryPickingCommit);

				}, target);

			}

		}, {

			title: strings.menuRevert + ELLIPSIS,

			visible: visibility.revert,

			onClick: () => {

				if (commit.parents.length > 1) {

					let options = commit.parents.map((hash: string, index: number) => ({

						name: abbrevCommit(hash) + (typeof view.commitLookup[hash] === 'number' ? ': ' + view.commits[view.commitLookup[hash]].message : ''),

						value: (index + 1).toString()

					}));

					dialog.showSelect(formatStr(strings.revertMergeCommitConfirm, abbrevCommit(hash)), '1', options, strings.yesRevert, (parentIndex) => {

						runAction({ command: 'revertCommit', repo: view.currentRepo, commitHash: hash, parentIndex: parseInt(parentIndex) }, strings.revertingCommit);

					}, target);

				} else {

					dialog.showConfirmation(formatStr(strings.revertCommitConfirm, abbrevCommit(hash)), strings.yesRevert, () => {

						runAction({ command: 'revertCommit', repo: view.currentRepo, commitHash: hash, parentIndex: 0 }, strings.revertingCommit);

					}, target);

				}

			}

		}, {

			title: strings.menuResetLastCommitSoft + ELLIPSIS,

			visible: visibility.undo && hash === view.commitHead,

			onClick: () => {

				dialog.showConfirmation(strings.resetLastCommitConfirm, strings.yesResetLastCommit, () => {

					runAction({ command: 'undoLastCommit', repo: view.currentRepo }, strings.resettingLastCommit);

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

			visible: visibility.editMessage && commit.parents.length < 2 && !view.graph.commitOnRemote(view.commitLookup[hash]),

			onClick: () => amendCommitAction(view, target)

		}, {



			title: strings.menuDrop + ELLIPSIS,

			visible: visibility.drop && view.graph.dropCommitPossible(view.commitLookup[hash]),

			onClick: () => {

				dialog.showConfirmation(formatStr(strings.dropCommitConfirm, abbrevCommit(hash)) + (view.onlyFollowFirstParent ? strings.dropCommitFirstParentNote : ''), strings.yesDrop, () => {

					runAction({ command: 'dropCommit', repo: view.currentRepo, commitHash: hash }, strings.droppingCommit);

				}, target);

			}

		}

	], [

		{

			title: strings.menuMergeIntoCurrentBranch + ELLIPSIS,

			visible: visibility.merge,

			onClick: () => mergeAction(view, hash, abbrevCommit(hash), GG.MergeActionOn.Commit, target)

		}, {

			title: strings.menuRebaseOnCommit + ELLIPSIS,

			visible: visibility.rebase,

			onClick: () => rebaseAction(view, hash, abbrevCommit(hash), GG.RebaseActionOn.Commit, target)

		}, {

			title: strings.menuResetToCommit + ELLIPSIS,

			visible: visibility.reset,

			onClick: () => {

				dialog.showSelect(formatStr(strings.resetToCommitConfirm, view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b>' + strings.currentBranchSuffix : strings.currentBranchPlain, abbrevCommit(hash)), view.config.dialogDefaults.resetCommit.mode, [

					{ name: strings.resetModeSoft, value: GG.GitResetMode.Soft },

					{ name: strings.resetModeMixed, value: GG.GitResetMode.Mixed },

					{ name: strings.resetModeHard, value: GG.GitResetMode.Hard }

				], strings.yesReset, (mode) => {

					runAction({ command: 'resetToCommit', repo: view.currentRepo, commit: hash, resetMode: <GG.GitResetMode>mode }, strings.resettingToCommit);

				}, target);

			}

		}

	], [

		{

			title: strings.menuCopyCommitHash,

			visible: visibility.copyHash,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: 'Commit Hash', data: hash });

			}

		},

		{

			title: strings.menuCopyCommitSubject,

			visible: visibility.copySubject,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: 'Commit Subject', data: commit.message });

			}

		}

	], [

		{

			title: strings.menuSelectForCompare,

			visible: hash !== UNCOMMITTED,

			onClick: () => {

				view.compareSourceHash = hash;

				view.saveState();

			}

		}, {

			title: strings.menuCompareWithSelected + (view.compareSourceHash !== null ? ' (' + abbrevCommit(view.compareSourceHash) + ')' : '') + ELLIPSIS,

			visible: view.compareSourceHash !== null && view.compareSourceHash !== hash,

			onClick: () => {

				const compareSourceHash = view.compareSourceHash;

				if (compareSourceHash === null) return;

				view.openCompareTab(hash, compareSourceHash);

			}

		}, {

			title: strings.menuDiffWithWorkingTree + ELLIPSIS,

			visible: hash !== UNCOMMITTED && view.gitConfig !== null && (view.gitConfig.diffTool !== null || view.gitConfig.guiDiffTool !== null),

			onClick: () => {

				if (view.gitConfig === null) return;

				runAction({

					command: 'openExternalDirDiff',

					repo: view.currentRepo,

					fromHash: hash,

					toHash: UNCOMMITTED,

					isGui: view.gitConfig.guiDiffTool !== null

				}, strings.openingExternalDirDiff);

			}

		}

	], [

		{

			title: view.isCommitPinned(hash) ? strings.unpinCommit : strings.pinCommit,

			visible: hash !== UNCOMMITTED,

			onClick: () => view.togglePinCommit(hash, commit)

		}

	]];

}


function getRemoteBranchContextMenuActions(view: GitGraphView, remote: string, target: DialogTarget & RefTarget): ContextMenuActions {

	const refName = target.ref, visibility = view.config.contextMenuActionsVisibility.remoteBranch;

	const branchName = remote !== '' ? refName.substring(remote.length + 1) : '';

	const prefixedRefName = 'remotes/' + refName;

	const isSelectedInBranchesDropdown = view.branchDropdown.isSelected(prefixedRefName);

	return [[

		{

			title: strings.menuCheckoutBranch + ELLIPSIS,

			visible: visibility.checkout,

			onClick: () => checkoutBranchAction(view, refName, remote, null, target)

		}, {

			title: strings.menuCreateBranch + ELLIPSIS,

			visible: visibility.createBranch,

			onClick: () => createBranchAction(view, target.hash, branchName, true, target)

		}, {

			title: strings.menuDeleteRemoteBranch + ELLIPSIS,

			visible: visibility.delete && remote !== '',

			onClick: () => {

				dialog.showConfirmation(formatStr(strings.deleteRemoteBranchConfirm, escapeHtml(refName)), strings.yesDelete, () => {

					runAction({ command: 'deleteRemoteBranch', repo: view.currentRepo, branchName: branchName, remote: remote }, strings.deletingRemoteBranch);

				}, target);

			}

		}, {

			title: strings.menuFetchIntoLocalBranch + ELLIPSIS,

			visible: visibility.fetch && remote !== '' && view.gitBranches.includes(branchName) && view.gitBranchHead !== branchName,

			onClick: () => {

				dialog.showForm(formatStr(strings.fetchIntoLocalConfirm, escapeHtml(refName), escapeHtml(branchName)), [{

					type: DialogInputType.Checkbox,

						name: strings.forceFetchCheckbox,

					value: view.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,

						info: strings.forceFetchInfo

					}], strings.yesFetch, (values) => {

						runAction({ command: 'fetchIntoLocalBranch', repo: view.currentRepo, remote: remote, remoteBranch: branchName, localBranch: branchName, force: <boolean>values[0] }, strings.fetchingBranch);

				}, target);

			}

		}, {

			title: strings.menuMergeIntoCurrentBranch + ELLIPSIS,

			visible: visibility.merge,

			onClick: () => mergeAction(view, refName, refName, GG.MergeActionOn.RemoteTrackingBranch, target)

		}, {

			title: strings.menuPullIntoCurrentBranch + ELLIPSIS,

			visible: visibility.pull && remote !== '',

			onClick: () => {

				dialog.showForm(formatStr(strings.pullBranchConfirm, escapeHtml(refName), view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b>' + strings.currentBranchSuffix : strings.currentBranchPlain), [

					{ type: DialogInputType.Checkbox, name: strings.noFastForwardCheckbox, value: view.config.dialogDefaults.pullBranch.noFastForward },

					{ type: DialogInputType.Checkbox, name: strings.squashCommitsCheckbox, value: view.config.dialogDefaults.pullBranch.squash, info: strings.squashRemoteBranchInfo }

				], strings.yesPull, (values) => {

					runAction({ command: 'pullBranch', repo: view.currentRepo, branchName: branchName, remote: remote, createNewCommit: <boolean>values[0], squash: <boolean>values[1] }, strings.pullingBranch);

				}, target);

			}

		}

	], [

		getViewIssueAction(view, refName, visibility.viewIssue, target),

		{

			title: strings.menuCreatePullRequest,

			visible: visibility.createPullRequest && view.gitRepos[view.currentRepo].pullRequestConfig !== null && branchName !== 'HEAD' &&

				(view.gitRepos[view.currentRepo].pullRequestConfig!.sourceRemote === remote || view.gitRepos[view.currentRepo].pullRequestConfig!.destRemote === remote),

			onClick: () => {

				const config = view.gitRepos[view.currentRepo].pullRequestConfig;

				if (config === null) return;

				const isDestRemote = config.destRemote === remote;

				runAction({

					command: 'createPullRequest',

					repo: view.currentRepo,

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

				runAction({ command: 'createArchive', repo: view.currentRepo, ref: refName }, strings.creatingArchive);

			}

		},

		{

			title: strings.menuSelectInBranchesDropdown,

			visible: visibility.selectInBranchesDropdown && !isSelectedInBranchesDropdown,

			onClick: () => view.branchDropdown.selectOption(prefixedRefName)

		},

		{

			title: strings.menuUnselectInBranchesDropdown,

			visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,

			onClick: () => view.branchDropdown.unselectOption(prefixedRefName)

		}

	], [

		{

			title: strings.menuCopyBranchName,

			visible: visibility.copyName,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: strings.copyTypeBranchName, data: refName });

			}

		}

	], [

		{

			title: view.getPinnedBranches().includes(branchName) ? strings.unpinBranch : strings.pinBranch,

			visible: true,

			onClick: () => view.togglePinBranch(branchName)

		}

	]];

}


function getStashContextMenuActions(view: GitGraphView, target: DialogTarget & RefTarget): ContextMenuActions {

	const hash = target.hash, selector = target.ref, visibility = view.config.contextMenuActionsVisibility.stash;

	return [[

		{

			title: strings.menuApplyStash + ELLIPSIS,

			visible: visibility.apply,

			onClick: () => {

				dialog.showForm(formatStr(strings.applyStashConfirm, escapeHtml(selector.substring(5))), [{

					type: DialogInputType.Checkbox,

					name: strings.reinstateIndexCheckbox,

					value: view.config.dialogDefaults.applyStash.reinstateIndex,

					info: strings.reinstateIndexInfo

				}], strings.yesApplyStash, (values) => {

					runAction({ command: 'applyStash', repo: view.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, strings.applyingStash);

				}, target);

			}

		}, {

			title: strings.menuCreateBranchFromStash + ELLIPSIS,

			visible: visibility.createBranch,

			onClick: () => {

				dialog.showRefInput(formatStr(strings.branchFromStashPrompt, escapeHtml(selector.substring(5))), '', strings.actionCreateBranch, (branchName) => {

					runAction({ command: 'branchFromStash', repo: view.currentRepo, selector: selector, branchName: branchName }, strings.creatingBranch);

				}, target);

			}

		}, {

			title: strings.menuPopStash + ELLIPSIS,

			visible: visibility.pop,

			onClick: () => {

				dialog.showForm(formatStr(strings.popStashConfirm, escapeHtml(selector.substring(5))), [{

					type: DialogInputType.Checkbox,

					name: strings.reinstateIndexCheckbox,

					value: view.config.dialogDefaults.popStash.reinstateIndex,

					info: strings.reinstateIndexInfo

				}], strings.yesPopStash, (values) => {

					runAction({ command: 'popStash', repo: view.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, strings.poppingStash);

				}, target);

			}

		}, {

			title: strings.menuDropStash + ELLIPSIS,

			visible: visibility.drop,

			onClick: () => {

				dialog.showConfirmation(formatStr(strings.dropStashConfirm, escapeHtml(selector.substring(5))), strings.yesDrop, () => {

					runAction({ command: 'dropStash', repo: view.currentRepo, selector: selector }, strings.droppingStash);

				}, target);

			}

		}

	], [

		{

			title: strings.menuCopyStashName,

			visible: visibility.copyName,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: strings.copyTypeStashName, data: selector });

			}

		}, {

			title: strings.menuCopyStashHash,

			visible: visibility.copyHash,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: strings.copyTypeStashHash, data: hash });

			}

		}

	]];

}


function getTagContextMenuActions(view: GitGraphView, isAnnotated: boolean, target: DialogTarget & RefTarget): ContextMenuActions {

	const hash = target.hash, tagName = target.ref, visibility = view.config.contextMenuActionsVisibility.tag;

	return [[

		{

			title: strings.menuViewDetails,

			visible: visibility.viewDetails && isAnnotated,

			onClick: () => {

				runAction({ command: 'tagDetails', repo: view.currentRepo, tagName: tagName, commitHash: hash }, strings.retrievingTagDetails);

			}

		}, {

			title: strings.menuDeleteTag + ELLIPSIS,

			visible: visibility.delete,

			onClick: () => {

				let message = formatStr(strings.deleteTagConfirm, escapeHtml(tagName));

				if (view.gitRemotes.length > 1) {

					let options = [{ name: strings.dontDeleteOnRemote, value: '-1' }];

					view.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));

					dialog.showSelect(message + strings.alsoDeleteTagOnRemote, '-1', options, strings.yesDelete, remoteIndex => {

						deleteTagAction(view, tagName, remoteIndex !== '-1' ? view.gitRemotes[parseInt(remoteIndex)] : null);

					}, target);

				} else if (view.gitRemotes.length === 1) {

					dialog.showCheckbox(message, strings.alsoDeleteOnRemoteCheckbox, false, strings.yesDelete, deleteOnRemote => {

						deleteTagAction(view, tagName, deleteOnRemote ? view.gitRemotes[0] : null);

					}, target);

				} else {

					dialog.showConfirmation(message, strings.yesDelete, () => {

						deleteTagAction(view, tagName, null);

					}, target);

				}

			}

		}, {

			title: strings.menuPushTag + ELLIPSIS,

			visible: visibility.push && view.gitRemotes.length > 0,

			onClick: () => {

				const runPushTagAction = (remotes: string[]) => {

					runAction({

						command: 'pushTag',

						repo: view.currentRepo,

						tagName: tagName,

						remotes: remotes,

						commitHash: hash,

						skipRemoteCheck: globalState.pushTagSkipRemoteCheck

					}, strings.pushingTag);

				};



				if (view.gitRemotes.length === 1) {

					dialog.showConfirmation(formatStr(strings.pushTagToRemoteConfirm, escapeHtml(tagName), escapeHtml(view.gitRemotes[0])), strings.yesPush, () => {

						runPushTagAction([view.gitRemotes[0]]);

					}, target);

				} else if (view.gitRemotes.length > 1) {

					const defaults = [view.getPushRemote()];

					const options = view.gitRemotes.map((remote) => ({ name: remote, value: remote }));

					dialog.showMultiSelect(formatStr(strings.pushTagSelectRemotes, escapeHtml(tagName)), defaults, options, strings.yesPush, (remotes) => {

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

				runAction({ command: 'createArchive', repo: view.currentRepo, ref: tagName }, strings.creatingArchive);

			}

		},

		{

			title: strings.menuCopyTagName,

			visible: visibility.copyName,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: strings.copyTypeTagName, data: tagName });

			}

		}

	]];

}


function getUncommittedChangesContextMenuActions(view: GitGraphView, target: DialogTarget & CommitTarget): ContextMenuActions {

	let visibility = view.config.contextMenuActionsVisibility.uncommittedChanges;

	return [[

		{

			title: strings.menuStashUncommitted + ELLIPSIS,

			visible: visibility.stash,

			onClick: () => {

				dialog.showForm(strings.stashUncommittedConfirm, [

					{ type: DialogInputType.Text, name: strings.messageInput, default: '', placeholder: strings.optionalPlaceholder },

					{ type: DialogInputType.Checkbox, name: strings.includeUntrackedCheckbox, value: view.config.dialogDefaults.stashUncommittedChanges.includeUntracked, info: strings.includeUntrackedInfo }

				], strings.yesStash, (values) => {

					runAction({ command: 'pushStash', repo: view.currentRepo, message: <string>values[0], includeUntracked: <boolean>values[1] }, strings.stashingUncommitted);

				}, target);

			}

		}

	], [

		{

			title: strings.menuResetUncommitted + ELLIPSIS,

			visible: visibility.reset,

			onClick: () => {

				dialog.showSelect(strings.resetUncommittedConfirm, view.config.dialogDefaults.resetUncommitted.mode, [

					{ name: strings.resetModeMixed, value: GG.GitResetMode.Mixed },

					{ name: strings.resetModeHard, value: GG.GitResetMode.Hard }

				], strings.yesReset, (mode) => {

					runAction({ command: 'resetToCommit', repo: view.currentRepo, commit: 'HEAD', resetMode: <GG.GitResetMode>mode }, strings.resettingUncommitted);

				}, target);

			}

		}, {

			title: strings.menuCleanUntracked + ELLIPSIS,

			visible: visibility.clean,

			onClick: () => {

				dialog.showCheckbox(strings.cleanUntrackedConfirm, strings.cleanDirectoriesCheckbox, true, strings.yesClean, directories => {

					runAction({ command: 'cleanUntrackedFiles', repo: view.currentRepo, directories: directories }, strings.cleaningUntracked);

				}, target);

			}

		}

	], [

		{

			title: strings.menuOpenSourceControlView,

			visible: visibility.openSourceControlView,

			onClick: () => {

				sendMessage({ command: 'viewScm' });

			}

		}

	]];

}


function getViewIssueAction(view: GitGraphView, refName: string, visible: boolean, target: DialogTarget & RefTarget): ContextMenuAction {

	const issueLinks: { url: string, displayText: string }[] = [];



	let issueLinking: IssueLinking | null, match: RegExpExecArray | null;

	if (visible && (issueLinking = parseIssueLinkingConfig(view.gitRepos[view.currentRepo].issueLinkingConfig)) !== null) {

		issueLinking.regexp.lastIndex = 0;

		while (match = issueLinking.regexp.exec(refName)) {

			if (match[0].length === 0) break;

			issueLinks.push({

				url: generateIssueLinkFromMatch(match, issueLinking),

				displayText: match[0]

			});

		}

	}



	return {

		title: strings.menuViewIssue + (issueLinks.length > 1 ? ELLIPSIS : ''),

		visible: issueLinks.length > 0,

		onClick: () => {

			if (issueLinks.length > 1) {

				dialog.showSelect(strings.selectIssueToView, '0', issueLinks.map((issueLink, i) => ({ name: issueLink.displayText, value: i.toString() })), strings.menuViewIssue, (value) => {

					sendMessage({ command: 'openExternalUrl', url: issueLinks[parseInt(value)].url });

				}, target);

			} else if (issueLinks.length === 1) {

				sendMessage({ command: 'openExternalUrl', url: issueLinks[0].url });

			}

		}

	};

}


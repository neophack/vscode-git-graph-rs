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

					dialog.showError('Compare Branch', 'No other local branches to compare with.', 'Close', null);

					return;

				}

				dialog.showSelect('Select branch to compare <b><i>' + escapeHtml(refName) + '</i></b> with:', options[0].value, options, 'Compare', (compareBranch) => {

					let refCommitIndex = view.commits.findIndex(c => c.heads.includes(refName));

					let compareCommitIndex = view.commits.findIndex(c => c.heads.includes(compareBranch));

					if (refCommitIndex > -1 && compareCommitIndex > -1) {

						view.openCompareTab(view.commits[refCommitIndex].hash, view.commits[compareCommitIndex].hash);

					} else {

						dialog.showError('Compare Branch', 'Could not find the commits for the selected branches in the current view. Try loading more commits.', 'Close', null);

					}

				}, target);

			}

		}, {

			title: strings.menuRenameBranch + ELLIPSIS,

			visible: visibility.rename,

			onClick: () => {

				dialog.showRefInput('Enter the new name for branch <b><i>' + escapeHtml(refName) + '</i></b>:', refName, 'Rename Branch', (newName) => {

					runAction({ command: 'renameBranch', repo: view.currentRepo, oldName: refName, newName: newName }, 'Renaming Branch');

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

				let inputs: DialogInput[] = [{ type: DialogInputType.Checkbox, name: 'Force Delete', value: view.config.dialogDefaults.deleteBranch.forceDelete }];

				if (remotesWithBranch.length > 0) {

					inputs.push({

						type: DialogInputType.Checkbox,

						name: 'Delete this branch on the remote' + (view.gitRemotes.length > 1 ? 's' : ''),

						value: false,

						info: 'This branch is on the remote' + (remotesWithBranch.length > 1 ? 's: ' : ' ') + formatCommaSeparatedList(remotesWithBranch.map((remote) => '"' + remote + '"'))

					});

				}

				dialog.showForm('Are you sure you want to delete the branch <b><i>' + escapeHtml(refName) + '</i></b>?', inputs, 'Yes, delete', (values) => {

					runAction({ command: 'deleteBranch', repo: view.currentRepo, branchName: refName, forceDelete: <boolean>values[0], deleteOnRemotes: remotesWithBranch.length > 0 && <boolean>values[1] ? remotesWithBranch : [] }, 'Deleting Branch');

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

					{ type: DialogInputType.Checkbox, name: 'Set Upstream', value: true },

					{

						type: DialogInputType.Radio,

						name: 'Push Mode',

						options: [

							{ name: 'Normal', value: GG.GitPushBranchMode.Normal },

							{ name: 'Force With Lease', value: GG.GitPushBranchMode.ForceWithLease },

							{ name: 'Force', value: GG.GitPushBranchMode.Force }

						],

						default: GG.GitPushBranchMode.Normal

					}

				];



				if (multipleRemotes) {

					inputs.unshift({

						type: DialogInputType.Select,

						name: 'Push to Remote(s)',

						defaults: [view.getPushRemote(refName)],

						options: view.gitRemotes.map((remote) => ({ name: remote, value: remote })),

						multiple: true

					});

				}



				dialog.showForm('Are you sure you want to push the branch <b><i>' + escapeHtml(refName) + '</i></b>' + (multipleRemotes ? '' : ' to the remote <b><i>' + escapeHtml(view.gitRemotes[0]) + '</i></b>') + '?', inputs, 'Yes, push', (values) => {

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

					}, 'Pushing Branch');

				}, target);

			}

		}, {

			title: strings.menuPullBranch + ELLIPSIS,

			visible: visibility.pull && view.gitRemotes.length > 0,

			onClick: () => {

				dialog.showForm('Are you sure you want to update the local branch <b><i>' + escapeHtml(refName) + '</i></b> with the latest changes from <b><i>' + escapeHtml(view.gitRemotes[0] + '/' + refName) + '</i></b>?', [{

					type: DialogInputType.Checkbox,

					name: 'Force Update',

					value: view.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,

					info: 'Force the local branch to be reset to the remote branch (discard local commits).'

				}], 'Yes, update', (values) => {

					runAction({ command: 'fetchIntoLocalBranch', repo: view.currentRepo, remote: view.gitRemotes[0], remoteBranch: refName, localBranch: refName, force: <boolean>values[0] }, 'Updating Branch');

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

				dialog.showCheckbox('Are you sure you want to create a Pull Request for branch <b><i>' + escapeHtml(refName) + '</i></b>?', 'Push branch before creating the Pull Request', true, 'Yes, create Pull Request', (push) => {

					runAction({ command: 'createPullRequest', repo: view.currentRepo, config: config, sourceRemote: config.sourceRemote, sourceOwner: config.sourceOwner, sourceRepo: config.sourceRepo, sourceBranch: refName, push: push }, 'Creating Pull Request');

				}, target);

			}

		}

	], [

		{

			title: strings.menuCreateArchive,

			visible: visibility.createArchive,

			onClick: () => {

				runAction({ command: 'createArchive', repo: view.currentRepo, ref: refName }, 'Creating Archive');

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

				sendMessage({ command: 'copyToClipboard', type: 'Branch Name', data: refName });

			}

		}

	], [

		{

			title: view.getPinnedBranches().includes(refName) ? 'Unpin Branch' : 'Pin Branch',

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

				const checkoutCommit = () => runAction({ command: 'checkoutCommit', repo: view.currentRepo, commitHash: hash }, 'Checking out Commit');

				if (globalState.alwaysAcceptCheckoutCommit) {

					checkoutCommit();

				} else {

					dialog.showCheckbox('Are you sure you want to checkout commit <b><i>' + abbrevCommit(hash) + '</i></b>? This will result in a \'detached HEAD\' state.', 'Always Accept', false, 'Yes, checkout', (alwaysAccept) => {

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

						name: 'Parent Hash',

						options: options,

						default: '1',

						info: 'Choose the parent hash on the main branch, to cherry pick the commit relative to.'

					});

				}

				inputs.push({

					type: DialogInputType.Checkbox,

					name: 'Record Origin',

					value: view.config.dialogDefaults.cherryPick.recordOrigin,

					info: 'Record that this commit was the origin of the cherry pick by appending a line to the original commit message that states "(cherry picked from commit ...​)".'

				}, {

					type: DialogInputType.Checkbox,

					name: 'No Commit',

					value: view.config.dialogDefaults.cherryPick.noCommit,

					info: 'Cherry picked changes will be staged but not committed, so that you can select and commit specific parts of this commit.'

				});



				dialog.showForm('Are you sure you want to cherry pick commit <b><i>' + abbrevCommit(hash) + '</i></b>?', inputs, 'Yes, cherry pick', (values) => {

					let parentIndex = isMerge ? parseInt(<string>values.shift()) : 0;

					runAction({

						command: 'cherrypickCommit',

						repo: view.currentRepo,

						commitHash: hash,

						parentIndex: parentIndex,

						recordOrigin: <boolean>values[0],

						noCommit: <boolean>values[1]

					}, 'Cherry picking Commit');

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

					dialog.showSelect('Are you sure you want to revert merge commit <b><i>' + abbrevCommit(hash) + '</i></b>? Choose the parent hash on the main branch, to revert the commit relative to:', '1', options, 'Yes, revert', (parentIndex) => {

						runAction({ command: 'revertCommit', repo: view.currentRepo, commitHash: hash, parentIndex: parseInt(parentIndex) }, 'Reverting Commit');

					}, target);

				} else {

					dialog.showConfirmation('Are you sure you want to revert commit <b><i>' + abbrevCommit(hash) + '</i></b>?', 'Yes, revert', () => {

						runAction({ command: 'revertCommit', repo: view.currentRepo, commitHash: hash, parentIndex: 0 }, 'Reverting Commit');

					}, target);

				}

			}

		}, {

			title: strings.menuResetLastCommitSoft + ELLIPSIS,

			visible: visibility.undo && hash === view.commitHead,

			onClick: () => {

				dialog.showConfirmation('Are you sure you want to reset the last commit? This will keep all changes from the commit as uncommitted changes.', 'Yes, reset the last commit', () => {

					runAction({ command: 'undoLastCommit', repo: view.currentRepo }, 'Resetting Last Commit');

				}, target);

			}

		}, {

			title: strings.menuEditMessage + ELLIPSIS,

			visible: visibility.editMessage,

			onClick: () => editCommitMessageAction(view, target)

		}, {



			title: strings.menuDrop + ELLIPSIS,

			visible: visibility.drop && view.graph.dropCommitPossible(view.commitLookup[hash]),

			onClick: () => {

				dialog.showConfirmation('Are you sure you want to permanently drop commit <b><i>' + abbrevCommit(hash) + '</i></b>?' + (view.onlyFollowFirstParent ? '<br/><i>Note: By enabling "Only follow the first parent of commits", some commits may have been hidden from the Git Graph View that could affect the outcome of performing this action.</i>' : ''), 'Yes, drop', () => {

					runAction({ command: 'dropCommit', repo: view.currentRepo, commitHash: hash }, 'Dropping Commit');

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

				dialog.showSelect('Are you sure you want to reset ' + (view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + ' to commit <b><i>' + abbrevCommit(hash) + '</i></b>?', view.config.dialogDefaults.resetCommit.mode, [

					{ name: 'Soft - Keep all changes, but reset head', value: GG.GitResetMode.Soft },

					{ name: 'Mixed - Keep working tree, but reset index', value: GG.GitResetMode.Mixed },

					{ name: 'Hard - Discard all changes', value: GG.GitResetMode.Hard }

				], 'Yes, reset', (mode) => {

					runAction({ command: 'resetToCommit', repo: view.currentRepo, commit: hash, resetMode: <GG.GitResetMode>mode }, 'Resetting to Commit');

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

				}, 'Opening External Directory Diff');

			}

		}

	], [

		{

			title: view.isCommitPinned(hash) ? 'Unpin Commit' : 'Pin Commit',

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

				dialog.showConfirmation('Are you sure you want to delete the remote branch <b><i>' + escapeHtml(refName) + '</i></b>?', 'Yes, delete', () => {

					runAction({ command: 'deleteRemoteBranch', repo: view.currentRepo, branchName: branchName, remote: remote }, 'Deleting Remote Branch');

				}, target);

			}

		}, {

			title: strings.menuFetchIntoLocalBranch + ELLIPSIS,

			visible: visibility.fetch && remote !== '' && view.gitBranches.includes(branchName) && view.gitBranchHead !== branchName,

			onClick: () => {

				dialog.showForm('Are you sure you want to fetch the remote branch <b><i>' + escapeHtml(refName) + '</i></b> into the local branch <b><i>' + escapeHtml(branchName) + '</i></b>?', [{

					type: DialogInputType.Checkbox,

					name: 'Force Fetch',

					value: view.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,

					info: 'Force the local branch to be reset to this remote branch.'

				}], 'Yes, fetch', (values) => {

					runAction({ command: 'fetchIntoLocalBranch', repo: view.currentRepo, remote: remote, remoteBranch: branchName, localBranch: branchName, force: <boolean>values[0] }, 'Fetching Branch');

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

				dialog.showForm('Are you sure you want to pull the remote branch <b><i>' + escapeHtml(refName) + '</i></b> into ' + (view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + '? If a merge is required:', [

					{ type: DialogInputType.Checkbox, name: 'Create a new commit even if fast-forward is possible', value: view.config.dialogDefaults.pullBranch.noFastForward },

					{ type: DialogInputType.Checkbox, name: 'Squash Commits', value: view.config.dialogDefaults.pullBranch.squash, info: 'Create a single commit on the current branch whose effect is the same as merging this remote branch.' }

				], 'Yes, pull', (values) => {

					runAction({ command: 'pullBranch', repo: view.currentRepo, branchName: branchName, remote: remote, createNewCommit: <boolean>values[0], squash: <boolean>values[1] }, 'Pulling Branch');

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

				}, 'Creating Pull Request');

			}

		}

	], [

		{

			title: strings.menuCreateArchive,

			visible: visibility.createArchive,

			onClick: () => {

				runAction({ command: 'createArchive', repo: view.currentRepo, ref: refName }, 'Creating Archive');

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

				sendMessage({ command: 'copyToClipboard', type: 'Branch Name', data: refName });

			}

		}

	], [

		{

			title: view.getPinnedBranches().includes(branchName) ? 'Unpin Branch' : 'Pin Branch',

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

				dialog.showForm('Are you sure you want to apply the stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b>?', [{

					type: DialogInputType.Checkbox,

					name: 'Reinstate Index',

					value: view.config.dialogDefaults.applyStash.reinstateIndex,

					info: 'Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.'

				}], 'Yes, apply stash', (values) => {

					runAction({ command: 'applyStash', repo: view.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, 'Applying Stash');

				}, target);

			}

		}, {

			title: strings.menuCreateBranchFromStash + ELLIPSIS,

			visible: visibility.createBranch,

			onClick: () => {

				dialog.showRefInput('Create a branch from stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b> with the name:', '', 'Create Branch', (branchName) => {

					runAction({ command: 'branchFromStash', repo: view.currentRepo, selector: selector, branchName: branchName }, 'Creating Branch');

				}, target);

			}

		}, {

			title: strings.menuPopStash + ELLIPSIS,

			visible: visibility.pop,

			onClick: () => {

				dialog.showForm('Are you sure you want to pop the stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b>?', [{

					type: DialogInputType.Checkbox,

					name: 'Reinstate Index',

					value: view.config.dialogDefaults.popStash.reinstateIndex,

					info: 'Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.'

				}], 'Yes, pop stash', (values) => {

					runAction({ command: 'popStash', repo: view.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, 'Popping Stash');

				}, target);

			}

		}, {

			title: strings.menuDropStash + ELLIPSIS,

			visible: visibility.drop,

			onClick: () => {

				dialog.showConfirmation('Are you sure you want to drop the stash <b><i>' + escapeHtml(selector.substring(5)) + '</i></b>?', 'Yes, drop', () => {

					runAction({ command: 'dropStash', repo: view.currentRepo, selector: selector }, 'Dropping Stash');

				}, target);

			}

		}

	], [

		{

			title: strings.menuCopyStashName,

			visible: visibility.copyName,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: 'Stash Name', data: selector });

			}

		}, {

			title: strings.menuCopyStashHash,

			visible: visibility.copyHash,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: 'Stash Hash', data: hash });

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

				runAction({ command: 'tagDetails', repo: view.currentRepo, tagName: tagName, commitHash: hash }, 'Retrieving Tag Details');

			}

		}, {

			title: strings.menuDeleteTag + ELLIPSIS,

			visible: visibility.delete,

			onClick: () => {

				let message = 'Are you sure you want to delete the tag <b><i>' + escapeHtml(tagName) + '</i></b>?';

				if (view.gitRemotes.length > 1) {

					let options = [{ name: 'Don\'t delete on any remote', value: '-1' }];

					view.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));

					dialog.showSelect(message + '<br>Do you also want to delete the tag on a remote:', '-1', options, 'Yes, delete', remoteIndex => {

						deleteTagAction(view, tagName, remoteIndex !== '-1' ? view.gitRemotes[parseInt(remoteIndex)] : null);

					}, target);

				} else if (view.gitRemotes.length === 1) {

					dialog.showCheckbox(message, 'Also delete on remote', false, 'Yes, delete', deleteOnRemote => {

						deleteTagAction(view, tagName, deleteOnRemote ? view.gitRemotes[0] : null);

					}, target);

				} else {

					dialog.showConfirmation(message, 'Yes, delete', () => {

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

					}, 'Pushing Tag');

				};



				if (view.gitRemotes.length === 1) {

					dialog.showConfirmation('Are you sure you want to push the tag <b><i>' + escapeHtml(tagName) + '</i></b> to the remote <b><i>' + escapeHtml(view.gitRemotes[0]) + '</i></b>?', 'Yes, push', () => {

						runPushTagAction([view.gitRemotes[0]]);

					}, target);

				} else if (view.gitRemotes.length > 1) {

					const defaults = [view.getPushRemote()];

					const options = view.gitRemotes.map((remote) => ({ name: remote, value: remote }));

					dialog.showMultiSelect('Are you sure you want to push the tag <b><i>' + escapeHtml(tagName) + '</i></b>? Select the remote(s) to push the tag to:', defaults, options, 'Yes, push', (remotes) => {

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

				runAction({ command: 'createArchive', repo: view.currentRepo, ref: tagName }, 'Creating Archive');

			}

		},

		{

			title: strings.menuCopyTagName,

			visible: visibility.copyName,

			onClick: () => {

				sendMessage({ command: 'copyToClipboard', type: 'Tag Name', data: tagName });

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

				dialog.showForm('Are you sure you want to stash the <b>uncommitted changes</b>?', [

					{ type: DialogInputType.Text, name: 'Message', default: '', placeholder: 'Optional' },

					{ type: DialogInputType.Checkbox, name: 'Include Untracked', value: view.config.dialogDefaults.stashUncommittedChanges.includeUntracked, info: 'Include all untracked files in the stash, and then clean them from the working directory.' }

				], 'Yes, stash', (values) => {

					runAction({ command: 'pushStash', repo: view.currentRepo, message: <string>values[0], includeUntracked: <boolean>values[1] }, 'Stashing uncommitted changes');

				}, target);

			}

		}

	], [

		{

			title: strings.menuResetUncommitted + ELLIPSIS,

			visible: visibility.reset,

			onClick: () => {

				dialog.showSelect('Are you sure you want to reset the <b>uncommitted changes</b> to <b>HEAD</b>?', view.config.dialogDefaults.resetUncommitted.mode, [

					{ name: 'Mixed - Keep working tree, but reset index', value: GG.GitResetMode.Mixed },

					{ name: 'Hard - Discard all changes', value: GG.GitResetMode.Hard }

				], 'Yes, reset', (mode) => {

					runAction({ command: 'resetToCommit', repo: view.currentRepo, commit: 'HEAD', resetMode: <GG.GitResetMode>mode }, 'Resetting uncommitted changes');

				}, target);

			}

		}, {

			title: strings.menuCleanUntracked + ELLIPSIS,

			visible: visibility.clean,

			onClick: () => {

				dialog.showCheckbox('Are you sure you want to clean all untracked files?', 'Clean untracked directories', true, 'Yes, clean', directories => {

					runAction({ command: 'cleanUntrackedFiles', repo: view.currentRepo, directories: directories }, 'Cleaning untracked files');

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

				dialog.showSelect('Select which issue you want to view for this branch:', '0', issueLinks.map((issueLink, i) => ({ name: issueLink.displayText, value: i.toString() })), 'View Issue', (value) => {

					sendMessage({ command: 'openExternalUrl', url: issueLinks[parseInt(value)].url });

				}, target);

			} else if (issueLinks.length === 1) {

				sendMessage({ command: 'openExternalUrl', url: issueLinks[0].url });

			}

		}

	};

}


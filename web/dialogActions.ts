/* Dialog Actions (tag, branch checkout/creation, merge, rebase, edit message) */

function getMergeActionOnName(actionOn: GG.MergeActionOn): string {
	return actionOn === GG.MergeActionOn.Branch
		? strings.actionOnBranch
		: actionOn === GG.MergeActionOn.RemoteTrackingBranch
			? strings.actionOnRemoteTrackingBranch
			: strings.actionOnCommit;
}

function getRebaseActionOnName(actionOn: GG.RebaseActionOn): string {
	return actionOn === GG.RebaseActionOn.Branch ? strings.actionOnBranch : strings.actionOnCommit;
}

function addTagAction(view: GitGraphView, hash: string, initialName: string, initialType: GG.TagType, initialMessage: string, initialPushToRemote: string | null, target: DialogTarget & CommitTarget, isInitialLoad: boolean = true) {

	let mostRecentTagsIndex = -1;

	for (let i = 0; i < view.commits.length; i++) {

		if (view.commits[i].tags.length > 0 && (mostRecentTagsIndex === -1 || view.commits[i].date > view.commits[mostRecentTagsIndex].date)) {

			mostRecentTagsIndex = i;

		}

	}

	const mostRecentTagsRaw = mostRecentTagsIndex > -1 ? view.commits[mostRecentTagsIndex].tags.map((tag: GG.GitCommitTag) => {

		let parts = tag.name.split('/');

		return parts.length > 1 ? parts.slice(1).join('/') : parts[0];

	}) : [];

	const mostRecentTags = mostRecentTagsRaw.map((tag) => '"' + tag + '"');

	if (initialName === '' && mostRecentTagsRaw.length > 0) {

		const match = mostRecentTagsRaw[0].match(/^(.*?)(\d+)$/);

		if (match) {

			initialName = match[1] + (parseInt(match[2]) + 1);

		}

	}



	const inputs: DialogInput[] = [

		{ type: DialogInputType.TextRef, name: strings.inputNameLabel, default: initialName, info: mostRecentTags.length > 0 ? formatStr(mostRecentTags.length > 1 ? strings.tagNameInfoMultiple : strings.tagNameInfoSingle, formatCommaSeparatedList(mostRecentTags)) : undefined },

		{ type: DialogInputType.Select, name: strings.tagTypeInput, default: initialType === GG.TagType.Annotated ? 'annotated' : 'lightweight', options: [{ name: strings.tagTypeAnnotated, value: 'annotated' }, { name: strings.tagTypeLightweight, value: 'lightweight' }] },

		{ type: DialogInputType.Text, name: strings.messageInput, default: initialMessage, placeholder: strings.optionalPlaceholder, info: strings.tagMessageInfo }

	];

	if (view.gitRemotes.length > 1) {

		const options = [{ name: strings.dontPushOption, value: '-1' }];

		view.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));

		const defaultOption = initialPushToRemote !== null

			? view.gitRemotes.indexOf(initialPushToRemote)

			: isInitialLoad

				? view.gitRemotes.indexOf(view.getPushRemote())

				: -1;

		inputs.push({ type: DialogInputType.Select, name: strings.pushToRemoteInput, options: options, default: defaultOption.toString(), info: strings.pushToRemoteInfo });

	} else if (view.gitRemotes.length === 1) {

		const defaultValue = initialPushToRemote !== null || isInitialLoad;

		inputs.push({ type: DialogInputType.Checkbox, name: strings.pushToRemoteInput, value: defaultValue, info: strings.pushToRemoteRepoInfo });

	}



	dialog.showForm(formatStr(strings.addTagToCommit, abbrevCommit(hash)), inputs, strings.actionAddTag, (values) => {

		const tagName = <string>values[0];

		const type = <string>values[1] === 'annotated' ? GG.TagType.Annotated : GG.TagType.Lightweight;

		const message = <string>values[2];

		const pushToRemote = view.gitRemotes.length > 1 && <string>values[3] !== '-1'

			? view.gitRemotes[parseInt(<string>values[3])]

			: view.gitRemotes.length === 1 && <boolean>values[3]

				? view.gitRemotes[0]

				: null;



		const runAddTagAction = (force: boolean) => {

			runAction({

				command: 'addTag',

				repo: view.currentRepo,

				tagName: tagName,

				commitHash: hash,

				type: type,

				message: message,

				pushToRemote: pushToRemote,

				pushSkipRemoteCheck: globalState.pushTagSkipRemoteCheck,

				force: force

			}, strings.addingTag);

		};



		if (view.gitTags.includes(tagName)) {

			dialog.showTwoButtons(formatStr(strings.tagExistsReplace, escapeHtml(tagName)), strings.yesReplaceTag, () => {

				runAddTagAction(true);

			}, strings.noOtherTagName, () => {

				addTagAction(view, hash, tagName, type, message, pushToRemote, target, false);

			}, target);

		} else {

			runAddTagAction(false);

		}

	}, target);

}


function checkoutBranchAction(view: GitGraphView, refName: string, remote: string | null, prefillName: string | null, target: DialogTarget & (CommitTarget | RefTarget)) {

	if (remote !== null) {

		dialog.showRefInput(formatStr(strings.checkoutNewBranchPrompt, escapeHtml(refName)), (prefillName !== null ? prefillName : (remote !== '' ? refName.substring(remote.length + 1) : refName)), strings.actionCheckoutBranch, newBranch => {

			if (view.gitBranches.includes(newBranch)) {

				const canPullFromRemote = remote !== '';

				dialog.showTwoButtons(formatStr(strings.branchNameInUse, escapeHtml(newBranch)), strings.chooseAnotherBranchName, () => {

					checkoutBranchAction(view, refName, remote, newBranch, target);

				}, canPullFromRemote ? strings.checkoutExistingBranchAndPull : strings.checkoutExistingBranch, () => {

					runAction({

						command: 'checkoutBranch',

						repo: view.currentRepo,

						branchName: newBranch,

						remoteBranch: null,

						pullAfterwards: canPullFromRemote

							? {

								branchName: refName.substring(remote.length + 1),

								remote: remote,

								createNewCommit: view.config.dialogDefaults.pullBranch.noFastForward,

								squash: view.config.dialogDefaults.pullBranch.squash

							}

							: null

					}, canPullFromRemote ? strings.checkingOutBranchAndPulling : strings.checkingOutBranch);

				}, target);

			} else {

				runAction({ command: 'checkoutBranch', repo: view.currentRepo, branchName: newBranch, remoteBranch: refName, pullAfterwards: null }, strings.checkingOutBranch);

			}

		}, target);

	} else {

		runAction({ command: 'checkoutBranch', repo: view.currentRepo, branchName: refName, remoteBranch: null, pullAfterwards: null }, strings.checkingOutBranch);

	}

}


function createBranchAction(view: GitGraphView, hash: string, initialName: string, initialCheckOut: boolean, target: DialogTarget & CommitTarget) {

	dialog.showForm(formatStr(strings.createBranchAtCommit, abbrevCommit(hash)), [

		{ type: DialogInputType.TextRef, name: strings.inputNameLabel, default: initialName },

		{ type: DialogInputType.Checkbox, name: strings.checkOutCheckbox, value: initialCheckOut }

	], strings.actionCreateBranch, (values) => {

		const branchName = <string>values[0], checkOut = <boolean>values[1];

		if (view.gitBranches.includes(branchName)) {

			dialog.showTwoButtons(formatStr(strings.branchExistsReplace, escapeHtml(branchName)), strings.yesReplaceBranch, () => {

				runAction({ command: 'createBranch', repo: view.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: true }, strings.creatingBranch);

			}, strings.noOtherBranchName, () => {

				createBranchAction(view, hash, branchName, checkOut, target);

			}, target);

		} else {

			runAction({ command: 'createBranch', repo: view.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: false }, strings.creatingBranch);

		}

	}, target);

}


function deleteTagAction(view: GitGraphView, refName: string, deleteOnRemote: string | null) {

	runAction({ command: 'deleteTag', repo: view.currentRepo, tagName: refName, deleteOnRemote: deleteOnRemote }, strings.deletingTag);

}


function fetchFromRemotesAction(view: GitGraphView) {

	runAction({ command: 'fetch', repo: view.currentRepo, name: null, prune: view.config.fetchAndPrune, pruneTags: view.config.fetchAndPruneTags }, strings.fetchingFromRemotes);

}


function mergeAction(view: GitGraphView, obj: string, name: string, actionOn: GG.MergeActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {

	const actionOnName = getMergeActionOnName(actionOn);

	dialog.showForm(formatStr(strings.mergeConfirm, actionOnName, escapeHtml(name), view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b>' + strings.currentBranchSuffix : strings.currentBranchPlain), [

		{ type: DialogInputType.Checkbox, name: strings.noFastForwardCheckbox, value: view.config.dialogDefaults.merge.noFastForward },

		{ type: DialogInputType.Checkbox, name: strings.squashCommitsCheckbox, value: view.config.dialogDefaults.merge.squash, info: formatStr(strings.squashMergeInfo, actionOnName) },

		{ type: DialogInputType.Checkbox, name: strings.noCommitCheckbox, value: view.config.dialogDefaults.merge.noCommit, info: strings.noCommitMergeInfo }

	], strings.yesMerge, (values) => {

		runAction({ command: 'merge', repo: view.currentRepo, obj: obj, actionOn: actionOn, createNewCommit: <boolean>values[0], squash: <boolean>values[1], noCommit: <boolean>values[2] }, formatStr(strings.mergingActionOn, actionOnName));

	}, target);

}


function rebaseAction(view: GitGraphView, obj: string, name: string, actionOn: GG.RebaseActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {

	dialog.showForm(formatStr(strings.rebaseConfirm, view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b>' + strings.currentBranchSuffix : strings.currentBranchPlain, getRebaseActionOnName(actionOn), escapeHtml(name)), [

		{ type: DialogInputType.Checkbox, name: strings.interactiveRebaseCheckbox, value: view.config.dialogDefaults.rebase.interactive },

		{ type: DialogInputType.Checkbox, name: strings.ignoreDateCheckbox, value: view.config.dialogDefaults.rebase.ignoreDate, info: strings.ignoreDateInfo }

	], strings.yesRebase, (values) => {

		let interactive = <boolean>values[0];

		runAction({ command: 'rebase', repo: view.currentRepo, obj: obj, actionOn: actionOn, ignoreDate: <boolean>values[1], interactive: interactive }, interactive ? strings.launchingInteractiveRebase : formatStr(strings.rebasingOnActionOn, getRebaseActionOnName(actionOn)));

	}, target);

}


function editCommitMessageAction(view: GitGraphView, target: DialogTarget & CommitTarget) {

	const hash = target.hash;

	const commit = view.commits[view.commitLookup[hash]];

	if (commit === undefined) return; // The commit is no longer loaded (e.g. after a refresh)



	dialog.showForm(

		formatStr(strings.editCommitMessagePrompt, abbrevCommit(hash)),

		[{

			type: DialogInputType.Textarea, lines: 5,

			name: strings.commitMessageInput,

			default: commit.message,

			placeholder: strings.commitMessagePlaceholder

		}],

		strings.updateMessageAction,

		(values) => {

			const newMessage = <string>values[0];

			if (newMessage.trim() === '') {

				dialog.showError(strings.commitMessageEmptyError, null, null, null);

				return;

			}

			if (newMessage === commit.message) {

				return; // No change needed

			}

			runAction({

				command: 'editCommitMessage',

				repo: view.currentRepo,

				commitHash: hash,

				message: newMessage

			}, strings.editingCommitMessage);

		},

		target

	);

}

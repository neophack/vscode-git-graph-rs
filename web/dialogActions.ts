/* Dialog Actions (tag, branch checkout/creation, merge, rebase, edit message) */

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

		{ type: DialogInputType.TextRef, name: 'Name', default: initialName, info: mostRecentTags.length > 0 ? 'The most recent tag' + (mostRecentTags.length > 1 ? 's' : '') + ' in the loaded commits ' + (mostRecentTags.length > 1 ? 'are' : 'is') + ' ' + formatCommaSeparatedList(mostRecentTags) + '.' : undefined },

		{ type: DialogInputType.Select, name: 'Type', default: initialType === GG.TagType.Annotated ? 'annotated' : 'lightweight', options: [{ name: 'Annotated', value: 'annotated' }, { name: 'Lightweight', value: 'lightweight' }] },

		{ type: DialogInputType.Text, name: 'Message', default: initialMessage, placeholder: 'Optional', info: 'A message can only be added to an annotated tag.' }

	];

	if (view.gitRemotes.length > 1) {

		const options = [{ name: 'Don\'t push', value: '-1' }];

		view.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));

		const defaultOption = initialPushToRemote !== null

			? view.gitRemotes.indexOf(initialPushToRemote)

			: isInitialLoad

				? view.gitRemotes.indexOf(view.getPushRemote())

				: -1;

		inputs.push({ type: DialogInputType.Select, name: 'Push to remote', options: options, default: defaultOption.toString(), info: 'Once this tag has been added, push it to this remote.' });

	} else if (view.gitRemotes.length === 1) {

		const defaultValue = initialPushToRemote !== null || isInitialLoad;

		inputs.push({ type: DialogInputType.Checkbox, name: 'Push to remote', value: defaultValue, info: 'Once this tag has been added, push it to the repositories remote.' });

	}



	dialog.showForm('Add tag to commit <b><i>' + abbrevCommit(hash) + '</i></b>:', inputs, 'Add Tag', (values) => {

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

			}, 'Adding Tag');

		};



		if (view.gitTags.includes(tagName)) {

			dialog.showTwoButtons('A tag named <b><i>' + escapeHtml(tagName) + '</i></b> already exists, do you want to replace it with this new tag?', 'Yes, replace the existing tag', () => {

				runAddTagAction(true);

			}, 'No, choose another tag name', () => {

				addTagAction(view, hash, tagName, type, message, pushToRemote, target, false);

			}, target);

		} else {

			runAddTagAction(false);

		}

	}, target);

}


function checkoutBranchAction(view: GitGraphView, refName: string, remote: string | null, prefillName: string | null, target: DialogTarget & (CommitTarget | RefTarget)) {

	if (remote !== null) {

		dialog.showRefInput('Enter the name of the new branch you would like to create when checking out <b><i>' + escapeHtml(refName) + '</i></b>:', (prefillName !== null ? prefillName : (remote !== '' ? refName.substring(remote.length + 1) : refName)), 'Checkout Branch', newBranch => {

			if (view.gitBranches.includes(newBranch)) {

				const canPullFromRemote = remote !== '';

				dialog.showTwoButtons('The name <b><i>' + escapeHtml(newBranch) + '</i></b> is already used by another branch:', 'Choose another branch name', () => {

					checkoutBranchAction(view, refName, remote, newBranch, target);

				}, 'Checkout the existing branch' + (canPullFromRemote ? ' & pull changes' : ''), () => {

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

					}, 'Checking out Branch' + (canPullFromRemote ? ' & Pulling Changes' : ''));

				}, target);

			} else {

				runAction({ command: 'checkoutBranch', repo: view.currentRepo, branchName: newBranch, remoteBranch: refName, pullAfterwards: null }, 'Checking out Branch');

			}

		}, target);

	} else {

		runAction({ command: 'checkoutBranch', repo: view.currentRepo, branchName: refName, remoteBranch: null, pullAfterwards: null }, 'Checking out Branch');

	}

}


function createBranchAction(view: GitGraphView, hash: string, initialName: string, initialCheckOut: boolean, target: DialogTarget & CommitTarget) {

	dialog.showForm('Create branch at commit <b><i>' + abbrevCommit(hash) + '</i></b>:', [

		{ type: DialogInputType.TextRef, name: 'Name', default: initialName },

		{ type: DialogInputType.Checkbox, name: 'Check out', value: initialCheckOut }

	], 'Create Branch', (values) => {

		const branchName = <string>values[0], checkOut = <boolean>values[1];

		if (view.gitBranches.includes(branchName)) {

			dialog.showTwoButtons('A branch named <b><i>' + escapeHtml(branchName) + '</i></b> already exists, do you want to replace it with this new branch?', 'Yes, replace the existing branch', () => {

				runAction({ command: 'createBranch', repo: view.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: true }, 'Creating Branch');

			}, 'No, choose another branch name', () => {

				createBranchAction(view, hash, branchName, checkOut, target);

			}, target);

		} else {

			runAction({ command: 'createBranch', repo: view.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: false }, 'Creating Branch');

		}

	}, target);

}


function deleteTagAction(view: GitGraphView, refName: string, deleteOnRemote: string | null) {

	runAction({ command: 'deleteTag', repo: view.currentRepo, tagName: refName, deleteOnRemote: deleteOnRemote }, 'Deleting Tag');

}


function fetchFromRemotesAction(view: GitGraphView) {

	runAction({ command: 'fetch', repo: view.currentRepo, name: null, prune: view.config.fetchAndPrune, pruneTags: view.config.fetchAndPruneTags }, 'Fetching from Remote(s)');

}


function mergeAction(view: GitGraphView, obj: string, name: string, actionOn: GG.MergeActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {

	dialog.showForm('Are you sure you want to merge ' + actionOn.toLowerCase() + ' <b><i>' + escapeHtml(name) + '</i></b> into ' + (view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + '?', [

		{ type: DialogInputType.Checkbox, name: 'Create a new commit even if fast-forward is possible', value: view.config.dialogDefaults.merge.noFastForward },

		{ type: DialogInputType.Checkbox, name: 'Squash Commits', value: view.config.dialogDefaults.merge.squash, info: 'Create a single commit on the current branch whose effect is the same as merging this ' + actionOn.toLowerCase() + '.' },

		{ type: DialogInputType.Checkbox, name: 'No Commit', value: view.config.dialogDefaults.merge.noCommit, info: 'The changes of the merge will be staged but not committed, so that you can review and/or modify the merge result before committing.' }

	], 'Yes, merge', (values) => {

		runAction({ command: 'merge', repo: view.currentRepo, obj: obj, actionOn: actionOn, createNewCommit: <boolean>values[0], squash: <boolean>values[1], noCommit: <boolean>values[2] }, 'Merging ' + actionOn);

	}, target);

}


function rebaseAction(view: GitGraphView, obj: string, name: string, actionOn: GG.RebaseActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {

	dialog.showForm('Are you sure you want to rebase ' + (view.gitBranchHead !== null ? '<b><i>' + escapeHtml(view.gitBranchHead) + '</i></b> (the current branch)' : 'the current branch') + ' on ' + actionOn.toLowerCase() + ' <b><i>' + escapeHtml(name) + '</i></b>?', [

		{ type: DialogInputType.Checkbox, name: 'Launch Interactive Rebase in new Terminal', value: view.config.dialogDefaults.rebase.interactive },

		{ type: DialogInputType.Checkbox, name: 'Ignore Date', value: view.config.dialogDefaults.rebase.ignoreDate, info: 'Only applicable to a non-interactive rebase.' }

	], 'Yes, rebase', (values) => {

		let interactive = <boolean>values[0];

		runAction({ command: 'rebase', repo: view.currentRepo, obj: obj, actionOn: actionOn, ignoreDate: <boolean>values[1], interactive: interactive }, interactive ? 'Launching Interactive Rebase' : 'Rebasing on ' + actionOn);

	}, target);

}


function editCommitMessageAction(view: GitGraphView, target: DialogTarget & CommitTarget) {

	const hash = target.hash;

	const commit = view.commits[view.commitLookup[hash]];

	if (commit === undefined) return; // The commit is no longer loaded (e.g. after a refresh)



	dialog.showForm(

		`Edit commit message for <b><i>${abbrevCommit(hash)}</i></b>:`,

		[{

			type: DialogInputType.Textarea, lines: 5,

			name: 'Commit Message',

			default: commit.message,

			placeholder: 'Enter the new commit message'

		}],

		'Update Message',

		(values) => {

			const newMessage = <string>values[0];

			if (newMessage.trim() === '') {

				dialog.showError('Commit message cannot be empty.', null, null, null);

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

			}, 'Editing Commit Message');

		},

		target

	);

}


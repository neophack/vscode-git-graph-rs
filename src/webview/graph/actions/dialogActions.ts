/* Dialog actions: the actions that ask the user for their parameters in a dialog (tags, branch
   checkout / creation, merge, rebase, edit commit message, ...). */

import { html, SafeHtml } from '../../common/html';
import { formatStr, markup, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { abbrevCommit, formatCommaSeparatedList } from '../../common/util';
import { GraphContext } from '../context';
import { CommitTarget, RefTarget } from '../state/types';
import { DialogInput, DialogInputType } from '../widgets/dialog';

export function getMergeActionOnName(actionOn: GG.MergeActionOn): string {
	return actionOn === GG.MergeActionOn.Branch
		? strings.actionOnBranch
		: actionOn === GG.MergeActionOn.RemoteTrackingBranch
			? strings.actionOnRemoteTrackingBranch
			: strings.actionOnCommit;
}

export function getRebaseActionOnName(actionOn: GG.RebaseActionOn): string {
	return actionOn === GG.RebaseActionOn.Branch ? strings.actionOnBranch : strings.actionOnCommit;
}

/** The checked-out branch as the merge / rebase / reset dialogs name it. */
export function currentBranchHtml(gitBranchHead: string | null): SafeHtml | string {
	return gitBranchHead !== null ? html`<b><i>${gitBranchHead}</i></b>${strings.currentBranchSuffix}` : strings.currentBranchPlain;
}

/**
 * Fire a conflict-prediction probe (a single `git merge-tree`, no working-tree side effects) for
 * a merge/rebase dialog that is about to be shown. The dialog opens immediately without waiting
 * for this - it is advisory, not blocking - and the result (if it still applies once it arrives,
 * see the `predictConflicts` response) is patched into the `#predictedConflicts` placeholder
 * already present in the dialog's message.
 */
function requestConflictPrediction(ctx: GraphContext, ours: string, theirs: string) {
	ctx.bridge.send({ command: 'predictConflicts', repo: ctx.store.currentRepo, ours: ours, theirs: theirs });
}

/**
 * A hidden placeholder, patched in place once the conflict prediction for this dialog arrives.
 * `ours`/`theirs` are stashed as data attributes so a response that arrives after the user has
 * already closed this dialog and opened a different one (for a different ref pair) is recognised
 * as stale and ignored, rather than patching conflict data onto the wrong dialog.
 */
function predictedConflictsPlaceholder(ours: string, theirs: string): SafeHtml {
	return html`<div id="predictedConflicts" data-ours="${ours}" data-theirs="${theirs}" style="display:none"></div>`;
}

export function addTagAction(ctx: GraphContext, hash: string, initialName: string, initialType: GG.TagType, initialMessage: string, initialPushToRemote: string | null, target: CommitTarget, isInitialLoad: boolean = true) {
	const store = ctx.store;
	let mostRecentTagsIndex = -1;
	for (let i = 0; i < store.commits.length; i++) {
		if (store.commits[i].tags.length > 0 && (mostRecentTagsIndex === -1 || store.commits[i].date > store.commits[mostRecentTagsIndex].date)) {
			mostRecentTagsIndex = i;
		}
	}
	const mostRecentTagsRaw = mostRecentTagsIndex > -1 ? store.commits[mostRecentTagsIndex].tags.map((tag: GG.GitCommitTag) => {
		const parts = tag.name.split('/');
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

	if (store.gitRemotes.length > 1) {
		const options = [{ name: strings.dontPushOption, value: '-1' }];
		store.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
		const defaultOption = initialPushToRemote !== null
			? store.gitRemotes.indexOf(initialPushToRemote)
			: isInitialLoad
				? store.gitRemotes.indexOf(store.getPushRemote())
				: -1;
		inputs.push({ type: DialogInputType.Select, name: strings.pushToRemoteInput, options: options, default: defaultOption.toString(), info: strings.pushToRemoteInfo });
	} else if (store.gitRemotes.length === 1) {
		const defaultValue = initialPushToRemote !== null || isInitialLoad;
		inputs.push({ type: DialogInputType.Checkbox, name: strings.pushToRemoteInput, value: defaultValue, info: strings.pushToRemoteRepoInfo });
	}

	ctx.dialog.showForm(formatStr(markup.addTagToCommit, abbrevCommit(hash)), inputs, strings.actionAddTag, (values) => {
		const tagName = <string>values[0];
		const type = <string>values[1] === 'annotated' ? GG.TagType.Annotated : GG.TagType.Lightweight;
		const message = <string>values[2];
		const pushToRemote = store.gitRemotes.length > 1 && <string>values[3] !== '-1'
			? store.gitRemotes[parseInt(<string>values[3])]
			: store.gitRemotes.length === 1 && <boolean>values[3]
				? store.gitRemotes[0]
				: null;

		const runAddTagAction = (force: boolean) => {
			ctx.actions.run({
				command: 'addTag',
				repo: store.currentRepo,
				tagName: tagName,
				commitHash: hash,
				type: type,
				message: message,
				pushToRemote: pushToRemote,
				pushSkipRemoteCheck: store.globalViewState.pushTagSkipRemoteCheck,
				force: force
			}, strings.addingTag);
		};

		if (store.gitTags.includes(tagName)) {
			ctx.dialog.showTwoButtons(formatStr(markup.tagExistsReplace, tagName), strings.yesReplaceTag, () => {
				runAddTagAction(true);
			}, strings.noOtherTagName, () => {
				addTagAction(ctx, hash, tagName, type, message, pushToRemote, target, false);
			}, target);
		} else {
			runAddTagAction(false);
		}
	}, target);
}

export function checkoutBranchAction(ctx: GraphContext, refName: string, remote: string | null, prefillName: string | null, target: CommitTarget | RefTarget) {
	const store = ctx.store;
	if (remote !== null) {
		ctx.dialog.showRefInput(formatStr(markup.checkoutNewBranchPrompt, refName), (prefillName !== null ? prefillName : (remote !== '' ? refName.substring(remote.length + 1) : refName)), strings.actionCheckoutBranch, (newBranch) => {
			if (store.gitBranches.includes(newBranch)) {
				const canPullFromRemote = remote !== '';
				ctx.dialog.showTwoButtons(formatStr(markup.branchNameInUse, newBranch), strings.chooseAnotherBranchName, () => {
					checkoutBranchAction(ctx, refName, remote, newBranch, target);
				}, canPullFromRemote ? strings.checkoutExistingBranchAndPull : strings.checkoutExistingBranch, () => {
					ctx.actions.run({
						command: 'checkoutBranch',
						repo: store.currentRepo,
						branchName: newBranch,
						remoteBranch: null,
						pullAfterwards: canPullFromRemote
							? {
								branchName: refName.substring(remote.length + 1),
								remote: remote,
								createNewCommit: store.config.dialogDefaults.pullBranch.noFastForward,
								squash: store.config.dialogDefaults.pullBranch.squash
							}
							: null
					}, canPullFromRemote ? strings.checkingOutBranchAndPulling : strings.checkingOutBranch);
				}, target);
			} else {
				ctx.actions.run({ command: 'checkoutBranch', repo: store.currentRepo, branchName: newBranch, remoteBranch: refName, pullAfterwards: null }, strings.checkingOutBranch);
			}
		}, target);
	} else {
		ctx.actions.run({ command: 'checkoutBranch', repo: store.currentRepo, branchName: refName, remoteBranch: null, pullAfterwards: null }, strings.checkingOutBranch);
	}
}

export function createBranchAction(ctx: GraphContext, hash: string, initialName: string, initialCheckOut: boolean, target: CommitTarget) {
	const store = ctx.store;
	ctx.dialog.showForm(formatStr(markup.createBranchAtCommit, abbrevCommit(hash)), [
		{ type: DialogInputType.TextRef, name: strings.inputNameLabel, default: initialName },
		{ type: DialogInputType.Checkbox, name: strings.checkOutCheckbox, value: initialCheckOut }
	], strings.actionCreateBranch, (values) => {
		const branchName = <string>values[0], checkOut = <boolean>values[1];
		if (store.gitBranches.includes(branchName)) {
			ctx.dialog.showTwoButtons(formatStr(markup.branchExistsReplace, branchName), strings.yesReplaceBranch, () => {
				ctx.actions.run({ command: 'createBranch', repo: store.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: true }, strings.creatingBranch);
			}, strings.noOtherBranchName, () => {
				createBranchAction(ctx, hash, branchName, checkOut, target);
			}, target);
		} else {
			ctx.actions.run({ command: 'createBranch', repo: store.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: false }, strings.creatingBranch);
		}
	}, target);
}

export function deleteTagAction(ctx: GraphContext, refName: string, deleteOnRemote: string | null) {
	ctx.actions.run({ command: 'deleteTag', repo: ctx.store.currentRepo, tagName: refName, deleteOnRemote: deleteOnRemote }, strings.deletingTag);
}

export function fetchFromRemotesAction(ctx: GraphContext) {
	const config = ctx.store.config;
	ctx.actions.run({ command: 'fetch', repo: ctx.store.currentRepo, name: null, prune: config.fetchAndPrune, pruneTags: config.fetchAndPruneTags }, strings.fetchingFromRemotes);
}

export function mergeAction(ctx: GraphContext, obj: string, name: string, actionOn: GG.MergeActionOn, target: CommitTarget | RefTarget) {
	const store = ctx.store, defaults = store.config.dialogDefaults;
	const actionOnName = getMergeActionOnName(actionOn);
	requestConflictPrediction(ctx, 'HEAD', obj);
	ctx.dialog.showForm(html`${formatStr(markup.mergeConfirm, actionOnName, name, currentBranchHtml(store.gitBranchHead))}${predictedConflictsPlaceholder('HEAD', obj)}`, [
		{ type: DialogInputType.Checkbox, name: strings.noFastForwardCheckbox, value: defaults.merge.noFastForward },
		{ type: DialogInputType.Checkbox, name: strings.squashCommitsCheckbox, value: defaults.merge.squash, info: formatStr(strings.squashMergeInfo, actionOnName) },
		{ type: DialogInputType.Checkbox, name: strings.noCommitCheckbox, value: defaults.merge.noCommit, info: strings.noCommitMergeInfo }
	], strings.yesMerge, (values) => {
		ctx.actions.run({ command: 'merge', repo: store.currentRepo, obj: obj, actionOn: actionOn, createNewCommit: <boolean>values[0], squash: <boolean>values[1], noCommit: <boolean>values[2] }, formatStr(strings.mergingActionOn, actionOnName));
	}, target);
}

export function rebaseAction(ctx: GraphContext, obj: string, name: string, actionOn: GG.RebaseActionOn, target: CommitTarget | RefTarget) {
	const store = ctx.store, defaults = store.config.dialogDefaults;
	requestConflictPrediction(ctx, 'HEAD', obj);
	ctx.dialog.showForm(html`${formatStr(markup.rebaseConfirm, currentBranchHtml(store.gitBranchHead), getRebaseActionOnName(actionOn), name)}${predictedConflictsPlaceholder('HEAD', obj)}`, [
		{ type: DialogInputType.Checkbox, name: strings.interactiveRebaseCheckbox, value: defaults.rebase.interactive },
		{ type: DialogInputType.Checkbox, name: strings.ignoreDateCheckbox, value: defaults.rebase.ignoreDate, info: strings.ignoreDateInfo },
		{ type: DialogInputType.Checkbox, name: strings.autosquashRebaseCheckbox, value: defaults.rebase.autosquash, info: strings.autosquashRebaseInfo }
	], strings.yesRebase, (values) => {
		const interactive = <boolean>values[0];
		ctx.actions.run({ command: 'rebase', repo: store.currentRepo, obj: obj, actionOn: actionOn, ignoreDate: <boolean>values[1], interactive: interactive, autosquash: <boolean>values[2] }, interactive ? strings.launchingInteractiveRebase : formatStr(strings.rebasingOnActionOn, getRebaseActionOnName(actionOn)));
	}, target);
}

export function editCommitMessageAction(ctx: GraphContext, target: CommitTarget) {
	const store = ctx.store, hash = target.hash;

	const showEditDialog = (message: string) => {
		const commit = store.getCommit(hash);
		if (commit === undefined) return; // The commit is no longer loaded (e.g. after a refresh)

		ctx.dialog.showForm(
			formatStr(markup.editCommitMessagePrompt, abbrevCommit(hash)),
			[{
				type: DialogInputType.Textarea, lines: 5,
				name: strings.commitMessageInput,
				default: message,
				placeholder: strings.commitMessagePlaceholder
			}, {
				type: DialogInputType.Text,
				name: strings.commitAuthorNameInput,
				default: commit.author,
				placeholder: null
			}, {
				type: DialogInputType.Text,
				name: strings.commitAuthorEmailInput,
				default: commit.email,
				placeholder: null
			}],
			strings.updateMessageAction,
			(values) => {
				const newMessage = <string>values[0];
				if (newMessage.trim() === '') {
					ctx.dialog.showError(strings.commitMessageEmptyError, null, null, null);
					return;
				}
				const newAuthorName = <string>values[1], newAuthorEmail = <string>values[2];
				if (newAuthorName.trim() === '') {
					ctx.dialog.showError(strings.commitAuthorEmptyError, null, null, null);
					return;
				}
				if (newMessage === message && newAuthorName === commit.author && newAuthorEmail === commit.email) {
					return; // No change needed
				}
				ctx.actions.run({
					command: 'editCommitMessage',
					repo: store.currentRepo,
					commitHash: hash,
					message: newMessage,
					// An unchanged author must be omitted from the request entirely: sending the
					// prefilled values would make the host take the `exec git commit --amend`
					// path (running pre-commit hooks) for what is really a plain reword.
					...(newAuthorName === commit.author && newAuthorEmail === commit.email ? {} : { authorName: newAuthorName, authorEmail: newAuthorEmail })
				}, strings.editingCommitMessage);
			},
			target
		);
	};

	// The commit list only carries each message's subject line: the dialog must edit the full
	// message the user actually committed, so it is fetched first (falling back to the subject
	// when that fails). The commit is re-resolved inside the callback, because it may have been
	// unloaded by a refresh while the fetch was in flight.
	ctx.commitBodies.getCommitBody(hash, (body) => {
		const commit = store.getCommit(hash);
		if (commit === undefined) return; // The commit is no longer loaded (e.g. after a refresh)
		if (ctx.dialog.isOpen()) return; // A dialog opened in the meantime (for another commit): a late body must not replace it
		showEditDialog(body !== null ? body : commit.message);
	});
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProductionGitRepository } from '../git/gitRepository';
import { checkUnsafeGitArgs, isSafeRefName, Localize } from '../git/write/argSafety';
import { detachedCommitsLossWarning, hardResetLossWarning } from '../git/write/lossGuard';
import * as ops from '../git/write/ops/index';
import type { GitConfigKey } from '../git/write/ops/config';
import { ErrorInfo, LossWarning } from '../../shared/protocol/messages';
import { MergeActionOn, RebaseActionOn } from '../../shared/protocol/operations';
import { SquashMessageFormat, TagType } from '../../shared/model/webview';
import { GitResetMode, GitPushBranchMode, GitConfigLocation, GitOperationType } from '../../shared/model/git';
import type { GitRunnerPort } from './gitRunner';
import { getRemotesContainingCommit } from './repoReads';

/**
 * The write flows of the graph view (REFACTOR-PLAN task 3.6, host side): the orchestration of the
 * legacy `DataSource` write methods — the loss-warning preflights, the squash follow-ups, the
 * remote-containment checks, the interactive-rebase and message-edit handoffs — expressed as
 * reads on the facade's `read` face plus the pure write ops through `write`. No handler spawns a
 * process and no flow skips the GitWriter's gates: every repository mutation goes through
 * `repo.write(repo, op)`; the editor-script rebase of `editCommitMessage` and the terminal
 * handoff of the interactive rebase are the two legacy spawn sequences that are not pure ops,
 * and they run through the runner and UI ports the panel injects.
 */

/** The slice of the handler context the flows run against (see handlers/context.ts). */
export interface WriteFlowContext {
	/** The repository facade: reads on `.read`, writes through `.write`. */
	readonly repo: ProductionGitRepository;
	/** The raw runner behind the few spawns that are not pure ops. */
	readonly git: GitRunnerPort;
	/** The localizer for the flow-produced messages (the panel injects the i18n `t`). */
	readonly t: Localize;
	/** The extension-configuration values a flow consults (a fresh snapshot per request). */
	readonly config: {
		readonly squashPullMessageFormat: SquashMessageFormat;
		readonly squashMergeMessageFormat: SquashMessageFormat;
	};
	/** The platform handoffs (terminal, shell quoting) a flow may need. */
	readonly ui: {
		/** Shell-quote an object for the integrated terminal's shell, or NULL when unsafe. */
		quoteForTerminal(obj: string): string | null;
		/** Open the integrated terminal at `repo` running `command`. */
		openGitTerminal(repo: string, command: string | null, name: string): Thenable<ErrorInfo>;
	};
	/** Drop the cached repository configuration after a config-affecting write. */
	readonly repoConfig: { invalidate(repo: string | null): void };
}

type Repo = string;

/** The one write seam of every flow: the facade's GitWriter (the single place a repository is changed). */
function run(ctx: WriteFlowContext, repo: Repo, op: ops.WriteOp): Promise<ErrorInfo> {
	return ctx.repo.write.run(repo, op);
}

/** The detached-commits warning of the legacy checkout-family methods, over the runner. */
function guardDetachedCommits(ctx: WriteFlowContext, repo: Repo, anchoredAt: string | null = null): Promise<LossWarning | null> {
	return detachedCommitsLossWarning((argv) => ctx.git.gitOutput(argv, repo, (out) => out), ctx.t, anchoredAt);
}

/** The hard-reset warning of the legacy `resetToCommit`, over the runner. */
function guardHardReset(ctx: WriteFlowContext, repo: Repo): Promise<LossWarning | null> {
	return hardResetLossWarning((argv) => ctx.git.gitOutput(argv, repo, (out) => out), ctx.t);
}

/* ---------- Branches ---------- */

/** Checkout a branch (or a remote branch as a new local one), with the detached-commits guard. */
export async function checkoutBranch(ctx: WriteFlowContext, repo: Repo, branchName: string, remoteBranch: string | null, confirmed: boolean): Promise<ErrorInfo | LossWarning> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['branchName', branchName, 'ref'], ['remoteBranch', remoteBranch, 'ref']);
	if (unsafe !== null) return unsafe;
	if (!confirmed) {
		const warning = await guardDetachedCommits(ctx, repo);
		if (warning !== null) return warning;
	}
	return run(ctx, repo, ops.checkoutBranch({ branchName: branchName, remoteBranch: remoteBranch }));
}

/** Create a branch at a commit, optionally checking it out, with the guard anchored at the commit. */
export async function createBranch(ctx: WriteFlowContext, repo: Repo, branchName: string, commitHash: string, checkout: boolean, force: boolean, confirmed: boolean): Promise<(ErrorInfo | LossWarning)[]> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['branchName', branchName, 'ref'], ['commitHash', commitHash, 'hash']);
	if (unsafe !== null) return [unsafe];
	// The guard runs before ANY command: with force the checkout runs as a second step, and a
	// warning returned there would sit behind the successful branch creation, where the view's
	// warning forwarding (which reads the first element) would miss it.
	if (checkout && !confirmed) {
		const warning = await guardDetachedCommits(ctx, repo, commitHash);
		if (warning !== null) return [warning];
	}
	const statuses: (ErrorInfo | LossWarning)[] = [await run(ctx, repo, ops.createBranch({ branchName: branchName, commitHash: commitHash, checkout: checkout, force: force }))];
	if (statuses[0] === null && checkout && force) {
		statuses.push(await checkoutBranch(ctx, repo, branchName, null, confirmed));
	}
	return statuses;
}

export function deleteBranch(ctx: WriteFlowContext, repo: Repo, branchName: string, force: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.deleteBranch({ branchName: branchName, force: force }));
}

/** Delete a remote branch, falling back to the stale remote-tracking branch when the remote ref is already gone. */
export async function deleteRemoteBranch(ctx: WriteFlowContext, repo: Repo, branchName: string, remote: string): Promise<ErrorInfo> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
	if (unsafe !== null) return unsafe;
	const remoteStatus = await run(ctx, repo, ops.deleteRemoteBranch({ branchName: branchName, remote: remote }));
	if (remoteStatus !== null && /remote ref does not exist/i.test(remoteStatus)) {
		const trackingStatus = await run(ctx, repo, ops.deleteRemoteTrackingBranch({ branchName: branchName, remote: remote }));
		return trackingStatus === null ? null : 'Branch does not exist on the remote, deleting the remote tracking branch ' + remote + '/' + branchName + '.\n' + trackingStatus;
	}
	return remoteStatus;
}

export function renameBranch(ctx: WriteFlowContext, repo: Repo, oldName: string, newName: string): Promise<ErrorInfo> {
	return run(ctx, repo, ops.renameBranch({ oldName: oldName, newName: newName }));
}

/** Fetch a remote branch into a local branch (the current branch goes through pull / fetch+reset). */
export async function fetchIntoLocalBranch(ctx: WriteFlowContext, repo: Repo, remote: string, remoteBranch: string, localBranch: string, force: boolean): Promise<ErrorInfo> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['remote', remote, 'ref'], ['remoteBranch', remoteBranch, 'ref'], ['localBranch', localBranch, 'ref']);
	if (unsafe !== null) return unsafe;
	const currentBranch = await ctx.repo.read.currentBranchName(repo).catch(() => null);
	return run(ctx, repo, ops.fetchIntoLocalBranch({
		remote: remote, remoteBranch: remoteBranch, localBranch: localBranch, force: force,
		isCurrentBranch: currentBranch === localBranch
	}));
}

/* ---------- Remote sync ---------- */

export function fetch(ctx: WriteFlowContext, repo: Repo, remote: string | null, prune: boolean, pruneTags: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.fetch({ remote: remote, prune: prune, pruneTags: pruneTags }));
}

/** Push a branch to one remote, with the force-push data-loss guard. */
export async function pushBranch(ctx: WriteFlowContext, repo: Repo, branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode, confirmed: boolean): Promise<ErrorInfo | LossWarning> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['branchName', branchName, 'ref'], ['remote', remote, 'ref']);
	if (unsafe !== null) return unsafe;
	// A force push rewrites the remote's history; --force-with-lease (the guarded variant) is not confirmed a second time.
	if (mode === GitPushBranchMode.Force && !confirmed) {
		return { message: ctx.t('forcePushOverwrites', branchName, remote) };
	}
	return run(ctx, repo, ops.pushBranch({ branchName: branchName, remote: remote, setUpstream: setUpstream, mode: mode }));
}

/** Push a branch to multiple remotes, stopping at the first failure (the legacy loop). */
export async function pushBranchToMultipleRemotes(ctx: WriteFlowContext, repo: Repo, branchName: string, remotes: ReadonlyArray<string>, setUpstream: boolean, mode: GitPushBranchMode, confirmed: boolean): Promise<(ErrorInfo | LossWarning)[]> {
	if (remotes.length === 0) {
		return ['No remote(s) were specified to push the branch ' + branchName + ' to.'];
	}
	const results: (ErrorInfo | LossWarning)[] = [];
	for (let i = 0; i < remotes.length; i++) {
		const result = await pushBranch(ctx, repo, branchName, remotes[i], setUpstream, mode, confirmed);
		results.push(result);
		if (result !== null) break;
	}
	return results;
}

/** Push a tag, with the remotes-contain-commit preflight of the legacy `pushTag`. */
export async function pushTag(ctx: WriteFlowContext, repo: Repo, tagName: string, remotes: ReadonlyArray<string>, commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['tagName', tagName, 'ref'], ['commitHash', commitHash, 'hash']);
	if (unsafe !== null) return [unsafe];
	if (remotes.length === 0) {
		return ['No remote(s) were specified to push the tag ' + tagName + ' to.'];
	}
	if (!remotes.every((remote) => isSafeRefName(remote))) {
		return ['Invalid reference name was provided for "remotes"'];
	}
	if (!skipRemoteCheck) {
		const containing = await getRemotesContainingCommit(ctx.git, repo, commitHash, remotes).catch(() => remotes);
		const notContaining = remotes.filter((remote) => !containing.includes(remote));
		if (notContaining.length > 0) {
			// The ErrorInfoExtensionPrefix the view parses for its "push anyway?" dialog.
			return ['PushTagCommitNotOnRemote:' + JSON.stringify(notContaining)];
		}
	}
	// The op's steps stop at the first failing push, exactly like the legacy loop; the view
	// reads the entries as the per-remote results.
	const error = await run(ctx, repo, ops.pushTag({ tagName: tagName, remotes: remotes, commitHash: commitHash }));
	return error === null ? [] : [error];
}

/* ---------- Remotes ---------- */

/**
 * Add a remote (optionally fetching it), dropping the engine's warm handle afterwards: the remote
 * set lives in the repository's config, which the engine's warm handle reads once at open time.
 */
export async function addRemote(ctx: WriteFlowContext, repo: Repo, name: string, url: string, pushUrl: string | null, fetchAfter: boolean): Promise<ErrorInfo> {
	const error = await run(ctx, repo, ops.addRemote({ name: name, url: url, pushUrl: pushUrl, fetchAfter: fetchAfter }));
	if (error !== null) return error;
	ctx.repo.read.closeRepository(repo);
	ctx.repoConfig.invalidate(repo);
	return fetchAfter ? fetch(ctx, repo, name, false, false) : null;
}

export async function deleteRemote(ctx: WriteFlowContext, repo: Repo, name: string): Promise<ErrorInfo> {
	const error = await run(ctx, repo, ops.deleteRemote({ name: name }));
	if (error !== null) return error;
	ctx.repo.read.closeRepository(repo);
	ctx.repoConfig.invalidate(repo);
	return null;
}

export async function editRemote(ctx: WriteFlowContext, repo: Repo, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null): Promise<ErrorInfo> {
	const error = await run(ctx, repo, ops.editRemote({
		nameOld: nameOld, nameNew: nameNew, urlOld: urlOld, urlNew: urlNew, pushUrlOld: pushUrlOld, pushUrlNew: pushUrlNew
	}));
	if (error !== null) return error;
	ctx.repo.read.closeRepository(repo);
	ctx.repoConfig.invalidate(repo);
	return null;
}

export function pruneRemote(ctx: WriteFlowContext, repo: Repo, name: string): Promise<ErrorInfo> {
	return run(ctx, repo, ops.pruneRemote({ name: name }));
}

/* ---------- Tags ---------- */

export function addTag(ctx: WriteFlowContext, repo: Repo, tagName: string, commitHash: string, type: TagType, message: string, force: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.addTag({
		tagName: tagName, commitHash: commitHash, type: type, message: message, force: force,
		signTags: ctx.repo.write.policies.signTags
	}));
}

/** Delete a tag (optionally on a remote), cleaning the other remotes' tracking refs like the legacy method. */
export async function deleteTag(ctx: WriteFlowContext, repo: Repo, tagName: string, deleteOnRemote: string | null): Promise<ErrorInfo> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['tagName', tagName, 'ref'], ['deleteOnRemote', deleteOnRemote, 'ref']);
	if (unsafe !== null) return unsafe;
	const remotes = await ctx.repo.read.getRemotes(repo).then((list) => [...list], () => [] as string[]);
	return run(ctx, repo, ops.deleteTag({
		tagName: tagName, deleteOnRemote: deleteOnRemote,
		otherRemotes: remotes.filter((remote) => remote !== deleteOnRemote)
	}));
}

/* ---------- Commits ---------- */

export async function checkoutCommit(ctx: WriteFlowContext, repo: Repo, commitHash: string, confirmed: boolean): Promise<ErrorInfo | LossWarning> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['commitHash', commitHash, 'hash']);
	if (unsafe !== null) return unsafe;
	if (!confirmed) {
		const warning = await guardDetachedCommits(ctx, repo);
		if (warning !== null) return warning;
	}
	return run(ctx, repo, ops.checkoutCommit({ commitHash: commitHash }));
}

export function cherrypickCommit(ctx: WriteFlowContext, repo: Repo, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.cherrypickCommit({
		commitHash: commitHash, parentIndex: parentIndex, recordOrigin: recordOrigin, noCommit: noCommit,
		sign: ctx.repo.write.policies.signCommits
	}));
}

export function revertCommit(ctx: WriteFlowContext, repo: Repo, commitHash: string, parentIndex: number): Promise<ErrorInfo> {
	return run(ctx, repo, ops.revertCommit({ commitHash: commitHash, parentIndex: parentIndex, sign: ctx.repo.write.policies.signCommits }));
}

export function dropCommit(ctx: WriteFlowContext, repo: Repo, commitHash: string): Promise<ErrorInfo> {
	return run(ctx, repo, ops.dropCommit({ commitHash: commitHash, sign: ctx.repo.write.policies.signCommits }));
}

export function createFixupCommit(ctx: WriteFlowContext, repo: Repo, commitHash: string): Promise<ErrorInfo> {
	return run(ctx, repo, ops.createFixupCommit({ commitHash: commitHash, sign: ctx.repo.write.policies.signCommits }));
}

export function createSquashCommit(ctx: WriteFlowContext, repo: Repo, commitHash: string): Promise<ErrorInfo> {
	return run(ctx, repo, ops.createSquashCommit({ commitHash: commitHash, sign: ctx.repo.write.policies.signCommits }));
}

export function undoLastCommit(ctx: WriteFlowContext, repo: Repo): Promise<ErrorInfo> {
	return run(ctx, repo, ops.undoLastCommit());
}

export async function resetToCommit(ctx: WriteFlowContext, repo: Repo, commit: string, resetMode: GitResetMode, confirmed: boolean): Promise<ErrorInfo | LossWarning> {
	if (commit !== 'HEAD') {
		const unsafe = checkUnsafeGitArgs(ctx.t, ['commit', commit, 'hash']);
		if (unsafe !== null) return unsafe;
		if (resetMode === GitResetMode.Hard && !confirmed) {
			const warning = await guardHardReset(ctx, repo);
			if (warning !== null) return warning;
		}
	}
	return run(ctx, repo, ops.resetToCommit({ commit: commit, resetMode: resetMode }));
}

export function resetFileToRevision(ctx: WriteFlowContext, repo: Repo, commitHash: string, filePath: string): Promise<ErrorInfo> {
	return run(ctx, repo, ops.resetFileToRevision({ commitHash: commitHash, filePath: filePath }));
}

/* ---------- Merge & rebase ---------- */

/** Merge a branch/commit, committing an applied squash merge afterwards like the legacy method. */
export async function merge(ctx: WriteFlowContext, repo: Repo, obj: string, actionOn: MergeActionOn, createNewCommit: boolean, squash: boolean, noCommit: boolean): Promise<ErrorInfo> {
	const mergeStatus = await run(ctx, repo, ops.merge({
		obj: obj, actionOn: actionOn, createNewCommit: createNewCommit, squash: squash, noCommit: noCommit,
		sign: ctx.repo.write.policies.signCommits
	}));
	if (mergeStatus !== null || !squash || noCommit) return mergeStatus;
	return commitSquashIfStagedChangesExist(ctx, repo, () => ops.commitSquashFromMerge({
		obj: obj, actionOn: actionOn,
		squashMessageFormat: ctx.config.squashMergeMessageFormat,
		sign: ctx.repo.write.policies.signCommits
	}));
}

/** Pull a branch, committing an applied squash pull afterwards like the legacy method. */
export async function pullBranch(ctx: WriteFlowContext, repo: Repo, branchName: string, remote: string, createNewCommit: boolean, squash: boolean): Promise<ErrorInfo> {
	const error = await run(ctx, repo, ops.pullBranch({
		branchName: branchName, remote: remote, createNewCommit: createNewCommit, squash: squash,
		sign: ctx.repo.write.policies.signCommits
	}));
	if (error !== null || !squash) return error;
	return commitSquashIfStagedChangesExist(ctx, repo, () => ops.commitSquashFromPull({
		remote: remote, branchName: branchName,
		squashMessageFormat: ctx.config.squashPullMessageFormat,
		sign: ctx.repo.write.policies.signCommits
	}));
}

/**
 * Rebase the current branch: the interactive variant hands off to the integrated terminal (an
 * editor is involved, so the object is shell-quoted for it), the headless variant is a plain op.
 */
export async function rebase(ctx: WriteFlowContext, repo: Repo, obj: string, actionOn: RebaseActionOn, ignoreDate: boolean, interactive: boolean, autosquash: boolean): Promise<ErrorInfo> {
	if (interactive) {
		const quoted = actionOn === RebaseActionOn.Branch ? ctx.ui.quoteForTerminal(obj) : obj;
		if (quoted === null) return ctx.t('unsafeForTerminal', obj);
		return ctx.ui.openGitTerminal(repo, 'rebase --interactive ' + (autosquash ? '--autosquash ' : '') + (ctx.repo.write.policies.signCommits ? '-S ' : '') + quoted, 'Rebase on "' + (actionOn === RebaseActionOn.Branch ? obj : obj.substring(0, 8)) + '"');
	}
	return run(ctx, repo, ops.rebase({ obj: obj, actionOn: actionOn, ignoreDate: ignoreDate, sign: ctx.repo.write.policies.signCommits }));
}

export function continueOperation(ctx: WriteFlowContext, repo: Repo, type: GitOperationType): Promise<ErrorInfo> {
	return run(ctx, repo, ops.continueOperation({ type: type }));
}

export function abortOperation(ctx: WriteFlowContext, repo: Repo, type: GitOperationType): Promise<ErrorInfo> {
	return run(ctx, repo, ops.abortOperation({ type: type }));
}

export function cleanUntrackedFiles(ctx: WriteFlowContext, repo: Repo, directories: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.cleanUntrackedFiles({ directories: directories }));
}

/* ---------- Stash ---------- */

export function applyStash(ctx: WriteFlowContext, repo: Repo, selector: string, reinstateIndex: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.applyStash({ selector: selector, reinstateIndex: reinstateIndex }));
}

export function popStash(ctx: WriteFlowContext, repo: Repo, selector: string, reinstateIndex: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.popStash({ selector: selector, reinstateIndex: reinstateIndex }));
}

export function pushStash(ctx: WriteFlowContext, repo: Repo, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.pushStash({ message: message, includeUntracked: includeUntracked }));
}

export function dropStash(ctx: WriteFlowContext, repo: Repo, selector: string): Promise<ErrorInfo> {
	return run(ctx, repo, ops.dropStash({ selector: selector }));
}

export async function branchFromStash(ctx: WriteFlowContext, repo: Repo, selector: string, branchName: string, confirmed: boolean): Promise<ErrorInfo | LossWarning> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['selector', selector, 'stash'], ['branchName', branchName, 'ref']);
	if (unsafe !== null) return unsafe;
	if (!confirmed) {
		const warning = await guardDetachedCommits(ctx, repo);
		if (warning !== null) return warning;
	}
	return run(ctx, repo, ops.branchFromStash({ selector: selector, branchName: branchName }));
}

/* ---------- Config ---------- */

export function setConfigValue(ctx: WriteFlowContext, repo: Repo, key: GitConfigKey, value: string, location: GitConfigLocation): Promise<ErrorInfo> {
	return run(ctx, repo, ops.setConfigValue({ key: key, value: value, location: location }));
}

export function unsetConfigValue(ctx: WriteFlowContext, repo: Repo, key: GitConfigKey, location: GitConfigLocation): Promise<ErrorInfo> {
	return run(ctx, repo, ops.unsetConfigValue({ key: key, location: location }));
}

/* ---------- Worktrees ---------- */

export function addWorktree(ctx: WriteFlowContext, repo: Repo, path: string, branch: string | null, newBranch: string | null): Promise<ErrorInfo> {
	return run(ctx, repo, ops.addWorktree({ path: path, branch: branch, newBranch: newBranch }));
}

export function removeWorktree(ctx: WriteFlowContext, repo: Repo, path: string, force: boolean): Promise<ErrorInfo> {
	return run(ctx, repo, ops.removeWorktree({ path: path, force: force }));
}

export function pruneWorktrees(ctx: WriteFlowContext, repo: Repo): Promise<ErrorInfo> {
	return run(ctx, repo, ops.pruneWorktrees());
}

/* ---------- Message editing (the one flow that is not a pure op) ---------- */

/**
 * Edit the message (and optionally the author) of an unpushed commit (the legacy
 * `editCommitMessage`): HEAD is amended directly; an earlier commit is reworded through an
 * automated interactive rebase whose sequence/message editors are small node scripts, aborted
 * (with `--autostash` restoring the working tree) when it fails part-way.
 */
export async function editCommitMessage(ctx: WriteFlowContext, repo: Repo, commitHash: string, message: string, authorName?: string, authorEmail?: string): Promise<ErrorInfo> {
	const unsafe = checkUnsafeGitArgs(ctx.t, ['commitHash', commitHash, 'hash']);
	if (unsafe !== null) return unsafe;

	// The commit's new author in git's "Name <email>" form (an empty email is written as "<>",
	// which git records as a name-only author), or null when the caller left the author unchanged.
	const author = typeof authorName === 'string' && authorName.trim() !== ''
		? (typeof authorEmail === 'string' && authorEmail.trim() !== '' ? authorName + ' <' + authorEmail + '>' : authorName + ' <>')
		: null;

	try {
		const headCommit = await ctx.git.gitOutput(['rev-parse', 'HEAD'], repo, (stdout) => stdout.trim());

		if (headCommit === commitHash) {
			return run(ctx, repo, ops.amendCommitMessage({
				message: message, authorName: authorName, authorEmail: authorEmail,
				sign: ctx.repo.write.policies.signCommits
			}));
		}

		// The commit must be part of the current branch's history for the rebase to reach it
		const isAncestor = await ctx.git.collect(['merge-base', '--is-ancestor', commitHash, 'HEAD'], repo).then((r) => r.code === 0, () => false);
		if (!isAncestor) return ctx.t('amendNotAncestor');

		// Merge commits cannot be reworded by a linear pick/reword todo
		const parents = await ctx.git.gitOutput(['rev-list', '--parents', '-n', '1', commitHash], repo, (stdout) => stdout.trim().split(/\s+/));
		if (parents.length > 2) return ctx.t('amendMergeCommit');

		// Editing a commit any remote already contains would rewrite published history
		const knownRemotes = await ctx.repo.read.getRemotes(repo).then((list) => [...list], () => [] as string[]);
		const containingRemotes = await getRemotesContainingCommit(ctx.git, repo, commitHash, knownRemotes);
		if (containingRemotes.length > 0) return ctx.t('amendPushedCommit', containingRemotes.join(', '));

		const rebaseArgs = parents.length === 1 ? ['rebase', '-i', '--autostash', '--root'] : ['rebase', '-i', '--autostash', commitHash + '^'];

		// The editors git invokes are real scripts shipped beside the host bundle
		// (dist/editors/{sequence,message}.js, built by scripts/build/build.mjs the same way as
		// the askpass helper; in the out/ tree tsc emits them beside this module, and the
		// source-run test tree resolves the repo's dist/ instead). Data reaches them only
		// through argv and the environment: git appends the todo / editor file path to the
		// editor command, the commit hash rides that command line, and the staged message and
		// author travel as FILES whose paths name the environment variables - nothing
		// user-provided is ever embedded in code a shell executes.
		const editorScript = (name: string): string | null => {
			const candidates = [
				path.join(__dirname, 'editors', name),
				// The vitest tree: this module runs from src/extension/graphView, the built
				// scripts sit in the repository's dist/ (built before the suite, like out/).
				path.join(__dirname, '..', '..', '..', 'dist', 'editors', name)
			];
			return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
		};
		const sequenceEditor = editorScript('sequence.js');
		const messageEditor = editorScript('message.js');
		if (sequenceEditor === null || messageEditor === null) {
			return 'The rebase editor scripts are missing from the extension directory (dist/editors); rebuild the extension and try again.';
		}

		// One private staging directory per rebase (fs.mkdtemp is unique and 0700 on POSIX),
		// holding the staged message and author files; the whole directory is removed in the
		// finally below, not the individual files.
		const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-amend-'));
		const messageFile = path.join(stagingDir, 'message.txt');
		const authorFile = path.join(stagingDir, 'author.txt');
		const node = '"' + process.execPath + '"';
		const extraEnv: { [key: string]: string } = {
			GIT_SEQUENCE_EDITOR: node + ' "' + sequenceEditor + '" ' + commitHash,
			GIT_EDITOR: node + ' "' + messageEditor + '" "' + messageFile + '"',
			// The extension host may run inside the Electron binary; without this an Electron
			// process.execPath would launch a window instead of the editor script.
			ELECTRON_RUN_AS_NODE: '1'
		};
		if (author !== null) {
			extraEnv.GG_AMEND_AUTHOR_FILE = authorFile;
			extraEnv.GG_AMEND_MESSAGE = messageFile;
		}

		try {
			// Owner-only (0o600) where the platform honors the mode; Windows maps it to the
			// read-only bit, which a freshly written text file never sets.
			fs.writeFileSync(messageFile, message, { mode: 0o600 });
			if (author !== null) fs.writeFileSync(authorFile, author, { mode: 0o600 });
			const result = await ctx.git.collect(rebaseArgs, repo, { env: extraEnv });
			if (result.code !== 0) throw new Error(commandFailureText(result));
			return null;
		} catch (thrown) {
			// Restore the repository to the pre-rebase state (and the autostashed working tree)
			await ctx.git.collect(['rebase', '--abort'], repo);
			return thrown instanceof Error ? thrown.message : String(thrown);
		} finally {
			fs.rmSync(stagingDir, { recursive: true, force: true });
		}
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/* ---------- Internals ---------- */

/** The staged-changes probe + squash commit of the legacy `commitSquashIfStagedChangesExist`. */
async function commitSquashIfStagedChangesExist(ctx: WriteFlowContext, repo: Repo, buildOp: () => ops.WriteOp): Promise<ErrorInfo> {
	const staged = await ctx.git.gitOutput(['diff-index', 'HEAD'], repo, (out) => out !== '').catch(() => false);
	if (!staged) return null;
	return run(ctx, repo, buildOp());
}

/** The error message of a failed collected run, in the legacy `commandFailure` shape. */
function commandFailureText(result: { stderr: string; stdout: Buffer }): string {
	const lines = (result.stderr + result.stdout.toString('utf8')).split(/\r\n|\r|\n/);
	lines.pop();
	return lines.join('\n');
}

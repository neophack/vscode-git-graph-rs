import type { RequestCommand } from '../../../shared/protocol/graphView';
import type { RequestMessage } from '../../../types';
import type { Handler, HandlerContext } from './context';

import * as branches from './branches';
import * as codeReview from './codeReview';
import * as commits from './commits';
import * as files from './files';
import * as gerrit from './gerrit';
import * as loading from './loading';
import * as misc from './misc';
import * as operations from './operations';
import * as remotes from './remotes';
import * as settings from './settings';
import * as stash from './stash';
import * as tags from './tags';
import * as worktrees from './worktrees';

/**
 * The exhaustive request handler table (task 4.2): one Handler per request command of the
 * graph view protocol, assembled from the domain modules. The `satisfies` check makes the
 * compiler guarantee exhaustiveness - a missing or extra entry fails compilation - so the
 * protocol half of the old contract tests is replaced by tsc itself.
 */
export const HANDLER_TABLE = {
	abortOperation: operations.abortOperation,
	addRemote: remotes.addRemote,
	addTag: tags.addTag,
	applyStash: stash.applyStash,
	branchFromStash: stash.branchFromStash,
	checkoutBranch: branches.checkoutBranch,
	checkoutCommit: commits.checkoutCommit,
	cherrypickCommit: commits.cherrypickCommit,
	cleanUntrackedFiles: operations.cleanUntrackedFiles,
	commitBodies: loading.commitBodies,
	commitDetails: loading.commitDetails,
	commitFileCounts: loading.commitFileCounts,
	commitFixup: commits.commitFixup,
	commitSquash: commits.commitSquash,
	compareCommits: loading.compareCommits,
	continueOperation: operations.continueOperation,
	copyFilePath: files.copyFilePath,
	copyToClipboard: files.copyToClipboard,
	countCommitsBefore: loading.countCommitsBefore,
	createArchive: files.createArchive,
	createBranch: branches.createBranch,
	createPullRequest: operations.createPullRequest,
	deleteBranch: branches.deleteBranch,
	deleteRemote: remotes.deleteRemote,
	deleteRemoteBranch: branches.deleteRemoteBranch,
	deleteTag: tags.deleteTag,
	deleteUserDetails: settings.deleteUserDetails,
	dropCommit: commits.dropCommit,
	dropStash: stash.dropStash,
	editCommitMessage: commits.editCommitMessage,
	editRemote: remotes.editRemote,
	editUserDetails: settings.editUserDetails,
	endCodeReview: codeReview.endCodeReview,
	exportRepoConfig: misc.exportRepoConfig,
	fetch: remotes.fetch,
	fetchAvatar: loading.fetchAvatar,
	fetchIntoLocalBranch: branches.fetchIntoLocalBranch,
	fetchPullRequest: gerrit.fetchPullRequest,
	gerritSetFetchRefs: gerrit.gerritSetFetchRefs,
	loadCommits: loading.loadCommits,
	loadConfig: loading.loadConfig,
	loadRepoInfo: loading.loadRepoInfo,
	loadRepos: misc.loadRepos,
	loadView: loading.loadView,
	merge: operations.merge,
	openCompareTab: files.openCompareTab,
	openExtensionSettings: settings.openExtensionSettings,
	openExternalDirDiff: files.openExternalDirDiff,
	openExternalUrl: misc.openExternalUrl,
	openFile: files.openFile,
	openLogFile: settings.openLogFile,
	openTerminal: misc.openTerminal,
	popStash: stash.popStash,
	predictConflicts: operations.predictConflicts,
	pruneRemote: remotes.pruneRemote,
	pullBranch: remotes.pullBranch,
	pushBranch: remotes.pushBranch,
	pushStash: stash.pushStash,
	pushTag: tags.pushTag,
	ready: loading.ready,
	rebase: operations.rebase,
	reflog: loading.reflog,
	renameBranch: branches.renameBranch,
	repoStatistics: loading.repoStatistics,
	rescanForRepos: misc.rescanForRepos,
	resetFileToRevision: commits.resetFileToRevision,
	resetToCommit: commits.resetToCommit,
	revertCommit: commits.revertCommit,
	setGlobalSetting: settings.setGlobalSetting,
	setGlobalViewState: settings.setGlobalViewState,
	setInterfaceLanguage: settings.setInterfaceLanguage,
	setRepoState: settings.setRepoState,
	setViewSnapshot: settings.setViewSnapshot,
	setWorkspaceViewState: settings.setWorkspaceViewState,
	showErrorMessage: misc.showErrorMessage,
	startCodeReview: codeReview.startCodeReview,
	tagDetails: tags.tagDetails,
	undoLastCommit: commits.undoLastCommit,
	updateCodeReview: codeReview.updateCodeReview,
	viewDiff: files.viewDiff,
	viewDiffBinary: files.viewDiffBinary,
	viewDiffWithWorkingFile: files.viewDiffWithWorkingFile,
	viewFileAtRevision: files.viewFileAtRevision,
	viewScm: misc.viewScm,
	worktreeAdd: worktrees.worktreeAdd,
	worktreeList: worktrees.worktreeList,
	worktreePrune: worktrees.worktreePrune,
	worktreeRemove: worktrees.worktreeRemove
} satisfies { readonly [K in RequestCommand]: Handler<K> };

/** The handler table widened to the general Handler type, for lookups by runtime command. */
const TABLE: { readonly [K in RequestCommand]: Handler } = HANDLER_TABLE;

/**
 * Whether a command's handler can modify the repository. The per-handler replacement of the
 * hand-maintained GitGraphView.REPO_MUTATING_COMMANDS set: the dispatcher's caller runs the
 * message with the repo file watcher muted and drops the commit cache afterwards exactly when
 * this answers TRUE (the acceptance comparison of the two sets ran once during the 4.4 cutover).
 */
export function isMutatingCommand(command: string): boolean {
	const handler = Object.prototype.hasOwnProperty.call(TABLE, command) ? TABLE[command as RequestCommand] : undefined;
	return handler !== undefined && handler.mutates;
}

/** What {@link dispatchRequest} did with a message. */
export type DispatchResult =
	/** A handler ran (it may still have thrown - the caller's try/catch reports that). */
	'handled'
	/** No handler exists for the command: the caller logs it and answers with an error. */
	| 'unknown';

/**
 * Route one inbound webview message to its handler.
 *
 * The minimal runtime guard of plan 3.2: the command must be a key of the handler table. A
 * message with an unknown command answers 'unknown' (the panel logs it and replies with an
 * error instead of silently dropping it - task 4.2); anything further (the `repo` must name a
 * known repository) is the caller's guard, which owns the repository list.
 *
 * @param msg The raw message received from the webview.
 * @param ctx The context the handler runs with.
 */
export async function dispatchRequest(msg: unknown, ctx: HandlerContext): Promise<DispatchResult> {
	const command = typeof msg === 'object' && msg !== null ? (msg as { command?: unknown }).command : undefined;
	if (typeof command !== 'string' || !Object.prototype.hasOwnProperty.call(TABLE, command)) return 'unknown';
	await TABLE[command as RequestCommand].handle(msg as RequestMessage, ctx);
	return 'handled';
}

import type {
	RequestAbortOperation, RequestAddRemote, RequestAddTag, RequestApplyStash, RequestBranchFromStash,
	RequestCheckoutBranch, RequestCheckoutCommit, RequestCherrypickCommit, RequestCleanUntrackedFiles,
	RequestCommitBodies, RequestCommitDetails, RequestCommitFileCounts, RequestCompareCommits, RequestCommitFixup,
	RequestCommitSquash, RequestContinueOperation, RequestCopyFilePath, RequestCopyToClipboard, RequestCountCommitsBefore,
	RequestCreateArchive, RequestCreateBranch, RequestCreatePullRequest, RequestDeleteBranch, RequestDeleteRemote,
	RequestDeleteRemoteBranch, RequestDeleteTag, RequestDeleteUserDetails, RequestDropCommit, RequestDropStash,
	RequestEditCommitMessage, RequestEditRemote, RequestEditUserDetails, RequestEndCodeReview, RequestExportRepoConfig,
	RequestFetch, RequestFetchAvatar, RequestFetchIntoLocalBranch, RequestFetchPullRequest, RequestGerritSetFetchRefs,
	RequestLoadCommits, RequestLoadConfig, RequestLoadRepoInfo, RequestLoadRepos, RequestMerge, RequestOpenCompareTab,
	RequestOpenExtensionSettings, RequestOpenExternalDirDiff, RequestOpenExternalUrl, RequestOpenFile, RequestOpenLogFile,
	RequestOpenTerminal, RequestPopStash, RequestPredictConflicts, RequestPruneRemote, RequestPullBranch, RequestPushBranch,
	RequestPushStash, RequestPushTag, RequestRebase, RequestReflog, RequestRenameBranch, RequestRepoStatistics,
	RequestRescanForRepos, RequestResetFileToRevision, RequestResetToCommit, RequestRevertCommit, RequestSetGlobalSetting,
	RequestSetGlobalViewState, RequestSetInterfaceLanguage, RequestSetRepoState, RequestSetViewSnapshot,
	RequestSetWorkspaceViewState, RequestShowErrorDialog, RequestStartCodeReview, RequestTagDetails, RequestUndoLastCommit,
	RequestUpdateCodeReview, RequestViewDiff, RequestViewDiffBinary, RequestViewDiffWithWorkingFile,
	RequestViewFileAtRevision, RequestViewScm, RequestWorktreeAdd, RequestWorktreeList, RequestWorktreePrune, RequestWorktreeRemove
} from '../../types';
import type { RequestMessage, ResponseMessage } from '../../types';
import type {
	ResponseAbortOperation, ResponseAddRemote, ResponseAddTag, ResponseApplyStash, ResponseBranchFromStash,
	ResponseCheckoutBranch, ResponseCheckoutCommit, ResponseCherrypickCommit, ResponseCleanUntrackedFiles,
	ResponseCommitBodies, ResponseCommitDetails, ResponseCommitFileCounts, ResponseCompareCommits, ResponseCommitFixup,
	ResponseCommitSquash, ResponseContinueOperation, ResponseCopyFilePath, ResponseCopyToClipboard,
	ResponseCountCommitsBefore, ResponseCreateArchive, ResponseCreateBranch, ResponseCreatePullRequest, ResponseDeleteBranch,
	ResponseDeleteRemote, ResponseDeleteRemoteBranch, ResponseDeleteTag, ResponseDeleteUserDetails, ResponseDropCommit,
	ResponseDropStash, ResponseEditCommitMessage, ResponseEditRemote, ResponseEditUserDetails, ResponseExportRepoConfig,
	ResponseFetch, ResponseFetchAvatar, ResponseFetchIntoLocalBranch, ResponseGerritSetFetchRefs, ResponseLoadCommits,
	ResponseLoadConfig, ResponseLoadRepoInfo, ResponseLoadRepos, ResponseMerge, ResponseOpenExtensionSettings,
	ResponseOpenExternalDirDiff, ResponseOpenExternalUrl, ResponseOpenFile, ResponseOpenLogFile, ResponseOpenTerminal,
	ResponsePopStash, ResponsePredictConflicts, ResponsePruneRemote, ResponsePullBranch, ResponsePullRequestStatus,
	ResponsePushBranch, ResponsePushStash, ResponsePushTag, ResponseRebase, ResponseReflog, ResponseRenameBranch,
	ResponseRepoStatistics, ResponseResetFileToRevision, ResponseResetToCommit, ResponseRevertCommit,
	ResponseSetGlobalSetting, ResponseSetGlobalViewState, ResponseSetInterfaceLanguage, ResponseSetWorkspaceViewState,
	ResponseStartCodeReview, ResponseTagDetails, ResponseUndoLastCommit, ResponseUpdateCodeReview, ResponseViewDiff,
	ResponseViewDiffWithWorkingFile, ResponseViewFileAtRevision, ResponseViewScm, ResponseWorktreeAdd, ResponseWorktreeList,
	ResponseWorktreePrune, ResponseWorktreeRemove
} from '../../types';

/**
 * The host↔webview protocol of the Git Graph main view, in the RequestMap form of
 * REFACTOR-PLAN §3.2 (task 4.1): each request command is declared exactly once, together with
 * the request it receives and the response the host sends back.
 *
 * This module is a mechanical typing layer over the existing contract; `src/types/messages.ts`
 * (re-exported by the webview through `src/webview/common/protocol.ts`) stays the runtime truth.
 * Every entry's `req` IS the corresponding `Request*` interface and every non-silent entry's
 * `res` IS the corresponding `Response*` interface, which the compile-time assertions at the
 * bottom of this file prove — so the two definitions cannot drift apart silently. Task 4.2's
 * handler table is declared against `RequestCommand`, and task 5.2's webview bridge will send
 * `send<K extends RequestCommand>(cmd: K, req: ...)`.
 */

/**
 * Requests whose handler sends no response at all (it only performs an effect: opening another
 * view, writing persisted state, ...). Their `res` is `void`.
 */
export type SilentCommand =
	| 'endCodeReview'
	| 'openCompareTab'
	| 'rescanForRepos'
	| 'setRepoState'
	| 'setViewSnapshot'
	| 'showErrorMessage'
	| 'viewDiffBinary';

export interface GraphViewRequests {
	readonly abortOperation: { readonly req: RequestAbortOperation; readonly res: ResponseAbortOperation };
	readonly addRemote: { readonly req: RequestAddRemote; readonly res: ResponseAddRemote };
	readonly addTag: { readonly req: RequestAddTag; readonly res: ResponseAddTag };
	readonly applyStash: { readonly req: RequestApplyStash; readonly res: ResponseApplyStash };
	readonly branchFromStash: { readonly req: RequestBranchFromStash; readonly res: ResponseBranchFromStash };
	readonly checkoutBranch: { readonly req: RequestCheckoutBranch; readonly res: ResponseCheckoutBranch };
	readonly checkoutCommit: { readonly req: RequestCheckoutCommit; readonly res: ResponseCheckoutCommit };
	readonly cherrypickCommit: { readonly req: RequestCherrypickCommit; readonly res: ResponseCherrypickCommit };
	readonly cleanUntrackedFiles: { readonly req: RequestCleanUntrackedFiles; readonly res: ResponseCleanUntrackedFiles };
	readonly commitBodies: { readonly req: RequestCommitBodies; readonly res: ResponseCommitBodies };
	readonly commitDetails: { readonly req: RequestCommitDetails; readonly res: ResponseCommitDetails };
	readonly commitFileCounts: { readonly req: RequestCommitFileCounts; readonly res: ResponseCommitFileCounts };
	readonly commitFixup: { readonly req: RequestCommitFixup; readonly res: ResponseCommitFixup };
	readonly commitSquash: { readonly req: RequestCommitSquash; readonly res: ResponseCommitSquash };
	readonly compareCommits: { readonly req: RequestCompareCommits; readonly res: ResponseCompareCommits };
	readonly continueOperation: { readonly req: RequestContinueOperation; readonly res: ResponseContinueOperation };
	readonly copyFilePath: { readonly req: RequestCopyFilePath; readonly res: ResponseCopyFilePath };
	readonly copyToClipboard: { readonly req: RequestCopyToClipboard; readonly res: ResponseCopyToClipboard };
	readonly countCommitsBefore: { readonly req: RequestCountCommitsBefore; readonly res: ResponseCountCommitsBefore };
	readonly createArchive: { readonly req: RequestCreateArchive; readonly res: ResponseCreateArchive };
	readonly createBranch: { readonly req: RequestCreateBranch; readonly res: ResponseCreateBranch };
	readonly createPullRequest: { readonly req: RequestCreatePullRequest; readonly res: ResponseCreatePullRequest };
	readonly deleteBranch: { readonly req: RequestDeleteBranch; readonly res: ResponseDeleteBranch };
	readonly deleteRemote: { readonly req: RequestDeleteRemote; readonly res: ResponseDeleteRemote };
	readonly deleteRemoteBranch: { readonly req: RequestDeleteRemoteBranch; readonly res: ResponseDeleteRemoteBranch };
	readonly deleteTag: { readonly req: RequestDeleteTag; readonly res: ResponseDeleteTag };
	readonly deleteUserDetails: { readonly req: RequestDeleteUserDetails; readonly res: ResponseDeleteUserDetails };
	readonly dropCommit: { readonly req: RequestDropCommit; readonly res: ResponseDropCommit };
	readonly dropStash: { readonly req: RequestDropStash; readonly res: ResponseDropStash };
	readonly editCommitMessage: { readonly req: RequestEditCommitMessage; readonly res: ResponseEditCommitMessage };
	readonly editRemote: { readonly req: RequestEditRemote; readonly res: ResponseEditRemote };
	readonly editUserDetails: { readonly req: RequestEditUserDetails; readonly res: ResponseEditUserDetails };
	readonly endCodeReview: { readonly req: RequestEndCodeReview; readonly res: void };
	readonly exportRepoConfig: { readonly req: RequestExportRepoConfig; readonly res: ResponseExportRepoConfig };
	readonly fetch: { readonly req: RequestFetch; readonly res: ResponseFetch };
	readonly fetchAvatar: { readonly req: RequestFetchAvatar; readonly res: ResponseFetchAvatar };
	readonly fetchIntoLocalBranch: { readonly req: RequestFetchIntoLocalBranch; readonly res: ResponseFetchIntoLocalBranch };
	readonly fetchPullRequest: { readonly req: RequestFetchPullRequest; readonly res: ResponsePullRequestStatus };
	readonly gerritSetFetchRefs: { readonly req: RequestGerritSetFetchRefs; readonly res: ResponseGerritSetFetchRefs };
	readonly loadCommits: { readonly req: RequestLoadCommits; readonly res: ResponseLoadCommits };
	readonly loadConfig: { readonly req: RequestLoadConfig; readonly res: ResponseLoadConfig };
	readonly loadRepoInfo: { readonly req: RequestLoadRepoInfo; readonly res: ResponseLoadRepoInfo };
	readonly loadRepos: { readonly req: RequestLoadRepos; readonly res: ResponseLoadRepos };
	readonly merge: { readonly req: RequestMerge; readonly res: ResponseMerge };
	readonly openCompareTab: { readonly req: RequestOpenCompareTab; readonly res: void };
	readonly openExtensionSettings: { readonly req: RequestOpenExtensionSettings; readonly res: ResponseOpenExtensionSettings };
	readonly openExternalDirDiff: { readonly req: RequestOpenExternalDirDiff; readonly res: ResponseOpenExternalDirDiff };
	readonly openExternalUrl: { readonly req: RequestOpenExternalUrl; readonly res: ResponseOpenExternalUrl };
	readonly openFile: { readonly req: RequestOpenFile; readonly res: ResponseOpenFile };
	readonly openLogFile: { readonly req: RequestOpenLogFile; readonly res: ResponseOpenLogFile };
	readonly openTerminal: { readonly req: RequestOpenTerminal; readonly res: ResponseOpenTerminal };
	readonly popStash: { readonly req: RequestPopStash; readonly res: ResponsePopStash };
	readonly predictConflicts: { readonly req: RequestPredictConflicts; readonly res: ResponsePredictConflicts };
	readonly pruneRemote: { readonly req: RequestPruneRemote; readonly res: ResponsePruneRemote };
	readonly pullBranch: { readonly req: RequestPullBranch; readonly res: ResponsePullBranch };
	readonly pushBranch: { readonly req: RequestPushBranch; readonly res: ResponsePushBranch };
	readonly pushStash: { readonly req: RequestPushStash; readonly res: ResponsePushStash };
	readonly pushTag: { readonly req: RequestPushTag; readonly res: ResponsePushTag };
	readonly rebase: { readonly req: RequestRebase; readonly res: ResponseRebase };
	readonly reflog: { readonly req: RequestReflog; readonly res: ResponseReflog };
	readonly renameBranch: { readonly req: RequestRenameBranch; readonly res: ResponseRenameBranch };
	readonly repoStatistics: { readonly req: RequestRepoStatistics; readonly res: ResponseRepoStatistics };
	readonly rescanForRepos: { readonly req: RequestRescanForRepos; readonly res: void };
	readonly resetFileToRevision: { readonly req: RequestResetFileToRevision; readonly res: ResponseResetFileToRevision };
	readonly resetToCommit: { readonly req: RequestResetToCommit; readonly res: ResponseResetToCommit };
	readonly revertCommit: { readonly req: RequestRevertCommit; readonly res: ResponseRevertCommit };
	readonly setGlobalSetting: { readonly req: RequestSetGlobalSetting; readonly res: ResponseSetGlobalSetting };
	readonly setGlobalViewState: { readonly req: RequestSetGlobalViewState; readonly res: ResponseSetGlobalViewState };
	readonly setInterfaceLanguage: { readonly req: RequestSetInterfaceLanguage; readonly res: ResponseSetInterfaceLanguage };
	readonly setRepoState: { readonly req: RequestSetRepoState; readonly res: void };
	readonly setViewSnapshot: { readonly req: RequestSetViewSnapshot; readonly res: void };
	readonly setWorkspaceViewState: { readonly req: RequestSetWorkspaceViewState; readonly res: ResponseSetWorkspaceViewState };
	readonly showErrorMessage: { readonly req: RequestShowErrorDialog; readonly res: void };
	readonly startCodeReview: { readonly req: RequestStartCodeReview; readonly res: ResponseStartCodeReview };
	readonly tagDetails: { readonly req: RequestTagDetails; readonly res: ResponseTagDetails };
	readonly undoLastCommit: { readonly req: RequestUndoLastCommit; readonly res: ResponseUndoLastCommit };
	readonly updateCodeReview: { readonly req: RequestUpdateCodeReview; readonly res: ResponseUpdateCodeReview };
	readonly viewDiff: { readonly req: RequestViewDiff; readonly res: ResponseViewDiff };
	readonly viewDiffBinary: { readonly req: RequestViewDiffBinary; readonly res: void };
	readonly viewDiffWithWorkingFile: { readonly req: RequestViewDiffWithWorkingFile; readonly res: ResponseViewDiffWithWorkingFile };
	readonly viewFileAtRevision: { readonly req: RequestViewFileAtRevision; readonly res: ResponseViewFileAtRevision };
	readonly viewScm: { readonly req: RequestViewScm; readonly res: ResponseViewScm };
	readonly worktreeAdd: { readonly req: RequestWorktreeAdd; readonly res: ResponseWorktreeAdd };
	readonly worktreeList: { readonly req: RequestWorktreeList; readonly res: ResponseWorktreeList };
	readonly worktreePrune: { readonly req: RequestWorktreePrune; readonly res: ResponseWorktreePrune };
	readonly worktreeRemove: { readonly req: RequestWorktreeRemove; readonly res: ResponseWorktreeRemove };
}

/** Every request command the webview can send to the host of the Git Graph main view. */
export type RequestCommand = keyof GraphViewRequests;

/** Every response command the host can send to the webview of the Git Graph main view. */
export type ResponseCommand = ResponseMessage['command'];

/**
 * The response command a request settles with: the command itself, except for the two
 * asynchronous mismatches (`fetchPullRequest` answers as `pullRequestStatus`) and the silent
 * commands (no response at all).
 */
export type ResponseCommandOf<K extends RequestCommand> =
	K extends 'fetchPullRequest' ? 'pullRequestStatus'
	: K extends SilentCommand ? never
	: K;

/**
 * Every request command, as a runtime list. The compile-time assertion below ties it to
 * `RequestCommand` exactly, so a command added to the protocol without an entry here (or vice
 * versa) fails compilation, and the runtime tests compare it with the other runtime tables.
 */
export const REQUEST_COMMANDS: ReadonlyArray<RequestCommand> = [
	'abortOperation', 'addRemote', 'addTag', 'applyStash', 'branchFromStash', 'checkoutBranch', 'checkoutCommit',
	'cherrypickCommit', 'cleanUntrackedFiles', 'commitBodies', 'commitDetails', 'commitFileCounts', 'commitFixup',
	'commitSquash', 'compareCommits', 'continueOperation', 'copyFilePath', 'copyToClipboard', 'countCommitsBefore',
	'createArchive', 'createBranch', 'createPullRequest', 'deleteBranch', 'deleteRemote', 'deleteRemoteBranch',
	'deleteTag', 'deleteUserDetails', 'dropCommit', 'dropStash', 'editCommitMessage', 'editRemote', 'editUserDetails',
	'endCodeReview', 'exportRepoConfig', 'fetch', 'fetchAvatar', 'fetchIntoLocalBranch', 'fetchPullRequest',
	'gerritSetFetchRefs', 'loadCommits', 'loadConfig', 'loadRepoInfo', 'loadRepos', 'merge', 'openCompareTab',
	'openExtensionSettings', 'openExternalDirDiff', 'openExternalUrl', 'openFile', 'openLogFile', 'openTerminal',
	'popStash', 'predictConflicts', 'pruneRemote', 'pullBranch', 'pushBranch', 'pushStash', 'pushTag', 'rebase',
	'reflog', 'renameBranch', 'repoStatistics', 'rescanForRepos', 'resetFileToRevision', 'resetToCommit',
	'revertCommit', 'setGlobalSetting', 'setGlobalViewState', 'setInterfaceLanguage', 'setRepoState',
	'setViewSnapshot', 'setWorkspaceViewState', 'showErrorMessage', 'startCodeReview', 'tagDetails', 'undoLastCommit',
	'updateCodeReview', 'viewDiff', 'viewDiffBinary', 'viewDiffWithWorkingFile', 'viewFileAtRevision', 'viewScm',
	'worktreeAdd', 'worktreeList', 'worktreePrune', 'worktreeRemove'
];

/**
 * Whether each request's handler can modify the repository (its HEAD, refs, stash, index,
 * working tree or Git config) — the parallel definition of `GitGraphView.REPO_MUTATING_COMMANDS`
 * (src/gitGraphView.ts), which stays in place until task 4.2 wires this table into the message
 * dispatch and deletes the old set. Handlers run with the RepoFileWatcher muted, so these
 * commands must also invalidate the commit cache directly (see respondToMessage).
 */
export const MUTATING_COMMANDS: { readonly [K in RequestCommand]: boolean } = {
	abortOperation: true,
	addRemote: true,
	addTag: true,
	applyStash: true,
	branchFromStash: true,
	checkoutBranch: true,
	checkoutCommit: true,
	cherrypickCommit: true,
	cleanUntrackedFiles: true,
	commitBodies: false,
	commitDetails: false,
	commitFileCounts: false,
	commitFixup: true,
	commitSquash: true,
	compareCommits: false,
	continueOperation: true,
	copyFilePath: false,
	copyToClipboard: false,
	countCommitsBefore: false,
	createArchive: false,
	createBranch: true,
	createPullRequest: true,
	deleteBranch: true,
	deleteRemote: true,
	deleteRemoteBranch: true,
	deleteTag: true,
	deleteUserDetails: false,
	dropCommit: true,
	dropStash: true,
	editCommitMessage: true,
	editRemote: true,
	editUserDetails: true,
	endCodeReview: false,
	exportRepoConfig: false,
	fetch: true,
	fetchAvatar: false,
	fetchIntoLocalBranch: true,
	fetchPullRequest: false,
	gerritSetFetchRefs: true,
	loadCommits: false,
	loadConfig: false,
	loadRepoInfo: false,
	loadRepos: false,
	merge: true,
	openCompareTab: false,
	openExtensionSettings: false,
	openExternalDirDiff: false,
	openExternalUrl: false,
	openFile: false,
	openLogFile: false,
	openTerminal: false,
	popStash: true,
	predictConflicts: false,
	pruneRemote: true,
	pullBranch: true,
	pushBranch: true,
	pushStash: true,
	pushTag: true,
	rebase: true,
	reflog: false,
	renameBranch: true,
	repoStatistics: false,
	rescanForRepos: false,
	resetFileToRevision: true,
	resetToCommit: true,
	revertCommit: true,
	setGlobalSetting: false,
	setGlobalViewState: false,
	setInterfaceLanguage: false,
	setRepoState: false,
	setViewSnapshot: false,
	setWorkspaceViewState: false,
	showErrorMessage: false,
	startCodeReview: false,
	tagDetails: false,
	undoLastCommit: true,
	updateCodeReview: false,
	viewDiff: false,
	viewDiffBinary: false,
	viewDiffWithWorkingFile: false,
	viewFileAtRevision: false,
	viewScm: false,
	worktreeAdd: true,
	worktreeList: false,
	worktreePrune: true,
	worktreeRemove: true
};

/* Compile-time contract guards: fail `tsc` when this map and src/types/messages.ts drift apart. */

/** Type-level equality (mutual identity, stronger than mutual assignability). */
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type AssertTrue<T extends true> = T;

/** The RequestMap covers every RequestMessage command, exactly, in both directions. */
export type AssertRequestCoverage = AssertTrue<Eq<RequestCommand, RequestMessage['command']>>;

/** Every entry's `req` is exactly the request interface messages.ts declares for that command. */
export type AssertRequestParity = AssertTrue<
	{ [K in RequestCommand]: Eq<GraphViewRequests[K]['req'], Extract<RequestMessage, { command: K }>> }[RequestCommand]
>;

/** Every entry's `res` is exactly the response interface the host sends for that command (`void` when silent). */
export type AssertResponseParity = AssertTrue<
	{
		[K in RequestCommand]: ResponseCommandOf<K> extends never
			? Eq<GraphViewRequests[K]['res'], void>
			: Eq<GraphViewRequests[K]['res'], Extract<ResponseMessage, { command: ResponseCommandOf<K> }>>
	}[RequestCommand]
>;

/** REQUEST_COMMANDS lists every request command, exactly (so runtime tables cannot go stale either). */
export type AssertCommandListParity = AssertTrue<Eq<RequestCommand, (typeof REQUEST_COMMANDS)[number]>>;

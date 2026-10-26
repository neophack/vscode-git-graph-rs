/**
 * The base shapes and the two wire unions of the Git Graph view protocol (the former
 * src/types/messages.ts): every request/response interface lives in the domain module that
 * mirrors its host handler (loading, branches, commits, commitDetails, ...), and this module
 * keeps the shared envelopes (BaseMessage, the RepoRequest/Response error shapes, the
 * data-loss warning pair) plus the RequestMessage/ResponseMessage unions that aggregate the
 * domain members. Declarations moved verbatim; task 4.1 folds the protocol into
 * src/shared/protocol, split by domain.
 */

/* Base Interfaces for Request / Response Messages */

export interface BaseMessage {
	readonly command: string;
}

export interface RepoRequest extends BaseMessage {
	readonly repo: string;
}

export interface ResponseWithErrorInfo extends BaseMessage {
	readonly error: ErrorInfo;
}

export interface ResponseWithMultiErrorInfo extends BaseMessage {
	readonly errors: ErrorInfo[];
}


/**
 * A data-loss warning an action returns instead of running: the view shows it through its
 * standard warning dialog (the mascot image above the message), and re-sends the action with
 * its confirmed flag set once the user insists.
 */
export interface LossWarning {
	/** The localised warning text. */
	readonly message: string;
}

/**
 * A data-loss warning for the view: the standard warning dialog shows `message`; confirming
 * re-sends `retry` — the original request with `confirmed` set.
 */
export interface ResponseLossWarning {
	readonly command: 'lossWarning';
	readonly message: string;
	readonly retry: RequestMessage;
}
export type ErrorInfo = string | null; // null => no error, otherwise => error message

export const enum ErrorInfoExtensionPrefix {
	PushTagCommitNotOnRemote = 'VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:'
}

/** The request and response unions aggregate the domain modules verbatim. */
import type { RequestCheckoutBranch, RequestCreateBranch, RequestDeleteBranch, RequestDeleteRemoteBranch, RequestFetchIntoLocalBranch, RequestRenameBranch, ResponseCheckoutBranch, ResponseCreateBranch, ResponseDeleteBranch, ResponseDeleteRemoteBranch, ResponseFetchIntoLocalBranch, ResponseRenameBranch } from './branches';
import type { RequestEndCodeReview, RequestStartCodeReview, RequestUpdateCodeReview, ResponseStartCodeReview, ResponseUpdateCodeReview } from './codeReview';
import type { RequestCommitDetails, RequestCommitFileCounts, RequestCompareCommits, ResponseCompareCommits, ResponseCommitDetails, ResponseCommitFileCounts } from './commitDetails';
import type { RequestCheckoutCommit, RequestCherrypickCommit, RequestCommitFixup, RequestCommitSquash, RequestDropCommit, RequestUndoLastCommit, RequestEditCommitMessage, RequestResetFileToRevision, RequestResetToCommit, RequestRevertCommit, ResponseCheckoutCommit, ResponseCherrypickCommit, ResponseCommitFixup, ResponseCommitSquash, ResponseDropCommit, ResponseUndoLastCommit, ResponseEditCommitMessage, ResponseResetFileToRevision, ResponseResetToCommit, ResponseRevertCommit } from './commits';
import type { RequestCopyFilePath, RequestCopyToClipboard, RequestCreateArchive, RequestOpenExternalDirDiff, RequestOpenCompareTab, RequestOpenFile, RequestViewDiff, RequestViewDiffBinary, RequestViewDiffWithWorkingFile, RequestViewFileAtRevision, ResponseCopyFilePath, ResponseCopyToClipboard, ResponseCreateArchive, ResponseOpenExternalDirDiff, ResponseOpenFile, ResponseViewDiff, ResponseViewDiffWithWorkingFile, ResponseViewFileAtRevision } from './files';
import type { RequestGerritSetFetchRefs, RequestFetchPullRequest, ResponseGerritSetFetchRefs, ResponsePullRequestStatus } from './gerrit';
import type { RequestCountCommitsBefore, RequestCommitBodies, RequestFetchAvatar, RequestLoadCommits, RequestLoadConfig, RequestLoadRepoInfo, RequestLoadView, RequestReady, RequestReflog, RequestRepoStatistics, ResponseCountCommitsBefore, ResponseCommitBodies, ResponseFetchAvatar, ResponseLoadCommits, ResponseLoadConfig, ResponseLoadRepoInfo, ResponseLoadView, ResponseReflog, ResponseRepoStatistics } from './loading';
import type { RequestExportRepoConfig, RequestLoadRepos, RequestOpenExternalUrl, RequestOpenTerminal, RequestRescanForRepos, RequestShowErrorDialog, RequestViewScm, ResponseExportRepoConfig, ResponseLoadRepos, ResponseOpenExternalUrl, ResponseOpenTerminal, ResponseRefresh, ResponseViewScm } from './misc';
import type { RequestAbortOperation, RequestCleanUntrackedFiles, RequestContinueOperation, RequestCreatePullRequest, RequestMerge, RequestPredictConflicts, RequestRebase, ResponseAbortOperation, ResponseCleanUntrackedFiles, ResponseContinueOperation, ResponseCreatePullRequest, ResponseMerge, ResponsePredictConflicts, ResponseRebase } from './operations';
import type { RequestAddRemote, RequestDeleteRemote, RequestEditRemote, RequestFetch, RequestPruneRemote, RequestPullBranch, RequestPushBranch, ResponseAddRemote, ResponseDeleteRemote, ResponseEditRemote, ResponseFetch, ResponsePruneRemote, ResponsePullBranch, ResponsePushBranch } from './remotes';
import type { RequestDeleteUserDetails, RequestEditUserDetails, RequestOpenExtensionSettings, RequestOpenLogFile, RequestSetGlobalViewState, RequestSetRepoState, RequestSetViewSnapshot, RequestSetWorkspaceViewState, RequestSetGlobalSetting, RequestSetInterfaceLanguage, ResponseConfigChanged, ResponseDeleteUserDetails, ResponseEditUserDetails, ResponseOpenExtensionSettings, ResponseOpenLogFile, ResponseSetGlobalViewState, ResponseSetWorkspaceViewState, ResponseSetGlobalSetting, ResponseSetInterfaceLanguage } from './settings';
import type { RequestApplyStash, RequestBranchFromStash, RequestDropStash, RequestPopStash, RequestPushStash, ResponseApplyStash, ResponseBranchFromStash, ResponseDropStash, ResponsePopStash, ResponsePushStash } from './stash';
import type { RequestAddTag, RequestDeleteTag, RequestPushTag, RequestTagDetails, ResponseAddTag, ResponseDeleteTag, ResponsePushTag, ResponseTagDetails } from './tags';
import type { RequestWorktreeList, RequestWorktreeAdd, RequestWorktreeRemove, RequestWorktreePrune, ResponseWorktreeList, ResponseWorktreeAdd, ResponseWorktreeRemove, ResponseWorktreePrune } from './worktrees';

export type RequestMessage =
	RequestAbortOperation
	| RequestAddRemote
	| RequestAddTag
	| RequestApplyStash
	| RequestBranchFromStash
	| RequestCheckoutBranch
	| RequestCheckoutCommit
	| RequestCherrypickCommit
	| RequestCleanUntrackedFiles
	| RequestCommitFixup
	| RequestCommitSquash
	| RequestContinueOperation
	| RequestCountCommitsBefore
	| RequestCommitBodies
	| RequestCommitDetails
	| RequestCommitFileCounts
	| RequestCompareCommits
	| RequestCopyFilePath
	| RequestCopyToClipboard
	| RequestCreateArchive
	| RequestCreateBranch
	| RequestCreatePullRequest
	| RequestDeleteBranch
	| RequestDeleteRemote
	| RequestDeleteRemoteBranch
	| RequestDeleteTag
	| RequestDeleteUserDetails
	| RequestDropCommit
	| RequestDropStash
	| RequestUndoLastCommit
	| RequestEditCommitMessage
	| RequestEditRemote
	| RequestEditUserDetails
	| RequestEndCodeReview
	| RequestExportRepoConfig
	| RequestFetch
	| RequestFetchAvatar
	| RequestFetchIntoLocalBranch
	| RequestGerritSetFetchRefs
	| RequestLoadCommits
	| RequestLoadConfig
	| RequestLoadRepoInfo
	| RequestLoadRepos
	| RequestLoadView
	| RequestReady
	| RequestMerge
	| RequestOpenExtensionSettings
	| RequestOpenExternalDirDiff
	| RequestOpenExternalUrl
	| RequestOpenCompareTab
	| RequestOpenFile
	| RequestOpenLogFile
	| RequestOpenTerminal
	| RequestPopStash
	| RequestPredictConflicts
	| RequestPruneRemote
	| RequestPullBranch
	| RequestPushBranch
	| RequestPushStash
	| RequestPushTag
	| RequestRebase
	| RequestReflog
	| RequestRenameBranch
	| RequestRescanForRepos
	| RequestResetFileToRevision
	| RequestResetToCommit
	| RequestRevertCommit
	| RequestSetGlobalViewState
	| RequestSetRepoState
	| RequestSetViewSnapshot
	| RequestSetWorkspaceViewState
	| RequestShowErrorDialog
	| RequestStartCodeReview
	| RequestTagDetails
	| RequestUpdateCodeReview
	| RequestViewDiff
	| RequestViewDiffBinary
	| RequestViewDiffWithWorkingFile
	| RequestViewFileAtRevision
	| RequestViewScm
	| RequestFetchPullRequest
	| RequestSetGlobalSetting
	| RequestSetInterfaceLanguage
	| RequestRepoStatistics
	| RequestWorktreeList
	| RequestWorktreeAdd
	| RequestWorktreeRemove
	| RequestWorktreePrune;

export type ResponseMessage =
	ResponseAbortOperation
	| ResponseAddRemote
	| ResponseAddTag
	| ResponseLossWarning
	| ResponseApplyStash
	| ResponseBranchFromStash
	| ResponseCheckoutBranch
	| ResponseCheckoutCommit
	| ResponseCherrypickCommit
	| ResponseCleanUntrackedFiles
	| ResponseCommitFixup
	| ResponseCommitSquash
	| ResponseContinueOperation
	| ResponseCountCommitsBefore
	| ResponseCompareCommits
	| ResponseCommitBodies
	| ResponseCommitDetails
	| ResponseCommitFileCounts
	| ResponseConfigChanged
	| ResponseCopyFilePath
	| ResponseCopyToClipboard
	| ResponseCreateArchive
	| ResponseCreateBranch
	| ResponseCreatePullRequest
	| ResponseDeleteBranch
	| ResponseDeleteRemote
	| ResponseDeleteRemoteBranch
	| ResponseDeleteTag
	| ResponseDeleteUserDetails
	| ResponseDropCommit
	| ResponseDropStash
	| ResponseUndoLastCommit
	| ResponseEditCommitMessage
	| ResponseEditRemote
	| ResponseEditUserDetails
	| ResponseExportRepoConfig
	| ResponseFetch
	| ResponseFetchAvatar
	| ResponseFetchIntoLocalBranch
	| ResponseGerritSetFetchRefs
	| ResponseLoadCommits
	| ResponseLoadConfig
	| ResponseLoadRepoInfo
	| ResponseLoadRepos
	| ResponseLoadView
	| ResponseMerge
	| ResponseOpenExtensionSettings
	| ResponseOpenExternalDirDiff
	| ResponseOpenExternalUrl
	| ResponseOpenFile
	| ResponseOpenLogFile
	| ResponseOpenTerminal
	| ResponsePopStash
	| ResponsePredictConflicts
	| ResponsePruneRemote
	| ResponsePullBranch
	| ResponsePushBranch
	| ResponsePushStash
	| ResponsePushTag
	| ResponseRebase
	| ResponseRefresh
	| ResponseReflog
	| ResponseRenameBranch
	| ResponseResetFileToRevision
	| ResponseResetToCommit
	| ResponseRevertCommit
	| ResponseSetGlobalViewState
	| ResponseSetWorkspaceViewState
	| ResponseStartCodeReview
	| ResponseTagDetails
	| ResponseUpdateCodeReview
	| ResponseViewDiff
	| ResponseViewDiffWithWorkingFile
	| ResponseViewFileAtRevision
	| ResponseViewScm
	| ResponsePullRequestStatus
	| ResponseSetGlobalSetting
	| ResponseSetInterfaceLanguage
	| ResponseRepoStatistics
	| ResponseWorktreeList
	| ResponseWorktreeAdd
	| ResponseWorktreeRemove
	| ResponseWorktreePrune;

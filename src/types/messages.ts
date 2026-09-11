import type { GerritChangeState, GerritStatusFilter } from './gerrit';
import type {
	GitCommit, GitCommitDetails, GitCommitStash,
	GitConfigLocation, GitFileChange, GitFileStatus, GitLineCounts, GitPushBranchMode, GitRepoConfig,
	GitResetMode, GitStash, GitTagDetails
} from './git';
import type { PullRequestConfig, PullRequestInfo } from './pullRequest';
import type { CodeReview, GitRepoSet, GitRepoState } from './repoState';
import type {
	CommitAuthor, CommitOrdering, GitGraphViewConfig, GitGraphViewGlobalState, GitGraphViewWorkspaceState,
	LoadGitGraphViewTo, TagType
} from './webview';

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

/* Request / Response Messages */

export interface RequestAddRemote extends RepoRequest {
	readonly command: 'addRemote';
	readonly name: string;
	readonly url: string;
	readonly pushUrl: string | null;
	readonly fetch: boolean;
}
export interface ResponseAddRemote extends ResponseWithErrorInfo {
	readonly command: 'addRemote';
}

export interface RequestAddTag extends RepoRequest {
	readonly command: 'addTag';
	readonly commitHash: string;
	readonly tagName: string;
	readonly type: TagType;
	readonly message: string;
	readonly pushToRemote: string | null; // string => name of the remote to push the tag to, null => don't push to a remote
	readonly pushSkipRemoteCheck: boolean;
	readonly force: boolean;
}
export interface ResponseAddTag extends ResponseWithMultiErrorInfo {
	readonly command: 'addTag';
	readonly repo: string;
	readonly tagName: string;
	readonly pushToRemote: string | null;
	readonly commitHash: string;
}

export interface RequestApplyStash extends RepoRequest {
	readonly command: 'applyStash';
	readonly selector: string;
	readonly reinstateIndex: boolean;
}
export interface ResponseApplyStash extends ResponseWithErrorInfo {
	readonly command: 'applyStash';
}

export interface RequestBranchFromStash extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'branchFromStash';
	readonly selector: string;
	readonly branchName: string;
}
export interface ResponseBranchFromStash extends ResponseWithErrorInfo {
	readonly command: 'branchFromStash';
}

export interface RequestCheckoutBranch extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'checkoutBranch';
	readonly branchName: string;
	readonly remoteBranch: string | null;
	readonly pullAfterwards: {
		readonly branchName: string;
		readonly remote: string;
		readonly createNewCommit: boolean;
		readonly squash: boolean;
	} | null; // NULL => Don't pull after checking out
}
export interface ResponseCheckoutBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'checkoutBranch';
	readonly pullAfterwards: {
		readonly branchName: string;
		readonly remote: string;
	} | null; // NULL => Don't pull after checking out
}

export interface RequestCheckoutCommit extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'checkoutCommit';
	readonly commitHash: string;
}
export interface ResponseCheckoutCommit extends ResponseWithErrorInfo {
	readonly command: 'checkoutCommit';
}

export interface RequestCherrypickCommit extends RepoRequest {
	readonly command: 'cherrypickCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
	readonly recordOrigin: boolean;
	readonly noCommit: boolean;
}
export interface ResponseCherrypickCommit extends ResponseWithMultiErrorInfo {
	readonly command: 'cherrypickCommit';
}

export interface RequestCleanUntrackedFiles extends RepoRequest {
	readonly command: 'cleanUntrackedFiles';
	readonly directories: boolean;
}
export interface ResponseCleanUntrackedFiles extends ResponseWithErrorInfo {
	readonly command: 'cleanUntrackedFiles';
}

export interface RequestCommitDetails extends RepoRequest {
	readonly command: 'commitDetails';
	readonly commitHash: string;
	readonly hasParents: boolean;
	readonly stash: GitCommitStash | null; // null => request is for a commit, otherwise => request is for a stash
	readonly avatarEmail: string | null; // string => fetch avatar with the given email, null => don't fetch avatar
	readonly refresh: boolean;
}
export interface ResponseCommitDetails extends ResponseWithErrorInfo {
	readonly command: 'commitDetails';
	readonly commitDetails: GitCommitDetails | null;
	readonly avatar: string | null;
	readonly codeReview: CodeReview | null;
	readonly refresh: boolean;
}

/**
 * The line counts of specific files of the open Commit Details / Commit Comparison view, which
 * computes its file list first and settles the `+N/-M` counts progressively — the visible files
 * first, then the rest in the background.
 */
export interface RequestCommitFileCounts extends RepoRequest {
	readonly command: 'commitFileCounts';
	/** The commit open in the view, echoed back so a stale reply can be dropped. */
	readonly commitHash: string;
	/** The second commit of an open comparison, or null when a single commit is open. */
	readonly compareWithHash: string | null;
	/** null => diff `to` against its first parent (a plain commit); string => the diff's left side. */
	readonly from: string | null;
	readonly to: string;
	readonly paths: ReadonlyArray<string>;
}
export interface ResponseCommitFileCounts extends ResponseWithErrorInfo {
	readonly command: 'commitFileCounts';
	readonly commitHash: string;
	readonly compareWithHash: string | null;
	readonly counts: { [path: string]: GitLineCounts };
}

export interface RequestCommitBodies extends RepoRequest {
	readonly command: 'commitBodies';
	readonly commitHashes: ReadonlyArray<string>;
}
export interface ResponseCommitBodies {
	readonly command: 'commitBodies';
	readonly bodies: { [hash: string]: string };
}

export interface RequestCompareCommits extends RepoRequest {
	readonly command: 'compareCommits';
	readonly commitHash: string;
	readonly compareWithHash: string;
	readonly fromHash: string;
	readonly toHash: string;
	readonly refresh: boolean;
}
export interface ResponseCompareCommits extends ResponseWithErrorInfo {
	readonly command: 'compareCommits';
	readonly commitHash: string;
	readonly compareWithHash: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
	readonly codeReview: CodeReview | null;
	readonly refresh: boolean;
}

export interface RequestCopyFilePath extends RepoRequest {
	readonly command: 'copyFilePath';
	readonly filePath: string;
	readonly absolute: boolean;
}
export interface ResponseCopyFilePath extends ResponseWithErrorInfo {
	readonly command: 'copyFilePath';
}

export interface RequestCopyToClipboard extends BaseMessage {
	readonly command: 'copyToClipboard';
	readonly type: string;
	readonly data: string;
}
export interface ResponseCopyToClipboard extends ResponseWithErrorInfo {
	readonly command: 'copyToClipboard';
	readonly type: string;
}

export interface RequestCreateArchive extends RepoRequest {
	readonly command: 'createArchive';
	readonly ref: string;
}
export interface ResponseCreateArchive extends ResponseWithErrorInfo {
	readonly command: 'createArchive';
}

export interface RequestCreateBranch extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'createBranch';
	readonly commitHash: string;
	readonly branchName: string;
	readonly checkout: boolean;
	readonly force: boolean;
}
export interface ResponseCreateBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'createBranch';
}

export interface RequestCreatePullRequest extends RepoRequest {
	readonly command: 'createPullRequest';
	readonly config: PullRequestConfig;
	readonly sourceRemote: string;
	readonly sourceOwner: string;
	readonly sourceRepo: string;
	readonly sourceBranch: string;
	readonly push: boolean;
}
export interface ResponseCreatePullRequest extends ResponseWithMultiErrorInfo {
	readonly command: 'createPullRequest';
	readonly push: boolean;
}

export interface RequestDeleteBranch extends RepoRequest {
	readonly command: 'deleteBranch';
	readonly branchName: string;
	readonly forceDelete: boolean;
	readonly deleteOnRemotes: ReadonlyArray<string>;
}
export interface ResponseDeleteBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteBranch';
	readonly repo: string;
	readonly branchName: string;
	readonly deleteOnRemotes: ReadonlyArray<string>;
}

export interface RequestDeleteRemote extends RepoRequest {
	readonly command: 'deleteRemote';
	readonly name: string;
}
export interface ResponseDeleteRemote extends ResponseWithErrorInfo {
	readonly command: 'deleteRemote';
}

export interface RequestDeleteRemoteBranch extends RepoRequest {
	readonly command: 'deleteRemoteBranch';
	readonly branchName: string;
	readonly remote: string;
}
export interface ResponseDeleteRemoteBranch extends ResponseWithErrorInfo {
	readonly command: 'deleteRemoteBranch';
}

export interface RequestDeleteTag extends RepoRequest {
	readonly command: 'deleteTag';
	readonly tagName: string;
	readonly deleteOnRemote: string | null; // null => don't delete on remote, otherwise => remote to delete on
}
export interface ResponseDeleteTag extends ResponseWithErrorInfo {
	readonly command: 'deleteTag';
}

export interface RequestDeleteUserDetails extends RepoRequest {
	readonly command: 'deleteUserDetails';
	readonly name: boolean; // TRUE => Delete Name, FALSE => Don't Delete Name
	readonly email: boolean; // TRUE => Delete Email, FALSE => Don't Delete Email
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
}
export interface ResponseDeleteUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteUserDetails';
}

export interface RequestDropCommit extends RepoRequest {
	readonly command: 'dropCommit';
	readonly commitHash: string;
}
export interface ResponseDropCommit extends ResponseWithErrorInfo {
	readonly command: 'dropCommit';
}

export interface RequestDropStash extends RepoRequest {
	readonly command: 'dropStash';
	readonly selector: string;
}
export interface ResponseDropStash extends ResponseWithErrorInfo {
	readonly command: 'dropStash';
}

export interface RequestEditRemote extends RepoRequest {
	readonly command: 'editRemote';
	readonly nameOld: string;
	readonly nameNew: string;
	readonly urlOld: string | null;
	readonly urlNew: string | null;
	readonly pushUrlOld: string | null;
	readonly pushUrlNew: string | null;
}
export interface ResponseEditRemote extends ResponseWithErrorInfo {
	readonly command: 'editRemote';
}

export interface RequestEditUserDetails extends RepoRequest {
	readonly command: 'editUserDetails';
	readonly name: string;
	readonly email: string;
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
	readonly deleteLocalName: boolean; // TRUE => Delete Local Name, FALSE => Don't Delete Local Name
	readonly deleteLocalEmail: boolean; // TRUE => Delete Local Email, FALSE => Don't Delete Local Email
}
export interface ResponseEditUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'editUserDetails';
}

export interface RequestEndCodeReview extends RepoRequest {
	readonly command: 'endCodeReview';
	readonly id: string;
}

export interface RequestExportRepoConfig extends RepoRequest {
	readonly command: 'exportRepoConfig';
}
export interface ResponseExportRepoConfig extends ResponseWithErrorInfo {
	readonly command: 'exportRepoConfig';
}

export interface RequestFetch extends RepoRequest {
	readonly command: 'fetch';
	readonly name: string | null; // null => Fetch all remotes
	readonly prune: boolean;
	readonly pruneTags: boolean;
}
export interface ResponseFetch extends ResponseWithErrorInfo {
	readonly command: 'fetch';
}

export interface RequestFetchAvatar extends RepoRequest {
	readonly command: 'fetchAvatar';
	readonly remote: string | null;
	readonly email: string;
	readonly commits: string[];
}
export interface ResponseFetchAvatar extends BaseMessage {
	readonly command: 'fetchAvatar';
	readonly email: string;
	readonly image: string;
}


export interface RequestFetchIntoLocalBranch extends RepoRequest {
	readonly command: 'fetchIntoLocalBranch';
	readonly remote: string;
	readonly remoteBranch: string;
	readonly localBranch: string;
	readonly force: boolean;
}
export interface ResponseFetchIntoLocalBranch extends ResponseWithErrorInfo {
	readonly command: 'fetchIntoLocalBranch';
}

export interface RequestLoadCommits extends RepoRequest {
	readonly command: 'loadCommits';
	readonly refreshId: number;
	readonly hard: boolean; // true => hard refresh (e.g. the Refresh button): the extension host must bypass its commit cache
	readonly branches: ReadonlyArray<string> | null; // null => Show All
	readonly authors: ReadonlyArray<string> | null; // null => Show All
	readonly maxCommits: number;
	readonly showTags: boolean;
	readonly showRemoteBranches: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly commitOrdering: CommitOrdering;
	readonly remotes: ReadonlyArray<string>;
	readonly hideRemotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly gerritFetchRefs: boolean; // false => the Gerrit integration is disabled for this repository
	readonly gerritFetchLimit: number | null; // how many of the most recent changes to fetch (NULL => the gerrit.fetchLimit Extension Setting)
	readonly gerritStatusFilter: GerritStatusFilter; // which change statuses may appear in the graph
	readonly filterPath?: string | null; // only show commits that modified the file(s) at this path (relative to the repository root); null/undefined => no path filter
}
export interface ResponseLoadCommits extends ResponseWithErrorInfo {
	readonly command: 'loadCommits';
	readonly refreshId: number;
	readonly commits: GitCommit[];
	readonly head: string | null;
	readonly tags: string[];
	readonly moreCommitsAvailable: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly gerritStates: GerritChangeState[] | null; // NULL => the Gerrit integration is disabled for this repository
	readonly gerritPending?: boolean; // true => the Gerrit data is still loading asynchronously: a final loadCommits response with the fresh states follows
	readonly uncommittedPending?: boolean; // true => the "Uncommitted Changes" status is still loading asynchronously: a final loadCommits response with the fresh status follows
	readonly uncommittedCount?: number; // the exact "Uncommitted Changes" file count (sent by the final follow-up; absent while pending)
	readonly branches?: ReadonlyArray<string> | null; // the branch name list of the ref scan this page was built from (the complete one once the remote-tracking refs were scanned); absent when the response carries none
}

/**
 * Enable or disable the fetching of Gerrit change refs of a repository. Disabling also deletes
 * the locally fetched change refs (`refs/remotes/<gerrit.remote>/changes/*`), so the change
 * commits disappear from the graph and no further fetches happen until it is enabled again.
 */
export interface RequestGerritSetFetchRefs extends RepoRequest {
	readonly command: 'gerritSetFetchRefs';
	readonly enabled: boolean;
}
export interface ResponseGerritSetFetchRefs extends ResponseWithErrorInfo {
	readonly command: 'gerritSetFetchRefs';
	readonly enabled: boolean;
	readonly cleared: number; // the number of local change refs deleted (0 when enabling)
}

export interface RequestCountCommitsBefore extends RepoRequest {
	readonly command: 'countCommitsBefore';
	readonly hash: string;
	readonly branches: ReadonlyArray<string> | null; // null => Show All
	readonly showRemoteBranches: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
}
export interface ResponseCountCommitsBefore {
	readonly command: 'countCommitsBefore';
	readonly hash: string;
	readonly count: number | null; // null => the hash is unknown to Git in this repository
}

export interface RequestLoadConfig extends RepoRequest {
	readonly command: 'loadConfig';
	readonly remotes: ReadonlyArray<string>;
}
export interface ResponseLoadConfig extends ResponseWithErrorInfo {
	readonly command: 'loadConfig';
	readonly repo: string;
	readonly config: GitRepoConfig | null;
}

export interface RequestLoadRepoInfo extends RepoRequest {
	readonly command: 'loadRepoInfo';
	readonly refreshId: number;
	readonly showRemoteBranches: boolean;
	readonly showStashes: boolean;
	readonly hideRemotes: ReadonlyArray<string>;
}
export interface ResponseLoadRepoInfo extends ResponseWithErrorInfo {
	readonly command: 'loadRepoInfo';
	readonly refreshId: number;
	readonly branches: ReadonlyArray<string>;
	/** The checked-out branch's short name, or null when HEAD is detached. */
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly isRepo: boolean;
	readonly remoteRefsPending?: boolean; // true => the branch list is local-only: the remote-tracking refs are still being scanned and follow with a loadCommits response
}

export interface RequestLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly check: boolean;
}
export interface ResponseLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly repos: GitRepoSet;
	readonly lastActiveRepo: string | null;
	readonly loadViewTo: LoadGitGraphViewTo;
}

export const enum MergeActionOn {
	Branch = 'Branch',
	RemoteTrackingBranch = 'Remote-tracking Branch',
	Commit = 'Commit'
}
export interface RequestMerge extends RepoRequest {
	readonly command: 'merge';
	readonly obj: string;
	readonly actionOn: MergeActionOn;
	readonly createNewCommit: boolean;
	readonly squash: boolean;
	readonly noCommit: boolean;
}
export interface ResponseMerge extends ResponseWithErrorInfo {
	readonly command: 'merge';
	readonly actionOn: MergeActionOn;
}

export interface RequestOpenExtensionSettings extends BaseMessage {
	readonly command: 'openExtensionSettings';
}
export interface ResponseOpenExtensionSettings extends ResponseWithErrorInfo {
	readonly command: 'openExtensionSettings';
}

export interface RequestOpenLogFile extends BaseMessage {
	readonly command: 'openLogFile';
}
export interface ResponseOpenLogFile extends ResponseWithErrorInfo {
	readonly command: 'openLogFile';
}

export interface RequestOpenExternalDirDiff extends RepoRequest {
	readonly command: 'openExternalDirDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly isGui: boolean;
}
export interface ResponseOpenExternalDirDiff extends ResponseWithErrorInfo {
	readonly command: 'openExternalDirDiff';
}

export interface RequestOpenExternalUrl extends BaseMessage {
	readonly command: 'openExternalUrl';
	readonly url: string;
}
export interface RequestOpenCompareTab extends RepoRequest {
	readonly command: 'openCompareTab';
	readonly fromHash: string;
	readonly toHash: string;
	/** Present the changes as those of `toHash` alone (its diff against `fromHash`, its first
	 *  parent) rather than as a comparison between two commits. */
	readonly singleCommit: boolean;
}
export interface ResponseOpenExternalUrl extends ResponseWithErrorInfo {
	readonly command: 'openExternalUrl';
}

export interface RequestOpenFile extends RepoRequest {
	readonly command: 'openFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseOpenFile extends ResponseWithErrorInfo {
	readonly command: 'openFile';
}

export interface RequestOpenTerminal extends RepoRequest {
	readonly command: 'openTerminal';
	readonly name: string;
}
export interface ResponseOpenTerminal extends ResponseWithErrorInfo {
	readonly command: 'openTerminal';
}

export interface RequestPopStash extends RepoRequest {
	readonly command: 'popStash';
	readonly selector: string;
	readonly reinstateIndex: boolean;
}
export interface ResponsePopStash extends ResponseWithErrorInfo {
	readonly command: 'popStash';
}

export interface RequestPruneRemote extends RepoRequest {
	readonly command: 'pruneRemote';
	readonly name: string;
}
export interface ResponsePruneRemote extends ResponseWithErrorInfo {
	readonly command: 'pruneRemote';
}

export interface RequestPullBranch extends RepoRequest {
	readonly command: 'pullBranch';
	readonly branchName: string;
	readonly remote: string;
	readonly createNewCommit: boolean;
	readonly squash: boolean;
}
export interface ResponsePullBranch extends ResponseWithErrorInfo {
	readonly command: 'pullBranch';
}

export interface RequestPushBranch extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'pushBranch';
	readonly branchName: string;
	readonly remotes: string[];
	readonly setUpstream: boolean;
	readonly mode: GitPushBranchMode;
	readonly willUpdateBranchConfig: boolean;
}
export interface ResponsePushBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'pushBranch';
	readonly willUpdateBranchConfig: boolean;
}

export interface RequestPushStash extends RepoRequest {
	readonly command: 'pushStash';
	readonly message: string;
	readonly includeUntracked: boolean;
}
export interface ResponsePushStash extends ResponseWithErrorInfo {
	readonly command: 'pushStash';
}

export interface RequestPushTag extends RepoRequest {
	readonly command: 'pushTag';
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
	readonly skipRemoteCheck: boolean;
}
export interface ResponsePushTag extends ResponseWithMultiErrorInfo {
	readonly command: 'pushTag';
	readonly repo: string;
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
}

export const enum RebaseActionOn {
	Branch = 'Branch',
	Commit = 'Commit'
}
export interface RequestRebase extends RepoRequest {
	readonly command: 'rebase';
	readonly obj: string;
	readonly actionOn: RebaseActionOn;
	readonly ignoreDate: boolean;
	readonly interactive: boolean;
}
export interface ResponseRebase extends ResponseWithErrorInfo {
	readonly command: 'rebase';
	readonly actionOn: RebaseActionOn;
	readonly interactive: boolean;
}

export interface ResponseRefresh extends BaseMessage {
	readonly command: 'refresh';
}

/**
 * A Git Graph Extension Setting changed: apply it live instead of regenerating the webview's HTML
 * (a full page reload that flashed the view and dropped the open Commit Details View). Only sent
 * for settings the webview can apply at runtime; an interface language change still regenerates
 * the page (every rendered label would have to be swapped).
 */
export interface ResponseConfigChanged extends BaseMessage {
	readonly command: 'configChanged';
	readonly config: GitGraphViewConfig;
}

export interface RequestRenameBranch extends RepoRequest {
	readonly command: 'renameBranch';
	readonly oldName: string;
	readonly newName: string;
}
export interface ResponseRenameBranch extends ResponseWithErrorInfo {
	readonly command: 'renameBranch';
}

export interface RequestRescanForRepos extends BaseMessage {
	readonly command: 'rescanForRepos';
}

export interface RequestResetFileToRevision extends RepoRequest {
	readonly command: 'resetFileToRevision';
	readonly commitHash: string;
	readonly filePath: string;
}
export interface ResponseResetFileToRevision extends ResponseWithErrorInfo {
	readonly command: 'resetFileToRevision';
}

export interface RequestResetToCommit extends RepoRequest {
	/** Set when the view already showed the data-loss warning and the user insisted. */
	readonly confirmed?: boolean;
	readonly command: 'resetToCommit';
	readonly commit: string;
	readonly resetMode: GitResetMode;
}
export interface ResponseResetToCommit extends ResponseWithErrorInfo {
	readonly command: 'resetToCommit';
}

export interface RequestRevertCommit extends RepoRequest {
	readonly command: 'revertCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
}
export interface ResponseRevertCommit extends ResponseWithErrorInfo {
	readonly command: 'revertCommit';
}

export interface RequestUndoLastCommit extends RepoRequest {
	readonly command: 'undoLastCommit';
}
export interface ResponseUndoLastCommit extends ResponseWithErrorInfo {
	readonly command: 'undoLastCommit';
}

export interface RequestEditCommitMessage extends RepoRequest {
	readonly command: 'editCommitMessage';
	readonly commitHash: string;
	readonly message: string;
}
export interface ResponseEditCommitMessage extends ResponseWithErrorInfo {
	readonly command: 'editCommitMessage';
}

export interface RequestSetGlobalViewState extends BaseMessage {
	readonly command: 'setGlobalViewState';
	readonly state: GitGraphViewGlobalState;
}
export interface ResponseSetGlobalViewState extends ResponseWithErrorInfo {
	readonly command: 'setGlobalViewState';
}

export interface RequestSetRepoState extends RepoRequest {
	readonly command: 'setRepoState';
	readonly state: GitRepoState;
}

export interface RequestSetWorkspaceViewState extends BaseMessage {
	readonly command: 'setWorkspaceViewState';
	readonly state: GitGraphViewWorkspaceState;
}
export interface ResponseSetWorkspaceViewState extends ResponseWithErrorInfo {
	readonly command: 'setWorkspaceViewState';
}

export interface RequestShowErrorDialog extends BaseMessage {
	readonly command: 'showErrorMessage';
	readonly message: string;
}

export interface RequestStartCodeReview extends RepoRequest {
	readonly command: 'startCodeReview';
	readonly id: string;
	readonly files: string[];
	readonly lastViewedFile: string | null;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}
export interface ResponseStartCodeReview extends ResponseWithErrorInfo {
	readonly command: 'startCodeReview';
	readonly codeReview: CodeReview;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}

export interface RequestTagDetails extends RepoRequest {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
}
export interface ResponseTagDetails extends ResponseWithErrorInfo {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
	readonly details: GitTagDetails | null;
}

export interface RequestUpdateCodeReview extends RepoRequest {
	readonly command: 'updateCodeReview';
	readonly id: string;
	readonly remainingFiles: string[];
	readonly lastViewedFile: string | null;
}

export interface ResponseUpdateCodeReview extends ResponseWithErrorInfo {
	readonly command: 'updateCodeReview';
}

export interface RequestViewDiff extends RepoRequest {
	readonly command: 'viewDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
}
export interface ResponseViewDiff extends ResponseWithErrorInfo {
	readonly command: 'viewDiff';
}

/** Opens the Binary Compare tab for a file the native Diff View cannot show (a binary or image
 *  change): the same tab the Commit Comparison View's "open diff" button uses. No response is
 *  sent, exactly like `openCompareTab`, since it just reveals a webview panel. */
export interface RequestViewDiffBinary extends RepoRequest {
	readonly command: 'viewDiffBinary';
	readonly fromHash: string;
	readonly toHash: string;
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
}

export interface RequestViewDiffWithWorkingFile extends RepoRequest {
	readonly command: 'viewDiffWithWorkingFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewDiffWithWorkingFile extends ResponseWithErrorInfo {
	readonly command: 'viewDiffWithWorkingFile';
}

export interface RequestViewFileAtRevision extends RepoRequest {
	readonly command: 'viewFileAtRevision';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewFileAtRevision extends ResponseWithErrorInfo {
	readonly command: 'viewFileAtRevision';
}

export interface RequestViewScm extends BaseMessage {
	readonly command: 'viewScm';
}
export interface ResponseViewScm extends ResponseWithErrorInfo {
	readonly command: 'viewScm';
}

export interface RequestFetchPullRequest extends RepoRequest {
	readonly command: 'fetchPullRequest';
}
export interface ResponsePullRequestStatus {
	readonly command: 'pullRequestStatus';
	readonly repo: string;
	/** The pull requests of the repository's remote (NULL when they couldn't be determined). */
	readonly prs: PullRequestInfo[] | null;
}

export interface RequestSetInterfaceLanguage extends BaseMessage {
	readonly command: 'setInterfaceLanguage';
	readonly language: 'auto' | 'en' | 'zh-cn';
}
export interface ResponseSetInterfaceLanguage extends ResponseWithErrorInfo {
	readonly command: 'setInterfaceLanguage';
}

/** The type of a Global Setting that can be written from the Settings Widget. */
export type GlobalSettingValue = boolean | number | string | ReadonlyArray<CommitAuthor>;

export interface RequestSetGlobalSetting extends BaseMessage {
	readonly command: 'setGlobalSetting';
	/** The key of the setting, relative to the `git-graph-rs` section (e.g. "graph.style"). */
	readonly setting: string;
	readonly value: GlobalSettingValue;
}
export interface ResponseSetGlobalSetting extends ResponseWithErrorInfo {
	readonly command: 'setGlobalSetting';
	readonly setting: string;
	/** Saving 'commitAuthors' may write the global Git configuration (defaulting or clearing the
	 * global author): the webview must reload the repository configuration only once the save
	 * completed, or it renders the pre-save snapshot of the global author. */
	readonly authorConfigTouched: boolean;
}

export type RequestMessage =
	RequestAddRemote
	| RequestAddTag
	| RequestApplyStash
	| RequestBranchFromStash
	| RequestCheckoutBranch
	| RequestCheckoutCommit
	| RequestCherrypickCommit
	| RequestCleanUntrackedFiles
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
	| RequestMerge
	| RequestOpenExtensionSettings
	| RequestOpenExternalDirDiff
	| RequestOpenExternalUrl
	| RequestOpenCompareTab
	| RequestOpenFile
	| RequestOpenLogFile
	| RequestOpenTerminal
	| RequestPopStash
	| RequestPruneRemote
	| RequestPullBranch
	| RequestPushBranch
	| RequestPushStash
	| RequestPushTag
	| RequestRebase
	| RequestRenameBranch
	| RequestRescanForRepos
	| RequestResetFileToRevision
	| RequestResetToCommit
	| RequestRevertCommit
	| RequestSetGlobalViewState
	| RequestSetRepoState
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
	| RequestSetInterfaceLanguage;

export type ResponseMessage =
	ResponseAddRemote
	| ResponseAddTag
	| ResponseLossWarning
	| ResponseApplyStash
	| ResponseBranchFromStash
	| ResponseCheckoutBranch
	| ResponseCheckoutCommit
	| ResponseCherrypickCommit
	| ResponseCleanUntrackedFiles
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
	| ResponseMerge
	| ResponseOpenExtensionSettings
	| ResponseOpenExternalDirDiff
	| ResponseOpenExternalUrl
	| ResponseOpenFile
	| ResponseOpenLogFile
	| ResponseOpenTerminal
	| ResponsePopStash
	| ResponsePruneRemote
	| ResponsePullBranch
	| ResponsePushBranch
	| ResponsePushStash
	| ResponsePushTag
	| ResponseRebase
	| ResponseRefresh
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
	| ResponseSetInterfaceLanguage;

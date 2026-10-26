/**
 * The loading-domain messages of the Git Graph view protocol (REFACTOR-PLAN task 4.1):
 * the boot handshake, the repository/config/commit loads, the commit-body, reflog and
 * statistics reads, and the avatar fetch. Split out of src/types/messages.ts verbatim;
 * the domain mirrors the host handlers in src/extension/graphView/handlers/loading.ts.
 */

import type { GitCommit, GitAuthorStat, GitActivityCell, GitReflogEntry, GitOperationState, GitRepoConfig, GitStash } from '../model/git';
import type { GerritChangeState, GerritStatusFilter } from '../model/gerrit';
import type { CommitOrdering } from '../model/webview';
import type { BaseMessage, RepoRequest, ResponseWithErrorInfo } from './messages';

export interface RequestCommitBodies extends RepoRequest {
	readonly command: 'commitBodies';
	readonly commitHashes: ReadonlyArray<string>;
	/** Client-generated id echoed verbatim in the response, pairing the response with its request. */
	readonly requestId: number;
}
export interface ResponseCommitBodies {
	readonly command: 'commitBodies';
	readonly bodies: { [hash: string]: string };
	/** The requestId of the request this response answers. */
	readonly requestId: number;
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
	readonly gerritFetchLimit: number | null; // how many of the most recent Gerrit changes passing the status filter are DISPLAYED (NULL => the gerrit.fetchLimit Extension Setting)
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
	readonly refreshId: number;
	readonly remotes: ReadonlyArray<string>;
}
export interface ResponseLoadConfig extends ResponseWithErrorInfo {
	readonly command: 'loadConfig';
	readonly repo: string;
	readonly refreshId: number;
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
	readonly operationState: GitOperationState;
}

export interface RequestRepoStatistics extends RepoRequest {
	readonly command: 'repoStatistics';
}
export interface ResponseRepoStatistics extends BaseMessage {
	readonly command: 'repoStatistics';
	readonly repo: string;
	readonly authors: ReadonlyArray<GitAuthorStat>;
	readonly activity: ReadonlyArray<GitActivityCell>;
}

export interface RequestReflog extends RepoRequest {
	readonly command: 'reflog';
	readonly ref: string;
	readonly limit: number;
}
export interface ResponseReflog extends ResponseWithErrorInfo {
	readonly command: 'reflog';
	readonly repo: string;
	readonly ref: string;
	readonly entries: ReadonlyArray<GitReflogEntry>;
	readonly moreAvailable: boolean;
}

/**
 * The merged open-path request (REFACTOR-PLAN task 4.7): one round trip carrying the repository
 * info AND the first commit page. The host begins this read itself when the panel is created and
 * pushes the result as soon as the page reports `ready` — the webview's initial boot sends no
 * loadRepoInfo/loadCommits requests of its own. The request form stays in the protocol for a
 * caller that wants the same merged answer later (e.g. a full reload after an error), while the
 * two partial requests remain for partial refreshes.
 *
 * The fields are the commit-page options the view already sends with `loadCommits` (the LogOptions
 * the engine walk accepts), plus the refresh id the response carries back.
 */
export interface RequestLoadView extends RepoRequest {
	readonly command: 'loadView';
	readonly refreshId: number;
	readonly hard: boolean; // true => the extension host must bypass its commit cache
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
	readonly filterPath?: string | null; // only show commits that modified the file(s) at this path; null/undefined => no path filter
}

/**
 * The merged open-path response: the halves of a loadRepoInfo and a loadCommits response in one
 * message (each without its command/refresh-id envelope, which the response itself carries).
 * The webview routes each half through the processing of the corresponding partial response, so
 * the staged follow-ups (remote refs, the "Uncommitted Changes" row) keep working unchanged.
 */
export interface ResponseLoadView extends BaseMessage {
	readonly command: 'loadView';
	readonly repo: string;
	readonly refreshId: number;
	readonly repoInfo: Omit<ResponseLoadRepoInfo, 'command' | 'refreshId'>;
	readonly commits: Omit<ResponseLoadCommits, 'command' | 'refreshId'>;
}

/**
 * The webview's boot acknowledgement: the page has installed its response router and waits for
 * the host to push the merged `loadView` result of the read the host began at panel creation.
 * The host sends no direct reply; the push (and its staged follow-ups) is the answer.
 */
export interface RequestReady extends BaseMessage {
	readonly command: 'ready';
}

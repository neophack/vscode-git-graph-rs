/**
 * The remote-domain messages of the Git Graph view protocol: remote CRUD, fetch and prune,
 * and branch push/pull. Split out of src/types/messages.ts verbatim; the domain mirrors
 * handlers/remotes.ts.
 */

import type { GitPushBranchMode } from '../model/git';
import type { RepoRequest, ResponseWithErrorInfo, ResponseWithMultiErrorInfo } from './messages';

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

export interface RequestDeleteRemote extends RepoRequest {
	readonly command: 'deleteRemote';
	readonly name: string;
}
export interface ResponseDeleteRemote extends ResponseWithErrorInfo {
	readonly command: 'deleteRemote';
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

export interface RequestFetch extends RepoRequest {
	readonly command: 'fetch';
	readonly name: string | null; // null => Fetch all remotes
	readonly prune: boolean;
	readonly pruneTags: boolean;
}
export interface ResponseFetch extends ResponseWithErrorInfo {
	readonly command: 'fetch';
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

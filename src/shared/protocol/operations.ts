/**
 * The operation-domain messages of the Git Graph view protocol: the merge/rebase and
 * cherry-pick/revert families and their continue/abort/clean-up controls, the conflict
 * prediction and the pull-request creation. Split out of src/types/messages.ts verbatim;
 * the domain mirrors handlers/operations.ts.
 */

import type { GitOperationType, GitConflictPrediction } from '../model/git';
import type { PullRequestConfig } from '../model/pullRequest';
import type { BaseMessage, RepoRequest, ResponseWithErrorInfo, ResponseWithMultiErrorInfo } from './messages';

export interface RequestCleanUntrackedFiles extends RepoRequest {
	readonly command: 'cleanUntrackedFiles';
	readonly directories: boolean;
}
export interface ResponseCleanUntrackedFiles extends ResponseWithErrorInfo {
	readonly command: 'cleanUntrackedFiles';
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

export interface RequestContinueOperation extends RepoRequest {
	readonly command: 'continueOperation';
	readonly type: GitOperationType;
}
export interface ResponseContinueOperation extends ResponseWithErrorInfo {
	readonly command: 'continueOperation';
}

export interface RequestPredictConflicts extends RepoRequest {
	readonly command: 'predictConflicts';
	readonly ours: string;
	readonly theirs: string;
}
export interface ResponsePredictConflicts extends BaseMessage {
	readonly command: 'predictConflicts';
	readonly ours: string;
	readonly theirs: string;
	readonly prediction: GitConflictPrediction | null;
}

export interface RequestAbortOperation extends RepoRequest {
	readonly command: 'abortOperation';
	readonly type: GitOperationType;
}
export interface ResponseAbortOperation extends ResponseWithErrorInfo {
	readonly command: 'abortOperation';
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
	readonly autosquash: boolean;
}
export interface ResponseRebase extends ResponseWithErrorInfo {
	readonly command: 'rebase';
	readonly actionOn: RebaseActionOn;
	readonly interactive: boolean;
}

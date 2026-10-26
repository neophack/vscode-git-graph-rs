/**
 * The commit-details-domain messages of the Git Graph view protocol: the commit details,
 * per-file line counts and commit-comparison reads. Split out of src/types/messages.ts
 * verbatim; the domain mirrors the detail reads of the host loading handlers.
 */

import type { GitCommitStash, GitCommitDetails, GitFileChange, GitLineCounts } from '../model/git';
import type { CodeReview } from '../model/repoState';
import type { RepoRequest, ResponseWithErrorInfo } from './messages';

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

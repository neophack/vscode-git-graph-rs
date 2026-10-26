/* Git Interfaces / Types */

export interface GitCommit {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
	readonly heads: ReadonlyArray<string>;
	readonly tags: ReadonlyArray<GitCommitTag>;
	readonly remotes: ReadonlyArray<GitCommitRemote>;
	readonly stash: GitCommitStash | null; // null => not a stash, otherwise => stash info
}

export interface GitCommitTag {
	readonly name: string;
	readonly annotated: boolean;
}

export interface GitCommitRemote {
	readonly name: string;
	readonly remote: string | null; // null => remote not found, otherwise => remote name
}

export interface GitCommitStash {
	readonly selector: string;
	readonly baseHash: string;
	readonly untrackedFilesHash: string | null;
}

export interface GitCommitDetails {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly signature: GitSignature | null;
	readonly body: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
}

export const enum GitSignatureStatus {
	GoodAndValid = 'G',
	GoodWithUnknownValidity = 'U',
	GoodButExpired = 'X',
	GoodButMadeByExpiredKey = 'Y',
	GoodButMadeByRevokedKey = 'R',
	CannotBeChecked = 'E',
	Bad = 'B'
}

export interface GitSignature {
	readonly key: string;
	readonly signer: string;
	readonly status: GitSignatureStatus;
}

export const enum GitConfigLocation {
	Local = 'local',
	Global = 'global',
	System = 'system'
}

export interface GitFileChange {
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
	readonly additions: number | null;
	readonly deletions: number | null;
}

/** The `+N/-M` line counts of one file; both are NULL for a binary file. */
export interface GitLineCounts {
	readonly additions: number | null;
	readonly deletions: number | null;
}

export const enum GitFileStatus {
	Added = 'A',
	Modified = 'M',
	Deleted = 'D',
	Renamed = 'R',
	Untracked = 'U'
}

export const enum GitPushBranchMode {
	Normal = '',
	Force = 'force',
	ForceWithLease = 'force-with-lease'
}

export const enum GitOperationType {
	Merge = 'merge',
	Rebase = 'rebase',
	CherryPick = 'cherry-pick',
	Revert = 'revert'
}

/**
 * The result of probing whether merging `theirs` into `ours` would conflict, via a single
 * `git merge-tree --write-tree` (no working-tree side effects). This is a tip-vs-target probe,
 * not a full simulation of every commit an interactive rebase would apply one at a time — so a
 * clean prediction here is not an absolute guarantee the real operation will not conflict.
 */
export interface GitConflictPrediction {
	readonly conflicted: boolean;
	/** Deduped file paths predicted to conflict; empty when `conflicted` is FALSE. */
	readonly files: ReadonlyArray<string>;
}

/** Commit count for one author, across all branches. */
export interface GitAuthorStat {
	readonly name: string;
	readonly email: string;
	readonly commits: number;
}

/** One non-zero cell of the commit activity heatmap (author-local weekday/hour). Sparse: zero
 * cells are omitted rather than sent as explicit zeroes. */
export interface GitActivityCell {
	/** 0 = Sunday, per `Date.getUTCDay()`. */
	readonly weekday: number;
	/** 0-23. */
	readonly hour: number;
	readonly count: number;
}

/** One worktree of a repository, as reported by `git worktree list --porcelain`. */
export interface GitWorktree {
	readonly path: string;
	readonly hash: string;
	/** The branch checked out in this worktree (`refs/heads/` stripped), or NULL if detached. */
	readonly branch: string | null;
	readonly detached: boolean;
	readonly locked: boolean;
	readonly prunable: boolean;
	/** TRUE for the repository's own working directory (always the first entry Git reports). */
	readonly isMain: boolean;
}

/** One entry of a reflog page, newest first. */
export interface GitReflogEntry {
	readonly hash: string;
	readonly abbrevHash: string;
	/** Rebuilt as `<ref>@{<index in this page>}`, not read from Git's own `%gd` (which switches to
	 * a date-based form once `--date` is given, rather than the index form). */
	readonly selector: string;
	readonly date: number;
	readonly message: string;
	/** TRUE => no branch, tag, remote-tracking ref or stash can reach this commit any more. */
	readonly dangling: boolean;
}

/** The state of a merge/rebase/cherry-pick/revert currently in progress, or NULL if none is. */
export interface GitOperationState {
	readonly type: GitOperationType | null;
	readonly conflictedFiles: ReadonlyArray<string>;
	/** The rebase step counter (`rebase-merge/msgnum` of `rebase-merge/end`), or NULL when not rebasing. */
	readonly progress: { readonly step: number, readonly total: number } | null;
}

export interface GitRepoConfig {
	readonly branches: GitRepoConfigBranches;
	readonly authors: ActionedUser[];
	readonly diffTool: string | null;
	readonly guiDiffTool: string | null;
	readonly pushDefault: string | null;
	readonly remotes: ReadonlyArray<GitRepoSettingsRemote>;
	readonly user: {
		readonly name: {
			readonly local: string | null,
			readonly global: string | null
		},
		readonly email: {
			readonly local: string | null,
			readonly global: string | null
		}
	};
}

export type GitRepoConfigBranches = { [branchName: string]: GitRepoConfigBranch };
export interface ActionedUser {
	name: string;
	email: string;
};
export interface GitRepoConfigBranch {
	readonly pushRemote: string | null;
	readonly remote: string | null;
}

export interface GitRepoSettingsRemote {
	readonly name: string;
	readonly url: string | null;
	readonly pushUrl: string | null;
}

export const enum GitResetMode {
	Soft = 'soft',
	Mixed = 'mixed',
	Hard = 'hard'
}

export interface GitStash {
	readonly hash: string;
	readonly baseHash: string;
	readonly untrackedFilesHash: string | null;
	readonly selector: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

export interface GitTagDetails {
	readonly hash: string;
	readonly taggerName: string;
	readonly taggerEmail: string;
	readonly taggerDate: number;
	readonly message: string;
	readonly signature: GitSignature | null;
}

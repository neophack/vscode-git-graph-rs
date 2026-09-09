import type { GerritStatusFilter } from './gerrit';
import type { PullRequestConfig } from './pullRequest';
import type { BooleanOverride, FileViewType, RepoCommitOrdering } from './webview';

/* Git Repo State */

export interface GitRepoState {
	pinnedBranches: string[];
	pinnedCommits: PinnedCommit[];
	cdvDivider: number;
	cdvHeight: number;
	columnWidths: ColumnWidth[] | null;
	commitOrdering: RepoCommitOrdering;
	fileViewType: FileViewType;
	gerritFetchRefs: boolean;
	/**
	 * How many of the most recent Gerrit changes this repository fetches (NULL => the
	 * `gerrit.fetchLimit` Extension Setting). Set in the Repository Settings.
	 */
	gerritFetchLimit: number | null;
	gerritStatusFilter: GerritStatusFilter;
	hideRemotes: string[];
	includeCommitsMentionedByReflogs: BooleanOverride;
	issueLinkingConfig: IssueLinkingConfig | null;
	lastImportAt: number;
	name: string | null;
	onlyFollowFirstParent: BooleanOverride;
	onRepoLoadShowCheckedOutBranch: BooleanOverride;
	onRepoLoadShowSpecificBranches: string[] | null;
	pullRequestConfig: PullRequestConfig | null;
	showRemoteBranches: boolean;
	showRemoteBranchesV2: BooleanOverride;
	showStashes: BooleanOverride;
	showTags: BooleanOverride;
	workspaceFolderIndex: number | null;
}

export interface PinnedCommit {
	hash: string;
	summary: string;
	/**
	 * Captured when the commit is pinned, so the chip's tooltip can show who wrote it and when
	 * even while the commit itself is outside the loaded page of the graph.
	 */
	author?: string;
	email?: string;
	date?: number;
}

export interface CodeReview {
	id: string;
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
}

export type ColumnWidth = number;

export type GitRepoSet = { [repo: string]: GitRepoState };

export interface IssueLinkingConfig {
	readonly issue: string;
	readonly url: string;
}

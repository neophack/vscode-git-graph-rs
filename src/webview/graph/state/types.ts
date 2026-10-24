/* The state types of the Git Graph View (persisted state, the expanded commit, file trees). */

import * as GG from '../../common/protocol';

/* Commit Details / Comparison View file tree */

export interface FileTreeFile {
	readonly type: 'file';
	readonly name: string;
	readonly index: number;
	reviewed: boolean;
}

export interface FileTreeRepo {
	readonly type: 'repo';
	readonly name: string;
	readonly path: string;
}

export interface FileTreeFolder {
	readonly type: 'folder';
	readonly name: string;
	readonly folderPath: string;
	readonly contents: FileTreeFolderContents;
	open: boolean;
	reviewed: boolean;
}

export type FileTreeLeaf = FileTreeFile | FileTreeRepo;
export type FileTreeNode = FileTreeFolder | FileTreeLeaf;
export type FileTreeFolderContents = { [name: string]: FileTreeNode };


/** The deferred-counts state of an open Commit Details / Commit Comparison view. */
export interface LineCountsState {
	/** The paths whose counts have not been settled yet; null before the file list arrives. */
	pending: Set<string> | null;
	/** The paths already asked for, so a scroll never asks twice. */
	requested: Set<string>;
	/** The remaining paths, in list order, waiting for a background batch. */
	queue: string[];
	/** Path → index into the file list, built once per file list. */
	byPath: Map<string, number> | null;
	/** True while a background batch is in flight. */
	chunkInFlight: boolean;
	/** The debounce timer of a scroll-triggered viewport request. */
	scrollTimer: number;
}

/** The commit whose Commit Details View (or Commit Comparison) is open. */
export interface ExpandedCommit {
	index: number;
	commitHash: string;
	commitElem: HTMLElement | null;
	compareWithHash: string | null;
	compareWithElem: HTMLElement | null;
	commitDetails: GG.GitCommitDetails | null;
	fileChanges: ReadonlyArray<GG.GitFileChange> | null;
	fileTree: FileTreeFolder | null;
	avatar: string | null;
	codeReview: GG.CodeReview | null;
	lastViewedFile: string | null;
	loading: boolean;
	/**
	 * TRUE once the entrance (fade-in) animation has played for this open commit. A CSS
	 * animation tied to `#cdv`'s connection to the document restarts whenever the element is
	 * disconnected and reconnected - which a table rebuild does even when the SAME element
	 * reference is carefully preserved and reinserted. Once `entered` is true, the renderer
	 * suppresses the animation via an inline style on every subsequent render of the same open
	 * commit, so a background refresh can never make the panel visibly "flash" again.
	 */
	entered: boolean;
	/** Whether the message body is currently rendered as Markdown (vs. plain/inline-formatted) - only meaningful when `hasMarkdown()` offers the toggle at all. Defaults to TRUE (rendered). */
	showMarkdown: boolean;
	/**
	 * The deferred `+N/-M` line counts of the file list. The details arrive without them (every
	 * file costs two blob reads, which dominates the load of a many-file commit); the paths
	 * near the viewport are settled first and the rest are filled in by background batches.
	 */
	lineCounts: LineCountsState;
	scrollTop: {
		summary: number,
		fileView: number
	};
	contextMenuOpen: {
		summary: boolean,
		fileView: number
	};
}

/** The persisted state of the Find Widget. */
export interface FindWidgetState {
	readonly text: string;
	readonly currentHash: string | null;
	readonly visible: boolean;
}

/** The persisted state of the Settings Widget. */
export interface SettingsWidgetState {
	readonly currentRepo: string | null;
	readonly scrollTop: number;
	readonly repoColumnScrollTop: number;
	readonly globalColumnScrollTop: number;
}

/**
 * The state VS Code persists for the webview (restored after the webview is reloaded). Its shape
 * is a public contract (REFACTOR-PLAN §2.2): the same fields as v1.0.
 */
export interface WebViewState {
	readonly currentRepo: string;
	readonly currentRepoLoading: boolean;
	readonly gitRepos: GG.GitRepoSet;
	readonly gitBranches: ReadonlyArray<string>;
	readonly gitBranchHead: string | null;
	readonly gitConfig: GG.GitRepoConfig | null;
	readonly gitRemotes: ReadonlyArray<string>;
	readonly gitStashes: ReadonlyArray<GG.GitStash>;
	readonly gitTags: ReadonlyArray<string>;
	readonly commitHead: string | null;
	readonly currentBranches: string[] | null;
	readonly currentAuthors: string[] | null;
	readonly moreCommitsAvailable: boolean;
	readonly maxCommits: number;
	readonly onlyFollowFirstParent: boolean;
	readonly scrollTop: number;
	readonly findWidget: FindWidgetState;
	readonly settingsWidget: SettingsWidgetState;
	readonly commitPathFilter?: string | null; // only show commits that modified the file(s) at this path
	readonly compareSourceHash?: string | null; // the commit selected via "Select for Compare"
}

/** The refresh cycle of the current repository (loadRepoInfo → loadCommits → loadConfig). */
export interface RefreshState {
	inProgress: boolean;
	hard: boolean;
	loadRepoInfoRefreshId: number;
	loadCommitsRefreshId: number;
	loadConfigRefreshId: number;
	repoInfoChanges: boolean;
	configChanges: boolean;
	requestingRepoInfo: boolean;
	requestingConfig: boolean;
}

/** A commit the view can scroll back to across an update: the commit at the top of the viewport. */
export interface ViewportAnchor {
	readonly hash: string;
	readonly offset: number;
	readonly atTop: boolean;
}

/* Dialog & context menu targets */

export const enum TargetType {
	Commit = 'commit',
	CommitDetailsView = 'cdv',
	Ref = 'ref',
	Repo = 'repo'
}

export interface RepoTarget {
	type: TargetType.Repo;
}

export interface CommitTarget {
	type: TargetType.Commit | TargetType.Ref | TargetType.CommitDetailsView;
	elem: HTMLElement;
	hash: string;
}

export interface RefTarget extends CommitTarget {
	ref: string;
}

/** A commit target of a context menu, which also names the commit's index. */
export interface IndexedCommitTarget extends CommitTarget {
	index: number;
}

/** A ref target of a context menu, which also names the commit's index. */
export interface IndexedRefTarget extends RefTarget {
	index: number;
}

/** What a dialog was opened for: it is re-linked to the re-rendered element (or closed) when the commits change. */
export type DialogTarget = {
	type: TargetType.Commit | TargetType.Ref | TargetType.CommitDetailsView;
	elem: HTMLElement;
	hash: string;
	ref?: string;
} | RepoTarget;

/** What a context menu was opened for (as a dialog target, plus the commit's index). */
export type ContextMenuTarget = {
	type: TargetType.Commit | TargetType.Ref | TargetType.CommitDetailsView;
	elem: HTMLElement;
	hash: string;
	index: number;
	ref?: string;
} | RepoTarget;

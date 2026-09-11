import type { GerritConfig } from './gerrit';
import type { GitResetMode } from './git';
import type { PullRequestsConfig } from './pullRequest';
import type { GitRepoSet, IssueLinkingConfig } from './repoState';

/* Git Graph View Types */

export interface GitGraphViewInitialState {
	readonly config: GitGraphViewConfig;
	readonly lastActiveRepo: string | null;
	readonly loadViewTo: LoadGitGraphViewTo;
	readonly repos: GitRepoSet;
	readonly loadRepoInfoRefreshId: number;
	readonly loadCommitsRefreshId: number;
	/** Which backend serves each area of the extension on this platform. */
	readonly backend: BackendReport;
}

/* Backend capability report */

/** Which backend serves one area of the extension, on the platform the editor is running on. */
export interface BackendCapability {
	/** A stable area id ('repoInfo', 'commits', …); the webview localises it. */
	readonly area: string;
	readonly provider: 'rust' | 'git-cli' | 'hybrid';
	/** A stable note id explaining the split, when it needs explaining. */
	readonly note?: 'dynamic' | 'writesAlways';
}

/**
 * The per-platform backend split, shown by the Settings widget: the engine's presence and
 * version, and one row per functional area saying who answers it.
 */
export interface BackendReport {
	/** `${platform}-${arch}` of this editor, e.g. `win32-x64`. */
	readonly platform: string;
	readonly engineAvailable: boolean;
	readonly engineVersion: string | null;
	/** Is a `git` executable available (for the CLI backend and the write path)? */
	readonly gitCliAvailable: boolean;
	readonly capabilities: ReadonlyArray<BackendCapability>;
}

export interface GitGraphViewConfig {
	readonly commitAuthors: ReadonlyArray<CommitAuthor>;
	readonly commitDetailsView: CommitDetailsViewConfig;
	readonly commitOrdering: CommitOrdering;
	readonly contextMenuActionsVisibility: ContextMenuActionsVisibility;
	readonly customBranchGlobPatterns: ReadonlyArray<CustomBranchGlobPattern>;
	readonly customEmojiShortcodeMappings: ReadonlyArray<CustomEmojiShortcodeMapping>;
	readonly customPullRequestProviders: ReadonlyArray<CustomPullRequestProvider>;
	readonly dateFormat: DateFormat;
	readonly dateType: DateType;
	readonly defaultColumnVisibility: DefaultColumnVisibility;
	readonly dialogDefaults: DialogDefaults;
	readonly enableLog: boolean;
	readonly enhancedAccessibility: boolean;
	readonly fetchAndPrune: boolean;
	readonly fetchAndPruneTags: boolean;
	readonly fetchAvatars: boolean;
	readonly gerrit: GerritConfig;
	readonly graph: GraphConfig;
	readonly interfaceLanguage: 'en' | 'zh-cn';
	readonly interfaceLanguageSetting: 'auto' | 'en' | 'zh-cn';
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly initialLoadCommits: number;
	readonly keybindings: KeybindingConfig
	readonly loadMoreCommits: number;
	readonly loadMoreCommitsAutomatically: boolean;
	readonly markdown: boolean;
	readonly mute: MuteCommitsConfig;
	readonly showBodyInline: boolean;

	readonly onlyFollowFirstParent: boolean;
	readonly onRepoLoad: OnRepoLoadConfig;
	readonly pullRequests: PullRequestsConfig;
	readonly referenceLabels: ReferenceLabelsConfig;
	readonly repoDropdownOrder: RepoDropdownOrder;
	readonly showCommitBodyInline: boolean;
	readonly showRemoteBranches: boolean;
	readonly showRemoteHeads: boolean;
	readonly showStashes: boolean;
	readonly showTags: boolean;
	readonly showUncommittedChanges: boolean;
	readonly showUntrackedFiles: boolean;
	readonly stickyHeader: boolean;
	readonly trackRemoteTags: boolean;
}

export interface GitGraphViewGlobalState {
	alwaysAcceptCheckoutCommit: boolean;
	issueLinkingConfig: IssueLinkingConfig | null;
	pushTagSkipRemoteCheck: boolean;
}

export interface GitGraphViewWorkspaceState {
	findIsCaseSensitive: boolean;
	findIsRegex: boolean;
	findOpenCommitDetailsView: boolean;
}

export interface CommitDetailsViewConfig {
	readonly autoCenter: boolean;
	readonly fileTreeCompactFolders: boolean;
	readonly fileViewType: FileViewType;
	readonly location: CommitDetailsViewLocation;
}

export interface GraphConfig {
	readonly colours: ReadonlyArray<string>;
	readonly fontSize: number;
	readonly rowHeight: number;
	readonly style: GraphStyle;
	readonly grid: { x: number, y: number, offsetX: number, offsetY: number, expandY: number };
	readonly uncommittedChanges: GraphUncommittedChangesStyle;
}

export interface KeybindingConfig {
	readonly find: string | null;
	readonly refresh: string | null;
	readonly scrollToHead: string | null;
	readonly scrollToStash: string | null;
}

export type LoadGitGraphViewTo = {
	readonly repo: string,
	readonly commitDetails?: {
		readonly commitHash: string,
		readonly compareWithHash: string | null
	},
	readonly findCommitHash?: string,
	readonly runCommandOnLoad?: 'fetch',
	readonly filterPath?: string
} | null;

export interface MuteCommitsConfig {
	readonly commitsNotAncestorsOfHead: boolean;
	readonly mergeCommits: boolean;
}

export interface OnRepoLoadConfig {
	readonly scrollToHead: boolean;
	readonly showCheckedOutBranch: boolean;
	readonly showSpecificBranches: ReadonlyArray<string>;
}

export interface ReferenceLabelsConfig {
	readonly branchLabelsAlignedToGraph: boolean;
	readonly combineLocalAndRemoteBranchLabels: boolean;
	readonly tagLabelsOnRight: boolean;
}


/* Extension Settings Types */

export const enum BooleanOverride {
	Default,
	Enabled,
	Disabled
}

export const enum CommitDetailsViewLocation {
	Inline,
	DockedToBottom
}

export const enum CommitOrdering {
	Date = 'date',
	AuthorDate = 'author-date',
	Topological = 'topo'
}

export interface ContextMenuActionsVisibility {
	readonly branch: {
		readonly checkout: boolean;
		readonly rename: boolean;
		readonly delete: boolean;
		readonly merge: boolean;
		readonly rebase: boolean;
		readonly push: boolean;
		readonly pull: boolean;
		readonly createBranch: boolean;
		readonly viewIssue: boolean;
		readonly createPullRequest: boolean;
		readonly createArchive: boolean;
		readonly selectInBranchesDropdown: boolean;
		readonly unselectInBranchesDropdown: boolean;
		readonly copyName: boolean;
	};
	readonly commit: {
		readonly addTag: boolean;
		readonly createBranch: boolean;
		readonly checkout: boolean;
		readonly cherrypick: boolean;
		readonly revert: boolean;
		readonly drop: boolean;
		readonly merge: boolean;
		readonly rebase: boolean;
		readonly reset: boolean;
			readonly undo: boolean;
			readonly editMessage: boolean;
			readonly fixup: boolean;
			readonly squash: boolean;
			readonly copyHash: boolean;
		readonly copySubject: boolean;
	};
	readonly commitDetailsViewFile: {
		readonly viewDiff: boolean;
		readonly viewFileAtThisRevision: boolean;
		readonly viewDiffWithWorkingFile: boolean;
		readonly openFile: boolean;
		readonly markAsReviewed: boolean;
		readonly markAsNotReviewed: boolean;
		readonly resetFileToThisRevision: boolean;
		readonly copyAbsoluteFilePath: boolean;
		readonly copyRelativeFilePath: boolean;
	};
	readonly remoteBranch: {
		readonly checkout: boolean;
		readonly delete: boolean;
		readonly fetch: boolean;
		readonly merge: boolean;
		readonly pull: boolean;
		readonly createBranch: boolean;
		readonly viewIssue: boolean;
		readonly createPullRequest: boolean;
		readonly createArchive: boolean;
		readonly selectInBranchesDropdown: boolean;
		readonly unselectInBranchesDropdown: boolean;
		readonly copyName: boolean;
	};
	readonly stash: {
		readonly apply: boolean;
		readonly createBranch: boolean;
		readonly pop: boolean;
		readonly drop: boolean;
		readonly copyName: boolean;
		readonly copyHash: boolean;
	};
	readonly tag: {
		readonly viewDetails: boolean;
		readonly delete: boolean;
		readonly push: boolean;
		readonly createArchive: boolean;
		readonly copyName: boolean;
	};
	readonly uncommittedChanges: {
		readonly stash: boolean;
		readonly reset: boolean;
		readonly clean: boolean;
		readonly openSourceControlView: boolean;
	};
}

export interface CustomBranchGlobPattern {
	readonly name: string;
	readonly glob: string;
}

export interface CustomEmojiShortcodeMapping {
	readonly shortcode: string;
	readonly emoji: string;
}

export interface CustomPullRequestProvider {
	readonly name: string;
	readonly templateUrl: string;
}

/**
 * One commit author identity of the `git-graph-rs.commitAuthors` Extension Setting (e.g. an open
 * source identity and a company identity). A repository switches between these in the Settings
 * widget, which applies the selected identity as the repository's local `user.name`/`user.email`.
 */
export interface CommitAuthor {
	readonly name: string;
	readonly email: string;
}

export interface DateFormat {
	readonly type: DateFormatType;
	readonly iso: boolean;
}

export const enum DateFormatType {
	DateAndTime,
	DateOnly,
	Relative
}

export const enum DateType {
	Author,
	Commit
}

export interface DefaultColumnVisibility {
	readonly date: boolean;
	readonly author: boolean;
	readonly commit: boolean;
}

export interface DialogDefaults {
	readonly addTag: {
		readonly pushToRemote: boolean,
		readonly type: TagType
	};
	readonly applyStash: {
		readonly reinstateIndex: boolean
	};
	readonly cherryPick: {
		readonly noCommit: boolean,
		readonly recordOrigin: boolean
	};
	readonly createBranch: {
		readonly checkout: boolean
	};
	readonly deleteBranch: {
		readonly forceDelete: boolean
	};
	readonly fetchIntoLocalBranch: {
		readonly forceFetch: boolean
	};
	readonly fetchRemote: {
		readonly prune: boolean,
		readonly pruneTags: boolean
	};
	readonly general: {
		readonly referenceInputSpaceSubstitution: string | null
	};
	readonly merge: {
		readonly noCommit: boolean,
		readonly noFastForward: boolean,
		readonly squash: boolean
	};
	readonly popStash: {
		readonly reinstateIndex: boolean
	};
	readonly pullBranch: {
		readonly noFastForward: boolean,
		readonly squash: boolean
	};
	readonly rebase: {
		readonly ignoreDate: boolean,
		readonly interactive: boolean,
		readonly autosquash: boolean
	};
	readonly resetCommit: {
		readonly mode: GitResetMode
	};
	readonly resetUncommitted: {
		readonly mode: Exclude<GitResetMode, GitResetMode.Soft>
	};
	readonly stashUncommittedChanges: {
		readonly includeUntracked: boolean
	};
}

export const enum FileViewType {
	Default,
	Tree,
	List
}

export const enum GraphStyle {
	Rounded,
	Angular
}

export const enum GraphUncommittedChangesStyle {
	OpenCircleAtTheUncommittedChanges,
	OpenCircleAtTheCheckedOutCommit
}

export const enum RefLabelAlignment {
	Normal,
	BranchesOnLeftAndTagsOnRight,
	BranchesAlignedToGraphAndTagsOnRight
}

export const enum RepoCommitOrdering {
	Default = 'default',
	Date = 'date',
	AuthorDate = 'author-date',
	Topological = 'topo'
}

export const enum RepoDropdownOrder {
	FullPath,
	Name,
	WorkspaceFullPath
}

export const enum SquashMessageFormat {
	Default,
	GitSquashMsg
}

export const enum TabIconColourTheme {
	Colour,
	Grey
}

export const enum TagType {
	Annotated,
	Lightweight
}

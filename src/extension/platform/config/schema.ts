// --------------------------------------------------------------------------------------
// Setting value types (derived from the package.json manifest's declared types)
// --------------------------------------------------------------------------------------

/** A `git-graph-rs.customBranchGlobPatterns` entry, as the manifest declares it. */
export interface BranchGlobPatternSetting {
	readonly name: string;
	readonly glob: string;
}

/** A `git-graph-rs.customEmojiShortcodeMappings` entry, as the manifest declares it. */
export interface EmojiShortcodeMappingSetting {
	readonly shortcode: string;
	readonly emoji: string;
}

/** A `git-graph-rs.customPullRequestProviders` entry, as the manifest declares it. */
export interface PullRequestProviderSetting {
	readonly name: string;
	readonly templateUrl: string;
}

/** A `git-graph-rs.commitAuthors` entry: an identity the Settings widget can switch to. */
export interface CommitAuthorSetting {
	readonly name: string;
	readonly email: string;
}

/** The menu groups of `git-graph-rs.contextMenuActionsVisibility`. */
export type ContextMenuVisibilityGroup = 'branch' | 'commit' | 'commitDetailsViewFile' | 'remoteBranch' | 'stash' | 'tag' | 'uncommittedChanges';

/**
 * The raw `git-graph-rs.contextMenuActionsVisibility` object: per menu group, which actions are
 * visible (the manifest declares the known action names; the value is read leniently as a
 * string-keyed boolean map, exactly like the live reader that preceded this module merged it).
 */
export type ContextMenuActionsVisibilitySetting = Readonly<Record<ContextMenuVisibilityGroup, Readonly<Record<string, boolean>>>>;

/** The raw `git-graph-rs.defaultColumnVisibility` object. */
export interface DefaultColumnVisibilitySetting {
	readonly Date: boolean;
	readonly Author: boolean;
	readonly Commit: boolean;
}

/** A `git-graph-rs.keyboardShortcut.*` value (the full manifest enum, `UNASSIGNED` included). */
export type KeyboardShortcutSetting = 'UNASSIGNED'
	| 'CTRL/CMD + A' | 'CTRL/CMD + B' | 'CTRL/CMD + C' | 'CTRL/CMD + D' | 'CTRL/CMD + E' | 'CTRL/CMD + F' | 'CTRL/CMD + G'
	| 'CTRL/CMD + H' | 'CTRL/CMD + I' | 'CTRL/CMD + J' | 'CTRL/CMD + K' | 'CTRL/CMD + L' | 'CTRL/CMD + M' | 'CTRL/CMD + N'
	| 'CTRL/CMD + O' | 'CTRL/CMD + P' | 'CTRL/CMD + Q' | 'CTRL/CMD + R' | 'CTRL/CMD + S' | 'CTRL/CMD + T' | 'CTRL/CMD + U'
	| 'CTRL/CMD + V' | 'CTRL/CMD + W' | 'CTRL/CMD + X' | 'CTRL/CMD + Y' | 'CTRL/CMD + Z';

/** A `git-graph-rs.openNewTabEditorGroup` value. */
export type OpenNewTabEditorGroupSetting = 'Active' | 'Beside' | 'One' | 'Two' | 'Three' | 'Four' | 'Five' | 'Six' | 'Seven' | 'Eight' | 'Nine';

// --------------------------------------------------------------------------------------
// ConfigSnapshot: one field per contributed setting, grouped by manifest section
// --------------------------------------------------------------------------------------

/**
 * One immutable reading of every `git-graph-rs.*` extension setting, taken once at the start of
 * a request (REFACTOR-PLAN task 4.5). Field names are the camelCase join of the dotted setting
 * key (`commitDetailsView.autoCenter` -> `commitDetailsViewAutoCenter`); the order and grouping
 * follow the package.json manifest, and the {@link CONFIG_SCHEMA} table below is that mapping,
 * typed against this interface so a table row cannot drift from its field's type.
 */
export interface ConfigSnapshot {
	// --- Commit Details View ---
	readonly commitDetailsViewAutoCenter: boolean;
	readonly commitDetailsViewFileViewFileTreeCompactFolders: boolean;
	readonly commitDetailsViewFileViewType: 'File Tree' | 'File List';
	readonly commitDetailsViewLocation: 'Inline' | 'Docked to Bottom';

	// --- Context Menu ---
	readonly contextMenuActionsVisibility: ContextMenuActionsVisibilitySetting;

	// --- Custom Data (globs, emoji, providers, avatars, authors) ---
	readonly customBranchGlobPatterns: ReadonlyArray<BranchGlobPatternSetting>;
	readonly customEmojiShortcodeMappings: ReadonlyArray<EmojiShortcodeMappingSetting>;
	readonly customPullRequestProviders: ReadonlyArray<PullRequestProviderSetting>;
	readonly avatarsGitlabToken: string;
	readonly commitAuthors: ReadonlyArray<CommitAuthorSetting>;

	// --- Dates and Columns ---
	readonly dateFormat: 'Date & Time' | 'Date Only' | 'ISO Date & Time' | 'ISO Date Only' | 'Relative';
	readonly dateType: 'Author Date' | 'Commit Date';
	readonly defaultColumnVisibility: DefaultColumnVisibilitySetting;

	// --- Dialog Defaults ---
	readonly dialogAddTagPushToRemote: boolean;
	readonly dialogAddTagType: 'Annotated' | 'Lightweight';
	readonly dialogApplyStashReinstateIndex: boolean;
	readonly dialogCherryPickNoCommit: boolean;
	readonly dialogCherryPickRecordOrigin: boolean;
	readonly dialogCreateBranchCheckOut: boolean;
	readonly dialogDeleteBranchForceDelete: boolean;
	readonly dialogFetchIntoLocalBranchForceFetch: boolean;
	readonly dialogFetchRemotePrune: boolean;
	readonly dialogFetchRemotePruneTags: boolean;
	readonly dialogGeneralReferenceInputSpaceSubstitution: 'None' | 'Hyphen' | 'Underscore';
	readonly dialogMergeNoCommit: boolean;
	readonly dialogMergeNoFastForward: boolean;
	readonly dialogMergeSquashCommits: boolean;
	readonly dialogMergeSquashMessageFormat: 'Default' | 'Git SQUASH_MSG';
	readonly dialogPopStashReinstateIndex: boolean;
	readonly dialogPullBranchNoFastForward: boolean;
	readonly dialogPullBranchSquashCommits: boolean;
	readonly dialogPullBranchSquashMessageFormat: 'Default' | 'Git SQUASH_MSG';
	readonly dialogRebaseIgnoreDate: boolean;
	readonly dialogRebaseLaunchInteractiveRebase: boolean;
	readonly dialogRebaseAutosquash: boolean;
	readonly dialogResetCurrentBranchToCommitMode: 'Soft' | 'Mixed' | 'Hard';
	readonly dialogResetUncommittedChangesMode: 'Mixed' | 'Hard';
	readonly dialogStashUncommittedChangesIncludeUntracked: boolean;

	// --- General ---
	readonly enableLog: boolean;
	readonly enhancedAccessibility: boolean;
	readonly fileEncoding: string;
	readonly integratedTerminalShell: string;
	readonly interfaceLanguage: 'auto' | 'en' | 'zh-cn';
	readonly markdown: boolean;
	readonly maxDepthOfRepoSearch: number;
	readonly mobileAdaptation: boolean;
	readonly openNewTabEditorGroup: OpenNewTabEditorGroupSetting;
	readonly openToTheRepoOfTheActiveTextEditorDocument: boolean;
	readonly prewarm: boolean;
	readonly snapshotFirstPaint: boolean;

	// --- Graph ---
	readonly graphColours: ReadonlyArray<string>;
	readonly graphStyle: 'rounded' | 'angular';
	readonly graphFontSize: number;
	readonly graphRowHeight: number;
	readonly graphUncommittedChanges: 'Open Circle at the Uncommitted Changes' | 'Open Circle at the Checked Out Commit';

	// --- Keyboard Shortcuts ---
	readonly keyboardShortcutFind: KeyboardShortcutSetting;
	readonly keyboardShortcutRefresh: KeyboardShortcutSetting;
	readonly keyboardShortcutScrollToHead: KeyboardShortcutSetting;
	readonly keyboardShortcutScrollToStash: KeyboardShortcutSetting;

	// --- Reference Labels ---
	readonly referenceLabelsAlignment: 'Normal' | 'Branches (on the left) & Tags (on the right)' | 'Branches (aligned to the graph) & Tags (on the right)';
	readonly referenceLabelsCombineLocalAndRemoteBranchLabels: boolean;

	// --- Repository ---
	readonly repositoryExtDiffToolArgs: ReadonlyArray<string>;
	readonly repositoryCommitsFetchAvatars: boolean;
	readonly repositoryCommitsInitialLoad: number;
	readonly repositoryCommitsLoadMore: number;
	readonly repositoryCommitsLoadMoreAutomatically: boolean;
	readonly repositoryCommitsMuteCommitsThatAreNotAncestorsOfHead: boolean;
	readonly repositoryCommitsMuteMergeCommits: boolean;
	readonly repositoryCommitsOrder: 'date' | 'author-date' | 'topo';
	readonly repositoryCommitsShowBodyInline: boolean;
	readonly repositoryCommitsShowSignatureStatus: boolean;
	readonly repositoryFetchAndPrune: boolean;
	readonly repositoryTrackRemoteTags: boolean;
	readonly repositoryFetchAndPruneTags: boolean;
	readonly repositoryIncludeCommitsMentionedByReflogs: boolean;
	readonly repositoryOnLoadScrollToHead: boolean;
	readonly repositoryOnLoadShowCheckedOutBranch: boolean;
	readonly repositoryOnLoadShowSpecificBranches: ReadonlyArray<string>;
	readonly repositoryOnlyFollowFirstParent: boolean;
	readonly repositoryShowCommitsOnlyReferencedByTags: boolean;
	readonly repositoryShowRemoteBranches: boolean;
	readonly repositoryShowRemoteHeads: boolean;
	readonly repositoryShowStashes: boolean;
	readonly repositoryShowTags: boolean;
	readonly repositoryShowUncommittedChanges: boolean;
	readonly repositoryShowUntrackedFiles: boolean;
	readonly repositorySignCommits: boolean;
	readonly repositorySignTags: boolean;
	readonly repositoryUseMailmap: boolean;
	readonly repositoryDropdownOrder: 'Full Path' | 'Name' | 'Workspace Full Path';

	// --- Interface Chrome ---
	readonly retainContextWhenHidden: boolean;
	readonly showStatusBarItem: boolean;
	readonly sourceCodeProviderIntegrationLocation: 'Inline' | 'More Actions';
	readonly stickyHeader: boolean;
	readonly tabIconColourTheme: 'colour' | 'grey';

	// --- Integrations (Pull Requests, Gerrit) ---
	readonly pullRequestsEnabled: boolean;
	readonly gerritRemote: string;
	readonly gerritFetchLimit: number;
	readonly gerritShowReviewProgress: boolean;
}

// --------------------------------------------------------------------------------------
// The schema table: the one checked-in mirror of package.json#contributes.configuration
// --------------------------------------------------------------------------------------

/** The manifest's declared setting types, normalised (`integer` folds into `number`). */
export type SettingType = 'boolean' | 'number' | 'string' | 'array' | 'object';

/** A schema table row: the manifest facts of one contributed setting. */
export interface SchemaRow<K extends SnapshotField = SnapshotField> {
	/** The dotted setting key, relative to the `git-graph-rs` section (`package.json` order). */
	readonly key: string;
	/** The type the manifest declares for the setting (`integer` normalised to `number`). */
	readonly type: SettingType;
	/** The default the manifest declares - the one place any default is defined. */
	readonly default: ConfigSnapshot[K];
}

/** A field name of {@link ConfigSnapshot} (and therefore one contributed setting). */
export type SnapshotField = keyof ConfigSnapshot & string;

/**
 * The typed `field -> { key, type, default }` table of every contributed `git-graph-rs.*`
 * setting, in manifest order. This is the ONE place a default exists in code: every
 * {@link ConfigSnapshot} value a {@link ../snapshot} takes for an unset setting answers from
 * these rows, and `schema.test.ts` asserts the table's parity with the manifest in both
 * directions (every contributed key has a row with the same type and default; every row's key
 * is contributed). Adding a setting therefore means: a manifest entry, an interface field, and
 * one row here - and `takeSnapshot` needs no change.
 *
 * The one declared divergence from a pure manifest mirror is the unset `mobileAdaptation`
 * default being host-aware (Git Graph Studio defaults the phone layout on); the mechanism lives
 * in snapshot.ts's HOST_AWARE_DEFAULTS, and this row keeps the manifest's own default (`false`).
 */
export const CONFIG_SCHEMA: { readonly [K in SnapshotField]: SchemaRow<K> } = {
	// --- Commit Details View ---
	commitDetailsViewAutoCenter: { key: 'commitDetailsView.autoCenter', type: 'boolean', default: true },
	commitDetailsViewFileViewFileTreeCompactFolders: { key: 'commitDetailsView.fileView.fileTree.compactFolders', type: 'boolean', default: true },
	commitDetailsViewFileViewType: { key: 'commitDetailsView.fileView.type', type: 'string', default: 'File Tree' },
	commitDetailsViewLocation: { key: 'commitDetailsView.location', type: 'string', default: 'Inline' },

	// --- Context Menu ---
	contextMenuActionsVisibility: { key: 'contextMenuActionsVisibility', type: 'object', default: {} as ContextMenuActionsVisibilitySetting },

	// --- Custom Data ---
	customBranchGlobPatterns: { key: 'customBranchGlobPatterns', type: 'array', default: [] as ReadonlyArray<BranchGlobPatternSetting> },
	customEmojiShortcodeMappings: { key: 'customEmojiShortcodeMappings', type: 'array', default: [] as ReadonlyArray<EmojiShortcodeMappingSetting> },
	customPullRequestProviders: { key: 'customPullRequestProviders', type: 'array', default: [] as ReadonlyArray<PullRequestProviderSetting> },
	avatarsGitlabToken: { key: 'avatars.gitlabToken', type: 'string', default: '' },
	commitAuthors: { key: 'commitAuthors', type: 'array', default: [] as ReadonlyArray<CommitAuthorSetting> },

	// --- Dates and Columns ---
	dateFormat: { key: 'date.format', type: 'string', default: 'Date & Time' },
	dateType: { key: 'date.type', type: 'string', default: 'Author Date' },
	defaultColumnVisibility: { key: 'defaultColumnVisibility', type: 'object', default: { Date: true, Author: true, Commit: true } },

	// --- Dialog Defaults ---
	dialogAddTagPushToRemote: { key: 'dialog.addTag.pushToRemote', type: 'boolean', default: false },
	dialogAddTagType: { key: 'dialog.addTag.type', type: 'string', default: 'Annotated' },
	dialogApplyStashReinstateIndex: { key: 'dialog.applyStash.reinstateIndex', type: 'boolean', default: false },
	dialogCherryPickNoCommit: { key: 'dialog.cherryPick.noCommit', type: 'boolean', default: false },
	dialogCherryPickRecordOrigin: { key: 'dialog.cherryPick.recordOrigin', type: 'boolean', default: false },
	dialogCreateBranchCheckOut: { key: 'dialog.createBranch.checkOut', type: 'boolean', default: false },
	dialogDeleteBranchForceDelete: { key: 'dialog.deleteBranch.forceDelete', type: 'boolean', default: false },
	dialogFetchIntoLocalBranchForceFetch: { key: 'dialog.fetchIntoLocalBranch.forceFetch', type: 'boolean', default: false },
	dialogFetchRemotePrune: { key: 'dialog.fetchRemote.prune', type: 'boolean', default: false },
	dialogFetchRemotePruneTags: { key: 'dialog.fetchRemote.pruneTags', type: 'boolean', default: false },
	dialogGeneralReferenceInputSpaceSubstitution: { key: 'dialog.general.referenceInputSpaceSubstitution', type: 'string', default: 'None' },
	dialogMergeNoCommit: { key: 'dialog.merge.noCommit', type: 'boolean', default: false },
	dialogMergeNoFastForward: { key: 'dialog.merge.noFastForward', type: 'boolean', default: true },
	dialogMergeSquashCommits: { key: 'dialog.merge.squashCommits', type: 'boolean', default: false },
	dialogMergeSquashMessageFormat: { key: 'dialog.merge.squashMessageFormat', type: 'string', default: 'Default' },
	dialogPopStashReinstateIndex: { key: 'dialog.popStash.reinstateIndex', type: 'boolean', default: false },
	dialogPullBranchNoFastForward: { key: 'dialog.pullBranch.noFastForward', type: 'boolean', default: false },
	dialogPullBranchSquashCommits: { key: 'dialog.pullBranch.squashCommits', type: 'boolean', default: false },
	dialogPullBranchSquashMessageFormat: { key: 'dialog.pullBranch.squashMessageFormat', type: 'string', default: 'Default' },
	dialogRebaseIgnoreDate: { key: 'dialog.rebase.ignoreDate', type: 'boolean', default: true },
	dialogRebaseLaunchInteractiveRebase: { key: 'dialog.rebase.launchInteractiveRebase', type: 'boolean', default: false },
	dialogRebaseAutosquash: { key: 'dialog.rebase.autosquash', type: 'boolean', default: false },
	dialogResetCurrentBranchToCommitMode: { key: 'dialog.resetCurrentBranchToCommit.mode', type: 'string', default: 'Mixed' },
	dialogResetUncommittedChangesMode: { key: 'dialog.resetUncommittedChanges.mode', type: 'string', default: 'Mixed' },
	dialogStashUncommittedChangesIncludeUntracked: { key: 'dialog.stashUncommittedChanges.includeUntracked', type: 'boolean', default: true },

	// --- General ---
	enableLog: { key: 'enableLog', type: 'boolean', default: false },
	enhancedAccessibility: { key: 'enhancedAccessibility', type: 'boolean', default: false },
	fileEncoding: { key: 'fileEncoding', type: 'string', default: 'utf8' },
	integratedTerminalShell: { key: 'integratedTerminalShell', type: 'string', default: '' },
	interfaceLanguage: { key: 'interfaceLanguage', type: 'string', default: 'auto' },
	markdown: { key: 'markdown', type: 'boolean', default: true },
	maxDepthOfRepoSearch: { key: 'maxDepthOfRepoSearch', type: 'number', default: 0 },
	mobileAdaptation: { key: 'mobileAdaptation', type: 'boolean', default: false },
	openNewTabEditorGroup: { key: 'openNewTabEditorGroup', type: 'string', default: 'Active' },
	openToTheRepoOfTheActiveTextEditorDocument: { key: 'openToTheRepoOfTheActiveTextEditorDocument', type: 'boolean', default: false },
	prewarm: { key: 'prewarm', type: 'boolean', default: true },
	snapshotFirstPaint: { key: 'snapshotFirstPaint', type: 'boolean', default: true },

	// --- Graph ---
	graphColours: {
		key: 'graph.colours', type: 'array',
		default: ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00']
	},
	graphStyle: { key: 'graph.style', type: 'string', default: 'rounded' },
	graphFontSize: { key: 'graph.fontSize', type: 'number', default: 13 },
	graphRowHeight: { key: 'graph.rowHeight', type: 'number', default: 24 },
	graphUncommittedChanges: { key: 'graph.uncommittedChanges', type: 'string', default: 'Open Circle at the Uncommitted Changes' },

	// --- Keyboard Shortcuts ---
	keyboardShortcutFind: { key: 'keyboardShortcut.find', type: 'string', default: 'CTRL/CMD + F' },
	keyboardShortcutRefresh: { key: 'keyboardShortcut.refresh', type: 'string', default: 'CTRL/CMD + R' },
	keyboardShortcutScrollToHead: { key: 'keyboardShortcut.scrollToHead', type: 'string', default: 'CTRL/CMD + H' },
	keyboardShortcutScrollToStash: { key: 'keyboardShortcut.scrollToStash', type: 'string', default: 'CTRL/CMD + S' },

	// --- Reference Labels ---
	referenceLabelsAlignment: { key: 'referenceLabels.alignment', type: 'string', default: 'Normal' },
	referenceLabelsCombineLocalAndRemoteBranchLabels: { key: 'referenceLabels.combineLocalAndRemoteBranchLabels', type: 'boolean', default: true },

	// --- Repository ---
	repositoryExtDiffToolArgs: { key: 'repository.extDiffToolArgs', type: 'array', default: [] as ReadonlyArray<string> },
	repositoryCommitsFetchAvatars: { key: 'repository.commits.fetchAvatars', type: 'boolean', default: false },
	repositoryCommitsInitialLoad: { key: 'repository.commits.initialLoad', type: 'number', default: 300 },
	repositoryCommitsLoadMore: { key: 'repository.commits.loadMore', type: 'number', default: 100 },
	repositoryCommitsLoadMoreAutomatically: { key: 'repository.commits.loadMoreAutomatically', type: 'boolean', default: true },
	repositoryCommitsMuteCommitsThatAreNotAncestorsOfHead: { key: 'repository.commits.mute.commitsThatAreNotAncestorsOfHead', type: 'boolean', default: false },
	repositoryCommitsMuteMergeCommits: { key: 'repository.commits.mute.mergeCommits', type: 'boolean', default: true },
	repositoryCommitsOrder: { key: 'repository.commits.order', type: 'string', default: 'date' },
	repositoryCommitsShowBodyInline: { key: 'repository.commits.showBodyInline', type: 'boolean', default: false },
	repositoryCommitsShowSignatureStatus: { key: 'repository.commits.showSignatureStatus', type: 'boolean', default: false },
	repositoryFetchAndPrune: { key: 'repository.fetchAndPrune', type: 'boolean', default: false },
	repositoryTrackRemoteTags: { key: 'repository.trackRemoteTags', type: 'boolean', default: false },
	repositoryFetchAndPruneTags: { key: 'repository.fetchAndPruneTags', type: 'boolean', default: false },
	repositoryIncludeCommitsMentionedByReflogs: { key: 'repository.includeCommitsMentionedByReflogs', type: 'boolean', default: false },
	repositoryOnLoadScrollToHead: { key: 'repository.onLoad.scrollToHead', type: 'boolean', default: false },
	repositoryOnLoadShowCheckedOutBranch: { key: 'repository.onLoad.showCheckedOutBranch', type: 'boolean', default: false },
	repositoryOnLoadShowSpecificBranches: { key: 'repository.onLoad.showSpecificBranches', type: 'array', default: [] as ReadonlyArray<string> },
	repositoryOnlyFollowFirstParent: { key: 'repository.onlyFollowFirstParent', type: 'boolean', default: false },
	repositoryShowCommitsOnlyReferencedByTags: { key: 'repository.showCommitsOnlyReferencedByTags', type: 'boolean', default: true },
	repositoryShowRemoteBranches: { key: 'repository.showRemoteBranches', type: 'boolean', default: true },
	repositoryShowRemoteHeads: { key: 'repository.showRemoteHeads', type: 'boolean', default: true },
	repositoryShowStashes: { key: 'repository.showStashes', type: 'boolean', default: true },
	repositoryShowTags: { key: 'repository.showTags', type: 'boolean', default: true },
	repositoryShowUncommittedChanges: { key: 'repository.showUncommittedChanges', type: 'boolean', default: true },
	repositoryShowUntrackedFiles: { key: 'repository.showUntrackedFiles', type: 'boolean', default: true },
	repositorySignCommits: { key: 'repository.sign.commits', type: 'boolean', default: false },
	repositorySignTags: { key: 'repository.sign.tags', type: 'boolean', default: false },
	repositoryUseMailmap: { key: 'repository.useMailmap', type: 'boolean', default: false },
	repositoryDropdownOrder: { key: 'repositoryDropdownOrder', type: 'string', default: 'Workspace Full Path' },

	// --- Interface Chrome ---
	retainContextWhenHidden: { key: 'retainContextWhenHidden', type: 'boolean', default: true },
	showStatusBarItem: { key: 'showStatusBarItem', type: 'boolean', default: true },
	sourceCodeProviderIntegrationLocation: { key: 'sourceCodeProviderIntegrationLocation', type: 'string', default: 'Inline' },
	stickyHeader: { key: 'stickyHeader', type: 'boolean', default: true },
	tabIconColourTheme: { key: 'tabIconColourTheme', type: 'string', default: 'colour' },

	// --- Integrations ---
	pullRequestsEnabled: { key: 'pullRequests.enabled', type: 'boolean', default: false },
	gerritRemote: { key: 'gerrit.remote', type: 'string', default: 'origin' },
	gerritFetchLimit: { key: 'gerrit.fetchLimit', type: 'number', default: 20 },
	gerritShowReviewProgress: { key: 'gerrit.showReviewProgress', type: 'boolean', default: true }
};

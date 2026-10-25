/**
 * Platform config adapter (REFACTOR-PLAN 3.3 + task 4.5): reads the extension's contributed
 * settings into one immutable {@link ConfigSnapshot} of pure data.
 *
 * The snapshot mirrors `package.json#contributes.configuration` exactly - one field per
 * contributed key, in manifest order, typed from the manifest's declared types and defaulted to
 * the manifest's declared defaults - and nothing else. Host-aware policies built on top of the
 * raw values (for example the per-host `mobileAdaptation` default of src/config.ts) and cooked
 * enums (`FileViewType.List`, `GitResetMode.Soft`, ...) belong to the consumers of the snapshot,
 * not to the platform layer. config.test.ts derives the key list from package.json itself, so a
 * newly contributed setting without a snapshot field fails the suite.
 *
 * Deprecated keys migrate through {@link CONFIG_MIGRATIONS} (REFACTOR-PLAN 3.7.2, "User data"):
 * contributed keys are added, never removed, and a deprecated key keeps being read and mapped
 * onto its modern equivalent with the precedence `modern > deprecated > default`.
 */

/** The configuration section every git-graph-rs setting lives under. */
export const CONFIG_SECTION = 'git-graph-rs';

/**
 * The shape of `vscode.WorkspaceConfiguration` this module reads. Structural (no vscode import),
 * so tests inject a plain map - and the real object satisfies it without adaptation.
 */
export interface WorkspaceConfigurationLike {
	get<T>(section: string, defaultValue?: T): T | undefined;
}

/** The shape of `vscode.workspace` this module reads: one configuration lookup. */
export interface WorkspaceLike {
	getConfiguration(section?: string): WorkspaceConfigurationLike;
}

/** The shape of `vscode.ConfigurationChangeEvent` used to filter relevant changes. */
export interface ConfigurationChangeEventLike {
	affectsConfiguration(section: string, scope?: unknown): boolean;
}

/** The shape of `vscode.Disposable` returned by event subscriptions. */
export interface DisposableLike {
	dispose(): void;
}

/** A workspace that can also report configuration changes (vscode.workspace's event side). */
export interface ObservableWorkspaceLike extends WorkspaceLike {
	onDidChangeConfiguration(listener: (event: ConfigurationChangeEventLike) => void): DisposableLike;
}

// --------------------------------------------------------------------------------------
// Setting value types (derived from the package.json manifest's declared types)
// --------------------------------------------------------------------------------------

/** A `git-graph-rs.customBranchGlobPatterns` entry: a display name and its `git` glob. */
export interface BranchGlobPatternSetting {
	readonly name: string;
	readonly glob: string;
}

/** A `git-graph-rs.customEmojiShortcodeMappings` entry. */
export interface EmojiShortcodeMappingSetting {
	readonly shortcode: string;
	readonly emoji: string;
}

/** A `git-graph-rs.customPullRequestProviders` entry. */
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
 * string-keyed boolean map, exactly like the live reader in src/config.ts merges it).
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
 * follow the package.json manifest.
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
// Deprecated-key migrations
// --------------------------------------------------------------------------------------

/**
 * Deprecated setting keys -> their modern equivalents (REFACTOR-PLAN 3.7.2, "User data":
 * config keys are added, never removed; a deprecated key keeps being read and maps here).
 * When a setting is deprecated, its package.json entry gains a `deprecationMessage` and a row
 * `'old.key': 'new.key'` is added here; {@link readWithMigrations} then resolves every read of
 * the modern key with the precedence modern > deprecated > default.
 *
 * Surveyed at the introduction of this module: none of the 97 contributed settings carries a
 * deprecation message, and every key the live reader (src/config.ts) reads is still contributed,
 * so the table starts empty. config.test.ts fails as soon as a setting is marked deprecated
 * without a row here (and when a row's modern key stops being contributed).
 */
export const CONFIG_MIGRATIONS: Readonly<Record<string, string>> = {};

/**
 * Read one setting honouring the deprecated-key migrations: the modern key's value wins when it
 * is explicitly set; otherwise the deprecated key's value; otherwise the given default.
 * @param config The configuration to read from.
 * @param key The modern (dotted) setting key, relative to {@link CONFIG_SECTION}.
 * @param defaultValue The value returned when neither key is set (the manifest default).
 * @param migrations The deprecated -> modern table; defaults to {@link CONFIG_MIGRATIONS} and is
 * injectable so the precedence itself can be tested against a synthetic table.
 */
export function readWithMigrations<T>(config: WorkspaceConfigurationLike, key: string, defaultValue: T, migrations: Readonly<Record<string, string>> = CONFIG_MIGRATIONS): T {
	const modern = config.get<T>(key);
	if (modern !== undefined) return modern;
	const deprecatedKey = migrations[key];
	if (deprecatedKey !== undefined) {
		const deprecated = config.get<T>(deprecatedKey);
		if (deprecated !== undefined) return deprecated;
	}
	return defaultValue;
}

// --------------------------------------------------------------------------------------
// Snapshotting
// --------------------------------------------------------------------------------------

/**
 * Take a snapshot of every contributed `git-graph-rs.*` setting from the injected workspace.
 * Unset (and not migrated) settings answer with their package.json default.
 * @param workspace A workspace-like object (`vscode.workspace` satisfies this structurally).
 */
export function takeSnapshot(workspace: WorkspaceLike): ConfigSnapshot {
	const config = workspace.getConfiguration(CONFIG_SECTION);
	return {
		// --- Commit Details View ---
		commitDetailsViewAutoCenter: readWithMigrations(config, 'commitDetailsView.autoCenter', true),
		commitDetailsViewFileViewFileTreeCompactFolders: readWithMigrations(config, 'commitDetailsView.fileView.fileTree.compactFolders', true),
		commitDetailsViewFileViewType: readWithMigrations(config, 'commitDetailsView.fileView.type', 'File Tree'),
		commitDetailsViewLocation: readWithMigrations(config, 'commitDetailsView.location', 'Inline'),

		// --- Context Menu ---
		contextMenuActionsVisibility: readWithMigrations(config, 'contextMenuActionsVisibility', {} as ContextMenuActionsVisibilitySetting),

		// --- Custom Data ---
		customBranchGlobPatterns: readWithMigrations(config, 'customBranchGlobPatterns', [] as ReadonlyArray<BranchGlobPatternSetting>),
		customEmojiShortcodeMappings: readWithMigrations(config, 'customEmojiShortcodeMappings', [] as ReadonlyArray<EmojiShortcodeMappingSetting>),
		customPullRequestProviders: readWithMigrations(config, 'customPullRequestProviders', [] as ReadonlyArray<PullRequestProviderSetting>),
		avatarsGitlabToken: readWithMigrations(config, 'avatars.gitlabToken', ''),
		commitAuthors: readWithMigrations(config, 'commitAuthors', [] as ReadonlyArray<CommitAuthorSetting>),

		// --- Dates and Columns ---
		dateFormat: readWithMigrations(config, 'date.format', 'Date & Time'),
		dateType: readWithMigrations(config, 'date.type', 'Author Date'),
		defaultColumnVisibility: readWithMigrations(config, 'defaultColumnVisibility', { Date: true, Author: true, Commit: true }),

		// --- Dialog Defaults ---
		dialogAddTagPushToRemote: readWithMigrations(config, 'dialog.addTag.pushToRemote', false),
		dialogAddTagType: readWithMigrations(config, 'dialog.addTag.type', 'Annotated'),
		dialogApplyStashReinstateIndex: readWithMigrations(config, 'dialog.applyStash.reinstateIndex', false),
		dialogCherryPickNoCommit: readWithMigrations(config, 'dialog.cherryPick.noCommit', false),
		dialogCherryPickRecordOrigin: readWithMigrations(config, 'dialog.cherryPick.recordOrigin', false),
		dialogCreateBranchCheckOut: readWithMigrations(config, 'dialog.createBranch.checkOut', false),
		dialogDeleteBranchForceDelete: readWithMigrations(config, 'dialog.deleteBranch.forceDelete', false),
		dialogFetchIntoLocalBranchForceFetch: readWithMigrations(config, 'dialog.fetchIntoLocalBranch.forceFetch', false),
		dialogFetchRemotePrune: readWithMigrations(config, 'dialog.fetchRemote.prune', false),
		dialogFetchRemotePruneTags: readWithMigrations(config, 'dialog.fetchRemote.pruneTags', false),
		dialogGeneralReferenceInputSpaceSubstitution: readWithMigrations(config, 'dialog.general.referenceInputSpaceSubstitution', 'None'),
		dialogMergeNoCommit: readWithMigrations(config, 'dialog.merge.noCommit', false),
		dialogMergeNoFastForward: readWithMigrations(config, 'dialog.merge.noFastForward', true),
		dialogMergeSquashCommits: readWithMigrations(config, 'dialog.merge.squashCommits', false),
		dialogMergeSquashMessageFormat: readWithMigrations(config, 'dialog.merge.squashMessageFormat', 'Default'),
		dialogPopStashReinstateIndex: readWithMigrations(config, 'dialog.popStash.reinstateIndex', false),
		dialogPullBranchNoFastForward: readWithMigrations(config, 'dialog.pullBranch.noFastForward', false),
		dialogPullBranchSquashCommits: readWithMigrations(config, 'dialog.pullBranch.squashCommits', false),
		dialogPullBranchSquashMessageFormat: readWithMigrations(config, 'dialog.pullBranch.squashMessageFormat', 'Default'),
		dialogRebaseIgnoreDate: readWithMigrations(config, 'dialog.rebase.ignoreDate', true),
		dialogRebaseLaunchInteractiveRebase: readWithMigrations(config, 'dialog.rebase.launchInteractiveRebase', false),
		dialogRebaseAutosquash: readWithMigrations(config, 'dialog.rebase.autosquash', false),
		dialogResetCurrentBranchToCommitMode: readWithMigrations(config, 'dialog.resetCurrentBranchToCommit.mode', 'Mixed'),
		dialogResetUncommittedChangesMode: readWithMigrations(config, 'dialog.resetUncommittedChanges.mode', 'Mixed'),
		dialogStashUncommittedChangesIncludeUntracked: readWithMigrations(config, 'dialog.stashUncommittedChanges.includeUntracked', true),

		// --- General ---
		enableLog: readWithMigrations(config, 'enableLog', false),
		enhancedAccessibility: readWithMigrations(config, 'enhancedAccessibility', false),
		fileEncoding: readWithMigrations(config, 'fileEncoding', 'utf8'),
		integratedTerminalShell: readWithMigrations(config, 'integratedTerminalShell', ''),
		interfaceLanguage: readWithMigrations(config, 'interfaceLanguage', 'auto'),
		markdown: readWithMigrations(config, 'markdown', true),
		maxDepthOfRepoSearch: readWithMigrations(config, 'maxDepthOfRepoSearch', 0),
		mobileAdaptation: readWithMigrations(config, 'mobileAdaptation', false),
		openNewTabEditorGroup: readWithMigrations(config, 'openNewTabEditorGroup', 'Active'),
		openToTheRepoOfTheActiveTextEditorDocument: readWithMigrations(config, 'openToTheRepoOfTheActiveTextEditorDocument', false),

		// --- Graph ---
		graphColours: readWithMigrations(config, 'graph.colours', ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'] as ReadonlyArray<string>),
		graphStyle: readWithMigrations(config, 'graph.style', 'rounded'),
		graphFontSize: readWithMigrations(config, 'graph.fontSize', 13),
		graphRowHeight: readWithMigrations(config, 'graph.rowHeight', 24),
		graphUncommittedChanges: readWithMigrations(config, 'graph.uncommittedChanges', 'Open Circle at the Uncommitted Changes'),

		// --- Keyboard Shortcuts ---
		keyboardShortcutFind: readWithMigrations(config, 'keyboardShortcut.find', 'CTRL/CMD + F'),
		keyboardShortcutRefresh: readWithMigrations(config, 'keyboardShortcut.refresh', 'CTRL/CMD + R'),
		keyboardShortcutScrollToHead: readWithMigrations(config, 'keyboardShortcut.scrollToHead', 'CTRL/CMD + H'),
		keyboardShortcutScrollToStash: readWithMigrations(config, 'keyboardShortcut.scrollToStash', 'CTRL/CMD + S'),

		// --- Reference Labels ---
		referenceLabelsAlignment: readWithMigrations(config, 'referenceLabels.alignment', 'Normal'),
		referenceLabelsCombineLocalAndRemoteBranchLabels: readWithMigrations(config, 'referenceLabels.combineLocalAndRemoteBranchLabels', true),

		// --- Repository ---
		repositoryExtDiffToolArgs: readWithMigrations(config, 'repository.extDiffToolArgs', [] as ReadonlyArray<string>),
		repositoryCommitsFetchAvatars: readWithMigrations(config, 'repository.commits.fetchAvatars', false),
		repositoryCommitsInitialLoad: readWithMigrations(config, 'repository.commits.initialLoad', 300),
		repositoryCommitsLoadMore: readWithMigrations(config, 'repository.commits.loadMore', 100),
		repositoryCommitsLoadMoreAutomatically: readWithMigrations(config, 'repository.commits.loadMoreAutomatically', true),
		repositoryCommitsMuteCommitsThatAreNotAncestorsOfHead: readWithMigrations(config, 'repository.commits.mute.commitsThatAreNotAncestorsOfHead', false),
		repositoryCommitsMuteMergeCommits: readWithMigrations(config, 'repository.commits.mute.mergeCommits', true),
		repositoryCommitsOrder: readWithMigrations(config, 'repository.commits.order', 'date'),
		repositoryCommitsShowBodyInline: readWithMigrations(config, 'repository.commits.showBodyInline', false),
		repositoryCommitsShowSignatureStatus: readWithMigrations(config, 'repository.commits.showSignatureStatus', false),
		repositoryFetchAndPrune: readWithMigrations(config, 'repository.fetchAndPrune', false),
		repositoryTrackRemoteTags: readWithMigrations(config, 'repository.trackRemoteTags', false),
		repositoryFetchAndPruneTags: readWithMigrations(config, 'repository.fetchAndPruneTags', false),
		repositoryIncludeCommitsMentionedByReflogs: readWithMigrations(config, 'repository.includeCommitsMentionedByReflogs', false),
		repositoryOnLoadScrollToHead: readWithMigrations(config, 'repository.onLoad.scrollToHead', false),
		repositoryOnLoadShowCheckedOutBranch: readWithMigrations(config, 'repository.onLoad.showCheckedOutBranch', false),
		repositoryOnLoadShowSpecificBranches: readWithMigrations(config, 'repository.onLoad.showSpecificBranches', [] as ReadonlyArray<string>),
		repositoryOnlyFollowFirstParent: readWithMigrations(config, 'repository.onlyFollowFirstParent', false),
		repositoryShowCommitsOnlyReferencedByTags: readWithMigrations(config, 'repository.showCommitsOnlyReferencedByTags', true),
		repositoryShowRemoteBranches: readWithMigrations(config, 'repository.showRemoteBranches', true),
		repositoryShowRemoteHeads: readWithMigrations(config, 'repository.showRemoteHeads', true),
		repositoryShowStashes: readWithMigrations(config, 'repository.showStashes', true),
		repositoryShowTags: readWithMigrations(config, 'repository.showTags', true),
		repositoryShowUncommittedChanges: readWithMigrations(config, 'repository.showUncommittedChanges', true),
		repositoryShowUntrackedFiles: readWithMigrations(config, 'repository.showUntrackedFiles', true),
		repositorySignCommits: readWithMigrations(config, 'repository.sign.commits', false),
		repositorySignTags: readWithMigrations(config, 'repository.sign.tags', false),
		repositoryUseMailmap: readWithMigrations(config, 'repository.useMailmap', false),
		repositoryDropdownOrder: readWithMigrations(config, 'repositoryDropdownOrder', 'Workspace Full Path'),

		// --- Interface Chrome ---
		retainContextWhenHidden: readWithMigrations(config, 'retainContextWhenHidden', true),
		showStatusBarItem: readWithMigrations(config, 'showStatusBarItem', true),
		sourceCodeProviderIntegrationLocation: readWithMigrations(config, 'sourceCodeProviderIntegrationLocation', 'Inline'),
		stickyHeader: readWithMigrations(config, 'stickyHeader', true),
		tabIconColourTheme: readWithMigrations(config, 'tabIconColourTheme', 'colour'),

		// --- Integrations ---
		pullRequestsEnabled: readWithMigrations(config, 'pullRequests.enabled', false),
		gerritRemote: readWithMigrations(config, 'gerrit.remote', 'origin'),
		gerritFetchLimit: readWithMigrations(config, 'gerrit.fetchLimit', 20),
		gerritShowReviewProgress: readWithMigrations(config, 'gerrit.showReviewProgress', true)
	};
}

/**
 * Subscribe to configuration changes affecting the extension's settings: the callback fires with
 * a FRESH snapshot ({@link takeSnapshot} is re-run on every relevant event). Debouncing is
 * deliberately NOT provided - it is a consumer concern (the extension host coalesces editor-level
 * events, and different consumers want different windows).
 * @param workspace A workspace-like object that also reports configuration changes.
 * @param onChange Called with the fresh snapshot for every event affecting {@link CONFIG_SECTION}.
 * Events whose shape cannot be inspected (no `affectsConfiguration`) are treated as affecting.
 * @returns An unsubscribe function.
 */
export function onConfigChange(workspace: ObservableWorkspaceLike, onChange: (snapshot: ConfigSnapshot) => void): () => void {
	const subscription = workspace.onDidChangeConfiguration((event) => {
		if (event !== null && typeof event === 'object' && typeof event.affectsConfiguration === 'function'
			&& !event.affectsConfiguration(CONFIG_SECTION)) {
			return;
		}
		onChange(takeSnapshot(workspace));
	});
	return () => subscription.dispose();
}

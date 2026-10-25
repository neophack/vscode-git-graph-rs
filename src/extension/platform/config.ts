import * as vscode from 'vscode';
import {
	CommitAuthor,
	CommitDetailsViewConfig,
	CommitDetailsViewLocation,
	CommitOrdering,
	ContextMenuActionsVisibility,
	CustomBranchGlobPattern,
	CustomEmojiShortcodeMapping,
	CustomPullRequestProvider,
	DateFormat,
	DateFormatType,
	DateType,
	DefaultColumnVisibility,
	DialogDefaults,
	FileViewType,
	GerritConfig,
	GitResetMode,
	GraphConfig,
	GraphStyle,
	GraphUncommittedChangesStyle,
	KeybindingConfig,
	MuteCommitsConfig,
	OnRepoLoadConfig,
	PullRequestsConfig,
	RefLabelAlignment,
	ReferenceLabelsConfig,
	RepoDropdownOrder,
	SquashMessageFormat,
	TabIconColourTheme,
	TagType
} from '../../types';

/**
 * Platform config adapter (REFACTOR-PLAN 3.3 + task 4.5): the ONE configuration module,
 * unifying the config-snapshot surface this module introduced with the live per-repository
 * reader absorbed from the former flat src/config.ts (now a re-export shim of this module).
 *
 * The snapshot mirrors `package.json#contributes.configuration` exactly - one field per
 * contributed key, in manifest order, typed from the manifest's declared types and defaulted to
 * the manifest's declared defaults - and nothing else. Host-aware policies built on top of the
 * raw values (for example the per-host `mobileAdaptation` default of the legacy reader below)
 * and cooked enums (`FileViewType.List`, `GitResetMode.Soft`, ...) belong to the consumers of
 * the snapshot, not to the platform layer. config.test.ts derives the key list from
 * package.json itself, so a newly contributed setting without a snapshot field fails the suite.
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
	readonly prewarm: boolean;

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
		prewarm: readWithMigrations(config, 'prewarm', true),

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

// --------------------------------------------------------------------------------------
// The live per-repository reader (absorbed verbatim from the former flat src/config.ts)
// --------------------------------------------------------------------------------------

const VIEW_COLUMN_MAPPING: { [column: string]: vscode.ViewColumn } = {
	'Active': vscode.ViewColumn.Active,
	'Beside': vscode.ViewColumn.Beside,
	'One': vscode.ViewColumn.One,
	'Two': vscode.ViewColumn.Two,
	'Three': vscode.ViewColumn.Three,
	'Four': vscode.ViewColumn.Four,
	'Five': vscode.ViewColumn.Five,
	'Six': vscode.ViewColumn.Six,
	'Seven': vscode.ViewColumn.Seven,
	'Eight': vscode.ViewColumn.Eight,
	'Nine': vscode.ViewColumn.Nine
};

/**
 * Represents the users configuration of Git Graph Extension Settings.
 */
class Config {
	private readonly config: vscode.WorkspaceConfiguration;

	private static readonly KEYBINDING_REGEXP = /^CTRL\/CMD \+ [A-Z]$/;

	/**
	 * Creates a Config instance.
	 * @param repo An option path of a repository (to be used for Workspace Folder Scoped Configuration Values).
	 * @returns A Config instance.
	 */
	constructor(repo?: string) {
		this.config = vscode.workspace.getConfiguration('git-graph-rs', repo ? vscode.Uri.file(repo) : undefined);
	}

	/**
	 * Get the Commit Details View configuration from the Extension Settings.
	 */
	get commitDetailsView(): CommitDetailsViewConfig {
		return {
			autoCenter: !!this.config.get('commitDetailsView.autoCenter', true),
			fileTreeCompactFolders: !!this.config.get('commitDetailsView.fileView.fileTree.compactFolders', true),
			fileViewType: this.config.get<string>('commitDetailsView.fileView.type', 'File Tree') === 'File List'
				? FileViewType.List
				: FileViewType.Tree,
			location: this.config.get<string>('commitDetailsView.location', 'Inline') === 'Docked to Bottom'
				? CommitDetailsViewLocation.DockedToBottom
				: CommitDetailsViewLocation.Inline
		};
	}

	/**
	 * Get the value of the `git-graph-rs.contextMenuActionsVisibility` Extension Setting.
	 */
	get contextMenuActionsVisibility(): ContextMenuActionsVisibility {
		const userConfig = this.config.get('contextMenuActionsVisibility', {});
		const config: ContextMenuActionsVisibility = {
			branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
			commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, undo: true, editMessage: true, fixup: true, squash: true, copyHash: true, copySubject: true },
			commitDetailsViewFile: { viewDiff: true, viewFileAtThisRevision: true, viewDiffWithWorkingFile: true, openFile: true, markAsReviewed: true, markAsNotReviewed: true, resetFileToThisRevision: true, copyAbsoluteFilePath: true, copyRelativeFilePath: true },
			remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
			stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true },
			tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
			uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true }
		};
		mergeConfigObjects(config, userConfig);
		return config;
	}

	/**
	 * Get the value of the `git-graph-rs.customBranchGlobPatterns` Extension Setting.
	 */
	get customBranchGlobPatterns(): CustomBranchGlobPattern[] {
		let inPatterns = this.config.get('customBranchGlobPatterns', <any[]>[]);
		let outPatterns: CustomBranchGlobPattern[] = [];
		if (!Array.isArray(inPatterns)) return outPatterns;
		for (let i = 0; i < inPatterns.length; i++) {
			if (typeof inPatterns[i] === 'object' && inPatterns[i] !== null
				&& typeof inPatterns[i].name === 'string' && typeof inPatterns[i].glob === 'string') {
				outPatterns.push({ name: inPatterns[i].name, glob: '--glob=' + inPatterns[i].glob });
			}
		}
		return outPatterns;
	}

	/**
	 * Get the value of the `git-graph-rs.customEmojiShortcodeMappings` Extension Setting.
	 */
	get customEmojiShortcodeMappings(): CustomEmojiShortcodeMapping[] {
		let inMappings = this.config.get('customEmojiShortcodeMappings', <any[]>[]);
		let outMappings: CustomEmojiShortcodeMapping[] = [];
		if (!Array.isArray(inMappings)) return outMappings;
		for (let i = 0; i < inMappings.length; i++) {
			if (typeof inMappings[i] === 'object' && inMappings[i] !== null
				&& typeof inMappings[i].shortcode === 'string' && typeof inMappings[i].emoji === 'string') {
				outMappings.push({ shortcode: inMappings[i].shortcode, emoji: inMappings[i].emoji });
			}
		}
		return outMappings;
	}

	/**
	 * Get the value of the `git-graph-rs.pullRequests.enabled` Extension Setting.
	 */
	get pullRequests(): PullRequestsConfig {
		return {
			enabled: !!this.config.get('pullRequests.enabled', false)
		};
	}

	/**
	 * Get the value of the `git-graph-rs.gerrit.*` Extension Settings.
	 */
	get gerrit(): GerritConfig {
		const fetchLimit = this.config.get<number>('gerrit.fetchLimit', 20);
		return {
			remote: this.config.get<string>('gerrit.remote', 'origin'),
			fetchLimit: Number.isFinite(fetchLimit) && fetchLimit >= 1 && fetchLimit <= 10000 ? Math.floor(fetchLimit) : 20,
			showReviewProgress: !!this.config.get('gerrit.showReviewProgress', true)
		};
	}

	/**
	 * Get the value of the `git-graph-rs.commitAuthors` Extension Setting: the commit author
	 * identities a repository can switch between in the Settings widget.
	 */
	get commitAuthors(): CommitAuthor[] {
		let authors = this.config.get('commitAuthors', <any[]>[]);
		return Array.isArray(authors)
			? authors
				.filter((author) => typeof author === 'object' && author !== null && typeof author.name === 'string' && author.name.trim() !== '' && typeof author.email === 'string' && author.email.trim() !== '')
				.map((author) => ({ name: author.name, email: author.email }))
			: [];
	}

	/**
	 * Get the value of the `git-graph-rs.customPullRequestProviders` Extension Setting.
	 */
	get customPullRequestProviders(): CustomPullRequestProvider[] {
		let providers = this.config.get('customPullRequestProviders', <any[]>[]);
		return Array.isArray(providers)
			? providers
				.filter((provider) => typeof provider === 'object' && provider !== null && typeof provider.name === 'string' && typeof provider.templateUrl === 'string')
				.map((provider) => ({ name: provider.name, templateUrl: provider.templateUrl }))
			: [];
	}

	/**
	 * Get the value of the `git-graph-rs.date.format` Extension Setting.
	 */
	get dateFormat(): DateFormat {
		let configValue = this.config.get<string>('date.format', 'Date & Time'), type = DateFormatType.DateAndTime, iso = false;
		if (configValue === 'Relative') {
			type = DateFormatType.Relative;
		} else {
			if (configValue.endsWith('Date Only')) type = DateFormatType.DateOnly;
			if (configValue.startsWith('ISO')) iso = true;
		}
		return { type: type, iso: iso };
	}

	/**
	 * Get the value of the `git-graph-rs.date.type` Extension Setting.
	 */
	get dateType() {
		return this.config.get<string>('date.type', 'Author Date') === 'Commit Date'
			? DateType.Commit
			: DateType.Author;
	}

	/**
	 * Get the value of the `git-graph-rs.defaultColumnVisibility` Extension Setting.
	 */
	get defaultColumnVisibility(): DefaultColumnVisibility {
		let obj: any = this.config.get('defaultColumnVisibility', {});
		if (typeof obj === 'object' && obj !== null && typeof obj['Date'] === 'boolean' && typeof obj['Author'] === 'boolean' && typeof obj['Commit'] === 'boolean') {
			return { author: obj['Author'], commit: obj['Commit'], date: obj['Date'] };
		} else {
			return { author: true, commit: true, date: true };
		}
	}

	/**
	 * Get the value of the `git-graph-rs.dialog.*` Extension Settings.
	 */
	get dialogDefaults(): DialogDefaults {
		let resetCommitMode = this.config.get<string>('dialog.resetCurrentBranchToCommit.mode', 'Mixed');
		let resetUncommittedMode = this.config.get<string>('dialog.resetUncommittedChanges.mode', 'Mixed');
		let refInputSpaceSubstitution = this.config.get<string>('dialog.general.referenceInputSpaceSubstitution', 'None');

		return {
			addTag: {
				pushToRemote: !!this.config.get('dialog.addTag.pushToRemote', false),
				type: this.config.get<string>('dialog.addTag.type', 'Annotated') === 'Lightweight' ? TagType.Lightweight : TagType.Annotated
			},
			applyStash: {
				reinstateIndex: !!this.config.get('dialog.applyStash.reinstateIndex', false)
			},
			cherryPick: {
				noCommit: !!this.config.get('dialog.cherryPick.noCommit', false),
				recordOrigin: !!this.config.get('dialog.cherryPick.recordOrigin', false)
			},
			createBranch: {
				checkout: !!this.config.get('dialog.createBranch.checkOut', false)
			},
			deleteBranch: {
				forceDelete: !!this.config.get('dialog.deleteBranch.forceDelete', false)
			},
			fetchIntoLocalBranch: {
				forceFetch: !!this.config.get('dialog.fetchIntoLocalBranch.forceFetch', false)
			},
			fetchRemote: {
				prune: !!this.config.get('dialog.fetchRemote.prune', false),
				pruneTags: !!this.config.get('dialog.fetchRemote.pruneTags', false)
			},
			general: {
				referenceInputSpaceSubstitution: refInputSpaceSubstitution === 'Hyphen' ? '-' : refInputSpaceSubstitution === 'Underscore' ? '_' : null
			},
			merge: {
				noCommit: !!this.config.get('dialog.merge.noCommit', false),
				noFastForward: !!this.config.get('dialog.merge.noFastForward', true),
				squash: !!this.config.get('dialog.merge.squashCommits', false)
			},
			popStash: {
				reinstateIndex: !!this.config.get('dialog.popStash.reinstateIndex', false)
			},
			pullBranch: {
				noFastForward: !!this.config.get('dialog.pullBranch.noFastForward', false),
				squash: !!this.config.get('dialog.pullBranch.squashCommits', false)
			},
			rebase: {
				ignoreDate: !!this.config.get('dialog.rebase.ignoreDate', true),
				interactive: !!this.config.get('dialog.rebase.launchInteractiveRebase', false),
				autosquash: !!this.config.get('dialog.rebase.autosquash', false)
			},
			resetCommit: {
				mode: resetCommitMode === 'Soft' ? GitResetMode.Soft : (resetCommitMode === 'Hard' ? GitResetMode.Hard : GitResetMode.Mixed)
			},
			resetUncommitted: {
				mode: resetUncommittedMode === 'Hard' ? GitResetMode.Hard : GitResetMode.Mixed
			},
			stashUncommittedChanges: {
				includeUntracked: !!this.config.get('dialog.stashUncommittedChanges.includeUntracked', true)
			}
		};
	}

	/**
	 * Get the value of the `git-graph-rs.dialog.merge.squashMessageFormat` Extension Setting.
	 */
	get squashMergeMessageFormat() {
		return this.config.get<string>('dialog.merge.squashMessageFormat', 'Default') === 'Git SQUASH_MSG'
			? SquashMessageFormat.GitSquashMsg
			: SquashMessageFormat.Default;
	}

	/**
	 * Get the value of the `git-graph-rs.dialog.pullBranch.squashMessageFormat` Extension Setting.
	 */
	get squashPullMessageFormat() {
		return this.config.get<string>('dialog.pullBranch.squashMessageFormat', 'Default') === 'Git SQUASH_MSG'
			? SquashMessageFormat.GitSquashMsg
			: SquashMessageFormat.Default;
	}

	/**
	 * Get the value of the `git-graph-rs.enhancedAccessibility` Extension Setting.
	 */
	get enhancedAccessibility() {
		return !!this.config.get('enhancedAccessibility', false);
	}

	/**
	 * Get the value of the `git-graph-rs.fileEncoding` Extension Setting.
	 */
	get fileEncoding() {
		return this.config.get<string>('fileEncoding', 'utf8');
	}

	/**
	 * Get the graph configuration from the Extension Settings.
	 */
	get graph(): GraphConfig {
		const colours = this.config.get<string[]>('graph.colours', []);
		const validColours = Array.isArray(colours) ? colours.filter((v) => v.match(/^\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb[a]?\s*\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\))\s*$/) !== null) : [];
		return {
			// An array whose every entry is invalid must fall back to the defaults too: an empty
			// palette would leave the webview computing `colours[n % 0]` — every graph line
			// rendered undefined-coloured.
			colours: validColours.length > 0
				? validColours
				: ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'],
			style: this.config.get<string>('graph.style', 'rounded') === 'angular'
				? GraphStyle.Angular
				: GraphStyle.Rounded,
			fontSize: this.config.get<number>('graph.fontSize', 13),
			rowHeight: this.config.get<number>('graph.rowHeight', 24),
			grid: { x: 16, y: this.config.get<number>('graph.rowHeight', 24), offsetX: 16, offsetY: this.config.get<number>('graph.rowHeight', 24) / 2, expandY: 250 },
			uncommittedChanges: this.config.get<string>('graph.uncommittedChanges', 'Open Circle at the Uncommitted Changes') === 'Open Circle at the Checked Out Commit'
				? GraphUncommittedChangesStyle.OpenCircleAtTheCheckedOutCommit
				: GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges
		};
	}

	/**
	 * Get the value of the `git-graph-rs.enableLog` Extension Setting.
	 */
	get enableLog(): boolean {
		return this.config.get<boolean>('enableLog', false);
	}

	/**
	 * Get the raw value of the `git-graph-rs.interfaceLanguage` Extension Setting (including
	 * "auto", which defers the language to Visual Studio Code's display language).
	 */
	get interfaceLanguageSetting(): 'auto' | 'en' | 'zh-cn' {
		const value = this.config.get<string>('interfaceLanguage', 'auto');
		return value === 'en' || value === 'zh-cn' ? value : 'auto';
	}

	/**
	 * Get the interface language to render the Git Graph interface with: the explicitly configured
	 * `git-graph-rs.interfaceLanguage` Extension Setting, or — when it is set to "auto" (the
	 * default) — the language Visual Studio Code itself is displayed in.
	 */
	get interfaceLanguage(): 'en' | 'zh-cn' {
		const setting = this.interfaceLanguageSetting;
		if (setting !== 'auto') return setting;
		return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
	}

	/**
	 * Get the value of the `git-graph-rs.integratedTerminalShell` Extension Setting.
	 */
	get integratedTerminalShell() {
		return this.config.get('integratedTerminalShell', '');
	}

	/**
	 * Get the keybinding configuration from the `git-graph-rs.keyboardShortcut.*` Extension Settings.
	 */
	get keybindings(): KeybindingConfig {
		return {
			find: this.getKeybinding('keyboardShortcut.find', 'f'),
			refresh: this.getKeybinding('keyboardShortcut.refresh', 'r'),
			scrollToHead: this.getKeybinding('keyboardShortcut.scrollToHead', 'h'),
			scrollToStash: this.getKeybinding('keyboardShortcut.scrollToStash', 's')
		};
	}

	/**
	 * Get the value of the `git-graph-rs.maxDepthOfRepoSearch` Extension Setting.
	 */
	get maxDepthOfRepoSearch() {
		return this.config.get('maxDepthOfRepoSearch', 0);
	}

	/**
	 * Get the value of the `git-graph-rs.markdown` Extension Setting.
	 */
	get markdown() {
		return !!this.config.get('markdown', true);
	}

	/**
	 * Get the value of the `git-graph-rs.mobileAdaptation` Extension Setting.
	 *
	 * The unset value defaults per host: Git Graph Studio (uriScheme 'ggs') turns the narrow-window
	 * phone layout on — its remote phone sessions are the layout's whole audience — while VS Code
	 * keeps the marketplace default (off). An explicitly set value always wins on every host. The
	 * activation seeds the studio default into the settings store once (extension.ts), so this
	 * host-aware fallback only covers the window before that write lands.
	 */
	get mobileAdaptation() {
		// An explicitly set value wins on every host; the unset one defaults per host — Git Graph
		// Studio (uriScheme 'ggs') on, VS Code off. `inspect` tells a set value from the default;
		// a configuration object without it (a harness stand-in) answers through `has` instead.
		let explicit: boolean | undefined;
		if (typeof this.config.inspect === 'function') {
			const inspected = this.config.inspect<boolean>('mobileAdaptation');
			// VS Code's own precedence: the most specific scope wins
			explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
		} else if (this.config.has('mobileAdaptation')) {
			explicit = this.config.get<boolean>('mobileAdaptation');
		}
		if (explicit !== undefined) return !!explicit;
		if (vscode.env.uriScheme === 'ggs') return true;
		return !!this.config.get('mobileAdaptation', false);
	}

	/**
	 * Get the value of the `git-graph-rs.openNewTabEditorGroup` Extension Setting.
	 */
	get openNewTabEditorGroup(): vscode.ViewColumn {
		const location = this.config.get<string>('openNewTabEditorGroup', 'Active');
		return typeof location === 'string' && typeof VIEW_COLUMN_MAPPING[location] !== 'undefined'
			? VIEW_COLUMN_MAPPING[location]
			: vscode.ViewColumn.Active;
	}

	/**
	 * Get the value of the `git-graph-rs.openToTheRepoOfTheActiveTextEditorDocument` Extension Setting.
	 */
	get openToTheRepoOfTheActiveTextEditorDocument() {
		return !!this.config.get('openToTheRepoOfTheActiveTextEditorDocument', false);
	}

	/**
	 * Get the reference label configuration from the Extension Settings.
	 */
	get referenceLabels(): ReferenceLabelsConfig {
		const alignmentConfigValue = this.config.get<string>('referenceLabels.alignment', 'Normal');
		const alignment = alignmentConfigValue === 'Branches (on the left) & Tags (on the right)'
			? RefLabelAlignment.BranchesOnLeftAndTagsOnRight
			: alignmentConfigValue === 'Branches (aligned to the graph) & Tags (on the right)'
				? RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight
				: RefLabelAlignment.Normal;
		return {
			branchLabelsAlignedToGraph: alignment === RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight,
			combineLocalAndRemoteBranchLabels: !!this.config.get('referenceLabels.combineLocalAndRemoteBranchLabels', true),
			tagLabelsOnRight: alignment !== RefLabelAlignment.Normal
		};
	}

	/**
	 * Get the value of the `git-graph-rs.repository.commits.fetchAvatars` Extension Setting.
	 */
	get fetchAvatars() {
		return !!this.config.get('repository.commits.fetchAvatars', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.commits.initialLoad` Extension Setting.
	 */
	get initialLoadCommits() {
		return this.config.get('repository.commits.initialLoad', 300);
	}


	/**
	 * Get the value of the `git-graph-rs.repository.commits.loadMore` Extension Setting.
	 */
	get loadMoreCommits() {
		return this.config.get('repository.commits.loadMore', 100);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.commits.loadMoreAutomatically` Extension Setting.
	 */
	get loadMoreCommitsAutomatically() {
		return !!this.config.get('repository.commits.loadMoreAutomatically', true);
	}

	/**
	 * Get the mute commits configuration from the Extension Settings.
	 */
	get muteCommits(): MuteCommitsConfig {
		return {
			commitsNotAncestorsOfHead: !!this.config.get('repository.commits.mute.commitsThatAreNotAncestorsOfHead', false),
			mergeCommits: !!this.config.get('repository.commits.mute.mergeCommits', true)
		};
	}

	/**
	 * Get the value of the `git-graph-rs.repository.commits.order` Extension Setting.
	 */
	get commitOrder() {
		const ordering = this.config.get<string>('repository.commits.order', 'date');
		return ordering === 'author-date'
			? CommitOrdering.AuthorDate
			: ordering === 'topo'
				? CommitOrdering.Topological
				: CommitOrdering.Date;
	}

	/**
	 * Get the value of the `git-graph-rs.repository.commits.showSignatureStatus` Extension Setting.
	 */
	get showSignatureStatus() {
		return !!this.config.get('repository.commits.showSignatureStatus', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.fetchAndPrune` Extension Setting.
	 */
	get fetchAndPrune() {
		return !!this.config.get('repository.fetchAndPrune', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.fetchAndPruneTags` Extension Setting.
	 */
	get fetchAndPruneTags() {
		return !!this.config.get('repository.fetchAndPruneTags', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.trackRemoteTags` Extension Setting.
	 */
	get trackRemoteTags() {
		return !!this.config.get('repository.trackRemoteTags', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.includeCommitsMentionedByReflogs` Extension Setting.
	 */
	get includeCommitsMentionedByReflogs() {
		return !!this.config.get('repository.includeCommitsMentionedByReflogs', false);
	}

	/**
	 * Get the On Repo Load configuration from the Extension Settings.
	 */
	get onRepoLoad(): OnRepoLoadConfig {
		const branches = this.config.get('repository.onLoad.showSpecificBranches', []);
		return {
			scrollToHead: !!this.config.get('repository.onLoad.scrollToHead', false),
			showCheckedOutBranch: !!this.config.get('repository.onLoad.showCheckedOutBranch', false),
			showSpecificBranches: Array.isArray(branches)
				? branches.filter((branch) => typeof branch === 'string')
				: []
		};
	}

	/**
	 * Get the value of the `git-graph-rs.repository.onlyFollowFirstParent` Extension Setting.
	 */
	get onlyFollowFirstParent() {
		return !!this.config.get('repository.onlyFollowFirstParent', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.showCommitsOnlyReferencedByTags` Extension Setting.
	 */
	get showCommitsOnlyReferencedByTags() {
		return !!this.config.get('repository.showCommitsOnlyReferencedByTags', true);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.showRemoteBranches` Extension Setting.
	 */
	get showRemoteBranches() {
		return !!this.config.get('repository.showRemoteBranches', true);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.showRemoteHeads` Extension Setting.
	 */
	get showRemoteHeads() {
		return !!this.config.get('repository.showRemoteHeads', true);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.commits.showBodyInline` Extension Setting.
	 */
	get showCommitBodyInline() {
		return !!this.config.get('repository.commits.showBodyInline', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.showStashes` Extension Setting.
	 */
	get showStashes() {
		return !!this.config.get('repository.showStashes', true);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.showTags` Extension Setting.
	 */
	get showTags() {
		return !!this.config.get('repository.showTags', true);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.showUncommittedChanges` Extension Setting.
	 */
	get showUncommittedChanges() {
		return !!this.config.get('repository.showUncommittedChanges', true);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.showUntrackedFiles` Extension Setting.
	 */
	get showUntrackedFiles() {
		return !!this.config.get('repository.showUntrackedFiles', true);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.sign.commits` Extension Setting.
	 */
	get signCommits() {
		return !!this.config.get('repository.sign.commits', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.sign.tags` Extension Setting.
	 */
	get signTags() {
		return !!this.config.get('repository.sign.tags', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.useMailmap` Extension Setting.
	 */
	get useMailmap() {
		return !!this.config.get('repository.useMailmap', false);
	}

	/**
	 * Get the value of the `git-graph-rs.repository.extDiffToolArgs` Extension Setting.
	 */
	get extDiffToolArgs(): string[] {
		return this.config.get<string[]>('repository.extDiffToolArgs', []);
	}

	/**
	 * Get the value of the `git-graph-rs.repositoryDropdownOrder` Extension Setting.
	 */
	get repoDropdownOrder(): RepoDropdownOrder {
		const order = this.config.get<string>('repositoryDropdownOrder', 'Workspace Full Path');
		return order === 'Full Path'
			? RepoDropdownOrder.FullPath
			: order === 'Name'
				? RepoDropdownOrder.Name
				: RepoDropdownOrder.WorkspaceFullPath;
	}

	/**
	 * Get the value of the `git-graph-rs.retainContextWhenHidden` Extension Setting.
	 */
	get retainContextWhenHidden() {
		return !!this.config.get('retainContextWhenHidden', true);
	}

	/**
	 * Get the value of the `git-graph-rs.showStatusBarItem` Extension Setting.
	 */
	get showStatusBarItem() {
		return !!this.config.get('showStatusBarItem', true);
	}

	/**
	 * Get the value of the `git-graph-rs.stickyHeader` Extension Setting.
	 */
	get stickyHeader() {
		return !!this.config.get('stickyHeader', true);
	}

	/**
	 * Get the value of the `git-graph-rs.tabIconColourTheme` Extension Setting.
	 */
	get tabIconColourTheme() {
		return this.config.get<string>('tabIconColourTheme', 'colour') === 'grey'
			? TabIconColourTheme.Grey
			: TabIconColourTheme.Colour;
	}

	/**
	 * Get the Git executable paths configured by the `git.path` Visual Studio Code Setting.
	 */
	get gitPaths() {
		const configValue = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path', null);
		if (configValue === null) {
			return [];
		} else if (typeof configValue === 'string') {
			return [configValue];
		} else if (Array.isArray(configValue)) {
			return configValue.filter((value) => typeof value === 'string');
		} else {
			return [];
		}
	}

	/**
	 * Get the optional GitLab Personal Access Token configured by the
	 * `git-graph-rs.avatars.gitlabToken` Extension Setting, used to raise the rate limit of the
	 * GitLab API when fetching avatars.
	 */
	get gitlabToken() {
		return this.config.get<string>('avatars.gitlabToken', '');
	}

	/**
	 * Get the normalised keybinding located by the provided section.
	 * @param section The section locating the keybinding setting.
	 * @param defaultValue The default keybinding.
	 * @returns The normalised keybinding.
	 */
	private getKeybinding(section: string, defaultValue: string) {
		const configValue = this.config.get<string>(section);
		if (typeof configValue === 'string') {
			if (configValue === 'UNASSIGNED') {
				return null;
			} else if (Config.KEYBINDING_REGEXP.test(configValue)) {
				return configValue.substring(11).toLowerCase();
			}
		}
		return defaultValue;
	}
}

/**
 * Get a Config instance for retrieving the users configuration of Git Graph Extension Settings.
 * @param repo An optional path of a repository (to be used for Workspace Folder Scoped Configuration Values).
 * @returns A Config instance.
 */
export function getConfig(repo?: string) {
	return new Config(repo);
}

/**
 * Recursively apply the values in a user specified object to an object containing default values.
 * @param base An object containing the default values.
 * @param user An object specified by the user.
 */
function mergeConfigObjects(base: { [key: string]: any }, user: { [key: string]: any }) {
	if (typeof base !== typeof user) return;

	let keys = Object.keys(base);
	for (let i = 0; i < keys.length; i++) {
		if (typeof base[keys[i]] === 'object') {
			if (typeof user[keys[i]] === 'object') {
				mergeConfigObjects(base[keys[i]], user[keys[i]]);
			}
		} else if (typeof user[keys[i]] === typeof base[keys[i]]) {
			base[keys[i]] = user[keys[i]];
		}
	}
}

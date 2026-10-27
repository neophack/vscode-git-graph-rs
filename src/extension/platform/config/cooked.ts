import * as vscode from 'vscode';
import {
	CommitAuthor, CommitDetailsViewConfig, CommitDetailsViewLocation, CommitOrdering, ContextMenuActionsVisibility,
	CustomBranchGlobPattern, CustomEmojiShortcodeMapping, CustomPullRequestProvider, DateFormat, DateFormatType,
	DateType, DefaultColumnVisibility, DialogDefaults, FileViewType, GraphConfig, GraphStyle, GraphUncommittedChangesStyle,
	KeybindingConfig, MuteCommitsConfig, OnRepoLoadConfig, RefLabelAlignment, ReferenceLabelsConfig, RepoDropdownOrder,
	SquashMessageFormat, TabIconColourTheme, TagType
} from '../../../shared/model/webview';
import { GerritConfig } from '../../../shared/model/gerrit';
import { GitResetMode } from '../../../shared/model/git';
import { ConfigSnapshot, ContextMenuActionsVisibilitySetting, KeyboardShortcutSetting, OpenNewTabEditorGroupSetting } from './schema';

/**
 * The cooked views over a {@link ConfigSnapshot}: the derived shapes the webview payload and the
 * remaining host consumers speak (the shared-model enums and composites the raw setting strings
 * map onto). Every function here is a PURE function of the snapshot (plus the explicitly passed
 * host language) — no configuration reads happen in this module, so a cooked value is always the
 * reading of one snapshot and defaults live only in the schema table.
 *
 * These mappings were absorbed from the per-key getters of the former `getConfig()` reader; the
 * behaviour is unchanged (including the deliberate normalisations: the `gerrit.fetchLimit`
 * clamp, the graph palette fallback, the keybinding normalisation and the entry filters).
 */

/** The validated raw `interfaceLanguage` setting (`auto` included, anything else read as `auto`). */
export function interfaceLanguageSettingOf(snapshot: ConfigSnapshot): 'auto' | 'en' | 'zh-cn' {
	const value = snapshot.interfaceLanguage;
	return value === 'en' || value === 'zh-cn' ? value : 'auto';
}

/**
 * The interface language to render the Git Graph interface with: the explicitly configured
 * `git-graph-rs.interfaceLanguage` setting, or — when it is set to "auto" (the default) — the
 * language Visual Studio Code itself is displayed in (the host language is passed explicitly so
 * this stays a pure function).
 */
export function resolvedInterfaceLanguage(setting: 'auto' | 'en' | 'zh-cn', hostLanguage: string): 'en' | 'zh-cn' {
	if (setting !== 'auto') return setting;
	return hostLanguage.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

/** The `vscode.ViewColumn` an `openNewTabEditorGroup` setting value names (unknown values open in the Active group, as before). */
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

export function viewColumnOfEditorGroup(setting: OpenNewTabEditorGroupSetting): vscode.ViewColumn {
	return typeof VIEW_COLUMN_MAPPING[setting] !== 'undefined' ? VIEW_COLUMN_MAPPING[setting] : vscode.ViewColumn.Active;
}

export function repoDropdownOrderOf(snapshot: ConfigSnapshot): RepoDropdownOrder {
	const order = snapshot.repositoryDropdownOrder;
	return order === 'Full Path'
		? RepoDropdownOrder.FullPath
		: order === 'Name'
			? RepoDropdownOrder.Name
			: RepoDropdownOrder.WorkspaceFullPath;
}

export function tabIconColourThemeOf(snapshot: ConfigSnapshot): TabIconColourTheme {
	return snapshot.tabIconColourTheme === 'grey' ? TabIconColourTheme.Grey : TabIconColourTheme.Colour;
}

export function commitOrderingOf(snapshot: ConfigSnapshot): CommitOrdering {
	const ordering = snapshot.repositoryCommitsOrder;
	return ordering === 'author-date'
		? CommitOrdering.AuthorDate
		: ordering === 'topo'
			? CommitOrdering.Topological
			: CommitOrdering.Date;
}

/** The squash-commit message format of a `*.squashMessageFormat` setting. */
export function squashMessageFormatOf(setting: 'Default' | 'Git SQUASH_MSG'): SquashMessageFormat {
	return setting === 'Git SQUASH_MSG' ? SquashMessageFormat.GitSquashMsg : SquashMessageFormat.Default;
}

export function commitDetailsViewOf(snapshot: ConfigSnapshot): CommitDetailsViewConfig {
	return {
		autoCenter: snapshot.commitDetailsViewAutoCenter,
		fileTreeCompactFolders: snapshot.commitDetailsViewFileViewFileTreeCompactFolders,
		fileViewType: snapshot.commitDetailsViewFileViewType === 'File List' ? FileViewType.List : FileViewType.Tree,
		location: snapshot.commitDetailsViewLocation === 'Docked to Bottom'
			? CommitDetailsViewLocation.DockedToBottom
			: CommitDetailsViewLocation.Inline
	};
}

export function dateFormatOf(snapshot: ConfigSnapshot): DateFormat {
	const configValue = snapshot.dateFormat;
	let type = DateFormatType.DateAndTime, iso = false;
	if (configValue === 'Relative') {
		type = DateFormatType.Relative;
	} else {
		if (configValue.endsWith('Date Only')) type = DateFormatType.DateOnly;
		if (configValue.startsWith('ISO')) iso = true;
	}
	return { type: type, iso: iso };
}

export function dateTypeOf(snapshot: ConfigSnapshot): DateType {
	return snapshot.dateType === 'Commit Date' ? DateType.Commit : DateType.Author;
}

export function defaultColumnVisibilityOf(snapshot: ConfigSnapshot): DefaultColumnVisibility {
	const obj: unknown = snapshot.defaultColumnVisibility;
	if (typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)['Date'] === 'boolean'
		&& typeof (obj as Record<string, unknown>)['Author'] === 'boolean' && typeof (obj as Record<string, unknown>)['Commit'] === 'boolean') {
		const record = obj as Record<string, boolean>;
		return { author: record['Author'], commit: record['Commit'], date: record['Date'] };
	} else {
		return { author: true, commit: true, date: true };
	}
}

export function dialogDefaultsOf(snapshot: ConfigSnapshot): DialogDefaults {
	const resetCommitMode = snapshot.dialogResetCurrentBranchToCommitMode;
	const resetUncommittedMode = snapshot.dialogResetUncommittedChangesMode;
	const refInputSpaceSubstitution = snapshot.dialogGeneralReferenceInputSpaceSubstitution;

	return {
		addTag: {
			pushToRemote: snapshot.dialogAddTagPushToRemote,
			type: snapshot.dialogAddTagType === 'Lightweight' ? TagType.Lightweight : TagType.Annotated
		},
		applyStash: {
			reinstateIndex: snapshot.dialogApplyStashReinstateIndex
		},
		cherryPick: {
			noCommit: snapshot.dialogCherryPickNoCommit,
			recordOrigin: snapshot.dialogCherryPickRecordOrigin
		},
		createBranch: {
			checkout: snapshot.dialogCreateBranchCheckOut
		},
		deleteBranch: {
			forceDelete: snapshot.dialogDeleteBranchForceDelete
		},
		fetchIntoLocalBranch: {
			forceFetch: snapshot.dialogFetchIntoLocalBranchForceFetch
		},
		fetchRemote: {
			prune: snapshot.dialogFetchRemotePrune,
			pruneTags: snapshot.dialogFetchRemotePruneTags
		},
		general: {
			referenceInputSpaceSubstitution: refInputSpaceSubstitution === 'Hyphen' ? '-' : refInputSpaceSubstitution === 'Underscore' ? '_' : null
		},
		merge: {
			noCommit: snapshot.dialogMergeNoCommit,
			noFastForward: snapshot.dialogMergeNoFastForward,
			squash: snapshot.dialogMergeSquashCommits
		},
		popStash: {
			reinstateIndex: snapshot.dialogPopStashReinstateIndex
		},
		pullBranch: {
			noFastForward: snapshot.dialogPullBranchNoFastForward,
			squash: snapshot.dialogPullBranchSquashCommits
		},
		rebase: {
			ignoreDate: snapshot.dialogRebaseIgnoreDate,
			interactive: snapshot.dialogRebaseLaunchInteractiveRebase,
			autosquash: snapshot.dialogRebaseAutosquash
		},
		resetCommit: {
			mode: resetCommitMode === 'Soft' ? GitResetMode.Soft : (resetCommitMode === 'Hard' ? GitResetMode.Hard : GitResetMode.Mixed)
		},
		resetUncommitted: {
			mode: resetUncommittedMode === 'Hard' ? GitResetMode.Hard : GitResetMode.Mixed
		},
		stashUncommittedChanges: {
			includeUntracked: snapshot.dialogStashUncommittedChangesIncludeUntracked
		}
	};
}

export function muteCommitsOf(snapshot: ConfigSnapshot): MuteCommitsConfig {
	return {
		commitsNotAncestorsOfHead: snapshot.repositoryCommitsMuteCommitsThatAreNotAncestorsOfHead,
		mergeCommits: snapshot.repositoryCommitsMuteMergeCommits
	};
}

export function onRepoLoadOf(snapshot: ConfigSnapshot): OnRepoLoadConfig {
	const branches: unknown[] = Array.isArray(snapshot.repositoryOnLoadShowSpecificBranches) ? [...snapshot.repositoryOnLoadShowSpecificBranches] : [];
	return {
		scrollToHead: snapshot.repositoryOnLoadScrollToHead,
		showCheckedOutBranch: snapshot.repositoryOnLoadShowCheckedOutBranch,
		showSpecificBranches: branches.filter((branch): branch is string => typeof branch === 'string')
	};
}

export function referenceLabelsOf(snapshot: ConfigSnapshot): ReferenceLabelsConfig {
	const alignmentConfigValue = snapshot.referenceLabelsAlignment;
	const alignment = alignmentConfigValue === 'Branches (on the left) & Tags (on the right)'
		? RefLabelAlignment.BranchesOnLeftAndTagsOnRight
		: alignmentConfigValue === 'Branches (aligned to the graph) & Tags (on the right)'
			? RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight
			: RefLabelAlignment.Normal;
	return {
		branchLabelsAlignedToGraph: alignment === RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight,
		combineLocalAndRemoteBranchLabels: snapshot.referenceLabelsCombineLocalAndRemoteBranchLabels,
		tagLabelsOnRight: alignment !== RefLabelAlignment.Normal
	};
}

export function graphOf(snapshot: ConfigSnapshot): GraphConfig {
	const colours: unknown[] = Array.isArray(snapshot.graphColours) ? [...snapshot.graphColours] : [];
	const validColours = colours.filter((v): v is string => typeof v === 'string' && v.match(/^\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb[a]?\s*\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\))\s*$/) !== null);
	return {
		// An array whose every entry is invalid must fall back to the defaults too: an empty
		// palette would leave the webview computing `colours[n % 0]` — every graph line
		// rendered undefined-coloured.
		colours: validColours.length > 0
			? validColours
			: ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'],
		style: snapshot.graphStyle === 'angular' ? GraphStyle.Angular : GraphStyle.Rounded,
		fontSize: snapshot.graphFontSize,
		rowHeight: snapshot.graphRowHeight,
		grid: { x: 16, y: snapshot.graphRowHeight, offsetX: 16, offsetY: snapshot.graphRowHeight / 2, expandY: 250 },
		uncommittedChanges: snapshot.graphUncommittedChanges === 'Open Circle at the Checked Out Commit'
			? GraphUncommittedChangesStyle.OpenCircleAtTheCheckedOutCommit
			: GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges
	};
}

export function gerritOf(snapshot: ConfigSnapshot): GerritConfig {
	return {
		remote: snapshot.gerritRemote,
		// The clamp the former reader applied: a garbage or out-of-range setting value answers
		// the manifest default instead of reaching the Gerrit fetch unfettered.
		fetchLimit: clampGerritFetchLimit(snapshot.gerritFetchLimit),
		showReviewProgress: snapshot.gerritShowReviewProgress
	};
}

/** The `gerrit.fetchLimit` bounds the reader has always enforced (1..10000, integral). */
function clampGerritFetchLimit(value: number): number {
	return Number.isFinite(value) && value >= 1 && value <= 10000 ? Math.floor(value) : 20;
}

export function keybindingsOf(snapshot: ConfigSnapshot): KeybindingConfig {
	return {
		find: keybindingOf(snapshot.keyboardShortcutFind, 'f'),
		refresh: keybindingOf(snapshot.keyboardShortcutRefresh, 'r'),
		scrollToHead: keybindingOf(snapshot.keyboardShortcutScrollToHead, 'h'),
		scrollToStash: keybindingOf(snapshot.keyboardShortcutScrollToStash, 's')
	};
}

/**
 * The normalised keybinding of one `keyboardShortcut.*` setting: `UNASSIGNED` answers NULL (the
 * shortcut is off), a `CTRL/CMD + <letter>` value answers the lower-case letter, and anything
 * else (an unset default that failed to read, or junk) answers the given default letter.
 */
function keybindingOf(setting: KeyboardShortcutSetting, defaultKey: string): string | null {
	if (setting === 'UNASSIGNED') return null;
	return /^CTRL\/CMD \+ [A-Z]$/.test(setting) ? setting.substring(11).toLowerCase() : defaultKey;
}

export function customBranchGlobPatternsOf(snapshot: ConfigSnapshot): CustomBranchGlobPattern[] {
	const inPatterns: unknown[] = Array.isArray(snapshot.customBranchGlobPatterns) ? [...snapshot.customBranchGlobPatterns] : [];
	const outPatterns: CustomBranchGlobPattern[] = [];
	for (const entry of inPatterns) {
		if (typeof entry === 'object' && entry !== null
			&& typeof (entry as Record<string, unknown>)['name'] === 'string' && typeof (entry as Record<string, unknown>)['glob'] === 'string') {
			const record = entry as { name: string; glob: string };
			outPatterns.push({ name: record.name, glob: '--glob=' + record.glob });
		}
	}
	return outPatterns;
}

export function customEmojiShortcodeMappingsOf(snapshot: ConfigSnapshot): CustomEmojiShortcodeMapping[] {
	const inMappings: unknown[] = Array.isArray(snapshot.customEmojiShortcodeMappings) ? [...snapshot.customEmojiShortcodeMappings] : [];
	const outMappings: CustomEmojiShortcodeMapping[] = [];
	for (const entry of inMappings) {
		if (typeof entry === 'object' && entry !== null
			&& typeof (entry as Record<string, unknown>)['shortcode'] === 'string' && typeof (entry as Record<string, unknown>)['emoji'] === 'string') {
			const record = entry as { shortcode: string; emoji: string };
			outMappings.push({ shortcode: record.shortcode, emoji: record.emoji });
		}
	}
	return outMappings;
}

export function customPullRequestProvidersOf(snapshot: ConfigSnapshot): CustomPullRequestProvider[] {
	const providers: unknown[] = Array.isArray(snapshot.customPullRequestProviders) ? [...snapshot.customPullRequestProviders] : [];
	return providers
		.filter((provider): provider is { name: string; templateUrl: string } =>
			typeof provider === 'object' && provider !== null
			&& typeof (provider as Record<string, unknown>)['name'] === 'string'
			&& typeof (provider as Record<string, unknown>)['templateUrl'] === 'string')
		.map((provider) => ({ name: provider.name, templateUrl: provider.templateUrl }));
}

export function commitAuthorsOf(snapshot: ConfigSnapshot): CommitAuthor[] {
	const authors: unknown[] = Array.isArray(snapshot.commitAuthors) ? [...snapshot.commitAuthors] : [];
	return authors
		.filter((author): author is { name: string; email: string } =>
			typeof author === 'object' && author !== null
			&& typeof (author as Record<string, unknown>)['name'] === 'string' && ((author as Record<string, unknown>)['name'] as string).trim() !== ''
			&& typeof (author as Record<string, unknown>)['email'] === 'string' && ((author as Record<string, unknown>)['email'] as string).trim() !== '')
		.map((author) => ({ name: author.name, email: author.email }));
}

export function contextMenuActionsVisibilityOf(snapshot: ConfigSnapshot): ContextMenuActionsVisibility {
	const userConfig: { [key: string]: unknown } = typeof snapshot.contextMenuActionsVisibility === 'object' && snapshot.contextMenuActionsVisibility !== null
		? { ...(snapshot.contextMenuActionsVisibility as ContextMenuActionsVisibilitySetting) }
		: {};
	const config: { [key: string]: { [key: string]: boolean } } = {
		branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
		commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, undo: true, editMessage: true, fixup: true, squash: true, copyHash: true, copySubject: true },
		commitDetailsViewFile: { viewDiff: true, viewFileAtThisRevision: true, viewDiffWithWorkingFile: true, openFile: true, markAsReviewed: true, markAsNotReviewed: true, resetFileToThisRevision: true, copyAbsoluteFilePath: true, copyRelativeFilePath: true },
		remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, createBranch: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true },
		stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true },
		tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
		uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true }
	};
	mergeConfigObjects(config, userConfig);
	return config as unknown as ContextMenuActionsVisibility;
}

/**
 * Recursively apply the values in a user specified object to an object containing default values.
 * @param base An object containing the default values.
 * @param user An object specified by the user.
 */
function mergeConfigObjects(base: { [key: string]: unknown }, user: { [key: string]: unknown }) {
	if (typeof base !== typeof user) return;

	const keys = Object.keys(base);
	for (const key of keys) {
		if (typeof base[key] === 'object') {
			if (typeof user[key] === 'object') {
				mergeConfigObjects(base[key] as { [key: string]: unknown }, user[key] as { [key: string]: unknown });
			}
		} else if (typeof user[key] === typeof base[key]) {
			base[key] = user[key];
		}
	}
}

/**
 * The cooked configuration the webview payload and the panel speak: every derived view of one
 * snapshot, built once. (The raw settings ride along as the snapshot's own fields; consumers
 * that need a single cooked value use the specific `*Of` function instead.)
 * @param snapshot The configuration snapshot to derive from.
 * @param hostLanguage The language Visual Studio Code itself is displayed in (the "auto"
 * interface language resolves against it).
 */
export function cookConfig(snapshot: ConfigSnapshot, hostLanguage: string): CookedConfig {
	return {
		commitDetailsView: commitDetailsViewOf(snapshot),
		contextMenuActionsVisibility: contextMenuActionsVisibilityOf(snapshot),
		customBranchGlobPatterns: customBranchGlobPatternsOf(snapshot),
		customEmojiShortcodeMappings: customEmojiShortcodeMappingsOf(snapshot),
		customPullRequestProviders: customPullRequestProvidersOf(snapshot),
		commitAuthors: commitAuthorsOf(snapshot),
		dateFormat: dateFormatOf(snapshot),
		dateType: dateTypeOf(snapshot),
		defaultColumnVisibility: defaultColumnVisibilityOf(snapshot),
		dialogDefaults: dialogDefaultsOf(snapshot),
		gerrit: gerritOf(snapshot),
		graph: graphOf(snapshot),
		interfaceLanguage: resolvedInterfaceLanguage(interfaceLanguageSettingOf(snapshot), hostLanguage),
		interfaceLanguageSetting: interfaceLanguageSettingOf(snapshot),
		keybindings: keybindingsOf(snapshot),
		muteCommits: muteCommitsOf(snapshot),
		onRepoLoad: onRepoLoadOf(snapshot),
		referenceLabels: referenceLabelsOf(snapshot),
		repoDropdownOrder: repoDropdownOrderOf(snapshot),
		commitOrder: commitOrderingOf(snapshot)
	};
}

/** The derived configuration views of one snapshot (see {@link cookConfig}). */
export interface CookedConfig {
	readonly commitDetailsView: CommitDetailsViewConfig;
	readonly contextMenuActionsVisibility: ContextMenuActionsVisibility;
	readonly customBranchGlobPatterns: CustomBranchGlobPattern[];
	readonly customEmojiShortcodeMappings: CustomEmojiShortcodeMapping[];
	readonly customPullRequestProviders: CustomPullRequestProvider[];
	readonly commitAuthors: CommitAuthor[];
	readonly dateFormat: DateFormat;
	readonly dateType: DateType;
	readonly defaultColumnVisibility: DefaultColumnVisibility;
	readonly dialogDefaults: DialogDefaults;
	readonly gerrit: GerritConfig;
	readonly graph: GraphConfig;
	readonly interfaceLanguage: 'en' | 'zh-cn';
	readonly interfaceLanguageSetting: 'auto' | 'en' | 'zh-cn';
	readonly keybindings: KeybindingConfig;
	readonly muteCommits: MuteCommitsConfig;
	readonly onRepoLoad: OnRepoLoadConfig;
	readonly referenceLabels: ReferenceLabelsConfig;
	readonly repoDropdownOrder: RepoDropdownOrder;
	readonly commitOrder: CommitOrdering;
}

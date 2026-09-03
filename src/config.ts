import * as vscode from 'vscode';
import {
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
} from './types';

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
			commit: { addTag: true, createBranch: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, undo: true, editMessage: true, amend: true, copyHash: true, copySubject: true },
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
		for (let i = 0; i < inPatterns.length; i++) {
			if (typeof inPatterns[i].name === 'string' && typeof inPatterns[i].glob === 'string') {
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
		for (let i = 0; i < inMappings.length; i++) {
			if (typeof inMappings[i].shortcode === 'string' && typeof inMappings[i].emoji === 'string') {
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
	 * Get the value of the `git-graph-rs.customPullRequestProviders` Extension Setting.
	 */
	get customPullRequestProviders(): CustomPullRequestProvider[] {
		let providers = this.config.get('customPullRequestProviders', <any[]>[]);
		return Array.isArray(providers)
			? providers
				.filter((provider) => typeof provider.name === 'string' && typeof provider.templateUrl === 'string')
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
				interactive: !!this.config.get('dialog.rebase.launchInteractiveRebase', false)
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
		return {
			colours: Array.isArray(colours) && colours.length > 0
				? colours.filter((v) => v.match(/^\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb[a]?\s*\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\))\s*$/) !== null)
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

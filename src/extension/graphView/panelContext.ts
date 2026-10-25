import * as vscode from 'vscode';
import type { AvatarManager } from '../../avatarManager';
import { GitConfigKey, type DataSource } from '../../dataSource';
import type { ExtensionState } from '../../extensionState';
import { getConfig } from '../../config';
import { t } from '../../i18n';
import type { Logger } from '../../logger';
import type { RepoManager } from '../repos/repoManager';
import { BinaryCompareView } from '../views/binaryCompare/viewController';
import { CommitComparisonView } from '../views/comparison/viewController';
import type { ErrorInfo, PullRequestConfig, PullRequestInfo } from '../../types';
import {
	archive, copyFilePathToClipboard, copyToClipboard, createPullRequest, openExtensionSettings,
	openExternalUrl, openFile, resolveDiffFromHash, showErrorMessage, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision, viewScm
} from '../../utils/actions';
import { CommitLoader } from './commitLoader';
import { saveGlobalSetting } from './globalSettings';
import type {
	AvatarPort, GlobalSettingsPort, PullRequestsPort, ReposPort, StoragePort, UiPort, UserConfigPort, ViewPort
} from './handlers/context';
import type { PullRequestRemote, RefreshIdKind } from './handlers/context';
import { fetchPullRequestHeadRefs, fetchPullRequests } from './pullRequestFetch';
import type { PullRequestFetchDeps } from './pullRequestFetch';
import { UncommittedCountStabiliser } from './uncommittedStabiliser';

/**
 * The production implementations of the HandlerContext's ports (REFACTOR-PLAN task 4.4): thin
 * adapters over the collaborators the Panel already owns - the DataSource, the ExtensionState,
 * the AvatarManager, the RepoManager, the utils/actions helpers and the auxiliary view
 * controllers - so the handler table runs against the real thing while staying substitutable
 * in tests. Each port moves to its future module (platform/storage, extension/repos,
 * integrations/*, platform/config) as those land.
 */

/** The Panel collaborators the ports adapt. */
export interface PanelPortDeps {
	readonly dataSource: DataSource;
	readonly extensionState: ExtensionState;
	readonly avatarManager: AvatarManager;
	readonly repoManager: RepoManager;
	readonly logger: Logger;
	readonly extensionPath: string;
	/** The shared pull-request data source (HTTP + parsing; owned by the Panel). */
	readonly pullRequests: { getPullRequests(url: string): Promise<{ prs: PullRequestInfo[], complete: boolean } | null> };
	/** The repository the view currently shows (the working directory of the Git invocations). */
	currentRepo(): string | null;
}

/** The port implementations the Panel assembles its HandlerContext from. */
export interface PanelPorts {
	readonly ui: UiPort;
	readonly avatars: AvatarPort;
	readonly storage: StoragePort;
	readonly repos: ReposPort;
	readonly userConfig: UserConfigPort;
	readonly settings: GlobalSettingsPort;
	readonly pullRequests: PullRequestsPort;
}

/**
 * Build the production ports over the Panel's collaborators. Pure wiring: every member is a
 * closure over {@link deps}; nothing is constructed beyond the pull-request fetch bundle.
 */
export function createPanelPorts(deps: PanelPortDeps): PanelPorts {
	const prDeps: PullRequestFetchDeps = {
		gitOutput: (args, repo, resolveValue) => deps.dataSource.gitOutput(args, repo, resolveValue),
		loadPullRequests: (url) => deps.pullRequests.getPullRequests(url),
		isEnabled: () => getConfig().pullRequests.enabled,
		logger: deps.logger
	};

	return {
		ui: {
			showErrorMessage: (message) => showErrorMessage(message),
			viewScm: () => viewScm(),
			openExternalUrl: (url) => openExternalUrl(url),
			openExtensionSettings: () => openExtensionSettings(),
			openLogFile: () => openLogFile(deps.logger),
			copyToClipboard: (text) => copyToClipboard(text),
			copyFilePathToClipboard: (repo, filePath, absolute) => copyFilePathToClipboard(repo, filePath, absolute),
			viewDiff: (repo, fromHash, toHash, oldFilePath, newFilePath, type) => viewDiff(repo, fromHash, toHash, oldFilePath, newFilePath, type),
			viewDiffWithWorkingFile: (repo, hash, filePath) => viewDiffWithWorkingFile(repo, hash, filePath, deps.dataSource),
			viewFileAtRevision: (repo, hash, filePath) => viewFileAtRevision(repo, hash, filePath),
			openFile: (repo, filePath, hash) => openFile(repo, filePath, hash, deps.dataSource),
			createArchive: (repo, ref) => archive(repo, ref, deps.dataSource),
			createPullRequest: (config: PullRequestConfig, sourceOwner, sourceRepo, sourceBranch) => createPullRequest(config, sourceOwner, sourceRepo, sourceBranch),
			setInterfaceLanguage: (language) => setInterfaceLanguage(deps.logger, language),
			openCompareTab: (repo, fromHash, toHash, singleCommit) => {
				CommitComparisonView.open(deps.extensionPath, deps.dataSource, repo, fromHash, toHash, singleCommit);
			},
			viewDiffBinary: (repo, fromHash, toHash, oldFilePath, newFilePath, type) => {
				// The native Diff View can't show a binary/image file (both panes would be empty):
				// the same standalone tab the Commit Comparison View opens for one does
				BinaryCompareView.open(deps.extensionPath, deps.dataSource, repo, resolveDiffFromHash(fromHash, toHash), toHash, {
					oldFilePath: oldFilePath, newFilePath: newFilePath, type: type, additions: null, deletions: null
				});
			}
		},
		avatars: {
			fetchAvatarImage: (email, repo, remote, commits) => deps.avatarManager.fetchAvatarImage(email, repo, remote, commits),
			getAvatarImage: (email) => deps.avatarManager.getAvatarImage(email)
		},
		storage: {
			getCodeReview: (repo, id) => deps.extensionState.getCodeReview(repo, id),
			startCodeReview: (repo, id, files, lastViewedFile) => deps.extensionState.startCodeReview(repo, id, files, lastViewedFile),
			updateCodeReview: (repo, id, remainingFiles, lastViewedFile) => deps.extensionState.updateCodeReview(repo, id, remainingFiles, lastViewedFile),
			endCodeReview: (repo, id) => deps.extensionState.endCodeReview(repo, id),
			setGlobalViewState: (state) => deps.extensionState.setGlobalViewState(state),
			setWorkspaceViewState: (state) => deps.extensionState.setWorkspaceViewState(state),
			setViewSnapshot: (snapshot) => deps.extensionState.setViewSnapshot(snapshot),
			getLastActiveRepo: () => deps.extensionState.getLastActiveRepo()
		},
		repos: {
			getRepos: () => deps.repoManager.getRepos(),
			checkReposExist: () => deps.repoManager.checkReposExist(),
			setRepoState: (repo, state) => deps.repoManager.setRepoState(repo, state),
			exportRepoConfig: (repo) => deps.repoManager.exportRepoConfig(repo),
			rescanForRepos: async () => {
				if (!(await deps.repoManager.searchWorkspaceForRepos())) {
					showErrorMessage(t('noReposInWorkspace'));
				}
			}
		},
		userConfig: {
			setUserName: (repo, name, location) => deps.dataSource.setConfigValue(repo, GitConfigKey.UserName, name, location),
			setUserEmail: (repo, email, location) => deps.dataSource.setConfigValue(repo, GitConfigKey.UserEmail, email, location),
			unsetUserName: (repo, location) => deps.dataSource.unsetConfigValue(repo, GitConfigKey.UserName, location),
			unsetUserEmail: (repo, location) => deps.dataSource.unsetConfigValue(repo, GitConfigKey.UserEmail, location),
			invalidateConfig: (repo) => deps.dataSource.invalidateConfigCache(repo)
		},
		settings: {
			setGlobalSetting: (setting, value, previousValue) => saveGlobalSetting({
				dataSource: deps.dataSource,
				state: deps.extensionState,
				currentRepo: deps.currentRepo,
				logger: deps.logger
			}, setting, value, previousValue)
		},
		pullRequests: {
			fetchPullRequests: (repo) => fetchPullRequests(prDeps, repo),
			fetchPullRequestHeadRefs: (repo: string, remote: PullRequestRemote) => fetchPullRequestHeadRefs(prDeps, repo, remote)
		}
	};
}

/**
 * The staged commit loader over the DataSource (task 4.4's production pairing): the
 * commit-page cache, the Gerrit pipeline and the uncommitted-changes stabiliser, reading the
 * configuration at load time exactly as the live inline pipeline did. The uncommitted row's
 * message arrives injected (`t` would be fine here too, but the loader's own doc keeps its
 * deps vscode-free), as do the clock and the sleep the confirm loop re-checks under.
 */
export function createCommitLoader(dataSource: DataSource, logger: Logger): CommitLoader {
	return new CommitLoader({
		reads: {
			getCommits: (repo, query) => dataSource.getCommits(repo, query.branches, query.authors, query.maxCommits, query.showTags, query.showRemoteBranches, query.includeCommitsMentionedByReflogs, query.onlyFollowFirstParent, query.commitOrdering, query.remotes, query.hideRemotes, query.stashes, query.gerritRefs, false, query.filterPath, query.deferUncommittedChanges, query.deferRemoteRefs),
			getUncommittedChanges: (repo) => dataSource.getUncommittedChanges(repo)
		},
		gerrit: {
			listRemoteChanges: (repo, remote) => dataSource.gerrit.listRemoteChanges(repo, remote),
			fetchChanges: (repo, remote, refspecs) => dataSource.gerrit.fetchChanges(repo, remote, refspecs.slice()),
			listLocalChangeRefs: (repo, remote) => dataSource.gerrit.listLocalChangeRefs(repo, remote),
			pruneLocalChanges: (repo, remote, keepChanges) => dataSource.gerrit.pruneLocalChanges(repo, remote, keepChanges),
			parseMetas: (repo, remote, changes, urlBase) => dataSource.gerrit.parseMetas(repo, remote, changes, urlBase),
			getChangeUrlBase: (repo, remote) => dataSource.gerrit.getChangeUrlBase(repo, remote)
		},
		getConfig: () => {
			const config = getConfig();
			return {
				showUncommittedChanges: config.showUncommittedChanges,
				gerrit: { remote: config.gerrit.remote, fetchLimit: config.gerrit.fetchLimit }
			};
		},
		logger: logger,
		formatUncommittedRow: (count) => t('uncommittedChangesRow', count),
		stabiliser: new UncommittedCountStabiliser(PANEL_UNCOMMITTED_ZERO_CONFIRM_MS, PANEL_UNCOMMITTED_RECHECK_MS),
		now: () => Date.now(),
		sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
	});
}

/** The "Uncommitted Changes" zero-confirmation window and re-check interval (see UncommittedCountStabiliser). */
export const PANEL_UNCOMMITTED_ZERO_CONFIRM_MS = 5000;
export const PANEL_UNCOMMITTED_RECHECK_MS = 1000;

/** The refresh ids the regenerated page embeds, owned by the Panel and recorded through the ViewPort. */
export interface PanelRefreshIds {
	loadRepoInfo: number;
	loadCommits: number;
	loadConfig: number;
}

/** The collaborators the view port coordinates (the Panel's own per-repository state machine). */
export interface ViewPortDeps {
	readonly loader: CommitLoader;
	readonly extensionState: ExtensionState;
	/** The repo file watcher to restart on a repository switch. */
	readonly watcher: { start(repo: string): void };
	/** The background poll whose baseline a repository switch resets. */
	readonly poller: { resetBaseline(): void };
	/** The refresh ids the loadRepoInfo/loadCommits/loadConfig handlers record into. */
	readonly refreshIds: PanelRefreshIds;
	/** Reads and updates the repository the view currently shows. */
	currentRepo(): string | null;
	setCurrentRepo(repo: string): void;
}

/**
 * The Panel's ViewPort: the loadRepoInfo handler's view-state hooks. The refresh ids ride the
 * regenerated page's initialState (the webview drops responses older than them); a repository
 * switch records the last-active repository, restarts the watcher and the poll baseline, and
 * resets the loader's per-repo view state (the remote-refs deferral and the uncommitted
 * stabiliser) - exactly the block the live loadRepoInfo case ran inline.
 */
export function createViewPort(deps: ViewPortDeps): ViewPort {
	return {
		get viewHasCommits() { return deps.loader.viewHasCommits; },
		noteRefreshId: (kind: RefreshIdKind, id: number) => {
			if (kind === 'loadRepoInfo') deps.refreshIds.loadRepoInfo = id;
			else if (kind === 'loadCommits') deps.refreshIds.loadCommits = id;
			else deps.refreshIds.loadConfig = id;
		},
		repoSwitched: (repo: string) => {
			if (repo === deps.currentRepo()) return;
			deps.setCurrentRepo(repo);
			deps.extensionState.setLastActiveRepo(repo);
			deps.watcher.start(repo);
			// The signature of the previous repository says nothing about this one
			deps.poller.resetBaseline();
			// Neither does its uncommitted count, nor its rendered-commits state
			deps.loader.viewRepoChanged();
		}
	};
}

/**
 * Save the `git-graph-rs.interfaceLanguage` setting to the Global User Settings. The
 * onDidChangeConfiguration listener reloads the Git Graph View, which re-renders the webview
 * with the new language (the settings page is restored from the persisted webview state).
 * @param language The interface language.
 * @returns The ErrorInfo of the failure (NULL => saved successfully).
 */
async function setInterfaceLanguage(logger: Logger, language: 'auto' | 'en' | 'zh-cn'): Promise<ErrorInfo> {
	if (language !== 'auto' && language !== 'en' && language !== 'zh-cn') return t('interfaceLanguageInvalid');
	try {
		await vscode.workspace.getConfiguration('git-graph-rs').update('interfaceLanguage', language, vscode.ConfigurationTarget.Global);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.log('Saving the interface language failed: ' + message);
		return message;
	}
	return null;
}

/**
 * Open this session's log file in an editor tab. The file starts empty on every activation, so
 * what it shows is always the log of the current editor session.
 * @returns The ErrorInfo of the failure (NULL => opened).
 */
async function openLogFile(logger: Logger): Promise<ErrorInfo> {
	const logFile = logger.getLogFile();
	if (logFile === null) {
		return t('noLogRecorded');
	}
	try {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logFile));
		await vscode.window.showTextDocument(document, { preview: false });
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

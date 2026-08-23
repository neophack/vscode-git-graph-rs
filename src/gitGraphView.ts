import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Cache-busting version appended to the webview media URIs.
 * Must be bumped whenever web/ sources change, so that already-open webviews
 * don't keep serving a stale cached out.min.js / out.min.css after an update.
 */
const MEDIA_CACHE_VERSION = '1.39.6';

import { AvatarManager } from './avatarManager';
import { describeCapabilities } from './backend';
import { getConfig } from './config';
import { CommitComparisonView } from './comparisonView';
import { DataSource, GitCommitData, GitCommitDetailsData, GitConfigKey } from './dataSource';
import { ExtensionState } from './extensionState';
import { Logger } from './logger';
import { PullRequestDataSource } from './pullRequests';
import { RepoFileWatcher } from './repoFileWatcher';
import { RepoManager } from './repoManager';
import { ErrorInfo, GitConfigLocation, GitGraphViewInitialState, GitPushBranchMode, GitRepoSet, LoadGitGraphViewTo, RequestLoadCommits, RequestMessage, ResponseMessage, TabIconColourTheme } from './types';
import { UNABLE_TO_FIND_GIT_MSG, UNCOMMITTED, archive, copyFilePathToClipboard, copyToClipboard, createPullRequest, encodeJsonForInlineScript, getNonce, openExtensionSettings, openExternalUrl, openFile, showErrorMessage, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision, viewScm } from './utils';
import { Disposable, toDisposable } from './utils/disposable';

/**
 * The Global (User) Settings that the Settings Widget is allowed to write, and the validator of
 * each value. Requests naming a setting that isn't a key of this record are rejected, so a
 * compromised webview can't write arbitrary VS Code settings.
 */
const WRITABLE_GLOBAL_SETTINGS: { readonly [setting: string]: (value: any) => boolean } = {
	/* Graph & Display */
	'graph.style': isOneOf('rounded', 'angular'),
	'graph.rowHeight': isIntegerInRange(16, 48),
	'graph.fontSize': isIntegerInRange(8, 24),
	'date.type': isOneOf('Author Date', 'Commit Date'),
	'date.format': isOneOf('Date & Time', 'Date Only', 'ISO Date & Time', 'ISO Date Only', 'Relative'),
	'referenceLabels.combineLocalAndRemoteBranchLabels': isBoolean,
	'stickyHeader': isBoolean,
	'markdown': isBoolean,

	/* Commit Loading */
	'repository.commits.initialLoad': isIntegerInRange(1, 100000),
	'repository.commits.loadMore': isIntegerInRange(1, 100000),
	'repository.commits.loadMoreAutomatically': isBoolean,
	'repository.commits.order': isOneOf('date', 'author-date', 'topo'),
	'repository.commits.fetchAvatars': isBoolean,
	'repository.showUncommittedChanges': isBoolean,
	'repository.showUntrackedFiles': isBoolean,

	/* Remotes & Fetching */
	'repository.fetchAndPrune': isBoolean,
	'repository.fetchAndPruneTags': isBoolean,
	'repository.trackRemoteTags': isBoolean,
	'repository.showRemoteBranches': isBoolean,
	'repository.showRemoteHeads': isBoolean,

	/* Review Integration */
	'pullRequests.enabled': isBoolean,

	/* Logging */
	'enableLog': isBoolean
};

function isBoolean(value: any) {
	return typeof value === 'boolean';
}

function isOneOf(...allowed: string[]) {
	return (value: any) => typeof value === 'string' && allowed.includes(value);
}

function isIntegerInRange(min: number, max: number) {
	return (value: any) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Manages the Git Graph View.
 */
export class GitGraphView extends Disposable {
	public static currentPanel: GitGraphView | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionPath: string;
	private readonly avatarManager: AvatarManager;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly repoFileWatcher: RepoFileWatcher;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private isGraphViewLoaded: boolean = false;
	private isPanelVisible: boolean = true;
	private currentRepo: string | null = null;
	private loadViewTo: LoadGitGraphViewTo = null; // Is used by the next call to getHtmlForWebview, and is then reset to null

	private loadRepoInfoRefreshId: number = 0;
	private loadCommitsRefreshId: number = 0;

	private readonly pullRequests: PullRequestDataSource = new PullRequestDataSource();

	/**
	 * Cache of recently loaded commit data, keyed by the full request signature. getCommits
	 * dominates the load time on large repositories (multiple Git spawns), and many consecutive
	 * requests are identical (filter toggles back and forth): those are
	 * served from the cache instead of re-running Git. In-flight promises are cached too, so
	 * concurrent identical requests share a single Git run. Invalidated whenever the
	 * RepoFileWatcher observes a change in the repository, bypassed by forced refreshes.
	 */
	private readonly commitCache: Map<string, Promise<GitCommitData>> = new Map();
	private static readonly COMMIT_CACHE_LIMIT = 32;

	/**
	 * If a Git Graph View already exists, show and update it. Otherwise, create a Git Graph View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Graph DataSource instance.
	 * @param extensionState The Git Graph ExtensionState instance.
	 * @param avatarManager The Git Graph AvatarManager instance.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param logger The Git Graph Logger instance.
	 * @param loadViewTo What to load the view to.
	 */
	public static createOrShow(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (GitGraphView.currentPanel) {
			// If Git Graph panel already exists
			if (GitGraphView.currentPanel.isPanelVisible) {
				// If the Git Graph panel is visible
				if (loadViewTo !== null) {
					GitGraphView.currentPanel.respondLoadRepos(repoManager.getRepos(), loadViewTo);
				}
			} else {
				// If the Git Graph panel is not visible
				GitGraphView.currentPanel.loadViewTo = loadViewTo;
			}
			GitGraphView.currentPanel.panel.reveal(column);
		} else {
			// If Git Graph panel doesn't already exist
			GitGraphView.currentPanel = new GitGraphView(extensionPath, dataSource, extensionState, avatarManager, repoManager, logger, loadViewTo, column);
		}
	}

	/**
	 * Creates a Git Graph View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Graph DataSource instance.
	 * @param extensionState The Git Graph ExtensionState instance.
	 * @param avatarManager The Git Graph AvatarManager instance.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param logger The Git Graph Logger instance.
	 * @param loadViewTo What to load the view to.
	 * @param column The column the view should be loaded in.
	 */
	private constructor(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo, column: vscode.ViewColumn | undefined) {
		super();
		this.extensionPath = extensionPath;
		this.avatarManager = avatarManager;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.repoManager = repoManager;
		this.logger = logger;
		this.loadViewTo = loadViewTo;

		const config = getConfig();
		this.panel = vscode.window.createWebviewPanel('git-graph-rs', 'Git Graph RS', column || vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))],
			retainContextWhenHidden: config.retainContextWhenHidden
		});
		this.panel.iconPath = config.tabIconColourTheme === TabIconColourTheme.Colour
			? this.getResourcesUri('git-graph-rs-webview-icon.svg')
			: {
				light: this.getResourcesUri('git-graph-rs-webview-icon-light.svg'),
				dark: this.getResourcesUri('git-graph-rs-webview-icon-dark.svg')
			};


		this.registerDisposables(
			// Dispose Git Graph View resources when disposed
			toDisposable(() => {
				GitGraphView.currentPanel = undefined;
				this.repoFileWatcher.stop();
			}),

			// Dispose this Git Graph View when the Webview Panel is disposed
			this.panel.onDidDispose(() => this.dispose()),

			// Register a callback that is called when the view is shown or hidden
			this.panel.onDidChangeViewState(() => {
				if (this.panel.visible !== this.isPanelVisible) {
					if (this.panel.visible) {
						this.update();
					} else {
						this.currentRepo = null;
						this.repoFileWatcher.stop();
					}
					this.isPanelVisible = this.panel.visible;
				}
			}),

			// Subscribe to events triggered when a repository is added or deleted from Git Graph
			repoManager.onDidChangeRepos((event) => {
				if (!this.panel.visible) return;
				const loadViewTo = event.loadRepo !== null ? { repo: event.loadRepo } : null;
				if ((event.numRepos === 0 && this.isGraphViewLoaded) || (event.numRepos > 0 && !this.isGraphViewLoaded)) {
					this.loadViewTo = loadViewTo;
					this.update();
				} else {
					this.respondLoadRepos(event.repos, loadViewTo);
				}
			}),

			// Subscribe to events triggered when an avatar is available
			avatarManager.onAvatar((event) => {
				this.sendMessage({
					command: 'fetchAvatar',
					email: event.email,
					image: event.image
				});
			}),

			// Respond to messages sent from the Webview
			this.panel.webview.onDidReceiveMessage((msg) => this.respondToMessage(msg)),

			// Dispose the Webview Panel when disposed
			this.panel,

			// Update the Git Graph View when the configuration changes
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('git-graph-rs')) {
					const config = getConfig();
					// Cached commit data also depends on settings that aren't part of the cache key
					// (e.g. showCommitsOnlyReferencedByTags, showRemoteHeads): the webview re-requests
					// with an identical key, so drop the cache to avoid serving stale commits
					this.commitCache.clear();
					this.panel.iconPath = config.tabIconColourTheme === TabIconColourTheme.Colour
						? this.getResourcesUri('git-graph-rs-webview-icon.svg')
						: {
							light: this.getResourcesUri('git-graph-rs-webview-icon-light.svg'),
							dark: this.getResourcesUri('git-graph-rs-webview-icon-dark.svg')
						};
					this.update();
				}
			})
		);

		// Instantiate a RepoFileWatcher that watches for file changes in the repository currently open in the Git Graph View
		this.repoFileWatcher = new RepoFileWatcher(logger, () => {
			if (this.panel.visible) {
				// The repository changed on disk: any cached commit data is now stale
				this.commitCache.clear();
				this.sendMessage({ command: 'refresh' });
			}
		}, () => {
			// The repository's Git config changed: drop the cached config data so the next load is fresh
			this.dataSource.invalidateConfigCache(this.repoFileWatcher.getRepo());
		});

		// Render the content of the Webview
		this.update();

		this.logger.log('Created Git Graph View' + (loadViewTo !== null ? ' (active repo: ' + loadViewTo.repo + ')' : ''));
	}

	/**
	 * Respond to a message sent from the front-end.
	 * @param msg The message that was received.
	 */
	private async respondToMessage(msg: RequestMessage) {
		this.repoFileWatcher.mute();

		try {
			await this.handleMessage(msg);
		} catch (error) {
			this.logger.logError('Failed to handle "' + msg.command + '" message: ' + error);
			showErrorMessage('Git Graph RS encountered an error while handling this action.');
		} finally {
			this.repoFileWatcher.unmute();
		}
	}

	/**
	 * Handle a message sent from the front-end.
	 * Any error thrown by a handler is caught and logged by `respondToMessage`.
	 * @param msg The message that was received.
	 */
	private async handleMessage(msg: RequestMessage) {
		let errorInfos: ErrorInfo[];

		switch (msg.command) {
			case 'addRemote':
				this.sendMessage({
					command: 'addRemote',
					error: await this.dataSource.addRemote(msg.repo, msg.name, msg.url, msg.pushUrl, msg.fetch)
				});
				break;
			case 'addTag':
				errorInfos = [await this.dataSource.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, msg.force)];
				if (errorInfos[0] === null && msg.pushToRemote !== null) {
					errorInfos.push(...await this.dataSource.pushTag(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.pushSkipRemoteCheck));
				}
				this.sendMessage({
					command: 'addTag',
					repo: msg.repo,
					tagName: msg.tagName,
					pushToRemote: msg.pushToRemote,
					commitHash: msg.commitHash,
					errors: errorInfos
				});
				break;
			case 'applyStash':
				this.sendMessage({
					command: 'applyStash',
					error: await this.dataSource.applyStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'branchFromStash':
				this.sendMessage({
					command: 'branchFromStash',
					error: await this.dataSource.branchFromStash(msg.repo, msg.selector, msg.branchName)
				});
				break;
			case 'checkoutBranch':
				errorInfos = [await this.dataSource.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch)];
				if (errorInfos[0] === null && msg.pullAfterwards !== null) {
					errorInfos.push(await this.dataSource.pullBranch(msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash));
				}
				this.sendMessage({
					command: 'checkoutBranch',
					pullAfterwards: msg.pullAfterwards,
					errors: errorInfos
				});
				break;
			case 'checkoutCommit':
				this.sendMessage({
					command: 'checkoutCommit',
					error: await this.dataSource.checkoutCommit(msg.repo, msg.commitHash)
				});
				break;
			case 'cherrypickCommit':
				errorInfos = [await this.dataSource.cherrypickCommit(msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit)];
				if (errorInfos[0] === null && msg.noCommit) {
					errorInfos.push(await viewScm());
				}
				this.sendMessage({ command: 'cherrypickCommit', errors: errorInfos });
				break;
			case 'cleanUntrackedFiles':
				this.sendMessage({
					command: 'cleanUntrackedFiles',
					error: await this.dataSource.cleanUntrackedFiles(msg.repo, msg.directories)
				});
				break;
			case 'commitDetails': {
				const commitDetailsPromise: Promise<GitCommitDetailsData> = msg.commitHash === UNCOMMITTED
					? this.dataSource.getUncommittedDetails(msg.repo)
					: msg.stash === null
						? this.dataSource.getCommitDetails(msg.repo, msg.commitHash, msg.hasParents)
						: this.dataSource.getStashDetails(msg.repo, msg.commitHash, msg.stash);
				const avatarPromise: Promise<string | null> = msg.avatarEmail !== null ? this.avatarManager.getAvatarImage(msg.avatarEmail) : Promise.resolve(null);
				const data = await Promise.all([commitDetailsPromise, avatarPromise]);
				this.sendMessage({
					command: 'commitDetails',
					...data[0],
					avatar: data[1],
					codeReview: msg.commitHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.commitHash) : null,
					refresh: msg.refresh
				});
				break;
			}
			case 'commitBodies': {
				let bodies: { [hash: string]: string } = {};
				try {
					bodies = await this.dataSource.getCommitBodies(msg.repo, msg.commitHashes);
				} catch (error) {
					this.logger.logError('Failed to load commit bodies: ' + error);
				}
				this.sendMessage({ command: 'commitBodies', bodies: bodies });
				break;
			}
			case 'compareCommits':
				this.sendMessage({
					command: 'compareCommits',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.dataSource.getCommitComparison(msg.repo, msg.fromHash, msg.toHash),
					codeReview: msg.toHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.fromHash + '-' + msg.toHash) : null,
					refresh: msg.refresh
				});
				break;
			case 'copyFilePath':
				this.sendMessage({
					command: 'copyFilePath',
					error: await copyFilePathToClipboard(msg.repo, msg.filePath, msg.absolute)
				});
				break;
			case 'copyToClipboard':
				this.sendMessage({
					command: 'copyToClipboard',
					type: msg.type,
					error: await copyToClipboard(msg.data)
				});
				break;
			case 'createArchive':
				this.sendMessage({
					command: 'createArchive',
					error: await archive(msg.repo, msg.ref, this.dataSource)
				});
				break;
			case 'createBranch':
				this.sendMessage({
					command: 'createBranch',
					errors: await this.dataSource.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force)
				});
				break;
			case 'createPullRequest':
				errorInfos = [msg.push ? await this.dataSource.pushBranch(msg.repo, msg.sourceBranch, msg.sourceRemote, true, GitPushBranchMode.Normal) : null];
				if (errorInfos[0] === null) {
					errorInfos.push(await createPullRequest(msg.config, msg.sourceOwner, msg.sourceRepo, msg.sourceBranch));
				}
				this.sendMessage({
					command: 'createPullRequest',
					push: msg.push,
					errors: errorInfos
				});
				break;
			case 'deleteBranch':
				errorInfos = [await this.dataSource.deleteBranch(msg.repo, msg.branchName, msg.forceDelete)];
				if (errorInfos[0] === null) {
					for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
						errorInfos.push(await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.deleteOnRemotes[i]));
					}
				}
				this.sendMessage({
					command: 'deleteBranch',
					repo: msg.repo,
					branchName: msg.branchName,
					deleteOnRemotes: msg.deleteOnRemotes,
					errors: errorInfos
				});
				break;
			case 'deleteRemote':
				this.sendMessage({
					command: 'deleteRemote',
					error: await this.dataSource.deleteRemote(msg.repo, msg.name)
				});
				break;
			case 'deleteRemoteBranch':
				this.sendMessage({
					command: 'deleteRemoteBranch',
					error: await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.remote)
				});
				break;
			case 'deleteTag':
				this.sendMessage({
					command: 'deleteTag',
					error: await this.dataSource.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote)
				});
				break;
			case 'deleteUserDetails':
				errorInfos = [];
				if (msg.name) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, msg.location));
				}
				if (msg.email) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, msg.location));
				}
				this.sendMessage({
					command: 'deleteUserDetails',
					errors: errorInfos
				});
				break;
			case 'dropCommit':
				this.sendMessage({
					command: 'dropCommit',
					error: await this.dataSource.dropCommit(msg.repo, msg.commitHash)
				});
				break;
			case 'dropStash':
				this.sendMessage({
					command: 'dropStash',
					error: await this.dataSource.dropStash(msg.repo, msg.selector)
				});
				break;
			case 'editRemote':
				this.sendMessage({
					command: 'editRemote',
					error: await this.dataSource.editRemote(msg.repo, msg.nameOld, msg.nameNew, msg.urlOld, msg.urlNew, msg.pushUrlOld, msg.pushUrlNew)
				});
				break;
			case 'editUserDetails':
				errorInfos = [
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserName, msg.name, msg.location),
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserEmail, msg.email, msg.location)
				];
				if (errorInfos[0] === null && errorInfos[1] === null) {
					if (msg.deleteLocalName) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, GitConfigLocation.Local));
					}
					if (msg.deleteLocalEmail) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, GitConfigLocation.Local));
					}
				}
				this.sendMessage({
					command: 'editUserDetails',
					errors: errorInfos
				});
				break;
			case 'endCodeReview':
				this.extensionState.endCodeReview(msg.repo, msg.id);
				break;
			case 'exportRepoConfig':
				this.sendMessage({
					command: 'exportRepoConfig',
					error: await this.repoManager.exportRepoConfig(msg.repo)
				});
				break;
			case 'fetch':
				this.sendMessage({
					command: 'fetch',
					error: await this.dataSource.fetch(msg.repo, msg.name, msg.prune, msg.pruneTags)
				});
				break;
			case 'fetchAvatar':
				this.avatarManager.fetchAvatarImage(msg.email, msg.repo, msg.remote, msg.commits);
				break;
			case 'fetchIntoLocalBranch':
				this.sendMessage({
					command: 'fetchIntoLocalBranch',
					error: await this.dataSource.fetchIntoLocalBranch(msg.repo, msg.remote, msg.remoteBranch, msg.localBranch, msg.force)
				});
				break;
			case 'countCommitsBefore':
				this.sendMessage({
					command: 'countCommitsBefore',
					hash: msg.hash,
					count: await this.dataSource.countCommitsBefore(msg.repo, msg.branches, msg.hash, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs)
				});
				break;
			case 'loadCommits': {
				this.loadCommitsRefreshId = msg.refreshId;
				const startTime = Date.now();
				// A forced refresh (the Refresh button) must observe fresh repository state: bypass the commit cache
				const commitData = await this.getCommitsCached(msg, true, false);
				this.sendMessage({
					command: 'loadCommits',
					refreshId: msg.refreshId,
					onlyFollowFirstParent: msg.onlyFollowFirstParent,
					uncommittedPending: true,
					...commitData
				});
				this.logger.log('Loaded ' + commitData.commits.length + ' commits in ' + (Date.now() - startTime) + ' ms');
				this.sendUncommittedChangesFollowUp(msg, commitData); // runs asynchronously (never awaited)
				break;
			}
			case 'fetchPullRequest': {
				this.sendMessage({
					command: 'pullRequestStatus',
					branch: msg.branch,
					pr: await this.fetchPullRequest(msg.repo, msg.branch)
				});
				break;
			}
			case 'setInterfaceLanguage': {
				this.sendMessage({
					command: 'setInterfaceLanguage',
					error: await this.setInterfaceLanguage(msg.language)
				});
				break;
			}
			case 'setGlobalSetting': {
				this.sendMessage({
					command: 'setGlobalSetting',
					setting: msg.setting,
					error: await this.setGlobalSetting(msg.setting, msg.value)
				});
				break;
			}
			case 'loadConfig':
				this.sendMessage({
					command: 'loadConfig',
					repo: msg.repo,
					...await this.dataSource.getConfig(msg.repo, msg.remotes)
				});
				break;
			case 'loadRepoInfo': {
				this.loadRepoInfoRefreshId = msg.refreshId;
				const startTime = Date.now();
				let repoInfo = await this.dataSource.getRepoInfo(msg.repo, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes), isRepo = true;
				if (repoInfo.error) {
					// If an error occurred, check to make sure the repo still exists
					isRepo = (await this.dataSource.repoRoot(msg.repo)) !== null;
					if (!isRepo) repoInfo.error = null; // If the error is caused by the repo no longer existing, clear the error message
				}
				this.sendMessage({
					command: 'loadRepoInfo',
					refreshId: msg.refreshId,
					...repoInfo,
					isRepo: isRepo
				});
				this.logger.log('Loaded repository info in ' + (Date.now() - startTime) + ' ms (' + repoInfo.branches.length + ' branches)');
				if (msg.repo !== this.currentRepo) {
					this.currentRepo = msg.repo;
					this.extensionState.setLastActiveRepo(msg.repo);
					this.repoFileWatcher.start(msg.repo);
				}
				break;
			}
			case 'loadRepos':
				if (!msg.check || !await this.repoManager.checkReposExist()) {
					// If not required to check repos, or no changes were found when checking, respond with repos
					this.respondLoadRepos(this.repoManager.getRepos(), null);
				}
				break;
			case 'merge':
				this.sendMessage({
					command: 'merge',
					actionOn: msg.actionOn,
					error: await this.dataSource.merge(msg.repo, msg.obj, msg.actionOn, msg.createNewCommit, msg.squash, msg.noCommit)
				});
				break;
			case 'openExtensionSettings':
				this.sendMessage({
					command: 'openExtensionSettings',
					error: await openExtensionSettings()
				});
				break;
			case 'openLogFile':
				this.sendMessage({
					command: 'openLogFile',
					error: await this.openLogFile()
				});
				break;
			case 'openExternalDirDiff':
				this.sendMessage({
					command: 'openExternalDirDiff',
					error: await this.dataSource.openExternalDirDiff(msg.repo, msg.fromHash, msg.toHash, msg.isGui)
				});
				break;
			case 'openCompareTab':
				CommitComparisonView.open(this.dataSource, msg.repo, msg.fromHash, msg.toHash);
				break;
			case 'openExternalUrl':
				this.sendMessage({
					command: 'openExternalUrl',
					error: await openExternalUrl(msg.url)
				});
				break;
			case 'openFile':
				this.sendMessage({
					command: 'openFile',
					error: await openFile(msg.repo, msg.filePath, msg.hash, this.dataSource)
				});
				break;
			case 'openTerminal':
				this.sendMessage({
					command: 'openTerminal',
					error: await this.dataSource.openGitTerminal(msg.repo, null, msg.name)
				});
				break;
			case 'popStash':
				this.sendMessage({
					command: 'popStash',
					error: await this.dataSource.popStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'pruneRemote':
				this.sendMessage({
					command: 'pruneRemote',
					error: await this.dataSource.pruneRemote(msg.repo, msg.name)
				});
				break;
			case 'pullBranch':
				this.sendMessage({
					command: 'pullBranch',
					error: await this.dataSource.pullBranch(msg.repo, msg.branchName, msg.remote, msg.createNewCommit, msg.squash)
				});
				break;
			case 'pushBranch':
				this.sendMessage({
					command: 'pushBranch',
					willUpdateBranchConfig: msg.willUpdateBranchConfig,
					errors: await this.dataSource.pushBranchToMultipleRemotes(msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode)
				});
				break;
			case 'pushStash':
				this.sendMessage({
					command: 'pushStash',
					error: await this.dataSource.pushStash(msg.repo, msg.message, msg.includeUntracked)
				});
				break;
			case 'pushTag':
				this.sendMessage({
					command: 'pushTag',
					repo: msg.repo,
					tagName: msg.tagName,
					remotes: msg.remotes,
					commitHash: msg.commitHash,
					errors: await this.dataSource.pushTag(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.skipRemoteCheck)
				});
				break;
			case 'rebase':
				this.sendMessage({
					command: 'rebase',
					actionOn: msg.actionOn,
					interactive: msg.interactive,
					error: await this.dataSource.rebase(msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive)
				});
				break;
			case 'renameBranch':
				this.sendMessage({
					command: 'renameBranch',
					error: await this.dataSource.renameBranch(msg.repo, msg.oldName, msg.newName)
				});
				break;
			case 'rescanForRepos':
				if (!(await this.repoManager.searchWorkspaceForRepos())) {
					showErrorMessage('No Git repositories were found in the current workspace.');
				}
				break;
			case 'resetFileToRevision':
				this.sendMessage({
					command: 'resetFileToRevision',
					error: await this.dataSource.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath)
				});
				break;
			case 'resetToCommit':
				this.sendMessage({
					command: 'resetToCommit',
					error: await this.dataSource.resetToCommit(msg.repo, msg.commit, msg.resetMode)
				});
				break;
			case 'revertCommit':
				this.sendMessage({
					command: 'revertCommit',
					error: await this.dataSource.revertCommit(msg.repo, msg.commitHash, msg.parentIndex)
				});
				break;
			case 'editCommitMessage':
				this.sendMessage({
					command: 'editCommitMessage',
					error: await this.dataSource.editCommitMessage(msg.repo, msg.commitHash, msg.message)
				});
				break;

			case 'undoLastCommit':
				this.sendMessage({
					command: 'undoLastCommit',
					error: await this.dataSource.undoLastCommit(msg.repo)
				});
				break;

			case 'setGlobalViewState':
				this.sendMessage({
					command: 'setGlobalViewState',
					error: await this.extensionState.setGlobalViewState(msg.state)
				});
				break;
			case 'setRepoState':
				this.repoManager.setRepoState(msg.repo, msg.state);
				break;
			case 'setWorkspaceViewState':
				this.sendMessage({
					command: 'setWorkspaceViewState',
					error: await this.extensionState.setWorkspaceViewState(msg.state)
				});
				break;
			case 'showErrorMessage':
				showErrorMessage(msg.message);
				break;
			case 'startCodeReview':
				this.sendMessage({
					command: 'startCodeReview',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.extensionState.startCodeReview(msg.repo, msg.id, msg.files, msg.lastViewedFile)
				});
				break;
			case 'tagDetails':
				this.sendMessage({
					command: 'tagDetails',
					tagName: msg.tagName,
					commitHash: msg.commitHash,
					...await this.dataSource.getTagDetails(msg.repo, msg.tagName)
				});
				break;
			case 'updateCodeReview':
				this.sendMessage({
					command: 'updateCodeReview',
					error: await this.extensionState.updateCodeReview(msg.repo, msg.id, msg.remainingFiles, msg.lastViewedFile)
				});
				break;
			case 'viewDiff':
				this.sendMessage({
					command: 'viewDiff',
					error: await viewDiff(msg.repo, msg.fromHash, msg.toHash, msg.oldFilePath, msg.newFilePath, msg.type)
				});
				break;
			case 'viewDiffWithWorkingFile':
				this.sendMessage({
					command: 'viewDiffWithWorkingFile',
					error: await viewDiffWithWorkingFile(msg.repo, msg.hash, msg.filePath, this.dataSource)
				});
				break;
			case 'viewFileAtRevision':
				this.sendMessage({
					command: 'viewFileAtRevision',
					error: await viewFileAtRevision(msg.repo, msg.hash, msg.filePath)
				});
				break;
			case 'viewScm':
				this.sendMessage({
					command: 'viewScm',
					error: await viewScm()
				});
				break;
		}
	}

	/**
	 * Send a message to the front-end.
	 * @param msg The message to be sent.
	 */
	private sendMessage(msg: ResponseMessage) {
		if (this.isDisposed()) {
			this.logger.log('The Git Graph View has already been disposed, ignored sending "' + msg.command + '" message.');
		} else {
			this.panel.webview.postMessage(msg).then(
				() => { },
				() => {
					if (this.isDisposed()) {
						this.logger.log('The Git Graph View was disposed while sending "' + msg.command + '" message.');
					} else {
						this.logger.logError('Unable to send "' + msg.command + '" message to the Git Graph View.');
					}
				}
			);
		}
	}

	/**
	 * Update the HTML document loaded in the Webview.
	 */
	private update() {
		this.panel.webview.html = this.getHtmlForWebview();
	}

	/**
	 * Get the HTML document to be loaded in the Webview.
	 * @returns The HTML.
	 */
	private getHtmlForWebview() {
		const config = getConfig(), nonce = getNonce();
		const initialState: GitGraphViewInitialState = {
			config: {
				commitDetailsView: config.commitDetailsView,
				commitOrdering: config.commitOrder,
				contextMenuActionsVisibility: config.contextMenuActionsVisibility,
				customBranchGlobPatterns: config.customBranchGlobPatterns,
				customEmojiShortcodeMappings: config.customEmojiShortcodeMappings,
				customPullRequestProviders: config.customPullRequestProviders,
				dateFormat: config.dateFormat,
				dateType: config.dateType,
				defaultColumnVisibility: config.defaultColumnVisibility,
				enableLog: config.enableLog,
				stickyHeader: config.stickyHeader,
				dialogDefaults: config.dialogDefaults,
				enhancedAccessibility: config.enhancedAccessibility,
				fetchAndPrune: config.fetchAndPrune,
				fetchAndPruneTags: config.fetchAndPruneTags,
				fetchAvatars: config.fetchAvatars && this.extensionState.isAvatarStorageAvailable(),
				graph: config.graph,
				interfaceLanguage: config.interfaceLanguage,
				includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
				initialLoadCommits: config.initialLoadCommits,
				keybindings: config.keybindings,
				loadMoreCommits: config.loadMoreCommits,
				loadMoreCommitsAutomatically: config.loadMoreCommitsAutomatically,
				markdown: config.markdown,
				mute: config.muteCommits,
				showBodyInline: config.showCommitBodyInline,

				onlyFollowFirstParent: config.onlyFollowFirstParent,
				onRepoLoad: config.onRepoLoad,
				pullRequests: config.pullRequests,
				referenceLabels: config.referenceLabels,
				repoDropdownOrder: config.repoDropdownOrder,
				showCommitBodyInline: config.showCommitBodyInline,
				showRemoteBranches: config.showRemoteBranches,
				showRemoteHeads: config.showRemoteHeads,
				showStashes: config.showStashes,
				showTags: config.showTags,
				showUncommittedChanges: config.showUncommittedChanges,
				showUntrackedFiles: config.showUntrackedFiles,
				trackRemoteTags: config.trackRemoteTags
			},
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: this.loadViewTo,
			repos: this.repoManager.getRepos(),
			loadRepoInfoRefreshId: this.loadRepoInfoRefreshId,
			loadCommitsRefreshId: this.loadCommitsRefreshId,
			backend: describeCapabilities()
		};
		const globalState = this.extensionState.getGlobalViewState();
		const workspaceState = this.extensionState.getWorkspaceViewState();

		let body, numRepos = Object.keys(initialState.repos).length, colorVars = '', colorParams = '';
		for (let i = 0; i < initialState.config.graph.colours.length; i++) {
			colorVars += '--git-graph-color' + i + ':' + initialState.config.graph.colours[i] + '; ';
			colorParams += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ');} ';
		}

		// A platform without an engine binary does not get an error page: the view loads normally
		// and every query runs over the `git` CLI backend (see createBackend). The Settings
		// widget's backend section is where the split is shown.
		if (this.dataSource.isGitExecutableUnknown()) {
			body = `<body class="unableToLoad">
			<h2>Unable to load Git Graph</h2>
			<p class="unableToLoadMessage">${UNABLE_TO_FIND_GIT_MSG}</p>
			</body>`;
		} else if (numRepos > 0) {
			const stickyClassAttr = initialState.config.stickyHeader ? ' class="sticky"' : '';
			body = `<body>
			<div id="view" tabindex="-1">
				<div id="headerRow"${stickyClassAttr}>
					<div id="controls">
						<span id="repoControl"><span id="repoControlLabel" class="unselectable"></span><div id="repoDropdown" class="dropdown"></div></span>
						<span id="branchControl"><span id="branchControlLabel" class="unselectable"></span><div id="branchDropdown" class="dropdown"></div></span>
						<span id="authorControl"><span id="authorControlLabel" class="unselectable"></span><div id="authorDropdown" class="dropdown"></div></span>

					<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span><span id="showRemoteBranchesLabel"></span></label>
					<div id="currentBtn"></div>
						<div id="findBtn"></div>
						<div id="filterBtn"></div>
						<div id="terminalBtn"></div>
						<div id="settingsBtn"></div>
						<div id="fetchBtn"></div>
						<div id="refreshBtn"></div>
					</div>
					<div id="prStatus" style="display:none"></div>
					<div id="pinnedControls" style="display:none">
						<span id="pinnedRowLabel" class="unselectable pinnedRowLabel"></span>
					</div>
				</div>
				<div id="content">
					<div id="commitGraph"></div>
					<div id="commitTable"></div>
				</div>
				<div id="footer"></div>
			</div>
			<script nonce="${nonce}">var initialState = ${encodeJsonForInlineScript(JSON.stringify(initialState))}, globalState = ${encodeJsonForInlineScript(JSON.stringify(globalState))}, workspaceState = ${encodeJsonForInlineScript(JSON.stringify(workspaceState))};</script>
			<script nonce="${nonce}" src="${this.getMediaUri('out.min.js')}?v=${MEDIA_CACHE_VERSION}"></script>
			</body>`;
		} else {
			body = `<body class="unableToLoad">
			<h2>Unable to load Git Graph</h2>
			<p class="unableToLoadMessage">No Git repositories were found in the current workspace when it was last scanned by Git Graph.</p>
			<p>If your repositories are in subfolders of the open workspace folder(s), make sure you have set the Git Graph Setting "git-graph-rs.maxDepthOfRepoSearch" appropriately (read the <a href="https://github.com/mhutchie/vscode-git-graph/wiki/Extension-Settings#max-depth-of-repo-search" target="_blank">documentation</a> for more information).</p>
			<p><div id="rescanForReposBtn" class="roundedBtn">Re-scan the current workspace for repositories</div></p>
			<script nonce="${nonce}">(function(){ var api = acquireVsCodeApi(); document.getElementById('rescanForReposBtn').addEventListener('click', function(){ api.postMessage({command: 'rescanForRepos'}); }); })();</script>
			</body>`;
		}
		this.isGraphViewLoaded = numRepos > 0 && !this.dataSource.isGitExecutableUnknown();
		this.loadViewTo = null;

		return `<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${standardiseCspSource(this.panel.webview.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link rel="stylesheet" type="text/css" href="${this.getMediaUri('out.min.css')}?v=${MEDIA_CACHE_VERSION}">
				<title>Git Graph</title>
				<style>body{${colorVars}} ${colorParams}</style>
			</head>
			${body}
		</html>`;
	}


	/* Pull Request Methods */

	/**
	 * Get the pull/merge request whose source branch matches the checked-out branch of a repository.
	 * Degrades to NULL whenever the integration is disabled, the remote isn't hosted on GitHub or
	 * GitLab, or the API request fails (any failure is silent).
	 * @param repo The path of the repository.
	 * @param branch The branch name.
	 */
	private async fetchPullRequest(repo: string, branch: string) {
		if (!getConfig().pullRequests.enabled) return null;
		try {
			const remoteUrl = await this.dataSource.gitOutput(['remote', 'get-url', 'origin'], repo, (stdout) => stdout.trim());
			return await this.pullRequests.getPullRequestForBranch(remoteUrl, branch);
		} catch (_) {
			return null;
		}
	}


	/**
	 * Save the `git-graph-rs.interfaceLanguage` setting to the Global User Settings. The
	 * onDidChangeConfiguration listener reloads the Git Graph View, which re-renders the webview
	 * with the new language (the settings page is restored from the persisted webview state).
	 * @param language The interface language.
	 * @returns The ErrorInfo of the failure (NULL => saved successfully).
	 */
	private async setInterfaceLanguage(language: 'en' | 'zh-cn'): Promise<ErrorInfo> {
		if (language !== 'en' && language !== 'zh-cn') return 'The interface language must be either "en" or "zh-cn".';
		try {
			await vscode.workspace.getConfiguration('git-graph-rs').update('interfaceLanguage', language, vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Saving the interface language failed: ' + message);
			return message;
		}
		return null;
	}

	/**
	 * Save a Global (User) Setting on behalf of the Settings Widget. Only the settings named by
	 * WRITABLE_GLOBAL_SETTINGS can be written, and only with a value their validator accepts.
	 * The onDidChangeConfiguration listener reloads the Git Graph View, which re-renders the webview
	 * with the new value (the settings page is restored from the persisted webview state).
	 * @param setting The key of the setting, relative to the `git-graph-rs` section.
	 * @param value The new value of the setting.
	 * @returns The ErrorInfo of the failure (NULL => saved successfully).
	 */
	private async setGlobalSetting(setting: string, value: any): Promise<ErrorInfo> {
		const isValid = Object.prototype.hasOwnProperty.call(WRITABLE_GLOBAL_SETTINGS, setting)
			? WRITABLE_GLOBAL_SETTINGS[setting]
			: null;
		if (isValid === null) {
			this.logger.log('Rejected a request to save the setting "' + setting + '" (not a writable Global Setting).');
			return 'The setting "' + setting + '" cannot be changed from the Settings page.';
		}
		if (!isValid(value)) {
			return 'The value provided for the setting "' + setting + '" is invalid.';
		}
		try {
			await vscode.workspace.getConfiguration('git-graph-rs').update(setting, value, vscode.ConfigurationTarget.Global);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.log('Saving the setting "' + setting + '" failed: ' + message);
			return message;
		}
		return null;
	}

	/* Uncommitted Changes Follow-up */

	/**
	 * Complete a `loadCommits` request that was already answered without waiting for the
	 * uncommitted changes status (a `git status` that can be slow on large working trees, so it's
	 * deliberately excluded from the initial response). Fetches the status and sends the final
	 * `loadCommits` response marked `uncommittedPending: false`, prepending the synthetic
	 * "Uncommitted Changes" row to the SAME commit list already sent when there are uncommitted
	 * changes, so no Git commands (log/refs) are re-run. The Git Graph View keeps the previously
	 * rendered row (with its stale count) until this response arrives, so the row never flickers
	 * away and back on a refresh - only its count is updated.
	 * @param msg The original `loadCommits` request message.
	 * @param commitData The commit data already sent in the initial response.
	 */
	private async sendUncommittedChangesFollowUp(msg: RequestLoadCommits, commitData: GitCommitData) {
		// Match dataSource.getCommits: only prepend the row when HEAD is among the loaded commits
		// (with a filter or cutoff excluding HEAD, the row would have no parent in the graph).
		if (!getConfig().showUncommittedChanges || commitData.head === null || commitData.error !== null) return;
		if (!commitData.commits.some((commit) => commit.hash === commitData.head)) return;

		let numUncommittedChanges = 0;
		try {
			numUncommittedChanges = await this.dataSource.getUncommittedChanges(msg.repo);
		} catch (_) {
			numUncommittedChanges = 0;
		}
		if (this.loadCommitsRefreshId !== msg.refreshId) return; // superseded by a newer load request

		this.sendMessage({
			command: 'loadCommits',
			refreshId: msg.refreshId,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			commits: numUncommittedChanges > 0
				? [{
					hash: UNCOMMITTED,
					parents: [commitData.head],
					author: '*',
					email: '',
					date: Math.round(Date.now() / 1000),
					message: 'Uncommitted Changes (' + numUncommittedChanges + ')',
					heads: [],
					tags: [],
					remotes: [],
					stash: null
				}, ...commitData.commits]
				: commitData.commits,
			head: commitData.head,
			tags: commitData.tags,
			moreCommitsAvailable: commitData.moreCommitsAvailable,
			error: null
		});
	}

	/**
	 * Load the commits of a `loadCommits` request, serving identical requests from the commit cache
	 * instead of re-running Git (see `commitCache`).
	 * @param msg The `loadCommits` request message.
	 * @param deferUncommittedChanges Skip computing the "Uncommitted Changes" row in the initial response.
	 * @param forceFresh Bypass the cache (forced refresh) and refresh the cached entry.
	 * @returns The commits in the repository.
	 */
	private async getCommitsCached(msg: RequestLoadCommits, deferUncommittedChanges: boolean, forceFresh: boolean): Promise<GitCommitData> {
		const key = JSON.stringify([msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, msg.filterPath === undefined ? null : msg.filterPath, deferUncommittedChanges]);
		if (!forceFresh) {
			const cached = this.commitCache.get(key);
			if (cached !== undefined) return cached;
		}
		const promise: Promise<GitCommitData> = this.dataSource.getCommits(msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, null, false, msg.filterPath === undefined ? null : msg.filterPath, deferUncommittedChanges).then((commitData) => {
			if (commitData.error !== null && this.commitCache.get(key) === promise) {
				// Don't cache error results (they may be transient): allow the next call to retry
				this.commitCache.delete(key);
			}
			return commitData;
		});
		if (this.commitCache.size >= GitGraphView.COMMIT_CACHE_LIMIT) {
			this.commitCache.delete(this.commitCache.keys().next().value!); // evict the oldest entry
		}
		this.commitCache.set(key, promise);
		return promise;
	}

	/**
	 * Open this session's log file in an editor tab. The file starts empty on every activation, so
	 * what it shows is always the log of the current editor session.
	 */
	private async openLogFile(): Promise<string | null> {
		const logFile = this.logger.getLogFile();
		if (logFile === null) {
			return 'No log is being recorded for this session. Enable the "git-graph-rs.enableLog" setting to record one.';
		}
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logFile));
			await vscode.window.showTextDocument(document, { preview: false });
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/* URI Manipulation Methods */

	/**
	 * Get a WebviewUri for a media file included in the extension.
	 * @param file The file name in the `media` directory.
	 * @returns The WebviewUri.
	 */
	private getMediaUri(file: string) {
		return this.panel.webview.asWebviewUri(this.getUri('media', file));
	}

	/**
	 * Get a File Uri for a resource file included in the extension.
	 * @param file The file name in the `resource` directory.
	 * @returns The Uri.
	 */
	private getResourcesUri(file: string) {
		return this.getUri('resources', file);
	}

	/**
	 * Get a File Uri for a file included in the extension.
	 * @param pathComps The path components relative to the root directory of the extension.
	 * @returns The File Uri.
	 */
	private getUri(...pathComps: string[]) {
		return vscode.Uri.file(path.join(this.extensionPath, ...pathComps));
	}


	/* Response Construction Methods */

	/**
	 * Send the known repositories to the front-end.
	 * @param repos The set of known repositories.
	 * @param loadViewTo What to load the view to.
	 */
	private respondLoadRepos(repos: GitRepoSet, loadViewTo: LoadGitGraphViewTo) {
		this.sendMessage({
			command: 'loadRepos',
			repos: repos,
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: loadViewTo
		});
	}
}

/**
 * Standardise the CSP Source provided by Visual Studio Code for use with the Webview. It is idempotent unless called with http/https URI's, in which case it keeps only the authority portion of the http/https URI. This is necessary to be compatible with some web browser environments.
 * @param cspSource The value provide by Visual Studio Code.
 * @returns The standardised CSP Source.
 */
export function standardiseCspSource(cspSource: string) {
	if (cspSource.startsWith('http://') || cspSource.startsWith('https://')) {
		const pathIndex = cspSource.indexOf('/', 8), queryIndex = cspSource.indexOf('?', 8), fragmentIndex = cspSource.indexOf('#', 8);
		let endOfAuthorityIndex = pathIndex;
		if (queryIndex > -1 && (queryIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = queryIndex;
		if (fragmentIndex > -1 && (fragmentIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = fragmentIndex;
		return endOfAuthorityIndex > -1 ? cspSource.substring(0, endOfAuthorityIndex) : cspSource;
	} else {
		return cspSource;
	}
}

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Cache-busting version appended to the webview media URIs.
 * Must be bumped whenever web/ sources change, so that already-open webviews
 * don't keep serving a stale cached out.min.js / out.min.css after an update.
 * Derived from the extension's own version, which every release bumps: serving
 * a webview bundle that predates the extension host running it has produced
 * hard-to-reproduce webview errors (a host and a webview disagreeing about a
 * message field), so the buster must never be forgotten.
 */
let mediaCacheVersion: string | null = null;
function getMediaCacheVersion(extensionPath: string): string {
	const cached = mediaCacheVersion;
	if (cached !== null) return cached;
	let version: string;
	try {
		version = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')).version;
	} catch (_) {
		version = String(Date.now()); // unreadable version: bust every session instead
	}
	mediaCacheVersion = version;
	return version;
}

import { AvatarManager } from './avatarManager';
import { describeCapabilities } from './backend';
import { hasEngineForPlatform } from './backend/addon';
import { getConfig } from './config';
import { CommitComparisonView } from './comparisonView';
import { DataSource, GitCommitData, GitCommitDetailsData, GitConfigKey } from './dataSource';
import { ExtensionState } from './extensionState';
import { buildFetchRefspecs, changeShard, filterChangeStates, limitChanges, parseChangeRef } from './gerrit';
import { t } from './i18n';
import { Logger } from './logger';
import { PullRequestDataSource } from './pullRequests';
import { RepoFileWatcher } from './repoFileWatcher';
import { RepoManager } from './repoManager';
import { ErrorInfo, GerritChangeState, LossWarning, GerritStatusFilter, GitConfigLocation, GitGraphViewInitialState, GitPushBranchMode, GitRepoSet, LoadGitGraphViewTo, RequestGerritSetFetchRefs, RequestLoadCommits, RequestMessage, ResponseMessage, TabIconColourTheme } from './types';
import { UNCOMMITTED, archive, copyFilePathToClipboard, copyToClipboard, createPullRequest, encodeJsonForInlineScript, getNonce, openExtensionSettings, openExternalUrl, openFile, showErrorMessage, unableToFindGitMsg, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision, viewScm } from './utils';
import { Disposable, toDisposable } from './utils/disposable';

/**
 * Whether the complete (remote-refs-included) response of `sendRemoteRefsFollowUp` differs from
 * the deferred (local-only) response already sent, and is therefore worth sending as a follow-up.
 *
 * Comparing only each commit's `remotes` labels (as this once did) misses two real differences:
 * a commit can differ at the same index without any `remotes` label changing (the local-only walk
 * and the complete walk can disagree on which commits fill a `maxCommits`-truncated window without
 * either window's visible commits gaining a label), and the branch dropdown's option list — driven
 * by `branches`, not by any commit's `remotes` — can gain remote-tracking branches whose tip commit
 * never entered the loaded window at all. Either case must still trigger the follow-up, or the
 * webview is left rendering the deferred, local-only data for the rest of the session.
 */
export function remoteRefsFollowUpChanged(deferred: GitCommitData, complete: GitCommitData): boolean {
	if (!stringArraysEqual(deferred.branches, complete.branches)) return true;
	if (deferred.commits.length !== complete.commits.length) return true;
	return complete.commits.some((commit, index) => {
		const previous = deferred.commits[index];
		return commit.hash !== previous.hash ||
			commit.remotes.length !== previous.remotes.length ||
			commit.remotes.some((remote, remoteIndex) => remote.name !== previous.remotes[remoteIndex].name || remote.remote !== previous.remotes[remoteIndex].remote);
	});
}

function stringArraysEqual(a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

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

/** The cached (unfiltered) Gerrit data of a repository. */
interface GerritCacheEntry {
	states: GerritChangeState[];
	patchsets: Map<number, number[]>;
	/** The fetch limit this entry's changes were selected with: a request under a different limit re-fetches. */
	fetchLimit: number;
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
	 * The cached Gerrit change data of each repository (UNFILTERED, so switching the status filter
	 * re-renders instantly). Rebuilt from the locally fetched change refs without any network
	 * access, and only refreshed from the remote by `fetchGerritChanges` for a repository the user
	 * explicitly asked to fetch (the Fetch button, enabling the integration, or changing its fetch
	 * settings) — a plain view load or a hard refresh never touches the network.
	 */
	private readonly gerritCache: Map<string, GerritCacheEntry> = new Map();
	/** The Gerrit fetch currently in progress per repository, so concurrent loads share one fetch. */
	private readonly gerritFetches: Map<string, Promise<GerritCacheEntry | null>> = new Map();
	/** Repositories whose cached Gerrit data must be re-fetched from the remote on the next load. */
	private readonly gerritStaleRepos: Set<string> = new Set();
	/** Incremented whenever the Gerrit fetch settings change, so stale in-flight fetches don't repopulate the cache. */
	private gerritCacheGeneration: number = 0;
	/**
	 * Commands whose handlers can modify the repository (its HEAD, refs, stash, index, working tree
	 * or Git config). They run with the RepoFileWatcher muted, so the watcher-based commit cache
	 * invalidation never fires for changes the Git Graph View makes itself: these commands must
	 * invalidate the cache directly (see `respondToMessage`), otherwise the `loadCommits` request of
	 * the webview's post-action refresh is served pre-action data - e.g. a stale HEAD after a
	 * checkout, leaving the current-position marker on the previously checked-out commit.
	 */
	private static readonly REPO_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
		'addRemote', 'addTag', 'applyStash', 'branchFromStash', 'checkoutBranch', 'checkoutCommit', 'cherrypickCommit',
		'cleanUntrackedFiles', 'createBranch', 'createPullRequest', 'deleteBranch', 'deleteRemote', 'deleteRemoteBranch',
		'deleteTag', 'dropCommit', 'dropStash', 'editRemote', 'editUserDetails', 'fetch', 'fetchIntoLocalBranch', 'gerritSetFetchRefs', 'merge',
		'popStash', 'pruneRemote', 'pullBranch', 'pushBranch', 'pushStash', 'pushTag', 'rebase', 'renameBranch',
		'resetFileToRevision', 'resetToCommit', 'revertCommit', 'editCommitMessage', 'undoLastCommit'
	]);

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
						if (this.isGraphViewLoaded) {
							// The webview is already rendered: refresh its data in place instead of
							// regenerating the HTML, which would reload the page and re-render the
							// entire graph from scratch (a blank flash on every tab switch). The
							// webview's soft refresh keeps the rendered commits, the loadRepoInfo
							// request it sends restores this.currentRepo and the repo file watcher,
							// and the extension's commit cache serves the commits without rescanning.
							this.sendMessage({ command: 'refresh' });
						} else {
							this.update();
						}
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
					// The Gerrit fetch settings (remote, fetch limit) may have changed: drop the
					// cached change data so it is re-derived under the new settings
					this.clearGerritCaches();
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
			showErrorMessage(t('actionHandlingError'));
		} finally {
			this.repoFileWatcher.unmute();
			if (GitGraphView.REPO_MUTATING_COMMANDS.has(msg.command)) {
				// The handler ran with the RepoFileWatcher muted, so any repository change it made
				// bypassed the watcher-based cache invalidation. Drop the cached commit data even
				// when the action failed: a partially completed action (e.g. a conflicted merge)
				// may still have moved refs, and the cost of re-running Git once is negligible.
				this.commitCache.clear();
			}
		}
	}

	/**
	 * Forward a data-loss warning returned by an action to the view: its standard warning dialog
	 * shows the message (with the mascot image), and confirming re-sends the original request
	 * with its confirmed flag set.
	 * @param result The action result: a warning, or an array that may hold one.
	 * @param request The original request, replayed on confirmation.
	 * @returns TRUE when a warning was forwarded and the action must not report a result.
	 */
	private sendLossWarning(result: ErrorInfo | LossWarning | ReadonlyArray<ErrorInfo | LossWarning>, request: RequestMessage): boolean {
		const warning = Array.isArray(result) ? result[0] : result;
		if (warning === null || typeof warning !== 'object' || !('message' in warning)) return false;
		this.sendMessage({ command: 'lossWarning', message: warning.message, retry: { ...request, confirmed: true } as RequestMessage });
		return true;
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
			case 'checkoutBranch': {
				const checkoutResult = await this.dataSource.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch, msg.confirmed === true);
				if (this.sendLossWarning(checkoutResult, msg)) break;
				errorInfos = [<ErrorInfo>checkoutResult];
				if (errorInfos[0] === null && msg.pullAfterwards !== null) {
					errorInfos.push(await this.dataSource.pullBranch(msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash));
				}
				this.sendMessage({
					command: 'checkoutBranch',
					pullAfterwards: msg.pullAfterwards,
					errors: errorInfos
				});
				break;
			}
			case 'checkoutCommit': {
				const checkoutResult = await this.dataSource.checkoutCommit(msg.repo, msg.commitHash, msg.confirmed === true);
				if (this.sendLossWarning(checkoutResult, msg)) break;
				this.sendMessage({
					command: 'checkoutCommit',
					error: <ErrorInfo>checkoutResult
				});
				break;
			}
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
			case 'commitFileCounts': {
				const counts = await this.dataSource.getCommitFileCounts(msg.repo, msg.from, msg.to, msg.paths);
				this.sendMessage({
					command: 'commitFileCounts',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					counts: counts.counts,
					error: counts.error
				});
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
			case 'createBranch': {
				const createResult = await this.dataSource.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force, msg.confirmed === true);
				if (this.sendLossWarning(createResult, msg)) break;
				this.sendMessage({
					command: 'createBranch',
					errors: <ErrorInfo[]>createResult
				});
				break;
			}
			case 'createPullRequest':
				errorInfos = [<ErrorInfo>(msg.push ? await this.dataSource.pushBranch(msg.repo, msg.sourceBranch, msg.sourceRemote, true, GitPushBranchMode.Normal) : null)];
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
			case 'fetch': {
				const fetchError = await this.dataSource.fetch(msg.repo, msg.name, msg.prune, msg.pruneTags);
				// A plain fetch may update the change refs of the configured fetch refspecs: the
				// cached Gerrit data of this repository must be re-derived from the remote on the next load
				if (fetchError === null) this.gerritStaleRepos.add(msg.repo);
				this.sendMessage({
					command: 'fetch',
					error: fetchError
				});
				break;
			}
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
				// Remote-tracking refs dominate the ref scan on repositories with many of them (a
				// Gerrit one above all), so the first response is sent WITHOUT them: the local
				// branch and tag pills render immediately, and the complete ref set follows
				// asynchronously (see `sendRemoteRefsFollowUp`).
				const deferRemoteRefs = msg.showRemoteBranches;
				// A hard refresh (e.g. the Refresh button) must observe fresh repository state even if
				// the commit cache is still warm (e.g. a watcher event swallowed by the watcher's
				// post-action suppression window): bypass the commit cache
				if (!msg.gerritFetchRefs) {
					// Gerrit integration disabled for this repository: load the commits without any Gerrit data
					const commitData = await this.getCommitsCached(msg, null, true, msg.hard, deferRemoteRefs);
					this.sendMessage({
						command: 'loadCommits',
						refreshId: msg.refreshId,
						onlyFollowFirstParent: msg.onlyFollowFirstParent,
						gerritStates: null,
						uncommittedPending: true,
						...commitData
					});
					this.logger.log('Loaded ' + commitData.commits.length + ' commits in ' + (Date.now() - startTime) + ' ms');
					// runs asynchronously (never awaited): the remote refs first, then the "Uncommitted Changes" status on top of the complete data
					void this.sendRemoteRefsFollowUp(msg, null, commitData, null, true, msg.hard).then((complete) => this.sendUncommittedChangesFollowUp(msg, complete));
				} else if (this.gerritCache.has(msg.repo) && msg.hard !== true && !this.gerritStaleRepos.has(msg.repo)
					&& this.gerritCache.get(msg.repo)!.fetchLimit === this.gerritFetchLimitOf(msg)) {
					// The Gerrit data is already cached (under the requested fetch limit): serve it instantly from the cache
					const gerritData = this.buildGerritViewData(this.gerritCache.get(msg.repo)!, msg.gerritStatusFilter);
					const commitData = await this.getCommitsCached(msg, gerritData.refs, true, msg.hard, deferRemoteRefs);
					this.sendMessage({
						command: 'loadCommits',
						refreshId: msg.refreshId,
						onlyFollowFirstParent: msg.onlyFollowFirstParent,
						gerritStates: gerritData.states,
						uncommittedPending: true,
						...commitData
					});
					this.logger.log('Loaded ' + commitData.commits.length + ' commits in ' + (Date.now() - startTime) + ' ms');
					// runs asynchronously (never awaited): the remote refs first, then the "Uncommitted Changes" status on top of the complete data
					void this.sendRemoteRefsFollowUp(msg, gerritData.refs, commitData, gerritData.states, true, msg.hard).then((complete) => this.sendUncommittedChangesFollowUp(msg, complete, gerritData.states));
				} else {
					// No fresh Gerrit data (the extension just started, the repository was marked
					// stale, or a hard refresh was requested): render the branch graph IMMEDIATELY
					// with the stale Gerrit data (if any) — the first paint must never wait for the
					// Gerrit pipeline (the local meta parsing and, only for a repository the user
					// asked to fetch, the network fetch) NOR for the working-tree status scan, which
					// on a large working tree costs seconds and is deferred exactly as in the
					// Gerrit-less path above.
					// This response is marked `gerritPending`, and the pipeline completes
					// asynchronously in stages: the remote refs, then the badges once the metas are
					// parsed (usually by the Rust engine, in one call), then the review timelines,
					// and the "Uncommitted Changes" row last.
					const staleGerritData = this.gerritCache.has(msg.repo)
						? this.buildGerritViewData(this.gerritCache.get(msg.repo)!, msg.gerritStatusFilter)
						: null;
					const staleRefs = staleGerritData !== null ? staleGerritData.refs : null;
					const commitData = await this.getCommitsCached(msg, staleRefs, true, msg.hard, deferRemoteRefs);
					this.sendMessage({
						command: 'loadCommits',
						refreshId: msg.refreshId,
						onlyFollowFirstParent: msg.onlyFollowFirstParent,
						gerritPending: true,
						gerritStates: staleGerritData !== null ? staleGerritData.states : null,
						uncommittedPending: true,
						...commitData
					});
					// runs asynchronously (never awaited): the remote refs, then the Gerrit pipeline
					// on top of the complete data, then the "Uncommitted Changes" status last (on
					// the commit data the Gerrit stages actually rendered, which may be fresher)
					void this.sendRemoteRefsFollowUp(msg, staleRefs, commitData, staleGerritData !== null ? staleGerritData.states : null, true, msg.hard).then(async (complete) => {
						const result = await this.loadCommitsGerritFollowUp(msg, staleRefs, complete);
						await this.sendUncommittedChangesFollowUp(msg, result.commitData, result.states);
					});
				}
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
			case 'gerritSetFetchRefs': {
				this.sendMessage(await this.gerritSetFetchRefs(msg));
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
				// The remote-tracking refs are NOT scanned for this response (see
				// `deferRemoteRefs`): the branch dropdown starts local-only, and the complete list
				// rides along the follow-up `loadCommits` response that carries the remote pills —
				// the branch list and the pills come from the same ref scan, so it is run once.
				const repoInfo = await this.dataSource.getRepoInfo(msg.repo, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes, msg.showRemoteBranches);
				let isRepo = true;
				if (repoInfo.error) {
					// If an error occurred, check to make sure the repo still exists
					isRepo = (await this.dataSource.repoRoot(msg.repo)) !== null;
					if (!isRepo) repoInfo.error = null; // If the error is caused by the repo no longer existing, clear the error message
				}
				this.sendMessage({
					command: 'loadRepoInfo',
					refreshId: msg.refreshId,
					...repoInfo,
					isRepo: isRepo,
					remoteRefsPending: msg.showRemoteBranches || undefined
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
			case 'pushBranch': {
				const pushResult = await this.dataSource.pushBranchToMultipleRemotes(msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode, msg.confirmed === true);
				if (this.sendLossWarning(pushResult, msg)) break;
				this.sendMessage({
					command: 'pushBranch',
					willUpdateBranchConfig: msg.willUpdateBranchConfig,
					errors: <ErrorInfo[]>pushResult
				});
				break;
			}
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
					showErrorMessage(t('noReposInWorkspace'));
				}
				break;
			case 'resetFileToRevision':
				this.sendMessage({
					command: 'resetFileToRevision',
					error: await this.dataSource.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath)
				});
				break;
			case 'resetToCommit': {
				const resetResult = await this.dataSource.resetToCommit(msg.repo, msg.commit, msg.resetMode, msg.confirmed === true);
				if (this.sendLossWarning(resetResult, msg)) break;
				this.sendMessage({
					command: 'resetToCommit',
					error: <ErrorInfo>resetResult
				});
				break;
			}
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
				gerrit: config.gerrit,
				graph: config.graph,
				interfaceLanguage: config.interfaceLanguage,
				interfaceLanguageSetting: config.interfaceLanguageSetting,
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
			backend: describeCapabilities({ gitCliAvailable: !this.dataSource.isGitExecutableUnknown() })
		};
		const globalState = this.extensionState.getGlobalViewState();
		const workspaceState = this.extensionState.getWorkspaceViewState();

		let body, numRepos = Object.keys(initialState.repos).length, colorVars = '', colorParams = '';
		for (let i = 0; i < initialState.config.graph.colours.length; i++) {
			colorVars += '--git-graph-color' + i + ':' + initialState.config.graph.colours[i] + '; ';
			colorParams += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ');} ';
		}

		// The view needs the engine or Git — either one is enough (the engine serves every read
		// in-process; Git serves everything through the CLI backend). The page below appears only
		// when neither is present. The Settings widget's backend section shows which is in use.
		if (this.dataSource.isGitExecutableUnknown() && !hasEngineForPlatform(this.extensionPath)) {
			body = `<body class="unableToLoad">
			<h2>${t('unableToLoadGitGraph')}</h2>
			<p class="unableToLoadMessage">${unableToFindGitMsg()}</p>
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
			<script nonce="${nonce}" src="${this.getMediaUri('out.min.js')}?v=${getMediaCacheVersion(this.extensionPath)}"></script>
			</body>`;
		} else {
			body = `<body class="unableToLoad">
			<h2>${t('unableToLoadGitGraph')}</h2>
			<p class="unableToLoadMessage">${t('noReposWhenLastScanned')}</p>
			<p>${t('noReposHint', 'https://github.com/mhutchie/vscode-git-graph/wiki/Extension-Settings#max-depth-of-repo-search')}</p>
			<p><div id="rescanForReposBtn" class="roundedBtn">${t('rescanForReposButton')}</div></p>
			<script nonce="${nonce}">(function(){ var api = acquireVsCodeApi(); document.getElementById('rescanForReposBtn').addEventListener('click', function(){ api.postMessage({command: 'rescanForRepos'}); }); })();</script>
			</body>`;
		}
		this.isGraphViewLoaded =
			numRepos > 0 && (!this.dataSource.isGitExecutableUnknown() || hasEngineForPlatform(this.extensionPath));
		this.loadViewTo = null;

		return `<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${standardiseCspSource(this.panel.webview.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link rel="stylesheet" type="text/css" href="${this.getMediaUri('out.min.css')}?v=${getMediaCacheVersion(this.extensionPath)}">
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
	private async setInterfaceLanguage(language: 'auto' | 'en' | 'zh-cn'): Promise<ErrorInfo> {
		if (language !== 'auto' && language !== 'en' && language !== 'zh-cn') return t('interfaceLanguageInvalid');
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
			return t('settingNotWritable', setting);
		}
		if (!isValid(value)) {
			return t('settingValueInvalid', setting);
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
	 * @param gerritStates The Gerrit states already sent in the initial response (unaffected by this follow-up).
	 */
	private async sendUncommittedChangesFollowUp(msg: RequestLoadCommits, commitData: GitCommitData, gerritStates: GerritChangeState[] | null = null) {
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
			gerritStates: gerritStates,
			commits: numUncommittedChanges > 0
				? [{
					hash: UNCOMMITTED,
					parents: [commitData.head],
					author: '*',
					email: '',
					date: Math.round(Date.now() / 1000),
					message: t('uncommittedChangesRow', numUncommittedChanges),
					heads: [],
					tags: [],
					remotes: [],
					stash: null
				}, ...commitData.commits]
				: commitData.commits,
			head: commitData.head,
			tags: commitData.tags,
			branches: commitData.branches ?? null,
			moreCommitsAvailable: commitData.moreCommitsAvailable,
			error: null
		});
	}

	/* Gerrit Methods */

	/**
	 * Enable or disable the fetching of Gerrit change refs of a repository (the checkbox of the
	 * Repository Settings). Enabling marks the repository's Gerrit data stale, so the very next
	 * load runs the fetch pipeline (ls-remote probe, targeted fetch, prune, meta parsing).
	 * Disabling deletes ALL locally fetched change refs (`refs/remotes/<gerrit.remote>/changes/*`)
	 * with one batched `git update-ref --stdin` command, so the change commits leave the graph and
	 * nothing is re-fetched until the integration is enabled again.
	 */
	private async gerritSetFetchRefs(msg: RequestGerritSetFetchRefs): Promise<ResponseMessage> {
		if (msg.enabled) {
			this.gerritStaleRepos.add(msg.repo);
			this.commitCache.clear();
			return { command: 'gerritSetFetchRefs', error: null, enabled: true, cleared: 0 };
		}
		const { error, cleared } = await this.dataSource.gerrit.clearLocalChanges(msg.repo, getConfig().gerrit.remote);
		if (error === null) {
			// The change refs are gone: drop everything derived from them
			this.gerritCache.delete(msg.repo);
			this.gerritStaleRepos.delete(msg.repo);
			this.commitCache.clear();
			this.logger.log('Deleted ' + cleared + ' Gerrit change refs from ' + msg.repo);
		} else {
			this.logger.log('Deleting the Gerrit change refs of ' + msg.repo + ' failed: ' + error);
		}
		return { command: 'gerritSetFetchRefs', error: error, enabled: false, cleared: cleared };
	}

	/**
	 * Drop every cached Gerrit change datum and mark all repositories stale (the fetch settings changed).
	 */
	private clearGerritCaches() {
		for (const repo of this.gerritCache.keys()) this.gerritStaleRepos.add(repo);
		this.gerritCache.clear();
		this.gerritFetches.clear();
		this.gerritCacheGeneration++;
	}

	/**
	 * Build a Gerrit cache entry from the locally cached change refs
	 * (`refs/remotes/<remote>/changes/*`) of a repository, WITHOUT any network access. This makes
	 * Gerrit data fetched previously available instantly (and offline), until the next refresh
	 * re-fetches it from the remote.
	 * @param repo The path of the repository.
	 * @param fetchLimit The fetch limit the entry is recorded under (the local refs were fetched
	 * under the limit of the last fetch; the next online refresh aligns them with `fetchLimit`).
	 * @returns The cache entry, or NULL if the repository has no local change refs.
	 */
	private async buildLocalGerritEntry(repo: string, fetchLimit: number): Promise<GerritCacheEntry | null> {
		const config = getConfig().gerrit;
		const remote = config.remote, gerrit = this.dataSource.gerrit;
		try {
			const changes = new Map<number, number[]>();
			for (const ref of await gerrit.listLocalChangeRefs(repo, remote)) {
				const parsed = parseChangeRef(ref);
				if (parsed === null || parsed.meta || parsed.patchset === undefined) continue;
				const patchsets = changes.get(parsed.change);
				if (patchsets === undefined) changes.set(parsed.change, [parsed.patchset]);
				else if (!patchsets.includes(parsed.patchset)) patchsets.push(parsed.patchset);
			}
			if (changes.size === 0) return null;
			for (const patchsets of changes.values()) patchsets.sort((a, b) => a - b);

			// Both of these only read the local repository (git for-each-ref / git log / git config)
			const urlBase = await gerrit.getChangeUrlBase(repo, remote);
			const statesByChange = await gerrit.parseMetas(repo, remote, Array.from(changes.keys()), urlBase);
			const entry: GerritCacheEntry = { states: [], patchsets: new Map(), fetchLimit: fetchLimit };
			for (const [change, patchsets] of changes) {
				const state = statesByChange.get(change);
				if (state === undefined || state === null) continue; // meta ref not available locally
				entry.states.push(state);
				entry.patchsets.set(change, patchsets);
			}
			return entry.states.length > 0 ? entry : null;
		} catch (errorMessage) {
			this.logger.log('Building the Gerrit data from the local change refs failed: ' + errorMessage);
			return null;
		}
	}

	/**
	 * Derive the Gerrit view data of a cache entry: all cached states (the Webview applies the
	 * status filter locally, so toggling the filter re-renders instantly without a reload), and
	 * the change refs to inject into the commit log (built from the states passing the filter).
	 * @param cache The cache entry of the repository.
	 * @param statusFilter The status filter of the repository.
	 */
	private buildGerritViewData(cache: GerritCacheEntry, statusFilter: GerritStatusFilter): { states: GerritChangeState[], refs: string[] } {
		const remote = getConfig().gerrit.remote;
		const refs: string[] = [];
		for (const state of filterChangeStates(cache.states, statusFilter)) {
			// Merged changes are already part of the target branch's history (their content was
			// submitted, possibly re-hashed by a cherry-pick/rebase submit strategy). Injecting their
			// patchset refs would add duplicate floating chains to the graph and push branch commits
			// out of the loaded commits window, so the "Merged" filter must only affect the review
			// info displayed, never the commits in the graph.
			if (state.status === 'merged') continue;
			const patchsets = cache.patchsets.get(state.change);
			if (patchsets === undefined) continue;
			refs.push('refs/remotes/' + remote + '/changes/' + changeShard(state.change) + '/' + state.change + '/' + patchsets[patchsets.length - 1]);
		}
		return { states: cache.states, refs: refs };
	}

	/**
	 * Load the Gerrit change states of a repository: serve the cache when it is fresh, and run the
	 * fetch pipeline (reusing an in-progress fetch) when a refresh is required. Any failure
	 * degrades to the previously cached data (or NULL, the plain view without Gerrit data).
	 *
	 * The remote is contacted ONLY for a repository marked stale (the user fetched from the remote,
	 * enabled the integration, or changed its fetch settings) — a plain view load or a hard refresh
	 * re-reads the LOCAL change refs and metas and never touches the network.
	 * @param repo The path of the repository.
	 * @param statusFilter The status filter of the repository.
	 * @param fetchLimit The fetch limit to select the changes under; a cache built under a
	 *                   different limit is refreshed, because the fetched set of changes differs.
	 * @param rebuildFromLocal Whether the cache must be re-derived from the local change refs
	 *                        (a hard refresh: the repository may have changed behind the cache's
	 *                        back, e.g. a fetch run from a terminal).
	 */
	private async loadGerritData(repo: string, statusFilter: GerritStatusFilter, fetchLimit: number, rebuildFromLocal: boolean): Promise<{ states: GerritChangeState[], refs: string[] } | null> {
		let cache = this.gerritCache.get(repo) || null;
		if (cache === null || rebuildFromLocal) {
			// No cached data (e.g. the extension just started), or a hard refresh: (re)build the cache
			// from the locally cached change refs, WITHOUT any network access, so the Gerrit data is
			// displayed instantly and works offline
			cache = await this.buildLocalGerritEntry(repo, fetchLimit);
			if (cache !== null) this.gerritCache.set(repo, cache);
		}
		if (this.gerritStaleRepos.has(repo) || cache === null || cache.fetchLimit !== fetchLimit) {
			// Reuse a fetch that is already in progress for this repository
			let fetch = this.gerritFetches.get(repo);
			if (fetch === undefined) {
				fetch = this.fetchGerritChanges(repo, fetchLimit).then((entry) => {
					this.gerritFetches.delete(repo);
					return entry;
				});
				this.gerritFetches.set(repo, fetch);
			}
			const fetched = await fetch;
			if (fetched !== null) {
				this.gerritStaleRepos.delete(repo);
				cache = fetched;
			} // on failure, fall back to the local cache (if any) and keep the stale flag so the next load retries the fetch
		}
		if (cache === null) return null;
		return this.buildGerritViewData(cache, statusFilter);
	}

	/**
	 * Run the Gerrit refresh pipeline: ls-remote probe, targeted fetch, prune and meta parsing.
	 * The unfiltered result is stored in the Gerrit cache of the repository.
	 * @param repo The path of the repository.
	 * @param fetchLimit How many of the most recent changes to fetch (the repository's own limit,
	 *                   or the `gerrit.fetchLimit` Extension Setting when it has none).
	 * @returns The cache entry, or NULL if the pipeline failed (the previously cached data is kept).
	 */
	private async fetchGerritChanges(repo: string, fetchLimit: number): Promise<GerritCacheEntry | null> {
		const config = getConfig().gerrit, generation = this.gerritCacheGeneration;
		const remote = config.remote, gerrit = this.dataSource.gerrit;
		try {
			const changes = limitChanges(await gerrit.listRemoteChanges(repo, remote), fetchLimit);
			if (changes.size === 0 && (await gerrit.listLocalChangeRefs(repo, remote)).length > 0) {
				// ls-remote returned nothing while local change refs exist: the remote is unreachable
				// (a timeout resolves with an empty map). Fail, so the previously cached (or locally
				// rebuilt) Gerrit data keeps being displayed instead of an empty view.
				this.logger.log('Gerrit ls-remote returned no changes while local change refs exist (remote unreachable?), keeping the local Gerrit data.');
				return null;
			}
			const entry: GerritCacheEntry = { states: [], patchsets: new Map(), fetchLimit: fetchLimit };
			if (changes.size > 0) {
				// Resolve the change URL base concurrently with the fetch (it doesn't depend on it)
				const urlBasePromise = gerrit.getChangeUrlBase(repo, remote);
				const fetchError = await gerrit.fetchChanges(repo, remote, buildFetchRefspecs(changes, remote, 'latest'));
				if (fetchError !== null) {
					this.logger.log('Gerrit fetch failed: ' + fetchError);
					return null;
				}
				const pruneError = await gerrit.pruneLocalChanges(repo, remote, Array.from(changes.keys()));
				if (pruneError !== null) this.logger.log('Gerrit ref pruning failed (stale change refs may accumulate): ' + pruneError);

				// Parse the NoteDb meta histories of all changes concurrently: a single Git command
				// resolves every meta ref hash (so unchanged metas are served from the cache), and
				// the remaining histories are parsed by a pool of concurrent Git commands
				const urlBase = await urlBasePromise;
				const statesByChange = await gerrit.parseMetas(repo, remote, Array.from(changes.keys()), urlBase);
				for (const [change, patchsets] of changes) {
					const state = statesByChange.get(change);
					if (state === undefined || state === null) continue; // meta ref not available locally
					entry.states.push(state);
					entry.patchsets.set(change, patchsets);
				}
			}
			// Only cache the result if the fetch settings didn't change while the pipeline was running
			if (generation === this.gerritCacheGeneration) this.gerritCache.set(repo, entry);
			return entry;
		} catch (errorMessage) {
			this.logger.log('Fetching the Gerrit changes failed: ' + errorMessage);
			return null;
		}
	}

	/**
	 * The fetch limit a `loadCommits` request selects the Gerrit changes under: the repository's
	 * own limit from the Repository Settings, or the `gerrit.fetchLimit` Extension Setting when it
	 * has none (NULL). A value from the untrusted webview outside 1..10000 is treated as NULL.
	 */
	private gerritFetchLimitOf(msg: RequestLoadCommits): number {
		const limit = msg.gerritFetchLimit;
		return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 10000 ? limit : getConfig().gerrit.fetchLimit;
	}

	/**
	 * Complete an asynchronous Gerrit load started by a `loadCommits` request that was already
	 * answered with the branch graph (marked `gerritPending`), and send the remaining
	 * `loadCommits` responses once the fresh Gerrit data is available. The update is delivered in
	 * stages, so each part of the view refreshes as soon as its data is ready:
	 *  1. badges: the graph, updated with the change refs of the fresh states, together with the
	 *     light part of the states (everything the badges show) — no event timelines yet;
	 *  2. review information: the full states (with the event timelines), on the now unchanged
	 *     graph — they only reach the review dialog a badge click opens, so they arrive last.
	 * A response is skipped when a newer load request supersedes it (the Git Graph View also
	 * guards this by the refresh id).
	 * @param msg The original `loadCommits` request message.
	 * @param previousRefs The change refs the pending response was rendered with (NULL => none).
	 * @param pendingCommitData The commit data already sent in the pending response.
	 * @returns What the caller's final follow-up must build on: the Gerrit states the last sent
	 *          response carried (NULL when the pipeline failed or was superseded), and the commit
	 *          data of that response — which stage 1 may have reloaded with fresher change refs
	 *          than `pendingCommitData`.
	 */
	private async loadCommitsGerritFollowUp(msg: RequestLoadCommits, previousRefs: string[] | null, pendingCommitData: GitCommitData): Promise<{ states: GerritChangeState[] | null, commitData: GitCommitData }> {
		const gerritData = await this.loadGerritData(msg.repo, msg.gerritStatusFilter, this.gerritFetchLimitOf(msg), msg.hard === true);
		if (this.loadCommitsRefreshId !== msg.refreshId) return { states: null, commitData: pendingCommitData }; // superseded by a newer load request

		if (gerritData === null) {
			// The Gerrit pipeline failed: degrade to the plain view (as before)
			await this.sendGerritLoadStage(msg, null, null, pendingCommitData);
			return { states: null, commitData: pendingCommitData };
		}

		// Stage 1 (badges): the light part of the states — everything the badges render. A change
		// refs list identical to the one already rendered keeps the current graph, skipping the
		// getCommits round-trip (which dominates the load time on large repositories).
		const refsUnchanged = previousRefs !== null && previousRefs.length === gerritData.refs.length && previousRefs.every((ref, i) => ref === gerritData.refs[i]);
		const badgesCommitData = await this.sendGerritLoadStage(
			msg,
			GitGraphView.lightGerritStates(gerritData.states),
			refsUnchanged ? null : gerritData.refs,
			refsUnchanged ? pendingCommitData : null
		);
		if (this.loadCommitsRefreshId !== msg.refreshId) return { states: null, commitData: badgesCommitData }; // superseded by a newer load request

		// Stage 2 (review information): the event timelines arrive last, on the unchanged graph
		await this.sendGerritLoadStage(msg, gerritData.states, null, badgesCommitData);
		return { states: gerritData.states, commitData: badgesCommitData };
	}

	/**
	 * The states without their event timelines: everything the badges show, small enough to ride
	 * along the badge stage without delaying it. The timelines dominate the payload (each event
	 * carries the verbatim NoteDb record) and only the review dialog reads them.
	 */
	private static lightGerritStates(states: GerritChangeState[]): GerritChangeState[] {
		return states.map((state) => ({ ...state, events: [], eventsPending: true }));
	}

	/**
	 * Send one `loadCommits` response of the staged Gerrit follow-up: either the states on their own
	 * (when `commitData` is provided, reusing the already-rendered commit graph), or a full reload
	 * with the given change refs injected into the graph.
	 *
	 * Every load defers the working-tree status scan (it costs seconds on a large working tree, and
	 * no stage of the Gerrit pipeline needs it): the responses are marked `uncommittedPending`, and
	 * the "Uncommitted Changes" row arrives with the final follow-up.
	 * @returns The commit data the response carried (the freshly loaded one, or `commitData`).
	 */
	private async sendGerritLoadStage(msg: RequestLoadCommits, states: GerritChangeState[] | null, refs: string[] | null, commitData: GitCommitData | null): Promise<GitCommitData> {
		const data = commitData !== null ? commitData : await this.getCommitsCached(msg, refs, true, false);
		this.sendMessage({
			command: 'loadCommits',
			refreshId: msg.refreshId,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			gerritStates: states,
			uncommittedPending: true,
			...data
		});
		return data;
	}

	/**
	 * Complete a `loadCommits` request whose first response was sent without the remote-tracking
	 * refs (a `refs/remotes/` scan that dominates the load time on repositories with many of them —
	 * Gerrit ones above all). Loads the complete data and sends a final `loadCommits` response
	 * carrying the remote branch pills, which the view merges into the already-rendered graph in
	 * place. Nothing is sent when the remote annotations did not change (the deferred load raced a
	 * warm cache, or the repository has no remote refs on screen) — the responses are idempotent.
	 * @param msg The original `loadCommits` request message.
	 * @param gerritRefs The Gerrit change refs of the initial response (NULL => Gerrit integration disabled).
	 * @param commitData The commit data already sent in the initial response.
	 * @param gerritStates The Gerrit states already sent in the initial response (resent verbatim,
	 *                    so the remote update never disturbs the rendered badges).
	 * @param deferUncommittedChanges Whether the "Uncommitted Changes" status is still pending (the
	 *                                response then keeps the row rendered with its stale count).
	 * @param forceFresh Bypass the commit cache, exactly as the initial response did (a hard refresh
	 *                    must not serve the follow-up a stale complete entry).
	 * @returns The complete commit data (the freshly loaded one, or `commitData` when nothing changed).
	 */
	private async sendRemoteRefsFollowUp(msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, commitData: GitCommitData, gerritStates: GerritChangeState[] | null, deferUncommittedChanges: boolean, forceFresh: boolean): Promise<GitCommitData> {
		if (!msg.showRemoteBranches || commitData.error !== null) return commitData;
		const complete = await this.getCommitsCached(msg, gerritRefs, deferUncommittedChanges, forceFresh, false);
		if (this.loadCommitsRefreshId !== msg.refreshId) return complete; // superseded by a newer load request

		if (remoteRefsFollowUpChanged(commitData, complete)) {
			this.sendMessage({
				command: 'loadCommits',
				refreshId: msg.refreshId,
				onlyFollowFirstParent: msg.onlyFollowFirstParent,
				gerritStates: gerritStates,
				...(deferUncommittedChanges ? { uncommittedPending: true } : {}),
				...complete
			});
			this.logger.log('Loaded the remote refs of ' + msg.repo + ' in a follow-up response');
		}
		return complete;
	}

	/**
	 * Load the commits of a `loadCommits` request, serving identical requests from the commit cache
	 * instead of re-running Git (see `commitCache`).
	 * @param msg The `loadCommits` request message.
	 * @param gerritRefs The Gerrit change refs allowed into the graph (NULL => Gerrit integration disabled).
	 * @param deferUncommittedChanges Skip computing the "Uncommitted Changes" row in the initial response.
	 * @param forceFresh Bypass the cache (forced refresh) and refresh the cached entry.
	 * @param deferRemoteRefs Skip the remote-tracking refs (see `sendRemoteRefsFollowUp`); a cached
	 *                        complete entry is served instead — deferral only pays when there is
	 *                        nothing complete to serve.
	 * @returns The commits in the repository.
	 */
	private async getCommitsCached(msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, deferUncommittedChanges: boolean, forceFresh: boolean, deferRemoteRefs: boolean = false): Promise<GitCommitData> {
		if (!forceFresh && deferRemoteRefs) {
			const complete = this.commitCache.get(this.commitsCacheKey(msg, gerritRefs, deferUncommittedChanges, false));
			if (complete !== undefined) return complete;
		}
		const key = this.commitsCacheKey(msg, gerritRefs, deferUncommittedChanges, deferRemoteRefs);
		if (!forceFresh) {
			const cached = this.commitCache.get(key);
			if (cached !== undefined) return cached;
		}
		const promise: Promise<GitCommitData> = this.dataSource.getCommits(msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, gerritRefs, false, msg.filterPath === undefined ? null : msg.filterPath, deferUncommittedChanges, deferRemoteRefs).then((commitData) => {
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
	 * The cache key of a `loadCommits` request: everything of the request that changes what Git
	 * returns (the deferral flags included — a deferred response is a strictly smaller answer).
	 */
	private commitsCacheKey(msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, deferUncommittedChanges: boolean, deferRemoteRefs: boolean): string {
		return JSON.stringify([msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, gerritRefs, msg.filterPath === undefined ? null : msg.filterPath, deferUncommittedChanges, deferRemoteRefs]);
	}

	/**
	 * Open this session's log file in an editor tab. The file starts empty on every activation, so
	 * what it shows is always the log of the current editor session.
	 */
	private async openLogFile(): Promise<string | null> {
		const logFile = this.logger.getLogFile();
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

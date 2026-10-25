import * as path from 'path';
import * as vscode from 'vscode';
import type { AvatarManager } from '../../avatarManager';
import { deliverAutomationHostMessage, deliverAutomationShimResult, setLiveGraphView } from '../../automation/graphViewPort';
import { getConfig } from '../../config';
import type { ExtensionState } from '../../extensionState';
import { t } from '../../i18n';
import { TextMessageKey } from '../../shared/i18n';
import type { Logger } from '../../logger';
import { PullRequestDataSource } from '../integrations/pullRequests';
import type { ProductionGitRepository } from '../git/gitRepository';
import type { RepoChangeEvent, RepoManager } from '../repos/repoManager';
import { RepoFileWatcher } from '../repos/repoFileWatcher';
import { TabIconColourTheme } from '../../types';
import type { GitRepoSet, GitGraphViewSnapshot, LoadGitGraphViewTo, RequestLoadView, RequestMessage, ResponseLoadCommits, ResponseMessage } from '../../types';
import { showErrorMessage } from '../../utils/actions';
import { Disposable, toDisposable } from '../../utils/disposable';
import { CommitLoader } from './commitLoader';
import type { LoadViewTicket } from './commitLoader';
import { dispatchRequest, isMutatingCommand } from './handlers/index';
import type { HandlerContext } from './handlers/context';
import { canLoadGraphView, getWebviewConfig, renderGraphViewHtml } from './html';
import { watchForOrphanedTabs as watchOrphanedTabs } from './orphanedTabs';
import type { LegacyViewPort, GitRunnerPort } from './gitRunner';
import { createCommitLoader, createPanelPorts, createViewPort } from './panelContext';
import type { PanelRefreshIds } from './panelContext';
import { BackgroundChangePoller } from './poller';

/** The write-path localizer: the ports speak plain string keys, the i18n table's own keys are what they carry. */
function localizeWriteKey(key: string, ...params: Array<string | number>): string {
	return t(key as TextMessageKey, ...params);
}

/**
 * The Git Graph view panel (REFACTOR-PLAN task 4.4): the lifecycle, serialization restore,
 * orphaned-tab replacement and message routing of the view formerly known as
 * src/gitGraphView.ts's GitGraphView. Every inbound webview message routes through the
 * exhaustive handler table (handlers/index.ts); this class owns the panel itself - the
 * collaborators' ports (panelContext.ts), the staged commit loader (commitLoader.ts), the
 * background poll (poller.ts), the HTML shell (html.ts) - and the view state no handler may
 * touch directly. Its repository access is the `GitRepository` facade of the new git layer
 * (task 3.6); the open path is push-based (task 4.7): the panel begins the merged loadView read
 * when the page is (re)generated and pushes the result when the page reports `ready`.
 */
export class GitGraphView extends Disposable {
	/**
	 * The singleton live view. Automation observes it through the injected GraphViewPort
	 * (src/automation/graphViewPort.ts): the port's live-view reference is published at every
	 * point this singleton panel reference changes, and the message taps live in the port
	 * module — so this class holds no automation state of its own.
	 */
	public static currentPanel: GitGraphView | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionPath: string;
	private readonly repo: ProductionGitRepository;
	private readonly git: GitRunnerPort;
	private readonly extensionState: ExtensionState;
	private readonly repoFileWatcher: RepoFileWatcher;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly loader: CommitLoader;
	private readonly poller: BackgroundChangePoller;
	private readonly ports: ReturnType<typeof createPanelPorts>;
	private readonly viewPort: ReturnType<typeof createViewPort>;
	private readonly pullRequests: PullRequestDataSource = new PullRequestDataSource();
	/** The refresh ids the staged requests record and the regenerated page embeds. */
	private readonly refreshIds: PanelRefreshIds = { loadRepoInfo: 0, loadCommits: 0, loadConfig: 0 };
	/** The merged open-path read in flight for the current page, pushed when the page reports `ready`. */
	private pendingViewLoad: { readonly request: RequestLoadView; readonly ticket: LoadViewTicket } | null = null;

	private isGraphViewLoaded: boolean = false;
	private isPanelVisible: boolean = true;
	private currentRepo: string | null = null;
	private loadViewTo: LoadGitGraphViewTo = null; // Is used by the next call to update, and is then reset to null
	private restoredSnapshot: GitGraphViewSnapshot | null = null; // Is used by the next call to update, and is then reset to null
	private pendingReposEvent: RepoChangeEvent | null = null; // A repo-set change that arrived while the panel was hidden, replayed on the next show

	/**
	 * The interface language of the configuration last delivered to the webview (embedded in the
	 * generated HTML, or sent with a `configChanged` message). A language change is the one
	 * setting a live `configChanged` message cannot apply - every rendered label would have to be
	 * swapped - so it falls back to regenerating the page.
	 */
	private lastSentInterfaceLanguage: string | null = null;

	/** The background change poll interval (see {@link BackgroundChangePoller}). */
	private static readonly BACKGROUND_POLL_INTERVAL_MS = 5000;

	/**
	 * If a Git Graph View already exists, show and update it. Otherwise, create a Git Graph View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param repo The GitRepository facade of the new git layer (reads + writes + operation state).
	 * @param git The raw Git runner over the same process the writer runs on.
	 * @param legacyViews The auxiliary webviews still on the legacy data source (Phase 6 moves them).
	 * @param extensionState The Git Graph ExtensionState instance.
	 * @param avatarManager The Git Graph AvatarManager instance.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param logger The Git Graph Logger instance.
	 * @param loadViewTo What to load the view to.
	 */
	public static createOrShow(extensionPath: string, repo: ProductionGitRepository, git: GitRunnerPort, legacyViews: LegacyViewPort, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo) {
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
			GitGraphView.currentPanel = new GitGraphView(extensionPath, repo, git, legacyViews, extensionState, avatarManager, repoManager, logger, loadViewTo, column);
			setLiveGraphView(GitGraphView.currentPanel);
		}
	}

	/**
	 * Re-attach a Git Graph View to a Webview Panel VS Code revives through the serializer (a
	 * window reload restoring the open Git Graph tab). An Extension Host restart doesn't go
	 * through here: see watchForOrphanedTabs.
	 * @param panel The revived Webview Panel handed over by VS Code.
	 */
	public static restore(panel: vscode.WebviewPanel, extensionPath: string, repo: ProductionGitRepository, git: GitRunnerPort, legacyViews: LegacyViewPort, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger) {
		if (GitGraphView.currentPanel) {
			// A view is already open: a second one can't share the singleton state.
			panel.dispose();
			return;
		}
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))]
		};
		GitGraphView.currentPanel = new GitGraphView(extensionPath, repo, git, legacyViews, extensionState, avatarManager, repoManager, logger, null, panel.viewColumn, panel);
		setLiveGraphView(GitGraphView.currentPanel);
	}

	/**
	 * Replace the Git Graph tabs an Extension Host restart leaves behind (see orphanedTabs.ts,
	 * which holds the logic): a Git Graph tab that is shown while no live view backs it gets a
	 * fresh view opened NEXT to it and only then the dead tab closed.
	 * @returns A disposable that stops watching.
	 */
	public static watchForOrphanedTabs(extensionPath: string, repo: ProductionGitRepository, git: GitRunnerPort, legacyViews: LegacyViewPort, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger): vscode.Disposable {
		return watchOrphanedTabs({
			liveView: () => {
				const view = GitGraphView.currentPanel;
				return view !== undefined ? { visible: view.panelVisible, viewColumn: view.panelViewColumn } : undefined;
			},
			openReplacement: (viewColumn, preserveFocus) => {
				GitGraphView.currentPanel = new GitGraphView(extensionPath, repo, git, legacyViews, extensionState, avatarManager, repoManager, logger, null, { viewColumn: viewColumn, preserveFocus: preserveFocus }, undefined, extensionState.getViewSnapshot());
				setLiveGraphView(GitGraphView.currentPanel);
			},
			logger: logger
		});
	}

	/**
	 * Creates a Git Graph View.
	 * @param loadViewTo What to load the view to.
	 * @param column The column the view should be loaded in.
	 * @param existingPanel A revived Webview Panel to attach to, instead of creating a new one.
	 * @param restoredSnapshot The view state the page should reopen on (see GitGraphViewSnapshot).
	 */
	private constructor(extensionPath: string, repo: ProductionGitRepository, git: GitRunnerPort, legacyViews: LegacyViewPort, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo, column: vscode.ViewColumn | { viewColumn: vscode.ViewColumn, preserveFocus: boolean } | undefined, existingPanel?: vscode.WebviewPanel, restoredSnapshot: GitGraphViewSnapshot | null = null) {
		super();
		this.extensionPath = extensionPath;
		this.repo = repo;
		this.git = git;
		this.extensionState = extensionState;
		this.repoManager = repoManager;
		this.logger = logger;
		this.loadViewTo = loadViewTo;
		this.restoredSnapshot = restoredSnapshot;

		const config = getConfig();
		this.panel = existingPanel || vscode.window.createWebviewPanel('git-graph-rs', 'Git Graph RS', column || vscode.ViewColumn.One, {
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

		this.loader = createCommitLoader(repo, git, logger);
		this.ports = createPanelPorts({
			repo: repo,
			git: git,
			legacyViews: legacyViews,
			extensionState: extensionState,
			avatarManager: avatarManager,
			repoManager: repoManager,
			logger: logger,
			extensionPath: extensionPath,
			pullRequests: this.pullRequests,
			currentRepo: () => this.currentRepo
		});
		// Poll the repository for changes the file watcher may have missed
		this.poller = new BackgroundChangePoller({
			currentRepo: () => this.currentRepo,
			getSignature: (repoPath) => this.repo.read.getRepoChangeSignature(repoPath),
			onRepoChanged: () => {
				this.loader.invalidateCommitCache();
				this.sendMessage({ command: 'refresh' });
			},
			logger: logger
		}, GitGraphView.BACKGROUND_POLL_INTERVAL_MS);
		// Watch for file changes in the repository currently open in the Git Graph View
		this.repoFileWatcher = new RepoFileWatcher(logger, (commitsAffected) => {
			if (commitsAffected) {
				// A ref, HEAD or the Git config changed on disk: any cached commit data is now stale.
				// The invalidation must not depend on visibility: a commit made while the view is a
				// hidden or inactive tab still clears the cache, so the soft refresh of the next
				// show serves fresh data instead of the pre-commit snapshot. The change is handled
				// here, so the poll must also re-record its baseline instead of detecting it again.
				this.loader.repoChangedOnDisk(true);
				this.poller.resetBaseline();
			}
			// A working-tree-only change leaves the commit cache valid: the refresh is served from
			// it in one response, and only the "Uncommitted Changes" count is recomputed. Sent
			// whatever the visibility: a hidden-but-retained page processes it and stays current,
			// while a destroyed page drops it and the next show's soft refresh serves the
			// already-invalidated cache fresh.
			this.sendMessage({ command: 'refresh' });
		}, () => {
			// The repository's Git config changed: drop the cached config data so the next load is fresh
			this.ports.repoConfig.invalidate(this.repoFileWatcher.getRepo());
		});
		this.viewPort = createViewPort({
			loader: this.loader,
			extensionState: extensionState,
			watcher: this.repoFileWatcher,
			poller: this.poller,
			refreshIds: this.refreshIds,
			currentRepo: () => this.currentRepo,
			setCurrentRepo: (repoPath) => { this.currentRepo = repoPath; },
			pushViewLoad: () => { void this.pushViewLoad(); }
		});

		this.registerDisposables(
			// Dispose Git Graph View resources when disposed
			toDisposable(() => {
				GitGraphView.currentPanel = undefined;
				setLiveGraphView(null);
				this.repoFileWatcher.stop();
				this.poller.stop();
				this.loader.dispose();
			}),

			// Dispose this Git Graph View when the Webview Panel is disposed
			this.panel.onDidDispose(() => this.dispose()),

			// Register a callback that is called when the view is shown or hidden
			this.panel.onDidChangeViewState(() => {
				if (this.panel.visible !== this.isPanelVisible) {
					if (this.panel.visible) this.handlePanelShown();
					// Losing visibility tears nothing down. A hidden tab - or one in an inactive
					// editor group, still on screen - is exactly when commits are made from another
					// tab's Source Control or a terminal: the file watcher and the background poll
					// stay armed so those changes still invalidate the commit cache, and the soft
					// refresh above serves the invalidated cache fresh on the next show.
					this.isPanelVisible = this.panel.visible;
				}
			}),

			// Subscribe to events triggered when a repository is added or deleted from Git Graph
			repoManager.onDidChangeRepos((event) => {
				if (!this.panel.visible) {
					// Only the latest event matters (each carries the full repo set): keep it for
					// the handlePanelShown replay on the next show.
					this.pendingReposEvent = event;
					return;
				}
				this.handleReposChange(event);
			}),

			// Subscribe to events triggered when an avatar is available
			this.avatarManagerOnAvatar(avatarManager),

			// Respond to messages sent from the Webview
			this.panel.webview.onDidReceiveMessage((msg) => this.onDidReceiveWebviewMessage(msg)),

			// Dispose the Webview Panel when disposed
			this.panel,

			// Update the Git Graph View when the configuration changes
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('git-graph-rs')) {
					this.handleConfigChanged();
				}
			})
		);

		this.poller.start();

		// Render the content of the Webview (this also begins the open-path read the page
		// receives pushed once it reports `ready`)
		this.update();

		this.logger.log('Created Git Graph View' + (loadViewTo !== null ? ' (active repo: ' + loadViewTo.repo + ')' : ''));
	}

	/** Subscribe to the avatar manager's completion events (a one-liner for the constructor's disposable list). */
	private avatarManagerOnAvatar(avatarManager: AvatarManager) {
		return avatarManager.onAvatar((event) => {
			this.sendMessage({ command: 'fetchAvatar', email: event.email, image: event.image });
		});
	}

	/**
	 * One background-poll tick immediately: the legacy pipeline test (and the automation suite)
	 * drive a tick directly instead of waiting out the multi-second interval.
	 */
	public checkForBackgroundChanges(): Promise<void> {
		return this.poller.check();
	}

	/* ---------- Automation hooks (the automation server is their only consumer) ---------- */

	/** Snapshot of the view state for the automation server (gg.status / gg.query repos). */
	public automationState(): { viewLoaded: boolean; currentRepo: string | null; repos: string[] } {
		return {
			viewLoaded: this.isGraphViewLoaded,
			currentRepo: this.currentRepo,
			repos: Object.keys(this.repoManager.getRepos())
		};
	}

	/** Inject a request as if the webview had sent it (request-mode automation runs). */
	public runAutomationRequest(message: RequestMessage): void {
		void this.respondToMessage(message);
	}

	/**
	 * Release the engine's handle (and cached config) of a repository on the automation server's
	 * behalf. The engine keeps one warm handle per path for the whole session and its pack reads
	 * are memory-mapped, so a repository about to be deleted on disk (the suite runner's fixture
	 * reseed) must let go of the handle first — on Windows an active mapping makes every file it
	 * covers undeletable, which would otherwise fail the reseed's removal with EPERM.
	 */
	public automationCloseRepository(repo: string): void {
		this.repo.read.closeRepository(repo);
	}

	/** Send a page-level message to the automation shim (never a ResponseMessage). */
	public postAutomationMessage(message: unknown): void {
		if (!this.isDisposed()) {
			void this.panel.webview.postMessage(message);
		}
	}

	/** The visibility of the underlying webview panel (read by the orphaned-tab watcher). */
	public get panelVisible(): boolean {
		return this.panel.visible;
	}

	/** The column of the underlying webview panel (read by the orphaned-tab watcher). */
	public get panelViewColumn(): vscode.ViewColumn | undefined {
		return this.panel.viewColumn;
	}

	/* ---------- Message routing ---------- */

	private onDidReceiveWebviewMessage(msg: unknown): void {
		// Results from the in-page automation shim are not RequestMessages: route them to the
		// port (which forwards to the installed listener, if any) and keep them away from the
		// handler table's command guard.
		if (typeof msg === 'object' && msg !== null
			&& (msg as { __ggAutomationResult?: unknown }).__ggAutomationResult !== undefined) {
			deliverAutomationShimResult((msg as { __ggAutomationResult: unknown }).__ggAutomationResult);
			return;
		}
		void this.respondToMessage(msg);
	}

	/**
	 * Respond to a message sent from the front-end: route it through the exhaustive handler
	 * table with the RepoFileWatcher muted, and drop the commit cache afterwards whenever the
	 * command's handler can mutate the repository (the handler's `mutates` flag - the
	 * replacement of the old REPO_MUTATING_COMMANDS set: these commands must invalidate the
	 * cache directly, otherwise the webview's post-action refresh is served pre-action data,
	 * e.g. a stale HEAD after a checkout).
	 * @param msg The message that was received.
	 */
	private async respondToMessage(msg: unknown): Promise<void> {
		const command = typeof msg === 'object' && msg !== null ? (msg as { command?: unknown }).command : undefined;
		const mutates = typeof command === 'string' && isMutatingCommand(command);
		this.repoFileWatcher.mute();
		try {
			const result = await dispatchRequest(msg, this.buildContext());
			if (result === 'unknown') {
				// No handler exists for the command: say so in exactly one log line and surface an
				// error, instead of silently dropping the message (task 4.2). The protocol has no
				// generic error response a host could answer an unknown command with, so the error
				// shows as the localized action-handling notification.
				this.logger.logError('Received an unknown "' + String(command) + '" message from the Git Graph View.');
				showErrorMessage(t('actionHandlingError'));
			}
		} catch (error) {
			this.logger.logError('Failed to handle "' + command + '" message: ' + error);
			showErrorMessage(t('actionHandlingError'));
		} finally {
			this.repoFileWatcher.unmute();
			if (mutates) {
				// The handler ran with the RepoFileWatcher muted, so any repository change it made
				// bypassed the watcher-based cache invalidation. Drop the cached commit data even
				// when the action failed: a partially completed action (e.g. a conflicted merge)
				// may still have moved refs, and the cost of re-running Git once is negligible.
				this.loader.invalidateCommitCache();
			}
		}
	}

	/** The HandlerContext one request runs with: the collaborators' ports and the send function. */
	private buildContext(): HandlerContext {
		const config = getConfig();
		return {
			repo: this.repo,
			git: this.git,
			repoConfig: this.ports.repoConfig,
			gerrit: this.ports.gerrit,
			t: localizeWriteKey,
			config: {
				gerrit: { remote: config.gerrit.remote },
				showRemoteHeads: config.showRemoteHeads,
				squashPullMessageFormat: config.squashPullMessageFormat,
				squashMergeMessageFormat: config.squashMergeMessageFormat
			},
			ui: this.ports.ui,
			loader: this.loader,
			avatars: this.ports.avatars,
			storage: this.ports.storage,
			repos: this.ports.repos,
			userConfig: this.ports.userConfig,
			settings: this.ports.settings,
			pullRequests: this.ports.pullRequests,
			view: this.viewPort,
			send: (msg) => this.sendMessage(msg)
		};
	}

	/* ---------- The open path (task 4.7): begin the merged read, push it on `ready` ---------- */

	/**
	 * Begin the merged loadView read for the repository the CURRENT page will boot on. Called
	 * whenever the page's HTML is (re)generated: the page reports `ready` once its router is
	 * installed, and the panel pushes this completed (or in-flight) result — the webview's boot
	 * sends no loadRepoInfo/loadCommits requests of its own.
	 */
	private beginViewLoad(bootRepo: string | null): void {
		if (bootRepo === null) {
			this.pendingViewLoad = null;
			return;
		}
		const config = getConfig();
		const request: RequestLoadView = {
			command: 'loadView',
			repo: bootRepo,
			refreshId: ++this.refreshIds.loadCommits,
			hard: false,
			branches: null, // Show All: the pushed first page uses the default view options
			authors: null,
			maxCommits: config.initialLoadCommits,
			showTags: config.showTags,
			showRemoteBranches: config.showRemoteBranches,
			includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
			onlyFollowFirstParent: config.onlyFollowFirstParent,
			commitOrdering: config.commitOrder,
			remotes: [],
			hideRemotes: [],
			stashes: [],
			filterPath: this.loadViewTo !== null && typeof this.loadViewTo.filterPath === 'string' ? this.loadViewTo.filterPath : null
		};
		this.pendingViewLoad = { request: request, ticket: this.loader.beginLoadView(request) };
	}

	/** The repository the page about to be rendered will boot on (the webview's own pick, mirrored). */
	private computeBootRepo(loadViewTo: LoadGitGraphViewTo): string | null {
		const repos = this.repoManager.getRepos();
		if (loadViewTo !== null && repos[loadViewTo.repo] !== undefined) return loadViewTo.repo;
		if (this.currentRepo !== null && repos[this.currentRepo] !== undefined) return this.currentRepo;
		const snapshotRepo = typeof (this.restoredSnapshot as { currentRepo?: unknown } | null)?.currentRepo === 'string'
			? (this.restoredSnapshot as { currentRepo: string }).currentRepo
			: null;
		if (snapshotRepo !== null && repos[snapshotRepo] !== undefined) return snapshotRepo;
		const lastActive = this.extensionState.getLastActiveRepo();
		if (lastActive !== null && repos[lastActive] !== undefined) return lastActive;
		const keys = Object.keys(repos);
		return keys.length > 0 ? keys[0] : null;
	}

	/**
	 * Push the merged loadView result to the webview that just reported `ready` (the ViewPort's
	 * handshake): the completed or in-flight read of {@link beginViewLoad}, then its staged
	 * follow-ups (remote refs, the "Uncommitted Changes" row). When nothing is pending (e.g. a
	 * page that regenerated without a known repository), a fresh read begins and pushes instead.
	 */
	private async pushViewLoad(): Promise<void> {
		let pending = this.pendingViewLoad;
		if (pending === null) {
			this.beginViewLoad(this.currentRepo);
			pending = this.pendingViewLoad;
			if (pending === null) return;
		}
		this.pendingViewLoad = null;
		const response = await pending.ticket.promise;
		if (response === null) return; // superseded while in flight: the newer load answers instead
		// The pushed response doubles as the boot's repository switch: the last-active record,
		// the repo file watcher and the poll baseline follow the pushed repository.
		this.viewPort.repoSwitched(response.repo);
		this.sendMessage(response);
		pending.ticket.followUps((commitsResponse: ResponseLoadCommits) => this.sendMessage(commitsResponse));
	}

	/* ---------- Panel state transitions ---------- */

	private handlePanelShown(): void {
		if (this.pendingReposEvent !== null) {
			// A repository was added or removed while the view was hidden: the soft refresh below
			// only reloads the current repo's commits, it never conveys the new (or gone) repo set
			// to the webview — replay the deferred event now that the view is visible again.
			const event = this.pendingReposEvent;
			this.pendingReposEvent = null;
			this.handleReposChange(event);
		} else if (this.isGraphViewLoaded && this.loadViewTo === null) {
			// The webview is already rendered: refresh its data in place instead of regenerating
			// the HTML, which would reload the page and re-render the entire graph from scratch
			// (a blank flash on every tab switch). The webview's soft refresh keeps the rendered
			// commits: the loader's commit cache serves them without rescanning when nothing
			// changed while the view was hidden, and freshly when something did.
			this.sendMessage({ command: 'refresh' });
		} else {
			// The page isn't rendered yet, or a "load view to" request (e.g. Show File History)
			// was made while the panel was hidden: regenerate the page. A loadViewTo stashed for
			// "the next call to update" would otherwise never be consumed here (a soft refresh
			// doesn't apply it), silently dropping the requested repository and path filter.
			this.update();
		}
	}

	private handleConfigChanged(): void {
		const config = getConfig();
		// Cached commit data also depends on settings that aren't part of the cache key (e.g.
		// showCommitsOnlyReferencedByTags, showRemoteHeads): the webview re-requests with an
		// identical key, so drop the cache to avoid serving stale commits; the Gerrit fetch
		// settings (remote, fetch limit) may have changed too, so drop the cached change data
		// so it is re-derived under the new settings.
		this.loader.configChanged();
		this.panel.iconPath = config.tabIconColourTheme === TabIconColourTheme.Colour
			? this.getResourcesUri('git-graph-rs-webview-icon.svg')
			: {
				light: this.getResourcesUri('git-graph-rs-webview-icon-light.svg'),
				dark: this.getResourcesUri('git-graph-rs-webview-icon-dark.svg')
			};
		if (config.interfaceLanguage !== this.lastSentInterfaceLanguage || !this.isGraphViewLoaded || !this.panel.visible) {
			// Regenerate the page: a language change replaces every rendered label (the one
			// setting a live update cannot apply) - and when there is no live page to accept a
			// runtime update (a hidden webview may have been destroyed), regenerating now costs
			// nothing while unseen
			this.update();
		} else {
			// Apply the settings live: the page keeps its rendered commits, scroll position and
			// open Commit Details View
			this.sendMessage({
				command: 'configChanged',
				config: getWebviewConfig(config, this.extensionState.isAvatarStorageAvailable())
			});
			this.lastSentInterfaceLanguage = config.interfaceLanguage;
		}
	}

	/** Apply a repository-set change to the loaded view: reload the page when the change crosses the empty/non-empty boundary, otherwise hand the new repo set to the webview in place. */
	private handleReposChange(event: RepoChangeEvent) {
		const loadViewTo = event.loadRepo !== null ? { repo: event.loadRepo } : null;
		if ((event.numRepos === 0 && this.isGraphViewLoaded) || (event.numRepos > 0 && !this.isGraphViewLoaded)) {
			this.loadViewTo = loadViewTo;
			this.update();
		} else {
			this.respondLoadRepos(event.repos, loadViewTo);
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
			// The automation server's timing tap: observes the exact traffic the webview receives.
			deliverAutomationHostMessage(msg);
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

	/** Update the HTML document loaded in the Webview. */
	private update() {
		const config = getConfig();
		const repos = this.repoManager.getRepos();
		const gitCliAvailable = this.git.hasGit();
		this.isGraphViewLoaded = Object.keys(repos).length > 0 && canLoadGraphView(gitCliAvailable, this.extensionPath);
		this.lastSentInterfaceLanguage = config.interfaceLanguage;
		const loadViewTo = this.loadViewTo;
		this.panel.webview.html = renderGraphViewHtml({
			extensionPath: this.extensionPath,
			cspSource: this.panel.webview.cspSource,
			mediaUri: (file) => this.getMediaUri(file),
			config: config,
			avatarStorageAvailable: this.extensionState.isAvatarStorageAvailable(),
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: loadViewTo,
			repos: repos,
			refreshIds: this.refreshIds,
			restoredSnapshot: this.restoredSnapshot,
			globalState: this.extensionState.getGlobalViewState(),
			workspaceState: this.extensionState.getWorkspaceViewState(),
			gitCliAvailable: gitCliAvailable,
			logger: this.logger
		});
		this.loadViewTo = null;
		this.restoredSnapshot = null;
		// The open path (task 4.7): begin the merged read for the repository this page boots on,
		// so it is (nearly) complete by the time the page reports `ready` and gets pushed.
		this.beginViewLoad(this.computeBootRepo(loadViewTo));
	}


	/* ---------- URI and response helpers ---------- */

	/** Send the known repositories to the front-end. */
	private respondLoadRepos(repos: GitRepoSet, loadViewTo: LoadGitGraphViewTo) {
		this.sendMessage({
			command: 'loadRepos',
			repos: repos,
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: loadViewTo
		});
	}

	/** Get a WebviewUri for a media file included in the extension. */
	private getMediaUri(file: string) {
		return this.panel.webview.asWebviewUri(this.getUri('media', file));
	}

	/** Get a File Uri for a resource file included in the extension. */
	private getResourcesUri(file: string) {
		return this.getUri('resources', file);
	}

	/** Get a File Uri for a file included in the extension. */
	private getUri(...pathComps: string[]) {
		return vscode.Uri.file(path.join(this.extensionPath, ...pathComps));
	}
}

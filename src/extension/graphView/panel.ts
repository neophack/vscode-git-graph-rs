import * as path from 'path';
import * as vscode from 'vscode';
import type { AvatarManager } from '../integrations/avatars/avatarManager';
import { deliverAutomationHostMessage } from '../automation/graphViewPort';
import { resolvedInterfaceLanguage, tabIconColourThemeOf } from '../platform/config';
import type { ExtensionState } from '../platform/storage';
import type { Logger } from '../platform/logger';
import { PullRequestDataSource } from '../integrations/pullRequests';
import type { ProductionGitRepository } from '../git/gitRepository';
import type { RepoChangeEvent, RepoManager } from '../repos/repoManager';
import { RepoFileWatcher } from '../repos/repoFileWatcher';
import { TabIconColourTheme } from '../../shared/model/webview';
import type { GitRepoSet } from '../../shared/model/repoState';
import type { GitGraphViewSnapshot, LoadGitGraphViewTo } from '../../shared/model/webview';
import type { RequestMessage, ResponseMessage } from '../../shared/protocol/messages';
import { mark, MARK } from '../../shared/perf/trace';
import { Disposable, toDisposable } from '../../shared/util/disposable';
import { CommitLoader } from './commitLoader';
import { canLoadGraphView, getWebviewConfig, renderGraphViewHtml } from './html';
import { hostScheduler } from './scheduler';
import type { AuxiliaryViewsPort, GitRunnerPort } from './gitRunner';
import { createCommitLoader, createLoaderReads, createPanelPorts, createViewPort } from './panelContext';
import type { PanelRefreshIds } from './panelContext';
import { createMessageRouter } from './messageRouter';
import type { MessageRouter } from './messageRouter';
import { createViewState } from './viewState';
import type { ViewState } from './viewState';
import type { ExtensionServices } from '../services';
import type { PanelRegistry } from './panelRegistry';
import { BackgroundChangePoller } from './poller';

/**
 * The Git Graph view panel: this class owns the vscode Webview Panel lifecycle (creation, serializer revival, the
 * orphaned-tab replacement of orphanedTabs.ts, disposal) and the wiring of the collaborators:
 * the collaborators' ports (panelContext.ts), the staged commit loader (commitLoader.ts), the
 * background poll (poller.ts), the HTML shell (html.ts), the inbound message routing
 * (messageRouter.ts) and the serialization/restore state (viewState.ts) — plus the view state
 * no other module may touch directly. Its repository access is the `GitRepository` facade of
 * the git layer; the open path is push-based: the panel begins the
 * merged loadView read when the page is (re)generated and pushes the result when the page
 * reports `ready`.
 *
 * The panel is a plain instance: it registers itself with the
 * composition root's {@link PanelRegistry} at every lifecycle point (creation, revival,
 * orphaned-tab replacement, disposal) and publishes its activity transitions there, instead of
 * a static singleton field that any module could read.
 */

/** The per-instance options of one GitGraphView construction (the three lifecycle entries fold into these). */
export interface GitGraphViewOptions {
	/** What to load the view to. */
	readonly loadViewTo: LoadGitGraphViewTo;
	/** The column the view should be loaded in (or the column+focus of an orphan replacement). */
	readonly column?: vscode.ViewColumn | { readonly viewColumn: vscode.ViewColumn; readonly preserveFocus: boolean };
	/** A revived Webview Panel to attach to, instead of creating a new one. */
	readonly existingPanel?: vscode.WebviewPanel;
	/** The view state the page should reopen on (see GitGraphViewSnapshot). */
	readonly restoredSnapshot?: GitGraphViewSnapshot | null;
}

/**
 * The column a newly opened view loads in: the active text editor's column, or undefined when
 * no editor is open. Lives on the panel module because it is the one vscode runtime read the
 * registry (which must stay vscode-free) needs for `open()`.
 */
export function activeEditorColumn(): vscode.ViewColumn | undefined {
	return vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
}

/**
 * Register the Git Graph webview panel serializer (a window reload restoring the open Git
 * Graph tab). The registry owns the restore; the module only owns the vscode registration —
 * `awaitReady` is the background Git resolution (V1), so a restored panel's first render cannot
 * mistake an unvalidated Git for "no Git".
 */
export function registerPanelSerializer(awaitReady: () => Promise<unknown>, restore: (panel: vscode.WebviewPanel) => void): vscode.Disposable {
	return vscode.window.registerWebviewPanelSerializer('git-graph-rs', {
		deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
			await awaitReady();
			restore(panel);
		}
	});
}

export class GitGraphView extends Disposable {
	private readonly services: ExtensionServices;
	private readonly panels: PanelRegistry;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionPath: string;
	private readonly repo: ProductionGitRepository;
	private readonly git: GitRunnerPort;
	private readonly auxViews: AuxiliaryViewsPort;
	private readonly extensionState: ExtensionState;
	private readonly repoFileWatcher: RepoFileWatcher;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly loader: CommitLoader;
	private readonly poller: BackgroundChangePoller;
	private readonly ports: ReturnType<typeof createPanelPorts>;
	private readonly viewPort: ReturnType<typeof createViewPort>;
	private readonly pullRequests: PullRequestDataSource = new PullRequestDataSource();
	/** The inbound message routing and dispatch (messageRouter.ts). */
	private readonly messageRouter: MessageRouter;
	/** The serialization/restore state of the rendered page (viewState.ts). */
	private readonly viewState: ViewState;
	/** The refresh ids the staged requests record and the regenerated page embeds. */
	private readonly refreshIds: PanelRefreshIds = { loadRepoInfo: 0, loadCommits: 0, loadConfig: 0 };

	private isGraphViewLoaded: boolean = false;
	private isPanelVisible: boolean = true;
	private currentRepo: string | null = null;
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
	 * Whether the page has finished loading (the registry's busy signal and activity read this).
	 */
	public get viewLoaded(): boolean {
		return this.isGraphViewLoaded;
	}

	/** The repository the view currently shows (NULL when none). */
	public get shownRepo(): string | null {
		return this.currentRepo;
	}

	/**
	 * Creates a Git Graph View. Only the {@link PanelRegistry} constructs it — it owns the
	 * singleton lifecycle; this constructor only assembles one instance.
	 * @param services The extension services (the git layer and the collaborators).
	 * @param panels The panel registry this view publishes itself to.
	 * @param options What to load the view to, where to load it, and any revived panel/snapshot.
	 */
	public constructor(services: ExtensionServices, panels: PanelRegistry, options: GitGraphViewOptions) {
		super();
		this.services = services;
		this.panels = panels;
		this.extensionPath = services.context.extensionPath;
		this.repo = services.repo;
		this.git = services.git;
		this.auxViews = services.auxViews;
		this.extensionState = services.state;
		this.repoManager = services.repos;
		this.logger = services.logger;

		const config = services.config.current;
		if (options.existingPanel !== undefined) {
			// A revived panel re-uses VS Code's Webview Panel; only the resource roots must be
			// (re)declared before its first render - the former `restore` static set these.
			options.existingPanel.webview.options = {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, 'media'))]
			};
			this.panel = options.existingPanel;
		} else {
			this.panel = vscode.window.createWebviewPanel('git-graph-rs', 'Git Graph RS', options.column ?? vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, 'media'))],
				retainContextWhenHidden: config.retainContextWhenHidden
			});
		}
		this.panel.iconPath = tabIconColourThemeOf(config) === TabIconColourTheme.Colour
			? this.getResourcesUri('git-graph-rs-webview-icon.svg')
			: {
				light: this.getResourcesUri('git-graph-rs-webview-icon-light.svg'),
				dark: this.getResourcesUri('git-graph-rs-webview-icon-dark.svg')
			};
		// T1 (P1): the panel exists - the boot trace the view command began at T0 continues here
		// (a restored or orphan-replaced panel has no T0 and opens a session trace instead).
		mark(MARK.panelCreated);
		const loaderReads = createLoaderReads(this.repo, services.config);
		this.loader = createCommitLoader(this.repo, this.git, this.logger, services.config, loaderReads);
		this.ports = createPanelPorts({
			repo: this.repo,
			git: this.git,
			auxViews: this.auxViews,
			extensionState: this.extensionState,
			avatarManager: this.services.avatars,
			repoManager: this.repoManager,
			logger: this.logger,
			extensionPath: this.extensionPath,
			config: services.config,
			pullRequests: this.pullRequests,
			currentRepo: () => this.currentRepo
		});
		// Poll the repository for changes the file watcher may have missed. The signature read
		// runs as a background job of the host scheduler: it yields to interactive
		// requests instead of competing with them.
		this.poller = new BackgroundChangePoller({
			currentRepo: () => this.currentRepo,
			getSignature: (repoPath) => hostScheduler.run('poll:' + repoPath, 'background', () => this.repo.read.getRepoChangeSignature(repoPath)),
			onRepoChanged: () => {
				this.loader.invalidateCommitCache();
				this.sendMessage({ command: 'refresh' });
			},
			logger: this.logger
		}, GitGraphView.BACKGROUND_POLL_INTERVAL_MS);
		// Watch for file changes in the repository currently open in the Git Graph View
		this.repoFileWatcher = new RepoFileWatcher(this.logger, (commitsAffected) => {
			this.logger.log('The repo file watcher reported a change of ' + this.repoFileWatcher.getRepo() + ' (commits affected: ' + commitsAffected + ')');
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
			extensionState: this.extensionState,
			watcher: this.repoFileWatcher,
			poller: this.poller,
			refreshIds: this.refreshIds,
			currentRepo: () => this.currentRepo,
			setCurrentRepo: (repoPath) => {
				this.currentRepo = repoPath;
				this.noteActivity();
			},
			pushViewLoad: () => { void this.viewState.pushViewLoad(); }
		});
		this.viewState = createViewState({
			config: services.config,
			loader: this.loader,
			viewPort: this.viewPort,
			extensionState: this.extensionState,
			repoManager: this.repoManager,
			refreshIds: this.refreshIds,
			currentRepo: () => this.currentRepo,
			send: (msg) => this.sendMessage(msg),
			initialLoadViewTo: options.loadViewTo,
			initialSnapshot: options.restoredSnapshot ?? null
		});
		this.messageRouter = createMessageRouter({
			repo: this.repo,
			git: this.git,
			config: services.config,
			ports: this.ports,
			viewPort: this.viewPort,
			loader: this.loader,
			loaderReads: loaderReads,
			refreshIds: this.refreshIds,
			watcher: this.repoFileWatcher,
			logger: this.logger,
			currentRepo: () => this.currentRepo,
			send: (msg) => this.sendMessage(msg)
		});

		this.registerDisposables(
			// The write-path impact collection, created with the router: the GitWriter
			// reports the effects of every op that ran while a request was being dispatched into it.
			this.messageRouter.effectCollection,

			// Dispose Git Graph View resources when disposed
			toDisposable(() => {
				// The registry drops the view (and the automation port's live reference with it)
				this.panels.detach(this);
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
			this.repoManager.onDidChangeRepos((event) => {
				if (!this.panel.visible) {
					// Only the latest event matters (each carries the full repo set): keep it for
					// the handlePanelShown replay on the next show.
					this.pendingReposEvent = event;
					return;
				}
				this.handleReposChange(event);
			}),

			// Subscribe to events triggered when an avatar is available
			this.avatarManagerOnAvatar(this.services.avatars),

			// Respond to messages sent from the Webview
			this.panel.webview.onDidReceiveMessage((msg) => this.messageRouter.onWebviewMessage(msg)),

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

		this.logger.log('Created Git Graph View' + (options.loadViewTo !== null ? ' (active repo: ' + options.loadViewTo.repo + ')' : ''));
	}

	/** Subscribe to the avatar manager's completion events (a one-liner for the constructor's disposable list). */
	private avatarManagerOnAvatar(avatarManager: AvatarManager) {
		return avatarManager.onAvatar((event) => {
			this.sendMessage({ command: 'fetchAvatar', email: event.email, image: event.image });
		});
	}

	/** Publish the view's activity to the registry (the page loaded, or the shown repository changed). */
	private noteActivity(): void {
		this.panels.noteActivity(this);
	}

	/** Reveal the panel in an editor group (the registry's `open` on an already-live view). */
	public reveal(column: vscode.ViewColumn | undefined): void {
		this.panel.reveal(column);
	}

	/** Stash a "load view to" request for the view's next render (the registry's `open` on a hidden view). */
	public stashLoadViewTo(loadViewTo: LoadGitGraphViewTo): void {
		this.viewState.setLoadViewTo(loadViewTo);
	}

	/**
	 * One background-poll tick immediately: the integration pipeline test (and the automation
	 * suite) drive a tick directly instead of waiting out the multi-second interval.
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
		void this.messageRouter.dispatch(message);
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

	/* ---------- Panel state transitions ---------- */

	private handlePanelShown(): void {
		if (this.pendingReposEvent !== null) {
			// A repository was added or removed while the view was hidden: the soft refresh below
			// only reloads the current repo's commits, it never conveys the new (or gone) repo set
			// to the webview — replay the deferred event now that the view is visible again.
			const event = this.pendingReposEvent;
			this.pendingReposEvent = null;
			this.handleReposChange(event);
		} else if (this.isGraphViewLoaded && this.viewState.loadViewTo === null) {
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
		const config = this.services.config.current;
		const interfaceLanguage = resolvedInterfaceLanguage(config.interfaceLanguage, vscode.env.language);
		// Cached commit data also depends on settings that aren't part of the cache key (e.g.
		// showCommitsOnlyReferencedByTags, showRemoteHeads): the webview re-requests with an
		// identical key, so drop the cache to avoid serving stale commits; the Gerrit fetch
		// settings (remote, fetch limit) may have changed too, so drop the cached change data
		// so it is re-derived under the new settings.
		this.loader.configChanged();
		this.panel.iconPath = tabIconColourThemeOf(config) === TabIconColourTheme.Colour
			? this.getResourcesUri('git-graph-rs-webview-icon.svg')
			: {
				light: this.getResourcesUri('git-graph-rs-webview-icon-light.svg'),
				dark: this.getResourcesUri('git-graph-rs-webview-icon-dark.svg')
			};
		if (interfaceLanguage !== this.lastSentInterfaceLanguage || !this.isGraphViewLoaded || !this.panel.visible) {
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
				config: getWebviewConfig(config, vscode.env.language, this.extensionState.isAvatarStorageAvailable())
			});
			this.lastSentInterfaceLanguage = interfaceLanguage;
		}
	}

	/** Apply a repository-set change to the loaded view: reload the page when the change crosses the empty/non-empty boundary, otherwise hand the new repo set to the webview in place. */
	private handleReposChange(event: RepoChangeEvent) {
		const loadViewTo = event.loadRepo !== null ? { repo: event.loadRepo } : null;
		if ((event.numRepos === 0 && this.isGraphViewLoaded) || (event.numRepos > 0 && !this.isGraphViewLoaded)) {
			this.viewState.setLoadViewTo(loadViewTo);
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
		const config = this.services.config.current;
		const repos = this.repoManager.getRepos();
		const gitCliAvailable = this.git.hasGit();
		this.isGraphViewLoaded = Object.keys(repos).length > 0 && canLoadGraphView(gitCliAvailable, this.extensionPath);
		this.lastSentInterfaceLanguage = resolvedInterfaceLanguage(config.interfaceLanguage, vscode.env.language);
		const loadViewTo = this.viewState.loadViewTo;
		this.panel.webview.html = renderGraphViewHtml({
			extensionPath: this.extensionPath,
			cspSource: this.panel.webview.cspSource,
			mediaUri: (file) => this.getMediaUri(file),
			config: getWebviewConfig(config, vscode.env.language, this.extensionState.isAvatarStorageAvailable()),
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: loadViewTo,
			repos: repos,
			refreshIds: this.refreshIds,
			restoredSnapshot: this.viewState.restoredSnapshot,
			globalState: this.extensionState.getGlobalViewState(),
			workspaceState: this.extensionState.getWorkspaceViewState(),
			gitCliAvailable: gitCliAvailable,
			logger: this.logger
		});
		// Consume the rendered page's one-shot state and begin the open-path read for the
		// repository it boots on.
		this.viewState.pageRendered(loadViewTo);
		// The page's loaded state (and, through the pushed read, the shown repository) changed:
		// publish the new activity to the registry.
		this.noteActivity();
	}

	/* ---------- URI and response helpers ---------- */

	/** Send the known repositories to the front-end (the registry's `open` on a visible view). */
	public respondLoadRepos(repos: GitRepoSet, loadViewTo: LoadGitGraphViewTo) {
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

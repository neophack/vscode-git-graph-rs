/**
 * Loading the data of the view: the repositories, the current repository's refs (loadRepoInfo),
 * commits (loadCommits) and configuration (loadConfig), the refresh cycle that sequences them,
 * the requests that bring in avatars and pull requests, and applying a changed Extension
 * Configuration to the running view.
 *
 * This is the FACADE of the load pipeline: the lifecycle runs through
 * the explicit state machine (`loadMachine.ts`, driven by `loadController.ts`) — every lifecycle
 * event dispatches, and a response applies only in a state that expects it, keyed by its request
 * id; anything else is dropped and logged. The side effects live in the sibling modules
 * (`loadRequests`, `loadErrors`, `followUps`, `repoInfoApply`, `commitPage`, `configApply`,
 * `pinnedJump`); what remains here are the event SOURCES — the public API the router, the
 * control bar and the view observers call. A refresh runs `loadRepoInfo` → `loadCommits`
 * (→ `loadConfig`); the staged delivery (remote refs, Gerrit, "Uncommitted Changes") answers one
 * request with several responses sharing the cycle's refresh id, which the machine tracks.
 */

import { alterClass } from '../../common/dom';
import { formatStr, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { getSortedRepositoryPaths } from '../../common/util';
import { GraphContext } from '../context';
import { configFingerprint, decodeFirstPaintSnapshot } from '../state/firstPaint';
import { WebViewState } from '../state/types';
import { CommitPage } from './commitPage';
import { ConfigApplier } from './configApply';
import { FollowUps } from './followUps';
import { LoadController } from './loadController';
import { noteRefreshCycle } from './loadDiagnostics';
import { LoadErrors } from './loadErrors';
import { LoadRequests } from './loadRequests';
import { PinnedCommitJump } from './pinnedJump';
import { RepoInfoApplier } from './repoInfoApply';

export class RepoLoader {
	/** TRUE between the boot adopting its repository and the `awaitPush` dispatch: the boot's repository switch must not start a request chain — the data is already in flight on the host side and arrives pushed. */
	private bootPushExpected: boolean = false;

	private readonly requests: LoadRequests;
	private readonly followUps: FollowUps;
	private readonly repoInfo: RepoInfoApplier;
	private readonly commitPage: CommitPage;
	private readonly jump: PinnedCommitJump;
	private readonly configApplier: ConfigApplier;
	private readonly controller: LoadController;

	constructor(private readonly ctx: () => GraphContext) {
		this.requests = new LoadRequests(ctx);
		this.followUps = new FollowUps(ctx, () => this.requestLoadRepoInfoAndCommits(false, true));
		this.repoInfo = new RepoInfoApplier(ctx);
		const refreshCommitsOnly = () => this.requestLoadRepoInfoAndCommits(false, true);
		const loadMore = () => this.loadMoreCommits();
		this.jump = new PinnedCommitJump(ctx, { requests: this.requests, refreshCommitsOnly: refreshCommitsOnly, loadMore: loadMore });
		this.commitPage = new CommitPage(ctx, {
			repoInfo: this.repoInfo,
			followUps: this.followUps,
			jump: this.jump,
			refreshCommitsOnly: refreshCommitsOnly,
			completeLoad: (didLoadRepoData) => this.controller.finaliseLoad(didLoadRepoData)
		});
		this.configApplier = new ConfigApplier(ctx, (hard) => this.refresh(hard));
		this.controller = new LoadController(ctx, {
			requests: this.requests,
			errors: new LoadErrors(ctx, () => this.refresh(true)),
			commitPage: this.commitPage,
			repoInfo: this.repoInfo,
			followUps: this.followUps,
			refreshCommitsOnly: refreshCommitsOnly,
			loadMore: loadMore
		});
	}


	/* Start-up */

	/**
	 * Load the first repository: restore what a webview reload keeps (the previous repository and
	 * its scroll position), and wait for the pushed data.
	 *
	 * The open path is push-based: the extension host began the merged
	 * `loadView` read when the panel was created and pushes the result as soon as the page
	 * reports `ready` — which main.ts sends once this loader is composed. The boot sends NO
	 * loadRepoInfo/loadCommits requests; the loading state shows until the push arrives - unless
	 * the first-paint snapshot already put the previous session's rows on screen.
	 * @param prevState The state VS Code persisted for this webview (or the snapshot of a page left behind by an Extension Host restart).
	 * @param lastActiveRepo The repository that was last active.
	 * @param initialLoadViewTo Where the extension asked the view to load to.
	 */
	public start(prevState: WebViewState | null, lastActiveRepo: string | null, initialLoadViewTo: GG.LoadGitGraphViewTo) {
		const ctx = this.ctx(), store = ctx.store;
		let loadViewTo = initialLoadViewTo;
		if (loadViewTo === null && prevState && typeof prevState.currentRepo !== 'undefined') {
			// Reload the previously open repository after a webview reload, re-applying its path filter
			loadViewTo = prevState.commitPathFilter !== null && prevState.commitPathFilter !== undefined
				? { repo: prevState.currentRepo, filterPath: prevState.commitPathFilter }
				: { repo: prevState.currentRepo };
			// Restore the scroll position after the repository's commits have been rendered (the view
			// is still empty at this point, so scrolling immediately would be clamped to 0)
			store.slices.ui.setScrollTop(prevState.scrollTop);
			ctx.viewport.restoreScrollTop = prevState.scrollTop;
		}

		this.bootPushExpected = true;
		this.loadRepos(store.repos, lastActiveRepo, loadViewTo);
		store.slices.repos.beginCycle(false, false);
		this.awaitBootPush();

		const snapshotPainted = this.paintFirstPaintSnapshot(prevState);
		if (store.commits.length === 0 && !snapshotPainted) {
			ctx.table.showLoadingSkeleton();
		}

		if (prevState && prevState.compareSourceHash !== null && prevState.compareSourceHash !== undefined
			&& prevState.currentRepo === store.currentRepo) {
			// Restore the "Select for Compare" selection after a webview reload, so it survives
			// switching away from the panel and back (loadRepo clears it when the repo changes)
			store.slices.ui.setCompareSourceHash(prevState.compareSourceHash);
			ctx.persistence.saveState();
		}
	}

	/**
	 * Check the boot's first-paint snapshot and, when it is paintable, hand it to the machine: the previous session's rows go on screen IMMEDIATELY,
	 * marked "refreshing" (`snapshotPainted`), and the pushed `loadView` data reconciles them when
	 * it lands. The snapshot is skipped unless it is decodable, belongs to the repository being
	 * opened, and was rendered under the configuration this page booted with; HEAD cannot be
	 * checked before the data arrives, so it travels with the snapshot and the reconciliation is
	 * what replaces rows under a moved HEAD.
	 * @returns TRUE when the snapshot painted.
	 */
	private paintFirstPaintSnapshot(prevState: WebViewState | null): boolean {
		const ctx = this.ctx(), store = ctx.store;
		if (prevState == null || !store.config.snapshotFirstPaint) return false; // absent state arrives as undefined, not null
		const snapshot = decodeFirstPaintSnapshot(prevState.firstPaint);
		if (snapshot === null) return false; // absent, corrupt, or a foreign snapshot version
		if (snapshot.repo !== store.currentRepo) return false; // another repository's rows
		if (snapshot.configFingerprint !== configFingerprint(store.config)) return false; // another configuration's rendering

		this.controller.snapshotArrived(snapshot, prevState.gitBranchHead);
		return this.controller.loadState.type === 'snapshotPainted';
	}

	/** The boot adopted its repository (once): the host's pushed `loadView` is expected. */
	private awaitBootPush(): void {
		if (!this.bootPushExpected) return;
		this.bootPushExpected = false;
		this.controller.awaitPush(this.ctx().store.currentRepo);
	}


	/* Loading Data */

	/**
	 * Set the repositories of the view and load one of them (a `loadRepos` response).
	 * @returns TRUE => a repository switch was started (it requests the data itself), FALSE => the caller must request the data.
	 */
	public loadRepos(repos: GG.GitRepoSet, lastActiveRepo: string | null, loadViewTo: GG.LoadGitGraphViewTo) {
		const ctx = this.ctx(), store = ctx.store;
		store.slices.repos.setRepos(repos);
		ctx.persistence.saveState();

		let newRepo: string;
		if (loadViewTo !== null && store.currentRepo !== loadViewTo.repo && typeof repos[loadViewTo.repo] !== 'undefined') {
			newRepo = loadViewTo.repo;
		} else if (typeof repos[store.currentRepo] === 'undefined') {
			newRepo = lastActiveRepo !== null && typeof repos[lastActiveRepo] !== 'undefined'
				? lastActiveRepo
				: getSortedRepositoryPaths(repos, store.config.repoDropdownOrder)[0];
		} else {
			newRepo = store.currentRepo;
		}

		alterClass(ctx.dom.controls, 'singleRepo', Object.keys(repos).length === 1);
		ctx.controls.renderRepoDropdownOptions(newRepo);

		if (loadViewTo !== null) {
			if (loadViewTo.repo === newRepo) {
				store.slices.repos.setLoadViewTo(loadViewTo);
			} else {
				store.slices.repos.setLoadViewTo(null);
				ctx.bridge.send({ command: 'showErrorMessage', message: formatStr(strings.unableToLoadRepo, loadViewTo.repo) });
			}
		} else {
			store.slices.repos.setLoadViewTo(null);
		}

		let filterChanged = false;
		if (loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.filterPath === 'string') {
			// Apply the file path filter the view was requested to be loaded with
			const newFilter = loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null;
			filterChanged = newFilter !== store.commitPathFilter;
		}

		if (store.currentRepo !== newRepo) {			this.loadRepo(newRepo);
			// loadRepo resets the path filter, so re-apply it before the commits are requested
			if (loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.filterPath === 'string') {
				store.slices.refs.setPathFilter(loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null);
				ctx.controls.renderFilterButton();
			}
			return true;
		} else if (filterChanged) {
			// The repository is already loaded, but the path filter changed: reload the commits.
			// (Unreachable at boot — no repository is set, so the switch above always runs —
			// and start's awaitBootPush covers the push expectation regardless.)
			store.slices.refs.setPathFilter(loadViewTo !== null && typeof loadViewTo.filterPath === 'string' && loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null);
			ctx.controls.renderFilterButton();
			ctx.dom.view.scrollTop = 0;
			this.refresh(false);
			return false;
		} else {
			this.controller.finaliseLoad(false);
			return false;
		}
	}

	/** Switch the view to a repository. */
	public loadRepo(repo: string) {
		const ctx = this.ctx(), store = ctx.store;
		// Only a switch between known repositories closes the widgets: on the very first load
		// (no repository yet) the settings widget holds the state restored for this webview
		// reload — closing it here would undo that restore before the first paint, making the
		// persisted settings-widget state dead.
		const switchingRepo = store.hasCurrentRepo() && store.currentRepo !== repo;
		store.slices.repos.switchTo(repo);
		// A repository switch/reload wants its own start position (the webview-reload path restores
		// via restoreScrollTop): a pre-collapse anchor belonging to the previous repository must
		// not leak into the first render of the new one
		ctx.viewport.pendingViewportAnchor = null;
		ctx.controls.syncShowRemoteBranches();
		store.slices.commits.setMaxCommits(store.config.initialLoadCommits);
		store.slices.refs.reset();
		store.slices.ui.setCompareSourceHash(null);
		// The pull requests of the previous repository don't apply to the new one: drop them and
		// forget which repositories were already requested, so switching back re-requests them
		// (otherwise the badges would never come back after the switch cleared them)
		store.slices.integrations.resetPullRequests();
		this.followUps.forgetAllPullRequestsRequests();
		ctx.controls.renderFetchButton();
		ctx.controls.renderFilterButton();
		ctx.details.close(false);
		if (switchingRepo) ctx.widgets.settings.close();
		ctx.widgets.reflog.close();
		ctx.widgets.worktree.close();
		ctx.widgets.statistics.close();
		ctx.persistence.saveState();
		// The switch dispatches `openRepo` — valid from EVERY machine state (a switch mid-load
		// restarts under the new repository; a switch to the same repository is a reload) — its
		// effects clear the view and issue the repo-info request, the same shape a hard refresh
		// takes. The boot's own adoption expects the pushed data instead.
		if (this.bootPushExpected) {
			this.bootPushExpected = false;
			this.controller.awaitPush(repo);
			return;
		}
		// The cycle flags the responses still read start fresh with the switch (`beginCycle`
		// sets the hard kind, and no repo-info change note or pending config reload carries
		// over)
		store.slices.repos.beginCycle(true, false);
		this.controller.openRepo(repo);
	}

	/** Empty the view of the current repository's commits (before they are reloaded). */
	public clearCommits() {
		// A user-driven view clear during the boot wait abandons the expected push (the machine's
		// `cancel`): the hard reload that always follows this call must not be refused as
		// pushPending. A painted snapshot's rows go with it (the cancel's clearView effect).
		const state = this.controller.loadState;
		if (state.type === 'awaitingPush' || state.type === 'snapshotPainted') {
			this.controller.cancel(state.repo);
		}
		this.commitPage.clearView();
	}

	/**
	 * Apply a change of the Gerrit status filter (the Repository Settings checkboxes): the badges
	 * re-render immediately and the commit graph reloads in the background (debounced).
	 */
	public applyGerritFilterChange() {
		this.followUps.applyGerritFilterChange();
	}


	/* Responses (acceptance is the machine's; these are the router's entry points) */

	/**
	 * The pushed merged view of the open path: the repo info and the first commit page
	 * in one message, followed by the same staged follow-ups the partial responses carry.
	 */
	public processLoadView(msg: GG.ResponseLoadView) {
		this.bootPushExpected = false;
		this.controller.processLoadView(msg);
	}

	public processLoadRepoInfoResponse(msg: GG.ResponseLoadRepoInfo) {
		this.controller.processLoadRepoInfoResponse(msg);
	}

	public processLoadCommitsResponse(msg: GG.ResponseLoadCommits) {
		this.controller.processLoadCommitsResponse(msg);
	}

	public processLoadConfig(msg: GG.ResponseLoadConfig) {
		this.requests.processLoadConfig(msg);
	}

	/** Request the repository's configuration (and show the settings widget as loading). */
	public requestLoadConfig() {
		this.requests.requestLoadConfig();
	}

	public processPullRequestStatus(msg: GG.ResponsePullRequestStatus) {
		this.followUps.processPullRequestStatus(msg);
	}

	/** Drop the record that the pull requests of a repository were requested, so the next load requests them again. */
	public forgetPullRequestsRequest(repo: string) {
		this.followUps.forgetPullRequestsRequest(repo);
	}

	/** Set the avatar of an author (an author avatar response), updating the rows already rendered. */
	public loadAvatar(email: string, image: string) {
		this.followUps.loadAvatar(email, image);
	}

	public jumpToUnloadedCommit(hash: string) {
		this.jump.jumpToUnloadedCommit(hash);
	}

	/**
	 * Handle the response of a countCommitsBefore request (made when jumping to a pinned commit
	 * that is not in the view): load enough commits to include it in a single request.
	 */
	public processCountCommitsBefore(msg: GG.ResponseCountCommitsBefore) {
		this.jump.processCountCommitsBefore(msg);
	}


	/* Refresh */

	/**
	 * Apply a changed Extension Configuration to the running view (a `configChanged` message):
	 * everything the generated HTML would have baked in is re-applied in place, then the commits
	 * are reloaded with a soft refresh - the page keeps its rendered content, scroll position and
	 * open Commit Details View instead of being regenerated (which flashed the whole view).
	 */
	public applyConfig(config: GG.GitGraphViewConfig) {
		this.configApplier.apply(config);
	}

	/**
	 * Refresh the view.
	 * @param hard TRUE => clear the commits first (the view shows its loading state), FALSE => keep the rendered commits until the new ones arrive. (The clear is the machine's `clearView` effect now.)
	 * @param configChanges Also reload the repository's configuration.
	 */
	public refresh(hard: boolean, configChanges: boolean = false) {
		// The truthful refresh counter the E2E diagnostics read (see loadDiagnostics): every
		// cycle start — the host's `refresh` push included — is observable from a page step.
		noteRefreshCycle();
		this.requestLoadRepoInfoAndCommits(hard, false, configChanges);
	}

	/** Load more commits (the footer button, auto-load when scrolled to the end, a jump to an unloaded commit). */
	public loadMoreCommits() {
		const ctx = this.ctx(), store = ctx.store;
		ctx.table.setFooterLoading();
		store.slices.commits.setMaxCommits(store.maxCommits + store.config.loadMoreCommits);
		ctx.persistence.saveState();
		this.requestLoadRepoInfoAndCommits(false, true);
	}

	/**
	 * Start (or join) the refresh cycle: request the repository info and then the commits, or just
	 * the commits. The machine decides the cycle (a join replaces the ids the new requests carry,
	 * keeping an in-flight repo-info half valid); the join flags the responses still read
	 * (the hard kind, the config reload) merge into the running cycle.
	 * @param hard Clear the view's commits (the loading state is shown) for this refresh.
	 * @param skipRepoInfo Only request the commits (the repository info is unchanged).
	 * @param configChanges Also reload the repository's configuration once the commits are loaded.
	 */
	public requestLoadRepoInfoAndCommits(hard: boolean, skipRepoInfo: boolean, configChanges: boolean = false) {
		const store = this.ctx().store;
		const state = this.controller.loadState;
		const joining = state.type === 'loading' || state.type === 'refreshing';
		if (joining) {
			store.slices.repos.joinCycle(hard, configChanges);
		} else {
			store.slices.repos.beginCycle(hard, configChanges);
		}
		this.controller.refreshRequested(store.currentRepo, hard, skipRepoInfo);
	}
}

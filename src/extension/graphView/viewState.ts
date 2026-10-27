import { commitOrderingOf } from '../platform/config';
import type { ConfigProvider } from '../platform/config';
import type { ExtensionState } from '../platform/storage';
import type { RepoManager } from '../repos/repoManager';
import type { GitGraphViewSnapshot, LoadGitGraphViewTo } from '../../shared/model/webview';
import type { RequestLoadView, ResponseLoadCommits } from '../../shared/protocol/loading';
import type { ResponseMessage } from '../../shared/protocol/messages';
import { mark, MARK } from '../../shared/perf/trace';
import type { CommitLoader, LoadViewTicket } from './commitLoader';
import type { ViewPort } from './handlers/context';
import type { PanelRefreshIds } from './panelContext';

/**
 * The ViewState of the Git Graph view (OPTIMIZATION-PLAN A5, extracted from GitGraphView): the
 * serialization/restore state one rendered page consumes — the "load view to" request stashed for
 * the next render (the registry's `open` on a hidden view, a repo-set change), the snapshot a
 * serializer revival or an orphaned-tab replacement reopens on, and the merged open-path read
 * (task 4.7) the panel begins whenever the page's HTML is (re)generated and pushes once the page
 * reports `ready`. The panel (panel.ts) owns the page and hands each rendered page's one-shot
 * state to this module.
 */

/** The collaborators the view state coordinates, injected by the Panel. */
export interface ViewStateDeps {
	/** The configuration service (the open-path request is built from the latest snapshot). */
	readonly config: ConfigProvider;
	/** The staged commit loader: the merged open-path read runs as one of its loadView tickets. */
	readonly loader: CommitLoader;
	/** The Panel's view-state hooks (the pushed response switches the repository through them). */
	readonly viewPort: ViewPort;
	/** The persisted extension state (the last-active repository of the boot pick). */
	readonly extensionState: ExtensionState;
	/** The repository registry (the known repositories of the boot pick). */
	readonly repoManager: RepoManager;
	/** The refresh ids the regenerated page embeds, owned by the Panel. */
	readonly refreshIds: PanelRefreshIds;
	/** The repository the view currently shows (the boot pick's fallback, the push's fallback read). */
	currentRepo(): string | null;
	/** The Panel's single exit point to the webview. */
	send(msg: ResponseMessage): void;
	/** What to load the view to (the constructor's options). */
	readonly initialLoadViewTo: LoadGitGraphViewTo;
	/** The view state the page should reopen on (a serializer revival or orphan replacement). */
	readonly initialSnapshot: GitGraphViewSnapshot | null;
}

/** The view state the Panel reads and consumes through. */
export interface ViewState {
	/** The "load view to" request stashed for the view's next render (NULL when none is stashed). */
	readonly loadViewTo: LoadGitGraphViewTo;
	/** Stash a "load view to" request for the view's next render. */
	setLoadViewTo(loadViewTo: LoadGitGraphViewTo): void;
	/** The snapshot the next render reopens on (NULL when none was restored or it was consumed). */
	readonly restoredSnapshot: GitGraphViewSnapshot | null;
	/**
	 * Consume the one-shot state of the page just rendered and begin the merged open-path read
	 * for the repository that page boots on.
	 */
	pageRendered(loadViewTo: LoadGitGraphViewTo): void;
	/**
	 * Push the merged loadView result to the webview that just reported `ready` (the ViewPort's
	 * handshake).
	 */
	pushViewLoad(): Promise<void>;
}

/**
 * Assemble the view state. The one-shot fields are consumed by {@link ViewState.pageRendered}
 * exactly as the panel's former inline reads were.
 */
export function createViewState(deps: ViewStateDeps): ViewState {
	let loadViewTo: LoadGitGraphViewTo = deps.initialLoadViewTo; // Is used by the next call to pageRendered, and is then reset to null
	let restoredSnapshot: GitGraphViewSnapshot | null = deps.initialSnapshot; // Is used by the next call to pageRendered, and is then reset to null
	/** The merged open-path read in flight for the current page, pushed when the page reports `ready`. */
	let pendingViewLoad: { readonly request: RequestLoadView; readonly ticket: LoadViewTicket } | null = null;

	/**
	 * Begin the merged loadView read for the repository the CURRENT page will boot on. Called
	 * whenever the page's HTML is (re)generated: the page reports `ready` once its router is
	 * installed, and the panel pushes this completed (or in-flight) result — the webview's boot
	 * sends no loadRepoInfo/loadCommits requests of its own.
	 */
	const beginViewLoad = (bootRepo: string | null): void => {
		if (bootRepo === null) {
			pendingViewLoad = null;
			return;
		}
		const config = deps.config.current;
		const request: RequestLoadView = {
			command: 'loadView',
			repo: bootRepo,
			refreshId: ++deps.refreshIds.loadCommits,
			hard: false,
			branches: null, // Show All: the pushed first page uses the default view options
			authors: null,
			maxCommits: config.repositoryCommitsInitialLoad,
			showTags: config.repositoryShowTags,
			showRemoteBranches: config.repositoryShowRemoteBranches,
			includeCommitsMentionedByReflogs: config.repositoryIncludeCommitsMentionedByReflogs,
			onlyFollowFirstParent: config.repositoryOnlyFollowFirstParent,
			commitOrdering: commitOrderingOf(config),
			remotes: [],
			hideRemotes: [],
			stashes: [],
			filterPath: loadViewTo !== null && typeof loadViewTo.filterPath === 'string' ? loadViewTo.filterPath : null
		};
		pendingViewLoad = { request: request, ticket: deps.loader.beginLoadView(request) };
	};

	/** The repository the page about to be rendered will boot on (the webview's own pick, mirrored). */
	const computeBootRepo = (loadViewTo: LoadGitGraphViewTo): string | null => {
		const repos = deps.repoManager.getRepos();
		if (loadViewTo !== null && repos[loadViewTo.repo] !== undefined) return loadViewTo.repo;
		const currentRepo = deps.currentRepo();
		if (currentRepo !== null && repos[currentRepo] !== undefined) return currentRepo;
		const snapshotRepo = typeof (restoredSnapshot as { currentRepo?: unknown } | null)?.currentRepo === 'string'
			? (restoredSnapshot as { currentRepo: string }).currentRepo
			: null;
		if (snapshotRepo !== null && repos[snapshotRepo] !== undefined) return snapshotRepo;
		const lastActive = deps.extensionState.getLastActiveRepo();
		if (lastActive !== null && repos[lastActive] !== undefined) return lastActive;
		const keys = Object.keys(repos);
		return keys.length > 0 ? keys[0] : null;
	};

	/**
	 * Push the merged loadView result to the webview that just reported `ready` (the ViewPort's
	 * handshake): the completed or in-flight read of `beginViewLoad`, then its staged follow-ups
	 * (remote refs, the "Uncommitted Changes" row). When nothing is pending (e.g. a page that
	 * regenerated without a known repository), a fresh read begins and pushes instead.
	 */
	const pushViewLoad = async (): Promise<void> => {
		let pending = pendingViewLoad;
		if (pending === null) {
			beginViewLoad(deps.currentRepo());
			pending = pendingViewLoad;
			if (pending === null) return;
		}
		pendingViewLoad = null;
		const response = await pending.ticket.promise;
		if (response === null) return; // superseded while in flight: the newer load answers instead
		// The pushed response doubles as the boot's repository switch: the last-active record,
		// the repo file watcher and the poll baseline follow the pushed repository.
		deps.viewPort.repoSwitched(response.repo);
		// T3 (P1): the boot's data is ready and is about to be posted to the page.
		mark(MARK.hostDataReady);
		deps.send(response);
		pending.ticket.followUps((commitsResponse: ResponseLoadCommits) => deps.send(commitsResponse));
	};

	return {
		get loadViewTo() { return loadViewTo; },
		setLoadViewTo: (next: LoadGitGraphViewTo) => { loadViewTo = next; },
		get restoredSnapshot() { return restoredSnapshot; },
		pageRendered: (renderedTo: LoadGitGraphViewTo) => {
			loadViewTo = null;
			restoredSnapshot = null;
			// The open path (task 4.7): begin the merged read for the repository this page boots on,
			// so it is (nearly) complete by the time the page reports `ready` and gets pushed.
			beginViewLoad(computeBootRepo(renderedTo));
		},
		pushViewLoad: pushViewLoad
	};
}

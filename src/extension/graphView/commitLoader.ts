import type { AbortLike } from '../git/process/gitProcess';
import type { GitCommitData, RefReadOptions } from '../git/read/types';
import type {
	CommitOrdering, ErrorInfo, GerritChangeState, GitCommit, GitOperationState, GitStash, RequestLoadCommits, RequestLoadView, ResponseLoadCommits, ResponseLoadView
} from '../../types';
import { CommitPageCache, commitPageCacheKey } from './caches/commitPageCache';
import type { GerritCacheEntry } from './caches/gerritCache';
import { GerritCacheStore } from './caches/gerritCache';
import { remoteRefsFollowUpChanged } from './followUpChange';
import { GerritPipeline } from './gerritPipeline';
import type { CommitLoaderPort } from './handlers/context';

/**
 * The staged commit loading pipeline of the graph view (REFACTOR-PLAN task 4.3), extracted from
 * GitGraphView's `loadCommits` case and its follow-up methods (src/gitGraphView.ts). Every data
 * read is injected through {@link CommitDataPort} / {@link GerritDataPort}, so the pipeline is
 * pure TypeScript: no 'vscode', no Git - unit tests drive it with fakes.
 *
 * The pipeline answers one `loadCommits` request with SEVERAL responses, in stages:
 *  1. the first page (deferred remote refs while the view is empty; the Gerrit data that is
 *     already cached when the integration is enabled - marked `gerritPending` when a fresh fetch
 *     is still running);
 *  2. the remote-tracking refs follow-up (the complete ref scan);
 *  3. the Gerrit stages, badges first then the event timelines;
 *  4. the "Uncommitted Changes" row last (a `git status` that can cost seconds on a large tree).
 *
 * A new loadCommits call ABORTS the previous run (an AbortController per run; the cooperative
 * `run.signal.aborted` checks between stages replace the live code's refresh-id comparisons),
 * and every follow-up error is caught and answered with an error response - the live pipeline's
 * `void followUp().then(...)` chains left a rejecting read as an unhandled rejection, which is
 * exactly what this module fixes.
 *
 * COEXISTENCE: the live GitGraphView keeps its own inline pipeline until the Panel cutover
 * (task 4.4) replaces the `loadCommits` case of src/gitGraphView.ts, its `commitCache` /
 * `gerritCache*` fields and its follow-up methods with this loader. Until then nothing in the
 * production path instantiates this class.
 */

/** The configuration values the pipeline reads at load time (a subset of GitGraphViewConfig; task 4.5 folds this into the ConfigSnapshot). */
export interface CommitLoaderConfig {
	readonly showUncommittedChanges: boolean;
	readonly gerrit: {
		readonly remote: string;
		readonly fetchLimit: number;
	};
}

/** One commit-page read: the parameters the live `dataSource.getCommits` receives, as an object. */
export interface CommitLoadQuery {
	readonly branches: ReadonlyArray<string> | null;
	readonly authors: ReadonlyArray<string> | null;
	readonly maxCommits: number;
	readonly showTags: boolean;
	readonly showRemoteBranches: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly commitOrdering: CommitOrdering;
	readonly remotes: ReadonlyArray<string>;
	readonly hideRemotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly gerritRefs: ReadonlyArray<string> | null;
	readonly filterPath: string | null;
	readonly deferUncommittedChanges: boolean;
	readonly deferRemoteRefs: boolean;
}

/** The repository reads the pipeline needs, injected so unit tests run without Git. */
export interface CommitDataPort {
	/** A page of the graph; the optional signal cancels a superseded walk (task 4.8's seam). */
	getCommits(repo: string, query: CommitLoadQuery, signal?: AbortLike): Promise<GitCommitData>;
	getUncommittedChanges(repo: string): Promise<number>;
	/** The repository info the merged open-path response carries (the loadRepoInfo half). */
	getRepoInfo(repo: string, options: RefReadOptions): Promise<RepoInfoHalf>;
	/** The in-progress operation state the merged open-path response carries. */
	getOperationState(repo: string): Promise<GitOperationState>;
}

/** The repo-info half of a merged loadView response (the loadRepoInfo response fields, minus its envelope). */
export interface RepoInfoHalf {
	readonly branches: ReadonlyArray<string>;
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly tags: ReadonlyArray<string>;
	readonly error: ErrorInfo;
	readonly isRepo: boolean;
	readonly remoteRefsPending?: boolean;
	readonly operationState: GitOperationState;
}

/** The Gerrit reads the pipeline needs (the surface of GerritDataSource it uses), injected. */
export interface GerritDataPort {
	listRemoteChanges(repo: string, remote: string): Promise<Map<number, number[]>>;
	fetchChanges(repo: string, remote: string, refspecs: ReadonlyArray<string>): Promise<ErrorInfo>;
	listLocalChangeRefs(repo: string, remote: string): Promise<string[]>;
	pruneLocalChanges(repo: string, remote: string, keepChanges: ReadonlyArray<number>): Promise<ErrorInfo>;
	parseMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<Map<number, GerritChangeState | null>>;
	getChangeUrlBase(repo: string, remote: string): Promise<string | null>;
}

/** The pipeline's log sink (the production instance is the extension Logger). */
export interface CommitLoaderLogger {
	log(message: string): void;
	logError(message: string): void;
}

/**
 * One began merged open-path read (task 4.7): the promise settles with the merged response (NULL
 * once a newer load of the repository superseded it — the caller pushes nothing), and the
 * follow-up launcher runs the staged remote-refs / uncommitted-changes responses once the
 * response was actually pushed to a webview.
 */
export interface LoadViewTicket {
	readonly promise: Promise<ResponseLoadView | null>;
	followUps(send: (response: ResponseLoadCommits) => void): void;
}

/** The configuration values the merged open-path read consults (a subset of GitGraphViewConfig). */
interface LoaderConfig extends CommitLoaderConfig {
	readonly showRemoteHeads: boolean;
}

/** The decision for one reading of the repository's uncommitted-change count. */
export type UncommittedReading =
	| { readonly send: number } // deliver this count to the view now
	| { readonly recheckAfterMs: number }; // deliver nothing yet: read the count again after this delay

/**
 * Gates the "Uncommitted Changes" count delivered to the webview (the row must never vanish on a
 * momentary reading). The production instance is `UncommittedCountStabiliser`
 * (uncommittedStabiliser.ts); the pipeline depends only on this structural shape.
 */
export interface UncommittedStabiliser {
	observe(count: number | null, now: number): UncommittedReading;
	delivered(count: number): void;
	reset(): void;
}

/** Every effect the pipeline touches, injected. */
export interface CommitLoaderDeps {
	readonly reads: CommitDataPort;
	readonly gerrit: GerritDataPort;
	readonly getConfig: () => LoaderConfig;
	readonly logger: CommitLoaderLogger;
	/**
	 * The "Uncommitted Changes ({0})" row message (the live pipeline calls
	 * `t('uncommittedChangesRow', n)`; importing i18n would drag the vscode-dependent config
	 * module into this file, so the string arrives injected).
	 */
	readonly formatUncommittedRow: (count: number) => string;
	/** Gates the delivered uncommitted count; the Panel passes a `new UncommittedCountStabiliser(zeroConfirmMs, recheckMs)` built from the same constants below. */
	readonly stabiliser: UncommittedStabiliser;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	/** The confirm window the zero-confirmation re-reads are bounded by (GitGraphView's 5000/1000 constants). */
	readonly uncommittedZeroConfirmMs?: number;
	readonly uncommittedRecheckMs?: number;
	/** The commit-page cache bound (GitGraphView's COMMIT_CACHE_LIMIT). */
	readonly commitCacheLimit?: number;
}

/**
 * The staged commit loading pipeline, implementing the port the handler table's `loadCommits`
 * handler delegates to (see handlers/context.ts). All methods are safe to call from handlers;
 * the `configChanged` / `repoChangedOnDisk` / `viewRepoChanged` / `dispose` surface is driven by
 * the Panel (task 4.4) in place of the live invalidation sites listed in their doc comments.
 */
export class CommitLoader implements CommitLoaderPort {
	/**
	 * The synthetic hash of the "Uncommitted Changes" row. Duplicated from src/utils/git.ts's
	 * UNCOMMITTED ('*') because importing that module would transitively require the
	 * vscode-dependent i18n module - the price of a vscode-free pipeline.
	 */
	private static readonly UNCOMMITTED_HASH = '*';
	private static readonly DEFAULT_COMMIT_CACHE_LIMIT = 32;
	private static readonly DEFAULT_UNCOMMITTED_ZERO_CONFIRM_MS = 5000;
	private static readonly DEFAULT_UNCOMMITTED_RECHECK_MS = 1000;

	private readonly commitCache: CommitPageCache;
	private readonly gerritStore: GerritCacheStore;
	private readonly gerritPipeline: GerritPipeline;
	private readonly uncommittedZeroConfirmMs: number;
	private readonly uncommittedRecheckMs: number;
	/** The run of the CURRENT loadCommits request; a new request aborts it (see the header). */
	private currentRun: AbortController | null = null;
	/**
	 * The in-flight read of each repository, keyed by repo path: a newer load of the same kind
	 * (loadCommits or the merged loadView) cancels the older one's in-flight engine walk through
	 * its signal — the cooperative cancellation seam of the read backend (task 2.9/4.8).
	 */
	private readonly activeLoads: Map<string, AbortController> = new Map();
	private disposed = false;
	/**
	 * Whether the webview is currently RENDERING a commit list (set once a `loadCommits` response
	 * with commits has been sent, reset when the view switches repository - see
	 * {@link viewRepoChanged}). The remote-tracking refs are deferred only while this is FALSE: a
	 * stripped intermediate response is a win when the view is empty, but on a refresh of an
	 * already-rendered view the remote branch pills would visibly vanish until the follow-up
	 * restored them, so every refresh would flicker. Exposed as a getter: the loadRepoInfo
	 * handler reads the same state for its own remote-refs deferral (the single source of truth
	 * the live GitGraphView field was).
	 */
	private renderingCommits = false;

	/** Whether the view currently renders a commit list (see {@link renderingCommits}). */
	public get viewHasCommits(): boolean {
		return this.renderingCommits;
	}

	constructor(private readonly deps: CommitLoaderDeps) {
		this.commitCache = new CommitPageCache(deps.commitCacheLimit ?? CommitLoader.DEFAULT_COMMIT_CACHE_LIMIT);
		this.gerritStore = new GerritCacheStore();
		this.gerritPipeline = new GerritPipeline({ gerrit: deps.gerrit, getConfig: deps.getConfig, logger: deps.logger }, this.gerritStore);
		this.uncommittedZeroConfirmMs = deps.uncommittedZeroConfirmMs ?? CommitLoader.DEFAULT_UNCOMMITTED_ZERO_CONFIRM_MS;
		this.uncommittedRecheckMs = deps.uncommittedRecheckMs ?? CommitLoader.DEFAULT_UNCOMMITTED_RECHECK_MS;
	}

	/* ---------- CommitLoaderPort: the surface the handler table consumes ---------- */

	/**
	 * Serve a loadCommits request: send the initial response as soon as the branch graph is
	 * ready, then the follow-up responses (remote refs, the Gerrit stages, the uncommitted-changes
	 * row) through the same send function as they complete. Resolves once the INITIAL response is
	 * sent; the follow-ups run detached.
	 */
	public async loadCommits(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void> {
		if (this.disposed) return;
		// A new request supersedes the previous one: abort its remaining follow-ups AND cancel its
		// in-flight engine walk (a superseded page's result is never rendered, so its backend work
		// is pure waste). Every stage below cooperatively checks `run.signal.aborted` before
		// sending (the live pipeline compared `loadCommitsRefreshId !== msg.refreshId` instead; the
		// signal is the same rule plus disposal, and it also covers a re-sent request id).
		this.abortCurrentRun();
		this.cancelActiveLoad(msg.repo);
		const run = new AbortController();
		this.currentRun = run;
		this.activeLoads.set(msg.repo, run);

		const startTime = this.deps.now();
		// Remote-tracking refs dominate the ref scan on repositories with many of them, so the
		// first response is sent WITHOUT them while the view is empty (see `viewHasCommits`); the
		// complete ref set follows asynchronously in `sendRemoteRefsFollowUp`.
		const deferRemoteRefs = msg.showRemoteBranches && !this.renderingCommits;
		try {
			if (!msg.gerritFetchRefs) {
				// Gerrit integration disabled for this repository: load the commits without Gerrit data
				const commitData = await this.getCommitsCached(msg, null, true, msg.hard, deferRemoteRefs);
				if (run.signal.aborted) return;
				send({ command: 'loadCommits', refreshId: msg.refreshId, onlyFollowFirstParent: msg.onlyFollowFirstParent, gerritStates: null, uncommittedPending: true, ...commitData });
				this.noteViewHasCommits(commitData);
				this.deps.logger.log('Loaded ' + commitData.commits.length + ' commits in ' + (this.deps.now() - startTime) + ' ms');
				this.launchFollowUps(msg, run, send, async () => {
					const complete = await this.sendRemoteRefsFollowUp(msg, run, send, null, commitData, null, true, msg.hard);
					await this.sendUncommittedChangesFollowUp(msg, run, send, complete);
				});
			} else if (this.gerritStore.has(msg.repo) && msg.hard !== true && !this.gerritStore.isStale(msg.repo)
				&& this.gerritStore.get(msg.repo)!.fetchLimit === this.gerritFetchLimitOf(msg)) {
				// The Gerrit data is already cached (under the requested fetch limit): serve it instantly from the cache
				const page = await this.loadGerritPage(msg, this.gerritStore.get(msg.repo)!, null, null, deferRemoteRefs);
				if (run.signal.aborted) return;
				send({ command: 'loadCommits', refreshId: msg.refreshId, onlyFollowFirstParent: msg.onlyFollowFirstParent, gerritStates: page.states, uncommittedPending: true, ...page.commitData });
				this.noteViewHasCommits(page.commitData);
				this.deps.logger.log('Loaded ' + page.commitData.commits.length + ' commits in ' + (this.deps.now() - startTime) + ' ms');
				this.launchFollowUps(msg, run, send, async () => {
					// Quirk kept from the live pipeline: the uncommitted follow-up carries the states of
					// the INITIAL page, never anything a follow-up reloaded
					const complete = await this.sendRemoteRefsFollowUp(msg, run, send, page.refs, page.commitData, page.states, true, msg.hard);
					await this.sendUncommittedChangesFollowUp(msg, run, send, complete, page.states);
				});
			} else {
				// No fresh Gerrit data (the extension just started, the repository was marked stale,
				// or a hard refresh was requested): render the branch graph IMMEDIATELY with the
				// stale Gerrit data (if any) - the first paint must never wait for the Gerrit
				// pipeline nor for the working-tree status scan. The response is marked
				// `gerritPending`; the pipeline completes asynchronously in stages: the remote refs,
				// then the Gerrit badges, then the review timelines, and the uncommitted row last.
				const staleCache = this.gerritStore.get(msg.repo) || null;
				const stalePage = staleCache !== null ? await this.loadGerritPage(msg, staleCache, null, null, deferRemoteRefs) : null;
				if (run.signal.aborted) return;
				const staleRefs = stalePage !== null ? stalePage.refs : null;
				const staleStates = stalePage !== null ? stalePage.states : null;
				const commitData = stalePage !== null ? stalePage.commitData : await this.getCommitsCached(msg, null, true, msg.hard, deferRemoteRefs);
				if (run.signal.aborted) return;
				send({ command: 'loadCommits', refreshId: msg.refreshId, onlyFollowFirstParent: msg.onlyFollowFirstParent, gerritPending: true, gerritStates: staleStates, uncommittedPending: true, ...commitData });
				this.noteViewHasCommits(commitData);
				this.launchFollowUps(msg, run, send, async () => {
					const complete = await this.sendRemoteRefsFollowUp(msg, run, send, staleRefs, commitData, staleStates, true, msg.hard);
					const result = await this.loadCommitsGerritFollowUp(msg, run, send, staleRefs, complete);
					await this.sendUncommittedChangesFollowUp(msg, run, send, result.commitData, result.states);
				});
			}
		} catch (error) {
			if (run.signal.aborted) return;
			this.sendLoadError(msg, send, error);
		}
	}

	/* ---------- The merged open path (task 4.7) ---------- */

	/**
	 * Begin the merged open-path read of a repository: the repo info and the first commit page in
	 * one answer, served while the webview is still booting. The panel calls this at creation,
	 * keeps the ticket, and PUSHES the completed (or in-flight) result when the page reports
	 * `ready` — the open path costs the webview zero loadRepoInfo/loadCommits round trips.
	 *
	 * The read registers under the same per-repository cancellation as `loadCommits`: a newer
	 * load of the same repository cancels this one's in-flight walk.
	 * @returns The ticket whose promise settles with the merged response (NULL once superseded —
	 *          the caller must not push a stale view), and the launcher of the staged follow-ups
	 *          (remote refs, the "Uncommitted Changes" row), which the caller starts only once the
	 *          response was actually pushed.
	 */
	public beginLoadView(msg: RequestLoadView): LoadViewTicket {
		if (this.disposed) {
			return { promise: Promise.resolve(null), followUps: () => undefined };
		}
		// The follow-up machinery is typed against RequestLoadCommits; the merged request carries
		// the same commit-page options (the Gerrit integration is not part of the open path).
		const commitsMsg: RequestLoadCommits = {
			command: 'loadCommits',
			repo: msg.repo,
			refreshId: msg.refreshId,
			hard: msg.hard,
			branches: msg.branches,
			authors: msg.authors,
			maxCommits: msg.maxCommits,
			showTags: msg.showTags,
			showRemoteBranches: msg.showRemoteBranches,
			includeCommitsMentionedByReflogs: msg.includeCommitsMentionedByReflogs,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			commitOrdering: msg.commitOrdering,
			remotes: msg.remotes,
			hideRemotes: msg.hideRemotes,
			stashes: msg.stashes,
			gerritFetchRefs: false,
			gerritFetchLimit: null,
			gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true },
			filterPath: msg.filterPath === undefined ? null : msg.filterPath
		};
		this.abortCurrentRun();
		this.cancelActiveLoad(msg.repo);
		const run = new AbortController();
		this.currentRun = run;
		this.activeLoads.set(msg.repo, run);
		const deferRemoteRefs = msg.showRemoteBranches && !this.renderingCommits;
		const startTime = this.deps.now();
		let page: GitCommitData | null = null;
		const promise = (async (): Promise<ResponseLoadView | null> => {
			page = await this.getCommitsCached(commitsMsg, null, true, msg.hard, deferRemoteRefs);
			if (run.signal.aborted) return null; // superseded: the newer load owns the view
			const repoInfo = await this.deps.reads.getRepoInfo(msg.repo, {
				showRemoteBranches: msg.showRemoteBranches && !deferRemoteRefs,
				showRemoteHeads: this.deps.getConfig().showRemoteHeads,
				hideRemotes: msg.hideRemotes,
				showChangeRefs: false,
				showStashes: true
			});
			if (run.signal.aborted) return null;
			if (page === null) return null;
			this.deps.logger.log('Loaded the view of ' + msg.repo + ' (' + page.commits.length + ' commits) in ' + (this.deps.now() - startTime) + ' ms');
			const merged: ResponseLoadView = {
				command: 'loadView',
				repo: msg.repo,
				refreshId: msg.refreshId,
				repoInfo: repoInfo,
				commits: {
					commits: page.commits,
					head: page.head,
					tags: page.tags,
					moreCommitsAvailable: page.moreCommitsAvailable,
					onlyFollowFirstParent: msg.onlyFollowFirstParent,
					gerritStates: null, // the Gerrit pipeline is not part of the merged open path
					uncommittedPending: true,
					branches: page.branches ?? null,
					error: page.error
				}
			};
			return merged;
		})().catch((error: unknown) => {
			if (run.signal.aborted) return null;
			this.deps.logger.logError('Failed to load the view of ' + msg.repo + ': ' + String(error));
			const message = error instanceof Error ? error.message : String(error);
			const failed: ResponseLoadView = {
				command: 'loadView',
				repo: msg.repo,
				refreshId: msg.refreshId,
				repoInfo: {
					branches: [], head: null, remotes: [], stashes: [],
					error: message, isRepo: false,
					operationState: { type: null, conflictedFiles: [], progress: null }
				},
				commits: {
					commits: [], head: null, tags: [], moreCommitsAvailable: false,
					onlyFollowFirstParent: msg.onlyFollowFirstParent,
					gerritStates: null, error: message
				}
			};
			return failed;
		});
		const followUps = (send: (response: ResponseLoadCommits) => void) => {
			if (run.signal.aborted || page === null) return;
			this.launchFollowUps(commitsMsg, run, send, async () => {
				const complete = await this.sendRemoteRefsFollowUp(commitsMsg, run, send, null, page as GitCommitData, null, true, msg.hard);
				await this.sendUncommittedChangesFollowUp(commitsMsg, run, send, complete);
			});
		};
		return { promise: promise, followUps: followUps };
	}

	/**
	 * Serve a `loadView` request: begin the merged read and push its response through `send`,
	 * then run the staged follow-ups. (The open path itself goes through `beginLoadView` + the
	 * panel's `ready` push; this entry answers an explicit request, e.g. an automation replay.)
	 */
	public async loadView(msg: RequestLoadView, send: (response: ResponseLoadView | ResponseLoadCommits) => void): Promise<void> {
		const ticket = this.beginLoadView(msg);
		const response = await ticket.promise;
		if (response === null) return; // superseded by a newer load: it answers instead
		send(response);
		ticket.followUps(send);
	}

	/** Mark the repository's cached Gerrit data stale: a fetch may have updated its change refs. */
	public markGerritStale(repo: string): void {
		this.gerritStore.markStale(repo);
	}

	/** Drop the stale flag (the repository's Gerrit change refs were just deleted). */
	public unmarkGerritStale(repo: string): void {
		this.gerritStore.unmarkStale(repo);
	}

	/** Drop every cached Gerrit datum of the repository (its change refs are gone). */
	public clearGerritCache(repo: string): void {
		this.gerritStore.delete(repo);
	}

	/** Drop the cached commit pages of every repository (a repo-mutating command finished). */
	public invalidateCommitCache(): void {
		this.commitCache.clear();
	}

	/* ---------- Panel-driven invalidation (the sites task 4.4's cutover wires) ---------- */

	/**
	 * The git-graph-rs configuration changed (GitGraphView's onDidChangeConfiguration): cached
	 * commit data also depends on settings outside the cache key (e.g.
	 * showCommitsOnlyReferencedByTags, showRemoteHeads), and the Gerrit fetch settings may have
	 * changed.
	 */
	public configChanged(): void {
		this.commitCache.clear();
		this.gerritStore.clearAll();
	}

	/**
	 * The repository changed on disk (the RepoFileWatcher callback): a ref, HEAD or the Git
	 * config change makes every cached page stale; a working-tree-only change leaves them valid.
	 */
	public repoChangedOnDisk(commitsAffected: boolean): void {
		if (commitsAffected) this.commitCache.clear();
	}

	/**
	 * The view switched to a different repository (the loadRepoInfo handler's repo-switch block):
	 * the uncommitted count of the previous repository says nothing about this one, and the view
	 * starts empty, so the remote-refs deferral applies again until its first page is rendered.
	 */
	public viewRepoChanged(): void {
		this.renderingCommits = false;
		this.deps.stabiliser.reset();
	}

	/** Stop the loader: cancels every in-flight read, aborts the current run's follow-ups and refuses further loads. */
	public dispose(): void {
		this.disposed = true;
		this.abortCurrentRun();
		for (const load of this.activeLoads.values()) load.abort();
		this.activeLoads.clear();
	}

	/* ---------- Follow-up plumbing ---------- */

	/**
	 * Run the follow-up chain detached from the initial response, catching every error: a
	 * rejecting follow-up read is answered with an error response (so the view is never left
	 * hanging), never left as an unhandled rejection - the fix task 4.3 exists for.
	 */
	private launchFollowUps(msg: RequestLoadCommits, run: AbortController, send: (response: ResponseLoadCommits) => void, chain: () => Promise<void>): void {
		void chain().catch((error) => {
			if (run.signal.aborted) return; // superseded: the newer request owns the view
			this.sendLoadError(msg, send, error);
		});
	}

	/** Answer a request whose pipeline failed with a loadCommits error response, and log it. */
	private sendLoadError(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void, error: unknown): void {
		this.deps.logger.logError('Failed to load the commits of ' + msg.repo + ': ' + error);
		send({
			command: 'loadCommits',
			refreshId: msg.refreshId,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			gerritStates: null,
			commits: [],
			head: null,
			tags: [],
			moreCommitsAvailable: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	private noteViewHasCommits(commitData: GitCommitData): void {
		if (commitData.commits.length > 0) this.renderingCommits = true;
	}

	private abortCurrentRun(): void {
		if (this.currentRun !== null) {
			this.currentRun.abort();
			this.currentRun = null;
		}
	}

	/**
	 * Cancel the repository's in-flight read (the same-kind new request invalidates the old one):
	 * the read backend's walk receives the abort through its signal and stops (the engine cancels
	 * the request by id; the CLI kills the child process).
	 */
	private cancelActiveLoad(repo: string): void {
		const previous = this.activeLoads.get(repo);
		if (previous !== undefined) {
			this.activeLoads.delete(repo);
			previous.abort();
		}
	}

	/**
	 * Complete a `loadCommits` request whose first response was sent without the remote-tracking
	 * refs (a `refs/remotes/` scan that dominates the load time on repositories with many of
	 * them). Loads the complete data and sends a final response carrying the remote branch pills,
	 * which the view merges into the already-rendered graph in place. Nothing is sent when the
	 * remote annotations did not change (the responses are idempotent) - `remoteRefsFollowUpChanged`
	 * decides, catching the cases a plain remotes-label diff missed (see its doc comment).
	 */
	private async sendRemoteRefsFollowUp(msg: RequestLoadCommits, run: AbortController, send: (response: ResponseLoadCommits) => void, gerritRefs: ReadonlyArray<string> | null, commitData: GitCommitData, gerritStates: GerritChangeState[] | null, deferUncommittedChanges: boolean, forceFresh: boolean): Promise<GitCommitData> {
		if (!msg.showRemoteBranches || commitData.error !== null) return commitData;
		const complete = await this.getCommitsCached(msg, gerritRefs, deferUncommittedChanges, forceFresh, false);
		if (run.signal.aborted) return complete; // superseded by a newer load request

		if (remoteRefsFollowUpChanged(commitData, complete)) {
			send({
				command: 'loadCommits',
				refreshId: msg.refreshId,
				onlyFollowFirstParent: msg.onlyFollowFirstParent,
				gerritStates: gerritStates,
				...(deferUncommittedChanges ? { uncommittedPending: true } : {}),
				...complete
			});
			this.deps.logger.log('Loaded the remote refs of ' + msg.repo + ' in a follow-up response');
		}
		return complete;
	}

	/* ---------- Uncommitted Changes follow-up ---------- */

	/**
	 * Complete a `loadCommits` request that was already answered without waiting for the
	 * uncommitted changes status: fetches the status and sends the final response marked
	 * `uncommittedCount`, prepending the synthetic "Uncommitted Changes" row to the SAME commit
	 * list already sent when there are uncommitted changes, so no log/refs commands re-run.
	 *
	 * The count goes through the injected stabiliser: a positive count is sent at once, while a
	 * zero that would remove the row is re-checked across the confirm window first and a failed
	 * status read is not sent at all - the row's PRESENCE never flickers, only its number ever
	 * changes in place. The confirm loop is bounded: a status read that keeps failing gives up
	 * after twice the confirm window, leaving the row at its last delivered state.
	 */
	private async sendUncommittedChangesFollowUp(msg: RequestLoadCommits, run: AbortController, send: (response: ResponseLoadCommits) => void, commitData: GitCommitData, gerritStates: GerritChangeState[] | null = null): Promise<void> {
		// Match the page loader: only prepend the row when HEAD is among the loaded commits (with
		// a filter or cutoff excluding HEAD, the row would have no parent in the graph).
		if (!this.deps.getConfig().showUncommittedChanges || commitData.head === null || commitData.error !== null) return;
		if (!commitData.commits.some((commit) => commit.hash === commitData.head)) return;

		let numUncommittedChanges = await this.readUncommittedChanges(msg.repo);
		let attemptsLeft = Math.ceil((2 * this.uncommittedZeroConfirmMs) / this.uncommittedRecheckMs);
		while (true) {
			if (run.signal.aborted) return; // superseded by (or disposed with) a newer request

			if (msg.hard === true) {
				// A hard refresh wiped the view (the row included) before this pipeline started, so
				// there is no rendered row whose disappearance needs stabilising: deliver the
				// reading directly, and give up on a read that fails
				if (numUncommittedChanges === null) return;
				this.sendUncommittedChangesResponse(msg, send, commitData, gerritStates, numUncommittedChanges);
				this.deps.stabiliser.delivered(numUncommittedChanges);
				return;
			}

			const outcome = this.deps.stabiliser.observe(numUncommittedChanges, this.deps.now());
			if ('recheckAfterMs' in outcome) {
				if (--attemptsLeft < 0) return;
				await this.deps.sleep(outcome.recheckAfterMs);
				if (run.signal.aborted) return;
				numUncommittedChanges = await this.readUncommittedChanges(msg.repo);
				continue;
			}

			this.sendUncommittedChangesResponse(msg, send, commitData, gerritStates, outcome.send);
			this.deps.stabiliser.delivered(outcome.send);
			return;
		}
	}

	/**
	 * Send the final response of the uncommitted changes follow-up: the commit list of the
	 * initial response, prepended with the synthetic "Uncommitted Changes" row above HEAD when
	 * (and only when) there are uncommitted changes.
	 */
	private sendUncommittedChangesResponse(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void, commitData: GitCommitData, gerritStates: GerritChangeState[] | null, numUncommittedChanges: number): void {
		const head = commitData.head;
		if (head === null) return;
		send({
			command: 'loadCommits',
			refreshId: msg.refreshId,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			gerritStates: gerritStates,
			// The exact count, so the view can keep the row rendered (and update its number in
			// place) even across responses whose commit list doesn't carry the row
			uncommittedCount: numUncommittedChanges,
			commits: numUncommittedChanges > 0 ? [this.uncommittedRow(head, numUncommittedChanges), ...commitData.commits] : commitData.commits,
			head: commitData.head,
			tags: commitData.tags,
			branches: commitData.branches ?? null,
			moreCommitsAvailable: commitData.moreCommitsAvailable,
			error: null
		});
	}

	/** The synthetic "Uncommitted Changes" row the final follow-up prepends above HEAD. */
	private uncommittedRow(head: string, count: number): GitCommit {
		return {
			hash: CommitLoader.UNCOMMITTED_HASH,
			parents: [head],
			author: '*',
			email: '',
			date: Math.round(this.deps.now() / 1000),
			message: this.deps.formatUncommittedRow(count),
			heads: [],
			tags: [],
			remotes: [],
			stash: null
		};
	}

	/**
	 * Read the number of uncommitted changes of a repository.
	 * @returns The number, or NULL when the status could not be read (which must be treated as
	 *          "unknown", never as "0": a momentarily failing status scan is exactly how the
	 *          "Uncommitted Changes" row used to vanish and come back).
	 */
	private async readUncommittedChanges(repo: string): Promise<number | null> {
		try {
			return await this.deps.reads.getUncommittedChanges(repo);
		} catch (error) {
			this.deps.logger.logError('Failed to read the uncommitted changes of ' + repo + ': ' + error);
			return null;
		}
	}

	/* ---------- Gerrit pipeline ---------- */

	/**
	 * Complete an asynchronous Gerrit load started by a `loadCommits` request that was already
	 * answered with the branch graph (marked `gerritPending`), sending the remaining responses
	 * once the fresh Gerrit data is available, in stages:
	 *  1. badges: the graph, updated with the change refs of the fresh states, together with the
	 *     light part of the states (everything the badges show) - no event timelines yet;
	 *  2. review information: the full states (with the event timelines), on the now unchanged
	 *     graph - they only reach the review dialog a badge click opens, so they arrive last.
	 * A stage is skipped when a newer request supersedes it (the abort check).
	 * @returns What the caller's final follow-up must build on: the Gerrit states the last sent
	 *          response carried (NULL when the pipeline failed or was superseded), and the commit
	 *          data of that response - which stage 1 may have reloaded with fresher change refs.
	 */
	private async loadCommitsGerritFollowUp(msg: RequestLoadCommits, run: AbortController, send: (response: ResponseLoadCommits) => void, previousRefs: string[] | null, pendingCommitData: GitCommitData): Promise<{ states: GerritChangeState[] | null, commitData: GitCommitData }> {
		const cache = await this.gerritPipeline.loadGerritData(msg.repo, msg.gerritStatusFilter, this.gerritFetchLimitOf(msg), msg.hard === true);
		if (run.signal.aborted) return { states: null, commitData: pendingCommitData }; // superseded by a newer load request

		if (cache === null) {
			// The Gerrit pipeline failed: degrade to the plain view (as before)
			this.sendGerritLoadStage(msg, send, null, pendingCommitData);
			return { states: null, commitData: pendingCommitData };
		}

		// Stage 1 (badges): the page loaded with the change refs filling the badge slots, and the
		// light part of the states. A change refs list identical to the one already rendered
		// keeps the current graph, skipping the getCommits round-trip (which dominates the load
		// time on large repositories).
		const page = await this.loadGerritPage(msg, cache, previousRefs, pendingCommitData, false);
		if (run.signal.aborted) return { states: null, commitData: page.commitData }; // superseded by a newer load request
		this.sendGerritLoadStage(msg, send, CommitLoader.lightGerritStates(page.states), page.commitData);

		// Stage 2 (review information): the event timelines arrive last, on the unchanged graph
		this.sendGerritLoadStage(msg, send, page.states, page.commitData);
		return { states: page.states, commitData: page.commitData };
	}

	/** Send one `loadCommits` response of the staged Gerrit follow-up (always `uncommittedPending`). */
	private sendGerritLoadStage(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void, states: GerritChangeState[] | null, commitData: GitCommitData): void {
		send({
			command: 'loadCommits',
			refreshId: msg.refreshId,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			gerritStates: states,
			uncommittedPending: true,
			...commitData
		});
	}

	/**
	 * The states without their event timelines: everything the badges show, small enough to ride
	 * along the badge stage without delaying it (the timelines dominate the payload and only the
	 * review dialog reads them).
	 */
	private static lightGerritStates(states: GerritChangeState[]): GerritChangeState[] {
		return states.map((state) => ({ ...state, events: [], eventsPending: true }));
	}

	/**
	 * Load the page of a Gerrit-enabled `loadCommits` request through the Gerrit pipeline, feeding
	 * it this loader's cached page loader (see GerritPipeline.loadGerritPage).
	 */
	private loadGerritPage(msg: RequestLoadCommits, cache: GerritCacheEntry, previousRefs: ReadonlyArray<string> | null, previousCommitData: GitCommitData | null, deferRemoteRefs: boolean): Promise<{ refs: string[], commitData: GitCommitData, states: GerritChangeState[] }> {
		return this.gerritPipeline.loadGerritPage(msg, cache, previousRefs, previousCommitData, deferRemoteRefs, (message, refs, deferUncommitted, forceFresh, deferRemote) => this.getCommitsCached(message, refs, deferUncommitted, forceFresh, deferRemote));
	}

	/**
	 * The fetch limit a `loadCommits` request displays the Gerrit changes under: the repository's
	 * own limit from the Repository Settings, or the `gerrit.fetchLimit` Extension Setting when
	 * it has none (NULL). A value from the untrusted webview outside 1..10000 is treated as NULL.
	 */
	private gerritFetchLimitOf(msg: RequestLoadCommits): number {
		const limit = msg.gerritFetchLimit;
		return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 10000 ? limit : this.deps.getConfig().gerrit.fetchLimit;
	}

	/* ---------- Cached page loads ---------- */

	/**
	 * Load the commits of a `loadCommits` request, serving identical requests from the commit
	 * cache instead of re-running Git. A deferred load first looks for a CACHED COMPLETE entry
	 * under the complete key - deferral only pays when there is nothing complete to serve - and a
	 * forced (hard) refresh bypasses the cache and refreshes the cached entry.
	 */
	private async getCommitsCached(msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, deferUncommittedChanges: boolean, forceFresh: boolean, deferRemoteRefs: boolean = false): Promise<GitCommitData> {
		if (!forceFresh && deferRemoteRefs) {
			const complete = this.commitCache.get(commitPageCacheKey(msg, gerritRefs, deferUncommittedChanges, false));
			if (complete !== undefined) return complete;
		}
		const key = commitPageCacheKey(msg, gerritRefs, deferUncommittedChanges, deferRemoteRefs);
		if (!forceFresh) {
			const cached = this.commitCache.get(key);
			if (cached !== undefined) return cached;
		}
		return this.commitCache.put(key, () => this.deps.reads.getCommits(msg.repo, {
			branches: msg.branches,
			authors: msg.authors,
			maxCommits: msg.maxCommits,
			showTags: msg.showTags,
			showRemoteBranches: msg.showRemoteBranches,
			includeCommitsMentionedByReflogs: msg.includeCommitsMentionedByReflogs,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			commitOrdering: msg.commitOrdering,
			remotes: msg.remotes,
			hideRemotes: msg.hideRemotes,
			stashes: msg.stashes,
			gerritRefs: gerritRefs,
			filterPath: msg.filterPath === undefined ? null : msg.filterPath,
			deferUncommittedChanges: deferUncommittedChanges,
			deferRemoteRefs: deferRemoteRefs
		}, this.currentRun !== null ? this.currentRun.signal : undefined));
	}
}

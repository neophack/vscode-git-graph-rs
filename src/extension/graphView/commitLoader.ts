import type { AbortLike } from '../git/process/gitProcess';
import type { AnnotateReadOptions, GitAnnotation, GitCommitData, GitRefSnapshot, RefReadOptions } from '../git/read/types';
import type { HostScheduler } from './scheduler';
import type { CommitOrdering } from '../../shared/model/webview';
import type { ErrorInfo } from '../../shared/protocol/messages';
import type { GerritChangeState } from '../../shared/model/gerrit';
import type { GitOperationState, GitStash } from '../../shared/model/git';
import type { RequestLoadCommits, RequestLoadView, ResponseLoadCommits, ResponseLoadView } from '../../shared/protocol/loading';
import { CommitPageCache, commitPageCacheKey } from './caches/commitPageCache';
import type { GerritCacheEntry } from './caches/gerritCache';
import { GerritCacheStore } from './caches/gerritCache';
import { launchFollowUps, loadCommitsGerritFollowUp, pushUncommittedRow, sendLoadError, sendRemoteRefsFollowUp, sendUncommittedChangesFollowUp } from './followUpStages';
import { beginLoadView, loadView } from './openPath';
import type { LoadViewTicket, OpenPathContext } from './openPath';
import { GerritPipeline } from './gerritPipeline';
import type { CommitLoaderPort } from './handlers/context';

export type { LoadViewTicket } from './openPath';

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
 * Split along its seams (OPTIMIZATION-PLAN §A5): openPath.ts holds the merged open-path read,
 * followUpStages.ts the staged follow-up chain, and caches/commitPageCache.ts the page cache.
 * This module keeps the ports, the run/cancellation state, the caches and the Gerrit page
 * wiring, and the {@link CommitLoader} facade below exposes them as one surface.
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
	/**
	 * The one-pass ref snapshot of a refs-only refresh (task 4.8): the branch list, the
	 * checked-out branch, the tag names and the ref data — no history walk.
	 */
	getRefSnapshot(repo: string, options: RefReadOptions): Promise<GitRefSnapshot>;
	/**
	 * Re-annotate the given commits with freshly read refs (task 4.8): the labels a full page
	 * load of the same options would attach, without running one.
	 */
	annotate(repo: string, commits: ReadonlyArray<string>, options: AnnotateReadOptions): Promise<GitAnnotation>;
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
	/**
	 * The host scheduler (task 4.8): when present, the initial page read runs as an INTERACTIVE
	 * job (so background work — follow-ups, prewarming, PR fetches — yields to it, and a newer
	 * page load of the same repository cancels the superseded walk in the engine) and the staged
	 * follow-up chain runs as a BACKGROUND job (concurrency 1, yielded by any interactive
	 * arrival). Absent in unit tests, which drive the reads directly.
	 */
	readonly scheduler?: HostScheduler;
}

/**
 * The staged commit loading pipeline, implementing the port the handler table's `loadCommits`
 * handler delegates to (see handlers/context.ts). All methods are safe to call from handlers;
 * the `configChanged` / `repoChangedOnDisk` / `viewRepoChanged` / `dispose` surface is driven by
 * the Panel (task 4.4) in place of the live invalidation sites listed in their doc comments.
 */
export class CommitLoader implements CommitLoaderPort {
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
	/**
	 * The last load each repository was served (task 4.8): the request and the page (and the
	 * Gerrit states) the newest delivered response carried. The write-path impact refresh
	 * (impactRefresh.ts) reads it through the {@link ImpactRefreshView} accessors to re-annotate
	 * the rendered page in place instead of re-walking history.
	 */
	private readonly lastLoads: Map<string, { msg: RequestLoadCommits; page: GitCommitData; states: GerritChangeState[] | null }> = new Map();
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
	/** The seams the extracted openPath.ts / followUpStages.ts halves run on (built from the privates above). */
	private readonly ctx: OpenPathContext;

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
		this.ctx = {
			deps: deps,
			uncommittedZeroConfirmMs: this.uncommittedZeroConfirmMs,
			uncommittedRecheckMs: this.uncommittedRecheckMs,
			gerritPipeline: this.gerritPipeline,
			isDisposed: () => this.disposed,
			isRenderingCommits: () => this.renderingCommits,
			startRun: (repo) => this.startRun(repo),
			getCommitsCached: (msg, gerritRefs, deferUncommittedChanges, forceFresh, deferRemoteRefs) => this.getCommitsCached(msg, gerritRefs, deferUncommittedChanges, forceFresh, deferRemoteRefs),
			noteLoadedPage: (msg, page, states) => this.noteLoadedPage(msg, page, states),
			loadGerritPage: (msg, cache, previousRefs, previousCommitData, deferRemoteRefs) => this.loadGerritPage(msg, cache, previousRefs, previousCommitData, deferRemoteRefs),
			gerritFetchLimitOf: (msg) => this.gerritFetchLimitOf(msg),
			lastLoadRecord: (repo) => this.lastLoads.get(repo)
		};
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
		const run = this.startRun(msg.repo);

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
				this.noteLoadedPage(msg, commitData, null);
				this.deps.logger.log('Loaded ' + commitData.commits.length + ' commits in ' + (this.deps.now() - startTime) + ' ms');
				launchFollowUps(this.ctx, msg, run, send, async () => {
					const complete = await sendRemoteRefsFollowUp(this.ctx, msg, run, send, null, commitData, null, true, msg.hard);
					await sendUncommittedChangesFollowUp(this.ctx, msg, run, send, complete);
				});
			} else if (this.gerritStore.has(msg.repo) && msg.hard !== true && !this.gerritStore.isStale(msg.repo)
				&& this.gerritStore.get(msg.repo)!.fetchLimit === this.gerritFetchLimitOf(msg)) {
				// The Gerrit data is already cached (under the requested fetch limit): serve it instantly from the cache
				const page = await this.loadGerritPage(msg, this.gerritStore.get(msg.repo)!, null, null, deferRemoteRefs);
				if (run.signal.aborted) return;
				send({ command: 'loadCommits', refreshId: msg.refreshId, onlyFollowFirstParent: msg.onlyFollowFirstParent, gerritStates: page.states, uncommittedPending: true, ...page.commitData });
				this.noteViewHasCommits(page.commitData);
				this.noteLoadedPage(msg, page.commitData, page.states);
				this.deps.logger.log('Loaded ' + page.commitData.commits.length + ' commits in ' + (this.deps.now() - startTime) + ' ms');
				launchFollowUps(this.ctx, msg, run, send, async () => {
					// Quirk kept from the live pipeline: the uncommitted follow-up carries the states of
					// the INITIAL page, never anything a follow-up reloaded
					const complete = await sendRemoteRefsFollowUp(this.ctx, msg, run, send, page.refs, page.commitData, page.states, true, msg.hard);
					await sendUncommittedChangesFollowUp(this.ctx, msg, run, send, complete, page.states);
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
				this.noteLoadedPage(msg, commitData, staleStates);
				launchFollowUps(this.ctx, msg, run, send, async () => {
					const complete = await sendRemoteRefsFollowUp(this.ctx, msg, run, send, staleRefs, commitData, staleStates, true, msg.hard);
					const result = await loadCommitsGerritFollowUp(this.ctx, msg, run, send, staleRefs, complete);
					await sendUncommittedChangesFollowUp(this.ctx, msg, run, send, result.commitData, result.states);
				});
			}
		} catch (error) {
			if (run.signal.aborted) return;
			sendLoadError(this.ctx, msg, send, error);
		}
	}

	/* ---------- The merged open path (task 4.7; see openPath.ts) ---------- */

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
		return beginLoadView(this.ctx, msg);
	}

	/**
	 * Serve a `loadView` request: begin the merged read and push its response through `send`,
	 * then run the staged follow-ups. (The open path itself goes through `beginLoadView` + the
	 * panel's `ready` push; this entry answers an explicit request, e.g. an automation replay.)
	 */
	public async loadView(msg: RequestLoadView, send: (response: ResponseLoadView | ResponseLoadCommits) => void): Promise<void> {
		await loadView(this.ctx, msg, send);
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

	/* ---------- The write-path impact refresh view (task 4.8; see impactRefresh.ts) ---------- */

	/** The last `loadCommits` request served for the repository (the impact refresh's options), or NULL when it never loaded. */
	public lastLoadRequest(repo: string): RequestLoadCommits | null {
		return this.lastLoads.get(repo)?.msg ?? null;
	}

	/** The page (without the synthetic uncommitted row) the newest delivered response carried. */
	public lastRenderedPage(repo: string): GitCommitData | null {
		return this.lastLoads.get(repo)?.page ?? null;
	}

	/** The Gerrit states the newest delivered response carried (NULL when it carried none). */
	public cachedGerritStates(repo: string): GerritChangeState[] | null {
		return this.lastLoads.get(repo)?.states ?? null;
	}

	/** Drop every cached commit page: a history-affecting write made them stale. */
	public dropCachedPages(): void {
		this.commitCache.clear();
	}

	/**
	 * Re-run a recorded request as the incremental traversal refresh (task 4.8's `commits`
	 * class): the same staged pipeline a `loadCommits` request runs, over the same refresh id —
	 * the webview accepts it as the current view state's newest response and reconciles in place.
	 */
	public reload(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void> {
		return this.loadCommits(msg, send);
	}

	/**
	 * The worktree-only impact refresh (task 4.8's `worktree` class): re-read the "Uncommitted
	 * Changes" count and push the row update on the page the view last received — the same
	 * stabiliser-gated delivery the load pipeline's follow-up performs (a zero that would remove
	 * the row is re-checked across the confirm window; an unknown count delivers nothing).
	 */
	public async pushUncommittedRow(repo: string, msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void> {
		await pushUncommittedRow(this.ctx, repo, msg, send);
	}

	/** Record the newest delivered page of a repository (the impact refresh's base, task 4.8). */
	private noteLoadedPage(msg: RequestLoadCommits, page: GitCommitData, states: GerritChangeState[] | null): void {
		this.lastLoads.set(msg.repo, { msg: msg, page: page, states: states });
	}

	private noteViewHasCommits(commitData: GitCommitData): void {
		if (commitData.commits.length > 0) this.renderingCommits = true;
	}

	/**
	 * Begin the run of a new load of the repository, shared by `loadCommits` and the merged open
	 * path: aborts the previous run, cancels the repository's in-flight read and registers the
	 * new run as its active load.
	 */
	private startRun(repo: string): AbortController {
		this.abortCurrentRun();
		this.cancelActiveLoad(repo);
		const run = new AbortController();
		this.currentRun = run;
		this.activeLoads.set(repo, run);
		return run;
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
		const query: CommitLoadQuery = {
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
		};
		const runSignal = this.currentRun !== null ? this.currentRun.signal : undefined;
		return this.commitCache.put(key, () => {
			// Interactive through the scheduler (task 4.8): background work yields to the page
			// read, and a newer load of the same repository cancels this walk in the engine (the
			// scheduler's signal reaches the backend, which cancels the engine request by id).
			const scheduler = this.deps.scheduler;
			if (scheduler === undefined) return this.deps.reads.getCommits(msg.repo, query, runSignal);
			return scheduler.run('load:' + msg.repo, 'interactive', (jobSignal) => this.deps.reads.getCommits(msg.repo, query, jobSignal));
		});
	}
}

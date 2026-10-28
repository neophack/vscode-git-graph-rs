import type { AbortControllerLike } from '../git/process/gitProcess';
import type { GitCommitData } from '../git/read/types';
import { JobAbandonedError } from './scheduler';
import type { GerritChangeState } from '../../shared/model/gerrit';
import type { GitCommit } from '../../shared/model/git';
import type { RequestLoadCommits, ResponseLoadCommits } from '../../shared/protocol/loading';
import { remoteRefsFollowUpChanged } from './followUpChange';
import type { GerritCacheEntry } from './caches/gerritCache';
import type { GerritPipeline } from './gerritPipeline';
import type { CommitLoaderDeps } from './commitLoader';

/**
 * The staged follow-up half of the commit loading pipeline, split out of commitLoader.ts along
 * its natural seam: the responses a `loadCommits` request sends AFTER its
 * initial one — the remote-tracking refs completion, the Gerrit stages (badges, then the review
 * timelines), the "Uncommitted Changes" row — plus the detached plumbing that launches the chain
 * and answers its errors, and the worktree impact refresh's row push. Not to be confused with
 * followUpChange.ts, which holds the pure predicate deciding whether a remote-refs follow-up is
 * worth sending; this module performs the follow-ups and calls that predicate. The CommitLoader
 * facade keeps the run state, the caches and the public surface; every function below receives
 * the loader's seams through {@link FollowUpContext}, so the code is the loader's verbatim with
 * `this` replaced by the context.
 */

/** The loader seams the staged follow-up chain runs on (the CommitLoader facade builds it from its privates). */
export interface FollowUpContext {
	/** The loader's injected dependencies: the reads, the config, the stabiliser, the scheduler. */
	readonly deps: CommitLoaderDeps;
	/** The confirm window the zero-confirmation re-reads are bounded by (CommitLoader's 5000/1000 ms fallbacks). */
	readonly uncommittedZeroConfirmMs: number;
	readonly uncommittedRecheckMs: number;
	/** The Gerrit pipeline instance the Gerrit stages drive. */
	readonly gerritPipeline: GerritPipeline;
	/** Whether the loader was disposed (the worktree row push checks it between its re-reads). */
	isDisposed(): boolean;
	/** The loader's cached page loader (its `getCommitsCached`). */
	getCommitsCached(msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, deferUncommittedChanges: boolean, forceFresh: boolean, deferRemoteRefs?: boolean): Promise<GitCommitData>;
	/** Record the newest delivered page of a repository (the impact refresh's base). */
	noteLoadedPage(msg: RequestLoadCommits, page: GitCommitData, states: GerritChangeState[] | null): void;
	/** The loader's Gerrit page loader (its `loadGerritPage`). */
	loadGerritPage(msg: RequestLoadCommits, cache: GerritCacheEntry, previousRefs: ReadonlyArray<string> | null, previousCommitData: GitCommitData | null, deferRemoteRefs: boolean): Promise<{ refs: string[], commitData: GitCommitData, states: GerritChangeState[] }>;
	/** The fetch limit a request displays the Gerrit changes under (the loader's `gerritFetchLimitOf`). */
	gerritFetchLimitOf(msg: RequestLoadCommits): number;
	/** The last load the repository was served (the impact refresh's base), or undefined when it never loaded. */
	lastLoadRecord(repo: string): { msg: RequestLoadCommits; page: GitCommitData; states: GerritChangeState[] | null } | undefined;
}

/**
 * The synthetic hash of the "Uncommitted Changes" row - the same value as the backend's
 * `UNCOMMITTED` constant (git/read/types).
 */
const UNCOMMITTED_HASH = '*';

/* ---------- Follow-up plumbing ---------- */

/**
 * Run the follow-up chain detached from the initial response, catching every error: a
 * rejecting follow-up read is answered with an error response (so the view is never left
 * hanging), never left as an unhandled rejection. With a
 * scheduler the chain runs as a BACKGROUND job: one at a time, and yielded by any
 * interactive arrival (a newer page load of the same repository supersedes the run the chain
 * belongs to anyway, so an abandonment is silently dropped, never surfaced as an error).
 */
export function launchFollowUps(ctx: FollowUpContext, msg: RequestLoadCommits, run: AbortControllerLike, send: (response: ResponseLoadCommits) => void, chain: () => Promise<void>): void {
	const scheduler = ctx.deps.scheduler;
	const started = scheduler === undefined ? chain() : scheduler.run('followUp:' + msg.repo, 'background', () => chain());
	void started.catch((error) => {
		if (run.signal.aborted || error instanceof JobAbandonedError) return; // superseded or yielded: the newer load owns the view
		sendLoadError(ctx, msg, send, error);
	});
}

/** Answer a request whose pipeline failed with a loadCommits error response, and log it. */
export function sendLoadError(ctx: FollowUpContext, msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void, error: unknown): void {
	ctx.deps.logger.logError('Failed to load the commits of ' + msg.repo + ': ' + error);
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

/**
 * Complete a `loadCommits` request whose first response was sent without the remote-tracking
 * refs (a `refs/remotes/` scan that dominates the load time on repositories with many of
 * them). Loads the complete data and sends a final response carrying the remote branch pills,
 * which the view merges into the already-rendered graph in place. Nothing is sent when the
 * remote annotations did not change (the responses are idempotent) - `remoteRefsFollowUpChanged`
 * decides, catching the cases a plain remotes-label diff missed (see its doc comment).
 */
export async function sendRemoteRefsFollowUp(ctx: FollowUpContext, msg: RequestLoadCommits, run: AbortControllerLike, send: (response: ResponseLoadCommits) => void, gerritRefs: ReadonlyArray<string> | null, commitData: GitCommitData, gerritStates: GerritChangeState[] | null, deferUncommittedChanges: boolean, forceFresh: boolean): Promise<GitCommitData> {
	if (!msg.showRemoteBranches || commitData.error !== null) return commitData;
	const complete = await ctx.getCommitsCached(msg, gerritRefs, deferUncommittedChanges, forceFresh, false);
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
		ctx.noteLoadedPage(msg, complete, gerritStates);
		ctx.deps.logger.log('Loaded the remote refs of ' + msg.repo + ' in a follow-up response');
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
export async function sendUncommittedChangesFollowUp(ctx: FollowUpContext, msg: RequestLoadCommits, run: AbortControllerLike, send: (response: ResponseLoadCommits) => void, commitData: GitCommitData, gerritStates: GerritChangeState[] | null = null): Promise<void> {
	// Match the page loader: only prepend the row when HEAD is among the loaded commits (with
	// a filter or cutoff excluding HEAD, the row would have no parent in the graph).
	if (!ctx.deps.getConfig().showUncommittedChanges || commitData.head === null || commitData.error !== null) return;
	if (!commitData.commits.some((commit) => commit.hash === commitData.head)) return;

	let numUncommittedChanges = await readUncommittedChanges(ctx, msg.repo);
	let attemptsLeft = Math.ceil((2 * ctx.uncommittedZeroConfirmMs) / ctx.uncommittedRecheckMs);
	while (true) {
		if (run.signal.aborted) return; // superseded by (or disposed with) a newer request

		if (msg.hard === true) {
			// A hard refresh wiped the view (the row included) before this pipeline started, so
			// there is no rendered row whose disappearance needs stabilising: deliver the
			// reading directly, and give up on a read that fails
			if (numUncommittedChanges === null) return;
			sendUncommittedChangesResponse(ctx, msg, send, commitData, gerritStates, numUncommittedChanges);
			ctx.deps.stabiliser.delivered(numUncommittedChanges);
			return;
		}

		const outcome = ctx.deps.stabiliser.observe(numUncommittedChanges, ctx.deps.now());
		if ('recheckAfterMs' in outcome) {
			if (--attemptsLeft < 0) return;
			await ctx.deps.sleep(outcome.recheckAfterMs);
			if (run.signal.aborted) return;
			numUncommittedChanges = await readUncommittedChanges(ctx, msg.repo);
			continue;
		}

		sendUncommittedChangesResponse(ctx, msg, send, commitData, gerritStates, outcome.send);
		ctx.deps.stabiliser.delivered(outcome.send);
		return;
	}
}

/**
 * Send the final response of the uncommitted changes follow-up: the commit list of the
 * initial response, prepended with the synthetic "Uncommitted Changes" row above HEAD when
 * (and only when) there are uncommitted changes.
 */
function sendUncommittedChangesResponse(ctx: FollowUpContext, msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void, commitData: GitCommitData, gerritStates: GerritChangeState[] | null, numUncommittedChanges: number): void {
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
		commits: numUncommittedChanges > 0 ? [uncommittedRow(ctx, head, numUncommittedChanges), ...commitData.commits] : commitData.commits,
		head: commitData.head,
		tags: commitData.tags,
		branches: commitData.branches ?? null,
		moreCommitsAvailable: commitData.moreCommitsAvailable,
		error: null
	});
	ctx.noteLoadedPage(msg, commitData, gerritStates);
}

/** The synthetic "Uncommitted Changes" row the final follow-up prepends above HEAD. */
function uncommittedRow(ctx: FollowUpContext, head: string, count: number): GitCommit {
	return {
		hash: UNCOMMITTED_HASH,
		parents: [head],
		author: '*',
		email: '',
		date: Math.round(ctx.deps.now() / 1000),
		message: ctx.deps.formatUncommittedRow(count),
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
async function readUncommittedChanges(ctx: FollowUpContext, repo: string): Promise<number | null> {
	try {
		return await ctx.deps.reads.getUncommittedChanges(repo);
	} catch (error) {
		ctx.deps.logger.logError('Failed to read the uncommitted changes of ' + repo + ': ' + error);
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
export async function loadCommitsGerritFollowUp(ctx: FollowUpContext, msg: RequestLoadCommits, run: AbortControllerLike, send: (response: ResponseLoadCommits) => void, previousRefs: string[] | null, pendingCommitData: GitCommitData): Promise<{ states: GerritChangeState[] | null, commitData: GitCommitData }> {
	const cache = await ctx.gerritPipeline.loadGerritData(msg.repo, msg.gerritStatusFilter, ctx.gerritFetchLimitOf(msg), msg.hard === true);
	if (run.signal.aborted) return { states: null, commitData: pendingCommitData }; // superseded by a newer load request

	if (cache === null) {
		// The Gerrit pipeline failed: degrade to the plain view (as before)
		sendGerritLoadStage(ctx, msg, send, null, pendingCommitData);
		return { states: null, commitData: pendingCommitData };
	}

	// Stage 1 (badges): the page loaded with the change refs filling the badge slots, and the
	// light part of the states. A change refs list identical to the one already rendered
	// keeps the current graph, skipping the getCommits round-trip (which dominates the load
	// time on large repositories).
	const page = await ctx.loadGerritPage(msg, cache, previousRefs, pendingCommitData, false);
	if (run.signal.aborted) return { states: null, commitData: page.commitData }; // superseded by a newer load request
	sendGerritLoadStage(ctx, msg, send, lightGerritStates(page.states), page.commitData);

	// Stage 2 (review information): the event timelines arrive last, on the unchanged graph
	sendGerritLoadStage(ctx, msg, send, page.states, page.commitData);
	return { states: page.states, commitData: page.commitData };
}

/** Send one `loadCommits` response of the staged Gerrit follow-up (always `uncommittedPending`). */
function sendGerritLoadStage(ctx: FollowUpContext, msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void, states: GerritChangeState[] | null, commitData: GitCommitData): void {
	send({
		command: 'loadCommits',
		refreshId: msg.refreshId,
		onlyFollowFirstParent: msg.onlyFollowFirstParent,
		gerritStates: states,
		uncommittedPending: true,
		...commitData
	});
	ctx.noteLoadedPage(msg, commitData, states);
}

/**
 * The states without their event timelines: everything the badges show, small enough to ride
 * along the badge stage without delaying it (the timelines dominate the payload and only the
 * review dialog reads them).
 */
function lightGerritStates(states: GerritChangeState[]): GerritChangeState[] {
	return states.map((state) => ({ ...state, events: [], eventsPending: true }));
}

/* ---------- The worktree impact refresh's row push (see impactRefresh.ts) ---------- */

/**
 * The worktree-only impact refresh (the impact refresh's `worktree` class): re-read the "Uncommitted
 * Changes" count and push the row update on the page the view last received — the same
 * stabiliser-gated delivery the load pipeline's follow-up performs (a zero that would remove
 * the row is re-checked across the confirm window; an unknown count delivers nothing).
 */
export async function pushUncommittedRow(ctx: FollowUpContext, repo: string, msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void> {
	const record = ctx.lastLoadRecord(repo);
	if (record === undefined) return;
	if (!ctx.deps.getConfig().showUncommittedChanges) return;
	let numUncommittedChanges = await readUncommittedChanges(ctx, repo);
	let attemptsLeft = Math.ceil((2 * ctx.uncommittedZeroConfirmMs) / ctx.uncommittedRecheckMs);
	while (true) {
		if (ctx.isDisposed()) return;
		if (numUncommittedChanges === null) return; // unknown is not zero: the row keeps its last state
		const outcome = ctx.deps.stabiliser.observe(numUncommittedChanges, ctx.deps.now());
		if ('recheckAfterMs' in outcome) {
			if (--attemptsLeft < 0) return;
			await ctx.deps.sleep(outcome.recheckAfterMs);
			numUncommittedChanges = await readUncommittedChanges(ctx, repo);
			continue;
		}
		sendUncommittedChangesResponse(ctx, msg, send, record.page, record.states, outcome.send);
		ctx.deps.stabiliser.delivered(outcome.send);
		return;
	}
}

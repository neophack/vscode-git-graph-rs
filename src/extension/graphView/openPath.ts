import type { AbortControllerLike } from '../git/process/gitProcess';
import type { GitCommitData } from '../git/read/types';
import type { RequestLoadCommits, RequestLoadView, ResponseLoadCommits, ResponseLoadView } from '../../shared/protocol/loading';
import { launchFollowUps, sendRemoteRefsFollowUp, sendUncommittedChangesFollowUp } from './followUpStages';
import type { FollowUpContext } from './followUpStages';

/**
 * The merged open path of the graph view, split out of commitLoader.ts along its
 * seam: the ONE read that answers a repository being opened with both
 * its repo info and its first commit page, begun while the webview is still booting, whose
 * completed (or in-flight) result the panel PUSHES when the page reports `ready`. The
 * CommitLoader facade owns the run state and the caches; what this module needs of them arrives
 * through {@link OpenPathContext}, so the code is the loader's `beginLoadView` / `loadView`
 * verbatim with `this` replaced by the context.
 */

/**
 * One began merged open-path read: the promise settles with the merged response (NULL
 * once a newer load of the repository superseded it — the caller pushes nothing), and the
 * follow-up launcher runs the staged remote-refs / uncommitted-changes responses once the
 * response was actually pushed to a webview.
 */
export interface LoadViewTicket {
	readonly promise: Promise<ResponseLoadView | null>;
	followUps(send: (response: ResponseLoadCommits) => void): void;
}

/** The loader seams the open path runs on: the follow-up stages' context plus the shared run bookkeeping. */
export interface OpenPathContext extends FollowUpContext {
	/**
	 * Begin the run of a new load of the repository (the facade's `startRun`): aborts the previous
	 * run and cancels its in-flight engine walk through its signal, then registers the new run.
	 */
	startRun(repo: string): AbortControllerLike;
	/** Whether the webview is currently rendering a commit list (the remote-refs deferral's input). */
	isRenderingCommits(): boolean;
}

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
export function beginLoadView(ctx: OpenPathContext, msg: RequestLoadView): LoadViewTicket {
	if (ctx.isDisposed()) {
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
	const run = ctx.startRun(msg.repo);
	const deferRemoteRefs = msg.showRemoteBranches && !ctx.isRenderingCommits();
	const startTime = ctx.deps.now();
	let page: GitCommitData | null = null;
	const promise = (async (): Promise<ResponseLoadView | null> => {
		page = await ctx.getCommitsCached(commitsMsg, null, true, msg.hard, deferRemoteRefs);
		if (run.signal.aborted) return null; // superseded: the newer load owns the view
		const repoInfo = await ctx.deps.reads.getRepoInfo(msg.repo, {
			showRemoteBranches: msg.showRemoteBranches && !deferRemoteRefs,
			showRemoteHeads: ctx.deps.getConfig().showRemoteHeads,
			hideRemotes: msg.hideRemotes,
			showChangeRefs: false,
			showStashes: true
		});
		if (run.signal.aborted) return null;
		if (page === null) return null;
		ctx.deps.logger.log('Loaded the view of ' + msg.repo + ' (' + page.commits.length + ' commits) in ' + (ctx.deps.now() - startTime) + ' ms');
		ctx.noteLoadedPage(commitsMsg, page, null);
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
		ctx.deps.logger.logError('Failed to load the view of ' + msg.repo + ': ' + String(error));
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
		launchFollowUps(ctx, commitsMsg, run, send, async () => {
			const complete = await sendRemoteRefsFollowUp(ctx, commitsMsg, run, send, null, page as GitCommitData, null, true, msg.hard);
			await sendUncommittedChangesFollowUp(ctx, commitsMsg, run, send, complete);
		});
	};
	return { promise: promise, followUps: followUps };
}

/**
 * Serve a `loadView` request: begin the merged read and push its response through `send`,
 * then run the staged follow-ups. (The open path itself goes through `beginLoadView` + the
 * panel's `ready` push; this entry answers an explicit request, e.g. an automation replay.)
 */
export async function loadView(ctx: OpenPathContext, msg: RequestLoadView, send: (response: ResponseLoadView | ResponseLoadCommits) => void): Promise<void> {
	const ticket = beginLoadView(ctx, msg);
	const response = await ticket.promise;
	if (response === null) return; // superseded by a newer load: it answers instead
	send(response);
	ticket.followUps(send);
}

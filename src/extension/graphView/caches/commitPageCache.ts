import type { GitCommitData } from '../../git/read/types';
import type { RequestLoadCommits } from '../../../types';

/**
 * The commit-page cache of the graph view's staged loading pipeline (REFACTOR-PLAN task 4.3),
 * extracted verbatim from GitGraphView's `commitCache` (src/gitGraphView.ts): getCommits
 * dominates the load time on large repositories (multiple Git spawns) and many consecutive
 * requests are identical (filter toggles back and forth), so those are served from this cache
 * instead of re-running Git. In-flight promises are cached too, so concurrent identical requests
 * share a single Git run. The cache is dropped whenever the repository changes on disk, the
 * configuration changes, or a repo-mutating command finished (see CommitLoader's invalidation
 * methods); forced (hard) refreshes bypass it.
 *
 * The live GitGraphView keeps its own inline cache until the Panel cutover (task 4.4) replaces
 * it - the two coexist, deliberately, this wave.
 */
export class CommitPageCache {
	private readonly pages = new Map<string, Promise<GitCommitData>>();

	constructor(private readonly limit: number) {}

	/** The number of cached pages (never above the limit). */
	public get size(): number { return this.pages.size; }

	public get(key: string): Promise<GitCommitData> | undefined {
		return this.pages.get(key);
	}

	/**
	 * Cache and start one page load. Eviction is by INSERTION order (the oldest inserted key),
	 * not by access - matching the live implementation exactly: a repeatedly read entry is not
	 * refreshed, so under sustained load over the limit the original entries rotate out.
	 * A load that resolves with an ERROR result removes itself again (errors may be transient,
	 * the next call must be allowed to retry) unless a newer load has already replaced the entry.
	 */
	public put(key: string, load: () => Promise<GitCommitData>): Promise<GitCommitData> {
		if (this.pages.size >= this.limit) {
			const oldest = this.pages.keys().next().value;
			if (oldest !== undefined) this.pages.delete(oldest);
		}
		const promise = load();
		this.pages.set(key, promise);
		// The caller awaits the returned promise; this side-chain only drops error results, and
		// its rejection arm must stay silent or a rejecting load would resurface here as an
		// unhandled rejection - exactly what the extracted pipeline exists to eliminate.
		promise.then((page) => {
			if (page.error !== null && this.pages.get(key) === promise) this.pages.delete(key);
		}, () => undefined);
		return promise;
	}

	public clear(): void {
		this.pages.clear();
	}
}

/**
 * The cache key of a `loadCommits` request: everything of the request that changes what Git
 * returns, with the deferral flags included (a deferred response is a strictly smaller answer
 * than a complete one, so the two must never alias). Ported verbatim from GitGraphView's
 * `commitsCacheKey` - the exact key shape is behavior (a key that silently dropped a field
 * would serve one request's page to a different one).
 * @param msg The `loadCommits` request message.
 * @param gerritRefs The Gerrit change refs allowed into the graph (NULL => Gerrit disabled).
 * @param deferUncommittedChanges Whether the "Uncommitted Changes" row was deferred.
 * @param deferRemoteRefs Whether the remote-tracking refs were skipped.
 */
export function commitPageCacheKey(msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, deferUncommittedChanges: boolean, deferRemoteRefs: boolean): string {
	return JSON.stringify([msg.repo, msg.branches, msg.authors, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, gerritRefs, msg.filterPath === undefined ? null : msg.filterPath, deferUncommittedChanges, deferRemoteRefs]);
}

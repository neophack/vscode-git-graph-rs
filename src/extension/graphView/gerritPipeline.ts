import type { GitCommitData } from '../git/read/types';
import type { GerritChangeState, GerritStatusFilter } from '../../shared/model/gerrit';
import type { RequestLoadCommits } from '../../shared/protocol/loading';
import type { CommitLoaderConfig, CommitLoaderLogger, GerritDataPort } from './commitLoader';
import {
	buildFetchRefspecs, changeShard, filterChangeStates, GERRIT_FETCH_WINDOW_FACTOR, limitChangeStates, limitChanges, nextGerritSampleWindow, parseChangeRef, selectDisplayedChangeStates
} from './gerritSelection';
import type { GerritCacheEntry } from './caches/gerritCache';
import type { GerritCacheStore } from './caches/gerritCache';

/**
 * The Gerrit half of the staged loading pipeline (task 4.3), extracted from src/gitGraphView.ts's
 * `loadGerritData` / `fetchGerritChanges` / `buildLocalGerritEntry` / `loadGerritPage` /
 * `gerritChangeRefs` / `gerritPageStates`. Split out of commitLoader.ts to keep both files under
 * the 600-line cap; the loader owns the response staging and cancellation, this class owns the
 * Gerrit data itself. Like the loader, it is pure TypeScript: the Gerrit reads arrive injected,
 * so unit tests run without Git and without 'vscode'.
 */

/** The Gerrit pipeline's slice of the loader's injected dependencies. */
export interface GerritPipelineDeps {
	readonly gerrit: GerritDataPort;
	readonly getConfig: () => CommitLoaderConfig;
	readonly logger: CommitLoaderLogger;
}

/** The cached-page loader the pipeline reads pages through (the CommitLoader's `getCommitsCached`). */
export type LoadCachedPage = (msg: RequestLoadCommits, gerritRefs: ReadonlyArray<string> | null, deferUncommittedChanges: boolean, forceFresh: boolean, deferRemoteRefs: boolean) => Promise<GitCommitData>;

export class GerritPipeline {
	constructor(private readonly deps: GerritPipelineDeps, private readonly store: GerritCacheStore) {}

	/**
	 * Load the Gerrit change states of a repository (its cache entry, which `loadGerritPage`
	 * selects the displayed changes from): serve the cache when it is fresh, and run the fetch
	 * pipeline (reusing an in-progress fetch) when a refresh is required. Any failure degrades to
	 * the previously cached data (or NULL, the plain view without Gerrit data).
	 * The remote is contacted ONLY for a repository marked stale (the user fetched from the
	 * remote, enabled the integration, or changed its fetch settings) - a plain view load or a
	 * hard refresh re-reads the LOCAL change refs and metas and never touches the network.
	 * @param repo The path of the repository.
	 * @param statusFilter The status filter of the repository.
	 * @param fetchLimit The fetch limit to select the changes under; a cache built under a
	 *                   different limit is refreshed, because the fetched set of changes differs.
	 * @param rebuildFromLocal Whether the cache must be re-derived from the local change refs
	 *                        (a hard refresh: the repository may have changed behind the cache's
	 *                        back, e.g. a fetch run from a terminal).
	 */
	public async loadGerritData(repo: string, statusFilter: GerritStatusFilter, fetchLimit: number, rebuildFromLocal: boolean): Promise<GerritCacheEntry | null> {
		let cache = this.store.get(repo) || null;
		if (cache === null || rebuildFromLocal) {
			// No cached data (e.g. the extension just started), or a hard refresh: (re)build the
			// cache from the locally cached change refs, WITHOUT any network access, so the Gerrit
			// data is displayed instantly and works offline
			cache = await this.buildLocalGerritEntry(repo, fetchLimit);
			if (cache !== null) this.store.set(repo, cache);
			else this.store.delete(repo); // a hard rebuild that found no local change refs: the old entry (if any) refers to now-dead refs, and serving it again would make the next load fail on them
		}
		if (this.store.isStale(repo) || cache === null || cache.fetchLimit !== fetchLimit) {
			// Reuse a fetch that is already in progress for this repository
			const fetched = await this.store.dedupeFetch(repo, () => this.fetchGerritChanges(repo, fetchLimit, statusFilter));
			if (fetched !== null) {
				this.store.unmarkStale(repo);
				cache = fetched;
			} // on failure, fall back to the local cache (if any) and keep the stale flag so the next load retries the fetch
		}
		return cache;
	}

	/**
	 * Load the page of a Gerrit-enabled `loadCommits` request, with the change refs the fetch
	 * limit selects injected: the number set is the number of badges shown. Refs equal to
	 * `previousRefs` reuse `previousCommitData` instead of reloading (the getCommits round-trip
	 * dominates the load time on large repositories).
	 * @param msg The `loadCommits` request message.
	 * @param cache The cache entry of the repository.
	 * @param previousRefs The change refs the previous page was loaded with (NULL => none).
	 * @param previousCommitData The previous page (NULL => none).
	 * @param deferRemoteRefs Skip the remote-tracking refs (the loader's remote-refs deferral).
	 * @param loadPage The loader's cached page loader.
	 * @returns The refs the page was loaded with, the page, and the states to send with it.
	 */
	public async loadGerritPage(msg: RequestLoadCommits, cache: GerritCacheEntry, previousRefs: ReadonlyArray<string> | null, previousCommitData: GitCommitData | null, deferRemoteRefs: boolean, loadPage: LoadCachedPage): Promise<{ refs: string[], commitData: GitCommitData, states: GerritChangeState[] }> {
		const refs = this.gerritChangeRefs(cache, msg.gerritStatusFilter);
		const sameRefs = previousRefs !== null && previousRefs.length === refs.length && previousRefs.every((ref, i) => ref === refs[i]);
		const commitData = previousCommitData !== null && sameRefs
			? previousCommitData
			: await loadPage(msg, refs, true, msg.hard, deferRemoteRefs);
		return { refs: refs, commitData: commitData, states: this.gerritPageStates(cache, msg.gerritStatusFilter, commitData) };
	}

	/**
	 * Run the Gerrit refresh pipeline: ls-remote probe, targeted fetch, prune and meta parsing.
	 * The unfiltered result is stored in the repository's cache entry.
	 * @param repo The path of the repository.
	 * @param fetchLimit How many of the most recent changes PASSING the status filter are displayed.
	 * @param statusFilter The status filter the displayed changes are selected under: the sampling
	 *                     window deepens while fewer than `fetchLimit` sampled changes pass it
	 *                     (see `nextGerritSampleWindow`), because a change's status is only known
	 *                     once its NoteDb meta has been fetched and parsed.
	 * @returns The cache entry, or NULL if the pipeline failed (the previously cached data is kept).
	 */
	private async fetchGerritChanges(repo: string, fetchLimit: number, statusFilter: GerritStatusFilter): Promise<GerritCacheEntry | null> {
		const remote = this.deps.getConfig().gerrit.remote, generation = this.store.currentGeneration, gerrit = this.deps.gerrit;
		try {
			const remoteChanges = await gerrit.listRemoteChanges(repo, remote);
			if (remoteChanges.size === 0 && (await gerrit.listLocalChangeRefs(repo, remote)).length > 0) {
				// ls-remote returned nothing while local change refs exist: the remote is unreachable
				// (a timeout resolves with an empty map). Fail, so the previously cached (or locally
				// rebuilt) Gerrit data keeps being displayed instead of an empty view.
				this.deps.logger.log('Gerrit ls-remote returned no changes while local change refs exist (remote unreachable?), keeping the local Gerrit data.');
				return null;
			}
			const entry: GerritCacheEntry = { states: [], patchsets: new Map(), fetchLimit: fetchLimit };
			if (remoteChanges.size > 0) {
				// Resolve the change URL base concurrently with the fetch (it doesn't depend on it)
				const urlBasePromise = gerrit.getChangeUrlBase(repo, remote);
				// The sampling window deepens adaptively: the most recent `fetchLimit * FACTOR`
				// changes are fetched first, and while fewer than `fetchLimit` of them pass the
				// status filter, the window doubles (up to FACTOR_MAX, or the remote's end). Each
				// round only pays for the changes newly inside the window - already-sampled
				// changes are neither re-fetched nor re-parsed.
				let window = Math.min(remoteChanges.size, fetchLimit * GERRIT_FETCH_WINDOW_FACTOR);
				// A filter with every status disabled can never reach the target: deepening would
				// run to the cap for nothing
				const filterPassesAnything = statusFilter.new || statusFilter.merged || statusFilter.abandoned || statusFilter.wip;
				while (true) {
					const delta = new Map<number, number[]>();
					for (const [change, patchsets] of limitChanges(remoteChanges, window)) {
						if (!entry.patchsets.has(change)) delta.set(change, patchsets);
					}
					const fetchError = await gerrit.fetchChanges(repo, remote, buildFetchRefspecs(delta, remote, 'latest'));
					if (fetchError !== null) {
						this.deps.logger.log('Gerrit fetch failed: ' + fetchError);
						return null;
					}
					// Parse the NoteDb meta histories of the delta concurrently: a single Git command
					// resolves every meta ref hash (so unchanged metas are served from the cache), and
					// the remaining histories are parsed by a pool of concurrent Git commands
					const urlBase = await urlBasePromise;
					const statesByChange = await gerrit.parseMetas(repo, remote, Array.from(delta.keys()), urlBase);
					for (const [change, patchsets] of delta) {
						const state = statesByChange.get(change);
						if (state === undefined || state === null) continue; // meta ref not available locally
						entry.states.push(state);
						entry.patchsets.set(change, patchsets);
					}
					const next = filterPassesAnything
						? nextGerritSampleWindow(window, filterChangeStates(entry.states, statusFilter).length, fetchLimit, remoteChanges.size)
						: null;
					if (next === null) break;
					window = next;
				}
				const pruneError = await gerrit.pruneLocalChanges(repo, remote, Array.from(entry.patchsets.keys()));
				if (pruneError !== null) this.deps.logger.log('Gerrit ref pruning failed (stale change refs may accumulate): ' + pruneError);
			}
			// Only cache the result if the fetch settings didn't change while the pipeline was running
			this.store.setIfCurrent(repo, entry, generation);
			return entry;
		} catch (errorMessage) {
			this.deps.logger.log('Fetching the Gerrit changes failed: ' + errorMessage);
			return null;
		}
	}

	/**
	 * Build a Gerrit cache entry from the locally cached change refs
	 * (`refs/remotes/<remote>/changes/*`) of a repository, WITHOUT any network access. This makes
	 * Gerrit data fetched previously available instantly (and offline), until the next refresh
	 * re-fetches it from the remote.
	 * @returns The cache entry, or NULL if the repository has no local change refs.
	 */
	private async buildLocalGerritEntry(repo: string, fetchLimit: number): Promise<GerritCacheEntry | null> {
		const remote = this.deps.getConfig().gerrit.remote, gerrit = this.deps.gerrit;
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
			this.deps.logger.log('Building the Gerrit data from the local change refs failed: ' + errorMessage);
			return null;
		}
	}

	/**
	 * The Gerrit change refs injected into the commit graph: the latest patchset ref of every change
	 * the fetch limit selects (see `limitChangeStates`). The graph pins the injected commits onto
	 * the page, so each of them carries its badge whatever its age.
	 */
	private gerritChangeRefs(cache: GerritCacheEntry, statusFilter: GerritStatusFilter): string[] {
		const remote = this.deps.getConfig().gerrit.remote;
		const refs: string[] = [];
		for (const state of limitChangeStates(cache.states, statusFilter, cache.fetchLimit)) {
			const patchsets = cache.patchsets.get(state.change);
			if (patchsets === undefined) continue;
			refs.push('refs/remotes/' + remote + '/changes/' + changeShard(state.change) + '/' + state.change + '/' + patchsets[patchsets.length - 1]);
		}
		return refs;
	}

	/**
	 * The Gerrit states sent with a loaded page: every cached state, the event timelines riding
	 * along the DISPLAYED changes only - the `fetchLimit` most recent changes passing the status
	 * filter whose head commit is on the page (see `selectDisplayedChangeStates`; the Webview
	 * repeats this selection per render, so the badges it shows are exactly these). The states
	 * beyond them ride along LIGHT (without their event timelines): they let the Webview toggle
	 * the status filter and re-select instantly, and the timelines of a change that becomes
	 * visible arrive with the reload the toggle triggers.
	 */
	private gerritPageStates(cache: GerritCacheEntry, statusFilter: GerritStatusFilter, commitData: GitCommitData): GerritChangeState[] {
		const onPage = new Set(commitData.commits.map((commit) => commit.hash));
		const displayed = new Set(selectDisplayedChangeStates(cache.states, statusFilter, cache.fetchLimit, (hash) => onPage.has(hash)).map((state) => state.change));
		return cache.states.map((state) => displayed.has(state.change) ? state : { ...state, events: [], eventsPending: true });
	}
}

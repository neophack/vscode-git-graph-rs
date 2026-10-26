import type { GerritChangeState } from '../../../shared/model/gerrit';

/**
 * The cached (unfiltered) Gerrit data of a repository: the states and their patchsets as
 * `GerritDataSource` derived them, under the fetch limit they were fetched under. Ported from
 * GitGraphView's `GerritCacheEntry` (src/gitGraphView.ts).
 */
export interface GerritCacheEntry {
	states: GerritChangeState[];
	patchsets: Map<number, number[]>;
	/**
	 * The fetch limit this entry was fetched under (the changes themselves over-sample it
	 * adaptively - see `GERRIT_FETCH_WINDOW_FACTOR` / `nextGerritSampleWindow`): a request under
	 * a different limit re-fetches.
	 */
	fetchLimit: number;
}

/**
 * The per-repository Gerrit caches of the graph view's staged loading pipeline (REFACTOR-PLAN
 * task 4.3), extracted from GitGraphView's `gerritCache` / `gerritFetches` / `gerritStaleRepos`
 * / `gerritCacheGeneration` fields. The entry holds the UNFILTERED states (switching the status
 * filter re-renders instantly); entries are rebuilt from the locally fetched change refs without
 * any network access, and only refreshed from the remote for a repository the user explicitly
 * asked to fetch (the Fetch button, enabling the integration, or changing its fetch settings) -
 * a plain view load or a hard refresh never touches the network.
 */
export class GerritCacheStore {
	private readonly entries = new Map<string, GerritCacheEntry>();
	/** The Gerrit fetch currently in progress per repository, so concurrent loads share one fetch. */
	private readonly fetches = new Map<string, Promise<GerritCacheEntry | null>>();
	/** Repositories whose cached Gerrit data must be re-fetched from the remote on the next load. */
	private readonly staleRepos = new Set<string>();
	/** Incremented whenever the Gerrit fetch settings change, so stale in-flight fetches don't repopulate the cache. */
	private generation = 0;

	public get(repo: string): GerritCacheEntry | undefined {
		return this.entries.get(repo);
	}

	public has(repo: string): boolean {
		return this.entries.has(repo);
	}

	public set(repo: string, entry: GerritCacheEntry): void {
		this.entries.set(repo, entry);
	}

	public delete(repo: string): void {
		this.entries.delete(repo);
	}

	public isStale(repo: string): boolean {
		return this.staleRepos.has(repo);
	}

	/** Mark the repository's cached Gerrit data stale: a fetch may have updated its change refs. */
	public markStale(repo: string): void {
		this.staleRepos.add(repo);
	}

	public unmarkStale(repo: string): void {
		this.staleRepos.delete(repo);
	}

	/** The current fetch-settings generation (captured by a fetch when it starts). */
	public get currentGeneration(): number {
		return this.generation;
	}

	/**
	 * Store an entry only when the fetch settings did not change while its pipeline was running
	 * (the generation it captured still matches): a stale in-flight fetch must not repopulate the
	 * cache under settings the user has already left.
	 */
	public setIfCurrent(repo: string, entry: GerritCacheEntry, generation: number): void {
		if (generation === this.generation) this.entries.set(repo, entry);
	}

	/**
	 * Serve (or start) the Gerrit fetch of a repository: concurrent loads of the same repository
	 * share one in-flight fetch; the entry is removed again whichever way it settles.
	 */
	public dedupeFetch(repo: string, run: () => Promise<GerritCacheEntry | null>): Promise<GerritCacheEntry | null> {
		const existing = this.fetches.get(repo);
		if (existing !== undefined) return existing;
		const fetch = run().then((entry) => {
			this.fetches.delete(repo);
			return entry;
		}, (error) => {
			this.fetches.delete(repo);
			throw error;
		});
		this.fetches.set(repo, fetch);
		return fetch;
	}

	/**
	 * Drop every cached Gerrit datum and mark all repositories that had one stale: the fetch
	 * settings (remote, fetch limit) changed. Ported from GitGraphView's `clearGerritCaches`.
	 */
	public clearAll(): void {
		for (const repo of this.entries.keys()) this.staleRepos.add(repo);
		this.entries.clear();
		this.fetches.clear();
		this.generation++;
	}
}

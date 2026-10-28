import { describe, expect, it } from 'vitest';
import type { GerritChangeState } from '../../../shared/model/gerrit';
import type { GerritCacheEntry } from './gerritCache';
import { GerritCacheStore } from './gerritCache';

/** The Gerrit cache store: staleness, the settings generation, and fetch dedupe. */

function entry(change: number): GerritCacheEntry {
	return { states: [state(change)], patchsets: new Map([[change, [1, 2]]]), fetchLimit: 20 };
}

function state(change: number): GerritChangeState {
	return {
		change: change, patchset: 2, codeReview: 0, verified: 0, status: 'new', wip: false,
		headHash: 'c' + change, events: [], url: null
	};
}

describe('GerritCacheStore', () => {
	it('stores and drops entries per repository', () => {
		const store = new GerritCacheStore();
		store.set('/repo', entry(1001));
		expect(store.has('/repo')).toBe(true);
		expect(store.get('/repo')!.fetchLimit).toBe(20);
		store.delete('/repo');
		expect(store.has('/repo')).toBe(false);
	});

	it('tracks the stale flag per repository', () => {
		const store = new GerritCacheStore();
		expect(store.isStale('/repo')).toBe(false);
		store.markStale('/repo');
		expect(store.isStale('/repo')).toBe(true);
		store.unmarkStale('/repo');
		expect(store.isStale('/repo')).toBe(false);
	});

	it('clearAll marks every previously cached repository stale, drops the entries and bumps the generation', () => {
		const store = new GerritCacheStore();
		store.set('/a', entry(1001));
		store.set('/b', entry(1002));
		const generation = store.currentGeneration;
		store.clearAll();
		expect(store.has('/a')).toBe(false);
		expect(store.has('/b')).toBe(false);
		expect(store.isStale('/a')).toBe(true); // the next load of each re-fetches from the remote
		expect(store.isStale('/b')).toBe(true);
		expect(store.currentGeneration).toBe(generation + 1);
	});

	it('setIfCurrent ignores an entry whose fetch started before a settings change', () => {
		const store = new GerritCacheStore();
		const staleGeneration = store.currentGeneration;
		store.clearAll(); // the fetch settings changed while the pipeline was running
		store.setIfCurrent('/repo', entry(1001), staleGeneration);
		expect(store.has('/repo')).toBe(false);
		store.setIfCurrent('/repo', entry(1001), store.currentGeneration);
		expect(store.has('/repo')).toBe(true);
	});

	it('dedupeFetch shares one in-flight run between concurrent callers and clears it on settle', async () => {
		const store = new GerritCacheStore();
		let started = 0;
		const run = () => {
			started++;
			return new Promise<GerritCacheEntry | null>((resolve) => setTimeout(() => resolve(entry(1001)), 10));
		};
		const first = store.dedupeFetch('/repo', run);
		const second = store.dedupeFetch('/repo', run);
		expect(second).toBe(first); // the concurrent load joins the in-flight fetch
		expect(started).toBe(1);
		expect(await first).toEqual(entry(1001));
		// settled: the next fetch starts a fresh run
		const third = store.dedupeFetch('/repo', run);
		expect(third).not.toBe(first);
		expect(started).toBe(2);
		await third;
	});

	it('dedupeFetch clears the in-flight entry when the run rejects', async () => {
		const store = new GerritCacheStore();
		const run = () => Promise.reject(new Error('boom'));
		const first = store.dedupeFetch('/repo', run);
		await expect(first).rejects.toThrow('boom');
		const second = store.dedupeFetch('/repo', () => Promise.resolve(entry(1001)));
		await expect(second).resolves.toEqual(entry(1001)); // no stuck entry from the failed run
	});

	it('a superseded fetch does not unregister the newer one a clearAll re-registration holds', async () => {
		const store = new GerritCacheStore();
		let started = 0;
		const start = () => {
			started++;
			return new Promise<GerritCacheEntry | null>((resolve) => setTimeout(() => resolve(entry(started)), 10));
		};
		const old = store.dedupeFetch('/repo', start);
		store.clearAll(); // the fetch settings changed: the map is emptied, but the fetch still runs
		const fresh = store.dedupeFetch('/repo', start);
		expect(fresh).not.toBe(old); // the new load starts its own fetch
		await old;
		// the superseded fetch settling must not drop the newer one's registration, or a third
		// load would start ANOTHER concurrent fetch instead of joining the running one
		const third = store.dedupeFetch('/repo', start);
		expect(third).toBe(fresh);
		expect(started).toBe(2);
		await Promise.all([fresh, third]);
	});

	it('unmarkStaleIfCurrent clears the stale flag only under the fetch settings it was fetched under', () => {
		const store = new GerritCacheStore();
		store.set('/repo', entry(1001));
		const staleGeneration = store.currentGeneration;
		store.clearAll(); // marks /repo stale and bumps the generation
		expect(store.isStale('/repo')).toBe(true);

		store.unmarkStaleIfCurrent('/repo', staleGeneration); // the superseded fetch settles
		expect(store.isStale('/repo')).toBe(true); // still stale: the next load must re-fetch

		store.unmarkStaleIfCurrent('/repo', store.currentGeneration); // a fetch under the new settings settles
		expect(store.isStale('/repo')).toBe(false);
	});
});

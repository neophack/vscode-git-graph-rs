import { describe, expect, it } from 'vitest';
import type { GitCommitData } from '../../git/read/types';
import { CommitOrdering } from '../../../types';
import type { RequestLoadCommits } from '../../../types';
import { CommitPageCache, commitPageCacheKey } from './commitPageCache';

/** The commit-page cache and its key, ported from GitGraphView (task 4.3): the bound, the
 * error-result rule, and the exact key sensitivity of the live `commitsCacheKey`. */

function page(commits: string[], error: string | null = null): GitCommitData {
	return { commits: commits.map((hash) => ({ hash, parents: [], author: '', email: '', date: 0, message: '', heads: [], tags: [], remotes: [], stash: null })), head: null, tags: [], branches: [], moreCommitsAvailable: false, error: error };
}

function request(overrides: Partial<RequestLoadCommits> = {}): RequestLoadCommits {
	return {
		command: 'loadCommits', repo: '/repo', refreshId: 1, hard: false, branches: null, authors: null,
		maxCommits: 1000, showTags: true, showRemoteBranches: true, includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false, commitOrdering: CommitOrdering.Date, remotes: [], hideRemotes: [],
		stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
		gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true }, filterPath: null,
		...overrides
	};
}

describe('CommitPageCache', () => {
	it('serves a stored page by key', async () => {
		const cache = new CommitPageCache(32);
		const promise = cache.put('k', () => Promise.resolve(page(['a'])));
		await promise;
		expect(cache.get('k')).toBe(promise); // the SAME promise: concurrent identical requests share one load
		expect(cache.size).toBe(1);
	});

	it('evicts the OLDEST INSERTED entry at the bound (access does not refresh an entry)', async () => {
		const cache = new CommitPageCache(2);
		await cache.put('a', () => Promise.resolve(page(['a'])));
		await cache.put('b', () => Promise.resolve(page(['b'])));
		expect(cache.get('a')).toBeDefined(); // read the oldest: insertion order still governs eviction
		await cache.put('c', () => Promise.resolve(page(['c'])));
		expect(cache.get('a')).toBeUndefined(); // evicted despite the recent read
		expect(cache.get('b')).toBeDefined();
		expect(cache.get('c')).toBeDefined();
		expect(cache.size).toBe(2);
	});

	it('removes an entry that resolved with an error result (errors may be transient)', async () => {
		const cache = new CommitPageCache(32);
		await cache.put('k', () => Promise.resolve(page([], 'git failed')));
		expect(cache.get('k')).toBeUndefined();
	});

	it('keeps an error-result entry that a newer load has already replaced', async () => {
		const cache = new CommitPageCache(32);
		const failing = cache.put('k', () => Promise.resolve(page([], 'transient')));
		await cache.put('k', () => Promise.resolve(page(['a']))); // replaces the entry before it settles
		await failing;
		expect(cache.get('k')).toBeDefined(); // the newer good entry survives
	});

	it('clear() drops everything', async () => {
		const cache = new CommitPageCache(32);
		await cache.put('k', () => Promise.resolve(page(['a'])));
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get('k')).toBeUndefined();
	});
});

describe('commitPageCacheKey', () => {
	it('is sensitive to every request field the live key includes', () => {
		const base = commitPageCacheKey(request(), null, true, false);
		const variants: RequestLoadCommits[] = [
			request({ repo: '/other' }),
			request({ branches: ['main'] }),
			request({ authors: ['A <a@x>'] }),
			request({ maxCommits: 500 }),
			request({ showTags: false }),
			request({ showRemoteBranches: false }),
			request({ includeCommitsMentionedByReflogs: true }),
			request({ onlyFollowFirstParent: true }),
			request({ commitOrdering: CommitOrdering.Topological }),
			request({ remotes: ['origin'] }),
			request({ hideRemotes: ['origin'] }),
			request({ stashes: [{ hash: 's', baseHash: 'b', untrackedFilesHash: null, selector: 'stash@{0}', author: '', email: '', date: 0, message: '' }] }),
			request({ filterPath: 'src' })
		];
		for (const variant of variants) expect(commitPageCacheKey(variant, null, true, false), JSON.stringify(variant)).not.toBe(base);
	});

	it('is sensitive to the gerrit refs and both deferral flags (a deferred page is a strictly smaller answer)', () => {
		const msg = request();
		const base = commitPageCacheKey(msg, null, false, false);
		expect(commitPageCacheKey(msg, ['refs/remotes/gerrit/changes/01/100/2'], false, false)).not.toBe(base);
		expect(commitPageCacheKey(msg, null, true, false)).not.toBe(base);
		expect(commitPageCacheKey(msg, null, false, true)).not.toBe(base);
	});

	it('ignores the refresh id and the hard flag (identical re-requests share the cached page)', () => {
		expect(commitPageCacheKey(request({ refreshId: 7 }), null, false, false)).toBe(commitPageCacheKey(request({ refreshId: 8 }), null, false, false));
	});

	it('treats an undefined filterPath like null (the live key normalises both)', () => {
		expect(commitPageCacheKey(request({ filterPath: undefined }), null, false, false)).toBe(commitPageCacheKey(request({ filterPath: null }), null, false, false));
	});
});

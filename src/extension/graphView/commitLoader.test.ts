import { describe, expect, it } from 'vitest';
import type { GitCommitData, GitCommit as BackendGitCommit } from '../git/read/types';
import type { CommitDataPort, CommitLoadQuery, CommitLoaderConfig, GerritDataPort, RepoInfoHalf, UncommittedReading, UncommittedStabiliser } from './commitLoader';
import { CommitLoader } from './commitLoader';
import { remoteRefsFollowUpChanged } from './followUpChange';
import { CommitOrdering } from '../../types';
import type { GerritChangeState, RequestLoadCommits, ResponseLoadCommits } from '../../types';

/**
 * CommitLoader tests (REFACTOR-PLAN task 4.3): the staged follow-up orders (plain / Gerrit /
 * delayed remote refs / delayed uncommitted), stale-follow-up suppression, cache hits and
 * invalidation, and the follow-up error contract (an error response, never an unhandled
 * rejection). Everything is driven through fakes - no Git, no vscode.
 */

/* ---------- Fixtures ---------- */

function commit(hash: string, remotes: { name: string, remote: string | null }[] = []): BackendGitCommit {
	return { hash: hash, parents: [], author: 'A', email: 'a@x', date: 1, message: 'm', heads: [], tags: [], remotes: remotes, stash: null };
}

function page(commits: BackendGitCommit[], options: { head?: string | null, branches?: string[] } = {}): GitCommitData {
	return {
		commits: commits,
		head: options.head !== undefined ? options.head : (commits.length > 0 ? commits[0].hash : null),
		tags: [],
		branches: options.branches ?? ['main'],
		moreCommitsAvailable: false,
		error: null
	};
}

function gerritState(change: number): GerritChangeState {
	return {
		change: change, patchset: 2, codeReview: 2, verified: 0, status: 'new', wip: false,
		headHash: 'c' + change, events: [{ type: 'created', patchset: 1, timestamp: 1, raw: '', rawFull: '' }],
		url: null
	};
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

/** Flush every pending microtask/macrotask hop of the detached follow-up chains. */
async function flush(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/* ---------- Fakes ---------- */

class FakeReads {
	public readonly commitsQueries: CommitLoadQuery[] = [];
	public readonly uncommittedCalls: string[] = [];
	public uncommitted: number | Promise<number> = 0;
	public getCommitsHandler: (query: CommitLoadQuery) => Promise<GitCommitData> = () => Promise.resolve(page([commit('a')]));

	public getCommits(repo: string, query: CommitLoadQuery, _signal?: { readonly aborted: boolean }): Promise<GitCommitData> {
		expect(repo).toBe('/repo');
		this.commitsQueries.push(query);
		return this.getCommitsHandler(query);
	}

	public getRepoInfo(_repo: string, _options: unknown): Promise<RepoInfoHalf> {
		return Promise.resolve({
			branches: ['main'], head: 'main', remotes: [], stashes: [], tags: [], error: null,
			isRepo: true, operationState: { type: null, conflictedFiles: [], progress: null }
		});
	}

	public getOperationState(_repo: string): Promise<{ type: null; conflictedFiles: string[]; progress: null }> {
		return Promise.resolve({ type: null, conflictedFiles: [], progress: null });
	}

	public getUncommittedChanges(repo: string): Promise<number> {
		this.uncommittedCalls.push(repo);
		return typeof this.uncommitted === 'number' ? Promise.resolve(this.uncommitted) : this.uncommitted;
	}
}

class FakeGerrit {
	public readonly calls: string[] = [];
	public readonly fetchedRefspecs: string[][] = [];
	public remoteChanges: Map<number, number[]> = new Map();
	public localRefs: string[] = [];
	public states: Map<number, GerritChangeState> = new Map();
	public fetchError: string | null = null;

	listRemoteChanges(): Promise<Map<number, number[]>> { this.calls.push('listRemoteChanges'); return Promise.resolve(this.remoteChanges); }
	fetchChanges(_repo: string, _remote: string, refspecs: ReadonlyArray<string>): Promise<string | null> { this.calls.push('fetchChanges'); this.fetchedRefspecs.push(refspecs.slice()); return Promise.resolve(this.fetchError); }
	listLocalChangeRefs(): Promise<string[]> { this.calls.push('listLocalChangeRefs'); return Promise.resolve(this.localRefs); }
	pruneLocalChanges(): Promise<string | null> { this.calls.push('pruneLocalChanges'); return Promise.resolve(null); }
	parseMetas(_repo: string, _remote: string, changes: ReadonlyArray<number>, _urlBase: string | null): Promise<Map<number, GerritChangeState | null>> {
		this.calls.push('parseMetas');
		const parsed = new Map<number, GerritChangeState | null>();
		for (const change of changes) {
			const state = this.states.get(change);
			if (state !== undefined) parsed.set(change, state);
		}
		return Promise.resolve(parsed);
	}
	getChangeUrlBase(): Promise<string | null> { this.calls.push('getChangeUrlBase'); return Promise.resolve('https://gerrit.example/c'); }
}

/** The stabiliser with scriptable outcomes: queued readings are consumed first, then the default immediate decision. */
class RecordingStabiliser implements UncommittedStabiliser {
	public readonly queued: UncommittedReading[] = [];
	public readonly deliveredCounts: number[] = [];
	public resets = 0;

	public observe(count: number | null, _now: number): UncommittedReading {
		const queued = this.queued.shift();
		if (queued !== undefined) return queued;
		return count === null ? { recheckAfterMs: 1000 } : { send: count };
	}

	public delivered(count: number): void { this.deliveredCounts.push(count); }
	public reset(): void { this.resets++; }
}

class Harness {
	public readonly sent: ResponseLoadCommits[] = [];
	public readonly reads = new FakeReads();
	public readonly gerrit = new FakeGerrit();
	public readonly stabiliser = new RecordingStabiliser();
	public readonly logs: string[] = [];
	public readonly errors: string[] = [];
	public readonly sleeps: number[] = [];
	public clock = 1000;
	public config: CommitLoaderConfig & { showRemoteHeads: boolean } = { showUncommittedChanges: true, showRemoteHeads: false, gerrit: { remote: 'gerrit', fetchLimit: 20 } };
	public readonly loader: CommitLoader;

	constructor() {
		this.loader = new CommitLoader({
			reads: this.reads as unknown as CommitDataPort,
			gerrit: this.gerrit as GerritDataPort,
			getConfig: () => this.config,
			logger: { log: (message) => this.logs.push(message), logError: (message) => this.errors.push(message) },
			formatUncommittedRow: (count) => 'Uncommitted Changes (' + count + ')',
			stabiliser: this.stabiliser,
			now: () => this.clock,
			sleep: (ms) => { this.sleeps.push(ms); return Promise.resolve(); }
		});
	}

	public send = (response: ResponseLoadCommits): void => { this.sent.push(response); };
}

/** A Gerrit-enabled harness: change 1001 on the remote, its meta parseable, head commit c1001 on the injected page. */
function gerritHarness(): Harness {
	const h = new Harness();
	h.gerrit.remoteChanges = new Map([[1001, [1, 2]]]);
	h.gerrit.states.set(1001, gerritState(1001));
	const deferred = page([commit('a')]);
	const complete = page([commit('a', [{ name: 'origin/main', remote: 'origin' }])], { branches: ['main', 'remotes/origin/main'] });
	const withChange = page([commit('c1001'), commit('a')], { head: 'a', branches: ['main', 'remotes/origin/main'] });
	h.reads.getCommitsHandler = (query) => Promise.resolve(query.gerritRefs !== null ? withChange : (query.deferRemoteRefs ? deferred : complete));
	h.reads.uncommitted = 1;
	return h;
}

/* ---------- Tests ---------- */

describe('CommitLoader staged responses', () => {
	it('plain load: initial response, then the uncommitted row prepended above HEAD', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a'), commit('b')], { head: 'a' }));
		h.reads.uncommitted = 3;
		await h.loader.loadCommits(request({ showRemoteBranches: false }), h.send);
		await flush();

		expect(h.sent.length).toBe(2);
		expect(h.sent[0]).toMatchObject({ command: 'loadCommits', refreshId: 1, gerritStates: null, uncommittedPending: true, head: 'a', error: null });
		expect(h.sent[0].commits.map((c) => c.hash)).toEqual(['a', 'b']);
		expect(h.sent[0].uncommittedCount).toBeUndefined();

		expect(h.sent[1].uncommittedPending).toBeUndefined();
		expect(h.sent[1].uncommittedCount).toBe(3);
		expect(h.sent[1].commits.map((c) => c.hash)).toEqual(['*', 'a', 'b']);
		expect(h.sent[1].commits[0]).toMatchObject({ parents: ['a'], author: '*', email: '', message: 'Uncommitted Changes (3)' });
		expect(h.sent[1].gerritStates).toBeNull();
		// One page read (no remote follow-up without remote branches), one status read
		expect(h.reads.commitsQueries.length).toBe(1);
		expect(h.reads.uncommittedCalls).toEqual(['/repo']);
	});

	it('plain load with zero uncommitted changes: the final response keeps the commit list unchanged', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a')]));
		h.reads.uncommitted = 0;
		await h.loader.loadCommits(request({ showRemoteBranches: false }), h.send);
		await flush();

		expect(h.sent.length).toBe(2);
		expect(h.sent[1].uncommittedCount).toBe(0);
		expect(h.sent[1].commits.map((c) => c.hash)).toEqual(['a']);
	});

	it('delayed remote refs: the deferred page first, the complete page as a follow-up', async () => {
		const h = new Harness();
		const deferred = page([commit('a')]);
		const complete = page([commit('a', [{ name: 'origin/main', remote: 'origin' }])], { branches: ['main', 'remotes/origin/main'] });
		h.reads.getCommitsHandler = (query) => Promise.resolve(query.deferRemoteRefs ? deferred : complete);
		h.reads.uncommitted = 0;
		await h.loader.loadCommits(request(), h.send); // the view is empty: remote refs are deferred
		await flush();

		// The first read skipped the remote refs; the follow-up read them
		expect(h.reads.commitsQueries.map((query) => query.deferRemoteRefs)).toEqual([true, false]);

		expect(h.sent.length).toBe(3);
		expect(h.sent[0].commits[0].remotes).toEqual([]); // local-only first paint
		expect(h.sent[0].branches).toEqual(['main']);
		expect(h.sent[1].commits[0].remotes).toEqual([{ name: 'origin/main', remote: 'origin' }]);
		expect(h.sent[1].branches).toEqual(['main', 'remotes/origin/main']);
		expect(h.sent[1].uncommittedPending).toBe(true);
		expect(h.sent[2].uncommittedCount).toBe(0);
		expect(h.sent[2].commits).toEqual(complete.commits); // the row follow-up builds on the COMPLETE page
	});

	it('Gerrit enabled (cache miss): pending initial response, then remote refs, badges, timelines, uncommitted row', async () => {
		const h = gerritHarness();
		await h.loader.loadCommits(request({ gerritFetchRefs: true, gerritFetchLimit: 1 }), h.send);
		await flush();

		expect(h.sent.length).toBe(5);
		for (const response of h.sent) expect(response.command).toBe('loadCommits');

		// 1. initial: no Gerrit data yet, both follow-ups pending
		expect(h.sent[0]).toMatchObject({ refreshId: 1, gerritPending: true, gerritStates: null, uncommittedPending: true });
		expect(h.sent[0].commits.map((c) => c.hash)).toEqual(['a']);
		// 2. remote refs follow-up (no Gerrit states to preserve yet)
		expect(h.sent[1].gerritStates).toBeNull();
		expect(h.sent[1].commits[0].remotes).toEqual([{ name: 'origin/main', remote: 'origin' }]);
		// 3. Gerrit stage 1 - badges: light states (no event timelines) on the change-ref-injected page
		expect(h.sent[2].commits.map((c) => c.hash)).toEqual(['c1001', 'a']);
		expect(h.sent[2].uncommittedPending).toBe(true);
		expect(h.sent[2].gerritStates!.length).toBe(1);
		expect(h.sent[2].gerritStates![0].eventsPending).toBe(true);
		expect(h.sent[2].gerritStates![0].events).toEqual([]);
		// 4. Gerrit stage 2 - review information: the full states on the unchanged page
		expect(h.sent[3].commits.map((c) => c.hash)).toEqual(['c1001', 'a']);
		expect(h.sent[3].gerritStates![0].events.length).toBe(1);
		expect(h.sent[3].gerritStates![0].eventsPending).toBeUndefined();
		// 5. the uncommitted row last, on the page and states the Gerrit stages rendered
		expect(h.sent[4].uncommittedCount).toBe(1);
		expect(h.sent[4].commits.map((c) => c.hash)).toEqual(['*', 'c1001', 'a']);
		expect(h.sent[4].gerritStates![0].events.length).toBe(1);

		// The fetch pipeline ran the expected reads: local refs, ls-remote, url base, targeted fetch, metas, prune
		expect(h.gerrit.calls).toEqual(['listLocalChangeRefs', 'listRemoteChanges', 'getChangeUrlBase', 'fetchChanges', 'parseMetas', 'pruneLocalChanges']);
		expect(h.gerrit.fetchedRefspecs[0].join(' ')).toContain('refs/changes/01/1001/2'); // the LATEST patchset of the change
	});

	it('Gerrit cache hit: the second load serves the cached states without touching the remote', async () => {
		const h = gerritHarness();
		await h.loader.loadCommits(request({ gerritFetchRefs: true, gerritFetchLimit: 1 }), h.send);
		await flush();
		const readsAfterFirstLoad = h.reads.commitsQueries.length;
		expect(h.gerrit.calls.filter((call) => call === 'listRemoteChanges').length).toBe(1);

		h.reads.uncommitted = 0;
		await h.loader.loadCommits(request({ gerritFetchRefs: true, gerritFetchLimit: 1, refreshId: 2 }), h.send);
		await flush();

		// The remote was contacted once in total; every page came from the commit cache
		expect(h.gerrit.calls.filter((call) => call === 'listRemoteChanges').length).toBe(1);
		expect(h.reads.commitsQueries.length).toBe(readsAfterFirstLoad);

		const secondLoad = h.sent.filter((response) => response.refreshId === 2);
		expect(secondLoad.length).toBe(2); // initial + uncommitted final (the identical remote follow-up is skipped)
		expect(secondLoad[0].gerritStates!.length).toBe(1);
		expect(secondLoad[0].gerritPending).toBeUndefined();
		expect(secondLoad[1].uncommittedCount).toBe(0);
		expect(secondLoad[1].gerritStates!.length).toBe(1);
	});

	it('Gerrit pipeline failure degrades to the plain view instead of failing the load', async () => {
		const h = gerritHarness();
		h.gerrit.fetchError = 'network down';
		await h.loader.loadCommits(request({ gerritFetchRefs: true, gerritFetchLimit: 1 }), h.send);
		await flush();

		// initial, remote follow-up, the failed-pipeline degradation stage, the uncommitted final
		expect(h.sent.length).toBe(4);
		expect(h.sent[2].gerritStates).toBeNull(); // the degradation stage: no Gerrit data
		expect(h.sent[3].uncommittedCount).toBe(1);
		expect(h.sent[3].gerritStates).toBeNull();
		expect(h.sent.every((response) => response.error === null)).toBe(true); // a degraded load is not an error
	});
});

describe('CommitLoader cancellation', () => {
	it('a newer request suppresses the superseded run\'s follow-ups', async () => {
		const h = new Harness();
		const deferred = page([commit('a')]);
		const bPage = page([commit('x'), commit('a')], { head: 'a' });
		let gatedUsed = false;
		let releaseComplete: (value: GitCommitData) => void = () => undefined;
		const completeGate = new Promise<GitCommitData>((resolve) => { releaseComplete = resolve; });
		h.reads.getCommitsHandler = (query) => {
			if (query.deferRemoteRefs) return Promise.resolve(deferred);
			if (!gatedUsed) { gatedUsed = true; return completeGate; } // the first request's slow complete read
			return Promise.resolve(bPage);
		};
		h.reads.uncommitted = 0;

		await h.loader.loadCommits(request({ refreshId: 1 }), h.send); // initial response sent, follow-up gated
		await h.loader.loadCommits(request({ refreshId: 2, hard: true }), h.send); // supersedes the first run
		releaseComplete(page([commit('a'), commit('b')])); // the first run's read settles AFTER the supersede
		await flush();

		const superseded = h.sent.filter((response) => response.refreshId === 1);
		expect(superseded.length).toBe(1); // only its initial response: no follow-ups, no error
		expect(h.sent.every((response) => response.error === null)).toBe(true);
		const current = h.sent.filter((response) => response.refreshId === 2);
		expect(current.length).toBe(2); // the newer request's initial + final responses completed
		// Quirk kept from the live pipeline: the superseded run still performs ONE status read
		// (the live code read the count before its staleness check); one more belongs to the new run
		expect(h.reads.uncommittedCalls.length).toBe(2);
	});

	it('dispose() aborts the current run and refuses further loads', async () => {
		const h = new Harness();
		let release: (value: GitCommitData) => void = () => undefined;
		h.reads.getCommitsHandler = () => new Promise<GitCommitData>((resolve) => { release = resolve; });
		const first = h.loader.loadCommits(request(), h.send);
		h.loader.dispose();
		release(page([commit('a')])); // the disposed run's read settles after the disposal
		await first; // resolves without a response (the run was disposed, not crashed)
		await flush();
		expect(h.sent).toEqual([]);
		await h.loader.loadCommits(request({ refreshId: 2 }), h.send);
		expect(h.sent).toEqual([]);
	});
});

describe('CommitLoader cache', () => {
	it('serves identical requests from the cache; hard refreshes and invalidation bypass it', async () => {
		const h = new Harness();
		let loads = 0;
		h.reads.getCommitsHandler = () => { loads++; return Promise.resolve(page([commit('a')])); };

		await h.loader.loadCommits(request({ showRemoteBranches: false, refreshId: 1 }), h.send);
		await flush();
		expect(loads).toBe(1);

		await h.loader.loadCommits(request({ showRemoteBranches: false, refreshId: 2 }), h.send);
		await flush();
		expect(loads).toBe(1); // cache hit: identical request

		await h.loader.loadCommits(request({ showRemoteBranches: false, refreshId: 3, hard: true }), h.send);
		await flush();
		expect(loads).toBe(2); // a hard refresh bypasses the cache

		h.loader.invalidateCommitCache();
		await h.loader.loadCommits(request({ showRemoteBranches: false, refreshId: 4 }), h.send);
		await flush();
		expect(loads).toBe(3); // a repo-mutating command dropped the pages

		h.loader.configChanged();
		await h.loader.loadCommits(request({ showRemoteBranches: false, refreshId: 5 }), h.send);
		await flush();
		expect(loads).toBe(4); // a configuration change dropped the pages (settings outside the key)
	});

	it('a deferred load prefers a cached COMPLETE page over a smaller deferred one', async () => {
		const h = new Harness();
		const deferred = page([commit('a')]);
		const complete = page([commit('a', [{ name: 'origin/main', remote: 'origin' }])], { branches: ['main', 'remotes/origin/main'] });
		h.reads.getCommitsHandler = (query) => Promise.resolve(query.deferRemoteRefs ? deferred : complete);

		await h.loader.loadCommits(request({ refreshId: 1 }), h.send); // empty view: defers, caches both pages
		await flush();
		const reads = h.reads.commitsQueries.length;

		h.loader.viewRepoChanged(); // the view empties again: the next load would defer
		await h.loader.loadCommits(request({ refreshId: 2 }), h.send);
		await flush();

		// No new read: the deferred request was served the CACHED complete page (deferral only
		// pays when there is nothing complete to serve)
		expect(h.reads.commitsQueries.length).toBe(reads);
		const secondLoad = h.sent.filter((response) => response.refreshId === 2);
		expect(secondLoad[0].commits[0].remotes).toEqual([{ name: 'origin/main', remote: 'origin' }]);
	});

	it('viewRepoChanged resets the remote-refs deferral and the stabiliser (the repo-switch block)', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a')]));
		await h.loader.loadCommits(request({ refreshId: 1 }), h.send);
		await flush();
		expect(h.reads.commitsQueries[h.reads.commitsQueries.length - 1].deferRemoteRefs).toBe(false); // the follow-up read them

		h.loader.viewRepoChanged();
		expect(h.stabiliser.resets).toBe(1);
		await h.loader.loadCommits(request({ refreshId: 2, hard: true }), h.send);
		await flush();
		expect(h.reads.commitsQueries[h.reads.commitsQueries.length - 2].deferRemoteRefs).toBe(true); // the view is empty again: deferral is back
	});
});

describe('CommitLoader error contract', () => {
	it('a follow-up read that rejects is answered with an error response, not an unhandled rejection', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
		process.on('unhandledRejection', onUnhandled);
		try {
			const h = new Harness();
			h.reads.getCommitsHandler = (query) => query.deferRemoteRefs
				? Promise.resolve(page([commit('a')]))
				: Promise.reject(new Error('boom'));
			h.reads.uncommitted = 0;

			await h.loader.loadCommits(request(), h.send);
			await flush();

			expect(h.sent.length).toBe(2);
			expect(h.sent[0].error).toBeNull(); // the initial response had already been sent
			expect(h.sent[1].error).toBe('boom');
			expect(h.sent[1].commits).toEqual([]);
			expect(h.errors.length).toBe(1); // logged, too
			await flush(5);
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('an error in the INITIAL read is answered with an error response', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.reject(new Error('git missing'));
		await h.loader.loadCommits(request({ showRemoteBranches: false }), h.send);
		await flush();
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].error).toBe('git missing');
		expect(h.sent[0].commits).toEqual([]);
	});

	it('a failing status read delivers nothing (unknown is not zero)', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a')]));
		h.reads.uncommitted = Promise.reject(new Error('status failed'));
		await h.loader.loadCommits(request({ showRemoteBranches: false }), h.send);
		await flush();
		expect(h.sent.length).toBe(1); // the initial response only: no count was invented
		expect(h.sent[0].error).toBeNull();
	});
});

describe('CommitLoader uncommitted stabilisation', () => {
	it('a held reading is re-read after the stabiliser\'s delay, then delivered', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a')]));
		h.stabiliser.queued.push({ recheckAfterMs: 1500 }); // first reading is held...
		const readings: Array<number | Promise<number>> = [2, 5];
		h.reads.uncommitted = 0;
		h.reads.getUncommittedChanges = (repo) => {
			h.reads.uncommittedCalls.push(repo);
			const reading = readings.shift();
			if (reading === undefined) return Promise.resolve(0);
			return typeof reading === 'number' ? Promise.resolve(reading) : reading;
		};
		await h.loader.loadCommits(request({ showRemoteBranches: false }), h.send);
		await flush();

		expect(h.sleeps).toEqual([1500]); // the pipeline waited exactly the stabiliser's delay
		expect(h.reads.uncommittedCalls.length).toBe(2); // and re-read the count once
		expect(h.sent[h.sent.length - 1].uncommittedCount).toBe(5);
		expect(h.stabiliser.deliveredCounts).toEqual([5]);
	});

	it('a hard refresh delivers the reading directly, bypassing the stabilisation window', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a')]));
		h.stabiliser.queued.push({ recheckAfterMs: 1500 }); // would hold a soft refresh's zero
		h.reads.uncommitted = 0;
		await h.loader.loadCommits(request({ showRemoteBranches: false, hard: true }), h.send);
		await flush();
		expect(h.sleeps).toEqual([]);
		expect(h.sent[h.sent.length - 1].uncommittedCount).toBe(0);
	});

	it('a repository without HEAD on the page skips the row entirely', async () => {
		const h = new Harness();
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a')], { head: 'elsewhere' }));
		h.reads.uncommitted = 7;
		await h.loader.loadCommits(request({ showRemoteBranches: false }), h.send);
		await flush();
		expect(h.sent.length).toBe(1); // no uncommitted follow-up at all
		expect(h.reads.uncommittedCalls).toEqual([]);
	});

	it('showUncommittedChanges = false skips the follow-up', async () => {
		const h = new Harness();
		h.config = { ...h.config, showUncommittedChanges: false };
		h.reads.getCommitsHandler = () => Promise.resolve(page([commit('a')]));
		await h.loader.loadCommits(request({ showRemoteBranches: false }), h.send);
		await flush();
		expect(h.sent.length).toBe(1);
	});
});

/** The characterization cases of tests/gitGraphView.test.mjs, mirrored for the extracted copy. */
describe('remoteRefsFollowUpChanged', () => {
	it('is FALSE when the complete response is identical to the deferred one', () => {
		expect(remoteRefsFollowUpChanged(page([commit('a'), commit('b')]), page([commit('a'), commit('b')]))).toBe(false);
	});

	it('is TRUE when a commit already in the window gains a remote label (the classic case)', () => {
		expect(remoteRefsFollowUpChanged(
			page([commit('a'), commit('b')]),
			page([commit('a', [{ name: 'origin/main', remote: 'origin' }]), commit('b')])
		)).toBe(true);
	});

	it('is TRUE when the branch list gains a remote branch whose tip commit never entered the window', () => {
		expect(remoteRefsFollowUpChanged(
			page([commit('a'), commit('b')]),
			page([commit('a'), commit('b')], { branches: ['main', 'remotes/origin/stale-branch'] })
		)).toBe(true);
	});

	it('is TRUE when a truncated window is filled by different commits with no remotes label change', () => {
		expect(remoteRefsFollowUpChanged(page([commit('a'), commit('b')]), page([commit('a'), commit('c')]))).toBe(true);
	});

	it('is TRUE when the commit count differs', () => {
		expect(remoteRefsFollowUpChanged(page([commit('a')]), page([commit('a'), commit('b')]))).toBe(true);
	});

	it('is FALSE when neither the commits, their remotes, nor the branch list changed', () => {
		const labelled = [commit('a', [{ name: 'origin/main', remote: 'origin' }])];
		expect(remoteRefsFollowUpChanged(page(labelled, { branches: ['main', 'remotes/origin/main'] }), page(labelled, { branches: ['main', 'remotes/origin/main'] }))).toBe(false);
	});
});

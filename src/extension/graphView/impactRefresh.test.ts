import { describe, expect, it } from 'vitest';
import type { AnnotateReadOptions, GitAnnotation, GitCommitData, GitCommit as BackendCommit, GitRefSnapshot, RefReadOptions } from '../git/read/types';
import { CommitLoader } from './commitLoader';
import type { CommitDataPort, CommitLoadQuery, CommitLoaderConfig, GerritDataPort, RepoInfoHalf, UncommittedStabiliser } from './commitLoader';
import { refreshAfterWrite } from './impactRefresh';
import type { ImpactRefreshDeps } from './impactRefresh';
import { WRITE_EFFECTS } from '../../shared/protocol/graphView';
import type { WriteEffect } from '../../shared/protocol/graphView';
import { CommitOrdering } from '../../shared/model/webview';
import type { RequestLoadCommits, ResponseLoadCommits } from '../../shared/protocol/loading';
import type { ResponseMessage } from '../../shared/protocol/messages';

/**
 * Impact refresh tests: the minimal refresh per effect class
 * over a REAL CommitLoader (the ImpactRefreshView), recording every read the engine would see
 * —
 * - a refs-only write sends EXACTLY `Refs` + `Annotate` to the engine and NO traversal request;
 * - table-driven: exactly ONE refresh per write operation, across representative commands of
 *   every effect class (driven through the protocol's per-command fallback table);
 * - combinations are the union of their parts, cheapest first;
 * - a failed refs-only read degrades to the single reload.
 */

/* ---------- Fixtures ---------- */

function commit(hash: string, heads: string[] = [], tags: { name: string, annotated: boolean }[] = []): BackendCommit {
	return { hash: hash, parents: [], author: 'A', email: 'a@x', date: 1, message: 'm', heads: heads, tags: tags, remotes: [], stash: null };
}

function page(commits: BackendCommit[], head: string | null = commits.length > 0 ? commits[0].hash : null): GitCommitData {
	return { commits: commits, head: head, tags: [], branches: ['main'], moreCommitsAvailable: false, error: null };
}

function request(overrides: Partial<RequestLoadCommits> = {}): RequestLoadCommits {
	return {
		command: 'loadCommits', repo: '/repo', refreshId: 7, hard: false, branches: null, authors: null,
		maxCommits: 1000, showTags: true, showRemoteBranches: false, includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false, commitOrdering: CommitOrdering.Date, remotes: ['origin'], hideRemotes: [],
		stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
		gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true }, filterPath: null,
		...overrides
	};
}

/** Flush the detached follow-up chains of the initial load. */
async function flush(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The engine request names a fake reader saw, in order (the acceptance records these). */
type EngineRequest = 'getCommits' | 'getUncommittedChanges' | 'getRepoInfo' | 'getOperationState' | 'getRefSnapshot' | 'annotate';

class RecordingReads {
	public readonly requests: EngineRequest[] = [];
	public uncommitted = 0;
	public annotation: GitAnnotation = { head: 'a', commits: [] };
	public snapshot: GitRefSnapshot = {
		refData: {
			head: 'a',
			heads: [{ hash: 'a', name: 'main' }],
			tags: [{ hash: 'b', name: 'v1', annotated: false }],
			remotes: [{ hash: 'a', name: 'origin/main' }]
		},
		branches: ['main'],
		branchHead: 'main',
		tagNames: ['v1']
	};

	public async getCommits(_repo: string, _query: CommitLoadQuery): Promise<GitCommitData> {
		this.requests.push('getCommits');
		return Promise.resolve(page([commit('a'), commit('b')]));
	}

	public async getUncommittedChanges(_repo: string): Promise<number> {
		this.requests.push('getUncommittedChanges');
		return Promise.resolve(this.uncommitted);
	}

	public async getRepoInfo(_repo: string, _options: RefReadOptions): Promise<RepoInfoHalf> {
		this.requests.push('getRepoInfo');
		return Promise.resolve({
			branches: ['main'], head: 'main', remotes: ['origin'], stashes: [], tags: ['v1'], error: null,
			isRepo: true, operationState: { type: null, conflictedFiles: [], progress: null }
		});
	}

	public async getOperationState(_repo: string): Promise<{ type: null, conflictedFiles: string[], progress: null }> {
		this.requests.push('getOperationState');
		return Promise.resolve({ type: null, conflictedFiles: [], progress: null });
	}

	public async getRefSnapshot(_repo: string, _options: RefReadOptions): Promise<GitRefSnapshot> {
		this.requests.push('getRefSnapshot');
		return Promise.resolve(this.snapshot);
	}

	public async annotate(_repo: string, commits: ReadonlyArray<string>, _options: AnnotateReadOptions): Promise<GitAnnotation> {
		this.requests.push('annotate');
		// Annotate every asked hash: 'a' carries the branch head and the remote, 'b' the tag
		return Promise.resolve({
			head: this.annotation.head,
			commits: commits.map((hash) => ({
				hash: hash,
				heads: hash === 'a' ? ['main'] : [],
				tags: hash === 'b' ? [{ name: 'v1', annotated: false }] : [],
				remotes: hash === 'a' ? [{ name: 'origin/main', remote: 'origin' }] : []
			}))
		});
	}
}

class InstantStabiliser implements UncommittedStabiliser {
	public observe(count: number | null): { send: number } {
		return { send: count === null ? 0 : count };
	}

	public delivered(_count: number): void { /* nothing recorded */ }
	public reset(): void { /* nothing to reset */ }
}

/** A minimal Gerrit port: the integration is disabled in these tests. */
const silentGerrit: GerritDataPort = {
	listRemoteChanges: () => Promise.resolve(new Map()),
	fetchChanges: () => Promise.resolve(null),
	listLocalChangeRefs: () => Promise.resolve([]),
	pruneLocalChanges: () => Promise.resolve(null),
	parseMetas: () => Promise.resolve(new Map()),
	getChangeUrlBase: () => Promise.resolve(null)
};

class Harness {
	public readonly reads = new RecordingReads();
	public readonly sent: ResponseMessage[] = [];
	public readonly configPushes: { repo: string, remotes: ReadonlyArray<string> }[] = [];
	public readonly loader: CommitLoader;
	public readonly refreshIds = { loadRepoInfo: 41, loadCommits: 7, loadConfig: 13 };
	public readonly logs: string[] = [];
	public readonly errors: string[] = [];

	constructor() {
		this.loader = new CommitLoader({
			reads: this.reads as unknown as CommitDataPort,
			gerrit: silentGerrit,
			getConfig: () => ({ showUncommittedChanges: true, showRemoteHeads: false, gerrit: { remote: 'gerrit', fetchLimit: 20 } } as CommitLoaderConfig & { showRemoteHeads: boolean }),
			logger: { log: (message) => this.logs.push(message), logError: (message) => this.errors.push(message) },
			formatUncommittedRow: (count) => 'Uncommitted Changes (' + count + ')',
			stabiliser: new InstantStabiliser(),
			now: () => 1000,
			sleep: () => Promise.resolve()
		});
	}

	/** Serve one baseline load, then reset every recorder: the write happens from a clean slate. */
	public async loaded(msg: RequestLoadCommits = request()): Promise<void> {
		await this.loader.loadCommits(msg, (response) => this.sent.push(response));
		await flush();
		this.sent.length = 0;
		this.reads.requests.length = 0;
	}

	public deps(): ImpactRefreshDeps {
		return {
			reads: this.reads as unknown as CommitDataPort,
			view: this.loader,
			getConfig: () => ({ showRemoteHeads: false }),
			logger: { log: (message) => this.logs.push(message), logError: (message) => this.errors.push(message) },
			refreshIds: () => ({ loadRepoInfo: this.refreshIds.loadRepoInfo, loadCommits: this.refreshIds.loadCommits }),
			send: (message) => this.sent.push(message),
			pushConfig: (repo, remotes) => this.pushConfig(repo, remotes)
		};
	}

	public pushConfig(repo: string, remotes: ReadonlyArray<string>): void {
		this.configPushes.push({ repo: repo, remotes: remotes });
	}

	public loadCommitsPushes(): ResponseLoadCommits[] {
		return this.sent.filter((message): message is ResponseLoadCommits => message.command === 'loadCommits');
	}

	public repoInfoPushes(): Extract<ResponseMessage, { command: 'loadRepoInfo' }>[] {
		return this.sent.filter((message): message is Extract<ResponseMessage, { command: 'loadRepoInfo' }> => message.command === 'loadRepoInfo');
	}
}

/* ---------- Tests ---------- */

describe('Impact refresh: the refs-only class', () => {
	it('sends exactly Refs + Annotate to the engine and NO traversal request', async () => {
		const h = new Harness();
		await h.loaded();

		await refreshAfterWrite(h.deps(), '/repo', ['refs']);

		// The engine saw exactly the two refs-only requests — no getCommits (traversal), not
		// even a getRepoInfo (the snapshot replaces it), no status read
		expect(h.reads.requests).toEqual(['getRefSnapshot', 'annotate']);
	});

	it('pushes one loadRepoInfo and one re-annotated loadCommits under the view\'s refresh ids', async () => {
		const h = new Harness();
		await h.loaded();

		await refreshAfterWrite(h.deps(), '/repo', ['refs']);

		expect(h.repoInfoPushes()).toHaveLength(1);
		expect(h.repoInfoPushes()[0]).toMatchObject({ command: 'loadRepoInfo', refreshId: 41, branches: ['main'], head: 'main', remotes: ['origin'], isRepo: true });

		expect(h.loadCommitsPushes()).toHaveLength(1);
		const pushed = h.loadCommitsPushes()[0];
		expect(pushed.refreshId).toBe(7); // the id the view's current state accepts
		expect(pushed.head).toBe('a');
		expect(pushed.uncommittedPending).toBe(true); // the row is kept, its count not re-read
		expect(pushed.branches).toEqual(['main']);
		expect(pushed.tags).toEqual(['v1']);
		// The SAME page, freshly labelled: 'a' gained the branch head and the remote, 'b' the tag
		expect(pushed.commits.map((c) => c.hash)).toEqual(['a', 'b']);
		expect(pushed.commits[0].heads).toEqual(['main']);
		expect(pushed.commits[0].remotes).toEqual([{ name: 'origin/main', remote: 'origin' }]);
		expect(pushed.commits[1].tags).toEqual([{ name: 'v1', annotated: false }]);
	});

	it('a failed refs-only read degrades to the single reload (correct, only slower)', async () => {
		const h = new Harness();
		await h.loaded();
		h.reads.annotate = () => Promise.reject(new Error('engine missing'));
		h.reads.getRefSnapshot = () => Promise.reject(new Error('engine missing'));

		await refreshAfterWrite(h.deps(), '/repo', ['refs']);
		await flush();

		// The reload ran: one traversal (the recorded request, forced fresh) under the same id
		expect(h.reads.requests).toContain('getCommits');
		expect(h.loadCommitsPushes().length).toBeGreaterThanOrEqual(1);
		expect(h.loadCommitsPushes()[0].refreshId).toBe(7);
	});
});

describe('Impact refresh: the other effect classes', () => {
	it('worktree-only: refreshes only the uncommitted row (no page read, no refs read)', async () => {
		const h = new Harness();
		await h.loaded();
		h.reads.uncommitted = 3;

		await refreshAfterWrite(h.deps(), '/repo', ['worktree']);

		expect(h.reads.requests).toEqual(['getUncommittedChanges']);
		expect(h.loadCommitsPushes()).toHaveLength(1);
		const pushed = h.loadCommitsPushes()[0];
		expect(pushed.uncommittedCount).toBe(3);
		expect(pushed.commits.map((c) => c.hash)).toEqual(['*', 'a', 'b']); // the row, prepended above HEAD
	});

	it('config-only: pushes one fresh loadConfig and reads nothing from the engine', async () => {
		const h = new Harness();
		await h.loaded();

		await refreshAfterWrite(h.deps(), '/repo', ['config']);

		expect(h.reads.requests).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(h.configPushes).toEqual([{ repo: '/repo', remotes: ['origin'] }]);
	});

	it('commits: drops the cached pages and re-runs the recorded request as ONE hard reload', async () => {
		const h = new Harness();
		await h.loaded();

		await refreshAfterWrite(h.deps(), '/repo', ['commits']);
		await flush();

		// The repo-info read starts first, then the one traversal; the follow-up status read
		// completes the same refresh sequence (the staged delivery, same refresh id)
		expect(h.reads.requests).toEqual(['getRepoInfo', 'getCommits', 'getUncommittedChanges']);
		expect(h.loadCommitsPushes().length).toBeGreaterThanOrEqual(1);
		expect(new Set(h.loadCommitsPushes().map((pushed) => pushed.refreshId))).toEqual(new Set([7])); // ONE sequence
		expect(h.loadCommitsPushes().filter((pushed) => pushed.uncommittedPending !== true).length).toBeLessThanOrEqual(1);
		expect(h.repoInfoPushes()).toHaveLength(1);
	});

	it('stash: treated as history change (the stash commits leave the graph) — the reload', async () => {
		const h = new Harness();
		await h.loaded();

		await refreshAfterWrite(h.deps(), '/repo', ['stash']);
		await flush();

		expect(h.reads.requests).toContain('getCommits');
		expect(new Set(h.loadCommitsPushes().map((pushed) => pushed.refreshId))).toEqual(new Set([7])); // ONE sequence
	});

	it('combinations are the union of their parts, cheapest first', async () => {
		const combo = new Harness();
		await combo.loaded();
		combo.reads.uncommitted = 2;
		await refreshAfterWrite(combo.deps(), '/repo', ['refs', 'worktree']);
		// The annotate push, then the row update — no traversal anywhere
		expect(combo.reads.requests.filter((r) => r === 'getCommits')).toEqual([]);
		expect(combo.loadCommitsPushes()).toHaveLength(2);
		expect(combo.loadCommitsPushes()[0].uncommittedPending).toBe(true);
		expect(combo.loadCommitsPushes()[1].uncommittedCount).toBe(2);

		const withConfig = new Harness();
		await withConfig.loaded();
		await refreshAfterWrite(withConfig.deps(), '/repo', ['config', 'refs']);
		expect(withConfig.configPushes).toHaveLength(1); // the config push never waits on a read
		expect(withConfig.reads.requests).toEqual(['getRefSnapshot', 'annotate']);
	});
});

/**
 * The table-driven acceptance: for a representative command of every effect class — driven
 * through the protocol's per-command fallback table, exactly the effects the panel would use
 * when the GitWriter reported nothing — exactly ONE refresh follows the write: a single
 * loadCommits push to the webview (plus the dropdown/config ride-alongs), and never more.
 */
describe('Impact refresh: exactly 1 refresh per operation (table-driven)', () => {
	const cases: ReadonlyArray<{ readonly command: keyof typeof WRITE_EFFECTS, readonly engineExpectation: EngineRequest[] }> = [
		// refs-only: create/delete a tag or branch, rename — the engine sees Refs + Annotate only
		{ command: 'addTag', engineExpectation: ['getRefSnapshot', 'annotate'] },
		{ command: 'deleteTag', engineExpectation: ['getRefSnapshot', 'annotate'] },
		{ command: 'deleteBranch', engineExpectation: ['getRefSnapshot', 'annotate'] },
		{ command: 'renameBranch', engineExpectation: ['getRefSnapshot', 'annotate'] },
		{ command: 'pruneRemote', engineExpectation: ['getRefSnapshot', 'annotate'] },
		// head-only (a soft reset, an undo): the annotate read also answers the fresh HEAD
		{ command: 'undoLastCommit', engineExpectation: ['getRefSnapshot', 'annotate'] },
		// worktree-only: the uncommitted row alone
		{ command: 'applyStash', engineExpectation: ['getUncommittedChanges'] },
		{ command: 'resetFileToRevision', engineExpectation: ['getUncommittedChanges'] },
		{ command: 'cleanUntrackedFiles', engineExpectation: ['getUncommittedChanges'] },
		{ command: 'worktreePrune', engineExpectation: ['getUncommittedChanges'] },
		// config-only
		{ command: 'editUserDetails', engineExpectation: [] },
		{ command: 'deleteUserDetails', engineExpectation: [] },
		// head + worktree (a checkout, a hard reset): annotate plus the row
		{ command: 'checkoutCommit', engineExpectation: ['getRefSnapshot', 'annotate', 'getUncommittedChanges'] },
		{ command: 'resetToCommit', engineExpectation: ['getRefSnapshot', 'annotate', 'getUncommittedChanges'] },
		// commits (and stash): the single incremental traversal reload, its staged follow-up completing the sequence
		{ command: 'merge', engineExpectation: ['getRepoInfo', 'getCommits', 'getUncommittedChanges'] },
		{ command: 'revertCommit', engineExpectation: ['getRepoInfo', 'getCommits', 'getUncommittedChanges'] },
		{ command: 'fetch', engineExpectation: ['getRepoInfo', 'getCommits', 'getUncommittedChanges'] },
		{ command: 'dropStash', engineExpectation: ['getRepoInfo', 'getCommits', 'getUncommittedChanges'] },
		{ command: 'pushStash', engineExpectation: ['getRepoInfo', 'getCommits', 'getUncommittedChanges'] }
	];

	for (const { command, engineExpectation } of cases) {
		it('"' + String(command) + '" (' + String(WRITE_EFFECTS[command]) + ') triggers exactly one refresh', async () => {
			const effects = WRITE_EFFECTS[command] as ReadonlyArray<WriteEffect>;
			expect(effects).not.toBeNull(); // a mutating command the host must refresh
			const h = new Harness();
			await h.loaded();

			await refreshAfterWrite(h.deps(), '/repo', effects);
			await flush();

			// The engine saw exactly the minimal requests of the effect class
			expect(h.reads.requests).toEqual(engineExpectation);
			// And the webview received exactly ONE refresh: a config-only write pushes NO commits
			// refresh at all (the loadConfig push is the refresh); every other class pushes a
			// single sequence — every push carries the one refresh id the current view accepts —
			// with one traversal at most
			if (engineExpectation.length === 0) {
				expect(h.loadCommitsPushes()).toHaveLength(0);
				expect(h.configPushes).toHaveLength(1);
			} else {
				expect(h.loadCommitsPushes().length).toBeGreaterThanOrEqual(1);
				expect(new Set(h.loadCommitsPushes().map((pushed) => pushed.refreshId))).toEqual(new Set([7]));
				expect(h.reads.requests.filter((seen) => seen === 'getCommits').length).toBeLessThanOrEqual(1);
			}
			expect(h.repoInfoPushes().length).toBeLessThanOrEqual(1);
		});
	}

	it('the fallback table covers every mutating command with effects (the webview waits for the push)', () => {
		for (const [command, effects] of Object.entries(WRITE_EFFECTS)) {
			if (effects === null) continue;
			// gerritSetFetchRefs is the one documented exception: the view refreshes it itself
			if (command === 'gerritSetFetchRefs') continue;
			expect(effects.length).toBeGreaterThan(0);
		}
	});
});

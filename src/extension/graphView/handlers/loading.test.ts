import { describe, expect, it } from 'vitest';
import type { DataSource } from '../../../dataSource';
import type { GitCommitData } from '../../../dataSource';
import { CommitLoader } from '../commitLoader';
import type { CommitDataPort } from '../commitLoader';
import { CommitOrdering } from '../../../types';
import type { RequestLoadCommits, ResponseMessage, ResponseLoadCommits } from '../../../types';
import type { CommitLoaderPort, ConfigSnapshot, HandlerContext, UiPort, ViewPort } from './context';
import { dispatchRequest } from './index';

/**
 * Wiring tests (task 4.3, feature 2): the handler table's `loadCommits` handler delegates to a
 * REAL CommitLoader (not the recording stub of index.test.ts) and every staged response the
 * loader emits reaches the webview through `ctx.send` - proving the port surface the table
 * consumes is exactly the surface the extracted loader implements, before the Panel cutover
 * (task 4.4) constructs this pairing in production.
 */

function page(commits: string[]): GitCommitData {
	return {
		commits: commits.map((hash) => ({ hash: hash, parents: [], author: 'A', email: 'a@x', date: 1, message: 'm', heads: [], tags: [], remotes: [], stash: null })),
		head: commits.length > 0 ? commits[0] : null,
		tags: [], branches: ['main'], moreCommitsAvailable: false, error: null
	};
}

function loadCommitsRequest(refreshId: number): RequestLoadCommits {
	return {
		command: 'loadCommits', repo: '/repo', refreshId: refreshId, hard: false, branches: null, authors: null,
		maxCommits: 1000, showTags: true, showRemoteBranches: false, includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false, commitOrdering: CommitOrdering.Date, remotes: [], hideRemotes: [],
		stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
		gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true }, filterPath: null
	};
}

/** A context whose loader is the real CommitLoader over fake reads; only loader and send are exercised. */
class WiringContext implements HandlerContext {
	public readonly sent: ResponseMessage[] = [];
	public reads = 0;
	public readonly repo: DataSource = null as unknown as DataSource; // the handlers under test touch only ctx.loader and ctx.send
	public readonly config: ConfigSnapshot = { gerrit: { remote: 'gerrit' } };
	public readonly ui: UiPort = null as unknown as UiPort; // never reached by these handlers
	// The ports the loadCommits pipeline never touches (typed `never`, assignable to every port);
	// loadRepoInfo reads only ctx.view, recorded minimally
	public readonly avatars: never = null as unknown as never;
	public readonly storage: never = null as unknown as never;
	public readonly repos: never = null as unknown as never;
	public readonly userConfig: never = null as unknown as never;
	public readonly settings: never = null as unknown as never;
	public readonly pullRequests: never = null as unknown as never;
	public readonly view: ViewPort = {
		viewHasCommits: false,
		noteRefreshId: () => undefined,
		repoSwitched: () => undefined
	};
	public readonly loader: CommitLoaderPort;

	constructor() {
		const reads: CommitDataPort = {
			getCommits: (_repo, query) => {
				this.reads++;
				return Promise.resolve(page(query.deferRemoteRefs ? ['a'] : ['a', 'b']));
			},
			getUncommittedChanges: () => Promise.resolve(0)
		};
		// The production pairing under test: the real loader implements the port the table declares
		this.loader = new CommitLoader({
			reads: reads,
			gerrit: {
				listRemoteChanges: () => Promise.resolve(new Map<number, number[]>()),
				fetchChanges: () => Promise.resolve(null),
				listLocalChangeRefs: () => Promise.resolve([]),
				pruneLocalChanges: () => Promise.resolve(null),
				parseMetas: () => Promise.resolve(new Map<number, never>()),
				getChangeUrlBase: () => Promise.resolve(null)
			},
			getConfig: () => ({ showUncommittedChanges: true, gerrit: { remote: 'gerrit', fetchLimit: 20 } }),
			logger: { log: () => undefined, logError: () => undefined },
			formatUncommittedRow: (count) => 'Uncommitted Changes (' + count + ')',
			stabiliser: {
				observe: (count) => count === null ? { recheckAfterMs: 1000 } : { send: count },
				delivered: () => undefined,
				reset: () => undefined
			},
			now: () => 1000,
			sleep: () => Promise.resolve()
		});
	}

	public send = (msg: ResponseMessage): void => { this.sent.push(msg); };
}

async function flush(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('loadCommits handler wiring', () => {
	it('delegates to the real CommitLoader and forwards its staged responses via ctx.send', async () => {
		const ctx = new WiringContext();
		await expect(dispatchRequest(loadCommitsRequest(1), ctx)).resolves.toBe('handled');
		await flush();

		const responses = ctx.sent.filter((msg) => msg.command === 'loadCommits') as ResponseLoadCommits[];
		expect(responses.length).toBe(2); // the initial response, then the uncommitted follow-up
		expect(responses[0]).toMatchObject({ refreshId: 1, uncommittedPending: true, error: null });
		expect(responses[0].commits.map((c) => c.hash)).toEqual(['a', 'b']);
		expect(responses[1].uncommittedCount).toBe(0);
		expect(ctx.reads).toBe(1); // served by the real loader's commit cache pipeline (one page read)
	});

	it('keeps the loader state across dispatches: an identical request is served from its cache', async () => {
		const ctx = new WiringContext();
		await dispatchRequest(loadCommitsRequest(1), ctx);
		await flush();
		await dispatchRequest(loadCommitsRequest(2), ctx); // a different refresh id, identical query
		await flush();
		expect(ctx.reads).toBe(1); // the second dispatch hit the real loader's commit-page cache
	});

	it('gerritSetFetchRefs drives the real loader\'s invalidation port, dropping the cached pages', async () => {
		const ctx = new WiringContext();
		await dispatchRequest(loadCommitsRequest(1), ctx);
		await flush();
		expect(ctx.reads).toBe(1);

		await dispatchRequest({ command: 'gerritSetFetchRefs', repo: '/repo', enabled: true }, ctx);
		expect(ctx.sent.filter((msg) => msg.command === 'gerritSetFetchRefs')).toEqual([{ command: 'gerritSetFetchRefs', error: null, enabled: true, cleared: 0 }]);

		await dispatchRequest(loadCommitsRequest(2), ctx);
		await flush();
		expect(ctx.reads).toBe(2); // the port call dropped the cache: the page was read again
	});
});

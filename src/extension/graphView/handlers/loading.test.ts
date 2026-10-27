import { describe, expect, it } from 'vitest';
import type { GitCommitData } from '../../git/read/types';
import { CommitLoader } from '../commitLoader';
import type { CommitDataPort } from '../commitLoader';
import { CommitOrdering } from '../../../shared/model/webview';
import type { RequestLoadCommits, RequestLoadView, ResponseLoadCommits, ResponseLoadView } from '../../../shared/protocol/loading';
import type { ResponseMessage } from '../../../shared/protocol/messages';
import type { AbortLike } from '../../git/process/gitProcess';
import type { CommitLoaderPort, ConfigSnapshot, HandlerContext, UiPort, ViewPort } from './context';
import type { ProductionGitRepository } from '../../git/gitRepository';
import { dispatchRequest } from './index';

/**
 * Wiring tests: the handler table's `loadCommits` handler
 * delegates to a REAL CommitLoader (not the recording stub of index.test.ts) and every staged
 * response the loader emits reaches the webview through `ctx.send` - proving the port surface the
 * table consumes is exactly the surface the real loader implements. The `loadView` half
 * proves the merged open path answers in ONE response carrying both halves, through the same send.
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

function loadViewRequest(refreshId: number): RequestLoadView {
	return {
		command: 'loadView', repo: '/repo', refreshId: refreshId, hard: false, branches: null, authors: null,
		maxCommits: 1000, showTags: true, showRemoteBranches: false, includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false, commitOrdering: CommitOrdering.Date, remotes: [], hideRemotes: [], stashes: [], filterPath: null
	};
}

/** A context whose loader is the real CommitLoader over fake reads; only loader and send are exercised. */
class WiringContext implements HandlerContext {
	public readonly sent: ResponseMessage[] = [];
	public reads = 0;
	public readonly signals: (AbortLike | undefined)[] = [];
	public readonly repo: ProductionGitRepository = null as unknown as ProductionGitRepository; // the handlers under test touch only ctx.loader and ctx.send
	public readonly git = { hasGit: () => true } as never;
	public readonly repoConfig = null as never;
	public readonly gerrit = null as never;
	public readonly t = (key: string): string => key;
	public readonly config: ConfigSnapshot = { gerrit: { remote: 'gerrit' }, showRemoteHeads: false, squashPullMessageFormat: 0 as never, squashMergeMessageFormat: 0 as never };
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
		repoSwitched: () => undefined,
		viewReady: () => undefined
	};
	public readonly loader: CommitLoaderPort;

	constructor() {
		const context = this;
		const reads: CommitDataPort = {
			getCommits: (_repo, query, signal) => {
				context.reads++;
				context.signals.push(signal);
				return Promise.resolve(page(query.deferRemoteRefs ? ['a'] : ['a', 'b']));
			},
			getUncommittedChanges: () => Promise.resolve(0),
			getRepoInfo: () => Promise.resolve({
				branches: ['main'], head: 'main', remotes: [], stashes: [], tags: [], error: null,
				isRepo: true, operationState: { type: null, conflictedFiles: [], progress: null }
			}),
			getOperationState: () => Promise.resolve({ type: null, conflictedFiles: [], progress: null }),
			// The refs-only reads of the impact refresh: unused by these handler tests,
			// but part of the port the real loader reads through
			getRefSnapshot: () => Promise.resolve({
				refData: { head: 'a', heads: [], tags: [], remotes: [] },
				branches: ['main'],
				branchHead: 'main',
				tagNames: []
			}),
			annotate: (_repo, commits) => Promise.resolve({ head: 'a', commits: commits.map((hash) => ({ hash: hash, heads: [], tags: [], remotes: [] })) })
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
			getConfig: () => ({ showUncommittedChanges: true, showRemoteHeads: false, gerrit: { remote: 'gerrit', fetchLimit: 20 } }),
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

describe('loadView handler wiring (the merged open path)', () => {
	it('answers with ONE loadView response carrying the repo info and the first commit page', async () => {
		const ctx = new WiringContext();
		await dispatchRequest(loadViewRequest(1), ctx);
		await flush();

		const views = ctx.sent.filter((msg) => msg.command === 'loadView') as ResponseLoadView[];
		expect(views.length).toBe(1);
		expect(views[0].repo).toBe('/repo');
		expect(views[0].refreshId).toBe(1);
		expect(views[0].repoInfo).toMatchObject({ branches: ['main'], head: 'main', isRepo: true, error: null });
		expect(views[0].commits.commits.map((c) => c.hash)).toEqual(['a', 'b']);
		// The staged follow-ups keep their shape: the uncommitted row arrives as a loadCommits response
		const followUps = ctx.sent.filter((msg) => msg.command === 'loadCommits') as ResponseLoadCommits[];
		expect(followUps.length).toBe(1);
		expect(followUps[0].uncommittedCount).toBe(0);
	});

	it('registers the read under the loader\'s per-repo cancellation: a newer load supersedes it', async () => {
		const ctx = new WiringContext();
		const first = loadViewRequest(1);
		// The same kind of load, newer, with a different page key so it reads again (and registers its own signal)
		const second: RequestLoadCommits = { ...loadCommitsRequest(2), maxCommits: 500 };
		const firstDispatch = dispatchRequest(first, ctx);
		await dispatchRequest(second, ctx);
		await flush();
		await firstDispatch;

		// The first load's in-flight walk received a signal, and the newer load aborted it
		expect(ctx.signals.length).toBe(2);
		expect(ctx.signals[0]?.aborted).toBe(true);
		expect(ctx.signals[1]?.aborted).toBe(false);
		// The superseded open pushed nothing
		expect(ctx.sent.filter((msg) => msg.command === 'loadView')).toEqual([]);
	});
});

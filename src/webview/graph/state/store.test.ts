// @vitest-environment jsdom
/**
 * The Store's subscription semantics (REFACTOR-PLAN task 5.10): the config listeners replace the
 * old global config-changed plumbing, and the render-change channel is what the render scheduler
 * coalesces - any number of changes within a frame produce ONE render, which is the store-side
 * half of "one response, one render". The slice-action half of F1 is table-driven: every action's
 * emitted change set (slice + keys, row-scoped hashes where they exist) and the commitLookup
 * consistency the commits slice owns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as GG from '../../common/protocol';
import { RenderScheduler } from '../render/scheduler';
import { Store } from './store';
import { StoreChange } from './changes';

/** A store with the minimum of initialState the constructor and the tests read. */
function makeStore(): Store {
	const config = {
		initialLoadCommits: 100,
		mobileAdaptation: false,
		markdown: false,
		fetchAvatars: false,
		showBodyInline: false,
		customBranchGlobPatterns: [],
		dateFormat: { type: GG.DateFormatType.DateAndTime, iso: false },
		referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: false, tagLabelsOnRight: false },
		defaultColumnVisibility: { date: true, author: true, commit: true },
		graph: { colours: ['#0086d1'], fontSize: 12, rowHeight: 24, grid: { x: 10, y: 24, offsetX: 8, offsetY: 12, expandY: 0 } },
		mute: { commitsNotAncestorsOfHead: false, mergeCommits: false },
		gerrit: { fetchLimit: 10, showReviewProgress: false },
		commitDetailsView: { location: GG.CommitDetailsViewLocation.DockedToBottom },
		onRepoLoad: { scrollToHead: false, showCheckedOutBranch: false, showSpecificBranches: [] }
	};
	const initialState = {
		config: config,
		backend: { engineVersion: null, gitCliAvailable: true, capabilities: [] },
		repos: {},
		loadRepoInfoRefreshId: 0,
		loadCommitsRefreshId: 0,
		loadConfigRefreshId: 0,
		lastActiveRepo: null,
		loadViewTo: null
	};
	const globalState = { alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false };
	const workspaceState = { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false };
	return new Store(initialState as unknown as GG.GitGraphViewInitialState, globalState as unknown as GG.GitGraphViewGlobalState, workspaceState as unknown as GG.GitGraphViewWorkspaceState);
}

/** A commit with the given hash at the top of a one-commit page. */
function commitOf(hash: string): GG.GitCommit {
	return { hash: hash, parents: [], author: 'a', email: 'a@example.com', date: 1700000000, message: hash, heads: [], tags: [], remotes: [], stash: null };
}

describe('Store subscription semantics (task 5.10)', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	it('onConfigChange listeners receive the new AND the previous configuration', () => {
		const store = makeStore();
		const seen: Array<{ next: unknown, previous: unknown }> = [];
		store.onConfigChange((config, previous) => seen.push({ next: config, previous: previous }));

		const previous = store.config;
		const next = { ...previous, markdown: true };
		store.setConfig(next as unknown as GG.GitGraphViewConfig);
		expect(store.config).toBe(next);
		expect(seen).toEqual([{ next: next, previous: previous }]);
	});

	it('invalidateRender notifies every subscriber with the full invalidation (NULL)', () => {
		const store = makeStore();
		let a = 0, b = 0;
		const seen: Array<StoreChange | null> = [];
		store.onRenderChange((change) => { a++; seen.push(change); });
		store.onRenderChange(() => { b++; });

		store.invalidateRender();
		expect(a).toBe(1);
		expect(b).toBe(1);
		expect(seen).toEqual([null]);
	});

	it('an unsubscribe function stops the notifications', () => {
		const store = makeStore();
		let calls = 0;
		const unsubscribe = store.onRenderChange(() => { calls++; });

		store.invalidateRender();
		unsubscribe();
		store.invalidateRender();
		expect(calls).toBe(1);
	});

	it('wired to the render scheduler: N changes within a frame merge into ONE render', () => {
		vi.stubGlobal('requestAnimationFrame', undefined); // drive frames with the timers
		const store = makeStore();
		let renders = 0;
		const scheduler = new RenderScheduler();
		scheduler.subscribe({ slices: ['repos', 'refs', 'commits', 'details', 'ui', 'integrations'], render: () => { renders++; } });
		store.onRenderChange((change) => scheduler.request(change));

		store.slices.commits.replacePage({ commits: [commitOf('c1')], head: 'c1', moreCommitsAvailable: false, onlyFollowFirstParent: false });
		store.slices.integrations.setPullRequests({});
		store.invalidateRender(); // a response that touched several slices of the store
		expect(renders).toBe(0); // nothing before the frame

		vi.advanceTimersByTime(0);
		expect(renders).toBe(1);
	});
});

describe('slice actions emit typed change sets (F1, table-driven)', () => {
	// The EMITTING actions: the response-application changes the render pass (and, after task
	// 5.10, the keyed row patcher) consumes, plus the pull-request badges - the one change that
	// used to be a whole-view `invalidateRender()` and now routes by slice.
	it.each([
		{
			name: 'commits.replacePage',
			run: (store: Store) => store.slices.commits.replacePage({ commits: [commitOf('c1'), commitOf('c2')], head: 'c1', moreCommitsAvailable: true, onlyFollowFirstParent: false }),
			expected: { slice: 'commits', keys: ['page', 'head', 'lookup', 'moreAvailable'] }
		},
		{
			name: 'commits.clear',
			run: (store: Store) => store.slices.commits.clear(),
			expected: { slice: 'commits', keys: ['page', 'head', 'lookup', 'moreAvailable'] }
		},
		{
			name: 'refs.applyInfo (changed)',
			run: (store: Store) => store.slices.refs.applyInfo({ branches: ['main'], head: 'c1', remotes: ['origin'] }),
			expected: { slice: 'refs', keys: ['branches', 'head', 'remotes'] }
		},
		{
			name: 'refs.applyBranchList (changed)',
			run: (store: Store) => store.slices.refs.applyBranchList(['main', 'feature']),
			expected: { slice: 'refs', keys: ['branches'] }
		},
		{
			name: 'refs.setTags',
			run: (store: Store) => store.slices.refs.setTags(['v1']),
			expected: { slice: 'refs', keys: ['tags'] }
		},
		{
			name: 'refs.setStashes (changed)',
			run: (store: Store) => store.slices.refs.setStashes([{ name: 'stash@{0}', baseHash: 'c1', selector: 'refs/stash@{0}' } as unknown as GG.GitStash]),
			expected: { slice: 'refs', keys: ['stashes'] }
		},
		{
			name: 'integrations.setPullRequests',
			run: (store: Store) => store.slices.integrations.setPullRequests({}),
			expected: { slice: 'integrations', keys: ['pullRequests'] }
		},
		{
			name: 'integrations.setGerritStates (badges changed)',
			run: (store: Store) => store.slices.integrations.setGerritStates({ c1: { change: 1, patchset: 1, codeReview: 0, verified: 0, status: 'new', wip: false, headHash: 'c1', events: [], url: null } }, true, true),
			expected: { slice: 'integrations', keys: ['gerritStates', 'gerritVisible'] }
		},
		{
			name: 'integrations.setGerritStates (timelines only: swapped, no change emitted)',
			run: (store: Store) => store.slices.integrations.setGerritStates({ c1: { change: 1, patchset: 1, codeReview: 0, verified: 0, status: 'new', wip: false, headHash: 'c1', events: [], url: null } }, false, false),
			expected: null
		}
	])('$name', ({ run, expected }) => {
		const store = makeStore();
		const seen: Array<StoreChange | null> = [];
		store.onRenderChange((change) => seen.push(change));
		run(store);
		if (expected === null) {
			expect(seen).toEqual([]); // the action emitted nothing at all
		} else {
			// (actions with a setup step emit for the setup too; the ACTION's change is the last)
			expect(seen[seen.length - 1]).toEqual(expected);
		}
	});

	// The SILENT actions: their fields feed nothing the scheduler renders (the refresh button, the
	// dropdowns and the details panel are rendered explicitly by the components that change them),
	// so an emission could only schedule renders the view never used to do.
	it.each([
		{
			name: 'repos.switchTo (a switch re-renders through the page)',
			run: (store: Store) => store.slices.repos.switchTo('/repo')
		},
		{
			name: 'repos.setLoadViewTo',
			run: (store: Store) => store.slices.repos.setLoadViewTo({ repo: '/repo' })
		},
		{
			name: 'repos.beginCycle',
			run: (store: Store) => store.slices.repos.beginCycle(true, false)
		},
		{
			name: 'repos.projectLoadState',
			run: (store: Store) => store.slices.repos.projectLoadState(true, false, true)
		},
		{
			name: 'repos.endConfigLoad',
			run: (store: Store) => store.slices.repos.endConfigLoad()
		},
		{
			name: 'refs.setPathFilter (the filter button re-renders itself)',
			run: (store: Store) => store.slices.refs.setPathFilter('src')
		},
		{
			name: 'refs.setBranchSelection (the dropdown re-renders itself)',
			run: (store: Store) => store.slices.refs.setBranchSelection(['main'])
		},
		{
			name: 'refs.setRepoConfig',
			run: (store: Store) => store.slices.refs.setRepoConfig({} as GG.GitRepoConfig)
		},
		{
			name: 'refs.setStashes (identical: no change, no emission)',
			run: (store: Store) => store.slices.refs.setStashes([])
		},
		{
			name: 'refs.reset (the repository switch)',
			run: (store: Store) => store.slices.refs.reset()
		},
		{
			name: 'ui.setScrollTop (nobody renders for the scroll record)',
			run: (store: Store) => store.slices.ui.setScrollTop(40)
		},
		{
			name: 'ui.setCompareSourceHash',
			run: (store: Store) => store.slices.ui.setCompareSourceHash('c1')
		},
		{
			name: 'details.open (the panel renders itself)',
			run: (store: Store) => store.slices.details.open({
				index: 0, commitHash: 'c1', commitElem: null, compareWithHash: null, compareWithElem: null,
				commitDetails: null, fileChanges: null, fileTree: null, avatar: null, codeReview: null,
				lastViewedFile: null, loading: true, entered: false, showMarkdown: true,
				lineCounts: { pending: null, requested: new Set<string>(), queue: [], byPath: null, chunkInFlight: false, scrollTimer: 0 },
				scrollTop: { summary: 0, fileView: 0 }, contextMenuOpen: { summary: false, fileView: -1 }
			})
		},
		{
			name: 'commits.setMaxCommits (the next request asks for more; nothing renders)',
			run: (store: Store) => store.slices.commits.setMaxCommits(250)
		},
		{
			name: 'commits.patchUncommittedRow (the caller patches the row in place)',
			run: (store: Store) => store.slices.commits.patchUncommittedRow(commitOf('uncommitted'))
		},
		{
			name: 'commits.setUncommittedCount (applied within the response render)',
			run: (store: Store) => store.slices.commits.setUncommittedCount(3)
		}
	])('$name emits nothing', ({ run }) => {
		const store = makeStore();
		const seen: Array<StoreChange | null> = [];
		store.onRenderChange((change) => seen.push(change));
		run(store);
		expect(seen).toEqual([]);
	});
});

describe('the commits slice owns commitLookup (F1)', () => {
	it('replacePage rebuilds the lookup; getCommitId/getCommit answer from it', () => {
		const store = makeStore();
		store.slices.commits.replacePage({ commits: [commitOf('c1'), commitOf('c2')], head: 'c1', moreCommitsAvailable: false, onlyFollowFirstParent: false });
		expect(store.getCommitId('c1')).toBe(0);
		expect(store.getCommitId('c2')).toBe(1);
		expect(store.getCommitId('missing')).toBeNull();
		expect(store.getCommit('c2')?.hash).toBe('c2');

		// A new page REPLACES the lookup - a hash the old page carried is gone with it
		store.slices.commits.replacePage({ commits: [commitOf('c3')], head: 'c3', moreCommitsAvailable: false, onlyFollowFirstParent: false });
		expect(store.getCommitId('c1')).toBeNull();
		expect(store.getCommitId('c3')).toBe(0);
	});

	it('clear empties the page and the lookup together, so they can never disagree', () => {
		const store = makeStore();
		store.slices.commits.replacePage({ commits: [commitOf('c1')], head: 'c1', moreCommitsAvailable: false, onlyFollowFirstParent: false });
		store.slices.commits.clear();
		expect(store.commits).toEqual([]);
		expect(store.getCommitId('c1')).toBeNull();
	});

	it('getCommitOrder answers which of two loaded commits is newer', () => {
		const store = makeStore();
		store.slices.commits.replacePage({ commits: [commitOf('newer'), commitOf('older')], head: 'newer', moreCommitsAvailable: false, onlyFollowFirstParent: false });
		expect(store.getCommitOrder('newer', 'older')).toEqual({ from: 'older', to: 'newer' });
		expect(store.getCommitOrder('older', 'newer')).toEqual({ from: 'older', to: 'newer' });
		// An unknown hash lands on the OLDER side, exactly like the old plain-object lookup whose
		// `undefined` answered every `>` comparison false (from = the other hash then)
		expect(store.getCommitOrder('missing', 'older')).toEqual({ from: 'older', to: 'missing' });
		expect(store.getCommitOrder('newer', 'missing')).toEqual({ from: 'missing', to: 'newer' });
	});
});


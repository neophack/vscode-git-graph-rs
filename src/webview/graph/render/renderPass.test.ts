// @vitest-environment jsdom
/**
 * The render pass of a response (REFACTOR-PLAN task 5.10): one response triggers exactly ONE
 * render (counted at the scheduler's single choke point), and the keyed row patches mean a
 * refs-only update rewrites only the rows whose refs changed - the other visible rows keep their
 * very DOM nodes (asserted both by element identity and by counting the replaced rows through a
 * MutationObserver, the way the acceptance criteria measure it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import { RepoLoader } from '../loading/repoLoader';
import { Store } from '../state/store';
import { CommitTable } from './commitTable';
import { RenderScheduler } from './scheduler';
import { LayoutMode } from './layoutMode';
import { Viewport } from './viewport';

/** A linear history: commit i's parents point at commit i+1; optional heads per hash. */
function history(entries: { hash: string, heads?: string[] }[]): GG.GitCommit[] {
	return entries.map((entry) => ({
		hash: entry.hash,
		parents: [],
		author: 'Author ' + entry.hash.substring(1, 3),
		email: 'author' + entry.hash.substring(1, 3) + '@example.com',
		date: 1700000000 + parseInt(entry.hash.substring(1, 3), 10) * 60,
		message: 'commit ' + entry.hash,
		heads: entry.heads !== undefined ? entry.heads : [],
		tags: [],
		remotes: [],
		stash: null
	}));
}

const ENTRIES = [
	{ hash: 'c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' },
	{ hash: 'c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2' },
	{ hash: 'c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3' },
	{ hash: 'c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4' },
	{ hash: 'c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5' }
];

/**
 * The real Store, LayoutMode, Viewport, CommitTable and RepoLoader over a stubbed rest-of-view:
 * enough of the context for a `loadCommits` response to run its actual processing and rendering,
 * with the render pass counted where main.ts puts it (the scheduler).
 */
function makeView() {
	document.body.textContent = '';
	const view = document.createElement('div');
	view.id = 'view';
	const controls = document.createElement('div');
	const table = document.createElement('div');
	table.id = 'commitTable';
	const footer = document.createElement('div');
	document.body.appendChild(view);
	document.body.appendChild(controls);
	document.body.appendChild(table);
	document.body.appendChild(footer);

	const config = {
		initialLoadCommits: 100,
		loadMoreCommits: 100,
		loadMoreCommitsAutomatically: false,
		mobileAdaptation: false,
		markdown: false,
		fetchAvatars: false,
		showBodyInline: false,
		customBranchGlobPatterns: [],
		dateFormat: { type: GG.DateFormatType.DateAndTime, iso: false },
		referenceLabels: { branchLabelsAlignedToGraph: false, combineLocalAndRemoteBranchLabels: false, tagLabelsOnRight: false },
		defaultColumnVisibility: { date: true, author: true, commit: true },
		graph: { colours: ['#0086d1'], fontSize: 12, rowHeight: 24, style: GG.GraphStyle.Rounded, grid: { x: 10, y: 24, offsetX: 8, offsetY: 12, expandY: 0 }, uncommittedChanges: GG.GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges },
		mute: { commitsNotAncestorsOfHead: false, mergeCommits: false },
		gerrit: { fetchLimit: 10, showReviewProgress: false },
		pullRequests: { enabled: true },
		commitDetailsView: { location: GG.CommitDetailsViewLocation.DockedToBottom },
		onRepoLoad: { scrollToHead: false, showCheckedOutBranch: false, showSpecificBranches: [] }
	};
	const repoState = {
		name: null, issueLinkingConfig: null, columnWidths: null, cdvHeight: 200,
		gerritFetchLimit: null, gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true },
		pinnedCommits: [], pinnedBranches: [], hideRemotes: [],
		onRepoLoadShowCheckedOutBranch: 0, onRepoLoadShowSpecificBranches: null,
		showRemoteBranchesV2: 0, showStashes: 0, showTags: 0, commitOrdering: GG.RepoCommitOrdering.Default,
		includeCommitsMentionedByReflogs: 0, onlyFollowFirstParent: 0
	};
	const initialState = {
		config: config,
		backend: { platform: 'test', engineAvailable: false, engineVersion: null, gitCliAvailable: true, capabilities: [] },
		repos: { '/repo': repoState },
		loadRepoInfoRefreshId: 0,
		loadCommitsRefreshId: 0,
		loadConfigRefreshId: 0,
		lastActiveRepo: '/repo',
		loadViewTo: null
	};
	const globalState = { alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false };
	const workspaceState = { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false };
	const store = new Store(initialState as unknown as GG.GitGraphViewInitialState, globalState as unknown as GG.GitGraphViewGlobalState, workspaceState as unknown as GG.GitGraphViewWorkspaceState);
	store.currentRepo = '/repo';
	store.currentRepoLoading = false;

	const noop = () => undefined;
	const renders = { count: 0 };
	const ctx = <{ -readonly [K in keyof GraphContext]: GraphContext[K] }>{};
	ctx.store = store;
	ctx.bridge = { send: noop } as unknown as GraphContext['bridge'];
	ctx.persistence = { saveState: noop, saveRepoStateValue: noop, updateWorkspaceViewState: noop } as unknown as GraphContext['persistence'];
	ctx.closeDialogAndContextMenu = noop;
	ctx.dialog = { closeActionRunning: noop, isTargetDynamicSource: () => false, showError: noop } as unknown as GraphContext['dialog'];
	ctx.contextMenu = { isTargetDynamicSource: () => false } as unknown as GraphContext['contextMenu'];
	ctx.layout = new LayoutMode(store, view);
	const vertexColours: number[] = [];
	ctx.graph = {
		loadCommits: noop,
		render: noop,
		getVertexColours: () => vertexColours,
		getWidthsAtVertices: () => [],
		getMutedCommits: () => store.commits.map(() => false),
		getContentWidth: () => 100
	} as unknown as GraphContext['graph'];
	ctx.viewport = new Viewport(() => ctx as GraphContext);
	ctx.table = new CommitTable(() => ctx as GraphContext);
	ctx.renderScheduler = new RenderScheduler(() => {
		renders.count++;
		ctx.table.render();
	});
	// The wiring main.ts installs: store changes coalesce into scheduler requests
	store.onRenderChange(() => ctx.renderScheduler.request());
	ctx.columns = { makeTableResizable: noop, applyGraphColumnAutoLayout: noop } as unknown as GraphContext['columns'];
	ctx.loader = new RepoLoader(() => ctx as GraphContext);
	ctx.commitBodies = { bodies: {}, requestForRows: noop, clear: noop } as unknown as GraphContext['commitBodies'];
	ctx.details = { close: noop } as unknown as GraphContext['details'];
	ctx.controls = { renderRefreshButton: noop, renderFetchButton: noop, renderFilterButton: noop, syncShowRemoteBranches: noop } as unknown as GraphContext['controls'];
	ctx.pinned = { render: noop } as unknown as GraphContext['pinned'];
	ctx.widgets = {
		find: { refresh: noop, isSearching: () => false },
		settings: { refresh: noop, close: noop },
		conflictBanner: { update: noop },
		reflog: { close: noop },
		worktree: { close: noop },
		statistics: { close: noop }
	} as unknown as GraphContext['widgets'];
	ctx.dom = {
		view: view,
		headerRow: document.createElement('div'),
		controls: controls,
		pinnedControls: null,
		conflictBanner: document.createElement('div'),
		commitGraph: document.createElement('div'),
		table: table,
		footer: footer
	};

	return {
		ctx: ctx as GraphContext,
		store: store,
		loader: ctx.loader as RepoLoader,
		renders: renders,
		scheduler: ctx.renderScheduler as RenderScheduler
	};
}

/** A `loadCommits` response carrying the given commits. */
function loadCommitsResponse(commits: GG.GitCommit[]): GG.ResponseLoadCommits {
	return {
		command: 'loadCommits',
		refreshId: 0,
		commits: commits,
		head: commits.length > 0 ? commits[0].hash : null,
		tags: [],
		moreCommitsAvailable: false,
		onlyFollowFirstParent: false,
		gerritStates: null,
		error: null
	} as unknown as GG.ResponseLoadCommits;
}

describe('one response, one render pass (task 5.10)', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	it('a loadCommits response renders exactly once, with nothing left pending for the next frame', () => {
		vi.stubGlobal('requestAnimationFrame', undefined); // drive any straggler frames with the timers
		const { ctx, loader, renders, scheduler } = makeView();

		loader.processLoadCommitsResponse(loadCommitsResponse(history(ENTRIES)));

		expect(renders.count).toBe(1); // the single render pass of the response
		expect(scheduler.isPending()).toBe(false); // nothing still scheduled
		expect(document.querySelectorAll('tr.commit')).toHaveLength(ENTRIES.length);

		// Let a frame pass: no deferred second render appears
		vi.advanceTimersByTime(50);
		expect(renders.count).toBe(1);

		expect(ctx.store.commitLookup[ENTRIES[0].hash]).toBe(0); // the lookup was built
	});

	it('a pull-request response followed by a loadCommits response in the same tick still renders once', () => {
		vi.stubGlobal('requestAnimationFrame', undefined);
		const { store, loader, renders } = makeView();

		// The pull request badge arrives for an unloaded commit: it marks the view dirty (a
		// coalesced request), and the loadCommits response that lands in the same tick renders
		// synchronously - satisfying that request instead of adding a second pass
		loader.processPullRequestStatus({ command: 'pullRequestStatus', repo: '/repo', prs: [{ headHash: 'c0ffffffffffffffffffffffffffffff', number: 7 }] } as unknown as GG.ResponsePullRequestStatus);
		expect(renders.count).toBe(0); // coalesced: nothing renders before the frame

		loader.processLoadCommitsResponse(loadCommitsResponse(history(ENTRIES)));

		expect(renders.count).toBe(1);
		vi.advanceTimersByTime(50);
		expect(renders.count).toBe(1);
		expect(Object.keys(store.pullRequestsByHead)).toHaveLength(1); // the PR was still applied
	});
});

describe('keyed row patches: a refs-only update rewrites only the affected rows (task 5.10)', () => {
	it('replaces exactly the row whose refs changed, keeping every other row element (MutationObserver + identity)', async () => {
		const { ctx, loader } = makeView();
		const hashOf = (suffix: number) => ENTRIES[suffix].hash;

		loader.processLoadCommitsResponse(loadCommitsResponse(history(ENTRIES)));
		const tbody = ctx.dom.table.querySelector('table > tbody')!;
		const rowBefore = (suffix: number) => <HTMLElement>tbody.querySelector('tr.commit[data-hash="' + hashOf(suffix) + '"]');

		// Count every commit row the second response replaces, the way the acceptance criteria do.
		// (MutationObserver records are delivered in a microtask, so the assertions flush first.)
		const replaced: string[] = [];
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				mutation.removedNodes.forEach((node) => {
					if (node instanceof HTMLElement && node.classList.contains('commit')) replaced.push(node.dataset.hash!);
				});
			}
		});
		observer.observe(tbody, { childList: true });
		const rowsBefore = ENTRIES.map((_entry, i) => rowBefore(i));

		// The refs-only update: a fresh response (all-new commit objects, as JSON delivery always
		// produces) where exactly one commit gained a branch head
		const entriesAfter = ENTRIES.map((entry, i) => i === 2 ? { hash: entry.hash, heads: ['feature'] } : { hash: entry.hash });
		loader.processLoadCommitsResponse(loadCommitsResponse(history(entriesAfter)));

		await Promise.resolve(); // deliver the observer records

		// Only the row of the ref change was rewritten (a removed tr.commit), and it is the right one
		expect(replaced).toEqual([hashOf(2)]);
		// Every other row is the very same DOM node
		for (let i = 0; i < ENTRIES.length; i++) {
			if (i === 2) continue;
			expect(rowBefore(i)).toBe(rowsBefore[i]);
		}
		// The rewritten row shows the new ref
		expect(rowBefore(2).querySelector('.gitRef.head .gitRefName')!.textContent).toBe('feature');
		expect(rowBefore(2)).not.toBe(rowsBefore[2]);
	});

	it('a re-render whose inputs are all unchanged rebuilds no row at all (the keyed fast path)', async () => {
		const { ctx, loader } = makeView();

		loader.processLoadCommitsResponse(loadCommitsResponse(history(ENTRIES)));
		const tbody = ctx.dom.table.querySelector('table > tbody')!;
		const rowsBefore = Array.from(tbody.querySelectorAll<HTMLElement>('tr.commit'));

		const replaced: HTMLElement[] = [];
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				mutation.removedNodes.forEach((node) => {
					if (node instanceof HTMLElement && node.classList.contains('commit')) replaced.push(node);
				});
			}
		});
		observer.observe(tbody, { childList: true });

		// Same store, same commits: the render a scroll or resize re-runs. The keyed fast path
		// (reference-equal inputs) must keep every row without even building its markup
		ctx.renderScheduler.renderSync();

		await Promise.resolve(); // deliver the observer records
		observer.disconnect();
		expect(replaced).toEqual([]);
		expect(Array.from(tbody.querySelectorAll<HTMLElement>('tr.commit'))).toEqual(rowsBefore);
	});
});

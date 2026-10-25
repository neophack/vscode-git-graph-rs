import { describe, expect, it } from 'vitest';
import * as GG from '../../common/protocol';
import { captureFirstPaintSnapshot, configFingerprint, FIRST_PAINT_SNAPSHOT_VERSION } from '../state/firstPaint';
import type { FirstPaintSnapshot } from '../state/firstPaint';
import type { WebViewState } from '../state/types';
import type { GraphContext } from '../context';
import { RenderScheduler } from '../render/scheduler';
import { RepoLoader } from './repoLoader';

/**
 * The open path of the webview (REFACTOR-PLAN task 4.7): the initial boot sends ZERO
 * loadRepoInfo/loadCommits requests — it only reports `ready` — and the pushed `loadView`
 * response applies the repo-info and commit-page halves through the same processing the
 * partial responses use. The repository's own settings matching the pushed defaults costs no
 * re-request; a repository that selects specific branches re-requests just the commits.
 */

interface SentMessage {
	readonly command: string;
	readonly [field: string]: unknown;
}

/** A GraphContext whose members are no-ops (or recording fakes where the test asserts on them). */
function fakeContext(options: { repos?: GG.GitRepoSet } = {}): { ctx: GraphContext; sent: SentMessage[]; store: Record<string, unknown> } {
	const sent: SentMessage[] = [];
	const repoState = {
		pinnedBranches: [], pinnedCommits: [], cdvDivider: 0, cdvHeight: 0, columnWidths: null,
		commitOrdering: GG.RepoCommitOrdering.Default, fileViewType: 0, gerritFetchRefs: false,
		gerritFetchLimit: null, gerritStatusFilter: { new: true, merged: true, abandoned: true, wip: true },
		hideRemotes: [], includeCommitsMentionedByReflogs: 0, issueLinkingConfig: null, lastImportAt: 0,
		name: null, onlyFollowFirstParent: 0, onRepoLoadShowCheckedOutBranch: 0, onRepoLoadShowSpecificBranches: null,
		pullRequestConfig: null, showRemoteBranches: true, showRemoteBranchesV2: 0, showStashes: 0, showTags: 0,
		workspaceFolderIndex: null
	};
	const store: Record<string, unknown> = {
		repos: options.repos !== undefined ? options.repos : { '/repo': { name: 'repo' } as unknown as GG.GitRepoState },
		currentRepo: null,
		currentRepoLoading: false,
		loadViewTo: null,
		maxCommits: 0,
		gitConfig: null,
		gitRemotes: [],
		gitStashes: [],
		gitTags: [],
		gitBranches: [],
		gitBranchHead: null,
		currentBranches: null,
		currentAuthors: null,
		commitPathFilter: null,
		compareSourceHash: null,
		pullRequestsByHead: {},
		expandedCommit: null,
		commits: [],
		commitLookup: {},
		commitHead: null,
		uncommittedCount: null,
		renderedGitBranchHead: null,
		gerritStates: {},
		gerritStatesDirty: false,
		moreCommitsAvailable: false,
		onlyFollowFirstParent: false,
		scrollTop: 0,
		repoState: repoState,
		hasCurrentRepo: () => false,
		invalidateRender: () => undefined,
		getBranchGlobPatterns: () => [] as string[],
		getBranchOptions: () => [] as unknown[],
		getAuthorOptions: () => [] as unknown[],
		getSelectedBranchesFilter: () => null,
		getSelectedAuthorsFilter: () => null,
		getCommitId: () => null,
		config: {
			repoDropdownOrder: 'alphabetical',
			snapshotFirstPaint: true,
			initialLoadCommits: 100,
			commitOrdering: GG.CommitOrdering.Date,
			showRemoteBranches: true,
			showTags: true,
			showStashes: true,
			includeCommitsMentionedByReflogs: false,
			onlyFollowFirstParent: false,
			fetchAvatars: false,
			pullRequests: { enabled: false },
			onRepoLoad: { scrollToHead: false, showCheckedOutBranch: false, showSpecificBranches: [] }
		},
		refreshState: {
			inProgress: false, snapshotRefreshing: false, hard: false, configChanges: false, requestingRepoInfo: false,
			repoInfoChanges: false, requestingConfig: false,
			loadRepoInfoRefreshId: 0, loadCommitsRefreshId: 0, loadConfigRefreshId: 0
		}
	};
	const noop = () => undefined;
	const ctx = {
		store: store,
		// Route the scheduler's render through the (per-test stubbed) fake table, so render-count
		// assertions observe the passes the loader asks for (task 5.10's renderSync integration).
		renderScheduler: new RenderScheduler(() => { ctx.table.render(); }),
		bridge: {
			send: (message: unknown) => { sent.push(message as SentMessage); }
		},
		persistence: { saveState: noop, saveRepoStateValue: noop, scheduleFirstPaintCapture: noop },
		controls: {
			renderRepoDropdownOptions: noop, syncShowRemoteBranches: noop, renderFetchButton: noop,
			renderFilterButton: noop, renderRefreshButton: noop, renderToolbarText: noop,
			branchDropdown: { setOptions: noop }, authorDropdown: { setOptions: noop },
			repoDropdown: { setOptions: noop }
		},
		viewport: {
			pendingViewportAnchor: null, restoreScrollTop: null, renderedRange: null,
			captureViewportAnchor: () => null, capturePendingViewportAnchor: () => undefined,
			applyViewportAnchor: noop, updateVirtualWindow: noop,
			pendingScrollCommit: null
		},
		table: { showLoadingSkeleton: noop, setFooterLoading: noop, setFooter: noop, render: noop, clear: noop, renderGraph: noop, renderUncommittedChanges: noop },
		graph: { loadCommits: noop },
		details: { close: noop },
		widgets: {
			settings: { close: noop, refresh: noop }, reflog: { close: noop }, worktree: { close: noop },
			statistics: { close: noop }, conflictBanner: { update: noop }, find: { refresh: noop }
		},
		dialog: { closeActionRunning: noop, isTargetDynamicSource: () => false, showError: noop },
		contextMenu: { isTargetDynamicSource: () => false },
		closeDialogAndContextMenu: noop,
		commitBodies: { clear: noop },
		dom: {
			view: { focus: noop, scrollTop: 0, classList: { contains: () => false, add: noop, remove: noop } },
			controls: { classList: { contains: () => false, add: noop, remove: noop } },
			headerRow: { classList: { contains: () => false, add: noop, remove: noop } }
		}
	};
	return { ctx: ctx as unknown as GraphContext, sent: sent, store: store };
}

/** The pushed merged response the host sends once the page reported `ready`. */
function pushedLoadView(refreshId: number): GG.ResponseLoadView {
	return {
		command: 'loadView',
		repo: '/repo',
		refreshId: refreshId,
		repoInfo: {
			branches: ['main'], head: 'main', remotes: ['origin'], stashes: [], isRepo: true,
			operationState: { type: null, conflictedFiles: [], progress: null }, error: null
		},
		commits: {
			commits: [commit('c1')].map((entry) => entry as unknown as GG.GitCommit),
			head: 'c1', tags: [], moreCommitsAvailable: true, onlyFollowFirstParent: false,
			gerritStates: null, uncommittedPending: true, branches: ['main'], error: null
		}
	} as unknown as GG.ResponseLoadView;
}

function commit(hash: string) {
	return { hash: hash, parents: [], author: 'A', email: 'a@x', date: 1, message: 'm', heads: [], tags: [], remotes: [], stash: null };
}

describe('RepoLoader open path (task 4.7)', () => {
	it('the initial boot sends ZERO loadRepoInfo/loadCommits requests (main.ts reports `ready` next)', () => {
		const { ctx, sent } = fakeContext();
		const loader = new RepoLoader(() => ctx);
		loader.start(null, '/repo', null);
		// The boot itself sends nothing: main.ts sends the single `ready` handshake once the
		// response router is installed, and the data arrives as the host's pushed loadView.
		expect(sent).toEqual([]);
		// The repository switch of the boot happened (the pushed response applies to it) ...
		expect((ctx.store as unknown as { currentRepo: string }).currentRepo).toBe('/repo');
		// ... and the loading skeleton shows until the push arrives.
		expect((ctx.store as unknown as { currentRepoLoading: boolean }).currentRepoLoading).toBe(true);
	});

	it('the pushed loadView applies both halves and triggers no re-request when the settings match the defaults', () => {
		const { ctx, sent, store } = fakeContext();
		const loader = new RepoLoader(() => ctx);
		loader.start(null, '/repo', null);
		expect(sent).toEqual([]);

		loader.processLoadView(pushedLoadView(7));
		// The refresh ids adopted the pushed one, so the staged follow-ups (same id) are accepted
		const refreshState = store.refreshState as { loadRepoInfoRefreshId: number; loadCommitsRefreshId: number };
		expect(refreshState.loadRepoInfoRefreshId).toBe(7);
		expect(refreshState.loadCommitsRefreshId).toBe(7);
		// The repo-info half applied ...
		expect(store.gitBranches).toEqual(['main']);
		expect(store.gitBranchHead).toBe('main');
		// ... and the commit-page half rendered the pushed page.
		expect(store.commits).toHaveLength(1);
		expect((store.commits as { hash: string }[])[0].hash).toBe('c1');
		// A repository whose settings match the pushed defaults re-requests nothing: the config
		// load the boot always issues is the only request the open path costs.
		expect(sent.map((message) => message.command)).toEqual(['loadConfig']);
	});

	it('a repository whose settings differ from the pushed defaults re-requests just the commits', () => {
		const { ctx, sent } = fakeContext();
		const loader = new RepoLoader(() => ctx);
		// This repository pins a non-default ordering: the pushed default page does not match it.
		(ctx.store as unknown as { repoState: { commitOrdering: GG.RepoCommitOrdering } }).repoState.commitOrdering = GG.RepoCommitOrdering.Topological;
		loader.start(null, '/repo', null);
		loader.processLoadView(pushedLoadView(7));
		const commands = sent.map((message) => message.command);
		expect(commands).toContain('loadCommits'); // one partial refresh, under the repository's own options
		expect(commands).not.toContain('loadRepoInfo');
	});
});

/** A persisted state whose firstPaint snapshot matches the fake context's repo and config. */
function stateWithSnapshot(ctx: GraphContext, snapshot: FirstPaintSnapshot | null): WebViewState {
	return {
		currentRepo: '/repo',
		currentRepoLoading: false,
		gitRepos: ctx.store.repos,
		gitBranches: ['main'],
		gitBranchHead: 'main',
		gitConfig: null,
		gitRemotes: ['origin'],
		gitStashes: [],
		gitTags: [],
		commitHead: snapshot !== null ? snapshot.head : null,
		currentBranches: null,
		currentAuthors: null,
		moreCommitsAvailable: false,
		maxCommits: 500,
		onlyFollowFirstParent: false,
		scrollTop: 0,
		findWidget: { text: '', currentHash: null, visible: false },
		settingsWidget: { currentRepo: null, scrollTop: 0, repoColumnScrollTop: 0, globalColumnScrollTop: 0 },
		firstPaint: snapshot
	} as unknown as WebViewState;
}

/** A snapshot of the given commits under the fake context's own configuration. */
function snapshotOf(ctx: GraphContext, hashes: string[]): FirstPaintSnapshot {
	return captureFirstPaintSnapshot({
		repo: '/repo',
		head: hashes.length > 0 ? hashes[0] : null,
		config: ctx.store.config,
		commits: hashes.map((hash) => commit(hash) as unknown as GG.GitCommit),
		moreCommitsAvailable: true,
		maxCommits: 500,
		onlyFollowFirstParent: false,
		uncommittedCount: null,
		scrollTop: 0,
		rowHeight: 24,
		viewHeight: 600
	})!;
}

describe('first-paint snapshot (REFACTOR-PLAN 3.8.2 D10, task 5.9)', () => {
	it('paints a valid snapshot at boot: the rows seed immediately and the refresh button spins until the push lands', () => {
		const { ctx, store } = fakeContext();
		let refreshButtonRenderings = 0;
		(ctx.controls as unknown as { renderRefreshButton: () => void }).renderRefreshButton = () => { refreshButtonRenderings++; };
		const snapshot = snapshotOf(ctx, ['c1']);
		const loader = new RepoLoader(() => ctx);

		loader.start(stateWithSnapshot(ctx, snapshot), '/repo', null);

		// The snapshot's rows went through the ordinary loadCommits path ...
		expect((store.commits as { hash: string }[])[0].hash).toBe('c1');
		expect(store.commitHead).toBe('c1');
		expect(store.maxCommits).toBe(500);
		expect((store.refreshState as { snapshotRefreshing: boolean }).snapshotRefreshing).toBe(true);
		// ... and the "refreshing" marker reached the refresh button
		expect(refreshButtonRenderings).toBeGreaterThan(0);
	});

	it('skips the snapshot when it belongs to another repository', () => {
		const { ctx, store } = fakeContext();
		const snapshot = { ...snapshotOf(ctx, ['c1']), repo: '/other-repo' };
		const loader = new RepoLoader(() => ctx);

		loader.start(stateWithSnapshot(ctx, snapshot), '/repo', null);

		expect((store.commits as unknown[])).toEqual([]);
		expect((store.refreshState as { snapshotRefreshing: boolean }).snapshotRefreshing).toBe(false);
	});

	it('skips the snapshot when the configuration changed since it was captured', () => {
		const { ctx, store } = fakeContext();
		const snapshot = { ...snapshotOf(ctx, ['c1']), configFingerprint: configFingerprint({} as GG.GitGraphViewConfig) };
		const loader = new RepoLoader(() => ctx);

		loader.start(stateWithSnapshot(ctx, snapshot), '/repo', null);

		expect((store.commits as unknown[])).toEqual([]);
	});

	it('skips a corrupt or foreign-version snapshot (never a throw, never a paint)', () => {
		const { ctx, store } = fakeContext();
		const good = snapshotOf(ctx, ['c1']);
		const corrupt = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
		delete corrupt.commits;
		const foreign = { ...good, version: FIRST_PAINT_SNAPSHOT_VERSION + 1 };
		const loader = new RepoLoader(() => ctx);

		loader.start(stateWithSnapshot(ctx, corrupt as unknown as FirstPaintSnapshot), '/repo', null);
		expect((store.commits as unknown[])).toEqual([]);

		loader.start(stateWithSnapshot(ctx, foreign), '/repo', null);
		expect((store.commits as unknown[])).toEqual([]);
	});

	it('skips the snapshot when the git-graph-rs.snapshotFirstPaint setting is off', () => {
		const { ctx, store } = fakeContext();
		(ctx.store as unknown as { config: { snapshotFirstPaint: boolean } }).config.snapshotFirstPaint = false;
		const loader = new RepoLoader(() => ctx);

		loader.start(stateWithSnapshot(ctx, snapshotOf(ctx, ['c1'])), '/repo', null);

		expect((store.commits as unknown[])).toEqual([]);
	});

	it('reconciles without re-rendering when the pushed data matches the painted snapshot (the seamless update)', () => {
		const { ctx, store } = fakeContext();
		const renders: number[] = [];
		const anchors: Array<{ hash: string, offset: number, atTop: boolean }> = [];
		// The real CommitTable.render records the branch head the rows were built for (the
		// equality path of the seamless update reads it) - the fake mirrors that
		(ctx.table as unknown as { render: () => void }).render = () => {
			renders.push(renders.length);
			(store as unknown as { renderedGitBranchHead: string | null }).renderedGitBranchHead = (store as unknown as { gitBranchHead: string | null }).gitBranchHead;
		};
		(ctx.viewport as unknown as { captureViewportAnchor: () => unknown }).captureViewportAnchor = () => {
			const anchor = { hash: 'c1', offset: 0, atTop: true };
			anchors.push(anchor);
			return anchor;
		};
		let appliedAnchors = 0;
		(ctx.viewport as unknown as { applyViewportAnchor: (anchor: unknown) => void }).applyViewportAnchor = () => { appliedAnchors++; };
		const snapshot = snapshotOf(ctx, ['c1']);
		const loader = new RepoLoader(() => ctx);
		loader.start(stateWithSnapshot(ctx, snapshot), '/repo', null);
		expect(renders).toHaveLength(1); // the paint rendered exactly once
		appliedAnchors = 0; // drop the paint's own (NULL) anchor applications

		loader.processLoadView(pushedLoadView(7));

		// Identical data reconciles to NOTHING: no second render, no captured anchor, no applied
		// anchor - the painted rows keep their DOM nodes and their coordinates by construction
		expect(renders).toHaveLength(1);
		expect(anchors).toEqual([]);
		expect(appliedAnchors).toBe(0);
		expect((store.refreshState as { snapshotRefreshing: boolean }).snapshotRefreshing).toBe(false);
	});

	it('reconciles a moved HEAD through the anchored rebuild (rows keyed by hash, coordinates stable)', () => {
		const { ctx, store } = fakeContext();
		const applied: Array<{ hash: string, offset: number, atTop: boolean } | null> = [];
		const anchor = { hash: 'c1', offset: 5, atTop: true };
		(ctx.viewport as unknown as { captureViewportAnchor: () => unknown }).captureViewportAnchor = () => anchor;
		(ctx.viewport as unknown as { applyViewportAnchor: (a: unknown) => void }).applyViewportAnchor = (a) => { applied.push(a as { hash: string, offset: number, atTop: boolean }); };
		const snapshot = snapshotOf(ctx, ['c1']);
		const loader = new RepoLoader(() => ctx);
		loader.start(stateWithSnapshot(ctx, snapshot), '/repo', null);
		applied.length = 0; // drop the paint's own (NULL) anchor applications

		// The push carries a rewritten history: a new head commit above c1
		const pushed = pushedLoadView(7);
		(pushed.commits as { commits: GG.GitCommit[], head: string }).commits = [commit('c0') as unknown as GG.GitCommit, commit('c1') as unknown as GG.GitCommit];
		(pushed.commits as { head: string }).head = 'c0';
		loader.processLoadView(pushed);

		// The anchored rebuild ran: the anchor captured from the visible row was re-applied, so
		// the row the user was looking at keeps its position while the new commit lands above it
		expect((store.commits as { hash: string }[]).map((c) => c.hash)).toEqual(['c0', 'c1']);
		expect(applied.length).toBeGreaterThan(0);
		expect(applied.every((a) => a !== null && a.hash === 'c1')).toBe(true);
		expect((store.refreshState as { snapshotRefreshing: boolean }).snapshotRefreshing).toBe(false);
	});
});

// @vitest-environment jsdom
/**
 * The Store's subscription semantics (REFACTOR-PLAN task 5.10): the config listeners replace the
 * old global config-changed plumbing, and the render-invalidation channel is what the render
 * scheduler coalesces - any number of `invalidateRender()` calls within a frame produce ONE
 * render, which is the store-side half of "one response, one render".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as GG from '../../common/protocol';
import { RenderScheduler } from '../render/scheduler';
import { Store } from './store';

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

	it('invalidateRender notifies every subscriber', () => {
		const store = makeStore();
		let a = 0, b = 0;
		store.onRenderChange(() => { a++; });
		store.onRenderChange(() => { b++; });

		store.invalidateRender();
		expect(a).toBe(1);
		expect(b).toBe(1);
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

	it('wired to the render scheduler: N invalidations within a frame merge into ONE render', () => {
		vi.stubGlobal('requestAnimationFrame', undefined); // drive frames with the timers
		const store = makeStore();
		let renders = 0;
		const scheduler = new RenderScheduler(() => { renders++; });
		store.onRenderChange(() => scheduler.request());

		store.invalidateRender();
		store.invalidateRender();
		store.invalidateRender(); // a response that touched several slices of the store
		expect(renders).toBe(0); // nothing before the frame

		vi.advanceTimersByTime(0);
		expect(renders).toBe(1);
	});
});

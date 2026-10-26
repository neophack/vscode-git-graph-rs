import { describe, expect, it } from 'vitest';
import type { GerritChangeState } from '../../shared/model/gerrit';
import {
	buildFetchRefspecs, changeShard, filterChangeStates, limitChangeStates, limitChanges,
	nextGerritSampleWindow, parseChangeRef, selectDisplayedChangeStates
} from './gerritSelection';

/**
 * The pure Gerrit selection math, ported verbatim from src/gerrit.ts (see the module header for
 * why the copy exists): these tests pin the ported behavior so drift against the source of truth
 * is caught by the mirrored cases.
 */

const ALL = { new: true, merged: true, abandoned: true, wip: true };

function state(change: number, status: GerritChangeState['status'] = 'new', wip = false): GerritChangeState {
	return { change: change, patchset: 2, codeReview: 0, verified: 0, status: status, wip: wip, headHash: 'c' + change, events: [], url: null };
}

describe('parseChangeRef', () => {
	it('parses remote, local and meta change refs', () => {
		expect(parseChangeRef('refs/changes/24/41466/1')).toEqual({ change: 41466, patchset: 1, meta: false });
		expect(parseChangeRef('refs/remotes/origin/changes/24/41466/2')).toEqual({ change: 41466, patchset: 2, meta: false });
		expect(parseChangeRef('refs/changes/24/41466/meta')).toEqual({ change: 41466, meta: true });
	});

	it('rejects non-change refs', () => {
		expect(parseChangeRef('refs/heads/main')).toBeNull();
		expect(parseChangeRef('refs/changes/24/41466/')).toBeNull();
		expect(parseChangeRef('refs/remotes/origin/changes/24/41466/meta')).not.toBeNull(); // the local copy of a meta ref parses too
	});
});

describe('changeShard', () => {
	it('maps a change number to its two digit shard', () => {
		expect(changeShard(41466)).toBe('66');
		expect(changeShard(5)).toBe('05');
		expect(changeShard(100)).toBe('00');
	});
});

describe('limitChanges', () => {
	it('keeps the most recent changes by change number', () => {
		const changes = new Map([[1, [1]], [30, [1, 2]], [7, [1]]]);
		expect(Array.from(limitChanges(changes, 2).keys())).toEqual([30, 7]);
		expect(limitChanges(changes, 0)).toBe(changes); // <= 0 keeps all
		expect(limitChanges(changes, 5)).toBe(changes); // a limit above the size keeps all
	});
});

describe('buildFetchRefspecs', () => {
	it('fetches the latest patchset and the meta ref per change', () => {
		expect(buildFetchRefspecs(new Map([[41466, [1, 2]]]), 'gerrit', 'latest')).toEqual([
			'+refs/changes/66/41466/2:refs/remotes/gerrit/changes/66/41466/2',
			'+refs/changes/66/41466/meta:refs/remotes/gerrit/changes/66/41466/meta'
		]);
	});

	it('fetches every patchset in all mode', () => {
		expect(buildFetchRefspecs(new Map([[41466, [1, 2]]]), 'gerrit', 'all')).toHaveLength(3); // 1, 2 and meta
	});
});

describe('filterChangeStates / limitChangeStates / selectDisplayedChangeStates', () => {
	it('filters by status, with WIP overriding it', () => {
		const states = [state(1, 'new'), state(2, 'merged'), state(3, 'abandoned'), state(4, 'new', true)];
		expect(filterChangeStates(states, { new: true, merged: false, abandoned: false, wip: false }).map((s) => s.change)).toEqual([1]);
		expect(filterChangeStates(states, { new: false, merged: false, abandoned: false, wip: true }).map((s) => s.change)).toEqual([4]);
		expect(filterChangeStates(states, ALL)).toHaveLength(4);
	});

	it('limits to the most recent passing changes', () => {
		const states = [state(1), state(30), state(7)];
		expect(limitChangeStates(states, ALL, 2).map((s) => s.change)).toEqual([30, 7]);
		expect(limitChangeStates(states, ALL, 0).map((s) => s.change)).toEqual([30, 7, 1]);
	});

	it('selects the displayed changes: passing, on the page, most recent first, at most the limit', () => {
		const states = [state(1), state(30), state(7)];
		const onPage = (hash: string) => hash !== 'c30'; // change 30's patchset commit is not on the page
		expect(selectDisplayedChangeStates(states, ALL, 2, onPage).map((s) => s.change)).toEqual([7, 1]);
		expect(selectDisplayedChangeStates(states, ALL, 1, () => true).map((s) => s.change)).toEqual([30]);
	});
});

describe('nextGerritSampleWindow', () => {
	it('stops once enough changes pass, deepens by doubling otherwise', () => {
		expect(nextGerritSampleWindow(4, 20, 20, 100)).toBeNull(); // enough passing already
		expect(nextGerritSampleWindow(4, 3, 20, 100)).toBe(8); // deepen
		expect(nextGerritSampleWindow(8, 3, 20, 10)).toBe(10); // deepen, but no further than the remote's end
		expect(nextGerritSampleWindow(8, 3, 20, 8)).toBeNull(); // the remote is exhausted
	});

	it('never deepens beyond the FACTOR_MAX cap', () => {
		const fetchLimit = 1, cap = 16;
		expect(nextGerritSampleWindow(cap, 0, fetchLimit, 1000)).toBeNull(); // at the cap
		expect(nextGerritSampleWindow(cap / 2, 0, fetchLimit, 1000)).toBe(cap); // the last allowed deepening
	});
});

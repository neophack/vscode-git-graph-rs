// @vitest-environment jsdom
/**
 * The Find Widget's search behaviour: the input debounces (a burst of
 * keystrokes runs ONE search, of the final text), the scan of the loaded commits is incremental
 * (slices per frame, so a large repository never blocks), and a stale search is CANCELLED - the
 * slices still in flight when the query changes (or the widget closes) abort without landing
 * their highlights. The tests run without rAF (the scheduler's setTimeout fallback), so fake
 * timers drive both the debounce and the scan slices deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as GG from '../../common/protocol';
import type { GraphContext } from '../context';
import { FindWidget } from './findWidget';

/** A commit whose row text is its message. */
function commit(hash: string, message: string): GG.GitCommit {
	return { hash: hash, parents: [], author: 'A', email: 'a@x', date: 1700000000, message: message, heads: [], tags: [], remotes: [], stash: null };
}

function makeHarness(commits: GG.GitCommit[]) {
	document.body.textContent = '';
	// The rows the widget scans and highlights: one tr.commit per commit, its message as text
	const tbody = document.createElement('tbody');
	for (let i = 0; i < commits.length; i++) {
		const row = document.createElement('tr');
		row.className = 'commit';
		row.dataset.id = String(i);
		const cell = document.createElement('td');
		cell.appendChild(document.createTextNode(commits[i].message));
		row.appendChild(cell);
		tbody.appendChild(row);
	}
	const table = document.createElement('table');
	table.appendChild(tbody);
	document.body.appendChild(table);

	const workspaceViewState = { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false };
	const commitLookup = new Map<string, number>();
	commits.forEach((entry, index) => { commitLookup.set(entry.hash, index); });
	const store = {
		commits: commits,
		// The commits slice's lookup is a Map the widget reads through getCommitId (F1)
		getCommitId: (hash: string) => (commitLookup.has(hash) ? (commitLookup.get(hash) as number) : null),
		workspaceViewState: workspaceViewState,
		hasCurrentRepo: () => true,
		config: {
			dateFormat: { type: GG.DateFormatType.DateAndTime, iso: false },
			referenceLabels: { combineLocalAndRemoteBranchLabels: false }
		}
	};

	const calls = { exitWindowedRender: 0, searches: 0 };
	const noop = () => undefined;
	const ctx = {
		store: store,
		persistence: { updateWorkspaceViewState: noop, saveState: noop },
		viewport: {
			exitWindowedRender: () => { calls.exitWindowedRender++; },
			updateVirtualWindow: noop,
			scrollToCommit: noop
		},
		layout: { isTwoLineRows: () => false, getColumnVisibility: () => ({ date: true, author: true, commit: true }) },
		details: { isOpen: () => true, load: noop },
		table: { findCommitElem: () => null },
		// The widget scopes its row scan to the commit table (F3): the rows above are its DOM
		dom: { table: <HTMLElement>table }
	} as unknown as GraphContext;

	const widget = new FindWidget(() => ctx);
	widget.show(false);
	return { widget: widget, input: document.getElementById('findInput') as HTMLInputElement, calls: calls };
}

/** Type a query: set the input's value and raise the (debounced) keyup. */
function type(input: HTMLInputElement, text: string) {
	input.value = text;
	input.dispatchEvent(new KeyboardEvent('keyup', { key: text.charAt(text.length - 1), bubbles: true }));
}

/** Every find-match highlight currently in the table. */
const matchSpans = () => Array.from(document.querySelectorAll('.findMatch'));

describe('the find input debounces', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('requestAnimationFrame', undefined); // the scheduler's setTimeout fallback
	});
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	it('a burst of keystrokes runs ONE search, of the final text', () => {
		const commits = [commit('c1', 'feat: a'), commit('c2', 'feat: b'), commit('c3', 'fix: c'), commit('c4', 'fix: d'), commit('c5', 'chore: e')];
		const { input, calls } = makeHarness(commits);

		type(input, 'f');
		type(input, 'fe');
		type(input, 'fea');
		type(input, 'feat');
		vi.advanceTimersByTime(199);
		expect(calls.exitWindowedRender).toBe(0); // nothing searched yet
		vi.advanceTimersByTime(1);

		expect(calls.exitWindowedRender).toBe(1); // exactly one scan started
		// The search ran to completion (small list, first slice): both 'feat' rows highlighted
		expect(matchSpans().map((span) => span.textContent)).toEqual(['feat', 'feat']);
	});
});

describe('the search is incremental and stale searches are cancelled', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('requestAnimationFrame', undefined);
	});
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	/** 1200 commits: 'apple N' and 'zebra N' alternating - 'appl' matches 600 of them. */
	function largeHistory(): GG.GitCommit[] {
		const commits: GG.GitCommit[] = [];
		for (let i = 0; i < 1200; i++) {
			commits.push(commit('c' + String(i).padStart(4, '0') + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', (i % 2 === 0 ? 'apple ' : 'zebra ') + i));
		}
		return commits;
	}

	it('scans in slices across frames: the first slice lands synchronously, the rest are scheduled', () => {
		const { input, widget } = makeHarness(largeHistory());

		type(input, 'appl');
		vi.advanceTimersByTime(200); // the debounce fires; slice 1 runs synchronously
		expect(widget.isScanning()).toBe(true); // slices 2-3 still pending
		expect(matchSpans().length).toBe(250); // the first slice covered commits 0..499 (250 apples)

		vi.advanceTimersByTime(1); // slice 2
		expect(matchSpans().length).toBe(500);
		vi.advanceTimersByTime(1); // slice 3: the scan completes
		expect(widget.isScanning()).toBe(false);
		expect(matchSpans().length).toBe(600);
	});

	it('a query change mid-scan cancels the stale search: its later slices never land highlights', () => {
		const { input, widget } = makeHarness(largeHistory());

		type(input, 'appl');
		vi.advanceTimersByTime(200); // slice 1 of 'appl' ran
		expect(widget.isScanning()).toBe(true);

		type(input, 'zzz'); // superseded before its slices finish
		vi.advanceTimersByTime(200); // the new debounce fires; the 'appl' slices are cancelled

		// 'zzz' matches nothing, but the scan still walks the whole list in slices - run it out
		vi.advanceTimersByTime(100);
		expect(widget.isScanning()).toBe(false);
		expect(matchSpans()).toEqual([]); // no 'appl' highlight survived or landed late
		expect(document.getElementById('findPosition')!.textContent).not.toContain('600'); // 'zzz' has no results
	});

	it('closing the widget cancels an in-flight scan', () => {
		const { input, widget } = makeHarness(largeHistory());

		type(input, 'appl');
		vi.advanceTimersByTime(200);
		expect(widget.isScanning()).toBe(true);

		widget.close();
		vi.advanceTimersByTime(100);
		expect(widget.isScanning()).toBe(false);
		expect(matchSpans()).toEqual([]);
	});
});

describe('incremental matching refines from the previous result', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('requestAnimationFrame', undefined);
	});
	afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

	it('a query that extends the previous one rescans only its matches - and finds exactly the same rows a full scan would', () => {
		const commits = [commit('c1', 'fix: one'), commit('c2', 'fix: two'), commit('c3', 'fixup: three'), commit('c4', 'feat: four'), commit('c5', 'chore: five')];
		const { input } = makeHarness(commits);

		type(input, 'fix');
		vi.advanceTimersByTime(200);
		expect(matchSpans().map((span) => span.textContent)).toEqual(['fix', 'fix', 'fix']); // fix, fix, fixup

		type(input, 'fixu'); // extends 'fix': only 'fixup: three' can match
		vi.advanceTimersByTime(200);
		expect(matchSpans().map((span) => span.textContent)).toEqual(['fixu']);
		expect(matchSpans()[0].closest('tr')!.dataset.id).toBe('2'); // the row a full scan would find
	});
});

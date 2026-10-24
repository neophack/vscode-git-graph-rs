import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * vscodeCompat is tested against a fake 'vscode' module: the compat wrappers must answer NULL
 * whenever the API they probe is absent (older editors, test stubs) or shaped differently, and
 * hand the real object through when it is present. The fake module object is swapped per test
 * through a hoisted mutable (vi.mock factories are hoisted above every const declaration).
 */
const vscodeMock = vi.hoisted(() => ({ window: {} as Record<string, unknown> }));

vi.mock('vscode', () => vscodeMock);

import { tabGroups } from './vscodeCompat';

const FULL_TAB_GROUPS = {
	all: [
		{ viewColumn: 1, tabs: [{ input: { viewType: 'git-graph-rs' } }] },
		{ viewColumn: 2, tabs: [] }
	],
	close: (_tab: unknown, _preserveFocus?: boolean) => Promise.resolve(true)
};

beforeEach(() => {
	vscodeMock.window = {};
});

describe('tabGroups compat probe', () => {
	it('returns NULL when the Tab API is absent (VS Code < 1.67, or a stub without tabGroups)', () => {
		expect(vscodeMock.window.tabGroups).toBeUndefined();
		expect(tabGroups()).toBeNull();
	});

	it('returns NULL for malformed tabGroups (all not an array, group without tabs array)', () => {
		vscodeMock.window.tabGroups = { all: 'nope' };
		expect(tabGroups()).toBeNull();
		vscodeMock.window.tabGroups = { all: [{ viewColumn: 1 }] };
		expect(tabGroups()).toBeNull();
		vscodeMock.window.tabGroups = null;
		expect(tabGroups()).toBeNull();
	});

	it('hands through the real Tab Groups API when present', () => {
		vscodeMock.window.tabGroups = FULL_TAB_GROUPS;
		const groups = tabGroups();
		expect(groups).toBe(FULL_TAB_GROUPS);
		expect(groups !== null && groups.all.length).toBe(2);
		expect(groups !== null && Array.isArray(groups.all[0].tabs)).toBe(true);
	});

	it('exposes close as an optional member the caller feature-detects', () => {
		vscodeMock.window.tabGroups = FULL_TAB_GROUPS;
		expect(typeof tabGroups()?.close).toBe('function');

		const readOnly = { all: [] };
		vscodeMock.window.tabGroups = readOnly;
		const groups = tabGroups();
		expect(groups).toBe(readOnly);
		expect(groups !== null && groups.close).toBeUndefined();
	});
});

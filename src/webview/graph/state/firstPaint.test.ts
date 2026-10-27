import { describe, expect, it } from 'vitest';

import type * as GG from '../../common/protocol';
import {
	captureFirstPaintSnapshot,
	configFingerprint,
	decodeFirstPaintSnapshot,
	FIRST_PAINT_SNAPSHOT_MAX_LENGTH,
	FIRST_PAINT_SNAPSHOT_VERSION
} from './firstPaint';

/**
 * The first-paint snapshot's pure halves: the capture (with
 * its 200 KB cap and the visible-window guarantee), the lenient decode (corruption and foreign
 * versions answer NULL, never a throw), and the configuration fingerprint the reopen compares.
 * The paint itself is covered by the RepoLoader suite (it flows through the ordinary
 * loadCommits path); this suite pins the data layer.
 */

const CONFIG = { initialLoadCommits: 500 } as unknown as GG.GitGraphViewConfig;
const OTHER_CONFIG = { initialLoadCommits: 1000 } as unknown as GG.GitGraphViewConfig;

function commit(hash: string, messageLength: number = 40): GG.GitCommit {
	let message = 'm';
	while (message.length < messageLength) message += 'x';
	return {
		hash: hash,
		parents: [],
		author: 'Author Name',
		email: 'author@example.com',
		date: 1700000000,
		message: message,
		heads: hash === 'c1' ? ['main'] : [],
		tags: [{ name: 'v1.0', annotated: true }],
		remotes: [{ name: 'origin/main', remote: 'origin' }],
		stash: null
	};
}

function capture(commits: ReadonlyArray<GG.GitCommit>, overrides: Partial<Parameters<typeof captureFirstPaintSnapshot>[0]> = {}) {
	return captureFirstPaintSnapshot({
		repo: '/repo',
		head: 'c1',
		config: CONFIG,
		commits: commits,
		moreCommitsAvailable: true,
		maxCommits: 500,
		onlyFollowFirstParent: false,
		uncommittedCount: 3,
		scrollTop: 0,
		rowHeight: 24,
		viewHeight: 600,
		...overrides
	});
}

describe('configFingerprint', () => {
	it('is stable for the same configuration and differs when a setting changes', () => {
		expect(configFingerprint(CONFIG)).toBe(configFingerprint(CONFIG));
		expect(configFingerprint(CONFIG)).not.toBe(configFingerprint(OTHER_CONFIG));
		// A structurally equal copy fingerprints the same (the reopen compares its own config)
		expect(configFingerprint({ ...CONFIG })).toBe(configFingerprint(CONFIG));
	});
});

describe('captureFirstPaintSnapshot', () => {
	it('captures the loaded commits with the repo, head, fingerprint and render bookkeeping', () => {
		const commits = [commit('c1'), commit('c2'), commit('c3')];
		const snapshot = capture(commits);
		expect(snapshot).not.toBeNull();
		expect(snapshot!.version).toBe(FIRST_PAINT_SNAPSHOT_VERSION);
		expect(snapshot!.repo).toBe('/repo');
		expect(snapshot!.head).toBe('c1');
		expect(snapshot!.commits).toEqual(commits);
		expect(snapshot!.configFingerprint).toBe(configFingerprint(CONFIG));
		expect(snapshot!.moreCommitsAvailable).toBe(true);
		expect(snapshot!.maxCommits).toBe(500);
		expect(snapshot!.onlyFollowFirstParent).toBe(false);
		expect(snapshot!.uncommittedCount).toBe(3);
	});

	it('answers NULL for an empty commit list (nothing to paint)', () => {
		expect(capture([])).toBeNull();
	});

	it('round-trips through JSON and the decoder', () => {
		const snapshot = capture([commit('c1'), commit('c2')])!;
		const decoded = decodeFirstPaintSnapshot(JSON.parse(JSON.stringify(snapshot)));
		expect(decoded).toEqual(snapshot);
	});

	it('enforces the 200 KB cap by trimming the OLDEST commits (the tail), keeping the head-side rows', () => {
		// Each entry is ~300 bytes of JSON, so a few hundred commits exceed the cap
		const commits: GG.GitCommit[] = [];
		for (let i = 0; i < 1200; i++) commits.push(commit('commit-' + String(i).padStart(5, '0'), 200));
		expect(JSON.stringify(commits).length).toBeGreaterThan(FIRST_PAINT_SNAPSHOT_MAX_LENGTH);

		const snapshot = capture(commits, { scrollTop: 0, viewHeight: 600 })!;
		expect(snapshot).not.toBeNull();
		expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(FIRST_PAINT_SNAPSHOT_MAX_LENGTH);
		// The retained slice is a PREFIX: the fresh data of a reopen starts from HEAD, so the
		// head-side rows are exactly what the reconciliation overlaps
		expect(snapshot!.commits[0].hash).toBe('commit-00000');
		expect(snapshot!.commits.length).toBeLessThan(commits.length);
		expect(snapshot!.commits[snapshot!.commits.length - 1].hash).toBe(commits[snapshot!.commits.length - 1].hash ? 'commit-' + String(snapshot!.commits.length - 1).padStart(5, '0') : '');
	});

	it('skips the snapshot entirely when the cap cannot retain the visible window', () => {
		// The user scrolled deep into a huge history: the head-side trim would drop their rows
		const commits: GG.GitCommit[] = [];
		for (let i = 0; i < 1200; i++) commits.push(commit('commit-' + String(i).padStart(5, '0'), 200));
		const deepScroll = 1000 * 24; // row 1000, far beyond what the cap retains
		expect(capture(commits, { scrollTop: deepScroll, viewHeight: 600 })).toBeNull();
		// ... while the same history near the top still snapshots (the window is retained)
		expect(capture(commits, { scrollTop: 0, viewHeight: 600 })).not.toBeNull();
	});

	it('skips the snapshot when not even one commit fits the cap', () => {
		const huge = [commit('c1', FIRST_PAINT_SNAPSHOT_MAX_LENGTH + 100)];
		expect(capture(huge)).toBeNull();
	});
});

describe('decodeFirstPaintSnapshot', () => {
	it('answers NULL for a foreign snapshot version (a newer or older schema is never partially trusted)', () => {
		const snapshot = capture([commit('c1')])!;
		expect(decodeFirstPaintSnapshot({ ...snapshot, version: FIRST_PAINT_SNAPSHOT_VERSION + 1 })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, version: 0 })).toBeNull();
	});

	it('answers NULL for corrupt input of every shape (never a throw)', () => {
		const snapshot = capture([commit('c1')])!;
		expect(decodeFirstPaintSnapshot(null)).toBeNull();
		expect(decodeFirstPaintSnapshot('{"truncated')).toBeNull();
		expect(decodeFirstPaintSnapshot(42)).toBeNull();
		expect(decodeFirstPaintSnapshot([])).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, repo: 7 })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, head: 7 })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, configFingerprint: 'x' })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, commits: 'nope' })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, commits: [] })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, moreCommitsAvailable: 'yes' })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, maxCommits: '500' })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, onlyFollowFirstParent: 1 })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, uncommittedCount: '3' })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, scrollTop: -5 })).toBeNull();
		expect(decodePersistedCorrupt({ ...snapshot, scrollTop: Number.NaN })).toBeNull();
	});

	it('answers NULL when a commit entry is malformed (the renderer must never meet a broken row)', () => {
		const snapshot = capture([commit('c1'), commit('c2')])!;
		const broken = JSON.parse(JSON.stringify(snapshot));
		delete broken.commits[1].hash;
		expect(decodeFirstPaintSnapshot(broken)).toBeNull();

		const wrongParents = JSON.parse(JSON.stringify(snapshot));
		wrongParents.commits[0].parents = [7];
		expect(decodeFirstPaintSnapshot(wrongParents)).toBeNull();

		const wrongTags = JSON.parse(JSON.stringify(snapshot));
		wrongTags.commits[0].tags = [{ name: 'v1.0' }];
		expect(decodeFirstPaintSnapshot(wrongTags)).toBeNull();

		const wrongStash = JSON.parse(JSON.stringify(snapshot));
		wrongStash.commits[0].stash = { noSelector: true };
		expect(decodeFirstPaintSnapshot(wrongStash)).toBeNull();
	});
});

/** decode of a mutated snapshot, typed around the strict record input. */
function decodePersistedCorrupt(record: unknown): ReturnType<typeof decodeFirstPaintSnapshot> {
	return decodeFirstPaintSnapshot(record);
}

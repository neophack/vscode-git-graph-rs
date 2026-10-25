import { beforeAll, describe, expect, it } from 'vitest';

import type { HostBridge } from '../../common/host/bridge';
import type { Store } from './store';
import {
	Persistence,
	WEBVIEW_STATE_VERSION,
	decodePersistedWebViewState,
	encodePersistedWebViewState
} from './persistence';
import type { WebViewState } from './types';

/**
 * The versioned persistence of the Git Graph View's state (REFACTOR-PLAN §3.7.2 "User data").
 * The WebViewState FIELDS are a frozen public contract (§2.2), so the version travels as an
 * extra field on the persisted record. Samples come from test/fixtures/user-data/, one
 * directory per historical version: 1.0.27 (pre-versioning), current (v1) and a v2 record
 * written by a NEWER page (unknown fields, downgrade case).
 */

/** The webview tsconfig compiles without Node types; declare the Vite glob the loader uses. */
declare global {
	interface ImportMeta {
		glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, unknown>;
	}
}

/** One sample directory per historical version. */
const SAMPLE_DIRS = ['1.0.27', 'current', 'v2-newer-writer'];

/** The raw text of every webviewState.json sample, loaded through Vite (no Node builtins: the webview tree never imports them, §3.6). */
const SAMPLE_TEXT = import.meta.glob('/test/fixtures/user-data/*/webviewState.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function loadSample(dir: string): WebViewState {
	const key = Object.keys(SAMPLE_TEXT).find((candidate) => candidate.indexOf('/user-data/' + dir + '/webviewState.json') !== -1);
	if (key === undefined) throw new Error('Missing webviewState.json sample for ' + dir);
	return JSON.parse(SAMPLE_TEXT[key]) as WebViewState;
}

/** `saveState` debounces the snapshot mirror through `window.setTimeout`. */
beforeAll(() => {
	(globalThis as { window?: unknown }).window = {
		setTimeout: (handler: () => void, timeout: number) => setTimeout(handler, timeout),
		clearTimeout: (handle: number) => clearTimeout(handle)
	};
});

/** A Store fake carrying every field `saveState` reads, filled from a sample. */
function fakeStore(sample: WebViewState): Store {
	return {
		currentRepo: sample.currentRepo,
		repos: sample.gitRepos,
		gitBranches: sample.gitBranches,
		gitBranchHead: sample.gitBranchHead,
		gitConfig: sample.gitConfig,
		gitRemotes: sample.gitRemotes,
		gitStashes: sample.gitStashes,
		gitTags: sample.gitTags,
		commitHead: sample.commitHead,
		currentBranches: sample.currentBranches,
		currentAuthors: sample.currentAuthors,
		moreCommitsAvailable: sample.moreCommitsAvailable,
		maxCommits: sample.maxCommits,
		onlyFollowFirstParent: sample.onlyFollowFirstParent,
		scrollTop: sample.scrollTop,
		commitPathFilter: sample.commitPathFilter,
		compareSourceHash: sample.compareSourceHash,
		repoState: sample.gitRepos[sample.currentRepo]
	} as unknown as Store;
}

/** A HostBridge fake: getState/setState record the persisted state, send records messages. */
function fakeBridge(): HostBridge<WebViewState> {
	let persisted: WebViewState | null = null;
	return {
		getState: () => persisted,
		setState: (state: WebViewState) => { persisted = state; },
		send: () => undefined
	} as unknown as HostBridge<WebViewState>;
}

describe('versioned webview state (REFACTOR-PLAN §3.7.2)', () => {
	it.each(SAMPLE_DIRS)('round-trips the %s webviewState.json sample: decode → encode → decode', (dir) => {
		const sample = loadSample(dir);

		const decoded = decodePersistedWebViewState(sample);
		expect(decoded).not.toBeNull();

		const encoded = encodePersistedWebViewState(decoded!);
		const again = decodePersistedWebViewState(encoded);
		expect(again).toEqual(encoded);
	});

	it('migrates the unversioned 1.0.27 sample to the current version', () => {
		const sample = loadSample('1.0.27');

		const decoded = decodePersistedWebViewState(sample);
		expect(decoded !== null && decoded.version).toBe(WEBVIEW_STATE_VERSION);
		expect(decoded !== null && decoded.currentRepo).toBe(sample.currentRepo);
		expect(decoded).toEqual(encodePersistedWebViewState(sample));
	});

	it('answers the current sample unchanged (no behavior change for current-version data)', () => {
		const sample = loadSample('current');

		const decoded = decodePersistedWebViewState(sample);
		expect(decoded).toEqual({ ...sample, version: WEBVIEW_STATE_VERSION });
	});

	it('preserves a newer writer\'s (version+1) record and unknown fields on read', () => {
		const sample = loadSample('v2-newer-writer') as WebViewState & Record<string, unknown>;

		const decoded = decodePersistedWebViewState(sample);
		// The downgrade read keeps the newer version stamp and the unknown field
		expect(decoded !== null && decoded.version).toBe(WEBVIEW_STATE_VERSION + 1);
		expect(decoded !== null && (decoded as unknown as Record<string, unknown>).commitGraphStyle).toBe('linear');
		// ... and every known field
		expect(decoded !== null && decoded.currentRepo).toBe(sample.currentRepo);
		expect(decoded !== null && decoded.findWidget).toEqual(sample.findWidget);
	});

	it('answers NULL for anything that is not a state record, and normalizes bare records', () => {
		expect(decodePersistedWebViewState(null)).toBeNull();
		expect(decodePersistedWebViewState(undefined)).toBeNull();
		expect(decodePersistedWebViewState('{"truncated:')).toBeNull();
		expect(decodePersistedWebViewState(42)).toBeNull();
		expect(decodePersistedWebViewState(['not', 'a', 'record'])).toBeNull();
		// A bare record survives leniently: never a throw, fields kept, version stamped
		expect(decodePersistedWebViewState({})).toEqual({ version: WEBVIEW_STATE_VERSION });
	});

	it('saveState persists the state stamped with the current version (strict write)', () => {
		const sample = loadSample('current');
		const persistence = new Persistence(fakeStore(sample), fakeBridge());
		persistence.setWidgets({
			getFindWidgetState: () => sample.findWidget,
			getSettingsWidgetState: () => sample.settingsWidget
		});

		persistence.saveState();

		const persisted = (persistence as unknown as { bridge: HostBridge<WebViewState> }).bridge.getState();
		// saveState always re-flags the repository as loading: a reloaded page reloads its data
		const expected = encodePersistedWebViewState(Object.assign({}, sample, { currentRepoLoading: true }));
		expect(persisted).toEqual(expected);
		expect(persisted !== null && (persisted as unknown as Record<string, unknown>).version).toBe(WEBVIEW_STATE_VERSION);
	});

	it('saveState is a no-op before the widgets are connected', () => {
		const sample = loadSample('current');
		const persistence = new Persistence(fakeStore(sample), fakeBridge());

		// Must not throw despite the missing widgets
		persistence.saveState();
		expect((persistence as unknown as { bridge: HostBridge<WebViewState> }).bridge.getState()).toBeNull();
	});
});

/**
 * `RepoFileWatcher` turns repository file events into (debounced) refresh callbacks. The watcher
 * is muted for the duration of every message the extension host handles; a naive
 * "return while muted" would DROP events: a commit made in a terminal or by VS Code's own Git while
 * the webview was loading data would never refresh the view (a new commit would only appear after
 * some unrelated change).
 *
 * These tests pin the replacement contract of `RepoFileWatcher`:
 * a muted event is remembered and its refresh runs once the mute ends, past the post-action
 * suppression window, with the commit-graph classification accumulated across the whole debounce
 * window.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

/* The recording stand-in for `vscode.workspace.createFileSystemWatcher` the hoisted mock serves. */
const watcherState = vi.hoisted(() => {
	const handlerSets: Array<{ create: (uri: unknown) => void, change: (uri: unknown) => void, delete: (uri: unknown) => void, disposed?: boolean }> = [];
	return {
		handlerSets,
		lastHandlers() { return handlerSets[handlerSets.length - 1]; }
	};
});

vi.mock('vscode', () => {
	class RelativePatternStub {
		constructor(base: unknown, pattern: string) {
			(this as unknown as Record<string, unknown>).base = base;
			(this as unknown as Record<string, unknown>).pattern = pattern;
		}
	}
	const disposable = () => ({ dispose() { /* nothing */ } });
	return {
		RelativePattern: RelativePatternStub,
		Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
		env: { language: 'en' },
		ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		window: {
			createOutputChannel: () => ({ appendLine() { /* nothing */ }, show() { /* nothing */ }, dispose() { /* nothing */ } }),
			showWarningMessage: async () => undefined,
			showErrorMessage: async () => undefined
		},
		workspace: {
			createFileSystemWatcher: () => {
				const handlers: { create: (uri: unknown) => void, change: (uri: unknown) => void, delete: (uri: unknown) => void, disposed?: boolean } = { create: () => { /* nothing */ }, change: () => { /* nothing */ }, delete: () => { /* nothing */ } };
				watcherState.handlerSets.push(handlers);
				return {
					onDidCreate: (cb: (uri: unknown) => void) => { handlers.create = cb; return disposable(); },
					onDidChange: (cb: (uri: unknown) => void) => { handlers.change = cb; return disposable(); },
					onDidDelete: (cb: (uri: unknown) => void) => { handlers.delete = cb; return disposable(); },
					dispose: () => { handlers.disposed = true; }
				};
			},
			getConfiguration: () => ({
				get: (_section: string, defaultValue: unknown) => defaultValue,
				has: () => false,
				inspect: () => undefined,
				update: () => Promise.resolve()
			})
		}
	};
});

import { RepoFileWatcher } from './repoFileWatcher';

const REPO = 'C:/repos/demo';

/**
 * Make a watcher whose repo change callback records invocations, and drive it with mock timers
 * (the debounces are 750ms/1500ms of real time otherwise).
 */
function makeWatcher() {
	const repoChanges: boolean[] = [];
	const configChanges: boolean[] = [];
	const watcher = new RepoFileWatcher(
		{ log() { /* silent */ }, logError() { /* silent */ } } as never,
		(commitsAffected: boolean) => repoChanges.push(commitsAffected),
		() => configChanges.push(true)
	);
	watcher.start(REPO);
	return { watcher, repoChanges, configChanges };
}

/** Fire an onDidChange event for a path inside the watched repository. */
function fireChange(...pathComps: string[]) {
	const handlers = watcherState.lastHandlers()!;
	handlers.change({ fsPath: [...pathComps].join('/') });
}

describe('RepoFileWatcher muted events', () => {
	beforeEach(() => {
		// The debounces derive from Date.now() (the post-action suppression window), so the clock
		// is mocked too - otherwise a real millisecond elapsing between unmute() and the tick makes
		// the 1500ms boundary flaky
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires the refresh after the debounce when no mute is active', () => {
		const { watcher, repoChanges } = makeWatcher();
		fireChange(REPO, 'src', 'main.ts');
		vi.advanceTimersByTime(749);
		assert.deepStrictEqual(repoChanges, []);
		vi.advanceTimersByTime(1);
		assert.deepStrictEqual(repoChanges, [false]); // working tree only
		watcher.stop();
	});

	it('fires a refresh for events that arrived while muted (deferred, not dropped)', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		fireChange(REPO, '.git', 'refs', 'heads', 'main'); // a commit moved the branch tip
		vi.advanceTimersByTime(5000);
		assert.deepStrictEqual(repoChanges, []); // nothing may fire while muted

		watcher.unmute(); // schedules past the post-action suppression window (1500ms)
		vi.advanceTimersByTime(1499);
		assert.deepStrictEqual(repoChanges, []);
		vi.advanceTimersByTime(1);
		assert.deepStrictEqual(repoChanges, [true]); // the commit graph changed
		watcher.stop();
	});

	it('unions the classification of muted and unmuted events of one debounce window', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		fireChange(REPO, '.git', 'index'); // `git commit` writes the index first...
		watcher.unmute(); // the pending muted refresh is scheduled past the suppression window
		fireChange(REPO, '.git', 'refs', 'heads', 'main'); // ...then moves the branch ref (reschedules the same window)
		vi.advanceTimersByTime(2000);
		assert.deepStrictEqual(repoChanges, [true]); // one refresh, with the union
		watcher.stop();
	});

	it('reports the config callback for .git/config even while muted, and still refreshes afterwards', () => {
		const { watcher, repoChanges, configChanges } = makeWatcher();
		watcher.mute();
		fireChange(REPO, '.git', 'config');
		assert.deepStrictEqual(configChanges, [true]); // caches must be dropped immediately
		assert.deepStrictEqual(repoChanges, []); // ...but the refresh still waits for the mute
		watcher.unmute();
		vi.advanceTimersByTime(1500);
		assert.deepStrictEqual(repoChanges, [true]); // the config can change the commit graph
		watcher.stop();
	});

	it('drops nothing into a stopped watcher: stop() cancels a pending muted refresh', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		fireChange(REPO, '.git', 'refs', 'heads', 'main');
		watcher.stop();
		watcher.unmute();
		vi.advanceTimersByTime(5000);
		assert.deepStrictEqual(repoChanges, []);
	});

	it('collapses a burst of muted events into a single refresh', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		for (let i = 0; i < 5; i++) fireChange(REPO, 'src', 'file' + i + '.ts');
		fireChange(REPO, '.git', 'index');
		watcher.unmute();
		vi.advanceTimersByTime(1500);
		assert.deepStrictEqual(repoChanges, [false]); // one callback, working-tree classification
		watcher.stop();
	});
});

/**
 * `RepoFileWatcher` turns repository file events into (debounced) refresh callbacks. The watcher
 * is muted for the duration of every message the extension host handles, so the historical
 * "return while muted" DROPPED events: a commit made in a terminal or by VS Code's own Git while
 * the webview was loading data never refreshed the view (a new commit then only appeared after
 * some unrelated change). These tests pin the replacement contract: a muted event is remembered
 * and its refresh runs once the mute ends, past the post-action suppression window, with the
 * commit-graph classification accumulated across the whole debounce window.
 */

import assert from 'node:assert/strict';
import { Module } from 'node:module';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';

/* The stand-in for the extension host (src/repoFileWatcher.ts requires 'vscode' directly). */
class RelativePatternStub {
	constructor(base, pattern) {
		this.base = base;
		this.pattern = pattern;
	}
}
const watcherEventHandlers = [];
const vscodeStub = {
	RelativePattern: RelativePatternStub,
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined
	},
	workspace: {
		createFileSystemWatcher: (pattern) => {
			const handlers = {};
			watcherEventHandlers.push(handlers);
			return {
				pattern,
				onDidCreate: (cb) => { handlers.create = cb; },
				onDidChange: (cb) => { handlers.change = cb; },
				onDidDelete: (cb) => { handlers.delete = cb; },
				dispose: () => { handlers.disposed = true; }
			};
		},
		getConfiguration: () => ({
			get: (_section, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { RepoFileWatcher } = await import('../out/repoFileWatcher.js');

const REPO = 'C:/repos/demo';

/**
 * Make a watcher whose repo change callback records invocations, and drive it with mock timers
 * (the debounces are 750ms/1500ms of real time otherwise).
 */
function makeWatcher() {
	const repoChanges = [];
	const configChanges = [];
	const watcher = new RepoFileWatcher(
		{ log() {}, logError() {} },
		(commitsAffected) => repoChanges.push(commitsAffected),
		() => configChanges.push(true)
	);
	watcher.start(REPO);
	return { watcher, repoChanges, configChanges };
}

/** Fire an onDidChange event for a path inside the watched repository. */
function fireChange(...pathComps) {
	const handlers = watcherEventHandlers[watcherEventHandlers.length - 1];
	handlers.change({ fsPath: [...pathComps].join('/') });
}

describe('RepoFileWatcher muted events', () => {
	beforeEach(() => {
		// The debounces derive from Date.now() (the post-action suppression window), so the clock
		// is mocked too - otherwise a real millisecond elapsing between unmute() and tick() makes
		// the 1500ms boundary flaky
		mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	});
	afterEach(() => {
		mock.timers.reset();
	});

	it('fires the refresh after the debounce when no mute is active', () => {
		const { watcher, repoChanges } = makeWatcher();
		fireChange(REPO, 'src', 'main.ts');
		mock.timers.tick(749);
		assert.deepStrictEqual(repoChanges, []);
		mock.timers.tick(1);
		assert.deepStrictEqual(repoChanges, [false]); // working tree only
		watcher.stop();
	});

	it('fires a refresh for events that arrived while muted (deferred, not dropped)', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		fireChange(REPO, '.git', 'refs', 'heads', 'main'); // a commit moved the branch tip
		mock.timers.tick(5000);
		assert.deepStrictEqual(repoChanges, []); // nothing may fire while muted

		watcher.unmute(); // schedules past the post-action suppression window (1500ms)
		mock.timers.tick(1499);
		assert.deepStrictEqual(repoChanges, []);
		mock.timers.tick(1);
		assert.deepStrictEqual(repoChanges, [true]); // the commit graph changed
		watcher.stop();
	});

	it('unions the classification of muted and unmuted events of one debounce window', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		fireChange(REPO, '.git', 'index'); // `git commit` writes the index first...
		watcher.unmute(); // the pending muted refresh is scheduled past the suppression window
		fireChange(REPO, '.git', 'refs', 'heads', 'main'); // ...then moves the branch ref (reschedules the same window)
		mock.timers.tick(2000);
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
		mock.timers.tick(1500);
		assert.deepStrictEqual(repoChanges, [true]); // the config can change the commit graph
		watcher.stop();
	});

	it('drops nothing into a stopped watcher: stop() cancels a pending muted refresh', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		fireChange(REPO, '.git', 'refs', 'heads', 'main');
		watcher.stop();
		watcher.unmute();
		mock.timers.tick(5000);
		assert.deepStrictEqual(repoChanges, []);
	});

	it('collapses a burst of muted events into a single refresh', () => {
		const { watcher, repoChanges } = makeWatcher();
		watcher.mute();
		for (let i = 0; i < 5; i++) fireChange(REPO, 'src', 'file' + i + '.ts');
		fireChange(REPO, '.git', 'index');
		watcher.unmute();
		mock.timers.tick(1500);
		assert.deepStrictEqual(repoChanges, [false]); // one callback, working-tree classification
		watcher.stop();
	});
});

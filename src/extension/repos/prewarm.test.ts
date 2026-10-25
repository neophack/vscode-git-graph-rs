import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogOptions, RefReadOptions } from '../git/read/backendIndex';
import {
	PREWARM_HANDLE_IDLE_CLOSE_MS,
	PREWARM_IDLE_DELAY_MS,
	PREWARM_MAX_COMMITS,
	PREWARM_MAX_REPOS,
	PrewarmController,
	createPrewarmController,
	type PrewarmClock,
	type PrewarmReader
} from './prewarm';

/**
 * The controller is fully dependency-injected (no vscode), so these tests run it against vitest's
 * fake timers and a fake reader that records every call: the whole lifecycle — the 2 s idle
 * window, the 3-repository cap, the yield signal, the 10-minute idle close and dispose — is
 * observable from the reader's call log without a Git backend.
 */

type RecordedMethod = 'open' | 'close' | 'repoInfo' | 'commits';

interface RecordedCall {
	readonly method: RecordedMethod;
	readonly repo: string;
}

interface HarnessOptions {
	/** The recently-opened repositories (most recent first) the provider answers with. */
	readonly repos?: readonly string[];
	/** The repository the fake view currently shows (defaults to none). */
	readonly currentRepo?: () => string | null;
	/** The initial answer of the busy signal (defaults to idle). */
	readonly busy?: boolean;
	/** The git-graph-rs.prewarm value (defaults to on). */
	readonly enabled?: boolean;
	/** Repositories whose openRepository rejects. */
	readonly failOpenFor?: readonly string[];
	/** Repositories whose getCommits rejects. */
	readonly failCommitsFor?: readonly string[];
	/** Hook run inside getRepoInfo, before its promise resolves (e.g. to flip the busy signal). */
	readonly onRepoInfo?: (repo: string) => void;
}

function createHarness(options: HarnessOptions = {}) {
	const repos = options.repos ?? ['repo/a', 'repo/b', 'repo/c', 'repo/d'];
	const calls: RecordedCall[] = [];
	const repoInfoOptions: Array<RefReadOptions | undefined> = [];
	const logOptions: LogOptions[] = [];
	const logs: string[] = [];
	const failOpenFor = new Set(options.failOpenFor ?? []);
	const failCommitsFor = new Set(options.failCommitsFor ?? []);
	let busy = options.busy ?? false;

	const reader = {
		openRepository: vi.fn((repo: string) => {
			calls.push({ method: 'open', repo });
			return failOpenFor.has(repo) ? Promise.reject(new Error('cannot open ' + repo)) : Promise.resolve(repo);
		}),
		closeRepository: vi.fn((repo: string) => {
			calls.push({ method: 'close', repo });
		}),
		getRepoInfo: vi.fn((repo: string, readOptions?: RefReadOptions) => {
			calls.push({ method: 'repoInfo', repo });
			repoInfoOptions.push(readOptions);
			options.onRepoInfo?.(repo);
			return Promise.resolve({});
		}),
		getCommits: vi.fn((repo: string, commitOptions: LogOptions) => {
			calls.push({ method: 'commits', repo });
			logOptions.push(commitOptions);
			return failCommitsFor.has(repo) ? Promise.reject(new Error('cannot read ' + repo)) : Promise.resolve({});
		})
	};

	const deps = {
		clock: {
			setTimeout: (handler: () => void, timeoutMs: number) => setTimeout(handler, timeoutMs),
			clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout)
		} satisfies PrewarmClock,
		readerFactory: vi.fn(() => reader as unknown as PrewarmReader),
		recentRepos: vi.fn(() => repos),
		currentRepo: options.currentRepo ?? ((): string | null => null),
		isBusy: (): boolean => busy,
		enabled: options.enabled ?? true,
		log: (message: string) => logs.push(message)
	};

	return {
		controller: createPrewarmController(deps),
		calls,
		repoInfoOptions,
		logOptions,
		logs,
		reader,
		deps,
		setBusy: (value: boolean) => {
			busy = value;
		}
	};
}

/** Advance the fake clock past the idle window and let the resulting promises settle. */
async function runPastIdleWindow() {
	await vi.advanceTimersByTimeAsync(PREWARM_IDLE_DELAY_MS);
}

describe('PrewarmController (fake timers, fake reader)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('is idle until the 2 s window elapses, then opens and prefetches the first candidate', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a'] });

		controller.start();
		await vi.advanceTimersByTimeAsync(PREWARM_IDLE_DELAY_MS - 1);
		expect(calls).toEqual([]);

		await runPastIdleWindow();
		expect(calls).toEqual([
			{ method: 'open', repo: 'repo/a' },
			{ method: 'repoInfo', repo: 'repo/a' },
			{ method: 'commits', repo: 'repo/a' }
		]);
	});

	it('prefetches with the view\u2019s default first-page options, kept minimal', async () => {
		const { controller, repoInfoOptions, logOptions } = createHarness({ repos: ['repo/a'] });

		controller.start();
		await runPastIdleWindow();

		expect(repoInfoOptions[0]).toEqual({ showRemoteBranches: true, showStashes: true });
		expect(logOptions[0]).toEqual({ maxCommits: PREWARM_MAX_COMMITS, showTags: true, showRemoteBranches: true });
		expect(PREWARM_MAX_COMMITS).toBe(300); // the manifest default of repository.commits.initialLoad
	});

	it('serves the recently-opened list in order, one repository at a time (concurrency 1)', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a', 'repo/b'] });

		controller.start();
		await runPastIdleWindow();

		expect(calls).toEqual([
			{ method: 'open', repo: 'repo/a' },
			{ method: 'repoInfo', repo: 'repo/a' },
			{ method: 'commits', repo: 'repo/a' },
			{ method: 'open', repo: 'repo/b' },
			{ method: 'repoInfo', repo: 'repo/b' },
			{ method: 'commits', repo: 'repo/b' }
		]);
	});

	it('prewarms at most ' + PREWARM_MAX_REPOS + ' repositories per cycle (D11)', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a', 'repo/b', 'repo/c', 'repo/d', 'repo/e'] });

		controller.start();
		await runPastIdleWindow();

		const opened = calls.filter((call) => call.method === 'open').map((call) => call.repo);
		expect(opened).toEqual(['repo/a', 'repo/b', 'repo/c']);
	});

	it('skips the repository the view currently shows (it is already hot)', async () => {
		const { controller, calls } = createHarness({
			repos: ['repo/a', 'repo/b', 'repo/c'],
			currentRepo: () => 'repo/b'
		});

		controller.start();
		await runPastIdleWindow();

		const opened = calls.filter((call) => call.method === 'open').map((call) => call.repo);
		expect(opened).toEqual(['repo/a', 'repo/c']);
		expect(calls.filter((call) => call.method === 'open' && call.repo === 'repo/b')).toEqual([]);
	});

	it('yields between repositories: a user action ending one repo stops the cycle', async () => {
		// The busy signal flips the moment the first repository's prefetch completes, so the cycle
		// must end before opening the second repository
		const busy = createHarnessWithBusyAfterFirst();
		busy.controller.start();
		await runPastIdleWindow();

		const opened = busy.calls.filter((call) => call.method === 'open').map((call) => call.repo);
		expect(opened).toEqual(['repo/a']);
		expect(busy.logs.some((line) => line.includes('yielded'))).toBe(true);
	});

	it('yields mid-repository: a user action between the info and the commits read skips the page', async () => {
		const { controller, calls, setBusy } = createHarness({
			repos: ['repo/a'],
			onRepoInfo: () => setBusy(true)
		});

		controller.start();
		await runPastIdleWindow();

		expect(calls).toEqual([
			{ method: 'open', repo: 'repo/a' },
			{ method: 'repoInfo', repo: 'repo/a' }
		]);
		// The opened handle is still scheduled to close after its idle time
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);
		expect(calls.filter((call) => call.method === 'close')).toEqual([{ method: 'close', repo: 'repo/a' }]);
	});

	it('defers the whole cycle when a user action is in flight when the window elapses', async () => {
		const { controller, calls, setBusy } = createHarness({ repos: ['repo/a'], busy: true });

		controller.start();
		await runPastIdleWindow();
		expect(calls).toEqual([]); // still deferring

		setBusy(false);
		await runPastIdleWindow();
		expect(calls[0]).toEqual({ method: 'open', repo: 'repo/a' });
	});

	it('closes a prewarmed handle after 10 minutes idle', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a', 'repo/b'] });

		controller.start();
		await runPastIdleWindow();
		expect(calls.filter((call) => call.method === 'close')).toEqual([]);

		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);
		expect(calls.filter((call) => call.method === 'close')).toEqual([
			{ method: 'close', repo: 'repo/a' },
			{ method: 'close', repo: 'repo/b' }
		]);
	});

	it('keeps the handle the view adopted: a prewarmed repository that became current never auto-closes', async () => {
		let current: string | null = null;
		const { controller, calls } = createHarness({
			repos: ['repo/a'],
			currentRepo: () => current
		});

		controller.start();
		await runPastIdleWindow();
		current = 'repo/a'; // the user opened the prewarmed repository in the view
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);

		expect(calls.filter((call) => call.method === 'close')).toEqual([]);
	});

	it('is a no-op when the git-graph-rs.prewarm setting is off', async () => {
		const { controller, calls, logs } = createHarness({ repos: ['repo/a'], enabled: false });

		controller.start();
		await runPastIdleWindow();
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);

		expect(calls).toEqual([]);
		expect(logs.some((line) => line.includes('disabled'))).toBe(true);
	});

	it('does nothing when there is nothing recent to prewarm', async () => {
		const { controller, calls, logs } = createHarness({ repos: [] });

		controller.start();
		await runPastIdleWindow();

		expect(calls).toEqual([]);
		expect(logs.some((line) => line.includes('no recently-opened'))).toBe(true);
	});

	it('ignores a second start() while a cycle is pending, and skips already-warm repositories on a re-run', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a'] });

		controller.start();
		controller.start(); // duplicate: must not schedule a second cycle
		await runPastIdleWindow();
		expect(calls.filter((call) => call.method === 'open')).toEqual([{ method: 'open', repo: 'repo/a' }]);

		controller.start(); // a fresh cycle after completion: everything is already warm
		await runPastIdleWindow();
		expect(calls.filter((call) => call.method === 'open')).toEqual([{ method: 'open', repo: 'repo/a' }]);
		expect(calls.filter((call) => call.method === 'commits')).toEqual([{ method: 'commits', repo: 'repo/a' }]);
	});

	it('survives a reader that rejects on open: logs it and moves on to the next repository', async () => {
		const { controller, calls } = createHarness({
			repos: ['repo/broken', 'repo/b'],
			failOpenFor: ['repo/broken']
		});

		controller.start();
		await runPastIdleWindow();

		const opened = calls.filter((call) => call.method === 'open').map((call) => call.repo);
		expect(opened).toEqual(['repo/broken', 'repo/b']);
		// The failed repository owns no handle: nothing of it is ever closed, and nothing is prefetched
		expect(calls.filter((call) => call.method === 'repoInfo' && call.repo === 'repo/broken')).toEqual([]);
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);
		expect(calls.filter((call) => call.method === 'close' && call.repo === 'repo/broken')).toEqual([]);
		expect(calls.filter((call) => call.method === 'close' && call.repo === 'repo/b')).toEqual([{ method: 'close', repo: 'repo/b' }]);
	});

	it('survives a reader that rejects on prefetch: logs it and still closes the handle on idle', async () => {
		const { controller, calls, logs } = createHarness({
			repos: ['repo/a'],
			failCommitsFor: ['repo/a']
		});

		controller.start();
		await runPastIdleWindow();

		expect(logs.some((line) => line.includes('prefetch failed'))).toBe(true);
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);
		expect(calls.filter((call) => call.method === 'close')).toEqual([{ method: 'close', repo: 'repo/a' }]);
	});

	it('dispose before the idle window cancels the cycle entirely', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a'] });

		controller.start();
		controller.dispose();
		await runPastIdleWindow();
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);

		expect(calls).toEqual([]);
	});

	it('dispose closes the handles it still owns and cancels the idle-close timers', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a', 'repo/b'] });

		controller.start();
		await runPastIdleWindow();
		controller.dispose();

		expect(calls.filter((call) => call.method === 'close')).toEqual([
			{ method: 'close', repo: 'repo/a' },
			{ method: 'close', repo: 'repo/b' }
		]);

		// The 10-minute timers were cancelled: no double close lands later
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);
		expect(calls.filter((call) => call.method === 'close').length).toBe(2);
	});

	it('dispose leaves a handle the view adopted open', async () => {
		let current: string | null = null;
		const { controller, calls } = createHarness({
			repos: ['repo/a', 'repo/b'],
			currentRepo: () => current
		});

		controller.start();
		await runPastIdleWindow();
		current = 'repo/a';
		controller.dispose();

		expect(calls.filter((call) => call.method === 'close')).toEqual([{ method: 'close', repo: 'repo/b' }]);
	});

	it('dispose during an in-flight open closes that handle instead of prefetching it', async () => {
		let resolveOpen: ((repo: string) => void) | null = null;
		const calls: RecordedCall[] = [];
		const reader = {
			openRepository: vi.fn((repo: string) => new Promise<string>((resolve) => {
				calls.push({ method: 'open', repo });
				resolveOpen = resolve;
			})),
			closeRepository: vi.fn((repo: string) => {
				calls.push({ method: 'close', repo });
			}),
			getRepoInfo: vi.fn(() => Promise.resolve({})),
			getCommits: vi.fn(() => Promise.resolve({}))
		} as unknown as PrewarmReader;
		const controller = new PrewarmController({
			clock: {
				setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
				clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
			},
			readerFactory: () => reader,
			recentRepos: () => ['repo/a'],
			currentRepo: () => null,
			isBusy: () => false,
			enabled: true,
			log: () => undefined
		});

		controller.start();
		await runPastIdleWindow();
		expect(calls).toEqual([{ method: 'open', repo: 'repo/a' }]);

		controller.dispose();
		resolveOpen!('repo/a');
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(PREWARM_HANDLE_IDLE_CLOSE_MS);

		expect(calls).toEqual([
			{ method: 'open', repo: 'repo/a' },
			{ method: 'close', repo: 'repo/a' }
		]);
	});

	it('dispose is idempotent', () => {
		const { controller, calls } = createHarness({ repos: [] });

		controller.dispose();
		expect(() => controller.dispose()).not.toThrow();
		expect(calls).toEqual([]);
	});

	it('start() after dispose is a no-op', async () => {
		const { controller, calls } = createHarness({ repos: ['repo/a'] });

		controller.dispose();
		controller.start();
		await runPastIdleWindow();

		expect(calls).toEqual([]);
	});
});

/**
 * The harness of the yields-between-repositories test: the busy signal flips on the moment the
 * first repository's first page finished, so the cycle must end before opening the second one.
 */
function createHarnessWithBusyAfterFirst() {
	const harness = createHarness({ repos: ['repo/a', 'repo/b', 'repo/c'] });
	harness.reader.getCommits.mockImplementation((repo: string) => {
		harness.calls.push({ method: 'commits', repo });
		if (repo === 'repo/a') harness.setBusy(true);
		return Promise.resolve({});
	});
	return harness;
}

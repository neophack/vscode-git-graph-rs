import { describe, expect, it, vi } from 'vitest';
import type { LastKnownGitRecord } from '../../platform/storage';
import { createGitResolution, type GitExecutableCache } from './gitResolution';
import type { GitExecutable } from './findGit';

/**
 * The deferred Git resolution (OPTIMIZATION-PLAN V1) is tested with an injected `find` (no real
 * `git --version` spawn) and a plain record standing in for the globalState cache: the contract
 * under test is that nothing waits for the spawn — `current()` answers the persisted record
 * immediately — while `ready()` and `onResolved` answer with the validated result, and that an
 * untrusted workspace never resolves (and never spawns) at all.
 */

/** A cache over a plain store, recording writes like the globalState memento does. */
function createCache(initial: LastKnownGitRecord | null = null): GitExecutableCache & { store: Record<string, LastKnownGitRecord>, written: LastKnownGitRecord[] } {
	const written: LastKnownGitRecord[] = [];
	let record: LastKnownGitRecord | null = initial;
	return {
		store: {},
		written,
		getLastKnownGit: () => record,
		setLastKnownGit: (value) => {
			record = value;
			written.push(value);
		}
	};
}

/** A `find` stub whose resolution the test controls. */
function controlledFind() {
	let resolve!: (executable: GitExecutable) => void;
	let reject!: (reason?: unknown) => void;
	const calls: number[] = [];
	const promise = new Promise<GitExecutable>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {
		promise,
		calls,
		find: (_cache: GitExecutableCache) => {
			calls.push(calls.length);
			return promise;
		},
		resolve,
		reject
	};
}

const EXECUTABLE: GitExecutable = { path: '/usr/bin/git', version: '2.43.0' };
const OTHER_EXECUTABLE: GitExecutable = { path: '/opt/git/bin/git', version: '2.45.1' };
/** A path that really exists, so the mtime probe answers (this test file itself). */
const SELF_PATH = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ');

describe('createGitResolution', () => {
	it('answers the persisted record immediately, before any validation has run', () => {
		const find = controlledFind();
		const resolution = createGitResolution({
			cache: createCache({ path: EXECUTABLE.path, version: EXECUTABLE.version, mtimeMs: 1234 }),
			restricted: () => false,
			onResolved: () => { throw new Error('nothing is resolved before start()'); },
			log: () => undefined,
			find: find.find
		});

		expect(resolution.current()).toEqual(EXECUTABLE);
		expect(find.calls.length).toBe(0);
		expect(resolution.restricted()).toBe(false);
	});

	it('current() is NULL without a persisted record until the validation answers', async () => {
		const find = controlledFind();
		const resolved: Array<GitExecutable | null> = [];
		const resolution = createGitResolution({
			cache: createCache(),
			restricted: () => false,
			onResolved: (executable) => resolved.push(executable),
			log: () => undefined,
			find: find.find
		});

		expect(resolution.current()).toBeNull();
		resolution.start();
		expect(resolution.current()).toBeNull(); // still nothing while the spawn is in flight

		find.resolve(EXECUTABLE);
		await resolution.ready();
		expect(resolution.current()).toEqual(EXECUTABLE);
		expect(resolved).toEqual([EXECUTABLE]);
	});

	it('ready() waits for the validation (and a command issued meanwhile observes the result)', async () => {
		const find = controlledFind();
		const resolution = createGitResolution({
			cache: createCache(),
			restricted: () => false,
			onResolved: () => undefined,
			log: () => undefined,
			find: find.find
		});
		resolution.start();

		let observed: GitExecutable | null | undefined;
		void resolution.ready().then(() => { observed = resolution.current(); });
		find.resolve(EXECUTABLE);
		await resolution.ready();
		expect(observed).toEqual(EXECUTABLE);
	});

	it('persists the validated { path, version, mtime } for the next activation', async () => {
		const find = controlledFind();
		const cache = createCache();
		const resolution = createGitResolution({
			cache,
			restricted: () => false,
			onResolved: () => undefined,
			log: () => undefined,
			find: find.find
		});
		resolution.start();
		find.resolve({ path: SELF_PATH, version: EXECUTABLE.version });
		await resolution.ready();

		// The mtime is statted asynchronously; wait for the write to land
		await vi.waitFor(() => {
			expect(cache.written.length).toBe(1);
		});
		expect(cache.written[0].path).toBe(SELF_PATH);
		expect(cache.written[0].version).toBe(EXECUTABLE.version);
		expect(typeof cache.written[0].mtimeMs).toBe('number');
	});

	it('resolves with the cached record without spawning when its mtime is unchanged', async () => {
		const mtime = await statOf(SELF_PATH);
		expect(mtime).not.toBeNull();
		const find = controlledFind();
		const resolved: Array<GitExecutable | null> = [];
		const resolution = createGitResolution({
			cache: createCache({ path: SELF_PATH, version: 'cached', mtimeMs: mtime! }),
			restricted: () => false,
			onResolved: (executable) => resolved.push(executable),
			log: () => undefined,
			find: find.find
		});

		await resolution.ready();
		expect(find.calls.length).toBe(0); // no git --version spawn for an unchanged binary
		expect(resolution.current()).toEqual({ path: SELF_PATH, version: 'cached' });
		expect(resolved).toEqual([{ path: SELF_PATH, version: 'cached' }]);
	});

	it('revalidates through find when the cached binary changed (mtime differs)', async () => {
		const find = controlledFind();
		const resolution = createGitResolution({
			cache: createCache({ path: EXECUTABLE.path, version: 'stale', mtimeMs: 1 }),
			restricted: () => false,
			onResolved: () => undefined,
			log: () => undefined,
			find: find.find
		});
		resolution.start();

		find.resolve(OTHER_EXECUTABLE);
		await resolution.ready();
		expect(resolution.current()).toEqual(OTHER_EXECUTABLE);
	});

	it('resolves NULL and reports it when no usable Git exists', async () => {
		const find = controlledFind();
		const resolved: Array<GitExecutable | null> = [];
		const resolution = createGitResolution({
			cache: createCache(),
			restricted: () => false,
			onResolved: (executable) => resolved.push(executable),
			log: () => undefined,
			find: find.find
		});
		resolution.start();

		find.reject(new Error('none of the paths are a Git executable'));
		await expect(resolution.ready()).resolves.toBeNull();
		expect(resolution.current()).toBeNull();
		expect(resolved).toEqual([null]);
	});

	it('never spawns and always answers NULL while the workspace is untrusted', async () => {
		const find = controlledFind();
		const cache = createCache({ path: EXECUTABLE.path, version: EXECUTABLE.version, mtimeMs: 1234 });
		let restricted = true;
		const logs: string[] = [];
		const resolved: Array<GitExecutable | null> = [];
		const resolution = createGitResolution({
			cache,
			restricted: () => restricted,
			onResolved: (executable) => resolved.push(executable),
			log: (message) => logs.push(message),
			find: find.find
		});

		resolution.start();
		expect(find.calls.length).toBe(0);
		expect(resolution.current()).toBeNull(); // even with a good cache: no Git in Restricted Mode
		await expect(resolution.ready()).resolves.toBeNull();
		expect(resolved).toEqual([]); // nothing resolved while untrusted
		expect(logs.some((line) => line.includes('not trusted'))).toBe(true);

		// Trust granted: the deferred validation now runs and answers
		restricted = false;
		resolution.start();
		find.resolve(EXECUTABLE);
		await resolution.ready();
		expect(resolution.current()).toEqual(EXECUTABLE);
		expect(resolved).toEqual([EXECUTABLE]);
	});
});

/** The mtime of a path, or NULL when it cannot be stated (the same probe the resolution uses). */
async function statOf(path: string): Promise<number | null> {
	try {
		const fs = await import('node:fs');
		return (await fs.promises.stat(path)).mtimeMs;
	} catch (_) {
		return null;
	}
}

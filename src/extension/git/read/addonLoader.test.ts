import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	AddonCallOptions,
	cancel,
	engineDirectories,
	enginePlatformTable,
	hasEngineForPlatform,
	loadAddon,
	NativeAddon,
	platformDirectory,
	platformKey,
	reportedGlibcVersion,
	request,
	resetAddonCache
} from './addonLoader';
import { GitBackendError } from './types';

/**
 * Cancellation paths of the engine adapter: how `requestId` and
 * `cancel()` travel through the single request seam, and how the engine's structured
 * `cancelled` envelope surfaces as a `GitBackendError`. Everything runs against a fake addon
 * injected through the loader option - no `.node` binary is ever loaded, so these tests pass on
 * a machine with or without a built engine.
 */

/** The envelope the engine answers when a request was cancelled. */
const CANCELLED_ENVELOPE = '{"error":{"kind":"cancelled","message":"The operation was cancelled"}}';

/** A fake `native/node` addon: every function is a spy, every answer overridable. */
function fakeAddon(overrides: { request?: (repo: string, requestJson: string, requestId?: number) => Promise<string> } = {}) {
	const addon: NativeAddon = {
		open: vi.fn(async () => '{"ok":"/repo"}'),
		close: vi.fn(),
		closeAll: vi.fn(),
		openCount: vi.fn(() => 1),
		engineVersion: vi.fn(() => '1.0.27-test'),
		request: overrides.request ?? (vi.fn(async () => '{"ok":"1.0.27-test"}') as unknown as NativeAddon['request']),
		cancel: vi.fn()
	};
	const load = (): NativeAddon => addon;
	return { addon, load: load as () => NativeAddon };
}

/** Every call below reaches the addon through the injected loader, never the binary loader. */
const optionsOf = (load: () => NativeAddon, requestId?: number): AddonCallOptions => ({ load, requestId });

describe('cancellation across the adapter seam', () => {
	it('forwards the requestId with the request', async () => {
		const { addon, load } = fakeAddon();
		await request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 7));
		expect(addon.request).toHaveBeenCalledTimes(1);
		expect(addon.request).toHaveBeenCalledWith('/repo', expect.stringContaining('"engineVersion"'), 7);
		expect(addon.cancel).not.toHaveBeenCalled();
	});

	it('omitting the requestId sends exactly the pre-2.9 call', async () => {
		const { addon, load } = fakeAddon();
		await request('/repo', 'engineVersion', {}, undefined, { load });
		expect(addon.request).toHaveBeenCalledWith('/repo', expect.any(String), undefined);
	});

	it('a cancellation before the request starts still cancels it', async () => {
		// The engine remembers a cancellation that races ahead of its request (see cancel.rs);
		// the fake answers the way that registry makes the real engine answer.
		const { addon, load } = fakeAddon({ request: vi.fn(async () => CANCELLED_ENVELOPE) });
		cancel(7, undefined, { load });
		expect(addon.cancel).toHaveBeenCalledWith(7);

		await expect(request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 7))).rejects.toMatchObject({
			name: 'GitBackendError',
			kind: 'Cancelled',
			message: 'The operation was cancelled'
		});
		expect(addon.request).toHaveBeenCalledWith('/repo', expect.any(String), 7);
	});

	it('a cancellation mid-flight rejects the pending request with Cancelled', async () => {
		let answer!: (envelope: string) => void;
		const { addon, load } = fakeAddon({
			request: () => new Promise<string>((resolve) => {
				answer = resolve;
			})
		});
		const pending = request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 8));

		// The request is in flight when the cancellation arrives; the engine answers the
		// structured cancelled envelope at its next checkpoint, which is what we hand back.
		cancel(8, undefined, { load });
		expect(addon.cancel).toHaveBeenCalledWith(8);
		answer(CANCELLED_ENVELOPE);

		const failure = await pending.then(
			() => undefined,
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(GitBackendError);
		expect((failure as GitBackendError).kind).toBe('Cancelled');
		expect((failure as GitBackendError).isFallbackWorthy).toBe(false);
	});

	it('cancelling an unknown id is a no-op for other requests', async () => {
		const { addon, load } = fakeAddon();
		expect(() => cancel(424242, undefined, { load })).not.toThrow();
		expect(addon.cancel).toHaveBeenCalledWith(424242);

		// A request under a different id answers normally, after the stray cancellation.
		await expect(request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 9))).resolves.toBe('1.0.27-test');
		expect(addon.cancel).toHaveBeenCalledTimes(1);
	});
});

/* ---------------------------------------------------------------------------------------------- */
/* Platform selection (R8b): how the editor picks between the gnu, musl and armhf engines.        */
/*                                                                                                */
/* Detection reads the process surface only — no spawn, no filesystem probe before the loader     */
/* runs — so the tests stub `process.platform`/`process.arch`/`process.report` directly and put   */
/* everything back afterwards.                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/** The `process` properties the stubs replaced, captured for restoration. */
const stubbedProcess = new Map<string, PropertyDescriptor | undefined>();

/** The temporary roots the load tests create (cleaned up in `afterEach`). */
const tempRoots: string[] = [];

/** Replace a `process` property for one test; `afterEach` puts the original back. */
function stubProcess(key: 'platform' | 'arch' | 'report', value: unknown): void {
	if (!stubbedProcess.has(key)) {
		stubbedProcess.set(key, Object.getOwnPropertyDescriptor(process, key));
	}
	Object.defineProperty(process, key, { configurable: true, enumerable: true, writable: true, value });
}

/** Stub a linux runtime the way each era of the editor reports its libc. */
function stubLinux(arch: string, report: unknown): void {
	stubProcess('platform', 'linux');
	stubProcess('arch', arch);
	stubProcess('report', report);
}

afterEach(() => {
	for (const [key, descriptor] of stubbedProcess) {
		if (descriptor !== undefined) {
			Object.defineProperty(process, key, descriptor);
		} else {
			delete (process as unknown as Record<string, unknown>)[key];
		}
	}
	stubbedProcess.clear();
	while (tempRoots.length > 0) {
		try {
			fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch {
			/* left for the OS temp cleaner */
		}
	}
	// Tests that drove the real loader must leave its cache clean for the next one.
	resetAddonCache();
});

describe('platform selection across the engine matrix', () => {
	it('a reported glibc version selects the gnu engine, with musl as the fallback', () => {
		stubLinux('x64', { header: { glibcVersion: '2.31' } });
		expect(platformKey()).toBe('linux-x64-gnu');
		expect(platformDirectory()).toBe('linux-x64-gnu');
		expect(engineDirectories()).toEqual(['linux-x64-gnu', 'linux-x64-musl']);
	});

	it('a musl host (a report without a glibc version) selects the musl engine', () => {
		stubLinux('arm64', { header: { hostname: 'alpine' } });
		expect(platformKey()).toBe('linux-arm64-musl');
		expect(platformDirectory()).toBe('linux-arm64-musl');
		expect(engineDirectories()).toEqual(['linux-arm64-musl', 'linux-arm64-gnu']);
	});

	it('a runtime too old for process.report (the 1.38 floor) also prefers the musl engine', () => {
		// Node 10.11 has no `process.report` at all: the libc cannot be named, and the
		// libc-static musl binary is the one engine that loads on either host.
		stubLinux('x64', undefined);
		expect(platformKey()).toBe('linux-x64-musl');
		expect(platformDirectory()).toBe('linux-x64-musl');
		expect(engineDirectories()).toEqual(['linux-x64-musl', 'linux-x64-gnu']);
	});

	it('armv7 has exactly the gnueabihf engine — no musl twin exists to fall back to', () => {
		stubLinux('arm', { header: { glibcVersion: '2.24' } });
		expect(platformKey()).toBe('linux-armhf');
		expect(platformDirectory()).toBe('linux-armhf');
		expect(engineDirectories()).toEqual(['linux-armhf']);
	});

	it('an architecture no engine is built for throws the Unsupported error the fallback knows', () => {
		stubLinux('ppc64le', { header: { glibcVersion: '2.28' } });
		expect(() => platformDirectory()).toThrowError(GitBackendError);
		expect(() => platformDirectory()).toThrowError(/No native engine is built for linux-ppc64le-gnu/);
		// The candidate list itself is well-formed; both directories are simply absent.
		expect(engineDirectories()).toEqual(['linux-ppc64le-gnu', 'linux-ppc64le-musl']);
	});

	it('non-Linux platforms keep their bare keys and their single engine', () => {
		stubProcess('platform', 'win32');
		stubProcess('arch', 'arm64');
		expect(platformKey()).toBe('win32-arm64');
		expect(platformDirectory()).toBe('win32-arm64-msvc');
		expect(engineDirectories()).toEqual(['win32-arm64-msvc']);
		expect(() => platformDirectory('sunos', 'x64')).toThrowError(/No native engine is built for sunos-x64/);
	});

	it('reportedGlibcVersion reads the report header structurally and never lies', () => {
		expect(reportedGlibcVersion(undefined)).toBe(null);
		expect(reportedGlibcVersion(null)).toBe(null);
		expect(reportedGlibcVersion('not a report')).toBe(null);
		expect(reportedGlibcVersion({})).toBe(null);
		expect(reportedGlibcVersion({ header: null })).toBe(null);
		expect(reportedGlibcVersion({ header: { glibcVersion: '' } })).toBe(null);
		expect(reportedGlibcVersion({ header: { glibcVersion: '2.17' } })).toBe('2.17');
	});

	it('the diagnostics table lists every engine the package can carry, both libcs included', () => {
		const table = enginePlatformTable(path.join(os.tmpdir(), 'ggr-engine-table-missing'));
		expect(table.map((row) => row.directory)).toEqual([
			'win32-x64-msvc',
			'win32-arm64-msvc',
			'linux-x64-gnu',
			'linux-x64-musl',
			'linux-arm64-gnu',
			'linux-arm64-musl',
			'linux-armhf',
			'darwin-x64',
			'darwin-arm64'
		]);
		expect(table.every((row) => row.present === false)).toBe(true);
		const armhf = table.find((row) => row.key === 'linux-armhf');
		expect(armhf?.arch).toBe('ARMv7');
	});

	it('a package carrying only the fallback libc still has an engine for this platform', () => {
		// A glibc host whose VSIX carries the musl binary only: the fallback candidate is what
		// makes this an engine platform rather than a CLI-only one.
		stubLinux('x64', { header: { glibcVersion: '2.31' } });
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-addon-'));
		tempRoots.push(root);
		fs.mkdirSync(path.join(root, 'native', 'linux-x64-musl'), { recursive: true });
		fs.writeFileSync(path.join(root, 'native', 'linux-x64-musl', 'git-graph.node'), 'not a binary');
		expect(hasEngineForPlatform(root)).toBe(true);
	});

	it('a broken primary engine falls through to the next candidate, and the failure names the primary', () => {
		stubLinux('x64', { header: { glibcVersion: '2.31' } });
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-addon-'));
		tempRoots.push(root);
		// Both shipped candidates exist, and neither is a loadable binary: require() fails on
		// both, the local cargo builds are absent, and the search reports the FIRST failure —
		// the primary engine's — rather than the fallback's.
		for (const directory of ['linux-x64-gnu', 'linux-x64-musl']) {
			fs.mkdirSync(path.join(root, 'native', directory), { recursive: true });
			fs.writeFileSync(path.join(root, 'native', directory, 'git-graph.node'), 'not a binary');
		}

		let failure: unknown;
		try {
			loadAddon(root);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(GitBackendError);
		expect((failure as GitBackendError).message).toContain(path.join('native', 'linux-x64-gnu'));

		// The failed search is remembered: a retry neither re-probes nor flips candidates.
		let retried: unknown;
		try {
			loadAddon(root);
		} catch (error) {
			retried = error;
		}
		expect(retried).toBe(failure);
	});
});

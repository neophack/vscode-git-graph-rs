import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancel, request } from './addonLoader';
import { NativeBackend, startCancellableRequest } from './gitReader';
import { GitBackendError } from './types';

/**
 * The cancellation-capable call shape (task 2.9) that the host scheduler of task 4.8 consumes:
 * `startCancellableRequest` must wire its id through the same typed request seam, and its
 * `cancel()` must reach the addon's `cancel` under that id. Alongside it, the request shapes of
 * the read methods added for DataSource parity (tasks 3.5) — every one a thin mapping onto the
 * generated protocol, or a documented decline. The addon module is mocked - these tests pin the
 * wiring, not the engine.
 */

vi.mock('./addonLoader', () => ({
	request: vi.fn(async () => 'ok-value'),
	cancel: vi.fn(),
	loadAddon: vi.fn(() => ({
		open: async () => '',
		close: () => undefined,
		closeAll: () => undefined,
		openCount: () => 0,
		engineVersion: () => '0.0.0',
		request: async () => '{"ok":null}',
		requestBytes: async () => ({ ok: null, error: null }),
		cancel: () => undefined
	}))
}));

const requestMock = vi.mocked(request);
const cancelMock = vi.mocked(cancel);

/** A minimal structural `AbortLike` the tests control by hand. */
function abortLike() {
	const listeners: (() => void)[] = [];
	const signal = {
		aborted: false,
		addEventListener: (_type: 'abort', listener: () => void) => listeners.push(listener),
		removeEventListener: (_type: 'abort', listener: () => void) => {
			const index = listeners.indexOf(listener);
			if (index >= 0) listeners.splice(index, 1);
		},
		abort: () => {
			signal.aborted = true;
			listeners.forEach((listener) => listener());
		}
	};
	return signal;
}

describe('startCancellableRequest', () => {
	it('issues the request under its id and cancels through the same id', async () => {
		const call = startCancellableRequest('/repo', 'engineVersion', {}, 42);

		await expect(call.promise).resolves.toBe('ok-value');
		expect(requestMock).toHaveBeenCalledWith('/repo', 'engineVersion', {}, undefined, { requestId: 42 });
		expect(cancelMock).not.toHaveBeenCalled();

		call.cancel();
		expect(cancelMock).toHaveBeenCalledWith(42, undefined);
	});

	it('mints a fresh id per call when none is given', async () => {
		const first = startCancellableRequest('/repo', 'engineVersion', {});
		const second = startCancellableRequest('/repo', 'engineVersion', {});

		const firstId = requestMock.mock.calls[0][4]?.requestId;
		const secondId = requestMock.mock.calls[1][4]?.requestId;
		expect(typeof firstId).toBe('number');
		expect(secondId).not.toBe(firstId);

		first.cancel();
		second.cancel();
		expect(cancelMock).toHaveBeenCalledWith(firstId, undefined);
		expect(cancelMock).toHaveBeenCalledWith(secondId, undefined);
		await Promise.all([first.promise, second.promise]);
	});
});

describe('NativeBackend read shapes added for DataSource parity', () => {
	beforeEach(() => {
		requestMock.mockClear();
		cancelMock.mockClear();
	});

	it('getRepoChangeSignature composes the ref snapshot and the stashes into one JSON signature', async () => {
		requestMock.mockResolvedValueOnce({ head: 'h', heads: [{ hash: 'h', name: 'main' }], tags: [], remotes: [] });
		requestMock.mockResolvedValueOnce([]);
		const backend = new NativeBackend();
		await expect(backend.getRepoChangeSignature('/repo')).resolves.toBe(JSON.stringify(['h', [{ hash: 'h', name: 'main' }], [], [], []]));
		expect(requestMock).toHaveBeenNthCalledWith(1, '/repo', 'loadRefs', {
			showRemoteBranches: true, showRemoteHeads: false, hideRemotes: [], showChangeRefs: false, showStashes: true
		});
		expect(requestMock).toHaveBeenNthCalledWith(2, '/repo', 'stashes', {});
	});

	it('getRepoChangeSignature answers null when a read fails (never rejects)', async () => {
		requestMock.mockRejectedValueOnce(new Error('boom'));
		const backend = new NativeBackend();
		await expect(backend.getRepoChangeSignature('/repo')).resolves.toBe(null);
	});

	it('getRepoChangeSignature lets a decline escape, so the fallback reader can serve it', async () => {
		requestMock.mockRejectedValueOnce(new GitBackendError('Unsupported', 'declined'));
		const backend = new NativeBackend();
		await expect(backend.getRepoChangeSignature('/repo')).rejects.toMatchObject({ kind: 'Unsupported', isFallbackWorthy: true });
	});

	it('getGlobalUserDetails reads the global config list and picks the identity', async () => {
		requestMock.mockResolvedValueOnce({ 'user.name': 'Alice', 'user.email': 'alice@example.com' });
		const backend = new NativeBackend();
		await expect(backend.getGlobalUserDetails('/repo')).resolves.toEqual({ name: 'Alice', email: 'alice@example.com' });
		expect(requestMock).toHaveBeenLastCalledWith('/repo', 'configList', { local: false });
	});

	it('compareFileDiff answers the single-commit case through fileDiff and declines the rest', async () => {
		const backend = new NativeBackend();
		await backend.compareFileDiff('/repo', 'abcd1234^', 'abcd1234', 'f.txt', 'f.txt');
		expect(requestMock).toHaveBeenLastCalledWith('/repo', 'fileDiff', { revision: 'abcd1234', path: 'f.txt' });

		await expect(backend.compareFileDiff('/repo', 'abcd1234', 'ef56789a', 'f.txt', 'f.txt'))
			.rejects.toMatchObject({ name: 'GitBackendError', kind: 'Unsupported', isFallbackWorthy: true });
		await expect(backend.compareFileDiff('/repo', 'abcd1234^', 'abcd1234', 'old.txt', 'f.txt'))
			.rejects.toMatchObject({ name: 'GitBackendError', kind: 'Unsupported' });
	});

	it('declines the reads the engine has no method for, so the fallback serves them', async () => {
		const backend = new NativeBackend();
		await expect(backend.getReflog('/repo', 'HEAD', 5)).rejects.toMatchObject({ name: 'GitBackendError', kind: 'Unsupported', isFallbackWorthy: true });
		await expect(backend.getWorktrees('/repo')).rejects.toMatchObject({ name: 'GitBackendError', kind: 'Unsupported', isFallbackWorthy: true });
		await expect(backend.predictConflicts('/repo', 'a', 'b')).rejects.toMatchObject({ name: 'GitBackendError', kind: 'Unsupported', isFallbackWorthy: true });
	});

	it('maps the Gerrit reads onto their protocol methods', async () => {
		const backend = new NativeBackend();
		await backend.parseGerritMetas('/repo', 'origin', [1, 2], null);
		expect(requestMock).toHaveBeenLastCalledWith('/repo', 'parseGerritMetas', { remote: 'origin', changes: [1, 2], urlBase: null });

		await backend.listChangeRefs('/repo', 'origin');
		expect(requestMock).toHaveBeenLastCalledWith('/repo', 'listChangeRefs', { remote: 'origin' });
	});
});

describe('NativeBackend.getCommits cancellation', () => {
	it('registers the walk under an id and cancels it when the signal aborts', async () => {
		cancelMock.mockClear();
		requestMock.mockClear();
		const signal = abortLike();
		const backend = new NativeBackend();
		const pending = backend.getCommits('/repo', { maxCommits: 5 }, signal);
		const requestId = requestMock.mock.calls[requestMock.mock.calls.length - 1][4]?.requestId;
		expect(typeof requestId).toBe('number');

		expect(cancelMock).not.toHaveBeenCalled();
		signal.abort();
		expect(cancelMock).toHaveBeenCalledWith(requestId);

		await expect(pending).resolves.toBe('ok-value');
		// The listener is dropped once the request settles: a later abort cancels nothing.
		signal.abort();
		expect(cancelMock).toHaveBeenCalledTimes(1);
	});

	it('does not register an id when no signal is given', async () => {
		cancelMock.mockClear();
		requestMock.mockClear();
		const backend = new NativeBackend();
		await backend.getCommits('/repo', { maxCommits: 5 });
		expect(requestMock.mock.calls[requestMock.mock.calls.length - 1][4]).toBeUndefined();
	});
});

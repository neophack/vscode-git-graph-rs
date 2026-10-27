import { describe, expect, it, vi } from 'vitest';

/**
 * The Restricted Mode branch of `createBackend`: with `engineOnly`, no
 * `git` child process may be reachable through the backend. On a machine with the engine binary
 * that is the engine alone (covered by the contract suites wherever the addon loads); without
 * one it is the `unavailable` backend — construction succeeds, every read fails with the
 * fallback-unworthy `Unsupported` error, and the release calls are safe no-ops. The addon is
 * forced unavailable here so the branch is deterministic on every machine.
 */
vi.mock('./addonLoader', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./addonLoader')>();
	return {
		...actual,
		isAddonAvailable: () => false
	};
});

import { createBackend, describeBackend } from './backendIndex';
import { GitBackendError } from './types';

describe('createBackend in Restricted Mode (engineOnly)', () => {
	it('builds the unavailable backend when there is no engine binary, and never a CLI one', () => {
		const backend = createBackend({ gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe', engineOnly: true });
		expect(backend.name).toBe('unavailable');
		// A git path was handed in and must be ignored: no `git` process may run untrusted.
		expect(describeBackend({ gitPath: 'git', engineOnly: true })).toBe('unavailable (no engine; restricted workspace)');
	});

	it('fails every read with the Unsupported GitBackendError, whatever its arguments', async () => {
		const backend = createBackend({ gitPath: null, engineOnly: true });
		await expect(backend.openRepository('/some/repo')).rejects.toMatchObject({
			name: 'GitBackendError',
			kind: 'Unsupported'
		});
		await expect(backend.getRepoInfo('/some/repo', { showRemoteBranches: true })).rejects.toBeInstanceOf(GitBackendError);
		await expect(backend.getCommits('/some/repo', { maxCommits: 100 })).rejects.toMatchObject({ kind: 'Unsupported' });
	});

	it('answers the release calls as no-ops (nothing was ever opened)', () => {
		const backend = createBackend({ gitPath: null, engineOnly: true });
		expect(() => {
			backend.closeRepository('/some/repo');
			backend.closeAllRepositories();
		}).not.toThrow();
	});
});

/**
 * The two adapters' shared contract (task 3.5.3/3.5.4): equivalent failures reject with the same
 * `GitBackendError` shape on both sides, `createBackend`'s fallback actually engages for the read
 * methods added for DataSource parity, and the CLI adapter honours cancellation on the long log
 * walk. The native side runs against a mocked addon (the engine has its own suite); the CLI side
 * runs real `git` against a temporary repository.
 */

import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { request } from './addonLoader';
import { createBackend } from './backendIndex';
import { NativeBackend } from './gitReader';
import { CliBackend } from './cli';
import { GitBackendError } from './types';
import { GitReaderLike } from '../gitRepository';
import type { GitSpawnFn } from '../process/gitProcess';

vi.mock('./addonLoader', () => ({
	request: vi.fn(),
	cancel: vi.fn(),
	loadAddon: vi.fn(() => ({
		open: async () => '',
		close: () => undefined,
		closeAll: () => undefined,
		openCount: () => 0,
		engineVersion: () => '0.0.0-mock',
		request: async () => {
			throw new Error('the mock engine answers through the request mock');
		},
		requestBytes: async () => ({ ok: null, error: null }),
		cancel: () => undefined
	})),
	isAddonAvailable: vi.fn(() => true),
	platformKey: vi.fn(() => 'test-platform'),
	resetAddonCache: vi.fn()
}));

const requestMock = vi.mocked(request);

const tempDirs: string[] = [];

afterEach(async () => {
	// A cancelled load rejects as soon as its log walk stops, while the ref-scan git.exe
	// processes it raced may still hold their cwd for a few milliseconds: give them a moment,
	// retry the delete (Windows holds .git files briefly), and never fail the suite on litter.
	await new Promise((resolve) => setTimeout(resolve, 100));
	while (tempDirs.length > 0) {
		try {
			fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (_) {
			/* left for the OS temp cleaner */
		}
	}
});

/** A real two-commit repository, the fixture every CLI answer below is read from. */
function makeRepo(): { repo: string; hash: string } {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-contract-'));
	tempDirs.push(repo);
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repo };
	const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
	git(['init', '--quiet', '--initial-branch=main']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'user.email', 'test@example.com']);
	fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
	git(['add', 'a.txt']);
	git(['commit', '--quiet', '-m', 'first']);
	fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
	git(['add', 'a.txt']);
	git(['commit', '--quiet', '-m', 'second']);
	return { repo, hash: git(['rev-parse', 'HEAD']).trim() };
}

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

describe('the error contract of the two adapters', () => {
	beforeEach(() => {
		requestMock.mockReset();
		// The seam's contract: request() rejects with a GitBackendError built from the engine's
		// structured error (the conversion itself has addonLoader's own tests). The persistent
		// default declines everything as Unsupported — fallback-worthy.
		requestMock.mockRejectedValue(new GitBackendError('Unsupported', 'the mock engine does not implement this'));
	});

	const failures = [
		{
			name: 'missing repository',
			cliKind: 'Git',
			nativeError: new GitBackendError('NotARepository', 'not a git repository'),
			nativeKind: 'NotARepository',
			nativeFallbackWorthy: true
		},
		{
			name: 'unknown revision',
			cliKind: 'Git',
			nativeError: new GitBackendError('NotFound', 'unknown revision'),
			nativeKind: 'NotFound',
			nativeFallbackWorthy: false
		}
	] as const;

	for (const failure of failures) {
		it(`rejects the same GitBackendError shape for a ${failure.name}`, async () => {
			const { repo, hash } = makeRepo();
			const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-notrepo-'));
			tempDirs.push(notARepo);
			const cli = new CliBackend('git');
			const native = new NativeBackend();

			const cliFailure = failure.name === 'missing repository'
				? cli.repoRoot(notARepo)
				: cli.getCommitSubject(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
			const cliError = await cliFailure.then(
				() => null,
				(error) => error
			);
			expect(cliError).toBeInstanceOf(GitBackendError);
			expect((cliError as GitBackendError).kind).toBe(failure.cliKind);
			expect((cliError as GitBackendError).message).not.toBe('');
			expect((cliError as GitBackendError).isFallbackWorthy).toBe(false);

			requestMock.mockRejectedValueOnce(failure.nativeError);
			const nativeFailure = failure.name === 'missing repository' ? native.repoRoot(notARepo) : native.getCommitSubject(repo, hash);
			const nativeErrorValue = await nativeFailure.then(
				() => null,
				(error) => error
			);
			expect(nativeErrorValue).toBeInstanceOf(GitBackendError);
			expect((nativeErrorValue as GitBackendError).kind).toBe(failure.nativeKind);
			expect((nativeErrorValue as GitBackendError).message).not.toBe('');
			expect((nativeErrorValue as GitBackendError).isFallbackWorthy).toBe(failure.nativeFallbackWorthy);
		});
	}
});

describe('createBackend serves the parity reads through the fallback', () => {
	beforeEach(() => {
		requestMock.mockReset();
		requestMock.mockRejectedValue(new GitBackendError('Unsupported', 'the mock engine does not implement this'));
	});

	it('every read added for parity is answered by the git CLI when the engine declines', async () => {
		const { repo, hash } = makeRepo();
		const fallenBack: string[] = [];
		const backend = createBackend({
			gitPath: 'git',
			onFallback: (method) => fallenBack.push(method)
		});

		const reflog = await backend.getReflog(repo, 'HEAD', 5);
		expect(reflog.entries.length).toBe(2);
		expect(reflog.entries[0].message).toBe('commit: second');
		expect(reflog.moreAvailable).toBe(false);

		const worktrees = await backend.getWorktrees(repo);
		expect(worktrees.length).toBe(1);
		expect(worktrees[0].isMain).toBe(true);
		expect(worktrees[0].branch).toBe('main');

		await expect(backend.predictConflicts(repo, hash, hash)).resolves.toEqual({ conflicted: false, files: [] });

		// The single-commit case (the engine's fileDiff shape) and the general two-revision case
		// both land on the CLI diff when the mock engine declines.
		expect(await backend.compareFileDiff(repo, hash + '^', hash, 'a.txt', 'a.txt')).toContain('diff --git');
		expect(await backend.compareFileDiff(repo, hash + '~1', hash, 'a.txt', 'a.txt')).toContain('diff --git');

		expect(typeof (await backend.getRepoChangeSignature(repo))).toBe('string');
		expect(await backend.listChangeRefs(repo, 'origin')).toEqual([]);

		// Every answer above arrived through a decline of the engine (the mock declines everything).
		expect(fallenBack.length).toBeGreaterThanOrEqual(6);
		expect(fallenBack).toContain('getReflog');
	});

	it("GitBackend satisfies the facade's structural read floor", async () => {
		const { repo } = makeRepo();
		const backend = createBackend({ gitPath: 'git' });
		const reader: GitReaderLike = backend;
		await expect(reader.getRemotes(repo)).resolves.toEqual([]);
	});
});

describe('the CLI adapter honours cancellation on the log walk', () => {
	/** A spawn whose child hangs forever until killed, recording the kill. */
	function hangingSpawn(): { spawn: GitSpawnFn; killed: () => boolean } {
		let killed = false;
		const spawn: GitSpawnFn = () => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				stdin: { end: () => undefined },
				kill: () => {
					killed = true;
				}
			});
			return child as unknown as ReturnType<GitSpawnFn>;
		};
		return { spawn, killed: () => killed };
	}

	beforeEach(() => {
		requestMock.mockReset();
		requestMock.mockRejectedValue(new GitBackendError('Unsupported', 'the mock engine does not implement this'));
	});

	it('rejects before spawning when the signal is already aborted', async () => {
		const { repo } = makeRepo();
		const signal = abortLike();
		signal.abort();

		const backend = new CliBackend('git');
		await expect(backend.getCommits(repo, { maxCommits: 10 }, signal)).rejects.toMatchObject({
			name: 'GitBackendError',
			kind: 'Cancelled'
		});
	});

	it('kills the in-flight walk and rejects with kind Cancelled when aborted mid-run', async () => {
		const { repo } = makeRepo();
		const { spawn, killed } = hangingSpawn();

		const backend = new CliBackend('git', undefined, spawn);
		const signal = abortLike();
		const pending = backend.getCommits(repo, { maxCommits: 10 }, signal);
		await new Promise((resolve) => setTimeout(resolve, 50));
		signal.abort();

		await expect(pending).rejects.toMatchObject({ name: 'GitBackendError', kind: 'Cancelled' });
		expect(killed()).toBe(true);
	});
});

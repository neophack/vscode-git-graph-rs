/**
 * Tests for the GitWriter: the gates in order (refusal, argument safety, executable, Git
 * version), the multi-step execution semantics (stop at first failure, tolerance, best effort),
 * the error mapping, and the repository-changed event. The GitProcess runs over an
 * injected spawn scripted per argv.
 */

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { GitProcess, GitSpawnFn, SpawnedGit } from '../process/gitProcess';
import { GitWriter, commandFailure } from './gitWriter';
import { WriteOp } from './ops/op';

const GIT = { path: 'git', version: '2.40.0' };
const OLD_GIT = { path: 'git', version: '2.10.0' };

const t = (key: string, ...params: Array<string | number>) => key + '{' + params.join(',') + '}';

/** A fake child answering one script; each spawn records its argv. */
function spawnOf(script: { [argv: string]: { code?: number; stdout?: string; stderr?: string } }): {
	spawn: GitSpawnFn;
	calls: string[][];
} {
	const calls: string[][] = [];
	const spawn: GitSpawnFn = (_command, args) => {
		const argv = [...args];
		calls.push(argv);
		const answer = script[argv.join(' ')] || { code: 0 };
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			stdin: { end: () => undefined }
		});
		Promise.resolve().then(() => {
			(child.stdout as EventEmitter).emit('data', Buffer.from(answer.stdout || ''));
			(child.stderr as EventEmitter).emit('data', Buffer.from(answer.stderr || ''));
			child.emit('close', answer.code === undefined ? 0 : answer.code);
		});
		return child as unknown as SpawnedGit;
	};
	return { spawn, calls };
}

function writerOf(script: Parameters<typeof spawnOf>[0], git: { readonly path: string; readonly version: string } | null = GIT): GitWriter {
	const { spawn } = spawnOf(script);
	return new GitWriter(new GitProcess(() => git, spawn), () => ({ signCommits: false, signTags: false }), t);
}

const SIMPLE: WriteOp = { steps: [{ argv: ['clean', '-fd'] }], effects: ['worktree'] };

describe('GitWriter.run gates', () => {
	it('runs the op steps and answers null on success', async () => {
		const { spawn, calls } = spawnOf({});
		const writer = new GitWriter(new GitProcess(() => GIT, spawn), () => ({ signCommits: true, signTags: false }), t);
		await expect(writer.run('/repo', SIMPLE)).resolves.toBeNull();
		expect(calls).toEqual([['clean', '-fd']]);
	});

	it('refusals: an i18n key is localised, a literal message passes through', async () => {
		const writer = writerOf({});
		await expect(writer.run('/repo', { steps: [], effects: [], refusal: 'pruneTagsRequiresPrune' }))
			.resolves.toBe('pruneTagsRequiresPrune{}');
		await expect(writer.run('/repo', { steps: [], effects: [], refusal: 'No remote(s) were specified.' }))
			.resolves.toBe('No remote(s) were specified.');
	});

	it('rejects unsafe arguments before anything spawns, with the localised message', async () => {
		const { spawn, calls } = spawnOf({});
		const writer = new GitWriter(new GitProcess(() => GIT, spawn), () => ({ signCommits: false, signTags: false }), t);
		const op: WriteOp = { steps: [{ argv: ['checkout', 'b'] }], effects: [], checks: [['branchName', '-oevil', 'ref']] };
		await expect(writer.run('/repo', op)).resolves.toBe('invalidRefName{branchName}');
		expect(calls).toEqual([]);
	});

	it('answers the unable-to-find-Git message when no executable exists', async () => {
		const writer = writerOf({}, null);
		await expect(writer.run('/repo', SIMPLE)).resolves.toBe('unableToFindGit{}');
	});

	it('answers the incompatible-version message when the Git is too old for the capability', async () => {
		const op: WriteOp = { steps: [{ argv: ['stash', 'push'] }], effects: ['stash'], requires: 'PushStash' };
		await expect(writerOf({}, OLD_GIT).run('/repo', op))
			.resolves.toBe('incompatibleGitVersion{2.13.2,thisFeature{},2.10.0}');
		// A capability with a feature name uses it in the message.
		const fetchOp: WriteOp = { steps: [{ argv: ['fetch'] }], effects: [], requires: 'FetchAndPruneTags' };
		await expect(writerOf({}, OLD_GIT).run('/repo', fetchOp))
			.resolves.toBe('incompatibleGitVersion{2.17.0,featurePruningTagsWhenFetching{},2.10.0}');
		// A new enough Git runs the op.
		await expect(writerOf({ 'stash push': {} }).run('/repo', op)).resolves.toBeNull();
	});
});

describe('GitWriter.run step semantics', () => {
	it('runs the steps in order and stops at the first failure', async () => {
		const { spawn, calls } = spawnOf({
			'remote add o u': { code: 0 },
			'remote set-url o --push p': { code: 1, stderr: 'fatal: bad url\n' }
		});
		const writer = new GitWriter(new GitProcess(() => GIT, spawn), () => ({ signCommits: false, signTags: false }), t);
		const op: WriteOp = {
			steps: [
				{ argv: ['remote', 'add', 'o', 'u'] },
				{ argv: ['remote', 'set-url', 'o', '--push', 'p'] },
				{ argv: ['fetch', 'o'] }
			],
			effects: ['config']
		};
		await expect(writer.run('/repo', op)).resolves.toBe('fatal: bad url');
		expect(calls.map((argv) => argv.join(' '))).toEqual(['remote add o u', 'remote set-url o --push p']);
	});

	it('a step whose tolerance matches the failure output continues the sequence', async () => {
		const { spawn, calls } = spawnOf({
			'push origin --delete v2': { code: 1, stderr: 'error: remote ref does not exist\n' },
			'tag -d v2': { code: 0, stdout: 'Deleted tag v2\n' }
		});
		const writer = new GitWriter(new GitProcess(() => GIT, spawn), () => ({ signCommits: false, signTags: false }), t);
		const op: WriteOp = {
			steps: [
				{ argv: ['push', 'origin', '--delete', 'v2'], tolerance: 'remote ref does not exist' },
				{ argv: ['tag', '-d', 'v2'] }
			],
			effects: ['refs']
		};
		await expect(writer.run('/repo', op)).resolves.toBeNull();
		expect(calls.map((argv) => argv.join(' '))).toEqual(['push origin --delete v2', 'tag -d v2']);
	});

	it('a tolerance that does not match still fails the operation', async () => {
		const op: WriteOp = {
			steps: [
				{ argv: ['push', 'origin', '--delete', 'v2'], tolerance: 'remote ref does not exist' },
				{ argv: ['tag', '-d', 'v2'] }
			],
			effects: ['refs']
		};
		await expect(writerOf({ 'push origin --delete v2': { code: 128, stderr: 'fatal: authentication failed\n' } }).run('/repo', op))
			.resolves.toBe('fatal: authentication failed');
	});

	it('a best-effort step failure is ignored', async () => {
		const op: WriteOp = {
			steps: [
				{ argv: ['tag', '-d', 'v2'] },
				{ argv: ['update-ref', '-d', 'refs/remotes/x/tags/v2'], bestEffort: true }
			],
			effects: ['refs']
		};
		await expect(writerOf({
			'tag -d v2': { code: 0, stdout: 'Deleted tag v2\n' },
			'update-ref -d refs/remotes/x/tags/v2': { code: 128, stderr: 'fatal: bad ref\n' }
		}).run('/repo', op)).resolves.toBeNull();
	});
});

describe('GitWriter error mapping', () => {
	it('maps a failed command to the legacy message: stderr then stdout, last line dropped', async () => {
		const op: WriteOp = { steps: [{ argv: ['merge', 'x'] }], effects: [] };
		await expect(writerOf({ 'merge x': { code: 1, stderr: 'Auto-merging f\nCONFLICT (content): f\n', stdout: '' } }).run('/repo', op))
			.resolves.toBe('Auto-merging f\nCONFLICT (content): f');
	});

	it('commandFailure reproduces getErrorMessage exactly', () => {
		expect(commandFailure({ code: 1, stdout: Buffer.from('out line\n'), stderr: 'err line\n' })).toBe('err line\nout line');
		expect(commandFailure({ code: 1, stdout: Buffer.alloc(0), stderr: '' })).toBe('');
		// No trailing newline: the final pop() still drops the last line (kept for parity).
		expect(commandFailure({ code: 1, stdout: Buffer.alloc(0), stderr: 'one line only' })).toBe('');
	});
});

describe('GitWriter repository-changed event', () => {
	it('fires after a successful run with the op effects', async () => {
		const writer = writerOf({});
		const listener = vi.fn();
		writer.onRepositoryChanged(listener);
		await writer.run('/repo', SIMPLE);
		expect(listener).toHaveBeenCalledWith('/repo', ['worktree']);
	});

	it('fires after a failed run too (a failed merge still changes things)', async () => {
		const writer = writerOf({ 'clean -fd': { code: 1, stderr: 'fatal: x\n' } });
		const listener = vi.fn();
		writer.onRepositoryChanged(listener);
		await writer.run('/repo', SIMPLE);
		expect(listener).toHaveBeenCalled();
	});

	it('does not fire when a gate stopped the operation before any command', async () => {
		const writer = writerOf({}, null);
		const listener = vi.fn();
		writer.onRepositoryChanged(listener);
		await writer.run('/repo', SIMPLE);
		expect(listener).not.toHaveBeenCalled();
	});

	it('a disposed listener is no longer called', async () => {
		const writer = writerOf({});
		const listener = vi.fn();
		const subscription = writer.onRepositoryChanged(listener);
		subscription.dispose();
		await writer.run('/repo', SIMPLE);
		expect(listener).not.toHaveBeenCalled();
	});
});

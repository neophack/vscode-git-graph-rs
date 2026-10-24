/**
 * Tests for the GitRepository facade skeleton: the operation-state plumbing over the injected
 * text runner and the real filesystem, against a temporary state directory.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitOperationType } from '../../types/git';
import { GitProcess, GitSpawnFn, SpawnedGit } from './process/gitProcess';
import { GitWriter } from './write/gitWriter';
import { GitReaderLike, GitRepository } from './gitRepository';

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
	}
});

/** A spawn that always succeeds with no output (the facade's writes are not under test here). */
const quietSpawn: GitSpawnFn = () => {
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		stdin: { end: () => undefined }
	});
	Promise.resolve().then(() => child.emit('close', 0));
	return child as unknown as SpawnedGit;
};

function repositoryOf(runText: (argv: ReadonlyArray<string>, repo: string) => Promise<string>): GitRepository {
	const reader: GitReaderLike = {
		openRepository: () => Promise.resolve(),
		closeRepository: () => undefined,
		getRemotes: () => Promise.resolve(['origin']),
		currentBranchName: () => Promise.resolve('main')
	};
	const writer = new GitWriter(new GitProcess(() => ({ path: 'git', version: '2.40.0' }), quietSpawn), () => ({ signCommits: false, signTags: false }), (key) => key);
	return new GitRepository(reader, writer, runText);
}

describe('GitRepository', () => {
	it('exposes its reader and writer faces', () => {
		const repo = repositoryOf(() => Promise.resolve(''));
		expect(repo.read.getRemotes('/r')).resolves.toEqual(['origin']);
		expect(repo.write).toBeInstanceOf(GitWriter);
	});

	it('getOperationState reads the state files of the reported Git directory', async () => {
		const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-facade-'));
		tempDirs.push(gitDir);
		fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
		fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'msgnum'), '2');
		fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'end'), '5');

		const repo = repositoryOf((argv) => {
			if (argv.join(' ') === 'rev-parse --git-dir') return Promise.resolve(gitDir);
			if (argv.join(' ') === 'diff --name-only --diff-filter=U') return Promise.resolve('conflicted.ts\n');
			return Promise.reject(new Error('unexpected argv'));
		});
		await expect(repo.getOperationState('/repo')).resolves.toEqual({
			type: GitOperationType.Rebase,
			conflictedFiles: ['conflicted.ts'],
			progress: { step: 2, total: 5 }
		});
	});

	it('getOperationState resolves to "none" when the Git probe fails (never rejects)', async () => {
		const repo = repositoryOf(() => Promise.reject(new Error('not a repository')));
		await expect(repo.getOperationState('/repo')).resolves.toEqual({ type: null, conflictedFiles: [], progress: null });
	});
});

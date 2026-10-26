/**
 * Tests for the operation-state detection: the state-file precedence, the rebase step counter,
 * the conflict listing, and the never-reject contract — over an injected environment.
 */

import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { GitOperationType } from '../../shared/model/git';
import { conflictedFilesArgv, detectOperationState, gitDirArgv, OperationStateEnv, readRebaseProgress, resolveGitDir } from './operationState';

const NONE = { type: null, conflictedFiles: [], progress: null };

/** An env answering for one set of existing paths, integer files, and Git reads. */
function envOf(existing: ReadonlyArray<string>, ints: { [file: string]: number }, reads: { [argv: string]: string | Error }): OperationStateEnv {
	return {
		exists: (file) => Promise.resolve(existing.includes(file)),
		readIntFile: (file) => Promise.resolve(file in ints ? ints[file] : null),
		runText: (argv) => {
			const answer = reads[argv.join(' ')];
			if (answer === undefined) return Promise.reject(new Error('unexpected argv: ' + argv.join(' ')));
			return typeof answer === 'string' ? Promise.resolve(answer) : Promise.reject(answer);
		}
	};
}

describe('resolveGitDir', () => {
	it('keeps an absolute path, joins a relative one onto the repository', () => {
		expect(resolveGitDir('/repo', 'C:\\data\\.git')).toBe('C:\\data\\.git');
		expect(resolveGitDir('/repo', '.git')).toBe(path.join('/repo', '.git'));
	});
});

describe('detectOperationState', () => {
	it('no state files: no operation in progress', async () => {
		const env = envOf([], {}, { [gitDirArgv().join(' ')]: '/repo/.git' });
		await expect(detectOperationState('/repo', env)).resolves.toEqual(NONE);
	});

	it('rebase-merge: rebase with the msgnum/end step counter', async () => {
		const gitDir = path.join('/repo', '.git');
		const mergeDir = path.join(gitDir, 'rebase-merge');
		const env = envOf(
			[mergeDir],
			{ [path.join(mergeDir, 'msgnum')]: 3, [path.join(mergeDir, 'end')]: 7 },
			{
				[gitDirArgv().join(' ')]: gitDir,
				[conflictedFilesArgv().join(' ')]: 'a.ts\nb.ts\n'
			}
		);
		await expect(detectOperationState('/repo', env)).resolves.toEqual({
			type: GitOperationType.Rebase,
			conflictedFiles: ['a.ts', 'b.ts'],
			progress: { step: 3, total: 7 }
		});
	});

	it('rebase-apply: rebase with the next/last step counter', async () => {
		const gitDir = path.join('/repo', '.git');
		const applyDir = path.join(gitDir, 'rebase-apply');
		const env = envOf(
			[applyDir],
			{ [path.join(applyDir, 'next')]: 1, [path.join(applyDir, 'last')]: 4 },
			{ [gitDirArgv().join(' ')]: '.git', [conflictedFilesArgv().join(' ')]: '' }
		);
		await expect(detectOperationState('/repo', env)).resolves.toEqual({
			type: GitOperationType.Rebase,
			conflictedFiles: [],
			progress: { step: 1, total: 4 }
		});
	});

	it('cherry-pick, revert and merge are recognised, without progress', async () => {
		for (const [marker, expected] of [
			['CHERRY_PICK_HEAD', GitOperationType.CherryPick],
			['REVERT_HEAD', GitOperationType.Revert],
			['MERGE_HEAD', GitOperationType.Merge]
		] as const) {
			const gitDir = path.join('/repo', '.git');
			const env = envOf([path.join(gitDir, marker)], {}, {
				[gitDirArgv().join(' ')]: gitDir,
				[conflictedFilesArgv().join(' ')]: 'conflicted.ts\n'
			});
			await expect(detectOperationState('/repo', env)).resolves.toEqual({
				type: expected,
				conflictedFiles: ['conflicted.ts'],
				progress: null
			});
		}
	});

	it('a rebase in progress outranks the other markers', async () => {
		const gitDir = path.join('/repo', '.git');
		const env = envOf([path.join(gitDir, 'rebase-merge'), path.join(gitDir, 'MERGE_HEAD')], {}, {
			[gitDirArgv().join(' ')]: gitDir,
			[conflictedFilesArgv().join(' ')]: ''
		});
		await expect(detectOperationState('/repo', env)).resolves.toMatchObject({ type: GitOperationType.Rebase });
	});

	it('a missing step-counter file leaves the progress null (the rebase is still reported)', async () => {
		const gitDir = path.join('/repo', '.git');
		const env = envOf([path.join(gitDir, 'rebase-merge')], {}, {
			[gitDirArgv().join(' ')]: gitDir,
			[conflictedFilesArgv().join(' ')]: ''
		});
		await expect(detectOperationState('/repo', env)).resolves.toEqual({
			type: GitOperationType.Rebase, conflictedFiles: [], progress: null
		});
	});

	it('a failing conflict probe still answers the operation (with no files)', async () => {
		const gitDir = path.join('/repo', '.git');
		const env = envOf([path.join(gitDir, 'MERGE_HEAD')], {}, {
			[gitDirArgv().join(' ')]: gitDir,
			[conflictedFilesArgv().join(' ')]: new Error('boom')
		});
		await expect(detectOperationState('/repo', env)).resolves.toEqual({
			type: GitOperationType.Merge, conflictedFiles: [], progress: null
		});
	});

	it('a failing Git-directory probe resolves to no operation (never rejects)', async () => {
		const env = envOf([], {}, { [gitDirArgv().join(' ')]: new Error('not a repository') });
		await expect(detectOperationState('/repo', env)).resolves.toEqual(NONE);
	});
});

describe('readRebaseProgress', () => {
	const ints = (a: number, b: number) => ({ readIntFile: (file: string) => Promise.resolve(file.endsWith('msgnum') || file.endsWith('next') ? a : b) });

	it('reads the pair when both are plain integers', async () => {
		await expect(readRebaseProgress('d/msgnum', 'd/end', ints(2, 5))).resolves.toEqual({ step: 2, total: 5 });
	});

	it('is null when either file is missing or not an integer', async () => {
		await expect(readRebaseProgress('d/msgnum', 'd/end', { readIntFile: () => Promise.resolve(null) })).resolves.toBeNull();
		// The env contract maps a non-integer file to null (as the real readIntFile does).
		await expect(readRebaseProgress('d/msgnum', 'd/end', { readIntFile: (file) => Promise.resolve(file.endsWith('msgnum') ? 2 : null) })).resolves.toBeNull();
	});
});

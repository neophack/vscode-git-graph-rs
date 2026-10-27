/**
 * Working-tree file write operations: the uncommitted-change actions and the per-file
 * actions, as pure `WriteOp` builders.
 */

import { WriteOp, single } from './op';

export interface CleanUntrackedFilesParams {
	/** Is `-d` enabled (clean directories too). */
	readonly directories: boolean;
}

export function cleanUntrackedFiles(params: CleanUntrackedFilesParams): WriteOp {
	return {
		steps: single(['clean', '-f' + (params.directories ? 'd' : '')]),
		effects: ['worktree']
	};
}

export interface ResetFileToRevisionParams {
	readonly commitHash: string;
	readonly filePath: string;
}

export function resetFileToRevision(params: ResetFileToRevisionParams): WriteOp {
	return {
		steps: single(['checkout', params.commitHash, '--', params.filePath]),
		effects: ['worktree'],
		// The path sits after `--`, so Git cannot read it as an option; only the hash
		// needs a check.
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

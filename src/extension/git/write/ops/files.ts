/**
 * Working-tree file write operations, ported from `DataSource`'s
 * "Git Action Methods - Uncommitted" and "Git Action Methods - File" (`src/dataSource.ts`).
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
		// The path sits after `--`, so Git cannot read it as an option; the legacy code checked
		// only the hash, and that parity is kept here.
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

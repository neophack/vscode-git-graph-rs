/**
 * Worktree write operations: pure `WriteOp` builders.
 */

import { WriteOp, single } from './op';

export interface AddWorktreeParams {
	readonly path: string;
	/** An existing branch to check out in the worktree, or null to use `newBranch` instead. */
	readonly branch: string | null;
	/** A new branch name to create (starting at `branch`, or HEAD), or null. */
	readonly newBranch: string | null;
}

export function addWorktree(params: AddWorktreeParams): WriteOp {
	const argv = ['worktree', 'add'];
	if (params.newBranch !== null) argv.push('-b', params.newBranch);
	argv.push(params.path);
	if (params.branch !== null) argv.push(params.branch);
	return {
		steps: single(argv),
		effects: params.newBranch !== null ? ['refs', 'worktree'] : ['worktree'],
		checks: [['path', params.path, 'url'], ['branch', params.branch, 'ref'], ['newBranch', params.newBranch, 'ref']]
	};
}

export interface RemoveWorktreeParams {
	readonly path: string;
	readonly force: boolean;
}

export function removeWorktree(params: RemoveWorktreeParams): WriteOp {
	const argv = ['worktree', 'remove'];
	if (params.force) argv.push('--force');
	argv.push(params.path);
	return {
		steps: single(argv),
		effects: ['worktree'],
		checks: [['path', params.path, 'url']]
	};
}

export function pruneWorktrees(): WriteOp {
	return { steps: single(['worktree', 'prune']), effects: ['worktree'] };
}

/**
 * Stash write operations: pure `WriteOp` builders.
 */

import { WriteOp, single } from './op';

export interface ApplyStashParams {
	readonly selector: string;
	readonly reinstateIndex: boolean;
}

export function applyStash(params: ApplyStashParams): WriteOp {
	const argv = ['stash', 'apply'];
	if (params.reinstateIndex) argv.push('--index');
	argv.push(params.selector);
	return {
		steps: single(argv),
		effects: ['worktree'],
		checks: [['selector', params.selector, 'stash']]
	};
}

export interface BranchFromStashParams {
	readonly selector: string;
	readonly branchName: string;
}

export function branchFromStash(params: BranchFromStashParams): WriteOp {
	return {
		steps: single(['stash', 'branch', params.branchName, params.selector]),
		effects: ['refs', 'head', 'worktree', 'stash'],
		checks: [['selector', params.selector, 'stash'], ['branchName', params.branchName, 'ref']]
	};
}

export interface DropStashParams {
	readonly selector: string;
}

export function dropStash(params: DropStashParams): WriteOp {
	return {
		steps: single(['stash', 'drop', params.selector]),
		effects: ['stash'],
		checks: [['selector', params.selector, 'stash']]
	};
}

export interface PopStashParams {
	readonly selector: string;
	readonly reinstateIndex: boolean;
}

export function popStash(params: PopStashParams): WriteOp {
	const argv = ['stash', 'pop'];
	if (params.reinstateIndex) argv.push('--index');
	argv.push(params.selector);
	return {
		steps: single(argv),
		effects: ['stash', 'worktree'],
		checks: [['selector', params.selector, 'stash']]
	};
}

export interface PushStashParams {
	readonly message: string;
	readonly includeUntracked: boolean;
}

export function pushStash(params: PushStashParams): WriteOp {
	const argv = ['stash', 'push'];
	if (params.includeUntracked) argv.push('--include-untracked');
	if (params.message !== '') argv.push('--message', params.message);
	return {
		steps: single(argv),
		effects: ['stash', 'worktree'],
		requires: 'PushStash',
		checks: []
	};
}

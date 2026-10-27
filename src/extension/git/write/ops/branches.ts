/**
 * Branch write operations: one pure `WriteOp` builder per action. The argv of each option
 * branch is fixed data, pinned exactly by the table tests in `ops.test.ts`.
 */

import { GitPushBranchMode } from '../../../../shared/model/git';
import { SquashMessageFormat } from '../../../../shared/model/webview';
import { WriteOp, WriteStep, single } from './op';

export interface CheckoutBranchParams {
	readonly branchName: string;
	/** The remote branch to check out (creating a local branch of the same name), or null. */
	readonly remoteBranch: string | null;
}

export function checkoutBranch(params: CheckoutBranchParams): WriteOp {
	return {
		steps: [params.remoteBranch === null
			? { argv: ['checkout', params.branchName] }
			: { argv: ['checkout', '-b', params.branchName, params.remoteBranch] }],
		effects: ['refs', 'head', 'worktree'],
		checks: [['branchName', params.branchName, 'ref'], ['remoteBranch', params.remoteBranch, 'ref']]
	};
}

export interface CreateBranchParams {
	readonly branchName: string;
	readonly commitHash: string;
	readonly checkout: boolean;
	readonly force: boolean;
}

export function createBranch(params: CreateBranchParams): WriteOp {
	// Legacy order: `checkout -b` in one step when it checks out and is not forced; otherwise
	// `branch [-f]`, and a forced checkout runs `checkout <name>` as a second command.
	const steps: WriteStep[] = [];
	if (params.checkout && !params.force) {
		steps.push({ argv: ['checkout', '-b', params.branchName, params.commitHash] });
	} else {
		steps.push({ argv: ['branch'].concat(params.force ? ['-f'] : [], [params.branchName, params.commitHash]) });
		if (params.checkout && params.force) steps.push({ argv: ['checkout', params.branchName] });
	}
	return {
		steps,
		effects: params.checkout ? ['refs', 'head', 'worktree'] : ['refs'],
		checks: [['branchName', params.branchName, 'ref'], ['commitHash', params.commitHash, 'hash']]
	};
}

export interface DeleteBranchParams {
	readonly branchName: string;
	readonly force: boolean;
}

export function deleteBranch(params: DeleteBranchParams): WriteOp {
	return {
		steps: single(['branch', params.force ? '-D' : '-d', params.branchName]),
		effects: ['refs'],
		checks: [['branchName', params.branchName, 'ref']]
	};
}

export interface DeleteRemoteBranchParams {
	readonly branchName: string;
	readonly remote: string;
}

export function deleteRemoteBranch(params: DeleteRemoteBranchParams): WriteOp {
	return {
		steps: single(['push', params.remote, '--delete', params.branchName]),
		effects: ['refs'],
		network: true,
		checks: [['branchName', params.branchName, 'ref'], ['remote', params.remote, 'ref']]
	};
}

/**
 * The fallback of a remote-branch deletion: when the remote ref no longer exists (the push
 * fails with "remote ref does not exist"), the stale remote-tracking branch is deleted instead.
 */
export function deleteRemoteTrackingBranch(params: DeleteRemoteBranchParams): WriteOp {
	return {
		steps: single(['branch', '-d', '-r', params.remote + '/' + params.branchName]),
		effects: ['refs'],
		checks: [['branchName', params.branchName, 'ref'], ['remote', params.remote, 'ref']]
	};
}

export interface FetchIntoLocalBranchParams {
	readonly remote: string;
	readonly remoteBranch: string;
	readonly localBranch: string;
	readonly force: boolean;
	/** Whether `localBranch` is the currently checked-out branch (a preflight read). */
	readonly isCurrentBranch: boolean;
}

export function fetchIntoLocalBranch(params: FetchIntoLocalBranchParams): WriteOp {
	// Legacy behaviour: the current branch cannot be fetch-fast-forwarded into, so it is pulled
	// (or fetch + hard reset when forced); any other branch is written by one fetch refspec.
	if (params.isCurrentBranch && !params.force) {
		return {
			steps: single(['pull', params.remote, params.remoteBranch]),
			effects: ['refs', 'head', 'commits', 'worktree'],
			network: true,
			checks: checksOfFetchIntoLocalBranch(params)
		};
	}
	if (params.isCurrentBranch) {
		return {
			steps: [
				{ argv: ['fetch', params.remote, params.remoteBranch] },
				{ argv: ['reset', '--hard', params.remote + '/' + params.remoteBranch] }
			],
			effects: ['refs', 'head', 'commits', 'worktree'],
			network: true,
			checks: checksOfFetchIntoLocalBranch(params)
		};
	}
	return {
		steps: single(['fetch'].concat(params.force ? ['-f'] : [], [params.remote, params.remoteBranch + ':' + params.localBranch])),
		effects: ['refs', 'commits'],
		network: true,
		checks: checksOfFetchIntoLocalBranch(params)
	};
}

function checksOfFetchIntoLocalBranch(params: FetchIntoLocalBranchParams) {
	return [
		['remote', params.remote, 'ref'],
		['remoteBranch', params.remoteBranch, 'ref'],
		['localBranch', params.localBranch, 'ref']
	] as const;
}

export interface PullBranchParams {
	readonly branchName: string;
	readonly remote: string;
	/** `--no-ff` when a merge is required and `squash` is not set. */
	readonly createNewCommit: boolean;
	readonly squash: boolean;
	/** The `repository.sign.commits` policy (`-S`). */
	readonly sign: boolean;
}

export function pullBranch(params: PullBranchParams): WriteOp {
	const argv = ['pull', params.remote, params.branchName];
	if (params.squash) argv.push('--squash');
	else if (params.createNewCommit) argv.push('--no-ff');
	if (params.sign) argv.push('-S');
	return {
		steps: single(argv),
		effects: ['refs', 'head', 'commits', 'worktree'],
		network: true,
		checks: [['branchName', params.branchName, 'ref'], ['remote', params.remote, 'ref']]
	};
}

/**
 * The follow-up of a squash pull: the squash
 * leaves the merge staged, which is committed here. The caller runs it only when the pull
 * succeeded AND staged changes exist (a read between the two commands).
 */
export interface CommitSquashFromPullParams {
	readonly remote: string;
	readonly branchName: string;
	readonly squashMessageFormat: SquashMessageFormat;
	readonly sign: boolean;
}

export function commitSquashFromPull(params: CommitSquashFromPullParams): WriteOp {
	const argv = ['commit'];
	if (params.sign) argv.push('-S');
	if (params.squashMessageFormat === SquashMessageFormat.Default) {
		argv.push('-m', 'Merge branch \'' + params.remote + '/' + params.branchName + '\'');
	} else {
		argv.push('--no-edit');
	}
	return { steps: single(argv), effects: ['commits'] };
}

export interface RenameBranchParams {
	readonly oldName: string;
	readonly newName: string;
}

export function renameBranch(params: RenameBranchParams): WriteOp {
	return {
		steps: single(['branch', '-m', params.oldName, params.newName]),
		effects: ['refs', 'head'],
		checks: [['oldName', params.oldName, 'ref'], ['newName', params.newName, 'ref']]
	};
}

/** The branch push argv shared by `pushBranch` (see `remotes.ts`) — kept next to its siblings. */
export function pushBranchArgv(branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode): ReadonlyArray<string> {
	const argv = ['push', remote, branchName];
	if (setUpstream) argv.push('--set-upstream');
	if (mode !== GitPushBranchMode.Normal) argv.push('--' + mode);
	return argv;
}

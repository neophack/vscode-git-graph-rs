/**
 * Commit write operations, ported one-for-one from `DataSource`'s
 * "Git Action Methods - Commits" (`src/dataSource.ts`), plus the archive action.
 */

import { GitResetMode } from '../../../../types/git';
import { WriteOp, single } from './op';

export interface CheckoutCommitParams {
	readonly commitHash: string;
}

export function checkoutCommit(params: CheckoutCommitParams): WriteOp {
	return {
		steps: single(['checkout', params.commitHash]),
		effects: ['head', 'worktree'],
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

export interface CherrypickCommitParams {
	readonly commitHash: string;
	/** The parent index when the commit is a merge (0 = not a merge). */
	readonly parentIndex: number;
	readonly recordOrigin: boolean;
	readonly noCommit: boolean;
	readonly sign: boolean;
}

export function cherrypickCommit(params: CherrypickCommitParams): WriteOp {
	const argv = ['cherry-pick'];
	if (params.noCommit) argv.push('--no-commit');
	if (params.recordOrigin) argv.push('-x');
	if (params.sign) argv.push('-S');
	if (params.parentIndex > 0) argv.push('-m', params.parentIndex.toString());
	argv.push(params.commitHash);
	return {
		steps: single(argv),
		effects: ['commits', 'head', 'worktree'],
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

export interface TargetCommitParams {
	readonly commitHash: string;
	readonly sign: boolean;
}

export function createFixupCommit(params: TargetCommitParams): WriteOp {
	const argv = ['commit', '--fixup', params.commitHash];
	if (params.sign) argv.push('-S');
	return {
		steps: single(argv),
		effects: ['commits'],
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

export function createSquashCommit(params: TargetCommitParams): WriteOp {
	// `git commit --squash` opens an editor for the message; --no-edit takes Git's own generated
	// "squash! <subject>" (the exact subject the autosquash flow expects), so a spawned process
	// without a terminal cannot block on it.
	const argv = ['commit', '--squash', params.commitHash, '--no-edit'];
	if (params.sign) argv.push('-S');
	return {
		steps: single(argv),
		effects: ['commits'],
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

export function dropCommit(params: TargetCommitParams): WriteOp {
	const argv = ['rebase'];
	if (params.sign) argv.push('-S');
	argv.push('--onto', params.commitHash + '^', params.commitHash);
	return {
		steps: single(argv),
		effects: ['commits', 'refs', 'head', 'worktree'],
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

export interface ResetToCommitParams {
	/** The commit to reset to, or the `'HEAD'` sentinel (reset uncommitted changes). */
	readonly commit: string;
	readonly resetMode: GitResetMode;
}

export function resetToCommit(params: ResetToCommitParams): WriteOp {
	const effects: ReadonlyArray<'head' | 'worktree'> = params.resetMode === GitResetMode.Hard ? ['head', 'worktree'] : ['head'];
	return {
		steps: single(['reset', '--' + params.resetMode, params.commit]),
		effects,
		checks: params.commit === 'HEAD' ? [] : [['commit', params.commit, 'hash']]
	};
}

export interface RevertCommitParams {
	readonly commitHash: string;
	readonly parentIndex: number;
	readonly sign: boolean;
}

export function revertCommit(params: RevertCommitParams): WriteOp {
	const argv = ['revert', '--no-edit'];
	if (params.sign) argv.push('-S');
	if (params.parentIndex > 0) argv.push('-m', params.parentIndex.toString());
	argv.push(params.commitHash);
	return {
		steps: single(argv),
		effects: ['commits', 'head', 'worktree'],
		checks: [['commitHash', params.commitHash, 'hash']]
	};
}

export function undoLastCommit(): WriteOp {
	return { steps: single(['reset', '--soft', 'HEAD^']), effects: ['head'] };
}

export interface AmendLastCommitParams {
	readonly sign: boolean;
}

export function amendLastCommit(params: AmendLastCommitParams): WriteOp {
	const argv = ['commit', '--amend', '--no-edit'];
	if (params.sign) argv.push('-S');
	return { steps: single(argv), effects: ['commits'] };
}

/**
 * Amend HEAD's commit message (and optionally its author): the HEAD case of the legacy
 * `editCommitMessage`. The earlier-commit case drives an interactive rebase through temporary
 * editor scripts (see `src/dataSource.ts`), which is a process-side flow this pure op table does
 * not model — it stays with the caller until a follow-up models it.
 */
export interface AmendCommitMessageParams {
	readonly message: string;
	readonly authorName?: string;
	readonly authorEmail?: string;
	readonly sign: boolean;
}

export function amendCommitMessage(params: AmendCommitMessageParams): WriteOp {
	// The new author in git's "Name <email>" form (an empty email is written as "<>", which git
	// records as a name-only author), or left unset when the caller passed nothing.
	const author = typeof params.authorName === 'string' && params.authorName.trim() !== ''
		? (typeof params.authorEmail === 'string' && params.authorEmail.trim() !== ''
			? params.authorName + ' <' + params.authorEmail + '>'
			: params.authorName + ' <>')
		: null;
	const argv = ['commit', '--amend'];
	if (author !== null) argv.push('--author=' + author);
	argv.push('-m', params.message);
	if (params.sign) argv.push('-S');
	return { steps: single(argv), effects: ['commits'] };
}

export function resetCurrentBranchToRemote(): WriteOp {
	return { steps: single(['reset', '--soft', '@{upstream}']), effects: ['head'] };
}

export interface ArchiveParams {
	readonly ref: string;
	readonly outputFilePath: string;
	readonly type: 'tar' | 'zip';
}

export function archive(params: ArchiveParams): WriteOp {
	return {
		steps: single(['archive', '--format=' + params.type, '-o', params.outputFilePath, params.ref]),
		effects: [],
		checks: [['ref', params.ref, 'ref']]
	};
}

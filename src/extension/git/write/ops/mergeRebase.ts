/**
 * Merge and rebase write operations, ported from `DataSource`'s
 * "Git Action Methods - Branches & Commits" (`src/dataSource.ts`), plus the continue/abort
 * commands of an in-progress operation.
 */

import { MergeActionOn, RebaseActionOn } from '../../../../types/messages';
import { GitOperationType } from '../../../../types/git';
import { SquashMessageFormat } from '../../../../types/webview';
import { ArgCheck, WriteOp, single } from './op';

export interface MergeParams {
	readonly obj: string;
	readonly actionOn: MergeActionOn;
	readonly createNewCommit: boolean;
	readonly squash: boolean;
	readonly noCommit: boolean;
	readonly sign: boolean;
}

export function merge(params: MergeParams): WriteOp {
	const argv = ['merge', params.obj];
	if (params.squash) argv.push('--squash');
	else if (params.createNewCommit) argv.push('--no-ff');
	if (params.noCommit) argv.push('--no-commit');
	if (params.sign) argv.push('-S');
	return {
		steps: single(argv),
		effects: ['commits', 'refs', 'head', 'worktree'],
		checks: [objCheck('obj', params.obj, params.actionOn === MergeActionOn.Commit)]
	};
}

/**
 * The follow-up of a squash merge (the legacy `commitSquashIfStagedChangesExist`): the caller
 * runs it only when the merge succeeded AND staged changes exist (a read between the two
 * commands) and the merge was not `--no-commit`.
 */
export interface CommitSquashFromMergeParams {
	readonly obj: string;
	readonly actionOn: MergeActionOn;
	readonly squashMessageFormat: SquashMessageFormat;
	readonly sign: boolean;
}

export function commitSquashFromMerge(params: CommitSquashFromMergeParams): WriteOp {
	const argv = ['commit'];
	if (params.sign) argv.push('-S');
	if (params.squashMessageFormat === SquashMessageFormat.Default) {
		// 'Merge branch …' / 'Merge remote-tracking branch …' / 'Merge commit …'
		argv.push('-m', 'Merge ' + params.actionOn.toLowerCase() + ' \'' + params.obj + '\'');
	} else {
		argv.push('--no-edit');
	}
	return { steps: single(argv), effects: ['commits'] };
}

export interface RebaseParams {
	readonly obj: string;
	readonly actionOn: RebaseActionOn;
	readonly ignoreDate: boolean;
	readonly sign: boolean;
}

export function rebase(params: RebaseParams): WriteOp {
	// The interactive variant of the legacy `rebase` runs through the integrated terminal
	// (shell quoting and an editor are involved), so it has no argv here; only the headless
	// rebase is a plain spawn.
	const argv = ['rebase', params.obj];
	if (params.ignoreDate) argv.push('--ignore-date');
	if (params.sign) argv.push('-S');
	return {
		steps: single(argv),
		effects: ['commits', 'refs', 'head', 'worktree'],
		checks: [objCheck('obj', params.obj, params.actionOn === RebaseActionOn.Branch ? false : true)]
	};
}

export interface OperationStepParams {
	readonly type: GitOperationType;
}

/** Continue an in-progress merge, rebase, cherry-pick or revert. */
export function continueOperation(params: OperationStepParams): WriteOp {
	return { steps: single([params.type, '--continue']), effects: ['commits', 'head', 'worktree'] };
}

/** Abort an in-progress merge, rebase, cherry-pick or revert. */
export function abortOperation(params: OperationStepParams): WriteOp {
	return { steps: single([params.type, '--abort']), effects: ['head', 'worktree'] };
}

/** A merge object is a commit hash when the action is on a commit, a ref name otherwise. */
function objCheck(name: string, obj: string, isCommit: boolean): ArgCheck {
	return isCommit ? [name, obj, 'hash'] : [name, obj, 'ref'];
}

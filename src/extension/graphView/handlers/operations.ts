import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import { GitPushBranchMode } from '../../../types';
import type { ErrorInfo } from '../../../types';
import type { Handler } from './context';
import * as flows from '../writeFlows';

/** In-progress Git operation handlers plus conflict prediction and PR creation. */

export const merge: Handler<'merge'> = {
	mutates: MUTATING_COMMANDS.merge,
	async handle(msg, ctx) {
		ctx.send({
			command: 'merge',
			actionOn: msg.actionOn,
			error: await flows.merge(ctx, msg.repo, msg.obj, msg.actionOn, msg.createNewCommit, msg.squash, msg.noCommit)
		});
	}
};

export const rebase: Handler<'rebase'> = {
	mutates: MUTATING_COMMANDS.rebase,
	async handle(msg, ctx) {
		ctx.send({
			command: 'rebase',
			actionOn: msg.actionOn,
			interactive: msg.interactive,
			error: await flows.rebase(ctx, msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive, msg.autosquash)
		});
	}
};

export const abortOperation: Handler<'abortOperation'> = {
	mutates: MUTATING_COMMANDS.abortOperation,
	async handle(msg, ctx) {
		ctx.send({
			command: 'abortOperation',
			error: await flows.abortOperation(ctx, msg.repo, msg.type)
		});
	}
};

export const continueOperation: Handler<'continueOperation'> = {
	mutates: MUTATING_COMMANDS.continueOperation,
	async handle(msg, ctx) {
		ctx.send({
			command: 'continueOperation',
			error: await flows.continueOperation(ctx, msg.repo, msg.type)
		});
	}
};

export const predictConflicts: Handler<'predictConflicts'> = {
	mutates: MUTATING_COMMANDS.predictConflicts,
	async handle(msg, ctx) {
		ctx.send({
			command: 'predictConflicts',
			ours: msg.ours,
			theirs: msg.theirs,
			prediction: await ctx.repo.read.predictConflicts(msg.repo, msg.ours, msg.theirs).catch(() => null)
		});
	}
};

export const cleanUntrackedFiles: Handler<'cleanUntrackedFiles'> = {
	mutates: MUTATING_COMMANDS.cleanUntrackedFiles,
	async handle(msg, ctx) {
		ctx.send({
			command: 'cleanUntrackedFiles',
			error: await flows.cleanUntrackedFiles(ctx, msg.repo, msg.directories)
		});
	}
};

export const createPullRequest: Handler<'createPullRequest'> = {
	mutates: MUTATING_COMMANDS.createPullRequest,
	async handle(msg, ctx) {
		// The branch is pushed first (when asked); the PR opens only on a clean push
		const errorInfos: ErrorInfo[] = [msg.push
			? <ErrorInfo>await flows.pushBranch(ctx, msg.repo, msg.sourceBranch, msg.sourceRemote, true, GitPushBranchMode.Normal, false)
			: null];
		if (errorInfos[0] === null) {
			errorInfos.push(await ctx.ui.createPullRequest(msg.config, msg.sourceOwner, msg.sourceRepo, msg.sourceBranch));
		}
		ctx.send({ command: 'createPullRequest', push: msg.push, errors: errorInfos });
	}
};

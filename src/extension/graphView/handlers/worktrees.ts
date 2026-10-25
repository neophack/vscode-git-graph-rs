import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { Handler } from './context';
import * as flows from '../writeFlows';

/** Worktree handlers: list, add, remove, prune. */

export const worktreeList: Handler<'worktreeList'> = {
	mutates: MUTATING_COMMANDS.worktreeList,
	async handle(msg, ctx) {
		ctx.send({
			command: 'worktreeList',
			repo: msg.repo,
			worktrees: await ctx.repo.read.getWorktrees(msg.repo).catch(() => [])
		});
	}
};

export const worktreeAdd: Handler<'worktreeAdd'> = {
	mutates: MUTATING_COMMANDS.worktreeAdd,
	async handle(msg, ctx) {
		ctx.send({
			command: 'worktreeAdd',
			error: await flows.addWorktree(ctx, msg.repo, msg.path, msg.branch, msg.newBranch)
		});
	}
};

export const worktreeRemove: Handler<'worktreeRemove'> = {
	mutates: MUTATING_COMMANDS.worktreeRemove,
	async handle(msg, ctx) {
		ctx.send({
			command: 'worktreeRemove',
			error: await flows.removeWorktree(ctx, msg.repo, msg.path, msg.force)
		});
	}
};

export const worktreePrune: Handler<'worktreePrune'> = {
	mutates: MUTATING_COMMANDS.worktreePrune,
	async handle(msg, ctx) {
		ctx.send({ command: 'worktreePrune', error: await flows.pruneWorktrees(ctx, msg.repo) });
	}
};

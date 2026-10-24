import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { Handler } from './context';

/** Worktree handlers: list, add, remove, prune. */

export const worktreeList: Handler<'worktreeList'> = {
	mutates: MUTATING_COMMANDS.worktreeList,
	async handle(msg, ctx) {
		ctx.send({
			command: 'worktreeList',
			repo: msg.repo,
			worktrees: await ctx.repo.getWorktrees(msg.repo)
		});
	}
};

export const worktreeAdd: Handler<'worktreeAdd'> = {
	mutates: MUTATING_COMMANDS.worktreeAdd,
	async handle(msg, ctx) {
		ctx.send({
			command: 'worktreeAdd',
			error: await ctx.repo.addWorktree(msg.repo, msg.path, msg.branch, msg.newBranch)
		});
	}
};

export const worktreeRemove: Handler<'worktreeRemove'> = {
	mutates: MUTATING_COMMANDS.worktreeRemove,
	async handle(msg, ctx) {
		ctx.send({
			command: 'worktreeRemove',
			error: await ctx.repo.removeWorktree(msg.repo, msg.path, msg.force)
		});
	}
};

export const worktreePrune: Handler<'worktreePrune'> = {
	mutates: MUTATING_COMMANDS.worktreePrune,
	async handle(msg, ctx) {
		ctx.send({ command: 'worktreePrune', error: await ctx.repo.pruneWorktrees(msg.repo) });
	}
};

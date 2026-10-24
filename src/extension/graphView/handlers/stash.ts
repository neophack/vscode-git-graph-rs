import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { ErrorInfo } from '../../../types';
import { sendLossWarning } from './context';
import type { Handler } from './context';

/** Stash handlers: push/pop/apply/drop and branching off a stash (loss-guarded). */

export const applyStash: Handler<'applyStash'> = {
	mutates: MUTATING_COMMANDS.applyStash,
	async handle(msg, ctx) {
		ctx.send({
			command: 'applyStash',
			error: await ctx.repo.applyStash(msg.repo, msg.selector, msg.reinstateIndex)
		});
	}
};

export const popStash: Handler<'popStash'> = {
	mutates: MUTATING_COMMANDS.popStash,
	async handle(msg, ctx) {
		ctx.send({
			command: 'popStash',
			error: await ctx.repo.popStash(msg.repo, msg.selector, msg.reinstateIndex)
		});
	}
};

export const pushStash: Handler<'pushStash'> = {
	mutates: MUTATING_COMMANDS.pushStash,
	async handle(msg, ctx) {
		ctx.send({
			command: 'pushStash',
			error: await ctx.repo.pushStash(msg.repo, msg.message, msg.includeUntracked)
		});
	}
};

export const dropStash: Handler<'dropStash'> = {
	mutates: MUTATING_COMMANDS.dropStash,
	async handle(msg, ctx) {
		ctx.send({ command: 'dropStash', error: await ctx.repo.dropStash(msg.repo, msg.selector) });
	}
};

export const branchFromStash: Handler<'branchFromStash'> = {
	mutates: MUTATING_COMMANDS.branchFromStash,
	async handle(msg, ctx) {
		const branchFromStashResult = await ctx.repo.branchFromStash(msg.repo, msg.selector, msg.branchName, msg.confirmed === true);
		if (sendLossWarning(branchFromStashResult, msg, ctx)) return;
		ctx.send({ command: 'branchFromStash', error: <ErrorInfo>branchFromStashResult });
	}
};

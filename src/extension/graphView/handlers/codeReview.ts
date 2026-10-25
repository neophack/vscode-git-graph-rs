import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { Handler } from './context';

/** Code-review handlers: the review store lives in ExtensionState behind the storage port. */

export const startCodeReview: Handler<'startCodeReview'> = {
	mutates: MUTATING_COMMANDS.startCodeReview,
	async handle(msg, ctx) {
		ctx.send({
			command: 'startCodeReview',
			commitHash: msg.commitHash,
			compareWithHash: msg.compareWithHash,
			...await ctx.storage.startCodeReview(msg.repo, msg.id, msg.files, msg.lastViewedFile)
		});
	}
};

export const updateCodeReview: Handler<'updateCodeReview'> = {
	mutates: MUTATING_COMMANDS.updateCodeReview,
	async handle(msg, ctx) {
		ctx.send({
			command: 'updateCodeReview',
			error: await ctx.storage.updateCodeReview(msg.repo, msg.id, msg.remainingFiles, msg.lastViewedFile)
		});
	}
};

export const endCodeReview: Handler<'endCodeReview'> = {
	mutates: MUTATING_COMMANDS.endCodeReview,
	handle(msg, ctx) {
		ctx.storage.endCodeReview(msg.repo, msg.id);
	}
};

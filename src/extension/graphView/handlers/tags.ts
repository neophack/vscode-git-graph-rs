import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { ErrorInfo } from '../../../types';
import type { Handler } from './context';

/** Tag handlers: create, delete, push, and the annotated-tag details read. */

export const addTag: Handler<'addTag'> = {
	mutates: MUTATING_COMMANDS.addTag,
	async handle(msg, ctx) {
		const errorInfos: ErrorInfo[] = [await ctx.repo.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, msg.force)];
		if (errorInfos[0] === null && msg.pushToRemote !== null) {
			errorInfos.push(...await ctx.repo.pushTag(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.pushSkipRemoteCheck));
		}
		ctx.send({
			command: 'addTag',
			repo: msg.repo,
			tagName: msg.tagName,
			pushToRemote: msg.pushToRemote,
			commitHash: msg.commitHash,
			errors: errorInfos
		});
	}
};

export const deleteTag: Handler<'deleteTag'> = {
	mutates: MUTATING_COMMANDS.deleteTag,
	async handle(msg, ctx) {
		ctx.send({
			command: 'deleteTag',
			error: await ctx.repo.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote)
		});
	}
};

export const pushTag: Handler<'pushTag'> = {
	mutates: MUTATING_COMMANDS.pushTag,
	async handle(msg, ctx) {
		ctx.send({
			command: 'pushTag',
			repo: msg.repo,
			tagName: msg.tagName,
			remotes: msg.remotes,
			commitHash: msg.commitHash,
			errors: await ctx.repo.pushTag(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.skipRemoteCheck)
		});
	}
};

export const tagDetails: Handler<'tagDetails'> = {
	mutates: MUTATING_COMMANDS.tagDetails,
	async handle(msg, ctx) {
		const details = await ctx.repo.getTagDetails(msg.repo, msg.tagName);
		ctx.send({
			command: 'tagDetails',
			tagName: msg.tagName,
			commitHash: msg.commitHash,
			details: details.details,
			error: details.error
		});
	}
};

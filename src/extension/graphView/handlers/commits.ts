import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { ErrorInfo } from '../../../shared/protocol/messages';
import { sendLossWarning } from './context';
import type { Handler } from './context';
import * as flows from '../writeFlows';

/** Commit handlers: history-editing operations on single commits plus the loss-guarded resets. */

export const checkoutCommit: Handler<'checkoutCommit'> = {
	mutates: MUTATING_COMMANDS.checkoutCommit,
	async handle(msg, ctx) {
		const checkoutResult = await flows.checkoutCommit(ctx, msg.repo, msg.commitHash, msg.confirmed === true);
		if (sendLossWarning(checkoutResult, msg, ctx)) return;
		ctx.send({ command: 'checkoutCommit', error: <ErrorInfo>checkoutResult });
	}
};

export const cherrypickCommit: Handler<'cherrypickCommit'> = {
	mutates: MUTATING_COMMANDS.cherrypickCommit,
	async handle(msg, ctx) {
		const errorInfos: ErrorInfo[] = [await flows.cherrypickCommit(ctx, msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit)];
		if (errorInfos[0] === null && msg.noCommit) {
			errorInfos.push(await ctx.ui.viewScm());
		}
		ctx.send({ command: 'cherrypickCommit', errors: errorInfos });
	}
};

export const revertCommit: Handler<'revertCommit'> = {
	mutates: MUTATING_COMMANDS.revertCommit,
	async handle(msg, ctx) {
		ctx.send({
			command: 'revertCommit',
			error: await flows.revertCommit(ctx, msg.repo, msg.commitHash, msg.parentIndex)
		});
	}
};

export const dropCommit: Handler<'dropCommit'> = {
	mutates: MUTATING_COMMANDS.dropCommit,
	async handle(msg, ctx) {
		ctx.send({ command: 'dropCommit', error: await flows.dropCommit(ctx, msg.repo, msg.commitHash) });
	}
};

export const undoLastCommit: Handler<'undoLastCommit'> = {
	mutates: MUTATING_COMMANDS.undoLastCommit,
	async handle(msg, ctx) {
		ctx.send({ command: 'undoLastCommit', error: await flows.undoLastCommit(ctx, msg.repo) });
	}
};

export const editCommitMessage: Handler<'editCommitMessage'> = {
	mutates: MUTATING_COMMANDS.editCommitMessage,
	async handle(msg, ctx) {
		ctx.send({
			command: 'editCommitMessage',
			error: await flows.editCommitMessage(ctx, msg.repo, msg.commitHash, msg.message, msg.authorName, msg.authorEmail)
		});
	}
};

export const commitFixup: Handler<'commitFixup'> = {
	mutates: MUTATING_COMMANDS.commitFixup,
	async handle(msg, ctx) {
		ctx.send({ command: 'commitFixup', error: await flows.createFixupCommit(ctx, msg.repo, msg.commitHash) });
	}
};

export const commitSquash: Handler<'commitSquash'> = {
	mutates: MUTATING_COMMANDS.commitSquash,
	async handle(msg, ctx) {
		ctx.send({ command: 'commitSquash', error: await flows.createSquashCommit(ctx, msg.repo, msg.commitHash) });
	}
};

export const resetToCommit: Handler<'resetToCommit'> = {
	mutates: MUTATING_COMMANDS.resetToCommit,
	async handle(msg, ctx) {
		const resetResult = await flows.resetToCommit(ctx, msg.repo, msg.commit, msg.resetMode, msg.confirmed === true);
		if (sendLossWarning(resetResult, msg, ctx)) return;
		ctx.send({ command: 'resetToCommit', error: <ErrorInfo>resetResult });
	}
};

export const resetFileToRevision: Handler<'resetFileToRevision'> = {
	mutates: MUTATING_COMMANDS.resetFileToRevision,
	async handle(msg, ctx) {
		ctx.send({
			command: 'resetFileToRevision',
			error: await flows.resetFileToRevision(ctx, msg.repo, msg.commitHash, msg.filePath)
		});
	}
};

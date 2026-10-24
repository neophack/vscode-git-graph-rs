import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { ErrorInfo } from '../../../types';
import { sendLossWarning } from './context';
import type { Handler } from './context';

/** Commit handlers: history-editing operations on single commits plus the loss-guarded resets. */

export const checkoutCommit: Handler<'checkoutCommit'> = {
	mutates: MUTATING_COMMANDS.checkoutCommit,
	async handle(msg, ctx) {
		const checkoutResult = await ctx.repo.checkoutCommit(msg.repo, msg.commitHash, msg.confirmed === true);
		if (sendLossWarning(checkoutResult, msg, ctx)) return;
		ctx.send({ command: 'checkoutCommit', error: <ErrorInfo>checkoutResult });
	}
};

export const cherrypickCommit: Handler<'cherrypickCommit'> = {
	mutates: MUTATING_COMMANDS.cherrypickCommit,
	async handle(msg, ctx) {
		const errorInfos: ErrorInfo[] = [await ctx.repo.cherrypickCommit(msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit)];
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
			error: await ctx.repo.revertCommit(msg.repo, msg.commitHash, msg.parentIndex)
		});
	}
};

export const dropCommit: Handler<'dropCommit'> = {
	mutates: MUTATING_COMMANDS.dropCommit,
	async handle(msg, ctx) {
		ctx.send({ command: 'dropCommit', error: await ctx.repo.dropCommit(msg.repo, msg.commitHash) });
	}
};

export const undoLastCommit: Handler<'undoLastCommit'> = {
	mutates: MUTATING_COMMANDS.undoLastCommit,
	async handle(msg, ctx) {
		ctx.send({ command: 'undoLastCommit', error: await ctx.repo.undoLastCommit(msg.repo) });
	}
};

export const editCommitMessage: Handler<'editCommitMessage'> = {
	mutates: MUTATING_COMMANDS.editCommitMessage,
	async handle(msg, ctx) {
		ctx.send({
			command: 'editCommitMessage',
			error: await ctx.repo.editCommitMessage(msg.repo, msg.commitHash, msg.message, msg.authorName, msg.authorEmail)
		});
	}
};

export const commitFixup: Handler<'commitFixup'> = {
	mutates: MUTATING_COMMANDS.commitFixup,
	async handle(msg, ctx) {
		ctx.send({ command: 'commitFixup', error: await ctx.repo.createFixupCommit(msg.repo, msg.commitHash) });
	}
};

export const commitSquash: Handler<'commitSquash'> = {
	mutates: MUTATING_COMMANDS.commitSquash,
	async handle(msg, ctx) {
		ctx.send({ command: 'commitSquash', error: await ctx.repo.createSquashCommit(msg.repo, msg.commitHash) });
	}
};

export const resetToCommit: Handler<'resetToCommit'> = {
	mutates: MUTATING_COMMANDS.resetToCommit,
	async handle(msg, ctx) {
		const resetResult = await ctx.repo.resetToCommit(msg.repo, msg.commit, msg.resetMode, msg.confirmed === true);
		if (sendLossWarning(resetResult, msg, ctx)) return;
		ctx.send({ command: 'resetToCommit', error: <ErrorInfo>resetResult });
	}
};

export const resetFileToRevision: Handler<'resetFileToRevision'> = {
	mutates: MUTATING_COMMANDS.resetFileToRevision,
	async handle(msg, ctx) {
		ctx.send({
			command: 'resetFileToRevision',
			error: await ctx.repo.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath)
		});
	}
};

import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { Handler } from './context';

/** File and diff handlers: opening files/diffs and the clipboard. */

export const copyFilePath: Handler<'copyFilePath'> = {
	mutates: MUTATING_COMMANDS.copyFilePath,
	async handle(msg, ctx) {
		ctx.send({
			command: 'copyFilePath',
			error: await ctx.ui.copyFilePathToClipboard(msg.repo, msg.filePath, msg.absolute)
		});
	}
};

export const copyToClipboard: Handler<'copyToClipboard'> = {
	mutates: MUTATING_COMMANDS.copyToClipboard,
	async handle(msg, ctx) {
		ctx.send({ command: 'copyToClipboard', type: msg.type, error: await ctx.ui.copyToClipboard(msg.data) });
	}
};

export const viewDiff: Handler<'viewDiff'> = {
	mutates: MUTATING_COMMANDS.viewDiff,
	async handle(msg, ctx) {
		ctx.send({
			command: 'viewDiff',
			error: await ctx.ui.viewDiff(msg.repo, msg.fromHash, msg.toHash, msg.oldFilePath, msg.newFilePath, msg.type)
		});
	}
};

export const viewDiffWithWorkingFile: Handler<'viewDiffWithWorkingFile'> = {
	mutates: MUTATING_COMMANDS.viewDiffWithWorkingFile,
	async handle(msg, ctx) {
		ctx.send({
			command: 'viewDiffWithWorkingFile',
			error: await ctx.ui.viewDiffWithWorkingFile(msg.repo, msg.hash, msg.filePath)
		});
	}
};

export const viewFileAtRevision: Handler<'viewFileAtRevision'> = {
	mutates: MUTATING_COMMANDS.viewFileAtRevision,
	async handle(msg, ctx) {
		ctx.send({
			command: 'viewFileAtRevision',
			error: await ctx.ui.viewFileAtRevision(msg.repo, msg.hash, msg.filePath)
		});
	}
};

export const openFile: Handler<'openFile'> = {
	mutates: MUTATING_COMMANDS.openFile,
	async handle(msg, ctx) {
		ctx.send({
			command: 'openFile',
			error: await ctx.ui.openFile(msg.repo, msg.filePath, msg.hash)
		});
	}
};

export const openExternalDirDiff: Handler<'openExternalDirDiff'> = {
	mutates: MUTATING_COMMANDS.openExternalDirDiff,
	async handle(msg, ctx) {
		ctx.send({
			command: 'openExternalDirDiff',
			error: await ctx.repo.openExternalDirDiff(msg.repo, msg.fromHash, msg.toHash, msg.isGui)
		});
	}
};

export const createArchive: Handler<'createArchive'> = {
	mutates: MUTATING_COMMANDS.createArchive,
	async handle(msg, ctx) {
		ctx.send({
			command: 'createArchive',
			error: await ctx.ui.createArchive(msg.repo, msg.ref)
		});
	}
};

export const openCompareTab: Handler<'openCompareTab'> = {
	mutates: MUTATING_COMMANDS.openCompareTab,
	handle(msg, ctx) {
		ctx.ui.openCompareTab(msg.repo, msg.fromHash, msg.toHash, msg.singleCommit);
	}
};

export const viewDiffBinary: Handler<'viewDiffBinary'> = {
	mutates: MUTATING_COMMANDS.viewDiffBinary,
	handle(msg, ctx) {
		// The native Diff View can't show a binary/image file (both panes would be empty): the
		// same standalone tab the Commit Comparison View opens for one does (via the ui port).
		ctx.ui.viewDiffBinary(msg.repo, msg.fromHash, msg.toHash, msg.oldFilePath, msg.newFilePath, msg.type);
	}
};

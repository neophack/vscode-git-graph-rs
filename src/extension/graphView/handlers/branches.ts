import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { ErrorInfo } from '../../../types';
import { sendLossWarning } from './context';
import type { Handler } from './context';
import * as flows from '../writeFlows';

/** Branch handlers: checkout, create, delete, rename, and the remote-tracking ref writes. */

export const checkoutBranch: Handler<'checkoutBranch'> = {
	mutates: MUTATING_COMMANDS.checkoutBranch,
	async handle(msg, ctx) {
		const checkoutResult = await flows.checkoutBranch(ctx, msg.repo, msg.branchName, msg.remoteBranch, msg.confirmed === true);
		if (sendLossWarning(checkoutResult, msg, ctx)) return;
		const errorInfos: ErrorInfo[] = [<ErrorInfo>checkoutResult];
		if (errorInfos[0] === null && msg.pullAfterwards !== null) {
			errorInfos.push(await flows.pullBranch(ctx, msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash));
		}
		ctx.send({
			command: 'checkoutBranch',
			pullAfterwards: msg.pullAfterwards,
			errors: errorInfos
		});
	}
};

export const createBranch: Handler<'createBranch'> = {
	mutates: MUTATING_COMMANDS.createBranch,
	async handle(msg, ctx) {
		const createResult = await flows.createBranch(ctx, msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force, msg.confirmed === true);
		if (sendLossWarning(createResult, msg, ctx)) return;
		ctx.send({ command: 'createBranch', errors: <ErrorInfo[]>createResult });
	}
};

export const deleteBranch: Handler<'deleteBranch'> = {
	mutates: MUTATING_COMMANDS.deleteBranch,
	async handle(msg, ctx) {
		const errorInfos: ErrorInfo[] = [await flows.deleteBranch(ctx, msg.repo, msg.branchName, msg.forceDelete)];
		if (errorInfos[0] === null) {
			for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
				errorInfos.push(await flows.deleteRemoteBranch(ctx, msg.repo, msg.branchName, msg.deleteOnRemotes[i]));
			}
		}
		ctx.send({
			command: 'deleteBranch',
			repo: msg.repo,
			branchName: msg.branchName,
			deleteOnRemotes: msg.deleteOnRemotes,
			errors: errorInfos
		});
	}
};

export const renameBranch: Handler<'renameBranch'> = {
	mutates: MUTATING_COMMANDS.renameBranch,
	async handle(msg, ctx) {
		ctx.send({
			command: 'renameBranch',
			error: await flows.renameBranch(ctx, msg.repo, msg.oldName, msg.newName)
		});
	}
};

export const fetchIntoLocalBranch: Handler<'fetchIntoLocalBranch'> = {
	mutates: MUTATING_COMMANDS.fetchIntoLocalBranch,
	async handle(msg, ctx) {
		ctx.send({
			command: 'fetchIntoLocalBranch',
			error: await flows.fetchIntoLocalBranch(ctx, msg.repo, msg.remote, msg.remoteBranch, msg.localBranch, msg.force)
		});
	}
};

export const deleteRemoteBranch: Handler<'deleteRemoteBranch'> = {
	mutates: MUTATING_COMMANDS.deleteRemoteBranch,
	async handle(msg, ctx) {
		ctx.send({
			command: 'deleteRemoteBranch',
			error: await flows.deleteRemoteBranch(ctx, msg.repo, msg.branchName, msg.remote)
		});
	}
};

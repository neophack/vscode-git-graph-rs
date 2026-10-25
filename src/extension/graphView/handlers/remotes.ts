import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { ErrorInfo } from '../../../types';
import { sendLossWarning } from './context';
import type { Handler } from './context';
import * as flows from '../writeFlows';

/** Remote handlers: remotes CRUD, fetch/pull/push, and the in-progress merge/rebase operations. */

export const addRemote: Handler<'addRemote'> = {
	mutates: MUTATING_COMMANDS.addRemote,
	async handle(msg, ctx) {
		ctx.send({
			command: 'addRemote',
			error: await flows.addRemote(ctx, msg.repo, msg.name, msg.url, msg.pushUrl, msg.fetch)
		});
	}
};

export const deleteRemote: Handler<'deleteRemote'> = {
	mutates: MUTATING_COMMANDS.deleteRemote,
	async handle(msg, ctx) {
		ctx.send({ command: 'deleteRemote', error: await flows.deleteRemote(ctx, msg.repo, msg.name) });
	}
};

export const editRemote: Handler<'editRemote'> = {
	mutates: MUTATING_COMMANDS.editRemote,
	async handle(msg, ctx) {
		ctx.send({
			command: 'editRemote',
			error: await flows.editRemote(ctx, msg.repo, msg.nameOld, msg.nameNew, msg.urlOld, msg.urlNew, msg.pushUrlOld, msg.pushUrlNew)
		});
	}
};

export const fetch: Handler<'fetch'> = {
	mutates: MUTATING_COMMANDS.fetch,
	async handle(msg, ctx) {
		const fetchError = await flows.fetch(ctx, msg.repo, msg.name, msg.prune, msg.pruneTags);
		// A plain fetch may update the change refs of the configured fetch refspecs: the cached
		// Gerrit data of this repository must be re-derived from the remote on the next load
		if (fetchError === null) ctx.loader.markGerritStale(msg.repo);
		ctx.send({ command: 'fetch', error: fetchError });
	}
};

export const pruneRemote: Handler<'pruneRemote'> = {
	mutates: MUTATING_COMMANDS.pruneRemote,
	async handle(msg, ctx) {
		ctx.send({ command: 'pruneRemote', error: await flows.pruneRemote(ctx, msg.repo, msg.name) });
	}
};

export const pullBranch: Handler<'pullBranch'> = {
	mutates: MUTATING_COMMANDS.pullBranch,
	async handle(msg, ctx) {
		ctx.send({
			command: 'pullBranch',
			error: await flows.pullBranch(ctx, msg.repo, msg.branchName, msg.remote, msg.createNewCommit, msg.squash)
		});
	}
};

export const pushBranch: Handler<'pushBranch'> = {
	mutates: MUTATING_COMMANDS.pushBranch,
	async handle(msg, ctx) {
		const pushResult = await flows.pushBranchToMultipleRemotes(ctx, msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode, msg.confirmed === true);
		if (sendLossWarning(pushResult, msg, ctx)) return;
		ctx.send({
			command: 'pushBranch',
			willUpdateBranchConfig: msg.willUpdateBranchConfig,
			errors: <ErrorInfo[]>pushResult
		});
	}
};

import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import type { Handler } from './context';

/** Everything that fits no other domain: SCM/terminal/URL surfaces and the repository list. */

export const viewScm: Handler<'viewScm'> = {
	mutates: MUTATING_COMMANDS.viewScm,
	async handle(_msg, ctx) {
		ctx.send({ command: 'viewScm', error: await ctx.ui.viewScm() });
	}
};

export const openTerminal: Handler<'openTerminal'> = {
	mutates: MUTATING_COMMANDS.openTerminal,
	async handle(msg, ctx) {
		ctx.send({
			command: 'openTerminal',
			error: await ctx.ui.openGitTerminal(msg.repo, null, msg.name)
		});
	}
};

export const openExternalUrl: Handler<'openExternalUrl'> = {
	mutates: MUTATING_COMMANDS.openExternalUrl,
	async handle(msg, ctx) {
		ctx.send({ command: 'openExternalUrl', error: await ctx.ui.openExternalUrl(msg.url) });
	}
};

export const showErrorMessage: Handler<'showErrorMessage'> = {
	mutates: MUTATING_COMMANDS.showErrorMessage,
	handle(msg, ctx) {
		ctx.ui.showErrorMessage(msg.message);
	}
};

export const loadRepos: Handler<'loadRepos'> = {
	mutates: MUTATING_COMMANDS.loadRepos,
	async handle(msg, ctx) {
		if (!msg.check || !await ctx.repos.checkReposExist()) {
			// If not required to check repos, or no changes were found when checking, respond with repos
			ctx.send({
				command: 'loadRepos',
				repos: ctx.repos.getRepos(),
				lastActiveRepo: ctx.storage.getLastActiveRepo(),
				loadViewTo: null
			});
		}
	}
};

export const rescanForRepos: Handler<'rescanForRepos'> = {
	mutates: MUTATING_COMMANDS.rescanForRepos,
	handle: (_msg, ctx) => ctx.repos.rescanForRepos()
};

export const exportRepoConfig: Handler<'exportRepoConfig'> = {
	mutates: MUTATING_COMMANDS.exportRepoConfig,
	async handle(msg, ctx) {
		ctx.send({
			command: 'exportRepoConfig',
			error: await ctx.repos.exportRepoConfig(msg.repo)
		});
	}
};

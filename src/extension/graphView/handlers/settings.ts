import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import { GitConfigLocation } from '../../../shared/model/git';
import type { ErrorInfo } from '../../../shared/protocol/messages';
import type { Handler } from './context';

/** Settings and persisted-state handlers. */

export const setInterfaceLanguage: Handler<'setInterfaceLanguage'> = {
	mutates: MUTATING_COMMANDS.setInterfaceLanguage,
	async handle(msg, ctx) {
		ctx.send({
			command: 'setInterfaceLanguage',
			error: await ctx.ui.setInterfaceLanguage(msg.language)
		});
	}
};

export const setGlobalSetting: Handler<'setGlobalSetting'> = {
	mutates: MUTATING_COMMANDS.setGlobalSetting,
	async handle(msg, ctx) {
		// The response leaves only after the save finished - for 'commitAuthors' that
		// includes the global Git configuration writes (defaulting or clearing the
		// global author). The flag tells the webview to reload the repository
		// configuration from that post-save state: a reload issued next to the save
		// races those writes and renders the pre-save global author in the Settings
		// Widget's "Use Global Author" row.
		ctx.send({
			command: 'setGlobalSetting',
			setting: msg.setting,
			authorConfigTouched: msg.setting === 'commitAuthors',
			error: await ctx.settings.setGlobalSetting(msg.setting, msg.value, msg.previousValue)
		});
	}
};

export const openExtensionSettings: Handler<'openExtensionSettings'> = {
	mutates: MUTATING_COMMANDS.openExtensionSettings,
	async handle(_msg, ctx) {
		ctx.send({ command: 'openExtensionSettings', error: await ctx.ui.openExtensionSettings() });
	}
};

export const openLogFile: Handler<'openLogFile'> = {
	mutates: MUTATING_COMMANDS.openLogFile,
	async handle(_msg, ctx) {
		ctx.send({ command: 'openLogFile', error: await ctx.ui.openLogFile() });
	}
};

export const deleteUserDetails: Handler<'deleteUserDetails'> = {
	mutates: MUTATING_COMMANDS.deleteUserDetails,
	async handle(msg, ctx) {
		const errorInfos: ErrorInfo[] = [];
		if (msg.name) {
			errorInfos.push(await ctx.userConfig.unsetUserName(msg.repo, msg.location));
		}
		if (msg.email) {
			errorInfos.push(await ctx.userConfig.unsetUserEmail(msg.repo, msg.location));
		}
		// A Global location write never touches the repository's `.git/config`, so the
		// watcher-based cache invalidation cannot fire for it: drop the cached config data
		// explicitly, so the settings widget re-render reflects the change immediately
		ctx.userConfig.invalidateConfig(msg.repo);
		ctx.send({
			command: 'deleteUserDetails',
			errors: errorInfos
		});
	}
};

export const editUserDetails: Handler<'editUserDetails'> = {
	mutates: MUTATING_COMMANDS.editUserDetails,
	async handle(msg, ctx) {
		const errorInfos: ErrorInfo[] = [
			await ctx.userConfig.setUserName(msg.repo, msg.name, msg.location),
			await ctx.userConfig.setUserEmail(msg.repo, msg.email, msg.location)
		];
		if (errorInfos[0] === null && errorInfos[1] === null) {
			if (msg.deleteLocalName) {
				errorInfos.push(await ctx.userConfig.unsetUserName(msg.repo, GitConfigLocation.Local));
			}
			if (msg.deleteLocalEmail) {
				errorInfos.push(await ctx.userConfig.unsetUserEmail(msg.repo, GitConfigLocation.Local));
			}
		}
		// A Global location write never touches the repository's `.git/config`, so the
		// watcher-based cache invalidation cannot fire for it: drop the cached config data
		// explicitly, so the settings widget re-render reflects the change immediately
		ctx.userConfig.invalidateConfig(msg.repo);
		ctx.send({
			command: 'editUserDetails',
			errors: errorInfos
		});
	}
};

export const setGlobalViewState: Handler<'setGlobalViewState'> = {
	mutates: MUTATING_COMMANDS.setGlobalViewState,
	async handle(msg, ctx) {
		ctx.send({
			command: 'setGlobalViewState',
			error: await ctx.storage.setGlobalViewState(msg.state)
		});
	}
};

export const setWorkspaceViewState: Handler<'setWorkspaceViewState'> = {
	mutates: MUTATING_COMMANDS.setWorkspaceViewState,
	async handle(msg, ctx) {
		ctx.send({
			command: 'setWorkspaceViewState',
			error: await ctx.storage.setWorkspaceViewState(msg.state)
		});
	}
};

export const setViewSnapshot: Handler<'setViewSnapshot'> = {
	mutates: MUTATING_COMMANDS.setViewSnapshot,
	handle(msg, ctx) {
		ctx.storage.setViewSnapshot(msg.snapshot);
	}
};

export const setRepoState: Handler<'setRepoState'> = {
	mutates: MUTATING_COMMANDS.setRepoState,
	handle(msg, ctx) {
		ctx.repos.setRepoState(msg.repo, msg.state);
	}
};

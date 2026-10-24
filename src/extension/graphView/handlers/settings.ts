import { MUTATING_COMMANDS } from '../../../shared/protocol/graphView';
import { notWired } from './context';
import type { Handler } from './context';

/** Settings and persisted-state handlers (several await the storage/config ports of 4.4/4.5). */

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
	handle: () => notWired('setGlobalSetting needs the writable-settings validators and the global-author side effects of GitGraphView, which move to platform/config in task 4.5')
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
	handle: () => notWired('deleteUserDetails writes git config through the GitConfigKey enum, which lives in dataSource.ts until the git layer split (Phase 3) makes it importable without pulling vscode into the handler tests')
};

export const editUserDetails: Handler<'editUserDetails'> = {
	mutates: MUTATING_COMMANDS.editUserDetails,
	handle: () => notWired('editUserDetails writes git config through the GitConfigKey enum, which lives in dataSource.ts until the git layer split (Phase 3) makes it importable without pulling vscode into the handler tests')
};

export const setGlobalViewState: Handler<'setGlobalViewState'> = {
	mutates: MUTATING_COMMANDS.setGlobalViewState,
	handle: () => notWired('setGlobalViewState persists through ExtensionState, which is not a context port yet (platform/storage)')
};

export const setWorkspaceViewState: Handler<'setWorkspaceViewState'> = {
	mutates: MUTATING_COMMANDS.setWorkspaceViewState,
	handle: () => notWired('setWorkspaceViewState persists through ExtensionState, which is not a context port yet (platform/storage)')
};

export const setViewSnapshot: Handler<'setViewSnapshot'> = {
	mutates: MUTATING_COMMANDS.setViewSnapshot,
	handle: () => notWired('setViewSnapshot persists through ExtensionState, which is not a context port yet (platform/storage)')
};

export const setRepoState: Handler<'setRepoState'> = {
	mutates: MUTATING_COMMANDS.setRepoState,
	handle: () => notWired('setRepoState persists through RepoManager, which is not a context port yet (extension/repos)')
};

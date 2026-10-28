import * as vscode from 'vscode';
import { CONFIG_SECTION } from './snapshot';

/**
 * The write side of the configuration model: updating one of the extension's own Global (User)
 * settings. The settings-page save flow (graphView/globalSettings) and the interface-language
 * switch route through here, so those modules stay vscode-free while the write (section, target
 * scope) is decided once.
 */

/**
 * Update a `git-graph-rs.*` setting in the Global (User) configuration.
 * @param key The setting key, relative to the section.
 * @param value The new value.
 * @returns A Thenable that rejects when Visual Studio Code refuses the write.
 */
export function updateGlobalConfigValue(key: string, value: unknown): Thenable<void> {
	return vscode.workspace.getConfiguration(CONFIG_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

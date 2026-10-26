import * as os from 'os';
import * as vscode from 'vscode';
import { t } from '../../i18n';
import { DiffDocProvider, decodeDiffDocUri } from '../views/diffDocProvider';
import { copyToClipboard, openFile as openFileInEditor, showErrorMessage, showInformationMessage, uiPort } from '../../utils/actions';
import { UiPort } from '../../extension/platform/uiPort';
import { getExtensionVersion } from '../../utils/format';
import type { CommandHost } from './context';

/**
 * The standalone utility commands: the extension's `version` information, `clearAvatarCache`
 * and `openFile` (opening the working-tree file behind a Git Graph diff view).
 */

/**
 * The method run when the `git-graph-rs.version` command is invoked.
 * @param host The services the command runs with.
 * @param ui The native-UI port the modal version dialog runs through (task 4.10, INVENTORY.md #3);
 * defaults to the production port, injectable for tests.
 */
export async function version(host: CommandHost, ui: UiPort = uiPort) {
	try {
		const gitGraphVersion = await getExtensionVersion(host.context);
		const information = t('versionInfo', gitGraphVersion, vscode.version, os.type() + ' ' + os.arch() + ' ' + os.release(), host.gitExecutable !== null ? host.gitExecutable.version : '(none)');
		ui.showInformationMessage(information, { modal: true }, t('copyButton')).then((selectedItem) => {
			if (selectedItem === t('copyButton')) {
				copyToClipboard(information).then((result) => {
					if (result !== null) {
						showErrorMessage(result);
					}
				});
			}
		}, () => { });
	} catch (_) {
		showErrorMessage(t('versionInfoError'));
	}
}

/**
 * The method run when the `git-graph-rs.clearAvatarCache` command is invoked.
 * @param host The services the command runs with.
 */
export function clearAvatarCache(host: CommandHost) {
	host.avatarManager.clearCache().then((errorInfo) => {
		if (errorInfo === null) {
			showInformationMessage(t('avatarCacheCleared'));
		} else {
			showErrorMessage(errorInfo);
		}
	}, () => {
		showErrorMessage(t('unexpectedErrorInCommand', 'Clear Avatar Cache'));
	});
}

/**
 * Opens a file in Visual Studio Code, based on a Git Graph URI (from the Diff View).
 * The method run when the `git-graph-rs.openFile` command is invoked.
 * @param host The services the command runs with.
 * @param arg The Git Graph URI.
 */
export function openFile(host: CommandHost, arg?: unknown) {
	const uri = (arg || vscode.window.activeTextEditor?.document.uri) as vscode.Uri | undefined;
	if (typeof uri === 'object' && uri && uri.scheme === DiffDocProvider.scheme) {
		// A Git Graph URI has been provided
		const request = decodeDiffDocUri(uri);
		return openFileInEditor(request.repo, request.filePath, request.commit, host.repo.read, vscode.ViewColumn.Active).then((errorInfo) => {
			return errorInfo !== null ? showErrorMessage(t('unableToOpenFile', errorInfo)) : undefined;
		});
	} else {
		return showErrorMessage(t('openFileMissingArgs'));
	}
}

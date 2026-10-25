import * as vscode from 'vscode';
import { t } from '../../i18n';
import { showErrorMessage, showInformationMessage, uiPort } from '../../utils/actions';
import { QuickPickItemLike, UiPort } from '../../extension/platform/uiPort';
import { getPathFromUri, getRepoName, isPathInWorkspace } from '../../utils/paths';
import { getSortedRepositoryPaths } from '../../utils/repo';
import { unableToFindGitMsg } from '../../utils/findGit';
import { getConfig } from '../../config';
import type { CommandHost } from './context';

/**
 * The commands managing the extension's list of known repositories:
 * `addGitRepository` adds a folder to it, `removeGitRepository` removes one from it.
 */

/**
 * The method run when the `git-graph-rs.addGitRepository` command is invoked.
 * @param host The services the command runs with.
 * @param ui The native-UI port the folder picker runs through (task 4.10, INVENTORY.md #24);
 * defaults to the production port, injectable for tests.
 */
export function addGitRepository(host: CommandHost, ui: UiPort = uiPort) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg());
		return;
	}

	ui.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }).then(uris => {
		if (uris && uris.length > 0) {
			// The dialog answers the port's Uri shape (a vscode.Uri in production, a fake in tests).
			let path = getPathFromUri(uris[0] as vscode.Uri);
			if (isPathInWorkspace(path)) {
				host.repoManager.registerRepo(path, false).then(status => {
					if (status.error === null) {
						showInformationMessage(t('repoAdded', status.root!));
					} else {
						showErrorMessage(t('repoAddFailed', status.error));
					}
				});
			} else {
				showErrorMessage(t('folderNotInWorkspace', path));
			}
		}
	}, () => { });
}

/**
 * The method run when the `git-graph-rs.removeGitRepository` command is invoked.
 * @param host The services the command runs with.
 * @param ui The native-UI port the repository picker runs through (task 4.10, INVENTORY.md #19);
 * defaults to the production port, injectable for tests.
 */
export function removeGitRepository(host: CommandHost, ui: UiPort = uiPort) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg());
		return;
	}

	const repos = host.repoManager.getRepos();
	const items: QuickPickItemLike[] = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder).map((path) => ({
		label: repos[path].name || getRepoName(path),
		description: path
	}));

	ui.showQuickPick(items, {
		placeHolder: t('selectRepoToRemove'),
		canPickMany: false
	}).then((item) => {
		if (item && item.description !== undefined) {
			if (host.repoManager.ignoreRepo(item.description)) {
				showInformationMessage(t('repoRemoved', item.label));
			} else {
				showErrorMessage(t('repoNotKnown', item.label));
			}
		}
	}, () => { });
}

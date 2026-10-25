import * as vscode from 'vscode';
import { t } from '../../i18n';
import { showErrorMessage, showInformationMessage } from '../../utils/actions';
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
 */
export function addGitRepository(host: CommandHost) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg());
		return;
	}

	vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }).then(uris => {
		if (uris && uris.length > 0) {
			let path = getPathFromUri(uris[0]);
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
 */
export function removeGitRepository(host: CommandHost) {
	if (host.gitExecutable === null) {
		showErrorMessage(unableToFindGitMsg());
		return;
	}

	const repos = host.repoManager.getRepos();
	const items: vscode.QuickPickItem[] = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder).map((path) => ({
		label: repos[path].name || getRepoName(path),
		description: path
	}));

	vscode.window.showQuickPick(items, {
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

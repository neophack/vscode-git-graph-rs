import * as path from 'path';
import * as vscode from 'vscode';
import { GitGraphView } from '../graphView/panel';
import { t } from '../../i18n';
import { getConfig } from '../platform/config';
import { showErrorMessage, uiPort } from '../../utils/actions';
import { UiPort } from '../../extension/platform/uiPort';
import { getRepoName, getPathFromStr, getPathFromUri, resolveToSymbolicPath } from '../../utils/paths';
import { getSortedRepositoryPaths } from '../../utils/repo';
import { isRepoCommandArg, type CommandHost } from './context';

/**
 * The commands that open (or re-focus) the Git Graph view: `view` and `fetch` select a
 * repository and show the view on it, `filterByFile` shows it filtered to one file's history.
 */

/**
 * The method run when the `git-graph-rs.view` command is invoked.
 * @param host The services the command runs with.
 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Git Extension).
 */
export async function view(host: CommandHost, arg: unknown) {
	let loadRepo: string | null = null;

	if (isRepoCommandArg(arg)) {
		// If command is run from the Visual Studio Code Source Control View, load the specific repo
		const repoPath = getPathFromUri(arg.rootUri);
		loadRepo = await host.repoManager.getKnownRepo(repoPath);
		if (loadRepo === null) {
			// The repo is not currently known, add it
			loadRepo = (await host.repoManager.registerRepo(await resolveToSymbolicPath(repoPath), true)).root;
		}
	} else if (getConfig().openToTheRepoOfTheActiveTextEditorDocument && vscode.window.activeTextEditor) {
		// If the config setting is enabled, load the repo containing the active text editor document
		loadRepo = host.repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
	}

	GitGraphView.createOrShow(host.context.extensionPath, host.repo, host.gitRunner, host.legacyViews, host.extensionState, host.avatarManager, host.repoManager, host.logger, loadRepo !== null ? { repo: loadRepo } : null);
}

/**
 * The method run when the `git-graph-rs.filterByFile` command is invoked.
 * Opens the Git Graph view filtered to only show commits that modified the specified file.
 * In VS Code the command stays single-file: when the explorer passes a multi-selection,
 * only the first entry is used (multi-file filtering is a Git Graph Studio extension).
 * @param host The services the command runs with.
 * @param arg The argument passed to the command (file URIs, or objects containing file URIs).
 */
export async function filterByFile(host: CommandHost, arg: unknown) {
	const uris = getUrisFromCommandArg(arg);
	if (uris.length === 0) {
		showErrorMessage(t('filterByFileUndetermined'));
		return;
	}

	const repo = host.repoManager.getRepoContainingFile(getPathFromUri(uris[0]));
	if (repo === null) {
		showErrorMessage(t('filterByFileNotInRepo', getPathFromUri(uris[0])));
		return;
	}

	// Compute the path of the file relative to the repository root (using forward slashes, as		// expected by git)
	let filterPath = getPathFromStr(path.relative(repo, getPathFromUri(uris[0])));
	if (filterPath === '') filterPath = '.';

	GitGraphView.createOrShow(host.context.extensionPath, host.repo, host.gitRunner, host.legacyViews, host.extensionState, host.avatarManager, host.repoManager, host.logger, { repo: repo, filterPath: filterPath });
}

/**
 * Extract file URIs from a command argument (URIs, or objects containing URIs). When multiple
 * items are selected in the explorer, VS Code passes an array of them.
 * @param arg The argument passed to the command.
 * @returns The file URIs (empty if none could be determined).
 */
function getUrisFromCommandArg(arg: unknown): vscode.Uri[] {
	const args = Array.isArray(arg) ? arg : [arg];
	const uris: vscode.Uri[] = [];
	for (const a of args) {
		if (a && typeof a === 'object') {
			const holder = a as { resourceUri?: vscode.Uri, uri?: vscode.Uri, scheme?: string, fsPath?: string };
			if (holder.resourceUri) uris.push(holder.resourceUri); // e.g. a SourceControlResourceState
			else if (holder.uri && holder.uri.scheme) uris.push(holder.uri);
			else if (holder.scheme && holder.fsPath) uris.push(a as vscode.Uri); // a URI
		}
	}
	if (uris.length === 0 && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
		uris.push(vscode.window.activeTextEditor.document.uri);
	}
	return uris;
}

/**
 * The method run when the `git-graph-rs.fetch` command is invoked.
 * @param host The services the command runs with.
 * @param ui The native-UI port the repository picker runs through (task 4.10, INVENTORY.md #20);
 * defaults to the production port, injectable for tests.
 */
export function fetch(host: CommandHost, ui: UiPort = uiPort) {
	const repos = host.repoManager.getRepos();
	const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder);

	if (repoPaths.length > 1) {
		const items: vscode.QuickPickItem[] = repoPaths.map((path) => ({
			label: repos[path].name || getRepoName(path),
			description: path
		}));

		const lastActiveRepo = host.extensionState.getLastActiveRepo();
		if (lastActiveRepo !== null) {
			let lastActiveRepoIndex = items.findIndex((item) => item.description === lastActiveRepo);
			if (lastActiveRepoIndex > -1) {
				const item = items.splice(lastActiveRepoIndex, 1)[0];
				items.unshift(item);
			}
		}

		ui.showQuickPick(items, {
			placeHolder: t('selectRepoToFetch'),
			canPickMany: false
		}).then((item) => {
			if (item && item.description) {
				GitGraphView.createOrShow(host.context.extensionPath, host.repo, host.gitRunner, host.legacyViews, host.extensionState, host.avatarManager, host.repoManager, host.logger, {
					repo: item.description,
					runCommandOnLoad: 'fetch'
				});
			}
		}, () => {
			showErrorMessage(t('unexpectedErrorInCommand', 'Fetch from Remote(s)'));
		});
	} else if (repoPaths.length === 1) {
		GitGraphView.createOrShow(host.context.extensionPath, host.repo, host.gitRunner, host.legacyViews, host.extensionState, host.avatarManager, host.repoManager, host.logger, {
			repo: repoPaths[0],
			runCommandOnLoad: 'fetch'
		});
	} else {
		GitGraphView.createOrShow(host.context.extensionPath, host.repo, host.gitRunner, host.legacyViews, host.extensionState, host.avatarManager, host.repoManager, host.logger, null);
	}
}

import * as vscode from 'vscode';
import { AvatarManager } from '../../avatarManager';
import type { GerritDataSource } from '../integrations/gerrit/gerrit';
import type { GitRunnerPort, LegacyViewPort } from '../graphView/gitRunner';
import type { ProductionGitRepository } from '../git/gitRepository';
import { ExtensionState } from '../../extensionState';
import { Logger } from '../../logger';
import { RepoManager } from '../../repoManager';
import { t } from '../../i18n';
import { getConfig } from '../../config';
import { GitExecutable } from '../../utils/findGit';
import { getSortedRepositoryPaths } from '../../utils/repo';
import { getPathFromUri, getRepoName } from '../../utils/paths';

/**
 * The collaborators a command handler runs with (task 4.6): the same services the
 * `CommandManager` was constructed with, passed to the per-group handler modules so each
 * command group is a standalone unit. The Git executable is mutable: it updates through the
 * `onDidChangeGitExecutable` event the manager subscribes to, and handlers read the current
 * value at invocation time.
 */
export interface CommandHost {
	readonly context: vscode.ExtensionContext;
	readonly avatarManager: AvatarManager;
	/** The repository facade: reads on `.read`, writes through the GitWriter (task 3.6). */
	readonly repo: ProductionGitRepository;
	/** The view's raw git runner (editor-script flows the ops do not model). */
	readonly gitRunner: GitRunnerPort;
	/** The Gerrit integration over the same runner (the `gerritPushRef` command's hook flow). */
	readonly gerrit: GerritDataSource;
	/** The auxiliary views the panel hands off to (comparison, binary compare, diff doc). */
	readonly legacyViews: LegacyViewPort;
	readonly extensionState: ExtensionState;
	readonly logger: Logger;
	readonly repoManager: RepoManager;
	/** The Git executable currently available to the extension (NULL until one is found). */
	gitExecutable: GitExecutable | null;
}

/** Whether a value is a plain record (for narrowing untyped command arguments). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Whether a value duck-types as a `vscode.Uri` (scheme and fsPath strings). */
function isUri(value: unknown): value is vscode.Uri {
	return isRecord(value) && typeof value.scheme === 'string' && typeof value.fsPath === 'string';
}

/** The argument the Source Control view passes to a command: the repository root URI. */
export interface RepoCommandArg {
	readonly rootUri: vscode.Uri;
}

/**
 * Whether a command argument is the Source Control view's repository argument.
 * @param arg The argument passed to the command.
 */
export function isRepoCommandArg(arg: unknown): arg is RepoCommandArg {
	return isRecord(arg) && isUri(arg.rootUri);
}

/**
 * Resolve the repository a command should operate on.
 * Prefers a repository provided in the command argument (e.g. from the Source Control view),
 * then the repository containing the active text editor document, and finally asks the user.
 * @param host The services the command runs with.
 * @param arg The argument passed to the command.
 * @returns The repository path, or NULL if it could not be determined or the user cancelled.
 */
export async function resolveRepoFromCommandArg(host: CommandHost, arg: unknown): Promise<string | null> {
	if (isRepoCommandArg(arg)) {
		const repoPath = getPathFromUri(arg.rootUri);
		return await host.repoManager.getKnownRepo(repoPath) || host.repoManager.getRepoContainingFile(repoPath);
	}

	if (vscode.window.activeTextEditor) {
		const repo = host.repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
		if (repo !== null) return repo;
	}

	const repos = host.repoManager.getRepos();
	const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder);
	if (repoPaths.length === 0) return null;
	if (repoPaths.length === 1) return repoPaths[0];

	const items: vscode.QuickPickItem[] = repoPaths.map((path) => ({
		label: repos[path].name || getRepoName(path),
		description: path
	}));
	const item = await vscode.window.showQuickPick(items, { canPickMany: false, placeHolder: t('selectRepoForCommand') });
	return item && item.description !== undefined ? item.description : null;
}

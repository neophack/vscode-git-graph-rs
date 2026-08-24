import * as path from 'path';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { hasEngineForPlatform, platformKey } from './backend/addon';
import { CommandManager } from './commands';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider } from './diffDocProvider';
import { ExtensionState } from './extensionState';
import { t } from './i18n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { StatusBarItem } from './statusBarItem';
import { GitExecutable, findGit, getGitExecutableFromPaths, showErrorMessage, showInformationMessage, unableToFindGitMsg } from './utils';
import { EventEmitter } from './utils/event';

/**
 * Activate Git Graph.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	const logger = new Logger(path.join(context.globalStoragePath, 'git-graph-rs.log'));
	logger.setEnabled(getConfig().enableLog);
	logger.log('Starting Git Graph ...');

	// No engine binary for this platform is not an error: everything runs over the `git` CLI
	// backend instead, with the full feature set. Say so once, quietly — the Settings widget's
	// backend section is where the per-capability split is shown.
	if (!hasEngineForPlatform(context.extensionPath)) {
		const msg = t('noEngineForPlatform', platformKey());
		showInformationMessage(msg);
		logger.log(msg);
	}

	const gitExecutableEmitter = new EventEmitter<GitExecutable>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;

	const extensionState = new ExtensionState(context, onDidChangeGitExecutable);

	let gitExecutable: GitExecutable | null;
	try {
		gitExecutable = await findGit(extensionState);
		gitExecutableEmitter.emit(gitExecutable);
		logger.log('Using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')');
	} catch (_) {
		gitExecutable = null;
		if (hasEngineForPlatform(context.extensionPath)) {
			// No Git executable, but the engine can serve the whole read path in-process: the
			// extension is usable as-is, and write operations report that they need Git.
			const msg = t('noGitRunsOnEngine');
			showInformationMessage(msg);
			logger.log(msg);
		} else {
			showErrorMessage(unableToFindGitMsg());
			logger.logError(unableToFindGitMsg());
		}
	}

	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;

	const dataSource = new DataSource(gitExecutable, onDidChangeConfiguration, onDidChangeGitExecutable, logger);
	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration, logger);
	const statusBarItem = new StatusBarItem(repoManager.getNumRepos(), repoManager.onDidChangeRepos, onDidChangeConfiguration, logger);
	const commandManager = new CommandManager(context, avatarManager, dataSource, extensionState, repoManager, gitExecutable, onDidChangeGitExecutable, logger);
	const diffDocProvider = new DiffDocProvider(dataSource);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-graph-rs')) {
				logger.setEnabled(getConfig().enableLog);
				configurationEmitter.emit(event);
			} else if (event.affectsConfiguration('git.path')) {
				const paths = getConfig().gitPaths;
				if (paths.length === 0) return;

				getGitExecutableFromPaths(paths).then((gitExecutable) => {
					gitExecutableEmitter.emit(gitExecutable);
					const msg = t('nowUsingGit', gitExecutable.path, gitExecutable.version);
					showInformationMessage(msg);
					logger.log(msg);
					repoManager.searchWorkspaceForRepos();
				}, () => {
					const msg = t('gitPathInvalid', paths.join('", "'), paths.length > 1 ? t('gitPathInvalidContain') : t('gitPathInvalidMatch'));
					showErrorMessage(msg);
					logger.logError(msg);
				});
			}
		}),
		diffDocProvider,
		commandManager,
		statusBarItem,
		repoManager,
		avatarManager,
		dataSource,
		configurationEmitter,
		extensionState,
		gitExecutableEmitter,
		logger
	);
	logger.log('Started Git Graph - Ready to use!');

	extensionState.expireOldCodeReviews();
}

/**
 * Deactivate Git Graph.
 */
export function deactivate() { }

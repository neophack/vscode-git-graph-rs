import * as path from 'path';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { enginePlatformTable, hasEngineForPlatform, platformKey } from './backend/addon';
import { CommandManager } from './commands';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider } from './diffDocProvider';
import { ExtensionState } from './extensionState';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { StatusBarItem } from './statusBarItem';
import { GitExecutable, UNABLE_TO_FIND_GIT_MSG, findGit, getGitExecutableFromPaths, showErrorMessage, showInformationMessage } from './utils';
import { EventEmitter } from './utils/event';

/**
 * Activate Git Graph.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	const logger = new Logger(path.join(context.globalStoragePath, 'git-graph-rs.log'));
	logger.setEnabled(getConfig().enableLog);
	logger.log('Starting Git Graph ...');

	// The extension cannot serve the graph view without a native engine for this platform, which
	// VS Code cannot know at install time (a universal VSIX has no per-architecture restriction).
	// Activation is the first moment the user can be told, so say it here — the Git Graph view
	// itself shows the same information as a page when it is opened.
	if (!hasEngineForPlatform(context.extensionPath)) {
		const zh = getConfig().interfaceLanguage === 'zh-cn';
		const included = enginePlatformTable(context.extensionPath)
			.filter((platform) => platform.present)
			.map((platform) => platform.label)
			.join(zh ? '、' : ', ');
		const msg = zh
			? `Git Graph RS 无法加载图形视图：当前系统架构（${platformKey()}）没有可用的原生引擎。此安装包包含的架构：${included}`
			: `Git Graph RS cannot load the graph view: there is no native engine available for the system architecture this editor is running on (${platformKey()}). Architectures included in this package: ${included}`;
		showErrorMessage(msg);
		logger.logError(msg);
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
		showErrorMessage(UNABLE_TO_FIND_GIT_MSG);
		logger.logError(UNABLE_TO_FIND_GIT_MSG);
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
					const msg = 'Git Graph is now using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')';
					showInformationMessage(msg);
					logger.log(msg);
					repoManager.searchWorkspaceForRepos();
				}, () => {
					const msg = 'The new value of "git.path" ("' + paths.join('", "') + '") does not ' + (paths.length > 1 ? 'contain a string that matches' : 'match') + ' the path and filename of a valid Git executable.';
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

import * as path from 'path';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { hasEngineForPlatform, platformKey } from './backend/addon';
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

	// No engine binary for this platform is not an error: everything runs over the `git` CLI
	// backend instead, with the full feature set. Say so once, quietly — the Settings widget's
	// backend section is where the per-capability split is shown.
	if (!hasEngineForPlatform(context.extensionPath)) {
		const zh = getConfig().interfaceLanguage === 'zh-cn';
		const msg = zh
			? `Git Graph RS：当前系统（${platformKey()}）没有原生引擎，将通过 git 命令行运行（功能完整，读操作为原版速度）。`
			: `Git Graph RS: no native engine is available for this system (${platformKey()}), so it runs over the git CLI instead (full functionality, original-extension read speed).`;
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
			const zh = getConfig().interfaceLanguage === 'zh-cn';
			const msg = zh
				? 'Git Graph RS：未找到 Git，将通过 Rust 引擎运行（查看、比较、搜索等全部可用；写入类操作需要安装 Git）。'
				: 'Git Graph RS: no Git executable was found, so it runs on the Rust engine (viewing, comparing and searching all work; write operations need Git installed).';
			showInformationMessage(msg);
			logger.log(msg);
		} else {
			showErrorMessage(UNABLE_TO_FIND_GIT_MSG);
			logger.logError(UNABLE_TO_FIND_GIT_MSG);
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

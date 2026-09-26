// Visual Studio Code command wrappers: the user-facing actions (diffs, files,
// archives, pull requests, dialogs) shared across the extension host.

import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { DataSource } from '../dataSource';
import { DiffSide, encodeDiffDocUri } from '../diffDocProvider';
import { t } from '../i18n';
import { ErrorInfo, GitFileStatus, PullRequestConfig, PullRequestProvider } from '../types';
import { UNCOMMITTED, abbrevCommit } from './git';
import { doesFileExist } from './paths';

/**
 * Create an archive of a repository at a specific reference, and save to disk.
 * @param repo The path of the repository.
 * @param ref The reference of the revision to archive.
 * @param dataSource The DataSource instance that can be used to create the archive.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function archive(repo: string, ref: string, dataSource: DataSource): Thenable<ErrorInfo> {
	return vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(repo),
		saveLabel: t('archiveSaveLabel'),
		filters: { [t('archiveTarFilter')]: ['tar'], [t('archiveZipFilter')]: ['zip'] }
	}).then(
		(uri) => {
			if (uri) {
				const extension = uri.fsPath.substring(uri.fsPath.lastIndexOf('.') + 1).toLowerCase();
				if (extension === 'tar' || extension === 'zip') {
					return dataSource.archive(repo, ref, uri.fsPath, extension);
				} else {
					return t('archiveInvalidExtension', extension);
				}
			} else {
				return t('archiveNoFileName');
			}
		},
		() => t('archiveNoSaveDialog')
	);
}

/**
 * Copy the path of a file in a repository to the clipboard.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 * @param absolute TRUE => Absolute path, FALSE => Relative path.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function copyFilePathToClipboard(repo: string, filePath: string, absolute: boolean) {
	return copyToClipboard(absolute ? path.join(repo, filePath) : filePath);
}

/**
 * Copy a string to the clipboard.
 * @param text The string.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function copyToClipboard(text: string): Thenable<ErrorInfo> {
	return vscode.env.clipboard.writeText(text).then(
		() => null,
		() => t('clipboardWriteFailed')
	);
}

/**
 * Construct the URL for creating a new Pull Request, and open it in the users default web browser.
 * @param config The Pull Request Provider's Configuration.
 * @param sourceOwner The owner of the repository that is the source of the Pull Request.
 * @param sourceRepo The name of the repository that is the source of the Pull Request.
 * @param sourceBranch The source branch the Pull Request should be created from.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function createPullRequest(config: PullRequestConfig, sourceOwner: string, sourceRepo: string, sourceBranch: string) {
	let templateUrl;
	switch (config.provider) {
		case PullRequestProvider.Bitbucket:
			templateUrl = '$1/$2/$3/pull-requests/new?source=$2/$3::$4&dest=$5/$6::$8';
			break;
		case PullRequestProvider.Custom:
			templateUrl = config.custom.templateUrl;
			break;
		case PullRequestProvider.GitHub:
			templateUrl = '$1/$5/$6/compare/$8...$2:$4';
			break;
		case PullRequestProvider.GitLab:
			templateUrl = '$1/$2/$3/-/merge_requests/new?merge_request[source_branch]=$4&merge_request[target_branch]=$8' +
				(config.destProjectId !== '' ? '&merge_request[target_project_id]=$7' : '');
			break;
	}

	const urlFieldValues = [
		config.hostRootUrl,
		sourceOwner, sourceRepo, sourceBranch,
		config.destOwner, config.destRepo, config.destProjectId, config.destBranch
	];

	const url = templateUrl.replace(/\$([1-8])/g, (_, index) => urlFieldValues[parseInt(index) - 1]);

	return openExternalUrl(url, t('pullRequestUrlType'));
}

/**
 * Open the Visual Studio Code Settings Editor to the Git Graph Extension Settings.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function openExtensionSettings(): Thenable<ErrorInfo> {
	return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:aucneon.git-graph-rs').then(
		() => null,
		() => t('openExtensionSettingsFailed')
	);
}

/**
 * Open an External URL using the default application.
 * @param url The URL for Visual Studio Code to open.
 * @param type The type of URL being opened (defaults to "External URL").
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function openExternalUrl(url: string, type: string = t('externalUrlType')): Thenable<ErrorInfo> {
	const getErrorMessage = () => t('openUrlFailed', type, url);
	try {
		return vscode.env.openExternal(vscode.Uri.parse(url)).then(
			(success) => success ? null : getErrorMessage(),
			getErrorMessage
		);
	} catch (_) {
		return Promise.resolve(getErrorMessage());
	}
}

/**
 * Open a file within a repository in Visual Studio Code.
 * @param repo The repository the file is contained in.
 * @param filePath The relative path of the file within the repository.
 * @param hash An optional commit hash where the file is known to have existed.
 * @param dataSource An optional DataSource instance, that's used to check if the file has been renamed.
 * @param viewColumn An optional ViewColumn that the file should be opened in.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export async function openFile(repo: string, filePath: string, hash: string | null = null, dataSource: DataSource | null = null, viewColumn: vscode.ViewColumn | null = null) {
	let newFilePath = filePath;
	let newAbsoluteFilePath = path.join(repo, newFilePath);
	let fileExists = await doesFileExist(newAbsoluteFilePath);
	if (!fileExists && hash !== null && dataSource !== null) {
		const renamedFilePath = await dataSource.getNewPathOfRenamedFile(repo, hash, filePath);
		if (renamedFilePath !== null) {
			const renamedAbsoluteFilePath = path.join(repo, renamedFilePath);
			if (await doesFileExist(renamedAbsoluteFilePath)) {
				newFilePath = renamedFilePath;
				newAbsoluteFilePath = renamedAbsoluteFilePath;
				fileExists = true;
			}
		}
	}

	if (fileExists) {
		return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(newAbsoluteFilePath), {
			preview: true,
			viewColumn: viewColumn === null ? getConfig().openNewTabEditorGroup : viewColumn
		}).then(
			() => null,
			() => t('openFileFailed', newFilePath)
		);
	} else {
		return t('fileNotInRepo', newFilePath);
	}
}

/**
 * Resolve the actual left-side revision of a diff: UNCOMMITTED means "against HEAD", and a
 * left/right pair that are the same commit means "against that commit's own parent" — the
 * shorthand both the native Diff View and the binary/image comparison views rely on.
 * @param fromHash The nominal revision of the left-side of the Diff View.
 * @param toHash The revision of the right-side of the Diff View.
 * @returns The revision to actually diff from.
 */
export function resolveDiffFromHash(fromHash: string, toHash: string): string {
	if (fromHash === UNCOMMITTED) fromHash = 'HEAD';
	return fromHash === toHash ? fromHash + '^' : fromHash;
}

/**
 * Open the Visual Studio Code Diff View for a specific Git file change.
 * @param repo The repository the file is contained in.
 * @param fromHash The revision of the left-side of the Diff View.
 * @param toHash The revision of the right-side of the Diff View.
 * @param oldFilePath The relative path of the left-side file within the repository.
 * @param newFilePath The relative path of the right-side file within the repository.
 * @param type The Git file status of the change.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewDiff(repo: string, fromHash: string, toHash: string, oldFilePath: string, newFilePath: string, type: GitFileStatus) {
	if (type !== GitFileStatus.Untracked) {
		let abbrevFromHash = abbrevCommit(fromHash), abbrevToHash = toHash !== UNCOMMITTED ? abbrevCommit(toHash) : t('diffTitlePresent'), pathComponents = newFilePath.split('/');
		let desc = fromHash === toHash
			? fromHash === UNCOMMITTED
				? t('diffTitleUncommitted')
				: (type === GitFileStatus.Added ? t('diffTitleAddedIn', abbrevToHash) : type === GitFileStatus.Deleted ? t('diffTitleDeletedIn', abbrevToHash) : t('diffTitleChangedWithParent', abbrevFromHash, abbrevToHash))
			: (type === GitFileStatus.Added ? t('diffTitleAddedBetween', abbrevFromHash, abbrevToHash) : type === GitFileStatus.Deleted ? t('diffTitleDeletedBetween', abbrevFromHash, abbrevToHash) : t('diffTitleChanged', abbrevFromHash, abbrevToHash));
		let title = pathComponents[pathComponents.length - 1] + ' (' + desc + ')';

		return vscode.commands.executeCommand('vscode.diff', encodeDiffDocUri(repo, oldFilePath, resolveDiffFromHash(fromHash, toHash), type, DiffSide.Old), encodeDiffDocUri(repo, newFilePath, toHash, type, DiffSide.New), title, {
			preview: true,
			viewColumn: getConfig().openNewTabEditorGroup
		}).then(
			() => null,
			() => t('diffEditorFailed', newFilePath)
		);
	} else {
		return openFile(repo, newFilePath);
	}
}

/**
 * Open the Visual Studio Code Diff View to display the changes of a file between a commit hash and the working tree.
 * @param repo The repository the file is contained in.
 * @param hash The revision of the left-side of the Diff View.
 * @param filePath The relative path of the file within the repository.
 * @param dataSource A DataSource instance, that's used to check if the file has been renamed.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export async function viewDiffWithWorkingFile(repo: string, hash: string, filePath: string, dataSource: DataSource) {
	let newFilePath = filePath;
	let fileExists = await doesFileExist(path.join(repo, newFilePath));
	if (!fileExists) {
		const renamedFilePath = await dataSource.getNewPathOfRenamedFile(repo, hash, filePath);
		if (renamedFilePath !== null && await doesFileExist(path.join(repo, renamedFilePath))) {
			newFilePath = renamedFilePath;
			fileExists = true;
		}
	}

	const type = fileExists
		? filePath === newFilePath
			? GitFileStatus.Modified
			: GitFileStatus.Renamed
		: GitFileStatus.Deleted;

	return viewDiff(repo, hash, UNCOMMITTED, filePath, newFilePath, type);
}

/**
 * Open a Visual Studio Code Editor (readonly) for a file a specific Git revision.
 * @param repo The repository the file is contained in.
 * @param hash The revision of the file.
 * @param filePath The relative path of the file within the repository.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewFileAtRevision(repo: string, hash: string, filePath: string) {
	const pathComponents = filePath.split('/');
	const title = abbrevCommit(hash) + ': ' + pathComponents[pathComponents.length - 1];

	return vscode.commands.executeCommand('vscode.open', encodeDiffDocUri(repo, filePath, hash, GitFileStatus.Modified, DiffSide.New).with({ path: title }), {
		preview: true,
		viewColumn: getConfig().openNewTabEditorGroup
	}).then(
		() => null,
		() => t('viewFileAtRevisionFailed', filePath, abbrevCommit(hash))
	);
}

/**
 * Open the Visual Studio Code Source Control View.
 * @returns A promise resolving to the ErrorInfo of the executed command.
 */
export function viewScm(): Thenable<ErrorInfo> {
	return vscode.commands.executeCommand('workbench.view.scm').then(
		() => null,
		() => t('openScmFailed')
	);
}

/**
 * Show a Visual Studio Code Information Message Dialog with the specified message.
 * @param message The message to show.
 */
export function showInformationMessage(message: string) {
	return vscode.window.showInformationMessage(message).then(() => { }, () => { });
}

/**
 * Show a Visual Studio Code Error Message Dialog with the specified message.
 * @param message The message to show.
 */
export function showErrorMessage(message: string) {
	return vscode.window.showErrorMessage(message).then(() => { }, () => { });
}

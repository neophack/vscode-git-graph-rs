// Path utilities: normalisation across URI/string forms, workspace membership,
// realpath resolution, and repository naming.

import * as fs from 'fs';
import * as vscode from 'vscode';

const FS_REGEX = /\\/g;

/**
 * Get the normalised path of a URI.
 * @param uri The URI.
 * @returns The normalised path.
 */
export function getPathFromUri(uri: vscode.Uri) {
	return uri.fsPath.replace(FS_REGEX, '/');
}

/**
 * Get the normalised path of a string.
 * @param str The string.
 * @returns The normalised path.
 */
export function getPathFromStr(str: string) {
	return str.replace(FS_REGEX, '/');
}

/**
 * Get the path with a trailing slash.
 * @param path The path.
 * @returns The path with a trailing slash.
 */
export function pathWithTrailingSlash(path: string) {
	return path.endsWith('/') ? path : path + '/';
}

/**
 * Check whether a path is within the current Visual Studio Code Workspace.
 * @param path The path to check.
 * @returns TRUE => Path is in workspace, FALSE => Path isn't in workspace.
 */
export function isPathInWorkspace(path: string) {
	let rootsExact = [], rootsFolder = [], workspaceFolders = vscode.workspace.workspaceFolders;
	if (typeof workspaceFolders !== 'undefined') {
		for (let i = 0; i < workspaceFolders.length; i++) {
			let tmpPath = getPathFromUri(workspaceFolders[i].uri);
			rootsExact.push(tmpPath);
			rootsFolder.push(pathWithTrailingSlash(tmpPath));
		}
	}
	return rootsExact.indexOf(path) > -1 || rootsFolder.findIndex(x => path.startsWith(x)) > -1;
}

/**
 * Get the normalised canonical absolute path (i.e. resolves symlinks in `path`).
 * @param path The path.
 * @param native Use the native realpath.
 * @returns The normalised canonical absolute path.
 */
export function realpath(path: string, native: boolean = false) {
	return new Promise<string>((resolve) => {
		(native ? fs.realpath.native : fs.realpath)(path, (err, resolvedPath) => resolve(err !== null ? path : getPathFromUri(vscode.Uri.file(resolvedPath))));
	});
}

/**
 * Transform the path from a canonical absolute path to use symbolic links if the containing Visual Studio Code workspace folder has symbolic link(s).
 * @param path The canonical absolute path.
 * @returns The transformed path.
 */
export async function resolveToSymbolicPath(path: string) {
	let workspaceFolders = vscode.workspace.workspaceFolders;
	if (typeof workspaceFolders !== 'undefined') {
		for (let i = 0; i < workspaceFolders.length; i++) {
			let rootSymPath = getPathFromUri(workspaceFolders[i].uri);
			let rootCanonicalPath = await realpath(rootSymPath);
			if (path === rootCanonicalPath) {
				return rootSymPath;
			} else if (path.startsWith(rootCanonicalPath + '/')) {
				return rootSymPath + path.substring(rootCanonicalPath.length);
			} else if (rootCanonicalPath.startsWith(path + '/')) {
				let symPath = rootSymPath;
				let first = symPath.indexOf('/');
				while (true) {
					if (path === symPath || path === await realpath(symPath)) return symPath;
					let next = symPath.lastIndexOf('/');
					if (first !== next && next > -1) {
						symPath = symPath.substring(0, next);
					} else {
						return path;
					}
				}
			}
		}
	}
	return path;
}

/**
 * Checks whether a file exists, and the user has access to read it.
 * @param path The path of the file.
 * @returns Promise resolving to a boolean: TRUE => File exists, FALSE => File doesn't exist.
 */
export function doesFileExist(path: string) {
	return new Promise<boolean>((resolve) => {
		fs.access(path, fs.constants.R_OK, (err) => resolve(err === null));
	});
}

/**
 * Get a short name for a repository.
 * @param path The path of the repository.
 * @returns The short name.
 */
export function getRepoName(path: string) {
	const firstSep = path.indexOf('/');
	if (firstSep === path.length - 1 || firstSep === -1) {
		return path; // Path has no slashes, or a single trailing slash ==> use the path
	} else {
		const p = path.endsWith('/') ? path.substring(0, path.length - 1) : path; // Remove trailing slash if it exists
		return p.substring(p.lastIndexOf('/') + 1);
	}
}

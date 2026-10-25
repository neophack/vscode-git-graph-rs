import * as fs from 'fs';
import * as vscode from 'vscode';
import { evalPromises } from '../../utils/childProcess';
import { getPathFromUri, pathWithTrailingSlash } from '../../utils/paths';

/**
 * The repository discovery seam of the repository manager (REFACTOR-PLAN §3.3 / Appendix A):
 * the directory search that finds repositories in (and below) workspace folders, the submodule
 * scan of a known repository, and the file-system predicates the search rests on. Extracted
 * from the former flat src/repoManager.ts; the search takes its repository lookups as
 * dependencies so the recursion can be tested without a Git backend.
 */

/** The repository lookups the directory search needs from its host (the RepoManager). */
export interface RepoSearchDeps {
	/** Resolve the root of the repository containing the given directory, or NULL if there is none. */
	repoRoot(directory: string): Promise<string | null>;
	/** Is the given directory within a repository that is already known? */
	isWithinKnownRepo(directory: string): boolean;
	/** Register a newly discovered repository. Resolves TRUE when it was added. */
	addRepo(repo: string): Promise<boolean>;
}

/**
 * Search the specified directory for new repositories (and add them).
 * @param directory The path of the directory to search.
 * @param maxDepth The maximum depth to recursively search.
 * @param deps The repository lookups the search uses.
 * @returns TRUE => At least one repository was added, FALSE => No repositories were added.
 */
export function searchDirectoryForRepos(directory: string, maxDepth: number, deps: RepoSearchDeps) {
	return new Promise<boolean>(resolve => {
		if (deps.isWithinKnownRepo(directory)) {
			resolve(false);
			return;
		}

		deps.repoRoot(directory).then(async (root) => {
			if (root !== null) {
				resolve(await deps.addRepo(root));
			} else if (maxDepth > 0) {
				fs.readdir(directory, async (err, dirContents) => {
					if (err) {
						resolve(false);
					} else {
						let dirs = [];
						for (let i = 0; i < dirContents.length; i++) {
							if (dirContents[i] !== '.git' && await isDirectory(directory + '/' + dirContents[i])) {
								dirs.push(directory + '/' + dirContents[i]);
							}
						}
						resolve((await evalPromises(dirs, 2, dir => searchDirectoryForRepos(dir, maxDepth - 1, deps))).indexOf(true) > -1);
					}
				});
			} else {
				resolve(false);
			}
		}).catch(() => resolve(false));
	});
}

/** The lookups the submodule scan needs from its host (the RepoManager). */
export interface SubmoduleSearchDeps {
	/** List the submodules of the given repository. */
	getSubmodules(repo: string): Promise<string[]>;
	/** Is the given repository already known? */
	isKnownRepo(repo: string): boolean;
	/** Register a newly discovered submodule repository. Resolves TRUE when it was added. */
	addRepo(repo: string): Promise<boolean>;
}

/**
 * Search a repository for any new submodules (and add them).
 * @param repo The path of the repository to search.
 * @param deps The lookups the scan uses.
 * @returns TRUE => At least one submodule was added, FALSE => No submodules were added.
 */
export async function searchRepoForSubmodules(repo: string, deps: SubmoduleSearchDeps) {
	let submodules = await deps.getSubmodules(repo), changes = false;
	for (let i = 0; i < submodules.length; i++) {
		if (!deps.isKnownRepo(submodules[i])) {
			if (await deps.addRepo(submodules[i])) changes = true;
		}
	}
	return changes;
}

/** The workspace-folder mapping used to decide whether a repository is inside the workspace. */
export interface WorkspaceFolderInclusionInfo {
	workspaceFolders: vscode.WorkspaceFolder[];
	rootsExact: string[];
	rootsFolder: string[];
}

/**
 * Gets the current workspace folders, and generates information required to identify whether a repository is within any of the workspace folders.
 * @returns The Workspace Folder Information.
 */
export function getWorkspaceFolderInfoForRepoInclusionMapping(): WorkspaceFolderInclusionInfo {
	let rootsExact: string[] = [], rootsFolder: string[] = [], workspaceFolders = vscode.workspace.workspaceFolders || [], path;
	for (let i = 0; i < workspaceFolders.length; i++) {
		path = getPathFromUri(workspaceFolders[i].uri);
		rootsExact.push(path);
		rootsFolder.push(pathWithTrailingSlash(path));
	}
	return {
		workspaceFolders: workspaceFolders,
		rootsExact: rootsExact,
		rootsFolder: rootsFolder
	};
}

/**
 * Check if the specified path is a directory.
 * @param path The path to check.
 * @returns TRUE => Directory, FALSE => Not a directory.
 */
export function isDirectory(path: string) {
	return new Promise<boolean>(resolve => {
		fs.stat(path, (err, stats) => {
			resolve(err ? false : stats.isDirectory());
		});
	});
}

/**
 * Check if the specified path exists.
 * @param path The path to check.
 * @returns TRUE => Path exists, FALSE => Path doesn't exist.
 */
export function doesPathExist(path: string) {
	return new Promise<boolean>(resolve => {
		fs.stat(path, err => resolve(!err));
	});
}

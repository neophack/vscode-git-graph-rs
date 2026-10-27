import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { evalPromises } from '../git/process/childProcess';
import { getPathFromUri, pathWithTrailingSlash, realpath } from '../platform/paths';

/**
 * The repository discovery seam of the repository manager:
 * the directory search that finds repositories in (and below) workspace folders, the submodule
 * scan of a known repository, and the file-system predicates the search rests on. The search
 * takes its repository lookups as
 * dependencies so the recursion can be tested without a Git backend.
 */

/** A mapped-network-drive letter path (`E:/...`) — the form Git may answer with a UNC path for. */
const DRIVE_LETTER_PATH_REGEX = /^[a-z]:\//;

/** The backend read the repository-root resolution needs. */
export interface RepoRootReader {
	repoRoot(path: string): Promise<string>;
}

/**
 * Resolve the root of the repository containing the specified path over the read backend
 * (GitBackend's `repoRoot` read): the answer is normalised, and on Windows a UNC
 * root Git substituted for a mapped network drive is mapped back onto the drive letter, walking
 * the asked path's ancestors so a symlinked directory still resolves to the known spelling.
 * @param read The read backend (or any structural stand-in) answering `repoRoot`.
 * @param pathOfPotentialRepo The path that is potentially a repository (or is contained within one).
 * @returns The root of the repository, or NULL when the path is not inside one.
 */
export async function resolveRepoRoot(read: RepoRootReader, pathOfPotentialRepo: string): Promise<string | null> {
	let pathReturnedByGit: string;
	try {
		const root = await read.repoRoot(pathOfPotentialRepo);
		pathReturnedByGit = getPathFromUri(vscode.Uri.file(path.normalize(root)));
	} catch (_) {
		return null; // null => path is not in a repo
	}

	if (process.platform === 'win32') {
		// On Windows Mapped Network Drives with Git >= 2.25.0, `git rev-parse --show-toplevel` returns the UNC Path for the Mapped Network Drive, instead of the Drive Letter.
		// Attempt to replace the UNC Path with the Drive Letter.
		let driveLetterPathMatch: RegExpMatchArray | null;
		if ((driveLetterPathMatch = pathOfPotentialRepo.match(DRIVE_LETTER_PATH_REGEX)) && !pathReturnedByGit.match(DRIVE_LETTER_PATH_REGEX)) {
			const realPathForDriveLetter = pathWithTrailingSlash(await realpath(driveLetterPathMatch[0], true));
			if (realPathForDriveLetter !== driveLetterPathMatch[0] && pathReturnedByGit.startsWith(realPathForDriveLetter)) {
				pathReturnedByGit = driveLetterPathMatch[0] + pathReturnedByGit.substring(realPathForDriveLetter.length);
			}
		}
	}
	let current = pathOfPotentialRepo;
	const first = current.indexOf('/');
	while (true) {
		if (pathReturnedByGit === current || pathReturnedByGit === await realpath(current)) return current;
		const next = current.lastIndexOf('/');
		if (first !== next && next > -1) {
			current = current.substring(0, next);
		} else {
			return pathReturnedByGit;
		}
	}
}

/** The backend read the submodule listing needs. */
export interface SubmoduleReader {
	getSubmodules(repo: string): Promise<ReadonlyArray<string>>;
}

/**
 * List the submodules of a repository, normalised to the extension's path spelling (GitBackend's
 * `getSubmodules` read): the backends return native-separator paths on Windows,
 * while every repository path these are compared against is normalised. A failed read answers
 * the empty list (no submodule of a repository that cannot be read).
 */
export async function listSubmodules(read: SubmoduleReader, repo: string): Promise<string[]> {
	return read.getSubmodules(repo).then(
		(submodules) => submodules.map((submodule) => getPathFromUri(vscode.Uri.file(path.normalize(submodule)))),
		() => [] as string[]
	);
}

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
						const dirs = [];
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
	const submodules = await deps.getSubmodules(repo);
	let changes = false;
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
	const rootsExact: string[] = [], rootsFolder: string[] = [], workspaceFolders = vscode.workspace.workspaceFolders || [];
	let path;
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

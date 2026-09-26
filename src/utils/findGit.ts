// Locating a usable Git executable. The discovery order matches the behaviour of
// Visual Studio Code's Git Extension, rewritten for this extension's needs - the
// original code is "Copyright (c) 2015 - present Microsoft Corporation", MIT
// licensed (see ./licenses/LICENSE_MICROSOFT in the repository root).

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config';
import type { ExtensionState } from '../extensionState';
import { t } from '../i18n';
import { resolveSpawnOutput } from './childProcess';

/**
 * Get the localised "unable to find a Git executable" message.
 * @returns The localised message.
 */
export function unableToFindGitMsg(): string {
	return t('unableToFindGit');
}

export interface GitExecutable {
	readonly path: string;
	readonly version: string;
}

/**
 * Find a Git executable that Git Graph can use.
 * @param extensionState The Git Graph ExtensionState instance.
 * @returns A Git executable.
 */
export async function findGit(extensionState: ExtensionState) {
	const lastKnownPath = extensionState.getLastKnownGitPath();
	if (lastKnownPath !== null) {
		try {
			return await getGitExecutable(lastKnownPath);
		} catch (_) { }
	}

	const configGitPaths = getConfig().gitPaths;
	if (configGitPaths.length > 0) {
		try {
			return await getGitExecutableFromPaths(configGitPaths);
		} catch (_) { }
	}

	switch (process.platform) {
		case 'darwin':
			return findGitOnDarwin();
		case 'win32':
			return findGitOnWin32();
		default:
			return getGitExecutable('git');
	}
}

/**
 * Find a Git executable on a Darwin-based platform that Git Graph can use.
 * @returns A Git executable.
 */
function findGitOnDarwin() {
	return new Promise<GitExecutable>((resolve, reject) => {
		cp.exec('which git', (err, stdout) => {
			if (err) return reject();

			const path = stdout.trim();
			if (path !== '/usr/bin/git') {
				getGitExecutable(path).then((exec) => resolve(exec), () => reject());
			} else {
				// must check if XCode is installed
				cp.exec('xcode-select -p', (err: any) => {
					if (err && err.code === 2) {
						// git is not installed, and launching /usr/bin/git will prompt the user to install it
						reject();
					} else {
						getGitExecutable(path).then((exec) => resolve(exec), () => reject());
					}
				});
			}
		});
	});
}

/**
 * Find a Git executable on a Windows-based platform that Git Graph can use.
 * @returns A Git executable.
 */
function findGitOnWin32() {
	return findSystemGitWin32(process.env['ProgramW6432'])
		.then(undefined, () => findSystemGitWin32(process.env['ProgramFiles(x86)']))
		.then(undefined, () => findSystemGitWin32(process.env['ProgramFiles']))
		.then(undefined, () => findSystemGitWin32(process.env['LocalAppData'] ? path.join(process.env['LocalAppData']!, 'Programs') : undefined))
		.then(undefined, () => findGitWin32InPath());
}

function findSystemGitWin32(pathBase?: string) {
	return pathBase
		? getGitExecutable(path.join(pathBase, 'Git', 'cmd', 'git.exe'))
		: Promise.reject<GitExecutable>();
}

async function findGitWin32InPath() {
	let dirs = (process.env['PATH'] || '').split(';');
	dirs.unshift(process.cwd());

	for (let i = 0; i < dirs.length; i++) {
		let file = path.join(dirs[i], 'git.exe');
		if (await isExecutable(file)) {
			try {
				return await getGitExecutable(file);
			} catch (_) { }
		}
	}
	return Promise.reject<GitExecutable>();
}

/**
 * Checks whether a path is an executable (a file that's not a symbolic link).
 * @param path The path to test.
 * @returns TRUE => Executable, FALSE => Not an Executable.
 */
function isExecutable(path: string) {
	return new Promise<boolean>(resolve => {
		fs.stat(path, (err, stat) => {
			resolve(!err && (stat.isFile() || stat.isSymbolicLink()));
		});
	});
}

/**
 * Tests whether the specified path corresponds to the path of a Git executable.
 * @param path The path of the Git executable.
 * @returns The GitExecutable data.
 */
export function getGitExecutable(path: string) {
	return new Promise<GitExecutable>((resolve, reject) => {
		resolveSpawnOutput(cp.spawn(path, ['--version'])).then((values) => {
			if (values[0].code === 0) {
				resolve({ path: path, version: values[1].toString().trim().replace(/^git version /, '') });
			} else {
				reject();
			}
		});
	});
}

/**
 * Tests whether one of the specified paths corresponds to the path of a Git executable.
 * @param paths The paths of possible Git executables.
 * @returns The GitExecutable data.
 */
export async function getGitExecutableFromPaths(paths: string[]): Promise<GitExecutable> {
	for (let i = 0; i < paths.length; i++) {
		try {
			return await getGitExecutable(paths[i]);
		} catch (_) { }
	}
	throw new Error('None of the provided paths are a Git executable');
}

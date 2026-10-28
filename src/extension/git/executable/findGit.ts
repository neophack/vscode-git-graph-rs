// Locating a usable Git executable. The discovery order matches the behaviour of
// Visual Studio Code's Git Extension, rewritten for this extension's needs - the
// original code is "Copyright (c) 2015 - present Microsoft Corporation", MIT
// licensed (see ./licenses/LICENSE_MICROSOFT in the repository root).

import * as fs from 'fs';
import * as path from 'path';
import type { ExtensionState } from '../../platform/storage';
import { spawnOutput } from '../process/spawn';

/**
 * The localizer the executable module's message helper takes (the platform `t`, which the
 * callers — layers allowed to import platform/i18n — pass in, keeping this layer vscode-free).
 */
export type GitLocalize = (key: 'unableToFindGit') => string;

/**
 * Get the localised "unable to find a Git executable" message.
 * @param localize The localizer (the platform `t` in production).
 * @returns The localised message.
 */
export function unableToFindGitMsg(localize: GitLocalize): string {
	return localize('unableToFindGit');
}

export interface GitExecutable {
	readonly path: string;
	readonly version: string;
}

/**
 * Find a Git executable that Git Graph can use.
 * @param extensionState The Git Graph ExtensionState instance.
 * @param configGitPaths The Git paths configured by the `git.path` Visual Studio Code setting
 * (answered by the caller from the configuration snapshot).
 * @returns A Git executable.
 */
export async function findGit(extensionState: ExtensionState, configGitPaths: ReadonlyArray<string>) {
	const lastKnownPath = extensionState.getLastKnownGitPath();
	if (lastKnownPath !== null) {
		try {
			return await getGitExecutable(lastKnownPath);
		} catch (_) { }
	}

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
	// The two probes are plain executables, so they spawn directly (a shell would add
	// nothing but quoting risk); the generic spawn owns windowsHide.
	return spawnOutput('which', ['git']).then((which) => {
		if (which.code !== 0) return Promise.reject();

		const path = which.stdout.toString().trim();
		if (path !== '/usr/bin/git') {
			return getGitExecutable(path).then((exec) => exec, () => Promise.reject());
		}
		// must check if XCode is installed
		return spawnOutput('xcode-select', ['-p']).then((xcode) => {
			// xcode-select exits 2 when the developer tools are missing: launching /usr/bin/git
			// would prompt the user to install them, so the search gives up here.
			if (xcode.code === 2) return Promise.reject();
			return getGitExecutable(path).then((exec) => exec, () => Promise.reject());
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
	const dirs = (process.env['PATH'] || '').split(';');
	dirs.unshift(process.cwd());

	for (let i = 0; i < dirs.length; i++) {
		const file = path.join(dirs[i], 'git.exe');
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
	// The version probe runs through the process seam's generic spawn: unlike a direct
	// `cp.spawn` it carries `windowsHide: true`, so probing a candidate on PATH cannot
	// flash a console window.
	return spawnOutput(path, ['--version']).then((output) => {
		if (output.code !== 0 || output.error !== null) return Promise.reject();
		return { path: path, version: output.stdout.toString().trim().replace(/^git version /, '') };
	});
}

/**
 * Tests whether one of the specified paths corresponds to the path of a Git executable.
 * @param paths The paths of possible Git executables.
 * @returns The GitExecutable data.
 */
export async function getGitExecutableFromPaths(paths: ReadonlyArray<string>): Promise<GitExecutable> {
	for (let i = 0; i < paths.length; i++) {
		try {
			return await getGitExecutable(paths[i]);
		} catch (_) { }
	}
	throw new Error('None of the provided paths are a Git executable');
}

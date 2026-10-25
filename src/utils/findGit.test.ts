/**
 * The Git executable discovery of src/utils/findGit.ts (ported from tests/utils.test.mjs): the
 * version probe of a candidate executable, the first-working-path search, and the discovery
 * order (last known path, then the git.path setting, then the platform search). The discovery
 * runs against the real `git` of the machine, like the extension itself does.
 */

import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
	const settings: { [key: string]: unknown } = {};
	return {
		settings: settings,
		Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
		ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		env: { language: 'en' },
		workspace: {
			getConfiguration: (section: string) => ({
				get: (key: string, defaultValue?: unknown) => {
					const value = settings[section + '.' + key];
					return value === undefined ? defaultValue : value;
				}
			})
		}
	};
});

vi.mock('vscode', () => vscodeMock);

import { ExtensionState } from '../extensionState';
import { findGit, getGitExecutable, getGitExecutableFromPaths } from './findGit';

const noSuchGit = path.join(os.tmpdir(), 'gg-no-such-git-' + process.pid);

describe('Git executable discovery', () => {
	it('getGitExecutable resolves a real git and rejects a command that fails', async () => {
		const executable = await getGitExecutable('git');
		expect(executable.path).toBe('git');
		expect(executable.version).toMatch(/^\d+\.\d+/);
		await expect(getGitExecutable(noSuchGit)).rejects.toEqual(undefined);
	});

	it('getGitExecutableFromPaths returns the first working path and throws when none work', async () => {
		const executable = await getGitExecutableFromPaths([noSuchGit, 'git']);
		expect(executable.path).toBe('git');
		await expect(getGitExecutableFromPaths([noSuchGit])).rejects.toThrow(/None of the provided paths/);
	});

	it('findGit prefers the last known path, then the git.path setting, then the platform search', async () => {
		const state = (lastKnownPath: string | null) => <ExtensionState><unknown>{ getLastKnownGitPath: () => lastKnownPath };

		expect((await findGit(state('git'))).path).toBe('git');

		vscodeMock.settings['git.path'] = 'git';
		expect((await findGit(state(noSuchGit))).path).toBe('git');
		vscodeMock.settings['git.path'] = ['git'];
		expect((await findGit(state(null))).path).toBe('git');
		delete vscodeMock.settings['git.path'];

		// Nothing configured: the platform search must still locate the git on PATH
		const found = await findGit(state(null));
		expect(found.version).toMatch(/^\d+\.\d+/);
	});
});

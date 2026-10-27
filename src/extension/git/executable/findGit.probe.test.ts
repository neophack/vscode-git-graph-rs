/**
 * The `git --version` probe of `findGit.ts` after the A3 reroute: it goes through the generic
 * spawn of `git/process/spawn.ts` (so `windowsHide: true` is now passed, where the pre-reroute
 * probe passed no options object at all). The version parsing and the reject-on-failure
 * behaviour carry over the pre-reroute characterization unchanged, over a mocked `child_process`.
 */

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const cpMock = vi.hoisted(() => ({
	spawn: vi.fn(),
	exec: vi.fn()
}));

vi.mock('child_process', () => ({ spawn: cpMock.spawn, exec: cpMock.exec }));

const vscodeMock = vi.hoisted(() => {
	const settings: { [key: string]: unknown } = {};
	return {
		settings: settings,
		Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
		ViewColumn: { Active: 1 },
		env: { language: 'en' },
		window: {},
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

import { getGitExecutable, getGitExecutableFromPaths } from './findGit';

/** A spawned-child double: the stdout/stderr emitters and the exit/error events the resolver consumes. */
function fakeSpawnChild() {
	const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

describe('git --version probe (after the A3 reroute)', () => {
	it('spawns the candidate with just --version and no options object, and parses the version line', async () => {
		const child = fakeSpawnChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = getGitExecutable('C:\\Git\\cmd\\git.exe');
		child.stdout.emit('data', Buffer.from('git version 2.45.1.windows.1\n'));
		child.emit('close', 0);
		await expect(pending).resolves.toEqual({ path: 'C:\\Git\\cmd\\git.exe', version: '2.45.1.windows.1' });
		expect(cpMock.spawn).toHaveBeenCalledTimes(1);
		// The A3 delta: the probe goes through the process seam's generic spawn, which sets
		// windowsHide (and overrides no environment) — where the pre-reroute probe passed NO
		// options object at all.
		expect(cpMock.spawn).toHaveBeenCalledWith('C:\\Git\\cmd\\git.exe', ['--version'], {
			cwd: undefined,
			env: undefined,
			windowsHide: true
		});
	});

	it('keeps a version string that does not carry the "git version " prefix, trimmed', async () => {
		const child = fakeSpawnChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = getGitExecutable('git');
		child.stdout.emit('data', Buffer.from('2.40.0  \n'));
		child.emit('close', 0);
		await expect(pending).resolves.toEqual({ path: 'git', version: '2.40.0' });
	});

	it('rejects (with the legacy undefined) when the candidate exits non-zero', async () => {
		const child = fakeSpawnChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = getGitExecutable('C:\\not-git.exe');
		child.emit('close', 128);
		await expect(pending).rejects.toEqual(undefined);
	});

	it('rejects when the spawn itself fails (error event, code -1)', async () => {
		const child = fakeSpawnChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = getGitExecutable('C:\\no-such-git.exe');
		child.emit('error', new Error('spawn ENOENT'));
		child.emit('close', 1);
		await expect(pending).rejects.toEqual(undefined);
	});

	it('getGitExecutableFromPaths takes the first path that spawns successfully', async () => {
		cpMock.spawn.mockImplementationOnce(() => {
			const failing = fakeSpawnChild();
			Promise.resolve().then(() => {
				failing.emit('close', 1);
			});
			return failing;
		}).mockImplementationOnce(() => {
			const working = fakeSpawnChild();
			Promise.resolve().then(() => {
				working.stdout.emit('data', Buffer.from('git version 2.40.0'));
				working.emit('close', 0);
			});
			return working;
		});
		await expect(getGitExecutableFromPaths(['C:\\bad.exe', 'C:\\good.exe'])).resolves.toEqual({
			path: 'C:\\good.exe',
			version: '2.40.0'
		});
		const calls = cpMock.spawn.mock.calls;
		expect(calls[calls.length - 2][0]).toBe('C:\\bad.exe');
		expect(calls[calls.length - 1][0]).toBe('C:\\good.exe');
	});
});

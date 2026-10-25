/**
 * The child-process helpers of src/utils/childProcess.ts (ported from tests/utils.test.mjs):
 * bounded-parallelism promise evaluation, spawned-output resolution, shell quoting and
 * detection, and the integrated Git terminal. The `vscode` module is faked with a recording
 * stub so the terminal the wrapper opens can be inspected.
 */

import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
	const settings: { [key: string]: unknown } = {};
	const terminals: Array<{ options: { cwd: string, name: string, env: { [key: string]: string }, shellPath?: string }, sent: string[], shown: number }> = [];
	return {
		settings: settings,
		terminals: terminals,
		Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
		ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		env: { language: 'en', shell: '' },
		window: {
			createTerminal: (options: { cwd: string, name: string, env: { [key: string]: string }, shellPath?: string }) => {
				const terminal = {
					options: options,
					sent: [] as string[],
					shown: 0,
					sendText(text: string) { this.sent.push(text); },
					show() { this.shown++; },
					dispose() { }
				};
				terminals.push(terminal);
				return terminal;
			}
		},
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

import { t } from '../i18n';
import { detectTerminalShellKind, evalPromises, openGitTerminal, quoteForShell, resolveSpawnOutput } from './childProcess';

describe('evalPromises', () => {
	it('resolves an empty and a single-element input', async () => {
		expect(await evalPromises([], 2, async (x) => x)).toEqual([]);
		expect(await evalPromises([7], 2, async (x) => x * 2)).toEqual([14]);
	});

	it('keeps at most maxParallel promises in flight and preserves the input order', async () => {
		let inFlight = 0, peak = 0;
		const result = await evalPromises([5, 1, 4, 2, 3], 2, (value) => new Promise((resolve) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			setTimeout(() => {
				inFlight--;
				resolve(value * 10);
			}, value);
		}));
		expect(result).toEqual([50, 10, 40, 20, 30]);
		expect(peak).toBe(2);
	});

	it('rejects as soon as one promise rejects, and tolerates an invalid parallelism', async () => {
		await expect(evalPromises([1, 2, 3], 3, async (v) => {
			if (v === 2) throw new Error('x');
			return v;
		})).rejects.toEqual(undefined);
		expect(await evalPromises([1, 2, 3], 0, async (v) => v)).toEqual([1, 2, 3]);
		expect(await evalPromises([1, 2], Infinity, async (v) => v)).toEqual([1, 2]);
	});
});

describe('resolveSpawnOutput', () => {
	/** A ChildProcess double: a plain event emitter trio, cast into the Node shape. */
	function fakeProcess() {
		const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter, stderr: EventEmitter };
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		proc.stdout = stdout;
		proc.stderr = stderr;
		return { proc: proc as unknown as ChildProcess, stdout: stdout, stderr: stderr };
	}

	it('collects the exit code, stdout and stderr', async () => {
		const { proc, stdout, stderr } = fakeProcess();
		const pending = resolveSpawnOutput(proc);
		stdout.emit('data', Buffer.from('out'));
		stdout.emit('data', Buffer.from('put'));
		stderr.emit('data', 'warn');
		proc.emit('exit', 0);
		proc.emit('error', new Error('ignored after exit'));
		stdout.emit('close');
		stderr.emit('close');
		const [status, out, err] = await pending;
		expect(status).toEqual({ code: 0, error: null });
		expect(out.toString()).toBe('output');
		expect(err).toBe('warn');
	});

	it('reports a spawn error with code -1', async () => {
		const { proc, stdout, stderr } = fakeProcess();
		const pending = resolveSpawnOutput(proc);
		const error = new Error('ENOENT');
		proc.emit('error', error);
		proc.emit('exit', 1);
		stdout.emit('close');
		stderr.emit('close');
		const [status] = await pending;
		expect(status).toEqual({ code: -1, error: error });
	});
});

describe('quoteForShell', () => {
	it('quotes a value so it arrives at git as a single argument in the given shell', () => {
		expect(quoteForShell('it\'s', 'posix')).toBe('\'it\'\\\'\'s\'');
		expect(quoteForShell('a & b; c', 'posix')).toBe('\'a & b; c\'');
		expect(quoteForShell('a & b; c', 'cmd')).toBe('"a & b; c"');
		expect(quoteForShell('a"b', 'cmd')).toBe(null); // cmd.exe cannot escape a double quote
		expect(quoteForShell('a%b', 'cmd')).toBe(null); // ... nor %VAR% expansion
		expect(quoteForShell('a$b`c"d', 'powershell')).toBe('"a`$b``c`"d"');
		expect(quoteForShell('a“;b”;c„', 'powershell')).toBe('"a`“;b`”;c`„"'); // PowerShell also ends a string at typographic quotes
		expect(quoteForShell('it\'s', 'fish')).toBe('\'it\\\'s\''); // fish treats \' inside single quotes as an escaped quote
	});

	it('detects the shell kind from the configured integrated terminal shell', () => {
		vscodeMock.settings['git-graph-rs.integratedTerminalShell'] = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
		expect(detectTerminalShellKind()).toBe('powershell');
		vscodeMock.settings['git-graph-rs.integratedTerminalShell'] = '/usr/bin/fish';
		expect(detectTerminalShellKind()).toBe('fish');
		vscodeMock.settings['git-graph-rs.integratedTerminalShell'] = '/bin/zsh';
		expect(detectTerminalShellKind()).toBe('posix');
		// No shell configured: the profile default VS Code reports decides
		delete vscodeMock.settings['git-graph-rs.integratedTerminalShell'];
		vscodeMock.env.shell = '/bin/bash';
		expect(detectTerminalShellKind()).toBe('posix');
		vscodeMock.env.shell = '';
	});
});

describe('openGitTerminal', () => {
	it('adds the Git directory to PATH, runs the command and honours the configured shell', () => {
		vscodeMock.terminals.length = 0;
		const sep = process.platform === 'win32' ? ';' : ':';

		openGitTerminal('/repo', '/opt/git/bin/git', 'rebase -i HEAD~3', 'Rebase');
		const terminal = vscodeMock.terminals[0];
		expect(terminal.options.cwd).toBe('/repo');
		expect(terminal.options.name).toBe(t('terminalName', 'Rebase'));
		expect(terminal.options.env.PATH.endsWith(sep + path.dirname('/opt/git/bin/git'))).toBe(true);
		expect(terminal.options.shellPath).toBeUndefined();
		expect(terminal.sent).toEqual(['git rebase -i HEAD~3']);
		expect(terminal.shown).toBe(1);

		vscodeMock.settings['git-graph-rs.integratedTerminalShell'] = '/bin/zsh';
		try {
			openGitTerminal('/repo', '/opt/git/bin/git', null, 'Shell');
		} finally {
			delete vscodeMock.settings['git-graph-rs.integratedTerminalShell'];
		}
		expect(vscodeMock.terminals[1].options.shellPath).toBe('/bin/zsh');
		expect(vscodeMock.terminals[1].sent).toEqual([]);
	});
});

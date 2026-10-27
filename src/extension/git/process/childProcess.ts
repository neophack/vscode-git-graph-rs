// View-side process helpers: bounded-parallelism promise evaluation, shell quoting and
// detection, and the integrated git terminal. The spawned-output resolution that used to live
// here moved to `spawn.ts` (OPTIMIZATION-PLAN A3: one process seam).

import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../../platform/config';
import { Terminals } from '../../platform/terminal';
import { t } from '../../platform/i18n';

/**
 * Open a new terminal, set up the Git executable, and optionally run a command.
 * @param cwd The working directory for the terminal.
 * @param gitPath The path of the Git executable.
 * @param command The command to run.
 * @param name The name for the terminal.
 */
export function openGitTerminal(cwd: string, gitPath: string, command: string | null, name: string) {
	let p = process.env['PATH'] || '', sep = isWindows() ? ';' : ':';
	if (p !== '' && !p.endsWith(sep)) p += sep;
	p += path.dirname(gitPath);

	const shell = getConfig().integratedTerminalShell;
	const options: { cwd: string, name: string, env: { [key: string]: string }, shellPath?: string } = {
		cwd: cwd,
		name: t('terminalName', name),
		env: { 'PATH': p }
	};
	if (shell !== '') options.shellPath = shell;

	// The platform adapter (task 4.10, INVENTORY.md #25) creates the terminal, optionally sends
	// the command into it and shows it - the exact flow this wrapper drove directly through
	// `vscode.window.createTerminal` before. Built at call time, so merely importing this
	// module never touches the vscode module surface (minimal test mocks stay usable).
	new Terminals(vscode.window).run(options, command === null ? null : 'git ' + command);
}

/**
 * Check whether Git Graph is running on a Windows-based platform.
 * @returns TRUE => Windows-based platform, FALSE => Not a Windows-based platform.
 */
function isWindows() {
	return process.platform === 'win32' || process.env.OSTYPE === 'cygwin' || process.env.OSTYPE === 'msys';
}

/** The integrated-terminal shell kinds that need distinct argument quoting. */
export type ShellKind = 'cmd' | 'powershell' | 'fish' | 'posix';

/**
 * Identify the shell kind of the terminal that openGitTerminal creates: the configured
 * `integratedTerminalShell`, falling back to the profile default VS Code reports (only
 * available in newer versions — otherwise the platform default is assumed).
 */
export function detectTerminalShellKind(): ShellKind {
	const configured = getConfig().integratedTerminalShell;
	const shellPath = configured !== '' ? configured : String((<{ shell?: string }>(<unknown>vscode.env)).shell ?? '');
	return shellKindFromPath(shellPath);
}

function shellKindFromPath(shellPath: string): ShellKind {
	const base = shellPath.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
	if (base === 'cmd.exe' || base === 'command.com') return 'cmd';
	if (base === 'powershell.exe' || base === 'pwsh.exe' || base === 'powershell' || base === 'pwsh') return 'powershell';
	if (base === 'fish') return 'fish';
	if (/^(ba|z|k|da|mk)?sh(\.exe)?$|^wsl(-?(bash|\d+))?(\.exe)?$|^busybox(\.exe)?$/.test(base)) return 'posix';
	return isWindows() ? 'powershell' : 'posix';
}

/**
 * Quote a value so that it arrives at `git` as a single argument in the given shell.
 * @param value The value to quote.
 * @param kind The shell the quoted value will be interpreted by.
 * @returns The quoted value, or NULL if no quoting can make the value safe in that shell.
 */
export function quoteForShell(value: string, kind: ShellKind): string | null {
	switch (kind) {
		case 'cmd':
			// cmd.exe only honours double quotes; between them everything is literal except the
			// quote itself (which ends the string) and `%…%` expansion (no interactive escape).
			return /["%]/.test(value) ? null : '"' + value + '"';
		case 'powershell':
			// Inside double quotes PowerShell expands `$…`, executes `$(…)` and honours backtick
			// escapes; each of those, and the quote itself, is neutralised with a backtick. PowerShell
			// also ends a double-quoted string at the typographic quotes “ ” „, which ref names may contain.
			return '"' + value.replace(/[`$"“”„]/g, '`$&') + '"';
		case 'fish':
			// Inside single quotes fish treats `\'` as an escaped quote (POSIX shells would not).
			return '\'' + value.replace(/'/g, '\\\'') + '\'';
		default:
			// POSIX (sh/bash/zsh/ksh): nothing is special inside single quotes.
			return '\'' + value.replace(/'/g, '\'\\\'\'') + '\'';
	}
}

/**
 * Evaluate promises in parallel, with at most `maxParallel` running at any point in time.
 * @param data The array of elements to be mapped via promises.
 * @param maxParallel The maximum number of promises to run at any point in time.
 * @param createPromise A function that creates a promise from an element of `data`.
 * @returns A result array evaluated by mapping promises generated from `data`.
 */
export function evalPromises<X, Y>(data: X[], maxParallel: number, createPromise: (val: X) => Promise<Y>) {
	return new Promise<Y[]>((resolve, reject) => {
		// Fall back to sequential evaluation if an invalid maximum parallelism was provided, so
		// that the returned promise always settles
		if (maxParallel < 1 || !isFinite(maxParallel)) {
			maxParallel = 1;
		}
		if (data.length === 1) {
			createPromise(data[0]).then(v => resolve([v])).catch(() => reject());
		} else if (data.length === 0) {
			resolve([]);
		} else {
			let results: Y[] = new Array(data.length), nextPromise = 0, rejected = false, completed = 0;
			function startNext() {
				let cur = nextPromise;
				nextPromise++;
				createPromise(data[cur]).then(result => {
					if (!rejected) {
						results[cur] = result;
						completed++;
						if (nextPromise < data.length) startNext();
						else if (completed === data.length) resolve(results);
					}
				}).catch(() => {
					reject();
					rejected = true;
				});
			}
			for (let i = 0; i < maxParallel && i < data.length; i++) startNext();
		}
	});
}


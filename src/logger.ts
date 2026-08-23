import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable } from './utils/disposable';

const DOUBLE_QUOTE_REGEXP = /"/g;

/**
 * Manages the Git Graph Logger, which writes log information to the Git Graph Output Channel.
 *
 * When a log file path is given, every line is also mirrored there — one file per editor session,
 * starting empty on each activation — so the log can be opened from the view's settings widget and
 * read back for performance analysis without hunting for the Output Channel.
 */
export class Logger extends Disposable {
	private readonly channel: vscode.OutputChannel;
	private logFile: string | null;
	private enabled: boolean = false;

	/**
	 * Creates the Git Graph Logger. Nothing is recorded until `setEnabled(true)` is called —
	 * logging is opt-in through the `git-graph-rs.enableLog` setting.
	 * @param logFilePath Where to mirror the log while enabled.
	 */
	constructor(logFilePath?: string) {
		super();
		this.channel = vscode.window.createOutputChannel('Git Graph RS');
		this.registerDisposable(this.channel);
		this.logFile = logFilePath ?? null;
	}

	/**
	 * Enable or disable logging. Enabling starts a fresh log file; disabling stops all recording
	 * (what was logged so far stays in the file, and can still be opened).
	 */
	public setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		if (enabled && this.logFile !== null) {
			try {
				const directory = path.dirname(this.logFile);
				if (!fs.existsSync(directory)) fs.mkdirSync(directory);
				fs.writeFileSync(this.logFile, '');
			} catch {
				// A read-only or missing storage location: the Output Channel still works.
				this.logFile = null;
			}
		}
	}

	/**
	 * Is logging currently enabled?
	 */
	public isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * The file the log is mirrored to while enabled, or null when there is none.
	 */
	public getLogFile(): string | null {
		return this.enabled ? this.logFile : null;
	}

	/**
	 * Log a message to the Output Channel and the log file.
	 * @param message The string to be logged.
	 */
	public log(message: string) {
		if (!this.enabled) return;
		const date = new Date();
		const timestamp = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) + '.' + pad3(date.getMilliseconds());
		const line = '[' + timestamp + '] ' + message;
		this.channel.appendLine(line);
		if (this.logFile !== null) {
			try {
				fs.appendFileSync(this.logFile, line + '\n');
			} catch { /* the Output Channel line has already been written */ }
		}
	}

	/**
	 * Log the execution of a spawned command to the Output Channel.
	 * @param cmd The command being spawned.
	 * @param args The arguments passed to the command.
	 * @param durationMs How long the command took, when known — the number the performance log
	 * analysis is built around (see `scripts/analyze-log.mjs`).
	 */
	public logCmd(cmd: string, args: string[], durationMs?: number) {
		this.log('> ' + cmd + ' ' + args.map((arg) => arg === ''
			? '""'
			: arg.startsWith('--format=')
				? '--format=...'
				: arg.includes(' ')
					? '"' + arg.replace(DOUBLE_QUOTE_REGEXP, '\\"') + '"'
					: arg
		).join(' ') + (typeof durationMs === 'number' ? ' (' + durationMs + ' ms)' : ''));
	}

	/**
	 * Log an error message to the Output Channel.
	 * @param message The string to be logged.
	 */
	public logError(message: string) {
		this.log('ERROR: ' + message);
	}
}

/**
 * Pad a number with a leading zero if it is less than two digits long.
 * @param n The number to be padded.
 * @returns The padded number.
 */
function pad2(n: number) {
	return (n > 9 ? '' : '0') + n;
}

/**
 * Pad a number with leading zeros if it is less than three digits long.
 * @param n The number to be padded.
 * @returns The padded number.
 */
function pad3(n: number) {
	return (n > 99 ? '' : n > 9 ? '0' : '00') + n;
}

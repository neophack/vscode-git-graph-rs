import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable } from '../../shared/util/disposable';

/**
 * Platform logger adapter (REFACTOR-PLAN 3.3): the ONE Logger of the extension host, unifying
 * the two halves that used to live side by side - the flat src/logger.ts (absorbed here
 * wholesale: the 'Git Graph RS' Output Channel, the opt-in enable gate and the log-file
 * mirroring) and this module's structurally-injected channel seam.
 *
 * The two construction shapes select the mode:
 * - `new Logger(logFilePath?)` - the live host shape (src/extension.ts): the channel is wired
 *   from `vscode.window` at construction, nothing is recorded until `setEnabled(true)`, and
 *   every recorded line is mirrored to the log file while one is configured. The mirror is
 *   written asynchronously: the truncations and appends run through one serialized queue in
 *   log-call order, so the shared extension host never performs synchronous fs for a log line
 *   (OPTIMIZATION-PLAN A6) while the file still reads back as an ordered log.
 * - `new Logger(name, factory)` - the injected seam (unit tests, degraded hosts): the channel
 *   comes from the injected factory and logging is ungated; a missing, throwing or unusable
 *   factory degrades every method to a no-op, so logging can never break a request path.
 */

/** The `vscode.OutputChannel` surface this adapter uses; optional members are feature-detected. */
export interface OutputChannelLike {
	appendLine(value: string): void;
	append?(value: string): void;
	show?(preserveFocus?: boolean): void;
	clear?(): void;
	dispose?(): void;
}

/** The output-channel factory surface of `vscode.window`. */
export interface OutputChannelFactoryLike {
	createOutputChannel(name: string): OutputChannelLike;
}

const CHANNEL_NAME = 'Git Graph RS';

const DOUBLE_QUOTE_REGEXP = /"/g;

/**
 * The maximum size the log file may grow to within one session. Logging exists to analyse the
 * performance of a (typically short) session, so past this size the file is reset rather than
 * rotated: the most recent lines are the relevant ones once it is full, and a long editor session
 * cannot grow it without bound.
 */
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

function isOutputChannel(candidate: unknown): candidate is OutputChannelLike {
	return candidate !== null && typeof candidate === 'object'
		&& typeof (candidate as { appendLine?: unknown }).appendLine === 'function';
}

export class Logger extends Disposable {
	private channel: OutputChannelLike | null = null;
	/** TRUE in the host-wired mode (vscode channel + enable gate + file mirroring). */
	private readonly hostWired: boolean;
	/** The path the mirror is configured to write (host-wired mode), independent of its health. */
	private readonly configuredLogFile: string | null;
	/** The live mirror target: null while disabled or after a failed setup (see setEnabled). */
	private logFile: string | null;
	private logFileBytes: number = 0;
	private enabled: boolean = false;
	/** The serialized tail of the file mirror: every truncation and append, in log-call order. */
	private fileQueue: Promise<void> = Promise.resolve();

	/**
	 * @param nameOrLogFilePath The channel name in the injected-factory mode, or the log file
	 * path to mirror to in the host-wired mode (see the module doc for the two shapes).
	 * @param factoryArg Present (even when its value is NULL or undefined) in the
	 * injected-factory mode: a window-like object providing `createOutputChannel`, where NULL or
	 * undefined means "no output-channel API available" (unit tests, degraded hosts) and every
	 * method degrades to a no-op.
	 */
	constructor(nameOrLogFilePath?: string, ...factoryArg: [] | [OutputChannelFactoryLike | null | undefined]) {
		super();
		if (factoryArg.length > 0) {
			this.hostWired = false;
			this.configuredLogFile = null;
			this.logFile = null;
			const factory = factoryArg[0] ?? null;
			const createOutputChannel = factory?.createOutputChannel;
			if (typeof createOutputChannel !== 'function') return;
			try {
				const channel = createOutputChannel.call(factory, nameOrLogFilePath ?? CHANNEL_NAME);
				this.channel = isOutputChannel(channel) ? channel : null;
			} catch {
				this.channel = null;
			}
		} else {
			this.hostWired = true;
			this.configuredLogFile = nameOrLogFilePath ?? null;
			this.logFile = nameOrLogFilePath ?? null;
			const channel = vscode.window.createOutputChannel(CHANNEL_NAME);
			this.channel = channel;
			this.registerDisposable(channel);
		}
	}

	/**
	 * Enable or disable logging (host-wired mode; a no-op otherwise). Enabling starts a fresh
	 * log file; disabling stops all recording (what was logged so far stays in the file, and
	 * can still be opened). The fresh file is written asynchronously through the mirror queue;
	 * until its write lands `getLogFile` may still report a path whose setup then failed (a
	 * read-only or missing storage location) — the failure then degrades the mirror to the
	 * Output Channel alone.
	 */
	public setEnabled(enabled: boolean): void {
		if (enabled === this.enabled && !(enabled && this.logFile === null && this.configuredLogFile !== null)) return;
		this.enabled = enabled;
		if (enabled && this.configuredLogFile !== null && this.logFile === null) {
			// First setup, or recovery: a previous setup lost the mirror (a transient failure such
			// as an antivirus lock, not only a read-only location), and an enable that does not
			// change the flag must still rebuild it - the equal-value guard would otherwise pin
			// the session to channel-only forever.
			this.logFile = this.configuredLogFile;
		}
		if (enabled && this.logFile !== null) {
			this.logFileBytes = 0;
			const file = this.logFile;
			this.enqueue(async () => {
				try {
					const directory = path.dirname(file);
					try {
						await fs.promises.access(directory);
					} catch {
						await fs.promises.mkdir(directory);
					}
					await fs.promises.writeFile(file, '');
				} catch {
					// A read-only or missing storage location: the Output Channel still works.
					if (this.logFile === file) this.logFile = null;
				}
			});
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
	 * Log a message to the Output Channel (timestamped, and mirrored to the log file while one
	 * is configured and enabled in the host-wired mode; appended verbatim in the injected mode).
	 * @param message The string to be logged.
	 */
	public log(message: string): void {
		if (this.hostWired) {
			if (!this.enabled) return;
			const date = new Date();
			const timestamp = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) + '.' + pad3(date.getMilliseconds());
			const line = '[' + timestamp + '] ' + message;
			this.channel?.appendLine(line);
			this.mirror(line);
		} else {
			this.channel?.appendLine(message);
		}
	}

	/**
	 * Queue one mirrored line on the file: the truncation decision and the byte accounting stay
	 * synchronous and in log-call order (the same bookkeeping the synchronous mirror kept),
	 * while the writes themselves run serialized in that order off the event loop.
	 */
	private mirror(line: string): void {
		const file = this.logFile;
		if (file === null) return;
		const truncate = this.logFileBytes >= LOG_FILE_MAX_BYTES;
		if (truncate) this.logFileBytes = 0;
		this.logFileBytes += Buffer.byteLength(line) + 1;
		this.enqueue(async () => {
			try {
				if (truncate) await fs.promises.writeFile(file, '');
				await fs.promises.appendFile(file, line + '\n');
			} catch { /* the Output Channel line has already been written */ }
		});
	}

	/** Serialize one file-mirroring step behind the queue, keeping the chain alive after failures. */
	private enqueue(step: () => Promise<void>): void {
		this.fileQueue = this.fileQueue.then(step, step);
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
	 * Log an error message to the Output Channel (prefixed `ERROR:` — the prefix the log
	 * analysis tooling greps for).
	 * @param message The string to be logged.
	 */
	public logError(message: string) {
		this.log('ERROR: ' + message);
	}

	/**
	 * Append one line, flagged as an error, to the channel (a no-op without a usable channel).
	 */
	public error(message: string): void {
		if (this.hostWired) {
			this.logError(message);
		} else {
			this.log('[ERROR] ' + message);
		}
	}

	/**
	 * Reveal the channel in the Output panel (a no-op without a channel that can show).
	 */
	public show(): void {
		this.channel?.show?.();
	}

	/**
	 * Clear the channel (a no-op without a channel that can clear).
	 */
	public clear(): void {
		this.channel?.clear?.();
	}

	/**
	 * Dispose the channel (host-wired mode: through the registered disposable, like the former
	 * flat Logger; injected mode: directly, like the former seam).
	 */
	public override dispose(): void {
		if (!this.hostWired) {
			this.channel?.dispose?.();
			this.channel = null;
		}
		super.dispose();
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

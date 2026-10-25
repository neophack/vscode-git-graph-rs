/**
 * Platform logger adapter (REFACTOR-PLAN 3.3): an OutputChannel-based logger that tolerates a
 * missing channel - the channel side of src/logger.ts's Logger, as a platform seam.
 *
 * The dependency is injected structurally (production wiring passes a window-like object whose
 * `createOutputChannel` is `vs.window.createOutputChannel`). Degradation follows the vscodeCompat
 * pattern: with no factory, a factory that answers nothing usable, or a channel lacking
 * `appendLine`, every method becomes a no-op - logging must never break a request path. (The
 * file-mirroring half of the old Logger is orthogonal and stays with its callers until the
 * migration PR folds it in.)
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

function isOutputChannel(candidate: unknown): candidate is OutputChannelLike {
	return candidate !== null && typeof candidate === 'object'
		&& typeof (candidate as { appendLine?: unknown }).appendLine === 'function';
}

export class Logger {
	private channel: OutputChannelLike | null = null;

	/**
	 * @param name The channel name (e.g. 'Git Graph RS').
	 * @param factory A window-like object providing `createOutputChannel`; NULL or undefined
	 * when no output-channel API is available (unit tests, degraded hosts).
	 */
	constructor(name: string, factory: OutputChannelFactoryLike | null | undefined) {
		const createOutputChannel = factory?.createOutputChannel;
		if (typeof createOutputChannel !== 'function') return;
		try {
			const channel = createOutputChannel.call(factory, name);
			this.channel = isOutputChannel(channel) ? channel : null;
		} catch {
			this.channel = null;
		}
	}

	/**
	 * Append one line to the channel (a no-op without a usable channel).
	 */
	public log(message: string): void {
		this.channel?.appendLine(message);
	}

	/**
	 * Append one line, flagged as an error, to the channel (a no-op without a usable channel).
	 */
	public error(message: string): void {
		this.log('[ERROR] ' + message);
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
	 * Dispose the channel (a no-op without a disposable channel).
	 */
	public dispose(): void {
		this.channel?.dispose?.();
		this.channel = null;
	}
}

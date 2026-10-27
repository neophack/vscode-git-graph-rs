/**
 * Platform terminal adapter: the typed seam over
 * `vscode.window.createTerminal` + `Terminal.sendText` + `Terminal.show` - the surface
 * src/extension/git/process/childProcess.ts's openGitTerminal drives.
 *
 * The dependency is injected structurally (production wiring passes `vscode.window`). A missing
 * or malformed API degrades to NULL instead of throwing (the vscodeCompat pattern), so a caller
 * can decide how to report "no terminal available".
 */

/** The `vscode.Terminal` surface this adapter drives. Optional members are feature-detected. */
export interface TerminalLike {
	sendText?(text: string, addNewLine?: boolean): void;
	show?(preserveFocus?: boolean): void;
	hide?(): void;
	dispose?(): void;
}

/** The subset of `vscode.TerminalOptions` the terminal creation sites use. */
export interface TerminalOptionsLike {
	readonly name: string;
	readonly cwd?: string;
	readonly shellPath?: string;
	readonly env?: Readonly<{ [key: string]: string | null }>;
}

/** The terminal-creation surface of `vscode.window`. */
export interface TerminalsLike {
	createTerminal(options: TerminalOptionsLike): TerminalLike;
}

function isTerminal(candidate: unknown): candidate is TerminalLike {
	return candidate !== null && typeof candidate === 'object';
}

export class Terminals {
	private readonly window: TerminalsLike | null;

	/**
	 * @param window A window-like object (`vscode.window` satisfies this structurally); NULL or
	 * undefined when no terminal API is available.
	 */
	constructor(window: TerminalsLike | null | undefined) {
		this.window = window ?? null;
	}

	/**
	 * Create a terminal. No text is sent and the terminal is not shown.
	 * @returns The terminal, or NULL when the API is unavailable or answered unusably.
	 */
	public create(options: TerminalOptionsLike): TerminalLike | null {
		const createTerminal = this.window?.createTerminal;
		if (typeof createTerminal !== 'function') return null;
		try {
			const terminal = createTerminal.call(this.window, options);
			return isTerminal(terminal) ? terminal : null;
		} catch {
			return null;
		}
	}

	/**
	 * Create a terminal, optionally send a command into it, and show it - the flow of
	 * openGitTerminal in src/utils/childProcess.ts.
	 * @param options The terminal creation options (name, cwd, shell, environment).
	 * @param command The command to send, or NULL to only open the terminal.
	 * @returns The terminal, or NULL when no terminal could be created.
	 */
	public run(options: TerminalOptionsLike, command: string | null): TerminalLike | null {
		const terminal = this.create(options);
		if (terminal === null) return null;
		if (command !== null && typeof terminal.sendText === 'function') {
			terminal.sendText(command);
		}
		if (typeof terminal.show === 'function') {
			terminal.show();
		}
		return terminal;
	}
}

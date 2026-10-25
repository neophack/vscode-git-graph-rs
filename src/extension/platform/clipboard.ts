/**
 * Platform clipboard adapter (REFACTOR-PLAN 3.3): the typed seam over `vscode.env.clipboard`
 * (the surface src/utils/actions.ts's copyToClipboard drives directly today).
 *
 * The dependency is injected structurally (production wiring passes `vscode.env.clipboard`).
 * Degradation is part of the contract, not an error: when the clipboard is unavailable or the
 * write rejects, `write` resolves FALSE - exactly the signal copyToClipboard turns into its
 * localized "clipboard write failed" message.
 */

/** The `vscode.Clipboard` surface this adapter uses. */
export interface ClipboardLike {
	writeText(value: string): Thenable<void>;
	readText?(): Thenable<string>;
}

export class Clipboard {
	private readonly clipboard: ClipboardLike | null;

	/**
	 * @param clipboard A clipboard-like object (`vscode.env.clipboard` satisfies this
	 * structurally); NULL or undefined when no clipboard is available.
	 */
	constructor(clipboard: ClipboardLike | null | undefined) {
		this.clipboard = clipboard ?? null;
	}

	/**
	 * Write text to the clipboard.
	 * @returns TRUE when the text was written; FALSE when the clipboard is unavailable or the
	 * write rejected (never rejects).
	 */
	public write(text: string): Promise<boolean> {
		const writeText = this.clipboard?.writeText;
		if (typeof writeText !== 'function') return Promise.resolve(false);
		return Promise.resolve(writeText.call(this.clipboard, text) as Thenable<void>)
			.then(() => true, () => false);
	}

	/**
	 * Read text from the clipboard.
	 * @returns The clipboard text, or NULL when the clipboard is unavailable, lacks a reader
	 * (pre-1.30 editors keep writeText only) or the read rejected.
	 */
	public read(): Promise<string | null> {
		const readText = this.clipboard?.readText;
		if (typeof readText !== 'function') return Promise.resolve(null);
		return Promise.resolve(readText.call(this.clipboard) as Thenable<string>)
			.then((text) => text, () => null);
	}
}

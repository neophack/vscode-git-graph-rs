/**
 * Platform notifications adapter (REFACTOR-PLAN 3.3): the typed seam over
 * `vscode.window.showInformationMessage` / `showWarningMessage` / `showErrorMessage`.
 *
 * The dependency is injected structurally (production wiring passes `vscode.window`), so the
 * module never imports 'vscode' and tests run against a plain fake. Following the vscodeCompat
 * pattern, a missing or malformed API degrades instead of throwing: every method answers
 * `undefined` (the "no choice made" answer - the same value a dismissed message yields), and a
 * rejected Thenable is swallowed to `undefined`, matching how the existing call sites in
 * src/utils/actions.ts already settle their message dialogs.
 */

/** A message choice: a plain string item, or a `vscode.MessageItem`-shaped object. */
export interface MessageItemLike {
	readonly title: string;
	/** Optional commands run instead of resolving the promise. */
	readonly isCloseAffordance?: boolean;
}

/** Anything a notification can offer as a clickable item. */
export type MessageChoice = string | MessageItemLike;

/**
 * The notification surface of `vscode.window` this adapter uses. Method syntax keeps the real
 * (overloaded, generic) API assignable to this shape.
 */
export interface NotificationsLike {
	showInformationMessage<T extends MessageChoice>(message: string, ...items: T[]): Thenable<T | undefined>;
	showWarningMessage<T extends MessageChoice>(message: string, ...items: T[]): Thenable<T | undefined>;
	showErrorMessage<T extends MessageChoice>(message: string, ...items: T[]): Thenable<T | undefined>;
}

function isShowMessage(candidate: unknown): candidate is (message: string, ...items: unknown[]) => Thenable<unknown> {
	return typeof candidate === 'function';
}

export class Notifications {
	private readonly window: NotificationsLike | null;

	/**
	 * @param window A window-like object (`vscode.window` satisfies this structurally); NULL or
	 * undefined when no notification API is available (unit tests, degraded hosts).
	 */
	constructor(window: NotificationsLike | null | undefined) {
		this.window = window ?? null;
	}

	/**
	 * Show an information message, optionally offering clickable items.
	 * @returns The chosen item, or UNDEFINED when the message was dismissed, the API is
	 * unavailable, or the underlying Thenable rejected.
	 */
	public information<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.show('showInformationMessage', message, items);
	}

	/**
	 * Show a warning message, optionally offering clickable items.
	 * @returns The chosen item, or UNDEFINED when the message was dismissed or unavailable.
	 */
	public warning<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.show('showWarningMessage', message, items);
	}

	/**
	 * Show an error message, optionally offering clickable items.
	 * @returns The chosen item, or UNDEFINED when the message was dismissed or unavailable.
	 */
	public error<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.show('showErrorMessage', message, items);
	}

	// --- vscode-named aliases: an instance structurally satisfies uiPort.ts's NotificationsPort
	// (and the showErrorMessage member the wave-1 handler table declares for ctx.ui). ---

	/** Alias of {@link information} under the vscode API's name. */
	public showInformationMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.show('showInformationMessage', message, items);
	}

	/** Alias of {@link warning} under the vscode API's name. */
	public showWarningMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.show('showWarningMessage', message, items);
	}

	/** Alias of {@link error} under the vscode API's name. */
	public showErrorMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.show('showErrorMessage', message, items);
	}

	private show<T extends MessageChoice>(method: 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage', message: string, items: T[]): Promise<T | undefined> {
		const candidate: unknown = this.window === null ? undefined : this.window[method];
		if (!isShowMessage(candidate)) return Promise.resolve(undefined);
		const showMessage = candidate.bind(this.window) as (message: string, ...items: T[]) => Thenable<T | undefined>;
		return Promise.resolve(showMessage(message, ...items))
			.then((choice) => choice ?? undefined, () => undefined);
	}
}

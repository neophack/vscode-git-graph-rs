import { DisposableLike } from './config';
import { MessageChoice } from './notifications';

/**
 * The native-UI port of the host (REFACTOR-PLAN 3.3 + task 4.10): every modal interaction the
 * host drives - notifications, input boxes, quick picks, save/open dialogs and progress - behind
 * one interface, so the E2E build can inject a ScriptedUiPort and replay every branch.
 *
 * This file is INTERFACE ONLY (types + JSDoc, no implementation). The production implementation
 * (a later wave) wraps `vscode.window` - which satisfies these signatures structurally; the
 * platform adapters already built (notifications.ts, terminal.ts, clipboard.ts) cover the
 * non-modal subsets.
 *
 * Compatibility with the wave-1 handler table (src/extension/graphView/handlers/context.ts):
 * its ctx.ui declares `showErrorMessage(message: string): void` among higher-level actions
 * (viewScm, viewDiff, ...). Those are compatible directions:
 * - any implementation of this UiPort also satisfies the handler's `showErrorMessage` member
 *   (fewer parameters, `void` vs a wider return), so the handler interface can extend UiPort
 *   by simply DROPPING its narrower `showErrorMessage` declaration - implementations need no
 *   change (uiPort.test.ts pins this assignability);
 * - the handler's remaining members (viewDiff, createArchive, ...) are higher-level actions
 *   COMPOSED on top of this port; they stay on the handler interface or a follow-up
 *   actions-port, not here.
 */

/** The URI shape the dialogs answer with (`vscode.Uri` satisfies this structurally). */
export interface UriLike {
	readonly scheme: string;
	readonly fsPath: string;
}

/** Options the modal message overloads accept (`vscode.MessageOptions` shape). */
export interface MessageOptionsLike {
	readonly modal?: boolean;
	readonly detail?: string;
}

/** `vscode.InputBoxOptions`, as far as the host's call sites use them. */
export interface InputBoxOptionsLike {
	readonly prompt?: string;
	readonly placeHolder?: string;
	readonly value?: string;
	readonly password?: boolean;
	readonly ignoreFocusOut?: boolean;
}

/** `vscode.QuickPickItem`, as far as the host's call sites use it. */
export interface QuickPickItemLike {
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
}

/** `vscode.QuickPickOptions`, as far as the host's call sites use them. */
export interface QuickPickOptionsLike {
	readonly placeHolder?: string;
	readonly canPickMany?: boolean;
	readonly matchOnDescription?: boolean;
	readonly matchOnDetail?: boolean;
	readonly ignoreFocusOut?: boolean;
}

/** `vscode.SaveDialogOptions`, as far as the host's call sites use them. */
export interface SaveDialogOptionsLike {
	readonly defaultUri?: UriLike;
	readonly saveLabel?: string;
	readonly filters?: Readonly<{ [name: string]: ReadonlyArray<string> }>;
}

/** `vscode.OpenDialogOptions`, as far as the host's call sites use them. */
export interface OpenDialogOptionsLike {
	readonly canSelectFiles?: boolean;
	readonly canSelectFolders?: boolean;
	readonly canSelectMany?: boolean;
	readonly defaultUri?: UriLike;
	readonly openLabel?: string;
	readonly filters?: Readonly<{ [name: string]: ReadonlyArray<string> }>;
}

/** `vscode.ProgressLocation` value (a numeric enum) or a view-anchored location. */
export type ProgressLocationLike = number | { readonly viewId: string };

/** `vscode.ProgressOptions`, as far as the host's call sites use them. */
export interface ProgressOptionsLike {
	readonly location: ProgressLocationLike;
	readonly title?: string;
	readonly cancellable?: boolean;
}

/** `vscode.Progress<H>`: the reporter a running task receives. */
export interface ProgressLike {
	report(value: { readonly message?: string; readonly increment?: number }): void;
}

/** `vscode.CancellationToken`, structurally (its event answers a Disposable). */
export interface CancellationTokenLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): DisposableLike;
}

/**
 * The plain notification surface (no options overload): the signatures platform/notifications.ts
 * implements, and the shape of every fire-and-forget message the host shows today.
 */
export interface NotificationsPort {
	showInformationMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	showWarningMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	showErrorMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
}

/**
 * The full native-UI surface the host will route through (task 4.10's ESLint rule makes every
 * `vscode.window.show*` call outside platform/ illegal; INVENTORY.md lists the sites to absorb).
 */
export interface UiPort extends NotificationsPort {
	// --- Notifications (the full vscode surface: plain and options-bearing overloads) ---
	// The plain forms are re-declared (identical to NotificationsPort) so the options overloads
	// merge into the same overload set instead of conflicting with the inherited members.
	showInformationMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	showInformationMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	showWarningMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	showWarningMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	showErrorMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	showErrorMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;

	// --- Input ---
	/** Ask the user for free text (the askpass credential prompts, "search commits" query). */
	showInputBox(options?: InputBoxOptionsLike): Promise<string | undefined>;
	/** Ask the user to pick one (or, with canPickMany, several) items from a list. */
	showQuickPick<T extends string | QuickPickItemLike>(items: ReadonlyArray<T>, options?: QuickPickOptionsLike): Promise<T | undefined>;

	// --- File dialogs ---
	/** Ask where to save a file; resolves UNDEFINED when the user cancels. */
	showSaveDialog(options: SaveDialogOptionsLike): Promise<UriLike | undefined>;
	/** Ask for files/folders to open; resolves UNDEFINED when the user cancels. */
	showOpenDialog(options: OpenDialogOptionsLike): Promise<ReadonlyArray<UriLike> | undefined>;

	// --- Progress ---
	/** Run a task under a progress indication (notification or view-anchored). */
	withProgress<R>(options: ProgressOptionsLike, task: (progress: ProgressLike, token: CancellationTokenLike) => Thenable<R>): Promise<R>;
}

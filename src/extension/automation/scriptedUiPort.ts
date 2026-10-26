import {
	CancellationTokenLike, InputBoxOptionsLike, MessageOptionsLike, OpenDialogOptionsLike,
	ProgressLike, ProgressOptionsLike, QuickPickItemLike, QuickPickOptionsLike, SaveDialogOptionsLike,
	UiPort, UriLike
} from '../platform/uiPort';
import { MessageChoice } from '../platform/notifications';
import type { DisposableLike } from '../platform/config';
import { setScriptedUiPort } from '../platform/actions';

/**
 * The ScriptedUiPort (REFACTOR-PLAN §6.8.2, task 4.10): the automation/E2E build's UiPort
 * implementation. It answers every native interaction the host raises — modal confirmations,
 * input boxes, quick picks, save/open dialogs — from a per-scenario script, and records every
 * call (kind, title, what was offered, the answer given) so scenario assertions can check them.
 *
 * Answers are POSITIONAL: the scenario lists the answers in the order the dialogs are expected
 * to appear, and each call pops the next one. An answer whose `dialog` kind does not match the
 * call it answers is recorded as a mismatch (the call resolves cancelled) instead of silently
 * re-ordering the script. When the script runs dry:
 *   - strict mode (scenario runs, the default): the call resolves cancelled and is recorded
 *     `from: 'exhausted'` — the scenario's then-block sees the disagreement;
 *   - lenient mode (the suite runner's blanket installation): the call is answered with the
 *     default the former dialog auto-answer used (the primary button, the first item, a
 *     generated save path) and recorded `from: 'default'`.
 *
 * This module lives in src/automation and is bundled only by the automation build; the
 * production seam it installs through (utils/actions.ts's setScriptedUiPort) is the only piece
 * the default bundle carries.
 */

/** Which native surface one scripted answer is for. */
export type ScriptedDialogKind = 'message' | 'input' | 'quickPick' | 'save' | 'open';

/**
 * One scripted answer, an entry of a scenario's `answers` array (§6.8.3). Values may contain
 * `{{placeholder}}` references the runner expands against the live context before installing.
 */
export type ScriptedAnswer =
	| {
		readonly dialog: 'message';
		/** 'primary' (the first offered item), 'cancel' (dismiss), or an item's exact label/title. */
		readonly choose: 'primary' | 'cancel' | string;
	}
	| {
		readonly dialog: 'input';
		/** The text to submit; NULL dismisses the input box (Esc). */
		readonly text: string | null;
	}
	| {
		readonly dialog: 'quickPick';
		/** The item's index, its exact label, or 'cancel'. */
		readonly pick: number | string | 'cancel';
	}
	| {
		readonly dialog: 'save';
		/** The file path to save to; NULL cancels the dialog. */
		readonly path: string | null;
	}
	| {
		readonly dialog: 'open';
		/** The paths to open; NULL cancels the dialog. */
		readonly paths: readonly string[] | null;
	};

/** Which native surface a recorded call went through. */
export type UiCallKind = 'information' | 'warning' | 'error' | 'input' | 'quickPick' | 'save' | 'open' | 'progress';

/** Where a recorded call's answer came from. */
export type UiAnswerSource = 'script' | 'default' | 'exhausted' | 'mismatch';

/** One recorded native-UI call, for scenario assertions and failure evidence. */
export interface UiCallRecord {
	readonly seq: number;
	readonly kind: UiCallKind;
	/** The message (notifications), the prompt/placeHolder (input, pick) or the save/open label. */
	readonly title: string;
	/** What the call offered: choice labels, quick-pick item labels, dialog options — JSON-safe. */
	readonly options: Readonly<Record<string, unknown>>;
	/** The answer the port resolved the call with (UNDEFINED = cancelled/dismissed). */
	readonly answer: unknown;
	readonly source: UiAnswerSource;
}

/** How the port behaves when the script has no answer left for a call. */
export type ScriptedUiPortMode = 'strict' | 'lenient';

export interface ScriptedUiPortOptions {
	/** The scripted answers, in dialog order. */
	readonly answers?: readonly ScriptedAnswer[];
	/**
	 * 'strict' (default): a call the script has no answer for resolves cancelled and is recorded
	 * `exhausted`. 'lenient': it is answered with the default the former dialog auto-answer used
	 * (primary button / first item / generated save path).
	 */
	readonly mode?: ScriptedUiPortMode;
}

/** The label a message choice or quick-pick item is matched by: its own text, its `label`
 * (quick-pick items) or its `title` (message items). */
function choiceLabel(item: unknown): string {
	if (typeof item === 'string') return item;
	if (item !== null && typeof item === 'object') {
		const titled = item as { title?: unknown; label?: unknown };
		if (typeof titled.title === 'string') return titled.title;
		if (typeof titled.label === 'string') return titled.label;
	}
	return String(item);
}

/** A JSON-safe summary of the options a dialog/input/pick call carried. */
function summarizeOptions(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object') return {};
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>)) {
		const entry = (value as Record<string, unknown>)[key];
		out[key] = Array.isArray(entry) ? entry.map(choiceLabel) : entry;
	}
	return out;
}

/** Sequence keeping default save-path answers unique inside one process. */
let defaultSaveSeq = 1;

/** The lenient default for a save dialog: a unique .zip path under the dialog's default URI. */
function defaultSavePath(options: SaveDialogOptionsLike): string {
	const dir = options.defaultUri !== undefined ? options.defaultUri.fsPath : '.';
	const sep = dir.indexOf('\\') !== -1 ? '\\' : '/';
	return dir + (dir.endsWith(sep) ? '' : sep) + 'automation-archive-' + Date.now() + '-' + (defaultSaveSeq++) + '.zip';
}

/** The scripted port currently installed through the production seam (NULL when none is). */
let installed: ScriptedUiPort | null = null;

/** The scripted UiPort the automation/E2E builds inject over the production seam. */
export class ScriptedUiPort implements UiPort {
	private readonly mode: ScriptedUiPortMode;
	private script: readonly ScriptedAnswer[];
	private readonly records: UiCallRecord[] = [];
	private seq = 0;

	constructor(options: ScriptedUiPortOptions = {}) {
		this.mode = options.mode ?? 'strict';
		this.script = options.answers ?? [];
	}

	/* ---------------- Script management ---------------- */

	/** Replace the answer script (used when one port is re-armed per scenario). */
	public setAnswers(answers: readonly ScriptedAnswer[]): void {
		this.script = answers;
	}

	/** Every call recorded since construction (or the last resetRecords), in call order. */
	public recordedCalls(): readonly UiCallRecord[] {
		return this.records;
	}

	/** Clear the recorded calls (the script is replaced via setAnswers). */
	public resetRecords(): void {
		this.records.length = 0;
	}

	/**
	 * The message-kind records so far (information / warning / error) — the scripted counterpart
	 * of the dialog auto-answer's captured notifications, for the engine's expectNotifications
	 * checks. `since` slices to the calls after the given record count (an engine run's baseline).
	 */
	public notificationRecords(since: number = 0): readonly UiCallRecord[] {
		return this.records.slice(since).filter((record) => record.kind === 'information' || record.kind === 'warning' || record.kind === 'error');
	}

	/** How many message-kind calls offered a CHOICE the port answered (the modal-counterpart of the auto-answer's autoAnswered). */
	public answeredDialogCount(since: number = 0): number {
		return this.notificationRecords(since).filter((record) => Array.isArray(record.options.items) && record.options.items.length > 0).length;
	}

	/** The port installed through the production seam — the typed accessor the engine uses. */
	public static active(): ScriptedUiPort | null {
		return installed;
	}

	/* ---------------- Recording ---------------- */

	private record(kind: UiCallKind, title: string, options: Record<string, unknown>, answer: unknown, source: UiAnswerSource): void {
		this.records.push({ seq: ++this.seq, kind, title, options, answer, source });
	}

	/**
	 * Pop the next scripted answer and, when it exists, whether its kind matches `kind`. A
	 * mismatched answer is DISCARDED (recorded) — the script and the flow disagreeing must be
	 * loud, never papered over by skipping ahead to a kind that fits.
	 */
	private pop(kind: ScriptedDialogKind): { readonly answer: ScriptedAnswer | null; readonly mismatch: boolean } {
		const answer = this.script[0];
		if (answer === undefined) return { answer: null, mismatch: false };
		this.script = this.script.slice(1);
		return { answer, mismatch: answer.dialog !== kind };
	}

	/** The answer source and resolution for a call whose scripted answer was absent or mismatched. */
	private fallback(answer: ScriptedAnswer | null, mismatch: boolean, defaulted: () => unknown): { readonly answer: unknown; readonly source: UiAnswerSource } {
		if (mismatch) return { answer: undefined, source: 'mismatch' };
		if (answer !== null) return { answer: undefined, source: 'mismatch' };
		if (this.mode === 'lenient') return { answer: defaulted(), source: 'default' };
		return { answer: undefined, source: 'exhausted' };
	}

	/** Resolve a message-kind choice from the offered items (UNDEFINED = dismissed). */
	private chooseItem(choose: string, items: readonly unknown[]): unknown {
		if (choose === 'cancel' || items.length === 0) return undefined;
		if (choose === 'primary') return items[0];
		return items.find((item) => choiceLabel(item) === choose);
	}

	/* ---------------- UiPort ---------------- */

	public showInformationMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	public showInformationMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	public showInformationMessage<T extends MessageChoice>(message: string, ...rest: unknown[]): Promise<T | undefined> {
		return this.answerMessage('information', message, rest);
	}

	public showWarningMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	public showWarningMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	public showWarningMessage<T extends MessageChoice>(message: string, ...rest: unknown[]): Promise<T | undefined> {
		return this.answerMessage('warning', message, rest);
	}

	public showErrorMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined>;
	public showErrorMessage<T extends MessageChoice>(message: string, options: MessageOptionsLike, ...items: T[]): Promise<T | undefined>;
	public showErrorMessage<T extends MessageChoice>(message: string, ...rest: unknown[]): Promise<T | undefined> {
		return this.answerMessage('error', message, rest);
	}

	/** Shared message answering: strip the optional options object, then apply the script. */
	private answerMessage<T extends MessageChoice>(kind: UiCallKind, message: string, rest: unknown[]): Promise<T | undefined> {
		const options = rest.length > 0 && typeof rest[0] === 'object' && rest[0] !== null && !('title' in (rest[0] as object))
			? rest[0] as MessageOptionsLike
			: undefined;
		const items = (options === undefined ? rest : rest.slice(1)) as T[];
		const offered: Record<string, unknown> = { items: items.map(choiceLabel), ...(options !== undefined ? summarizeOptions(options) : {}) };
		const { answer, mismatch } = this.pop('message');
		if (answer !== null && !mismatch && answer.dialog === 'message') {
			const chosen = this.chooseItem(answer.choose, items);
			this.record(kind, message, offered, chosen, 'script');
			return Promise.resolve(chosen as (T | undefined));
		}
		const fell = this.fallback(answer, mismatch, () => (items.length > 0 ? items[0] : undefined));
		this.record(kind, message, offered, fell.answer, fell.source);
		return Promise.resolve(fell.answer as (T | undefined));
	}

	public showInputBox(options?: InputBoxOptionsLike): Promise<string | undefined> {
		const offered = summarizeOptions(options);
		const title = options?.prompt ?? options?.placeHolder ?? '';
		const { answer, mismatch } = this.pop('input');
		if (answer !== null && !mismatch && answer.dialog === 'input') {
			this.record('input', title, offered, answer.text === null ? undefined : answer.text, 'script');
			return Promise.resolve(answer.text === null ? undefined : answer.text);
		}
		const fell = this.fallback(answer, mismatch, () => options?.value ?? '');
		this.record('input', title, offered, fell.answer === undefined || fell.answer === null ? undefined : String(fell.answer), fell.source);
		return Promise.resolve(fell.answer === undefined || fell.answer === null ? undefined : String(fell.answer));
	}

	public showQuickPick<T extends string | QuickPickItemLike>(items: ReadonlyArray<T>, options?: QuickPickOptionsLike): Promise<T | undefined> {
		const offered: Record<string, unknown> = { items: items.map(choiceLabel), ...summarizeOptions(options) };
		const title = options?.placeHolder ?? '';
		const { answer, mismatch } = this.pop('quickPick');
		if (answer !== null && !mismatch && answer.dialog === 'quickPick') {
			const picked = answer.pick === 'cancel' ? undefined
				: typeof answer.pick === 'number' ? (answer.pick >= 0 && answer.pick < items.length ? items[answer.pick] : undefined)
					: items.find((item) => choiceLabel(item) === answer.pick);
			this.record('quickPick', title, offered, picked, 'script');
			return Promise.resolve(picked as (T | undefined));
		}
		const fell = this.fallback(answer, mismatch, () => (items.length > 0 ? items[0] : undefined));
		this.record('quickPick', title, offered, fell.answer, fell.source);
		return Promise.resolve(fell.answer as (T | undefined));
	}

	public showSaveDialog(options: SaveDialogOptionsLike): Promise<UriLike | undefined> {
		const offered = summarizeOptions(options);
		const title = options.saveLabel ?? '';
		const { answer, mismatch } = this.pop('save');
		if (answer !== null && !mismatch && answer.dialog === 'save') {
			const uri = answer.path === null ? undefined : { scheme: 'file', fsPath: answer.path };
			this.record('save', title, offered, uri, 'script');
			return Promise.resolve(uri);
		}
		const fell = this.fallback(answer, mismatch, () => ({ scheme: 'file', fsPath: defaultSavePath(options) }));
		this.record('save', title, offered, fell.answer, fell.source);
		return Promise.resolve(fell.answer as (UriLike | undefined));
	}

	public showOpenDialog(options: OpenDialogOptionsLike): Promise<ReadonlyArray<UriLike> | undefined> {
		const offered = summarizeOptions(options);
		const title = options.openLabel ?? '';
		const { answer, mismatch } = this.pop('open');
		if (answer !== null && !mismatch && answer.dialog === 'open') {
			const uris = answer.paths === null ? undefined : answer.paths.map((p) => ({ scheme: 'file', fsPath: p }));
			this.record('open', title, offered, uris, 'script');
			return Promise.resolve(uris);
		}
		const fell = this.fallback(answer, mismatch, () => (options.defaultUri !== undefined ? [options.defaultUri] : undefined));
		this.record('open', title, offered, fell.answer, fell.source);
		return Promise.resolve(fell.answer as (ReadonlyArray<UriLike> | undefined));
	}

	public withProgress<R>(options: ProgressOptionsLike, task: (progress: ProgressLike, token: CancellationTokenLike) => Thenable<R>): Promise<R> {
		// Progress is not a dialog: record it (a scenario may assert a long operation ran under
		// progress) and run the task to completion on a never-cancelled token.
		this.record('progress', options.title ?? '', summarizeOptions(options), 'ran', 'script');
		const token: CancellationTokenLike = {
			isCancellationRequested: false,
			onCancellationRequested: (_listener: () => void): DisposableLike => ({ dispose: () => { return; } })
		};
		return Promise.resolve(task({ report: () => { return; } }, token));
	}
}

/** The port installed through the production seam, if any (module-level accessor for the engine). */
export function activeScriptedUiPort(): ScriptedUiPort | null {
	return ScriptedUiPort.active();
}

/**
 * Install a ScriptedUiPort through the production seam (utils/actions.ts's setScriptedUiPort).
 * Returns the restore function that reinstates whatever was installed before (usually nothing).
 * Only one scripted port is installed at a time — a nested install replaces the previous one
 * until restored.
 */
export function installScriptedUiPort(port: ScriptedUiPort): () => void {
	const previous = setScriptedUiPort(port);
	installed = port;
	return () => {
		if (ScriptedUiPort.active() === port) {
			setScriptedUiPort(previous);
			installed = previous instanceof ScriptedUiPort ? previous : null;
		}
	};
}

/** Remove whatever scripted port is installed (idempotent). */
export function uninstallScriptedUiPort(): void {
	setScriptedUiPort(null);
	installed = null;
}

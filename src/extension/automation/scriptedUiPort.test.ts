import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The `vscode` module stub: importing the production seam (platform/actions.ts, which scriptedUiPort
 * installs through) transitively imports vscode; none of it may run here, and the port's answers
 * must not depend on it (the scripted path never touches the window).
 */
vi.mock('vscode', () => ({
	version: '1.90.0',
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	ProgressLocation: { SourceControl: 1, Notification: 15 },
	window: {},
	Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p, path: p }) },
	env: { clipboard: {}, openExternal: () => Promise.resolve(true) },
	commands: { executeCommand: () => Promise.resolve(undefined) },
	workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d, has: () => false, inspect: () => undefined, update: () => Promise.resolve() }) }
}));

import { installScriptedUiPort, ScriptedUiPort, UiCallRecord, uninstallScriptedUiPort } from './scriptedUiPort';
import { uiPort } from '../platform/actions';

/** The record of one call, ignoring the sequence number. */
function shape(record: UiCallRecord): Omit<UiCallRecord, 'seq'> {
	const { seq: _seq, ...rest } = record;
	return rest;
}

afterEach(() => {
	uninstallScriptedUiPort();
});

describe('ScriptedUiPort messages', () => {
	it('answers confirmations with the primary item', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'primary' }] });
		await expect(port.showWarningMessage('Delete branch?', 'Delete', 'Cancel')).resolves.toBe('Delete');
		expect(port.recordedCalls().map(shape)).toEqual([
			{ kind: 'warning', title: 'Delete branch?', options: { items: ['Delete', 'Cancel'] }, answer: 'Delete', source: 'script' }
		]);
	});

	it('answers cancellation with undefined', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'cancel' }] });
		await expect(port.showWarningMessage('Reset?', { modal: true }, 'Reset', 'Abort')).resolves.toBeUndefined();
		expect(port.recordedCalls()[0].source).toBe('script');
		expect(port.recordedCalls()[0].answer).toBeUndefined();
	});

	it('answers by an item\'s exact label, including MessageItem titles', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'Copy Message' }] });
		const copy = { title: 'Copy Message' };
		await expect(port.showErrorMessage<{ title: string }>('Oops', { title: 'Dismiss' }, copy)).resolves.toBe(copy);
		expect(port.recordedCalls()[0].answer).toBe(copy);
	});

	it('treats a label that matches no item as a dismissal (invalid input)', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'No Such Button' }] });
		await expect(port.showInformationMessage('Hi', 'Yes', 'No')).resolves.toBeUndefined();
		expect(port.recordedCalls()[0].answer).toBeUndefined();
	});

	it('records the modal options of the options overload', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'primary' }] });
		await port.showErrorMessage('Destructive', { modal: true, detail: 'the detail' }, 'Do It');
		expect(port.recordedCalls()[0].options).toEqual({ items: ['Do It'], modal: true, detail: 'the detail' });
	});
});

describe('ScriptedUiPort input box', () => {
	it('submits the scripted text', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'input', text: 'feature-x' }] });
		await expect(port.showInputBox({ prompt: 'Branch name', value: 'main' })).resolves.toBe('feature-x');
		expect(port.recordedCalls()[0]).toMatchObject({ kind: 'input', title: 'Branch name', source: 'script' });
	});

	it('dismisses with NULL text (the cancel branch)', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'input', text: null }] });
		await expect(port.showInputBox({ prompt: 'Search' })).resolves.toBeUndefined();
	});

	it('submits empty text as empty (an invalid input the host flows treat as cancel)', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'input', text: '' }] });
		await expect(port.showInputBox({ prompt: 'Search' })).resolves.toBe('');
	});
});

describe('ScriptedUiPort quick pick', () => {
	it('picks by index, by label and cancels', async () => {
		const items = ['one', 'two', 'three'];
		const byIndex = new ScriptedUiPort({ answers: [{ dialog: 'quickPick', pick: 1 }] });
		await expect(byIndex.showQuickPick(items, { placeHolder: 'Pick' })).resolves.toBe('two');
		const byLabel = new ScriptedUiPort({ answers: [{ dialog: 'quickPick', pick: 'three' }] });
		await expect(byLabel.showQuickPick(items)).resolves.toBe('three');
		const cancelled = new ScriptedUiPort({ answers: [{ dialog: 'quickPick', pick: 'cancel' }] });
		await expect(cancelled.showQuickPick(items)).resolves.toBeUndefined();
		expect(byIndex.recordedCalls()[0].options).toEqual({ items: ['one', 'two', 'three'], placeHolder: 'Pick' });
	});

	it('treats an out-of-range index as a dismissal (invalid input)', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'quickPick', pick: 9 }] });
		await expect(port.showQuickPick(['a', 'b'])).resolves.toBeUndefined();
		expect(port.recordedCalls()[0].answer).toBeUndefined();
	});

	it('picks quick-pick items with label/detail fields by their label', async () => {
		const items = [{ label: 'feature/a', description: 'the feature' }, { label: 'main' }];
		const port = new ScriptedUiPort({ answers: [{ dialog: 'quickPick', pick: 'feature/a' }] });
		await expect(port.showQuickPick(items, { matchOnDescription: true })).resolves.toBe(items[0]);
	});
});

describe('ScriptedUiPort file dialogs', () => {
	it('answers the save dialog with the scripted path', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'save', path: 'E:/out/archive.zip' }] });
		await expect(port.showSaveDialog({ saveLabel: 'Save', filters: { Zip: ['zip'] } })).resolves.toEqual({ scheme: 'file', fsPath: 'E:/out/archive.zip' });
		expect(port.recordedCalls()[0]).toMatchObject({ kind: 'save', title: 'Save', source: 'script' });
	});

	it('cancels the save dialog with NULL path', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'save', path: null }] });
		await expect(port.showSaveDialog({ saveLabel: 'Save' })).resolves.toBeUndefined();
	});

	it('answers the open dialog with the scripted paths and cancels with NULL', async () => {
		const open = new ScriptedUiPort({ answers: [{ dialog: 'open', paths: ['E:/repo-a', 'E:/repo-b'] }] });
		await expect(open.showOpenDialog({ canSelectFolders: true })).resolves.toEqual([
			{ scheme: 'file', fsPath: 'E:/repo-a' }, { scheme: 'file', fsPath: 'E:/repo-b' }
		]);
		const cancel = new ScriptedUiPort({ answers: [{ dialog: 'open', paths: null }] });
		await expect(cancel.showOpenDialog({})).resolves.toBeUndefined();
	});
});

describe('ScriptedUiPort script discipline', () => {
	it('strict mode answers an unscripted call as cancelled and records exhaustion', async () => {
		const port = new ScriptedUiPort({ answers: [] });
		await expect(port.showWarningMessage('Unplanned', 'OK')).resolves.toBeUndefined();
		expect(port.recordedCalls()[0]).toMatchObject({ source: 'exhausted', answer: undefined });
	});

	it('lenient mode answers an unscripted call with the primary default', async () => {
		const port = new ScriptedUiPort({ mode: 'lenient' });
		await expect(port.showWarningMessage('Unplanned', 'OK', 'No')).resolves.toBe('OK');
		expect(port.recordedCalls()[0].source).toBe('default');
		await expect(port.showQuickPick(['a', 'b'])).resolves.toBe('a');
		const save = await port.showSaveDialog({ defaultUri: { scheme: 'file', fsPath: 'E:/repo' } });
		expect(save?.fsPath.startsWith('E:/repo')).toBe(true);
		expect(save?.fsPath.endsWith('.zip')).toBe(true);
		await expect(port.showInputBox({ value: 'prefilled' })).resolves.toBe('prefilled');
	});

	it('discards and records an answer whose dialog kind mismatches the call', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'input', text: 'wrong kind' }] });
		await expect(port.showWarningMessage('Confirm?', 'Yes')).resolves.toBeUndefined();
		expect(port.recordedCalls()[0]).toMatchObject({ source: 'mismatch', answer: undefined });
		// The mismatched answer was consumed: the next call sees an exhausted script.
		await expect(port.showInputBox()).resolves.toBeUndefined();
		expect(port.recordedCalls()[1].source).toBe('exhausted');
	});

	it('consumes answers positionally across mixed dialog kinds', async () => {
		const port = new ScriptedUiPort({
			answers: [{ dialog: 'message', choose: 'primary' }, { dialog: 'save', path: 'E:/out/a.tar' }, { dialog: 'message', choose: 'cancel' }]
		});
		await expect(port.showWarningMessage('Archive this ref?', 'Archive')).resolves.toBe('Archive');
		await expect(port.showSaveDialog({ saveLabel: 'Save' })).resolves.toMatchObject({ fsPath: 'E:/out/a.tar' });
		await expect(port.showErrorMessage('Done?', 'Open')).resolves.toBeUndefined();
		expect(port.recordedCalls().every((record) => record.source === 'script')).toBe(true);
	});

	it('re-arms with setAnswers and clears records with resetRecords', async () => {
		const port = new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'primary' }] });
		await port.showInformationMessage('One', 'OK');
		port.setAnswers([{ dialog: 'message', choose: 'cancel' }]);
		port.resetRecords();
		await expect(port.showInformationMessage('Two', 'OK')).resolves.toBeUndefined();
		expect(port.recordedCalls()).toHaveLength(1);
	});
});

describe('ScriptedUiPort progress and the installation seam', () => {
	it('runs the task under withProgress and records it', async () => {
		const port = new ScriptedUiPort();
		const result = await port.withProgress({ location: 15, title: 'Fetching' }, (progress) => {
			progress.report({ message: 'halfway' });
			return Promise.resolve(42);
		});
		expect(result).toBe(42);
		expect(port.recordedCalls()[0]).toMatchObject({ kind: 'progress', title: 'Fetching' });
	});

	it('installs through the production seam and routes the host uiPort to the script', async () => {
		const restore = installScriptedUiPort(new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'Retry' }] }));
		try {
			expect(ScriptedUiPort.active()).not.toBeNull();
			// The production port's methods dispatch to the scripted override (platform/actions.ts).
			await expect(uiPort.showWarningMessage('Network down?', 'Retry', 'Ignore')).resolves.toBe('Retry');
			expect(ScriptedUiPort.active()!.recordedCalls()[0]).toMatchObject({ kind: 'warning', answer: 'Retry', source: 'script' });
		} finally {
			restore();
		}
		expect(ScriptedUiPort.active()).toBeNull();
		// After restore the production port answers from the window again (undefined: no items
		// resolve against the empty stub, and no scripted port is consulted).
		await expect(uiPort.showWarningMessage('After restore', 'OK')).resolves.toBeUndefined();
		expect(ScriptedUiPort.active()).toBeNull();
	});

	it('a nested install replaces the previous scripted port until restored', async () => {
		const outer = new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'Outer' }] });
		const restoreOuter = installScriptedUiPort(outer);
		const restoreInner = installScriptedUiPort(new ScriptedUiPort({ answers: [{ dialog: 'message', choose: 'Inner' }] }));
		await expect(uiPort.showInformationMessage('Who?', 'Outer', 'Inner')).resolves.toBe('Inner');
		restoreInner();
		expect(ScriptedUiPort.active()).toBe(outer);
		await expect(uiPort.showInformationMessage('Who now?', 'Outer')).resolves.toBe('Outer');
		restoreOuter();
		expect(ScriptedUiPort.active()).toBeNull();
	});
});

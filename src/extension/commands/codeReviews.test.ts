/**
 * The workspace code review commands (task 4.10 migration): the review pickers run through the
 * injected UiPort, and their branch behavior must be unchanged - cancelling the pick is a no-op
 * (INVENTORY.md #13), picking a review ends it, and resuming one re-opens the view on its
 * commits. Plain messages run against a recording fake of the `vscode` module; the GitGraphView
 * module is mocked so no webview is created.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
	const calls: Array<{ name: string, args: unknown[] }> = [];
	const record = (name: string) => (...args: unknown[]) => {
		calls.push({ name: name, args: args });
		return Promise.resolve(undefined);
	};
	const settings: { [key: string]: unknown } = {};
	return {
		settings: settings,
		version: '1.90.0',
		ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		Uri: { file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }) },
		env: { language: 'en' },
		window: {
			activeTextEditor: undefined,
			showInformationMessage: record('showInformationMessage'),
			showWarningMessage: record('showWarningMessage'),
			showErrorMessage: record('showErrorMessage')
		},
		workspace: {
			getConfiguration: (section: string) => ({
				get: (key: string, defaultValue?: unknown) => {
					const value = settings[section + '.' + key];
					return value === undefined ? defaultValue : value;
				},
				has: () => false,
				inspect: () => undefined,
				update: () => Promise.resolve()
			})
		},
		callsTo: (name: string) => calls.filter((call) => call.name === name).map((call) => call.args),
		resetCalls: () => { calls.length = 0; }
	};
});

vi.mock('vscode', () => vscodeMock);

const created: unknown[][] = vi.hoisted(() => []);
vi.mock('../../gitGraphView', () => ({
	GitGraphView: {
		createOrShow: (...args: unknown[]) => { created.push(args); }
	}
}));

import { t } from '../../i18n';
import { ErrorInfo } from '../../types';
import { endSpecificWorkspaceCodeReview, resumeWorkspaceCodeReview } from './codeReviews';
import type { CommandHost } from './context';
import type { QuickPickItemLike, UiPort } from '../../extension/platform/uiPort';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* The pick flows settle over several promise hops (the review items load asynchronously);
 * poll for the settled result instead of a fixed wait (the bufferedQueue.test.ts pattern). */
const waitFor = async (condition: () => boolean, timeoutMs = 2000) => {
	for (let elapsed = 0; !condition() && elapsed < timeoutMs; elapsed += 10) await tick(10);
};

/** A fake native-UI port recording every dialog; each queued answer is consumed by the next
 * dialog in order (an Error rejects; an exhausted queue answers undefined - a dismissed dialog). */
class FakeUi {
	public readonly calls: Array<{ method: string, args: unknown[] }> = [];
	private readonly answers: unknown[] = [];

	public answer(...values: unknown[]) {
		this.answers.push(...values);
	}

	public showInformationMessage(message: string, ...items: unknown[]) {
		return this.respond('showInformationMessage', [message, ...items]);
	}

	public showWarningMessage(message: string, ...items: unknown[]) {
		return this.respond('showWarningMessage', [message, ...items]);
	}

	public showErrorMessage(message: string, ...items: unknown[]) {
		return this.respond('showErrorMessage', [message, ...items]);
	}

	public showInputBox(options?: unknown) {
		return this.respond('showInputBox', [options]);
	}

	public showQuickPick(items: ReadonlyArray<QuickPickItemLike | string>, options?: unknown) {
		return this.respond('showQuickPick', [items, options]);
	}

	private respond(method: string, args: unknown[]) {
		this.calls.push({ method: method, args: args });
		if (this.answers.length === 0) return Promise.resolve(undefined);
		const answer = this.answers.shift();
		return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
	}
}

/** A CommandHost double with one known repository and a scripted review set. */
function fakeHost(codeReviews: { [repo: string]: { [id: string]: { lastActive: number } } }, endResult: ErrorInfo = null) {
	const ended: Array<[string, string]> = [];
	const host = {
		context: { extensionPath: '/ext' },
		dataSource: { getCommitSubject: async () => 'the subject' },
		extensionState: {
			getCodeReviews: () => codeReviews,
			endCodeReview: async (repo: string, id: string) => {
				ended.push([repo, id]);
				return endResult;
			}
		},
		repoManager: { getRepos: () => ({ '/repo': { name: 'repo' } }) }
	};
	return { host: host as unknown as CommandHost, ended: ended };
}

const oneReview = { '/repo': { 'aaaaaaaa-bbbbbbbb': { lastActive: 1000 } } };
/** The pick item the flow must offer for {@link oneReview} (only the fields the handler reads). */
const thePick = { codeReviewRepo: '/repo', codeReviewId: 'aaaaaaaa-bbbbbbbb', label: 'repo: aaaaaaaa ↔ bbbbbbbb' };

beforeEach(() => {
	vscodeMock.resetCalls();
	created.length = 0;
});

describe('endSpecificWorkspaceCodeReview', () => {
	it('reports when no code review is in progress', () => {
		const { host } = fakeHost({});
		endSpecificWorkspaceCodeReview(host);

		expect(vscodeMock.callsTo('showErrorMessage')).toEqual([[t('noCodeReviewsInProgress')]]);
	});

	it('cancelling the pick is a no-op', async () => {
		const { host, ended } = fakeHost(oneReview);
		const ui = new FakeUi(); // dismissed pick

		endSpecificWorkspaceCodeReview(host, ui as unknown as UiPort);
		await waitFor(() => ui.calls.length > 0);

		expect(ended).toEqual([]);
		expect(ui.calls[0]!.method).toBe('showQuickPick');
		expect(ui.calls[0]!.args[1]).toEqual({ placeHolder: t('selectCodeReviewToEnd'), canPickMany: false });
		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([]);
	});

	it('picking a review ends it and confirms', async () => {
		const { host, ended } = fakeHost(oneReview);
		const ui = new FakeUi();
		ui.answer(thePick);

		endSpecificWorkspaceCodeReview(host, ui as unknown as UiPort);
		await waitFor(() => ended.length > 0);

		expect(ended).toEqual([['/repo', 'aaaaaaaa-bbbbbbbb']]);
		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([[t('endedCodeReview', thePick.label)]]);
	});

	it('a failed end is reported as an error', async () => {
		const { host } = fakeHost(oneReview, 'the error');
		const ui = new FakeUi();
		ui.answer(thePick);

		endSpecificWorkspaceCodeReview(host, ui as unknown as UiPort);
		await waitFor(() => vscodeMock.callsTo('showErrorMessage').length > 0);

		expect(vscodeMock.callsTo('showErrorMessage')).toEqual([['the error']]);
	});
});

describe('resumeWorkspaceCodeReview', () => {
	it('cancelling the pick opens no view', async () => {
		const { host } = fakeHost(oneReview);
		const ui = new FakeUi();

		resumeWorkspaceCodeReview(host, ui as unknown as UiPort);
		await waitFor(() => ui.calls.length > 0);

		expect(created).toEqual([]);
	});

	it('picking a comparison review re-opens the view on both commits', async () => {
		const { host } = fakeHost(oneReview);
		const ui = new FakeUi();
		ui.answer(thePick);

		resumeWorkspaceCodeReview(host, ui as unknown as UiPort);
		await waitFor(() => created.length > 0);

		expect(created.length).toBe(1);
		expect(created[0]![8]).toEqual({
			repo: '/repo',
			commitDetails: { commitHash: 'bbbbbbbb', compareWithHash: 'aaaaaaaa' }
		});
	});
});

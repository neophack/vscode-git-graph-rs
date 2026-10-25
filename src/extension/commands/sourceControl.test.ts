/**
 * The Source Control view commands (task 4.10 migration): the destructive "reset to remote"
 * confirm runs through the injected UiPort as a modal dialog whose cancel branch must abort
 * the reset (INVENTORY.md #5); the amend flow and the plain completion messages keep their
 * behavior. Messages run against a recording fake of the `vscode` module.
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

import { ErrorInfo } from '../../types';
import { t } from '../../i18n';
import { amendLastCommit, resetCurrentBranchToRemote } from './sourceControl';
import type { CommandHost } from './context';
import type { UiPort } from '../../extension/platform/uiPort';

/** A fake native-UI port recording every dialog; a queued function answer is called with the
 * recorded args, an Error rejects, an exhausted queue answers undefined (a dismissed dialog). */
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

	public showQuickPick(items: unknown, options?: unknown) {
		return this.respond('showQuickPick', [items, options]);
	}

	private respond(method: string, args: unknown[]) {
		this.calls.push({ method: method, args: args });
		if (this.answers.length === 0) return Promise.resolve(undefined);
		const answer = this.answers.shift();
		if (typeof answer === 'function') return Promise.resolve((answer as (...callArgs: unknown[]) => unknown)(...args));
		return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
	}
}

/** A CommandHost double with one known repository and a scripted reset/amend outcome. */
function fakeHost(upstream: string | null, resetResult: ErrorInfo = null, amendResult: ErrorInfo = null) {
	const resets: string[] = [];
	const amends: string[] = [];
	const host = {
		context: { extensionPath: '/ext' },
		avatarManager: {},
		repo: {
			read: { getCurrentBranchUpstream: async () => upstream },
			write: {
				policies: { signCommits: false, signTags: false },
				run: async (_repo: string, op: { steps?: { argv?: string[] }[] }) => {
					const argv = (op.steps ?? []).map((step) => step.argv ?? []).flat();
					if (argv.includes('--amend')) {
						amends.push(argv.join(' '));
						return amendResult;
					}
					resets.push(argv.join(' '));
					return resetResult;
				}
			}
		},
		extensionState: {},
		logger: { log: () => { }, logError: () => { } },
		repoManager: { getRepos: () => ({ '/repo': { name: 'repo' } }) },
		gitExecutable: { path: 'git', version: 'git' }
	};
	return { host: host as unknown as CommandHost, resets: resets, amends: amends };
}

beforeEach(() => {
	vscodeMock.resetCalls();
});

describe('resetCurrentBranchToRemote', () => {
	it('reports when the branch has no upstream', async () => {
		const { host, resets } = fakeHost(null);
		const ui = new FakeUi();

		await resetCurrentBranchToRemote(host, undefined, ui as unknown as UiPort);

		expect(resets).toEqual([]);
		expect(vscodeMock.callsTo('showErrorMessage')).toEqual([[t('noUpstreamBranch')]]);
	});

	it('the modal confirm offers the single button and cancelling aborts the reset', async () => {
		const { host, resets } = fakeHost('origin/main');
		const ui = new FakeUi(); // dismissed modal

		await resetCurrentBranchToRemote(host, undefined, ui as unknown as UiPort);

		expect(ui.calls).toEqual([{
			method: 'showWarningMessage',
			args: [t('resetToRemoteConfirm', 'origin/main'), { modal: true }, t('resetToRemoteButton')]
		}]);
		expect(resets).toEqual([]);
		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([]);
	});

	it('confirming the modal soft resets the branch to its upstream and confirms', async () => {
		const { host, resets } = fakeHost('origin/main');
		const ui = new FakeUi();
		ui.answer(t('resetToRemoteButton'));

		await resetCurrentBranchToRemote(host, undefined, ui as unknown as UiPort);

		expect(resets).toEqual([['reset', '--soft', '@{upstream}'].join(' ')]);
		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([[t('resetToRemoteDone', 'origin/main')]]);
	});

	it('a failed reset is reported as an error', async () => {
		const { host } = fakeHost('origin/main', 'the error');
		const ui = new FakeUi();
		ui.answer(t('resetToRemoteButton'));

		await resetCurrentBranchToRemote(host, undefined, ui as unknown as UiPort);

		expect(vscodeMock.callsTo('showErrorMessage')).toEqual([[t('unableToResetToRemote', 'the error')]]);
	});
});

describe('amendLastCommit', () => {
	it('amends the last commit of the repository and confirms, or reports the failure', async () => {
		const success = fakeHost('origin/main');
		await amendLastCommit(success.host, undefined);
		expect(success.amends).toEqual([['commit', '--amend', '--no-edit'].join(' ')]);
		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([[t('amendedLastCommit', 'repo')]]);

		vscodeMock.resetCalls();
		const failure = fakeHost('origin/main', null, 'the error');
		await amendLastCommit(failure.host, undefined);
		expect(vscodeMock.callsTo('showErrorMessage')).toEqual([[t('unableToAmendLastCommit', 'the error')]]);
	});
});

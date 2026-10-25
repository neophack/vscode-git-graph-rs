/**
 * The Gerrit command flows (task 4.10 migration): the push flow's branches around the
 * Change-Id amend confirm (INVENTORY.md #2 - confirm amends and pushes, cancel aborts the
 * whole flow) and the "Open Change" action of the pushed-with-url notification (INVENTORY.md
 * #1). The interactive dialogs run through an injected fake UiPort; the plain messages and the
 * external-url open run against a recording fake of the `vscode` module.
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
		Uri: {
			file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
			parse: (u: string) => ({ fsPath: u, path: u, scheme: 'https' })
		},
		env: { language: 'en', openExternal: record('env.openExternal') },
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

import { t } from '../../i18n';
import { gerritPushRef } from './gerrit';
import type { CommandHost } from './context';
import type { UiPort } from '../../extension/platform/uiPort';

const repoArg = { rootUri: { scheme: 'file', fsPath: '/repo' } };

/** A fake native-UI port: records every dialog and answers a scripted value (a function is
 * called with the recorded args; an Error rejects; an exhausted queue answers undefined). */
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

/** The git output each queried command answers with (stdout). */
function stdoutFor(args: string[]): string {
	switch (args[0]) {
		case 'rev-parse': return 'main';
		case 'log': return 'commit subject\n';
		case 'branch': return '';
		case 'show': return 'tree\nparent\nAuthor <a@x> 1\nCommitter <c@x> 2\nsubject\n\nbody\n';
		default: return '';
	}
}

/** A CommandHost double whose runner records the git calls it serves. */
function fakeHost(pushStderr: string, pushError: string | null = null) {
	const gitCalls: Array<{ args: string[], repo: string }> = [];
	const runCalls: Array<{ args: string[], repo: string }> = [];
	const gitRunner = {
		gitOutput: async (args: string[], _repo: string, map: (stdout: string) => unknown) => map(stdoutFor(args)),
		gitOutputWithStderr: async (args: string[], repo: string, map: (stdout: string, stderr: string) => unknown) => {
			gitCalls.push({ args: args, repo: repo });
			if (pushError !== null) throw new Error(pushError);
			return map('', pushStderr);
		},
		runGitCommand: async (args: string[], repo: string) => {
			runCalls.push({ args: args, repo: repo });
			return null;
		}
	};
	const host = {
		context: { extensionPath: '/ext' },
		avatarManager: {},
		gitRunner: gitRunner,
		gerrit: { installHook: async () => ({ error: null, installed: true }) },
		extensionState: {},
		logger: { log: () => { }, logError: () => { } },
		repoManager: {
			getKnownRepo: async () => '/repo',
			getRepoContainingFile: () => null,
			getRepos: () => ({ '/repo': { name: 'repo' } })
		},
		gitExecutable: { path: 'git', version: 'git version 2.45' }
	};
	return { host: host as unknown as CommandHost, gitCalls: gitCalls, runCalls: runCalls };
}

beforeEach(() => {
	vscodeMock.resetCalls();
});

describe('gerritPushRef', () => {
	it('confirm amends the Change-Id onto HEAD and pushes to refs/for/<branch>', async () => {
		vscodeMock.settings['git-graph-rs.gerrit.remote'] = 'origin';
		const { host, gitCalls, runCalls } = fakeHost('');
		const ui = new FakeUi();
		ui.answer(t('gerritAmendAndPushButton'));

		await gerritPushRef(host, repoArg, ui as unknown as UiPort);

		expect(ui.calls).toEqual([{
			method: 'showInformationMessage',
			args: [ui.calls[0]!.args[0], t('gerritAmendAndPushButton'), t('gerritCancel')]
		}]);
		expect(ui.calls[0]!.args[0]).toContain('Change-Id');
		expect(runCalls).toEqual([{
			args: ['commit', '--amend', '-m', expect.stringContaining('Change-Id: ')],
			repo: '/repo'
		}]);
		expect(gitCalls).toEqual([{ args: ['push', 'origin', 'HEAD:refs/for/main'], repo: '/repo' }]);
		expect(vscodeMock.callsTo('showErrorMessage')).toEqual([]);
	});

	it('cancel aborts the flow: no amend, no push, and the localized abort error is shown', async () => {
		vscodeMock.settings['git-graph-rs.gerrit.remote'] = 'origin';
		const { host, gitCalls, runCalls } = fakeHost('');
		const ui = new FakeUi(); // the queue is empty, so the confirm dialog is dismissed

		await gerritPushRef(host, repoArg, ui as unknown as UiPort);

		expect(runCalls).toEqual([]);
		expect(gitCalls).toEqual([]);
		expect(vscodeMock.callsTo('showErrorMessage')).toEqual([[t('gerritAmendAborted')]]);
		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([]);
	});

	it('a pushed change url is offered as the "Open Change" action and opens on confirmation', async () => {
		const url = 'https://host/c/repo/+/123';
		const { host, gitCalls } = fakeHost('remote: ' + url);
		const ui = new FakeUi();
		ui.answer(t('gerritAmendAndPushButton'), t('gerritOpenChange'));

		await gerritPushRef(host, repoArg, ui as unknown as UiPort);

		expect(gitCalls).toEqual([{ args: ['push', 'origin', 'HEAD:refs/for/main'], repo: '/repo' }]);
		expect(ui.calls[1]).toEqual({
			method: 'showInformationMessage',
			args: [t('gerritPushedWithUrl', url), t('gerritOpenChange')]
		});
		expect(vscodeMock.callsTo('env.openExternal')).toEqual([[{ fsPath: url, path: url, scheme: 'https' }]]);
	});

	it('dismissing the "Open Change" notification opens nothing', async () => {
		const { host } = fakeHost('remote: https://host/c/repo/+/123');
		const ui = new FakeUi();
		ui.answer(t('gerritAmendAndPushButton')); // confirm the amend; dismiss the notification

		await gerritPushRef(host, repoArg, ui as unknown as UiPort);

		expect(vscodeMock.callsTo('env.openExternal')).toEqual([]);
	});

	it('a push without a change url in its report answers with the plain pushed message', async () => {
		const { host } = fakeHost('');
		const ui = new FakeUi();
		ui.answer(t('gerritAmendAndPushButton'));

		await gerritPushRef(host, repoArg, ui as unknown as UiPort);

		expect(ui.calls.length).toBe(1); // only the amend confirm
		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([[t('gerritPushed', 'main', 'origin')]]);
	});
});

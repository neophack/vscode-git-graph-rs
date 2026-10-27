/**
 * The commit-search command: the repo/query/commit pickers run through
 * the injected UiPort with their branch behavior unchanged - a dismissed repo pick never
 * reaches the query input, an empty query never searches, an empty result reports, and a
 * picked commit opens the view on it (INVENTORY.md #15-#17). Plain messages run against a
 * recording fake of the `vscode` module; the GitGraphView module is mocked.
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

const created: unknown[][] = [];

import { t } from '../platform/i18n';
import { searchCommits } from './commits';
import type { CommandHost } from './context';
import type { UiPort } from '../platform/uiPort';

/** A fake native-UI port recording every dialog; a queued function answer is called with the
 * recorded args (so a pick can echo the offered items), an Error rejects, else undefined. */
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

/** A CommandHost double with the given repositories and a scripted search result. */
function fakeHost(repos: { [repo: string]: { name: string } }, commits: Array<{ hash: string, author: string, date: number, message: string }>) {
	const searches: Array<[string, string]> = [];
	const host = {
		context: { extensionPath: '/ext' },
		panels: { open: (loadViewTo: unknown) => { created.push([loadViewTo]); } },
		avatarManager: {},
		repo: {
			read: {
				searchHistory: async (repo: string, query: string) => {
					searches.push([repo, query]);
					return commits;
				}
			}
		},
		extensionState: {},
		logger: { log: () => { }, logError: () => { } },
		repoManager: { getRepos: () => repos },
		gitExecutable: { path: 'git', version: 'git' }
	};
	return { host: host as unknown as CommandHost, searches: searches };
}

const oneRepo = { '/repo': { name: 'repo' } };
const twoRepos = { '/b': { name: '' }, '/a': { name: 'a' } };

beforeEach(() => {
	vscodeMock.resetCalls();
	created.length = 0;
});

describe('searchCommits', () => {
	it('with several repositories it asks which to search, and dismissing it aborts', async () => {
		const { host, searches } = fakeHost(twoRepos, []);
		const ui = new FakeUi();

		await searchCommits(host, ui as unknown as UiPort);

		expect(ui.calls).toEqual([{
			method: 'showQuickPick',
			args: [['/a', '/b'], { placeHolder: t('selectRepoToSearch') }]
		}]);
		expect(searches).toEqual([]);
	});

	it('an empty (or whitespace) query never reaches the history search', async () => {
		const { host, searches } = fakeHost(oneRepo, []);
		const ui = new FakeUi();
		ui.answer('   ');

		await searchCommits(host, ui as unknown as UiPort);

		expect(ui.calls[0]!.method).toBe('showInputBox');
		expect(ui.calls[0]!.args[0]).toEqual({ prompt: t('searchCommitsPrompt'), placeHolder: t('searchCommitsPlaceholder') });
		expect(searches).toEqual([]);
	});

	it('an empty search result reports "no commits found"', async () => {
		const { host } = fakeHost(oneRepo, []);
		const ui = new FakeUi();
		ui.answer('query');

		await searchCommits(host, ui as unknown as UiPort);

		expect(vscodeMock.callsTo('showInformationMessage')).toEqual([[t('noCommitsFound')]]);
	});

	it('picking a found commit opens the view on it', async () => {
		const { host, searches } = fakeHost(oneRepo, [{ hash: '0123456789abcdef', author: 'me', date: 0, message: 'the message' }]);
		const ui = new FakeUi();
		ui.answer('query');
		ui.answer({ label: '01234567', description: 'the message', commitHash: '0123456789abcdef' });

		await searchCommits(host, ui as unknown as UiPort);

		expect(searches).toEqual([['/repo', 'query']]);
		expect(ui.calls[1]).toEqual({
			method: 'showQuickPick',
			args: [[{
				label: '01234567',
				description: 'the message',
				detail: 'me - ' + new Date(0).toLocaleString(),
				commitHash: '0123456789abcdef'
			}], {
				placeHolder: t('selectCommitToView'),
				matchOnDescription: true,
				matchOnDetail: true
			}]
		});
		expect(created.length).toBe(1);
		expect(created[0]![0]).toEqual({ repo: '/repo', findCommitHash: '0123456789abcdef' });
	});

	it('dismissing the commit pick opens no view', async () => {
		const { host } = fakeHost(oneRepo, [{ hash: '0123456789abcdef', author: 'me', date: 0, message: 'the message' }]);
		const ui = new FakeUi();
		ui.answer('query'); // then the pick is dismissed

		await searchCommits(host, ui as unknown as UiPort);

		expect(created).toEqual([]);
	});
});

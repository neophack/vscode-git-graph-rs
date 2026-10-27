/**
 * The Visual Studio Code command wrappers of src/utils/actions.ts (ported from
 * tests/utils.test.mjs): archives, clipboard copies, pull request URLs, external links, workbench
 * commands, opening files (following renames), the Diff View's title and URI construction, and
 * the message wrappers. Everything runs against a recording fake of the `vscode` module, so each
 * wrapper is checked for both the command it issues and the ErrorInfo it resolves to when the
 * editor refuses.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface FakeUri {
	readonly fsPath: string;
	readonly path: string;
	readonly scheme: string;
	readonly query: string;
	with(overrides: Partial<FakeUri>): FakeUri;
}

const vscodeMock = vi.hoisted(() => {
	const settings: { [key: string]: unknown } = {};
	const responses: { [name: string]: Array<unknown> | ((...args: unknown[]) => unknown) } = {};
	const calls: Array<{ name: string, args: unknown[] }> = [];
	const makeUri = (p: string, extra: { [key: string]: unknown } = {}): FakeUri => {
		const uri: FakeUri = {
			fsPath: p,
			path: p,
			scheme: 'file',
			query: '',
			...extra,
			with(overrides: Partial<FakeUri>) { return makeUri(p, { ...extra, ...overrides }); }
		};
		return uri;
	};
	/** Resolve the next queued response for `name` (an Error rejects; a function entry, or a
	 * permanent function responder, is called; an exhausted or absent queue resolves NULL). */
	const respond = (name: string, args: unknown[]) => {
		const queue = responses[name];
		let value: unknown;
		if (Array.isArray(queue) && queue.length > 0) {
			const next = queue.shift();
			value = typeof next === 'function' ? (<(...callArgs: unknown[]) => unknown>next)(...args) : next;
		} else if (typeof queue === 'function') {
			value = (<(...callArgs: unknown[]) => unknown>queue)(...args);
		} else {
			value = null;
		}
		if (value instanceof Error) return Promise.reject(value);
		return Promise.resolve(value === undefined ? null : value);
	};
	const record = (name: string) => (...args: unknown[]) => {
		calls.push({ name, args });
		return respond(name, args);
	};
	return {
		settings: settings,
		responses: responses,
		calls: calls,
		makeUri: makeUri,
		Uri: { file: (p: string) => makeUri(p), parse: (u: string) => makeUri('', { path: u }) },
		ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		env: {
			language: 'en',
			openExternal: record('env.openExternal'),
			clipboard: { writeText: record('clipboard.writeText') }
		},
		window: {
			showSaveDialog: record('showSaveDialog'),
			showInformationMessage: record('showInformationMessage'),
			showErrorMessage: record('showErrorMessage')
		},
		commands: { executeCommand: (...args: unknown[]) => {
			calls.push({ name: 'executeCommand:' + String(args[0]), args });
			return respond('executeCommand:' + String(args[0]), args);
		} },
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

import type { WriteOp } from '../git/write/ops/index';
import { decodeDiffDocUri } from '../views/diffDocProvider';
import { t } from './i18n';
import { GitFileStatus } from '../../shared/model/git';
import { PullRequestProvider } from '../../shared/model/pullRequest';
import { archive, copyFilePathToClipboard, copyToClipboard, createPullRequest, openExtensionSettings, openExternalUrl, openFile, resolveDiffFromHash, showErrorMessage, showInformationMessage, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision, viewScm } from './actions';

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-actions-ws-'));
const repo = workspaceRoot.replace(/\\/g, '/') + '/repo';

beforeAll(() => {
	fs.mkdirSync(path.join(workspaceRoot, 'repo', 'dir'), { recursive: true });
	fs.writeFileSync(path.join(workspaceRoot, 'repo', 'dir', 'new.txt'), 'x');
});

afterAll(() => {
	fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

/** A writer double recording the write ops it runs (NULL ErrorInfo everywhere). */
function fakeWriter() {
	const runs: Array<[string, WriteOp]> = [];
	const writer = {
		run: async (repo: string, op: WriteOp) => {
			runs.push([repo, op]);
			return null;
		}
	};
	return { writer: writer, runs: runs };
}

/** A rename-resolution reader double (NULL everywhere unless the case overrides it). */
function fakeRenames(overrides: { getNewPathOfRenamedFile?: (filePath: string) => string | null } = {}) {
	return {
		getNewPathOfRenamedFile: async (_repo: string, _hash: string, filePath: string) =>
			overrides.getNewPathOfRenamedFile ? overrides.getNewPathOfRenamedFile(filePath) : null
	};
}

describe('the Visual Studio Code command wrappers', () => {
	it('archive passes the chosen file to the writer as the archive op, and reports bad extensions / cancellation', async () => {
		const { writer, runs } = fakeWriter();

		vscodeMock.responses['showSaveDialog'] = [vscodeMock.makeUri('/out/x.zip')];
		expect(await archive(repo, 'main', writer)).toBe(null);
		expect(runs.length).toBe(1);
		expect(runs[0][0]).toBe(repo);
		expect(runs[0][1].steps.map((step) => step.argv)).toEqual([['archive', '--format=zip', '-o', '/out/x.zip', 'main']]);

		vscodeMock.responses['showSaveDialog'] = [vscodeMock.makeUri('/out/x.rar')];
		expect(await archive(repo, 'main', writer)).toBe(t('archiveInvalidExtension', 'rar'));
		expect(runs.length).toBe(1);

		vscodeMock.responses['showSaveDialog'] = [undefined];
		expect(await archive(repo, 'main', writer)).toBe(t('archiveNoFileName'));

		vscodeMock.responses['showSaveDialog'] = [new Error('no dialog')];
		expect(await archive(repo, 'main', writer)).toBe(t('archiveNoSaveDialog'));
	});

	it('copies to the clipboard (relative and absolute file paths) and reports write failures', async () => {
		vscodeMock.resetCalls();
		vscodeMock.responses['clipboard.writeText'] = [];
		expect(await copyFilePathToClipboard(repo, 'dir/file.txt', false)).toBe(null);
		expect(await copyFilePathToClipboard(repo, 'dir/file.txt', true)).toBe(null);
		expect(vscodeMock.callsTo('clipboard.writeText').map((args) => args[0])).toEqual(['dir/file.txt', path.join(repo, 'dir/file.txt')]);

		vscodeMock.responses['clipboard.writeText'] = [new Error('denied')];
		expect(await copyToClipboard('x')).toBe(t('clipboardWriteFailed'));
		vscodeMock.responses['clipboard.writeText'] = [];
	});

	it('createPullRequest builds the provider-specific URL and opens it', async () => {
		vscodeMock.responses['env.openExternal'] = () => true;
		const opened = () => vscodeMock.callsTo('env.openExternal').map((args) => String((<FakeUri>args[0]).path));
		const base = { hostRootUrl: 'https://host', sourceRemote: 'origin', sourceOwner: 'me', sourceRepo: 'fork', destRemote: 'origin', destOwner: 'org', destRepo: 'repo', destProjectId: '', destBranch: 'main', custom: null };

		vscodeMock.resetCalls();
		expect(await createPullRequest({ ...base, provider: PullRequestProvider.GitHub }, 'me', 'fork', 'feat')).toBe(null);
		expect(opened()).toEqual(['https://host/org/repo/compare/main...me:feat']);

		vscodeMock.resetCalls();
		await createPullRequest({ ...base, provider: PullRequestProvider.Bitbucket }, 'me', 'fork', 'feat');
		expect(opened()).toEqual(['https://host/me/fork/pull-requests/new?source=me/fork::feat&dest=org/repo::main']);

		vscodeMock.resetCalls();
		await createPullRequest({ ...base, provider: PullRequestProvider.GitLab }, 'me', 'fork', 'feat');
		expect(opened()).toEqual(['https://host/me/fork/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main']);

		vscodeMock.resetCalls();
		await createPullRequest({ ...base, provider: PullRequestProvider.GitLab, destProjectId: '77' }, 'me', 'fork', 'feat');
		expect(opened()).toEqual(['https://host/me/fork/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main&merge_request[target_project_id]=77']);

		vscodeMock.resetCalls();
		await createPullRequest({ ...base, provider: PullRequestProvider.Custom, custom: { name: 'Custom', templateUrl: '$1/pr/$4/$7/$8' }, destProjectId: '9' }, 'me', 'fork', 'feat');
		expect(opened()).toEqual(['https://host/pr/feat/9/main']);
	});

	it('openExternalUrl maps refusal, rejection and parse failures onto the localised error', async () => {
		vscodeMock.responses['env.openExternal'] = [false, new Error('nope')];
		expect(await openExternalUrl('https://x')).toBe(t('openUrlFailed', t('externalUrlType'), 'https://x'));
		expect(await openExternalUrl('https://x', 'Custom')).toBe(t('openUrlFailed', 'Custom', 'https://x'));
		expect(await openExternalUrl('not a uri')).toBe(t('openUrlFailed', t('externalUrlType'), 'not a uri'));
		vscodeMock.responses['env.openExternal'] = [];
	});

	it('openExtensionSettings and viewScm run the workbench commands and surface failures', async () => {
		vscodeMock.resetCalls();
		vscodeMock.responses['executeCommand:workbench.action.openSettings'] = [];
		vscodeMock.responses['executeCommand:workbench.view.scm'] = [];
		expect(await openExtensionSettings()).toBe(null);
		expect(await viewScm()).toBe(null);
		expect(vscodeMock.callsTo('executeCommand:workbench.action.openSettings').map((args) => args.slice(1))).toEqual([['@ext:aucneon.git-graph-rs']]);
		expect(vscodeMock.callsTo('executeCommand:workbench.view.scm').length).toBe(1);

		vscodeMock.responses['executeCommand:workbench.action.openSettings'] = [new Error('x')];
		vscodeMock.responses['executeCommand:workbench.view.scm'] = [new Error('x')];
		expect(await openExtensionSettings()).toBe(t('openExtensionSettingsFailed'));
		expect(await viewScm()).toBe(t('openScmFailed'));
		vscodeMock.responses['executeCommand:workbench.action.openSettings'] = [];
		vscodeMock.responses['executeCommand:workbench.view.scm'] = [];
	});

	it('openFile opens existing files, follows renames via the supplied lookup and reports missing files', async () => {
		vscodeMock.resetCalls();
		vscodeMock.responses['executeCommand:vscode.open'] = [];
		expect(await openFile(repo, 'dir/new.txt')).toBe(null);
		const open = vscodeMock.callsTo('executeCommand:vscode.open')[0];
		expect(open[0]).toBe('vscode.open');
		expect((<FakeUri>open[1]).fsPath).toBe(path.join(repo, 'dir/new.txt'));
		expect(open[2]).toEqual({ preview: true, viewColumn: vscodeMock.ViewColumn.Active });

		vscodeMock.resetCalls();
		expect(await openFile(repo, 'dir/new.txt', null, null, <never>vscodeMock.ViewColumn.Two)).toBe(null);
		expect((<{ viewColumn: number }>vscodeMock.callsTo('executeCommand:vscode.open')[0][2]).viewColumn).toBe(vscodeMock.ViewColumn.Two);

		const renames = fakeRenames({ getNewPathOfRenamedFile: (filePath) => filePath === 'dir/old.txt' ? 'dir/new.txt' : null });
		vscodeMock.resetCalls();
		expect(await openFile(repo, 'dir/old.txt', 'abc123', renames)).toBe(null);
		expect((<FakeUri>vscodeMock.callsTo('executeCommand:vscode.open')[0][1]).fsPath).toBe(path.join(repo, 'dir/new.txt'));

		expect(await openFile(repo, 'dir/gone.txt', 'abc123', renames)).toBe(t('fileNotInRepo', 'dir/gone.txt'));
		expect(await openFile(repo, 'dir/gone.txt')).toBe(t('fileNotInRepo', 'dir/gone.txt'));

		vscodeMock.responses['executeCommand:vscode.open'] = [new Error('x')];
		expect(await openFile(repo, 'dir/new.txt')).toBe(t('openFileFailed', 'dir/new.txt'));
		vscodeMock.responses['executeCommand:vscode.open'] = [];
	});

	it('resolveDiffFromHash expands the uncommitted / same-commit shorthands', () => {
		expect(resolveDiffFromHash('*', 'abc')).toBe('HEAD');
		expect(resolveDiffFromHash('*', '*')).toBe('HEAD'); // working tree against HEAD
		expect(resolveDiffFromHash('abc', 'abc')).toBe('abc^');
		expect(resolveDiffFromHash('abc', 'def')).toBe('abc');
	});

	it('viewDiff issues vscode.diff with the encoded revisions and a descriptive title', async () => {
		vscodeMock.responses['executeCommand:vscode.diff'] = [];
		const from = '1111111111111111111111111111111111111111', to = '2222222222222222222222222222222222222222';
		const diffTitle = async (fromHash: string, toHash: string, type: GitFileStatus) => {
			vscodeMock.resetCalls();
			expect(await viewDiff(repo, fromHash, toHash, 'dir/old.txt', 'dir/file.txt', type)).toBe(null);
			const call = vscodeMock.callsTo('executeCommand:vscode.diff')[0];
			expect(call[0]).toBe('vscode.diff');
			return call;
		};

		let call = await diffTitle(from, to, GitFileStatus.Modified);
		expect(call[3]).toBe('file.txt (' + t('diffTitleChanged', '11111111', '22222222') + ')');
		expect(decodeDiffDocUri(<never>call[1])).toEqual({ filePath: 'dir/old.txt', commit: from, repo: repo, exists: true });
		expect(decodeDiffDocUri(<never>call[2])).toEqual({ filePath: 'dir/file.txt', commit: to, repo: repo, exists: true });

		call = await diffTitle(from, to, GitFileStatus.Added);
		expect(call[3]).toBe('file.txt (' + t('diffTitleAddedBetween', '11111111', '22222222') + ')');
		expect(decodeDiffDocUri(<never>call[1]).exists).toBe(false);

		call = await diffTitle(from, to, GitFileStatus.Deleted);
		expect(call[3]).toBe('file.txt (' + t('diffTitleDeletedBetween', '11111111', '22222222') + ')');
		expect(decodeDiffDocUri(<never>call[2]).exists).toBe(false);

		call = await diffTitle(to, to, GitFileStatus.Modified);
		expect(call[3]).toBe('file.txt (' + t('diffTitleChangedWithParent', '22222222', '22222222') + ')');
		expect(decodeDiffDocUri(<never>call[1]).commit).toBe(to + '^');

		call = await diffTitle(to, to, GitFileStatus.Added);
		expect(call[3]).toBe('file.txt (' + t('diffTitleAddedIn', '22222222') + ')');
		call = await diffTitle(to, to, GitFileStatus.Deleted);
		expect(call[3]).toBe('file.txt (' + t('diffTitleDeletedIn', '22222222') + ')');

		call = await diffTitle('*', '*', GitFileStatus.Modified);
		expect(call[3]).toBe('file.txt (' + t('diffTitleUncommitted') + ')');
		expect((<FakeUri>call[2]).scheme).toBe('file'); // the working file itself

		call = await diffTitle(from, '*', GitFileStatus.Modified);
		expect(call[3]).toBe('file.txt (' + t('diffTitleChanged', '11111111', t('diffTitlePresent')) + ')');

		vscodeMock.responses['executeCommand:vscode.diff'] = [new Error('x')];
		expect(await viewDiff(repo, from, to, 'dir/old.txt', 'dir/file.txt', GitFileStatus.Modified)).toBe(t('diffEditorFailed', 'dir/file.txt'));
		vscodeMock.responses['executeCommand:vscode.diff'] = [];
	});

	it('viewDiff opens untracked files directly instead of diffing them', async () => {
		vscodeMock.resetCalls();
		vscodeMock.responses['executeCommand:vscode.open'] = [];
		expect(await viewDiff(repo, '*', '*', 'dir/new.txt', 'dir/new.txt', GitFileStatus.Untracked)).toBe(null);
		expect(vscodeMock.callsTo('executeCommand:vscode.open').length).toBe(1);
	});

	it('viewDiffWithWorkingFile classifies the change by whether the working file (or its rename) exists', async () => {
		vscodeMock.responses['executeCommand:vscode.diff'] = [];
		vscodeMock.responses['executeCommand:vscode.open'] = [];
		const hash = '3333333333333333333333333333333333333333';
		const renames = fakeRenames({ getNewPathOfRenamedFile: (filePath) => filePath === 'dir/renamed-from.txt' ? 'dir/new.txt' : null });
		const run = async (filePath: string) => {
			vscodeMock.resetCalls();
			expect(await viewDiffWithWorkingFile(repo, hash, filePath, renames)).toBe(null);
			return vscodeMock.callsTo('executeCommand:vscode.diff')[0];
		};

		let call = await run('dir/new.txt');
		expect(call[3]).toBe('new.txt (' + t('diffTitleChanged', '33333333', t('diffTitlePresent')) + ')');

		call = await run('dir/renamed-from.txt');
		expect(decodeDiffDocUri(<never>call[1]).filePath).toBe('dir/renamed-from.txt');
		expect((<FakeUri>call[2]).fsPath).toBe(path.join(repo, 'dir/new.txt'));

		call = await run('dir/deleted.txt');
		expect(call[3]).toBe('deleted.txt (' + t('diffTitleDeletedBetween', '33333333', t('diffTitlePresent')) + ')');
		expect(decodeDiffDocUri(<never>call[2]).exists).toBe(false);
	});

	it('viewFileAtRevision opens a readonly revision document titled with the abbreviated hash', async () => {
		vscodeMock.resetCalls();
		vscodeMock.responses['executeCommand:vscode.open'] = [];
		expect(await viewFileAtRevision(repo, '4444444444444444444444444444444444444444', 'dir/file.txt')).toBe(null);
		const call = vscodeMock.callsTo('executeCommand:vscode.open')[0];
		expect(call[0]).toBe('vscode.open');
		expect((<FakeUri>call[1]).scheme).toBe('git-graph-rs');
		expect((<FakeUri>call[1]).path).toBe('44444444: file.txt');
		expect(decodeDiffDocUri(<never>call[1])).toEqual({ filePath: 'dir/file.txt', commit: '4444444444444444444444444444444444444444', repo: repo, exists: true });

		vscodeMock.responses['executeCommand:vscode.open'] = [new Error('x')];
		expect(await viewFileAtRevision(repo, '4444444444444444444444444444444444444444', 'dir/file.txt')).toBe(t('viewFileAtRevisionFailed', 'dir/file.txt', '44444444'));
		vscodeMock.responses['executeCommand:vscode.open'] = [];
	});

	it('showInformationMessage / showErrorMessage swallow editor failures', async () => {
		vscodeMock.responses['showInformationMessage'] = [new Error('x')];
		vscodeMock.responses['showErrorMessage'] = [new Error('x')];
		expect(await showInformationMessage('hello')).toBeUndefined();
		expect(await showErrorMessage('oops')).toBeUndefined();
		expect(vscodeMock.callsTo('showInformationMessage').at(-1)![0]).toBe('hello');
		expect(vscodeMock.callsTo('showErrorMessage').at(-1)![0]).toBe('oops');
		vscodeMock.responses['showInformationMessage'] = [];
		vscodeMock.responses['showErrorMessage'] = [];
	});
});

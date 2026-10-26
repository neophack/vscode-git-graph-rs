/**
 * The CommandManager (src/extension/commands/, split by group in task 4.6 and re-exported
 * through the src/commands.ts shim): every `git-graph-rs.*` command registered with the
 * editor, driven through the recording `vscode` stub with hand-rolled DataSource / RepoManager /
 * ExtensionState / AvatarManager doubles. GitGraphView is replaced by a recorder (the real view
 * is covered by the webview harness tests), so each command is checked for the repository it
 * resolved, the dialogs it showed, and the view it asked to open.
 *
 * Ported from tests/commands.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it, vi } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/* The hoisted mock state: the recording `vscode` stub plus the GitGraphView recorder. */
const vs = vi.hoisted(() => {
	const viewCalls: unknown[][] = [];
	return {
		viewCalls,
		stateHolder: {} as { state: VscodeStubState }
	};
});

vi.mock('vscode', async () => {
	const { createVscodeState, vscodeMockOf } = await import('../../support/fakeVscode');
	const state = createVscodeState({ workspaceFolders: [{ path: '/ws' }] });
	vs.stateHolder.state = vscodeMockOf(state) as never;
	return vscodeMockOf(state);
});

/* GitGraphView recorder: the real panel is covered by the pipeline suites. */
vi.mock('../../../src/extension/graphView/panel', () => ({
	GitGraphView: { createOrShow: (...args: unknown[]) => { vs.viewCalls.push(args); } }
}));

import { CommandManager } from '../../../src/extension/commands';
import { t } from '../../../src/extension/platform/i18n';
import { encodeDiffDocUri } from '../../../src/extension/views/diffDocProvider';
import { EventEmitter } from '../../../src/shared/util/event';
import { GitFileStatus } from '../../../src/shared/model/git';
import type { VscodeStubState } from '../../support/fakeVscode';

const vscode = () => vs.stateHolder.state as unknown as {
	runCommand: (c: string, ...a: unknown[]) => unknown;
	Uri: { file: (p: string) => unknown };
	registeredCommands: Map<string, (...args: unknown[]) => unknown>;
	settings: Record<string, unknown>;
	responses: Record<string, unknown>;
	window: { activeTextEditor?: unknown };
	callsTo: (name: string) => Array<{ name: string, args: unknown[] }>;
	resetCalls: () => void;
};

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 10; i++) await tick(); await new Promise((resolve) => setTimeout(resolve, 25)); for (let i = 0; i < 10; i++) await tick(); };

/* ---------- doubles ---------- */

function createDoubles() {
	const repos: Record<string, unknown> = {};
	const repoManager = {
		repos,
		getRepos: () => repos,
		getKnownRepo: async (p: string) => Object.prototype.hasOwnProperty.call(repos, p) ? p : null,
		getRepoContainingFile: (file: string) => Object.keys(repos).find((r) => file === r || file.startsWith(r + '/')) ?? null,
		registerRepo: async (p: string) => { repos[p] = { name: null, workspaceFolderIndex: 0 }; return { root: p, error: null }; },
		ignoreRepo: (p: string) => { if (!repos[p]) return false; delete repos[p]; return true; }
	};
	const gitOutputs = new Map<string, string | Error>(); // args.join(' ') -> stdout | Error
	const dataSource: any = {
		gitOutputs,
		commands: [] as string[][],
		amendLastCommitError: null,
		upstream: 'origin/main',
		resetError: null,
		searchResults: [] as unknown[],
		subjects: {} as Record<string, string>,
		amendLastCommit: async () => dataSource.amendLastCommitError,
		getCurrentBranchUpstream: async () => dataSource.upstream,
		resetCurrentBranchToRemote: async () => dataSource.resetError,
		gitOutput: async (args: string[], _repo: unknown, resolve: (v: string) => unknown) => {
			const key = args.join(' ');
			if (!gitOutputs.has(key)) throw new Error('unexpected git ' + key);
			const value = gitOutputs.get(key)!;
			if (value instanceof Error) throw value.message;
			return resolve(value);
		},
		gitOutputWithStderr: async (args: string[], _repo: unknown, resolve: (v: string, e: string) => unknown) => {
			const key = args.join(' ');
			if (!gitOutputs.has(key)) throw new Error('unexpected git ' + key);
			const value = gitOutputs.get(key)!;
			if (value instanceof Error) throw value.message;
			// The mock stores one blob; hand it to the resolver as both streams, like the real
			// data source hands the spawned process's two streams over.
			return resolve(value, '');
		},
		runGitCommand: async (args: string[]) => { dataSource.commands.push(args); return dataSource.runGitCommandError ?? null; },
		searchHistory: async (_repo: unknown, query: string) => { if (dataSource.searchError) throw new Error('x'); return dataSource.searchResults.filter(() => query !== ''); },
		getCommitSubject: async (_repo: unknown, hash: string) => dataSource.subjects[hash] ?? null,
		getNewPathOfRenamedFile: async () => null,
		gerrit: { installHook: async () => dataSource.hookResult ?? { error: null, installed: true } }
	};
	const codeReviews: any = {};
	const extensionState = {
		codeReviews,
		lastActiveRepo: null as string | null,
		endedAll: 0,
		getLastActiveRepo: () => extensionState.lastActiveRepo,
		getCodeReviews: () => codeReviews,
		endAllWorkspaceCodeReviews: () => { extensionState.endedAll++; },
		endCodeReviewError: null as string | null,
		endCodeReview: async (repo: string, id: string): Promise<string | null> => { delete codeReviews[repo][id]; return extensionState.endCodeReviewError ?? null; }
	};
	const avatarManager: any = { clearCache: async () => avatarManager.clearError ?? null };
	return { repoManager, dataSource, extensionState, avatarManager };
}

function createManager(doubles: ReturnType<typeof createDoubles>, gitExecutable: unknown = { path: 'git', version: '2.45.0' }) {
	const onDidChangeGitExecutable = new EventEmitter();
	const onDidChangeConfiguration = new EventEmitter();
	// The deferred Git resolution (OPTIMIZATION-PLAN V1): current() follows the executable the
	// emitter announces, exactly as the manager's own field did before it derived from this port.
	let current = gitExecutable;
	onDidChangeGitExecutable.subscribe((value: unknown) => { current = value; });
	const gitResolution = {
		current: () => current,
		restricted: () => false,
		ready: () => Promise.resolve(current)
	};
	const logger = { lines: [] as Array<{ level: string, message: string }>, log(message: string) { this.lines.push({ level: 'log', message }); }, logCmd(command: string, args?: ReadonlyArray<string>) { this.lines.push({ level: 'cmd', message: command + ' ' + (args ?? []).join(' ') }); }, logError(message: string) { this.lines.push({ level: 'error', message }); }, dispose() { /* silent */ } };
	const context = { extensionPath: root, subscriptions: [] as Array<{ dispose(): void }> };
	// The view ports the panel consumes (task 3.6/4.4): structural fakes, since these tests
	// exercise registration and dispatch, not the panel wiring behind them.
	// task 3.6: commands read through the facade now - forward to the DataSource-shaped double,
	// which carries exactly the read surface these tests stub (getCommitSubject, searchHistory, ...).
	const viewRepo = {
		read: new Proxy({}, { get: (_target, key) => { if (key in doubles.dataSource) return (doubles.dataSource as any)[key]; return undefined; } }),
		write: { run: async () => null },
		getOperationState: async () => ({ type: null, conflictedFiles: [], progress: null })
	};
	const gitRunner = { gitOutput: async () => '', runGitCommand: async () => null, runGitCommandWithInput: async () => null };
	const legacyViews = { openCompareTab: () => { /* nothing */ }, openBinaryCompare: () => { /* nothing */ } };
	// The Gerrit double rides the old DataSource-shaped fake (installHook and the git-runner
	// surface the gerrit commands call) - task 3.6 moved it off the DataSource parameter.
	const gerrit = doubles.dataSource;
	const manager = new CommandManager(context as never, doubles.avatarManager, viewRepo as never, gitRunner as never, gerrit as never, legacyViews as never, doubles.extensionState as never, doubles.repoManager as never, gitResolution as never, onDidChangeConfiguration.subscribe as never, logger as never);
	return { manager, logger, onDidChangeGitExecutable, onDidChangeConfiguration };
}

let doubles!: ReturnType<typeof createDoubles>;
let manager!: ReturnType<typeof createManager>['manager'];
let logger!: ReturnType<typeof createManager>['logger'];
let onDidChangeGitExecutable!: EventEmitter<unknown>;
let onDidChangeConfiguration!: EventEmitter<unknown>;

beforeEach(() => {
	if (manager) manager.dispose();
	vs.viewCalls.length = 0;
	const state = vscode();
	state.resetCalls();
	for (const key of Object.keys(state.responses)) delete state.responses[key];
	state.window.activeTextEditor = undefined;
	for (const key of Object.keys(state.settings)) delete state.settings[key];
	doubles = createDoubles();
	({ manager, logger, onDidChangeGitExecutable, onDidChangeConfiguration } = createManager(doubles));
});

const lastError = () => vscode().callsTo('showErrorMessage').at(-1)?.args[0];
const lastInfo = () => vscode().callsTo('showInformationMessage').at(-1)?.args[0];
const contexts = () => vscode().callsTo('executeCommand').filter((c) => c.args[0] === 'setContext').map((c) => [c.args[1], c.args[2]]);

describe('CommandManager registration', () => {
	it('registers every command and sets the codicon / interface language contexts', async () => {
		await flush();
		for (const command of ['view', 'filterByFile', 'addGitRepository', 'removeGitRepository', 'clearAvatarCache', 'fetch', 'endAllWorkspaceCodeReviews', 'endSpecificWorkspaceCodeReview', 'resumeWorkspaceCodeReview', 'version', 'searchCommits', 'openFile', 'amendLastCommit', 'resetCurrentBranchToRemote', 'gerritPushRef', 'gerritFetchCommitMsgHook', 'amendLastCommit.zhCn', 'resetCurrentBranchToRemote.zhCn', 'gerritPushRef.zhCn', 'gerritFetchCommitMsgHook.zhCn']) {
			assert.ok(vscode().registeredCommands.has('git-graph-rs.' + command), command);
		}
		assert.deepEqual(contexts(), [['git-graph-rs:codiconsSupported', true], ['git-graph-rs:interfaceZhCn', false]]);
		assert.ok(logger.lines.some((l: any) => l.message.includes('Successfully set Visual Studio Code Context "git-graph-rs:codiconsSupported"')));
	});

	it('re-evaluates the interface language context when the setting changes, and logs context failures', async () => {
		vscode().resetCalls();
		vscode().settings.interfaceLanguage = 'zh-cn';
		vscode().responses['executeCommand:setContext'] = [new Error('refused')];
		onDidChangeConfiguration.emit({ affectsConfiguration: (s: string) => s === 'git-graph-rs.interfaceLanguage' });
		await flush();
		assert.deepEqual(contexts(), [['git-graph-rs:interfaceZhCn', true]]);
		assert.ok(logger.lines.some((l: any) => l.level === 'error' && l.message.includes('Failed to set Visual Studio Code Context "git-graph-rs:interfaceZhCn"')));

		vscode().resetCalls();
		onDidChangeConfiguration.emit({ affectsConfiguration: () => false });
		await flush();
		assert.deepEqual(contexts(), []);
	});

	it('unregisters the commands on dispose', () => {
		manager.dispose();
		assert.equal(vscode().registeredCommands.size, 0);
	});

	it('logs command invocations, and errors thrown synchronously or asynchronously by a handler', async () => {
		// The `view` command rejects when the RepoManager fails: the wrapper must log rather than leak the rejection
		doubles.repoManager.getKnownRepo = async () => { throw new Error('boom'); };
		vscode().runCommand('git-graph-rs.view', { rootUri: vscode().Uri.file('/ws/repo') });
		await flush();
		assert.ok(logger.lines.some((l: any) => l.message === 'Command Invoked: git-graph-rs.view'));
		assert.ok(logger.lines.some((l: any) => l.level === 'error' && l.message.includes('Command "git-graph-rs.view" failed: Error: boom')));

		doubles.repoManager.getRepos = () => { throw new Error('sync boom'); };
		vscode().runCommand('git-graph-rs.fetch');
		// The wrapper awaits the Git resolution before dispatching (OPTIMIZATION-PLAN V1), so the
		// handler's synchronous throw is logged one microtask later — still logged, never leaked.
		await flush();
		assert.ok(logger.lines.some((l: any) => l.level === 'error' && l.message.includes('Command "git-graph-rs.fetch" failed: Error: sync boom')));
	});
});

describe('git-graph-rs.view', () => {
	it('opens the view without a repository when invoked from the palette', async () => {
		vscode().runCommand('git-graph-rs.view');
		await flush();
		assert.equal(vs.viewCalls.length, 1);
		assert.equal((vs.viewCalls[0] as unknown[])[0], root);
		assert.equal((vs.viewCalls[0] as unknown[])[8], null);
	});

	it('loads the repository of the Source Control view argument, registering it when unknown', async () => {
		(doubles.repoManager.repos as any)['/ws/known'] = { name: null };
		vscode().runCommand('git-graph-rs.view', { rootUri: vscode().Uri.file('/ws/known') });
		await flush();
		assert.deepEqual((vs.viewCalls[0] as unknown[])[8], { repo: '/ws/known' });

		vscode().runCommand('git-graph-rs.view', { rootUri: vscode().Uri.file('/ws/new') });
		await flush();
		assert.deepEqual((vs.viewCalls[1] as unknown[])[8], { repo: '/ws/new' });
		assert.ok((doubles.repoManager.repos as any)['/ws/new']);
	});

	it('opens to the repository of the active editor when the setting is enabled', async () => {
		(doubles.repoManager.repos as any)['/ws/repo'] = { name: null };
		vscode().window.activeTextEditor = { document: { uri: vscode().Uri.file('/ws/repo/src/a.ts') } };
		vscode().runCommand('git-graph-rs.view');
		await flush();
		assert.equal((vs.viewCalls[0] as unknown[])[8], null);

		vscode().settings.openToTheRepoOfTheActiveTextEditorDocument = true;
		vscode().runCommand('git-graph-rs.view');
		await flush();
		assert.deepEqual((vs.viewCalls[1] as unknown[])[8], { repo: '/ws/repo' });
	});
});

describe('git-graph-rs.filterByFile', () => {
	beforeEach(() => {
		(doubles.repoManager.repos as any)['/ws/repo'] = { name: null };
		(doubles.repoManager.repos as any)['/ws/other'] = { name: null };
	});

	it('filters by the first selected file, relative to the repository root', async () => {
		vscode().runCommand('git-graph-rs.filterByFile', [vscode().Uri.file('/ws/repo/src/a.ts'), { resourceUri: vscode().Uri.file('/ws/repo/src/b.ts') }, { uri: vscode().Uri.file('/ws/repo/src/a.ts') }]);
		await flush();
		assert.deepEqual((vs.viewCalls[0] as unknown[])[8], { repo: '/ws/repo', filterPath: 'src/a.ts' });

		vscode().runCommand('git-graph-rs.filterByFile', [vscode().Uri.file('/ws/other/b.ts'), vscode().Uri.file('/ws/repo/a.ts')]);
		await flush();
		assert.deepEqual((vs.viewCalls[1] as unknown[])[8], { repo: '/ws/other', filterPath: 'b.ts' });
	});

	it('uses "." for the repository root itself and falls back to the active editor', async () => {
		vscode().runCommand('git-graph-rs.filterByFile', vscode().Uri.file('/ws/repo'));
		await flush();
		assert.deepEqual((vs.viewCalls[0] as unknown[])[8], { repo: '/ws/repo', filterPath: '.' });

		vscode().window.activeTextEditor = { document: { uri: vscode().Uri.file('/ws/repo/x.ts') } };
		vscode().runCommand('git-graph-rs.filterByFile', undefined);
		await flush();
		assert.deepEqual((vs.viewCalls[1] as unknown[])[8], { repo: '/ws/repo', filterPath: 'x.ts' });
	});

	it('reports when no file or a file outside any repository is given', async () => {
		vscode().runCommand('git-graph-rs.filterByFile', undefined);
		await flush();
		assert.equal(lastError(), t('filterByFileUndetermined' as never));

		vscode().runCommand('git-graph-rs.filterByFile', vscode().Uri.file('/elsewhere/a.ts'));
		await flush();
		assert.equal(lastError(), t('filterByFileNotInRepo' as never, '/elsewhere/a.ts'));
		assert.equal(vs.viewCalls.length, 0);
	});
});

describe('git-graph-rs.addGitRepository / removeGitRepository', () => {
	it('adds a folder inside the workspace and rejects one outside', async () => {
		vscode().responses.showOpenDialog = [[vscode().Uri.file('/ws/new-repo')]];
		vscode().runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(lastInfo(), t('repoAdded' as never, '/ws/new-repo'));

		vscode().responses.showOpenDialog = [[vscode().Uri.file('/outside/repo')]];
		vscode().runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(lastError(), t('folderNotInWorkspace' as never, '/outside/repo'));

		doubles.repoManager.registerRepo = async () => ({ root: null, error: 'not a repo' }) as never;
		vscode().responses.showOpenDialog = [[vscode().Uri.file('/ws/bad')]];
		vscode().runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(lastError(), t('repoAddFailed' as never, 'not a repo'));

		vscode().responses.showOpenDialog = [undefined];
		vscode().resetCalls();
		vscode().runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(vscode().callsTo('showErrorMessage').length, 0);
	});

	it('removes the repository picked from the sorted list', async () => {
		(doubles.repoManager.repos as any)['/ws/b'] = { name: null };
		(doubles.repoManager.repos as any)['/ws/a'] = { name: 'Alpha' };
		vscode().responses.showQuickPick = [(items: any[]) => items[1]];
		vscode().runCommand('git-graph-rs.removeGitRepository');
		await flush();
		const pick = vscode().callsTo('showQuickPick')[0];
		assert.deepEqual(pick.args[0], [{ label: 'Alpha', description: '/ws/a' }, { label: 'b', description: '/ws/b' }]);
		assert.equal((pick.args[1] as any).placeHolder, t('selectRepoToRemove' as never));
		assert.equal(lastInfo(), t('repoRemoved' as never, 'b'));
		assert.deepEqual(Object.keys(doubles.repoManager.repos), ['/ws/a']);

		vscode().responses.showQuickPick = [{ label: 'gone', description: '/ws/gone' }];
		vscode().runCommand('git-graph-rs.removeGitRepository');
		await flush();
		assert.equal(lastError(), t('repoNotKnown' as never, 'gone'));
	});

	it('both refuse to run without a Git executable', async () => {
		onDidChangeGitExecutable.emit(null);
		vscode().runCommand('git-graph-rs.addGitRepository');
		vscode().runCommand('git-graph-rs.removeGitRepository');
		await flush();
		assert.equal(vscode().callsTo('showErrorMessage').length, 2);
		assert.equal(lastError(), t('unableToFindGit' as never));
		assert.equal(vscode().callsTo('showOpenDialog').length, 0);
	});
});

describe('git-graph-rs.clearAvatarCache', () => {
	it('reports success, the AvatarManager error, or an unexpected failure', async () => {
		vscode().runCommand('git-graph-rs.clearAvatarCache');
		await flush();
		assert.equal(lastInfo(), t('avatarCacheCleared' as never));

		doubles.avatarManager.clearError = 'disk full';
		vscode().runCommand('git-graph-rs.clearAvatarCache');
		await flush();
		assert.equal(lastError(), 'disk full');

		doubles.avatarManager.clearCache = async () => { throw new Error('x'); };
		vscode().runCommand('git-graph-rs.clearAvatarCache');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand' as never, 'Clear Avatar Cache'));
	});
});

describe('git-graph-rs.fetch', () => {
	it('opens the view directly with zero or one repository', async () => {
		vscode().runCommand('git-graph-rs.fetch');
		await flush();
		assert.equal((vs.viewCalls[0] as unknown[])[8], null);

		(doubles.repoManager.repos as any)['/ws/only'] = { name: null };
		vscode().runCommand('git-graph-rs.fetch');
		await flush();
		assert.deepEqual((vs.viewCalls[1] as unknown[])[8], { repo: '/ws/only', runCommandOnLoad: 'fetch' });
	});

	it('asks which repository to fetch, listing the last active repository first', async () => {
		(doubles.repoManager.repos as any)['/ws/a'] = { name: null };
		(doubles.repoManager.repos as any)['/ws/b'] = { name: null };
		doubles.extensionState.lastActiveRepo = '/ws/b';
		vscode().responses.showQuickPick = [(items: any[]) => items[0]];
		vscode().runCommand('git-graph-rs.fetch');
		await flush();
		assert.deepEqual((vscode().callsTo('showQuickPick')[0].args[0] as Array<{ description: string }>).map((i) => i.description), ['/ws/b', '/ws/a']);
		assert.deepEqual((vs.viewCalls[0] as unknown[])[8], { repo: '/ws/b', runCommandOnLoad: 'fetch' });

		vscode().responses.showQuickPick = [new Error('closed')];
		vscode().runCommand('git-graph-rs.fetch');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand' as never, 'Fetch from Remote(s)'));
	});
});

describe('code review commands', () => {
	const hashA = 'a'.repeat(40), hashB = 'b'.repeat(40);
	beforeEach(() => {
		(doubles.repoManager.repos as any)['/ws/repo'] = { name: null };
		(doubles.extensionState.codeReviews as any)['/ws/repo'] = {
			[hashA]: { lastActive: Date.now() - 60000, lastViewedFile: null, remainingFiles: ['a'] },
			[hashA + '-' + hashB]: { lastActive: Date.now(), lastViewedFile: null, remainingFiles: ['b'] }
		};
		(doubles.extensionState.codeReviews as any)['/ws/unknown'] = { [hashB]: { lastActive: Date.now(), lastViewedFile: null, remainingFiles: [] } };
		doubles.dataSource.subjects[hashA] = 'Subject A';
	});

	it('endAllWorkspaceCodeReviews ends them all', async () => {
		vscode().runCommand('git-graph-rs.endAllWorkspaceCodeReviews');
		await flush();
		assert.equal(doubles.extensionState.endedAll, 1);
		assert.equal(lastInfo(), t('endedAllCodeReviews' as never));
	});

	it('endSpecificWorkspaceCodeReview lists the reviews of known repositories, most recent first', async () => {
		vscode().responses.showQuickPick = [(items: any[]) => items[1]];
		vscode().runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		await flush();
		const items = vscode().callsTo('showQuickPick')[0].args[0] as any[];
		assert.equal(items.length, 2); // the review in the unknown repository is not offered
		assert.equal(items[0].codeReviewId, hashA + '-' + hashB);
		assert.equal(items[0].label, 'repo: aaaaaaaa ↔ bbbbbbbb');
		assert.equal(items[0].detail, 'Subject A ↔ ' + t('unknownCommitSubject' as never));
		assert.equal(items[1].label, 'repo: aaaaaaaa');
		assert.equal(items[1].detail, 'Subject A');
		assert.equal(items[1].description, '1 minute ago');
		assert.equal(lastInfo(), t('endedCodeReview' as never, 'repo: aaaaaaaa'));
		assert.equal((doubles.extensionState.codeReviews as any)['/ws/repo'][hashA], undefined);
	});

	it('endSpecificWorkspaceCodeReview surfaces state errors and dialog failures', async () => {
		doubles.extensionState.endCodeReviewError = 'cannot save';
		vscode().responses.showQuickPick = [(items: any[]) => items[0]];
		vscode().runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		await flush();
		assert.equal(lastError(), 'cannot save');

		vscode().responses.showQuickPick = [new Error('closed')];
		vscode().runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand' as never, 'End a specific Code Review in Workspace...'));

		(doubles.extensionState.codeReviews as any)['/ws/repo'] = {};
		delete (doubles.extensionState.codeReviews as any)['/ws/unknown'];
		delete (doubles.extensionState.codeReviews as any)['/ws/repo'];
		vscode().runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		vscode().runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.equal(vscode().callsTo('showErrorMessage').filter((c) => c.args[0] === t('noCodeReviewsInProgress' as never)).length, 2);
	});

	it('resumeWorkspaceCodeReview reopens the view on the reviewed commit (or comparison)', async () => {
		vscode().responses.showQuickPick = [(items: any[]) => items[0], (items: any[]) => items[1], new Error('closed')];
		vscode().runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.deepEqual((vs.viewCalls[0] as unknown[])[8], { repo: '/ws/repo', commitDetails: { commitHash: hashB, compareWithHash: hashA } });

		vscode().runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.deepEqual((vs.viewCalls[1] as unknown[])[8], { repo: '/ws/repo', commitDetails: { commitHash: hashA, compareWithHash: null } });

		vscode().runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand' as never, 'Resume a specific Code Review in Workspace...'));
	});
});

describe('git-graph-rs.version', () => {
	it('shows the version information and copies it on request', async () => {
		vscode().responses.showInformationMessage = [t('copyButton' as never)];
		vscode().runCommand('git-graph-rs.version');
		await flush();
		const shown = vscode().callsTo('showInformationMessage')[0];
		assert.match(String(shown.args[0]), /2\.45\.0/);
		assert.deepEqual(shown.args[1], { modal: true });
		assert.equal(vscode().callsTo('clipboard.writeText')[0].args[0], shown.args[0]);

		vscode().responses.showInformationMessage = [t('copyButton' as never)];
		vscode().responses['clipboard.writeText'] = [new Error('x')];
		vscode().runCommand('git-graph-rs.version');
		await flush();
		assert.equal(lastError(), t('clipboardWriteFailed' as never));
	});

	it('reports "(none)" without a Git executable and an error when package.json cannot be read', async () => {
		onDidChangeGitExecutable.emit(null);
		vscode().runCommand('git-graph-rs.version');
		await flush();
		await flush();
		assert.match(String(vscode().callsTo('showInformationMessage').at(-1)!.args[0]), /\(none\)/);

		manager.dispose();
		({ manager } = createManager(doubles));
		const broken = new CommandManager({ extensionPath: '/nope' } as never, doubles.avatarManager, { read: {}, write: { run: async () => null } } as never, { gitOutput: async () => '' } as never, doubles.dataSource as never, { openCompareTab: () => { /* nothing */ }, openBinaryCompare: () => { /* nothing */ } } as never, doubles.extensionState as never, doubles.repoManager as never, { current: () => null, restricted: () => false, ready: () => Promise.resolve(null) } as never, (() => ({ dispose() { /* nothing */ } })) as never, { log() { /* silent */ }, logError() { /* silent */ } } as never);
		vscode().runCommand('git-graph-rs.version');
		await flush();
		assert.equal(lastError(), t('versionInfoError' as never));
		broken.dispose();
	});
});

describe('git-graph-rs.searchCommits', () => {
	beforeEach(() => { (doubles.repoManager.repos as any)['/ws/repo'] = { name: null }; });

	it('searches the single repository and opens the selected commit', async () => {
		doubles.dataSource.searchResults = [{ hash: 'c'.repeat(40), author: 'Ann', date: 1700000000, message: 'fix it' }];
		vscode().responses.showInputBox = ['  fix  '];
		vscode().responses.showQuickPick = [(items: any[]) => items[0]];
		vscode().runCommand('git-graph-rs.searchCommits');
		await flush();
		const items = vscode().callsTo('showQuickPick')[0].args[0] as any[];
		assert.equal(items[0].label, 'cccccccc');
		assert.equal(items[0].description, 'fix it');
		assert.deepEqual((vs.viewCalls[0] as unknown[])[8], { repo: '/ws/repo', findCommitHash: 'c'.repeat(40) });
	});

	it('asks for the repository when there are several, and stops on empty input or no results', async () => {
		(doubles.repoManager.repos as any)['/ws/zzz'] = { name: null };
		vscode().responses.showQuickPick = ['/ws/zzz'];
		vscode().responses.showInputBox = ['   '];
		vscode().runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.deepEqual(vscode().callsTo('showQuickPick')[0].args[0], ['/ws/repo', '/ws/zzz']);
		assert.equal(vs.viewCalls.length, 0);

		vscode().responses.showQuickPick = [undefined];
		vscode().runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(vscode().callsTo('showInputBox').length, 1);

		delete (doubles.repoManager.repos as any)['/ws/zzz'];
		vscode().responses.showInputBox = ['nothing'];
		vscode().runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(lastInfo(), t('noCommitsFound' as never));

		doubles.dataSource.searchError = true;
		vscode().responses.showInputBox = ['boom'];
		vscode().runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(lastError(), t('searchCommitsError' as never));
	});

	it('does nothing without repositories, and refuses without Git', async () => {
		delete (doubles.repoManager.repos as any)['/ws/repo'];
		vscode().runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(vscode().callsTo('showQuickPick').length + vscode().callsTo('showInputBox').length + vscode().callsTo('showErrorMessage').length, 0);

		onDidChangeGitExecutable.emit(null);
		vscode().runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(lastError(), t('unableToFindGit' as never));
	});
});

// Replaced by the colocated vitest suites on the new seams (task 3.6/4.10):
// - repository resolution + amendLastCommit + resetCurrentBranchToRemote ->
//   src/extension/commands/sourceControl.test.ts
// - gerritPushRef + gerritFetchCommitMsgHook -> src/extension/commands/gerrit.test.ts
describe('git-graph-rs.openFile', () => {
	it('opens the file behind a Git Graph diff URI (argument or active editor)', async () => {
		const uri = encodeDiffDocUri('/ws/repo', 'src/a.ts', 'd'.repeat(40), GitFileStatus.Modified, 1);
		doubles.dataSource.getNewPathOfRenamedFile = async () => null;
		vscode().runCommand('git-graph-rs.openFile', uri);
		await flush();
		// The file does not exist on disk, so the wrapper reports it (the vscode.open path is covered by utils.test.mjs)
		assert.equal(lastError(), t('unableToOpenFile' as never, t('fileNotInRepo' as never, 'src/a.ts')));

		vscode().window.activeTextEditor = { document: { uri } };
		vscode().resetCalls();
		vscode().runCommand('git-graph-rs.openFile');
		await flush();
		assert.equal(lastError(), t('unableToOpenFile' as never, t('fileNotInRepo' as never, 'src/a.ts')));

		vscode().window.activeTextEditor = { document: { uri: vscode().Uri.file('/ws/plain.ts') } };
		vscode().runCommand('git-graph-rs.openFile');
		await flush();
		assert.equal(lastError(), t('openFileMissingArgs' as never));
	});
});

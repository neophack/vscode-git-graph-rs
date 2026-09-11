/**
 * The CommandManager (src/commands.ts): every `git-graph-rs.*` command registered with the
 * editor, driven through the recording `vscode` stub with hand-rolled DataSource / RepoManager /
 * ExtensionState / AvatarManager doubles. GitGraphView is replaced by a recorder (the real view
 * is covered by the webview harness tests), so each command is checked for the repository it
 * resolved, the dialogs it showed, and the view it asked to open.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { createLoggerStub, createVscodeStub, installVscodeStub } from './vscodeStub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vscode = createVscodeStub({ workspaceFolders: [{ path: '/ws' }] });

/* GitGraphView recorder */
const viewCalls = [];
const gitGraphViewStub = { GitGraphView: { createOrShow: (...args) => { viewCalls.push(args); } } };
installVscodeStub(vscode, { './gitGraphView': gitGraphViewStub });

const { CommandManager } = await import('../out/commands.js');
const { t } = await import('../out/i18n.js');
const { encodeDiffDocUri } = await import('../out/diffDocProvider.js');
const { EventEmitter } = await import('../out/utils/event.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 10; i++) await tick(); await new Promise((resolve) => setTimeout(resolve, 25)); for (let i = 0; i < 10; i++) await tick(); };

/* ---------- doubles ---------- */

function createDoubles() {
	const repos = {};
	const repoManager = {
		repos,
		getRepos: () => repos,
		getKnownRepo: async (p) => Object.prototype.hasOwnProperty.call(repos, p) ? p : null,
		getRepoContainingFile: (file) => Object.keys(repos).find((r) => file === r || file.startsWith(r + '/')) ?? null,
		registerRepo: async (p) => { repos[p] = { name: null, workspaceFolderIndex: 0 }; return { root: p, error: null }; },
		ignoreRepo: (p) => { if (!repos[p]) return false; delete repos[p]; return true; }
	};
	const gitOutputs = new Map(); // args.join(' ') -> stdout | Error
	const dataSource = {
		gitOutputs,
		commands: [],
		amendLastCommitError: null,
		upstream: 'origin/main',
		resetError: null,
		searchResults: [],
		subjects: {},
		amendLastCommit: async () => dataSource.amendLastCommitError,
		getCurrentBranchUpstream: async () => dataSource.upstream,
		resetCurrentBranchToRemote: async () => dataSource.resetError,
		gitOutput: async (args, _repo, resolve) => {
			const key = args.join(' ');
			if (!gitOutputs.has(key)) throw new Error('unexpected git ' + key);
			const value = gitOutputs.get(key);
			if (value instanceof Error) throw value.message;
			return resolve(value);
		},
		runGitCommand: async (args) => { dataSource.commands.push(args); return dataSource.runGitCommandError ?? null; },
		searchHistory: async (_repo, query) => { if (dataSource.searchError) throw new Error('x'); return dataSource.searchResults.filter(() => query !== ''); },
		getCommitSubject: async (_repo, hash) => dataSource.subjects[hash] ?? null,
		getNewPathOfRenamedFile: async () => null,
		gerrit: { installHook: async () => dataSource.hookResult ?? { error: null, installed: true } }
	};
	const codeReviews = {};
	const extensionState = {
		codeReviews,
		lastActiveRepo: null,
		endedAll: 0,
		getLastActiveRepo: () => extensionState.lastActiveRepo,
		getCodeReviews: () => codeReviews,
		endAllWorkspaceCodeReviews: () => { extensionState.endedAll++; },
		endCodeReview: async (repo, id) => { delete codeReviews[repo][id]; return extensionState.endCodeReviewError ?? null; }
	};
	const avatarManager = { clearCache: async () => avatarManager.clearError ?? null };
	return { repoManager, dataSource, extensionState, avatarManager };
}

function createManager(doubles, gitExecutable = { path: 'git', version: '2.45.0' }) {
	const onDidChangeGitExecutable = new EventEmitter();
	const onDidChangeConfiguration = new EventEmitter();
	const logger = createLoggerStub();
	const context = { extensionPath: root, subscriptions: [] };
	const manager = new CommandManager(context, doubles.avatarManager, doubles.dataSource, doubles.extensionState, doubles.repoManager, gitExecutable, onDidChangeGitExecutable.subscribe, onDidChangeConfiguration.subscribe, logger);
	return { manager, logger, onDidChangeGitExecutable, onDidChangeConfiguration };
}

let doubles, manager, logger, onDidChangeGitExecutable, onDidChangeConfiguration;
beforeEach(() => {
	if (manager) manager.dispose();
	viewCalls.length = 0;
	vscode.resetCalls();
	for (const key of Object.keys(vscode.responses)) delete vscode.responses[key];
	vscode.window.activeTextEditor = undefined;
	for (const key of Object.keys(vscode.settings)) delete vscode.settings[key];
	doubles = createDoubles();
	({ manager, logger, onDidChangeGitExecutable, onDidChangeConfiguration } = createManager(doubles));
});

const lastError = () => vscode.callsTo('showErrorMessage').at(-1)?.args[0];
const lastInfo = () => vscode.callsTo('showInformationMessage').at(-1)?.args[0];
const contexts = () => vscode.callsTo('executeCommand').filter((c) => c.args[0] === 'setContext').map((c) => [c.args[1], c.args[2]]);

describe('CommandManager registration', () => {
	it('registers every command and sets the codicon / interface language contexts', async () => {
		await flush();
		for (const command of ['view', 'filterByFile', 'addGitRepository', 'removeGitRepository', 'clearAvatarCache', 'fetch', 'endAllWorkspaceCodeReviews', 'endSpecificWorkspaceCodeReview', 'resumeWorkspaceCodeReview', 'version', 'searchCommits', 'openFile', 'amendLastCommit', 'resetCurrentBranchToRemote', 'gerritPushRef', 'gerritFetchCommitMsgHook', 'amendLastCommit.zhCn', 'resetCurrentBranchToRemote.zhCn', 'gerritPushRef.zhCn', 'gerritFetchCommitMsgHook.zhCn']) {
			assert.ok(vscode.registeredCommands.has('git-graph-rs.' + command), command);
		}
		assert.deepEqual(contexts(), [['git-graph-rs:codiconsSupported', true], ['git-graph-rs:interfaceZhCn', false]]);
		assert.ok(logger.lines.some((l) => l.message.includes('Successfully set Visual Studio Code Context "git-graph-rs:codiconsSupported"')));
	});

	it('re-evaluates the interface language context when the setting changes, and logs context failures', async () => {
		vscode.resetCalls();
		vscode.settings.interfaceLanguage = 'zh-cn';
		vscode.responses['executeCommand:setContext'] = [new Error('refused')];
		onDidChangeConfiguration.emit({ affectsConfiguration: (s) => s === 'git-graph-rs.interfaceLanguage' });
		await flush();
		assert.deepEqual(contexts(), [['git-graph-rs:interfaceZhCn', true]]);
		assert.ok(logger.lines.some((l) => l.level === 'error' && l.message.includes('Failed to set Visual Studio Code Context "git-graph-rs:interfaceZhCn"')));

		vscode.resetCalls();
		onDidChangeConfiguration.emit({ affectsConfiguration: () => false });
		await flush();
		assert.deepEqual(contexts(), []);
	});

	it('unregisters the commands on dispose', () => {
		manager.dispose();
		assert.equal(vscode.registeredCommands.size, 0);
	});

	it('logs command invocations, and errors thrown synchronously or asynchronously by a handler', async () => {
		// The `view` command rejects when the RepoManager fails: the wrapper must log rather than leak the rejection
		doubles.repoManager.getKnownRepo = async () => { throw new Error('boom'); };
		vscode.runCommand('git-graph-rs.view', { rootUri: vscode.Uri.file('/ws/repo') });
		await flush();
		assert.ok(logger.lines.some((l) => l.message === 'Command Invoked: git-graph-rs.view'));
		assert.ok(logger.lines.some((l) => l.level === 'error' && l.message.includes('Command "git-graph-rs.view" failed: Error: boom')));

		doubles.repoManager.getRepos = () => { throw new Error('sync boom'); };
		vscode.runCommand('git-graph-rs.fetch');
		assert.ok(logger.lines.some((l) => l.level === 'error' && l.message.includes('Command "git-graph-rs.fetch" failed: Error: sync boom')));
	});
});

describe('git-graph-rs.view', () => {
	it('opens the view without a repository when invoked from the palette', async () => {
		vscode.runCommand('git-graph-rs.view');
		await flush();
		assert.equal(viewCalls.length, 1);
		assert.equal(viewCalls[0][0], root);
		assert.equal(viewCalls[0][6], null);
	});

	it('loads the repository of the Source Control view argument, registering it when unknown', async () => {
		doubles.repoManager.repos['/ws/known'] = { name: null };
		vscode.runCommand('git-graph-rs.view', { rootUri: vscode.Uri.file('/ws/known') });
		await flush();
		assert.deepEqual(viewCalls[0][6], { repo: '/ws/known' });

		vscode.runCommand('git-graph-rs.view', { rootUri: vscode.Uri.file('/ws/new') });
		await flush();
		assert.deepEqual(viewCalls[1][6], { repo: '/ws/new' });
		assert.ok(doubles.repoManager.repos['/ws/new']);
	});

	it('opens to the repository of the active editor when the setting is enabled', async () => {
		doubles.repoManager.repos['/ws/repo'] = { name: null };
		vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file('/ws/repo/src/a.ts') } };
		vscode.runCommand('git-graph-rs.view');
		await flush();
		assert.equal(viewCalls[0][6], null);

		vscode.settings.openToTheRepoOfTheActiveTextEditorDocument = true;
		vscode.runCommand('git-graph-rs.view');
		await flush();
		assert.deepEqual(viewCalls[1][6], { repo: '/ws/repo' });
	});
});

describe('git-graph-rs.filterByFile', () => {
	beforeEach(() => { doubles.repoManager.repos['/ws/repo'] = { name: null }; doubles.repoManager.repos['/ws/other'] = { name: null }; });

	it('filters by the selected file(s), relative to the repository root', async () => {
		vscode.runCommand('git-graph-rs.filterByFile', [vscode.Uri.file('/ws/repo/src/a.ts'), { resourceUri: vscode.Uri.file('/ws/repo/src/b.ts') }, { uri: vscode.Uri.file('/ws/repo/src/a.ts') }]);
		await flush();
		assert.deepEqual(viewCalls[0][6], { repo: '/ws/repo', filterPath: 'src/a.ts,src/b.ts' });
	});

	it('uses "." for the repository root itself and falls back to the active editor', async () => {
		vscode.runCommand('git-graph-rs.filterByFile', vscode.Uri.file('/ws/repo'));
		await flush();
		assert.deepEqual(viewCalls[0][6], { repo: '/ws/repo', filterPath: '.' });

		vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file('/ws/repo/x.ts') } };
		vscode.runCommand('git-graph-rs.filterByFile', undefined);
		await flush();
		assert.deepEqual(viewCalls[1][6], { repo: '/ws/repo', filterPath: 'x.ts' });
	});

	it('reports when no file, a file outside any repository, or files from several repositories are given', async () => {
		vscode.runCommand('git-graph-rs.filterByFile', undefined);
		await flush();
		assert.equal(lastError(), t('filterByFileUndetermined'));

		vscode.runCommand('git-graph-rs.filterByFile', vscode.Uri.file('/elsewhere/a.ts'));
		await flush();
		assert.equal(lastError(), t('filterByFileNotInRepo', '/elsewhere/a.ts'));

		vscode.runCommand('git-graph-rs.filterByFile', [vscode.Uri.file('/ws/repo/a.ts'), vscode.Uri.file('/ws/other/b.ts')]);
		await flush();
		assert.equal(lastError(), t('filterByFileMultipleRepos'));
		assert.equal(viewCalls.length, 0);
	});
});

describe('git-graph-rs.addGitRepository / removeGitRepository', () => {
	it('adds a folder inside the workspace and rejects one outside', async () => {
		vscode.responses.showOpenDialog = [[vscode.Uri.file('/ws/new-repo')]];
		vscode.runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(lastInfo(), t('repoAdded', '/ws/new-repo'));

		vscode.responses.showOpenDialog = [[vscode.Uri.file('/outside/repo')]];
		vscode.runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(lastError(), t('folderNotInWorkspace', '/outside/repo'));

		doubles.repoManager.registerRepo = async () => ({ root: null, error: 'not a repo' });
		vscode.responses.showOpenDialog = [[vscode.Uri.file('/ws/bad')]];
		vscode.runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(lastError(), t('repoAddFailed', 'not a repo'));

		vscode.responses.showOpenDialog = [undefined];
		vscode.resetCalls();
		vscode.runCommand('git-graph-rs.addGitRepository');
		await flush();
		assert.equal(vscode.callsTo('showErrorMessage').length, 0);
	});

	it('removes the repository picked from the sorted list', async () => {
		doubles.repoManager.repos['/ws/b'] = { name: null };
		doubles.repoManager.repos['/ws/a'] = { name: 'Alpha' };
		vscode.responses.showQuickPick = [(items) => items[1]];
		vscode.runCommand('git-graph-rs.removeGitRepository');
		await flush();
		const pick = vscode.callsTo('showQuickPick')[0];
		assert.deepEqual(pick.args[0], [{ label: 'Alpha', description: '/ws/a' }, { label: 'b', description: '/ws/b' }]);
		assert.equal(pick.args[1].placeHolder, t('selectRepoToRemove'));
		assert.equal(lastInfo(), t('repoRemoved', 'b'));
		assert.deepEqual(Object.keys(doubles.repoManager.repos), ['/ws/a']);

		vscode.responses.showQuickPick = [{ label: 'gone', description: '/ws/gone' }];
		vscode.runCommand('git-graph-rs.removeGitRepository');
		await flush();
		assert.equal(lastError(), t('repoNotKnown', 'gone'));
	});

	it('both refuse to run without a Git executable', async () => {
		onDidChangeGitExecutable.emit(null);
		vscode.runCommand('git-graph-rs.addGitRepository');
		vscode.runCommand('git-graph-rs.removeGitRepository');
		await flush();
		assert.equal(vscode.callsTo('showErrorMessage').length, 2);
		assert.equal(lastError(), t('unableToFindGit'));
		assert.equal(vscode.callsTo('showOpenDialog').length, 0);
	});
});

describe('git-graph-rs.clearAvatarCache', () => {
	it('reports success, the AvatarManager error, or an unexpected failure', async () => {
		vscode.runCommand('git-graph-rs.clearAvatarCache');
		await flush();
		assert.equal(lastInfo(), t('avatarCacheCleared'));

		doubles.avatarManager.clearError = 'disk full';
		vscode.runCommand('git-graph-rs.clearAvatarCache');
		await flush();
		assert.equal(lastError(), 'disk full');

		doubles.avatarManager.clearCache = async () => { throw new Error('x'); };
		vscode.runCommand('git-graph-rs.clearAvatarCache');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand', 'Clear Avatar Cache'));
	});
});

describe('git-graph-rs.fetch', () => {
	it('opens the view directly with zero or one repository', async () => {
		vscode.runCommand('git-graph-rs.fetch');
		await flush();
		assert.equal(viewCalls[0][6], null);

		doubles.repoManager.repos['/ws/only'] = { name: null };
		vscode.runCommand('git-graph-rs.fetch');
		await flush();
		assert.deepEqual(viewCalls[1][6], { repo: '/ws/only', runCommandOnLoad: 'fetch' });
	});

	it('asks which repository to fetch, listing the last active repository first', async () => {
		doubles.repoManager.repos['/ws/a'] = { name: null };
		doubles.repoManager.repos['/ws/b'] = { name: null };
		doubles.extensionState.lastActiveRepo = '/ws/b';
		vscode.responses.showQuickPick = [(items) => items[0]];
		vscode.runCommand('git-graph-rs.fetch');
		await flush();
		assert.deepEqual(vscode.callsTo('showQuickPick')[0].args[0].map((i) => i.description), ['/ws/b', '/ws/a']);
		assert.deepEqual(viewCalls[0][6], { repo: '/ws/b', runCommandOnLoad: 'fetch' });

		vscode.responses.showQuickPick = [new Error('closed')];
		vscode.runCommand('git-graph-rs.fetch');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand', 'Fetch from Remote(s)'));
	});
});

describe('code review commands', () => {
	const hashA = 'a'.repeat(40), hashB = 'b'.repeat(40);
	beforeEach(() => {
		doubles.repoManager.repos['/ws/repo'] = { name: null };
		doubles.extensionState.codeReviews['/ws/repo'] = {
			[hashA]: { lastActive: Date.now() - 60000, lastViewedFile: null, remainingFiles: ['a'] },
			[hashA + '-' + hashB]: { lastActive: Date.now(), lastViewedFile: null, remainingFiles: ['b'] }
		};
		doubles.extensionState.codeReviews['/ws/unknown'] = { [hashB]: { lastActive: Date.now(), lastViewedFile: null, remainingFiles: [] } };
		doubles.dataSource.subjects[hashA] = 'Subject A';
	});

	it('endAllWorkspaceCodeReviews ends them all', async () => {
		vscode.runCommand('git-graph-rs.endAllWorkspaceCodeReviews');
		await flush();
		assert.equal(doubles.extensionState.endedAll, 1);
		assert.equal(lastInfo(), t('endedAllCodeReviews'));
	});

	it('endSpecificWorkspaceCodeReview lists the reviews of known repositories, most recent first', async () => {
		vscode.responses.showQuickPick = [(items) => items[1]];
		vscode.runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		await flush();
		const items = vscode.callsTo('showQuickPick')[0].args[0];
		assert.equal(items.length, 2); // the review in the unknown repository is not offered
		assert.equal(items[0].codeReviewId, hashA + '-' + hashB);
		assert.equal(items[0].label, 'repo: aaaaaaaa ↔ bbbbbbbb');
		assert.equal(items[0].detail, 'Subject A ↔ ' + t('unknownCommitSubject'));
		assert.equal(items[1].label, 'repo: aaaaaaaa');
		assert.equal(items[1].detail, 'Subject A');
		assert.equal(items[1].description, '1 minute ago');
		assert.equal(lastInfo(), t('endedCodeReview', 'repo: aaaaaaaa'));
		assert.equal(doubles.extensionState.codeReviews['/ws/repo'][hashA], undefined);
	});

	it('endSpecificWorkspaceCodeReview surfaces state errors and dialog failures', async () => {
		doubles.extensionState.endCodeReviewError = 'cannot save';
		vscode.responses.showQuickPick = [(items) => items[0]];
		vscode.runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		await flush();
		assert.equal(lastError(), 'cannot save');

		vscode.responses.showQuickPick = [new Error('closed')];
		vscode.runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand', 'End a specific Code Review in Workspace...'));

		doubles.extensionState.codeReviews['/ws/repo'] = {};
		delete doubles.extensionState.codeReviews['/ws/unknown'];
		delete doubles.extensionState.codeReviews['/ws/repo'];
		vscode.runCommand('git-graph-rs.endSpecificWorkspaceCodeReview');
		vscode.runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.equal(vscode.callsTo('showErrorMessage').filter((c) => c.args[0] === t('noCodeReviewsInProgress')).length, 2);
	});

	it('resumeWorkspaceCodeReview reopens the view on the reviewed commit (or comparison)', async () => {
		vscode.responses.showQuickPick = [(items) => items[0], (items) => items[1], new Error('closed')];
		vscode.runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.deepEqual(viewCalls[0][6], { repo: '/ws/repo', commitDetails: { commitHash: hashB, compareWithHash: hashA } });

		vscode.runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.deepEqual(viewCalls[1][6], { repo: '/ws/repo', commitDetails: { commitHash: hashA, compareWithHash: null } });

		vscode.runCommand('git-graph-rs.resumeWorkspaceCodeReview');
		await flush();
		assert.equal(lastError(), t('unexpectedErrorInCommand', 'Resume a specific Code Review in Workspace...'));
	});
});

describe('git-graph-rs.version', () => {
	it('shows the version information and copies it on request', async () => {
		vscode.responses.showInformationMessage = [t('copyButton')];
		vscode.runCommand('git-graph-rs.version');
		await flush();
		const shown = vscode.callsTo('showInformationMessage')[0];
		assert.match(shown.args[0], /2\.45\.0/);
		assert.deepEqual(shown.args[1], { modal: true });
		assert.equal(vscode.callsTo('clipboard.writeText')[0].args[0], shown.args[0]);

		vscode.responses.showInformationMessage = [t('copyButton')];
		vscode.responses['clipboard.writeText'] = [new Error('x')];
		vscode.runCommand('git-graph-rs.version');
		await flush();
		assert.equal(lastError(), t('clipboardWriteFailed'));
	});

	it('reports "(none)" without a Git executable and an error when package.json cannot be read', async () => {
		onDidChangeGitExecutable.emit(null);
		vscode.runCommand('git-graph-rs.version');
		await flush();
		assert.match(vscode.callsTo('showInformationMessage')[0].args[0], /\(none\)/);

		manager.dispose();
		({ manager } = createManager(doubles));
		const broken = new CommandManager({ extensionPath: '/nope' }, doubles.avatarManager, doubles.dataSource, doubles.extensionState, doubles.repoManager, null, () => ({ dispose() {} }), () => ({ dispose() {} }), createLoggerStub());
		vscode.runCommand('git-graph-rs.version');
		await flush();
		assert.equal(lastError(), t('versionInfoError'));
		broken.dispose();
	});
});

describe('git-graph-rs.searchCommits', () => {
	beforeEach(() => { doubles.repoManager.repos['/ws/repo'] = { name: null }; });

	it('searches the single repository and opens the selected commit', async () => {
		doubles.dataSource.searchResults = [{ hash: 'c'.repeat(40), author: 'Ann', date: 1700000000, message: 'fix it' }];
		vscode.responses.showInputBox = ['  fix  '];
		vscode.responses.showQuickPick = [(items) => items[0]];
		vscode.runCommand('git-graph-rs.searchCommits');
		await flush();
		const items = vscode.callsTo('showQuickPick')[0].args[0];
		assert.equal(items[0].label, 'cccccccc');
		assert.equal(items[0].description, 'fix it');
		assert.deepEqual(viewCalls[0][6], { repo: '/ws/repo', findCommitHash: 'c'.repeat(40) });
	});

	it('asks for the repository when there are several, and stops on empty input or no results', async () => {
		doubles.repoManager.repos['/ws/zzz'] = { name: null };
		vscode.responses.showQuickPick = ['/ws/zzz'];
		vscode.responses.showInputBox = ['   '];
		vscode.runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.deepEqual(vscode.callsTo('showQuickPick')[0].args[0], ['/ws/repo', '/ws/zzz']);
		assert.equal(viewCalls.length, 0);

		vscode.responses.showQuickPick = [undefined];
		vscode.runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(vscode.callsTo('showInputBox').length, 1);

		delete doubles.repoManager.repos['/ws/zzz'];
		vscode.responses.showInputBox = ['nothing'];
		vscode.runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(lastInfo(), t('noCommitsFound'));

		doubles.dataSource.searchError = true;
		vscode.responses.showInputBox = ['boom'];
		vscode.runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(lastError(), t('searchCommitsError'));
	});

	it('does nothing without repositories, and refuses without Git', async () => {
		delete doubles.repoManager.repos['/ws/repo'];
		vscode.runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(vscode.callsTo('showQuickPick').length + vscode.callsTo('showInputBox').length + vscode.callsTo('showErrorMessage').length, 0);

		onDidChangeGitExecutable.emit(null);
		vscode.runCommand('git-graph-rs.searchCommits');
		await flush();
		assert.equal(lastError(), t('unableToFindGit'));
	});
});

describe('git-graph-rs.openFile', () => {
	it('opens the file behind a Git Graph diff URI (argument or active editor)', async () => {
		const uri = encodeDiffDocUri('/ws/repo', 'src/a.ts', 'd'.repeat(40), 'M', 1);
		doubles.dataSource.getNewPathOfRenamedFile = async () => null;
		vscode.runCommand('git-graph-rs.openFile', uri);
		await flush();
		// The file does not exist on disk, so the wrapper reports it (the vscode.open path is covered by utils.test.mjs)
		assert.equal(lastError(), t('unableToOpenFile', t('fileNotInRepo', 'src/a.ts')));

		vscode.window.activeTextEditor = { document: { uri } };
		vscode.resetCalls();
		vscode.runCommand('git-graph-rs.openFile');
		await flush();
		assert.equal(lastError(), t('unableToOpenFile', t('fileNotInRepo', 'src/a.ts')));

		vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file('/ws/plain.ts') } };
		vscode.runCommand('git-graph-rs.openFile');
		await flush();
		assert.equal(lastError(), t('openFileMissingArgs'));
	});
});

describe('repository resolution for Source Control commands', () => {
	beforeEach(() => { doubles.repoManager.repos['/ws/a'] = { name: null }; });

	it('amendLastCommit uses the argument repository, the active editor, or the only repository', async () => {
		const amended = [];
		doubles.dataSource.amendLastCommit = async (repo) => { amended.push(repo); return null; };

		vscode.runCommand('git-graph-rs.amendLastCommit', { rootUri: vscode.Uri.file('/ws/a') });
		await flush();
		assert.equal(lastInfo(), t('amendedLastCommit', 'a'));

		doubles.repoManager.repos['/ws/b'] = { name: null };
		vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file('/ws/b/file') } };
		vscode.runCommand('git-graph-rs.amendLastCommit.zhCn');
		await flush();

		vscode.window.activeTextEditor = undefined;
		vscode.responses.showQuickPick = [(items) => items[0], undefined];
		vscode.runCommand('git-graph-rs.amendLastCommit');
		await flush();
		assert.equal(vscode.callsTo('showQuickPick')[0].args[1].placeHolder, t('selectRepoForCommand'));

		vscode.runCommand('git-graph-rs.amendLastCommit'); // cancelled quick pick
		await flush();
		assert.deepEqual(amended, ['/ws/a', '/ws/b', '/ws/a']);

		// A Source Control argument for a sub-folder resolves to the containing repository
		vscode.runCommand('git-graph-rs.amendLastCommit', { rootUri: vscode.Uri.file('/ws/a/sub') });
		await flush();
		assert.equal(amended.at(-1), '/ws/a');

		doubles.dataSource.amendLastCommit = async () => 'nothing staged';
		vscode.runCommand('git-graph-rs.amendLastCommit', { rootUri: vscode.Uri.file('/ws/a') });
		await flush();
		assert.equal(lastError(), t('unableToAmendLastCommit', 'nothing staged'));
	});

	it('does nothing when no repository is known', async () => {
		delete doubles.repoManager.repos['/ws/a'];
		vscode.runCommand('git-graph-rs.amendLastCommit');
		await flush();
		assert.equal(vscode.callsTo('showQuickPick').length + vscode.callsTo('showErrorMessage').length + vscode.callsTo('showInformationMessage').length, 0);
	});
});

describe('git-graph-rs.resetCurrentBranchToRemote', () => {
	beforeEach(() => { doubles.repoManager.repos['/ws/a'] = { name: null }; });

	it('confirms with the upstream name before resetting', async () => {
		vscode.responses.showWarningMessage = [t('resetToRemoteButton')];
		vscode.runCommand('git-graph-rs.resetCurrentBranchToRemote');
		await flush();
		const warning = vscode.callsTo('showWarningMessage')[0];
		assert.equal(warning.args[0], t('resetToRemoteConfirm', 'origin/main'));
		assert.deepEqual(warning.args[1], { modal: true });
		assert.equal(lastInfo(), t('resetToRemoteDone', 'origin/main'));

		vscode.responses.showWarningMessage = [undefined];
		doubles.dataSource.resetCurrentBranchToRemote = async () => { throw new Error('must not run'); };
		vscode.runCommand('git-graph-rs.resetCurrentBranchToRemote.zhCn');
		await flush();
		assert.equal(vscode.callsTo('showInformationMessage').length, 1);
	});

	it('reports a missing upstream and reset failures, and refuses without Git', async () => {
		doubles.dataSource.upstream = null;
		vscode.runCommand('git-graph-rs.resetCurrentBranchToRemote');
		await flush();
		assert.equal(lastError(), t('noUpstreamBranch'));

		doubles.dataSource.upstream = 'origin/dev';
		doubles.dataSource.resetError = 'dirty tree';
		vscode.responses.showWarningMessage = [t('resetToRemoteButton')];
		vscode.runCommand('git-graph-rs.resetCurrentBranchToRemote');
		await flush();
		assert.equal(lastError(), t('unableToResetToRemote', 'dirty tree'));

		onDidChangeGitExecutable.emit(null);
		vscode.runCommand('git-graph-rs.resetCurrentBranchToRemote');
		await flush();
		assert.equal(lastError(), t('unableToFindGit'));
	});
});

describe('git-graph-rs.gerritPushRef', () => {
	const tree = 't'.repeat(40), parent = 'p'.repeat(40);
	beforeEach(() => {
		doubles.repoManager.repos['/ws/a'] = { name: null };
		doubles.dataSource.gitOutputs.set('rev-parse --abbrev-ref HEAD', 'feature\n');
		doubles.dataSource.gitOutputs.set('log -1 --format=%B HEAD --', 'Subject\n\nBody\n');
		doubles.dataSource.gitOutputs.set('branch -r --no-color --contains=HEAD', '\n');
		doubles.dataSource.gitOutputs.set('show -s --format=%T%n%P%n%an <%ae> %at%n%cn <%ce> %ct%n%B HEAD', [tree, parent, 'A <a@x> 1', 'C <c@x> 2', 'Subject', '', 'Body'].join('\n'));
	});

	it('amends a Change-Id (after confirmation) and pushes to refs/for/<branch>, offering to open the change', async () => {
		vscode.responses.showInformationMessage = [t('gerritAmendAndPushButton'), t('gerritOpenChange')];
		vscode.responses['env.openExternal'] = [true];
		doubles.dataSource.gitOutputs.set('push origin HEAD:refs/for/feature', 'remote:\nremote:   https://gerrit.example/c/proj/+/1234 Subject\nremote:\n');
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();

		const amend = doubles.dataSource.commands[0];
		assert.equal(amend[0], 'commit');
		assert.equal(amend[1], '--amend');
		assert.match(amend[3], /^Subject\n\nBody\n\nChange-Id: I[0-9a-f]{40}$/);
		assert.equal(amend.length, 4); // no -S without signCommits
		assert.equal(vscode.callsTo('showInformationMessage')[0].args[0], t('gerritAmendConfirm', amend[3].match(/Change-Id: (I[0-9a-f]{11})/)[1]));
		assert.equal(vscode.callsTo('showInformationMessage')[1].args[0], t('gerritPushedWithUrl', 'https://gerrit.example/c/proj/+/1234'));
		assert.equal(vscode.callsTo('env.openExternal')[0].args[0].toString(), 'https://gerrit.example/c/proj/+/1234');
	});

	it('skips the amend when HEAD already has a Change-Id, signs when configured, and reports a push without a URL', async () => {
		doubles.dataSource.gitOutputs.set('log -1 --format=%B HEAD --', 'Subject\n\nChange-Id: I' + '1'.repeat(40) + '\n');
		doubles.dataSource.gitOutputs.set('push upstream HEAD:refs/for/feature', 'done');
		vscode.settings['gerrit.remote'] = 'upstream';
		vscode.runCommand('git-graph-rs.gerritPushRef.zhCn');
		await flush();
		assert.equal(doubles.dataSource.commands.length, 0);
		assert.equal(lastInfo(), t('gerritPushed', 'feature', 'upstream'));

		doubles.dataSource.gitOutputs.set('log -1 --format=%B HEAD --', 'Subject\n');
		vscode.settings['repository.sign.commits'] = true;
		delete vscode.settings['gerrit.remote'];
		doubles.dataSource.gitOutputs.set('push origin HEAD:refs/for/feature', 'done');
		vscode.responses.showInformationMessage = [t('gerritAmendAndPushButton')];
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(doubles.dataSource.commands[0].at(-1), '-S');
	});

	it('refuses when HEAD was already pushed, when the amend is declined, or when the amend fails', async () => {
		doubles.dataSource.gitOutputs.set('branch -r --no-color --contains=HEAD', '  origin/feature\n');
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), t('gerritChangeIdPushedError', 'origin/feature'));

		doubles.dataSource.gitOutputs.set('branch -r --no-color --contains=HEAD', '');
		vscode.responses.showInformationMessage = [t('gerritCancel')];
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), t('gerritAmendAborted'));

		vscode.responses.showInformationMessage = [t('gerritAmendAndPushButton')];
		doubles.dataSource.runGitCommandError = 'hook rejected';
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), 'hook rejected');

		doubles.dataSource.gitOutputs.set('log -1 --format=%B HEAD --', new Error('no HEAD'));
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), 'no HEAD');
	});

	it('validates the current branch and reports push failures', async () => {
		doubles.dataSource.gitOutputs.set('rev-parse --abbrev-ref HEAD', new Error('fatal'));
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), t('gerritNoCommits'));

		doubles.dataSource.gitOutputs.set('rev-parse --abbrev-ref HEAD', 'HEAD');
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), t('gerritDetachedHead'));

		doubles.dataSource.gitOutputs.set('rev-parse --abbrev-ref HEAD', 'bad..name');
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), t('gerritInvalidBranch', 'bad..name'));

		doubles.dataSource.gitOutputs.set('rev-parse --abbrev-ref HEAD', 'feature');
		doubles.dataSource.gitOutputs.set('log -1 --format=%B HEAD --', 'Change-Id: I' + '2'.repeat(40));
		doubles.dataSource.gitOutputs.set('push origin HEAD:refs/for/feature', new Error('rejected'));
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), t('gerritPushFailed', 'rejected'));

		onDidChangeGitExecutable.emit(null);
		vscode.runCommand('git-graph-rs.gerritPushRef');
		await flush();
		assert.equal(lastError(), t('unableToFindGit'));
	});
});

describe('git-graph-rs.gerritFetchCommitMsgHook', () => {
	beforeEach(() => { doubles.repoManager.repos['/ws/a'] = { name: null }; });

	it('reports installation, an up-to-date hook, failures, and the missing Git executable', async () => {
		vscode.runCommand('git-graph-rs.gerritFetchCommitMsgHook');
		await flush();
		assert.equal(lastInfo(), t('gerritHookInstalled'));

		doubles.dataSource.hookResult = { error: null, installed: false };
		vscode.runCommand('git-graph-rs.gerritFetchCommitMsgHook.zhCn');
		await flush();
		assert.equal(lastInfo(), t('gerritHookUpToDate'));

		doubles.dataSource.hookResult = { error: '404', installed: false };
		vscode.runCommand('git-graph-rs.gerritFetchCommitMsgHook');
		await flush();
		assert.equal(lastError(), t('gerritHookFailed', '404'));

		onDidChangeGitExecutable.emit(null);
		vscode.runCommand('git-graph-rs.gerritFetchCommitMsgHook');
		await flush();
		assert.equal(lastError(), t('unableToFindGit'));
	});
});

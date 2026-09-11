/**
 * The smaller extension-host components that sit between the editor and the DataSource:
 * the ExtensionState mementos, the StatusBarItem, the Logger (Output Channel + mirrored log
 * file), the DiffDocProvider (readonly revision documents), the askpass bridge (the HTTP server
 * in the extension host and the askpassMain.js helper Git launches), and `activate()` itself,
 * booted against a real throwaway repository with every subsystem wired up.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createLoggerStub, createVscodeStub, installVscodeStub } from './vscodeStub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-host-'));
const repoDir = path.join(tmp, 'repo');
fs.mkdirSync(repoDir);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'first\n');
execFileSync('git', ['add', 'a.txt'], { cwd: repoDir });
execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repoDir });
const headHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

const vscode = createVscodeStub({ workspaceFolders: [{ path: repoDir }] });
installVscodeStub(vscode);

const { ExtensionState, DEFAULT_REPO_STATE } = await import('../out/extensionState.js');
const { StatusBarItem } = await import('../out/statusBarItem.js');
const { Logger } = await import('../out/logger.js');
const { DiffDocProvider, encodeDiffDocUri, decodeDiffDocUri } = await import('../out/diffDocProvider.js');
const { AskpassManager } = await import('../out/askpass/askpassManager.js');
const { EventEmitter } = await import('../out/utils/event.js');
const { t } = await import('../out/i18n.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BooleanOverride = { Default: 0, Enabled: 1, Disabled: 2 };

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ---------- a Memento that can be made to fail ---------- */
function createMemento(initial = {}) {
	const store = Object.assign({}, initial);
	return {
		store,
		failNext: false,
		get: (key, defaultValue) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue,
		update(key, value) {
			if (this.failNext) { this.failNext = false; return Promise.reject(new Error('memento unavailable')); }
			store[key] = value;
			return Promise.resolve();
		},
		keys: () => Object.keys(store)
	};
}

describe('ExtensionState', () => {
	let globalState, workspaceState, state, gitExecutableEmitter, storage;
	beforeEach(async () => {
		if (state) state.dispose();
		globalState = createMemento();
		workspaceState = createMemento();
		gitExecutableEmitter = new EventEmitter();
		storage = path.join(tmp, 'storage-' + Math.random().toString(36).slice(2));
		state = new ExtensionState({ globalState, workspaceState, globalStoragePath: storage }, gitExecutableEmitter.subscribe);
		await sleep(50); // the avatar storage folder is created asynchronously
	});

	it('creates the avatar storage folder (and detects it when it already exists)', async () => {
		assert.equal(state.isAvatarStorageAvailable(), true);
		assert.equal(state.getAvatarStoragePath(), storage.replace(/\\/g, '/') + '/avatars');
		assert.ok(fs.existsSync(path.join(storage, 'avatars')));

		const again = new ExtensionState({ globalState, workspaceState, globalStoragePath: storage }, gitExecutableEmitter.subscribe);
		await sleep(50);
		assert.equal(again.isAvatarStorageAvailable(), true);
		again.dispose();
	});

	it('records the Git executable path as it changes', () => {
		assert.equal(state.getLastKnownGitPath(), null);
		gitExecutableEmitter.emit({ path: '/usr/bin/git', version: '2.45.0' });
		assert.equal(state.getLastKnownGitPath(), '/usr/bin/git');
		gitExecutableEmitter.emit(null);
		assert.equal(state.getLastKnownGitPath(), '/usr/bin/git');
	});

	it('fills known repositories with defaults and migrates the legacy showRemoteBranches flag', () => {
		workspaceState.store.repoStates = {
			'/r/defaults': {},
			'/r/legacy-off': { showRemoteBranches: false },
			'/r/legacy-on': { showRemoteBranches: true },
			'/r/v2': { showRemoteBranches: false, showRemoteBranchesV2: BooleanOverride.Enabled }
		};
		const repos = state.getRepos();
		assert.deepEqual(repos['/r/defaults'], DEFAULT_REPO_STATE);
		assert.equal(repos['/r/legacy-off'].showRemoteBranchesV2, BooleanOverride.Disabled);
		assert.equal(repos['/r/legacy-on'].showRemoteBranchesV2, BooleanOverride.Default); // matches the (default true) setting
		assert.equal(repos['/r/v2'].showRemoteBranchesV2, BooleanOverride.Enabled);

		state.saveRepos({ '/r/x': DEFAULT_REPO_STATE });
		assert.deepEqual(Object.keys(workspaceState.store.repoStates), ['/r/x']);
	});

	it('transfers the last active repository and code reviews when a repository moves', async () => {
		state.setLastActiveRepo('/r/old');
		await state.startCodeReview('/r/old', 'abc', ['f1', 'f2'], null);
		state.transferRepo('/r/old', '/r/new');
		assert.equal(state.getLastActiveRepo(), '/r/new');
		assert.deepEqual(Object.keys(state.getCodeReviews()), ['/r/new']);

		state.transferRepo('/r/unrelated', '/r/other'); // nothing to move
		assert.deepEqual(Object.keys(state.getCodeReviews()), ['/r/new']);
	});

	it('merges the stored global and workspace view state over the defaults', async () => {
		assert.deepEqual(state.getGlobalViewState(), { alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false });
		assert.equal(await state.setGlobalViewState({ alwaysAcceptCheckoutCommit: true }), null);
		assert.equal(state.getGlobalViewState().alwaysAcceptCheckoutCommit, true);
		assert.equal(state.getGlobalViewState().pushTagSkipRemoteCheck, false);

		assert.deepEqual(state.getWorkspaceViewState(), { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false });
		assert.equal(await state.setWorkspaceViewState({ findIsRegex: true }), null);
		assert.equal(state.getWorkspaceViewState().findIsRegex, true);
	});

	it('stores ignored repositories and the last active repository', async () => {
		assert.deepEqual(state.getIgnoredRepos(), []);
		assert.equal(await state.setIgnoredRepos(['/r/a']), null);
		assert.deepEqual(state.getIgnoredRepos(), ['/r/a']);
		assert.equal(state.getLastActiveRepo(), null);
		state.setLastActiveRepo('/r/a');
		assert.equal(state.getLastActiveRepo(), '/r/a');
	});

	it('maintains the avatar cache and clears the stored files', async () => {
		const avatar = { image: 'x.png', timestamp: 1, identicon: false };
		state.saveAvatar('a@x', avatar);
		state.saveAvatar('b@x', avatar);
		state.saveAvatar('c@x', avatar);
		assert.deepEqual(Object.keys(state.getAvatarCache()), ['a@x', 'b@x', 'c@x']);
		state.removeAvatarFromCache('a@x');
		state.removeAvatarsFromCache([]);
		state.removeAvatarsFromCache(['b@x', 'missing@x']);
		assert.deepEqual(Object.keys(state.getAvatarCache()), ['c@x']);

		fs.writeFileSync(path.join(storage, 'avatars', 'x.png'), 'img');
		assert.equal(await state.clearAvatarCache(), null);
		assert.deepEqual(state.getAvatarCache(), {});
		await sleep(50);
		assert.deepEqual(fs.readdirSync(path.join(storage, 'avatars')), []);

		globalState.failNext = true;
		assert.equal(await state.clearAvatarCache(), 'Visual Studio Code was unable to save the Git Graph Global State Memento.');
	});

	it('starts, reads, updates, ends and expires code reviews', async () => {
		const started = await state.startCodeReview('/r/a', 'h1-h2', ['a', 'b'], 'a');
		assert.equal(started.error, null);
		assert.equal(started.codeReview.id, 'h1-h2');
		assert.deepEqual(started.codeReview.remainingFiles, ['a', 'b']);

		const review = state.getCodeReview('/r/a', 'h1-h2');
		assert.equal(review.lastViewedFile, 'a');
		assert.equal(state.getCodeReview('/r/a', 'nope'), null);
		assert.equal(state.getCodeReview('/r/none', 'h1-h2'), null);

		assert.equal(await state.updateCodeReview('/r/a', 'h1-h2', ['b'], 'b'), null);
		assert.deepEqual(state.getCodeReview('/r/a', 'h1-h2').remainingFiles, ['b']);
		assert.equal(await state.updateCodeReview('/r/a', 'h1-h2', ['b'], null), null);
		assert.equal(state.getCodeReview('/r/a', 'h1-h2').lastViewedFile, 'b');
		assert.equal(await state.updateCodeReview('/r/a', 'missing', ['b'], null), t('codeReviewNotFound'));

		// Reviewing the last file ends the review, and the repository entry goes with it
		assert.equal(await state.updateCodeReview('/r/a', 'h1-h2', [], null), null);
		assert.deepEqual(state.getCodeReviews(), {});

		await state.startCodeReview('/r/a', 'old', ['a'], null);
		await state.startCodeReview('/r/a', 'fresh', ['a'], null);
		await state.startCodeReview('/r/b', 'stale', ['a'], null);
		workspaceState.store.codeReviews['/r/a'].old.lastActive = Date.now() - 100 * 86400000;
		workspaceState.store.codeReviews['/r/b'].stale.lastActive = Date.now() - 100 * 86400000;
		state.expireOldCodeReviews();
		assert.deepEqual(Object.keys(state.getCodeReviews()), ['/r/a']);
		assert.deepEqual(Object.keys(state.getCodeReviews()['/r/a']), ['fresh']);
		state.expireOldCodeReviews(); // nothing left to expire: no write

		assert.equal(await state.endCodeReview('/r/a', 'fresh'), null);
		await state.endCodeReview('/r/a', 'fresh'); // already gone
		state.endAllWorkspaceCodeReviews();
		assert.deepEqual(state.getCodeReviews(), {});

		workspaceState.failNext = true;
		assert.equal((await state.startCodeReview('/r/a', 'x', ['a'], null)).error, 'Visual Studio Code was unable to save the Git Graph Workspace State Memento.');
	});
});

describe('StatusBarItem', () => {
	let repoEmitter, configEmitter, logger, item;
	beforeEach(() => {
		if (item) item.dispose();
		repoEmitter = new EventEmitter();
		configEmitter = new EventEmitter();
		logger = createLoggerStub();
		vscode.statusBarItems.length = 0;
		delete vscode.settings.showStatusBarItem;
	});

	it('is shown only while repositories are known and the setting is enabled', () => {
		item = new StatusBarItem(0, repoEmitter.subscribe, configEmitter.subscribe, logger);
		const bar = vscode.statusBarItems[0];
		assert.equal(bar.alignment, vscode.StatusBarAlignment.Left);
		assert.equal(bar.text, 'Git Graph RS');
		assert.equal(bar.tooltip, t('viewGitGraphRs'));
		assert.equal(bar.command, 'git-graph-rs.view');
		assert.equal(bar.visible, false);

		repoEmitter.emit({ repos: {}, numRepos: 2, loadRepo: null });
		assert.equal(bar.visible, true);
		assert.equal(logger.lines.at(-1).message, 'Showing "Git Graph" Status Bar Item');

		repoEmitter.emit({ repos: {}, numRepos: 2, loadRepo: null }); // unchanged: no extra show
		assert.equal(bar.shows, 1);

		vscode.settings.showStatusBarItem = false;
		configEmitter.emit({ affectsConfiguration: () => false }); // some other setting
		assert.equal(bar.visible, true);
		configEmitter.emit({ affectsConfiguration: (s) => s === 'git-graph-rs.showStatusBarItem' });
		assert.equal(bar.visible, false);
		assert.equal(logger.lines.at(-1).message, 'Hiding "Git Graph" Status Bar Item');

		vscode.settings.showStatusBarItem = true;
		configEmitter.emit({ affectsConfiguration: (s) => s === 'git-graph-rs.showStatusBarItem' });
		assert.equal(bar.visible, true);
		repoEmitter.emit({ repos: {}, numRepos: 0, loadRepo: null });
		assert.equal(bar.visible, false);

		item.dispose();
		assert.equal(bar.disposed, true);
		assert.equal(repoEmitter.hasSubscribers(), false);
	});

	it('starts visible when repositories are already known', () => {
		item = new StatusBarItem(3, repoEmitter.subscribe, configEmitter.subscribe, logger);
		assert.equal(vscode.statusBarItems[0].visible, true);
	});
});

describe('Logger', () => {
	it('is silent until enabled, then mirrors formatted lines to the channel and the log file', () => {
		vscode.outputChannels.length = 0;
		const logFile = path.join(tmp, 'logs', 'git-graph-rs.log');
		const logger = new Logger(logFile);
		const channel = vscode.outputChannels[0];
		assert.equal(channel.name, 'Git Graph RS');

		logger.log('dropped');
		assert.equal(logger.isEnabled(), false);
		assert.equal(logger.getLogFile(), null);
		assert.deepEqual(channel.lines, []);

		logger.setEnabled(true);
		logger.setEnabled(true); // idempotent
		assert.equal(logger.getLogFile(), logFile);
		logger.log('hello');
		logger.logCmd('git', ['log', '--format=%H', 'a b', 'say "hi"', ''], 12);
		logger.logCmd('git', ['status']);
		logger.logError('bad');
		assert.equal(channel.lines.length, 4);
		assert.match(channel.lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] hello$/);
		assert.ok(channel.lines[1].endsWith('] > git log --format=... "a b" "say \\"hi\\"" "" (12 ms)'), channel.lines[1]);
		assert.ok(channel.lines[2].endsWith('] > git status'));
		assert.ok(channel.lines[3].endsWith('] ERROR: bad'));
		assert.equal(fs.readFileSync(logFile, 'utf8'), channel.lines.join('\n') + '\n');

		logger.setEnabled(false);
		logger.log('not recorded');
		assert.equal(channel.lines.length, 4);
		assert.equal(logger.getLogFile(), null);

		// Re-enabling starts a fresh file
		logger.setEnabled(true);
		assert.equal(fs.readFileSync(logFile, 'utf8'), '');
		logger.dispose();
		assert.equal(channel.disposed, true);
	});

	it('resets the log file once it reaches the size cap', () => {
		const logFile = path.join(tmp, 'cap.log');
		const logger = new Logger(logFile);
		logger.setEnabled(true);
		logger.logFileBytes = 10 * 1024 * 1024; // simulate a full file
		logger.log('after cap');
		const content = fs.readFileSync(logFile, 'utf8');
		assert.equal(content.split('\n').length, 2);
		assert.ok(content.includes('after cap'));
		logger.dispose();
	});

	it('falls back to the channel alone when the log file cannot be created, or without a path', () => {
		const blocked = path.join(tmp, 'blocked-file');
		fs.writeFileSync(blocked, 'a file where the directory should be');
		const logger = new Logger(path.join(blocked, 'nested', 'log.txt'));
		logger.setEnabled(true);
		assert.equal(logger.getLogFile(), null);
		logger.log('channel only');
		assert.equal(vscode.outputChannels.at(-1).lines.length, 1);
		logger.dispose();

		const noFile = new Logger();
		noFile.setEnabled(true);
		assert.equal(noFile.getLogFile(), null);
		noFile.log('x');
		noFile.dispose();
	});
});

describe('DiffDocProvider', () => {
	it('serves a revision through the DataSource once, then from its cache, and clears it when the document closes', async () => {
		let fetches = 0;
		const dataSource = { getCommitFile: async (repo, commit, filePath) => { fetches++; return `${repo}@${commit}:${filePath}`; } };
		const provider = new DiffDocProvider(dataSource);
		vscode.textDocumentContentProviders.clear();
		const uri = encodeDiffDocUri('/r', 'dir/f.txt', 'abc', 'M', 1);

		assert.equal(await provider.provideTextDocumentContent(uri), '/r@abc:dir/f.txt');
		assert.equal(await provider.provideTextDocumentContent(uri), '/r@abc:dir/f.txt');
		assert.equal(fetches, 1);

		vscode.emitters.onDidCloseTextDocument.fire({ uri });
		assert.equal(await provider.provideTextDocumentContent(uri), '/r@abc:dir/f.txt');
		assert.equal(fetches, 2);

		assert.equal(typeof provider.onDidChange, 'function');
		provider.dispose();
	});

	it('returns empty content for a side that does not exist, and the DataSource error otherwise', async () => {
		const provider = new DiffDocProvider({ getCommitFile: async () => { throw 'no such object'; } });
		const missing = encodeDiffDocUri('/r', 'f.txt', 'abc', 'A', 0);
		assert.equal(missing.path.endsWith(' (non-existent)'), true);
		assert.equal(await provider.provideTextDocumentContent(missing), '');
		assert.equal(await provider.provideTextDocumentContent(encodeDiffDocUri('/r', 'f.txt', 'abc', 'M', 1)), t('unableToRetrieveFile', 'no such object'));
		assert.match(await provider.provideTextDocumentContent(vscode.Uri.file('/x').with({ scheme: 'git-graph-rs', query: '!!!' })), /^Error inside provideTextDocumentContent/);
		provider.dispose();
	});

	it('encodes / decodes the URI data, tolerating URL-encoded queries', () => {
		const uri = encodeDiffDocUri('/r', 'dir\\f.txt', 'abc', 'D', 0);
		assert.equal(uri.scheme, 'git-graph-rs');
		assert.deepEqual(decodeDiffDocUri(uri), { filePath: 'dir/f.txt', commit: 'abc', repo: '/r', exists: true });
		assert.deepEqual(decodeDiffDocUri(uri.with({ query: encodeURIComponent(uri.query) })), decodeDiffDocUri(uri));
		assert.equal(encodeDiffDocUri('/r', 'f.txt', '*', 'M', 1).scheme, 'file');
		assert.equal(encodeDiffDocUri('/r', 'f.txt', '*', 'D', 1).scheme, 'git-graph-rs');
		assert.throws(() => decodeDiffDocUri(vscode.Uri.file('/x').with({ query: '%%%' })), new RegExp(t('malformedDiffDocUri').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	});
});

describe('askpass bridge', () => {
	let manager;
	before(() => { manager = new AskpassManager(); });
	after(() => manager.dispose());

	it('exposes the environment Git needs to reach the extension host', () => {
		const env = manager.getEnv();
		assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
		assert.ok(env.GIT_ASKPASS.endsWith('askpass.sh'));
		assert.equal(env.VSCODE_GIT_GRAPH_ASKPASS_NODE, process.execPath);
		assert.ok(env.VSCODE_GIT_GRAPH_ASKPASS_MAIN.endsWith('askpassMain.js'));
		assert.ok(env.VSCODE_GIT_GRAPH_ASKPASS_HANDLE.includes('git-graph-askpass-'));
	});

	function runAskpassMain(args, extraEnv) {
		return new Promise((resolve) => {
			const child = spawn(process.execPath, [path.join(root, 'out', 'askpass', 'askpassMain.js'), ...args], { env: { ...process.env, ...manager.getEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
			let stderr = '';
			child.stderr.on('data', (d) => stderr += d);
			child.on('exit', (code) => resolve({ code, stderr }));
		});
	}

	it('askpassMain relays the prompt to the editor and writes the answer to the pipe file', async () => {
		const pipe = path.join(tmp, 'askpass-pipe');
		vscode.responses.showInputBox = ['s3cret'];
		vscode.resetCalls();
		const result = await runAskpassMain(['Password for', "'https://user@example.com':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(fs.readFileSync(pipe, 'utf8'), 's3cret\n');
		const prompt = vscode.callsTo('showInputBox')[0].args[0];
		assert.equal(prompt.placeHolder, 'Password for');
		assert.equal(prompt.prompt, 'Git Graph RS: https://user@example.com');
		assert.equal(prompt.password, true);
		assert.equal(prompt.ignoreFocusOut, true);

		// A dismissed prompt answers with an empty string; a username prompt is not masked
		vscode.responses.showInputBox = [undefined];
		vscode.resetCalls();
		await runAskpassMain(['Username for', "'https://example.com':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe });
		assert.equal(fs.readFileSync(pipe, 'utf8'), '\n');
		assert.equal(vscode.callsTo('showInputBox')[0].args[0].password, false);
	});

	it('askpassMain fails on bad arguments, missing environment, or an editor failure', async () => {
		const pipe = path.join(tmp, 'askpass-pipe-2');
		assert.equal((await runAskpassMain(['only-one'], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe })).code, 1);
		assert.equal((await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe, VSCODE_GIT_GRAPH_ASKPASS_HANDLE: '' })).code, 1);
		assert.equal((await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: '' })).code, 1);
		const unreachable = await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe, VSCODE_GIT_GRAPH_ASKPASS_HANDLE: path.join(tmp, 'no-such-socket') });
		assert.equal(unreachable.code, 1);
		assert.match(unreachable.stderr, /Error in request/);

		vscode.responses.showInputBox = [new Error('editor gone')];
		const failed = await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe });
		assert.equal(failed.code, 1);
		assert.match(failed.stderr, /Bad status code: 500/);
	});

	it('the server rejects malformed requests', async () => {
		const http = await import('node:http');
		const post = (body) => new Promise((resolve, reject) => {
			const req = http.request({ socketPath: manager.getEnv().VSCODE_GIT_GRAPH_ASKPASS_HANDLE, path: '/', method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
			req.on('error', reject);
			req.end(body);
		});
		assert.equal(await post('not json'), 400);
		assert.equal(await post(JSON.stringify({ request: 1, host: 'x' })), 400);
	});
});

describe('activate()', () => {
	it('boots every subsystem against the workspace repository and tears them down through the subscriptions', async () => {
		const { activate, deactivate } = await import('../out/extension.js');
		const context = {
			subscriptions: [],
			extensionPath: root,
			globalStoragePath: path.join(tmp, 'global-storage'),
			globalState: createMemento(),
			workspaceState: createMemento()
		};
		vscode.settings.enableLog = true;
		vscode.resetCalls();
		vscode.outputChannels.length = 0;
		vscode.statusBarItems.length = 0;

		await activate(context);
		const channel = vscode.outputChannels[0];
		assert.ok(channel.lines.some((line) => line.includes('Starting Git Graph')));
		assert.ok(channel.lines.some((line) => /Using .* \(version: \d/.test(line)));
		assert.ok(channel.lines.some((line) => line.includes('Started Git Graph - Ready to use!')));
		assert.ok(fs.existsSync(path.join(tmp, 'global-storage', 'git-graph-rs.log')));
		assert.ok(vscode.registeredCommands.has('git-graph-rs.view'));
		assert.ok(vscode.textDocumentContentProviders.has('git-graph-rs'));
		assert.equal(context.globalState.store.lastKnownGitPath !== undefined, true);

		// The repository in the workspace is discovered, which shows the status bar item
		for (let i = 0; i < 100 && !vscode.statusBarItems[0].visible; i++) await sleep(50);
		assert.equal(vscode.statusBarItems[0].visible, true);
		assert.ok(Object.keys(context.workspaceState.store.repoStates ?? {}).some((repo) => repo.endsWith('/repo')));

		// Configuration changes are forwarded (and toggle logging); a git.path change re-resolves Git
		vscode.settings.enableLog = false;
		vscode.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s) => s === 'git-graph-rs' });
		const linesBefore = channel.lines.length;
		vscode.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s) => s === 'git-graph-rs' });
		assert.equal(channel.lines.length, linesBefore);
		vscode.settings.enableLog = true;
		vscode.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s) => s === 'git-graph-rs' });

		vscode.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s) => s === 'git.path' }); // no paths configured: ignored
		vscode.settings['git.path'] = ['git'];
		vscode.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s) => s === 'git.path' });
		for (let i = 0; i < 100 && !vscode.callsTo('showInformationMessage').some((c) => /now using/i.test(c.args[0]) || c.args[0] === t('nowUsingGit', 'git', c.args[0].match(/version[^\d]*([\d.]+)/)?.[1] ?? '')); i++) await sleep(50);
		assert.ok(channel.lines.some((line) => line.includes('git') && /version/.test(line)));

		vscode.settings['git.path'] = [path.join(tmp, 'no-such-git')];
		vscode.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s) => s === 'git.path' });
		for (let i = 0; i < 100 && !vscode.callsTo('showErrorMessage').some((c) => c.args[0] === t('gitPathInvalid', path.join(tmp, 'no-such-git'), t('gitPathInvalidMatch'))); i++) await sleep(50);
		assert.ok(vscode.callsTo('showErrorMessage').some((c) => c.args[0] === t('gitPathInvalid', path.join(tmp, 'no-such-git'), t('gitPathInvalidMatch'))));
		delete vscode.settings['git.path'];

		deactivate();
		for (const subscription of context.subscriptions) subscription.dispose();
		assert.equal(vscode.registeredCommands.size, 0);
		assert.equal(channel.disposed, true);
	});

	it('reports a missing Git executable and still activates', async () => {
		const { activate } = await import('../out/extension.js');
		const context = {
			subscriptions: [],
			extensionPath: root,
			globalStoragePath: path.join(tmp, 'global-storage-2'),
			globalState: createMemento({ lastKnownGitPath: path.join(tmp, 'no-such-git') }),
			workspaceState: createMemento()
		};
		vscode.resetCalls();
		vscode.settings['git.path'] = [path.join(tmp, 'no-such-git')];
		const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		const savedPath = process.env.PATH;
		// Route the platform search to a directory holding no git at all
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
		process.env.PATH = tmp;
		try {
			await activate(context);
		} finally {
			Object.defineProperty(process, 'platform', savedPlatform);
			process.env.PATH = savedPath;
			delete vscode.settings['git.path'];
		}
		const messages = [...vscode.callsTo('showErrorMessage'), ...vscode.callsTo('showInformationMessage')].map((c) => c.args[0]);
		assert.ok(messages.includes(t('unableToFindGit')) || messages.includes(t('noGitRunsOnEngine')), messages.join('\n'));
		for (const subscription of context.subscriptions) subscription.dispose();
	});
});

void headHash;

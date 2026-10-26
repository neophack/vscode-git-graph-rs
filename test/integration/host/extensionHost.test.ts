/**
 * The smaller extension-host components that sit between the editor and the git layer:
 * the StatusBarItem, the DiffDocProvider (readonly revision documents), the askpass bridge (the
 * HTTP server in the extension host and the askpassMain.js helper Git launches), and `activate()`
 * itself, booted against a real throwaway repository with every subsystem wired up.
 *
 * Ported from tests/extensionHost.test.mjs (REFACTOR-PLAN task 7.1). The ExtensionState and
 * Logger describes of the former file are already absorbed by the colocated suites
 * (src/extension/platform/storage.test.ts, src/extension/platform/logger.test.ts) and are not
 * duplicated here; every remaining assertion is unchanged.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { vscodeState } from '../../support/vscodeAlias';
import { vscodeMockOf } from '../../support/fakeVscode';
import { StatusBarItem } from '../../../src/extension/statusBar';
import { DiffDocProvider, encodeDiffDocUri, decodeDiffDocUri } from '../../../src/extension/views/diffDocProvider';
import { AskpassManager } from '../../../src/askpass/askpassManager';
import { EventEmitter } from '../../../src/utils/event';
import { t } from '../../../src/i18n';
import { activate, deactivate } from '../../../src/extension';

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-host-'));
const repoDir = path.join(tmp, 'repo');
fs.mkdirSync(repoDir);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
fs.writeFileSync(path.join(repoDir, 'a.txt'), 'first\n');
execFileSync('git', ['add', 'a.txt'], { cwd: repoDir });
execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: repoDir });

/* Point the shared alias stub at the throwaway workspace. */
const stub: any = vscodeMockOf(vscodeState);
stub.workspace.workspaceFolders = [{ uri: stub.Uri.file(repoDir), name: 'repo', index: 0 }];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits until the condition holds, instead of a fixed sleep racing an fs callback
const waitFor = async (condition: () => boolean) => {
	for (let i = 0; i < 200 && !condition(); i++) await sleep(25);
};

// Windows keeps transient handles on freshly-written temp trees (AV scans, indexer, a git child
// mid-exit); the cleanup is a bounded retry and best-effort - a stuck temp dir must not fail
// behaviour tests that already passed.
afterAll(async () => {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== 'EPERM') return; // best-effort: the OS reclaims its temp root
		}
		await sleep(200);
	}
});

describe('StatusBarItem', () => {
	it('is shown only while repositories are known and the setting is enabled', () => {
		const repoEmitter = new EventEmitter();
		const configEmitter = new EventEmitter();
		const lines: Array<{ level: string, message: string }> = [];
		const logger = { lines, log(message: string) { lines.push({ level: 'log', message }); }, logCmd() { /* silent */ }, logError() { /* silent */ }, dispose() { /* silent */ } };
		vscodeState.statusBarItems.length = 0;
		delete vscodeState.settings.showStatusBarItem;
		const item = new StatusBarItem(0, repoEmitter.subscribe as never, configEmitter.subscribe as never, logger as never);
		const bar = vscodeState.statusBarItems[0] as any;
		assert.equal(bar.alignment, 1 /* StatusBarAlignment.Left */);
		assert.equal(bar.text, 'Git Graph RS');
		assert.equal(bar.tooltip, t('viewGitGraphRs' as never));
		assert.equal(bar.command, 'git-graph-rs.view');
		assert.equal(bar.visible, false);

		repoEmitter.emit({ repos: {}, numRepos: 2, loadRepo: null });
		assert.equal(bar.visible, true);
		assert.equal(lines.at(-1)!.message, 'Showing "Git Graph" Status Bar Item');

		repoEmitter.emit({ repos: {}, numRepos: 2, loadRepo: null }); // unchanged: no extra show
		assert.equal(bar.shows, 1);

		vscodeState.settings.showStatusBarItem = false;
		configEmitter.emit({ affectsConfiguration: () => false }); // some other setting
		assert.equal(bar.visible, true);
		configEmitter.emit({ affectsConfiguration: (s: string) => s === 'git-graph-rs.showStatusBarItem' });
		assert.equal(bar.visible, false);
		assert.equal(lines.at(-1)!.message, 'Hiding "Git Graph" Status Bar Item');

		vscodeState.settings.showStatusBarItem = true;
		configEmitter.emit({ affectsConfiguration: (s: string) => s === 'git-graph-rs.showStatusBarItem' });
		assert.equal(bar.visible, true);
		repoEmitter.emit({ repos: {}, numRepos: 0, loadRepo: null });
		assert.equal(bar.visible, false);

		item.dispose();
		assert.equal(bar.disposed, true);
		assert.equal(repoEmitter.hasSubscribers(), false);
	});

	it('starts visible when repositories are already known', () => {
		const repoEmitter = new EventEmitter();
		const configEmitter = new EventEmitter();
		const logger = { lines: [] as unknown[], log() { /* silent */ }, logCmd() { /* silent */ }, logError() { /* silent */ }, dispose() { /* silent */ } };
		vscodeState.statusBarItems.length = 0;
		const item = new StatusBarItem(3, repoEmitter.subscribe as never, configEmitter.subscribe as never, logger as never);
		assert.equal((vscodeState.statusBarItems[0] as any).visible, true);
	});
});

describe('DiffDocProvider', () => {
	it('serves a revision through the read face once, then from its cache, and clears it when the document closes', async () => {
		let fetches = 0;
		const read = { getCommitFile: async (repo: string, commit: string, filePath: string) => { fetches++; return { contents: `${repo}@${commit}:${filePath}` }; } };
		const provider = new DiffDocProvider(read as never);
		vscodeState.textDocumentContentProviders.clear();
		const uri = encodeDiffDocUri('/r', 'dir/f.txt', 'abc', 'M', 1);

		assert.equal(await provider.provideTextDocumentContent(uri), '/r@abc:dir/f.txt');
		assert.equal(await provider.provideTextDocumentContent(uri), '/r@abc:dir/f.txt');
		assert.equal(fetches, 1);

		vscodeState.emitters.onDidCloseTextDocument.fire({ uri });
		assert.equal(await provider.provideTextDocumentContent(uri), '/r@abc:dir/f.txt');
		assert.equal(fetches, 2);

		assert.equal(typeof provider.onDidChange, 'function');
		provider.dispose();
	});

	it('returns empty content for a side that does not exist, and the read error otherwise', async () => {
		const provider = new DiffDocProvider({ getCommitFile: async () => { throw 'no such object'; } } as never);
		const missing = encodeDiffDocUri('/r', 'f.txt', 'abc', 'A', 0);
		assert.equal((missing as any).path.endsWith(' (non-existent)'), true);
		assert.equal(await provider.provideTextDocumentContent(missing), '');
		assert.equal(await provider.provideTextDocumentContent(encodeDiffDocUri('/r', 'f.txt', 'abc', 'M', 1)), t('unableToRetrieveFile' as never, 'no such object'));
		assert.match(String(await provider.provideTextDocumentContent((stub.Uri.file('/x') as any).with({ scheme: 'git-graph-rs', query: '!!!' }))), /^Error inside provideTextDocumentContent/);
		provider.dispose();
	});

	it('encodes / decodes the URI data, tolerating URL-encoded queries', () => {
		const uri = encodeDiffDocUri('/r', 'dir\\f.txt', 'abc', 'D', 0) as any;
		assert.equal(uri.scheme, 'git-graph-rs');
		assert.deepEqual(decodeDiffDocUri(uri), { filePath: 'dir/f.txt', commit: 'abc', repo: '/r', exists: true });
		assert.deepEqual(decodeDiffDocUri(uri.with({ query: encodeURIComponent(uri.query) })), decodeDiffDocUri(uri));
		assert.equal((encodeDiffDocUri('/r', 'f.txt', '*', 'M', 1) as any).scheme, 'file');
		assert.equal((encodeDiffDocUri('/r', 'f.txt', '*', 'D', 1) as any).scheme, 'git-graph-rs');
		const malformedMessage = t('malformedDiffDocUri' as never).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		assert.throws(() => decodeDiffDocUri((stub.Uri.file('/x') as any).with({ query: '%%%' })), new RegExp(malformedMessage));
	});
});

describe('askpass bridge', () => {
	let manager: AskpassManager;

	beforeAll(() => { manager = new AskpassManager(); });
	afterAll(() => manager.dispose());

	it('exposes the environment Git needs to reach the extension host', () => {
		const env = manager.getEnv();
		assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
		assert.ok(env.GIT_ASKPASS!.endsWith('askpass.sh'));
		assert.equal(env.VSCODE_GIT_GRAPH_ASKPASS_NODE, process.execPath);
		assert.ok(env.VSCODE_GIT_GRAPH_ASKPASS_MAIN!.endsWith('askpassMain.js'));
		assert.ok(env.VSCODE_GIT_GRAPH_ASKPASS_HANDLE!.includes('git-graph-askpass-'));
	});

	function runAskpassMain(args: string[], extraEnv: Record<string, string>) {
		// The askpass helper ships as dist/askpass/askpassMain.js (npm run build:dist); the suite
		// self-skips when the dist tree has not been built.
		const helper = path.join(root, 'dist', 'askpass', 'askpassMain.js');
		if (!fs.existsSync(helper)) return Promise.resolve({ code: -1, stderr: '', skipped: 'dist/askpass/askpassMain.js has not been built (run "npm run build:dist"); skipping' });
		return new Promise((resolve) => {
			const child = spawn(process.execPath, [helper, ...args], { env: { ...process.env, ...manager.getEnv(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
			let stderr = '';
			child.stderr.on('data', (d) => stderr += d);
			child.on('exit', (code) => resolve({ code: code ?? -1, stderr, skipped: null as string | null }));
		});
	}

	it('askpassMain relays the prompt to the editor and writes the answer to the pipe file', async () => {
		const pipe = path.join(tmp, 'askpass-pipe');
		vscodeState.responses.showInputBox = ['s3cret'];
		vscodeState.resetCalls();
		const result = await runAskpassMain(['Password for', "'https://user@example.com':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe });
		if (result.skipped) return void console.warn(result.skipped);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(fs.readFileSync(pipe, 'utf8'), 's3cret\n');
		const prompt = vscodeState.callsTo('showInputBox')[0].args[0] as any;
		assert.equal(prompt.placeHolder, 'Password for');
		assert.equal(prompt.prompt, 'Git Graph RS: https://user@example.com');
		assert.equal(prompt.password, true);
		assert.equal(prompt.ignoreFocusOut, true);

		// A dismissed prompt answers with an empty string; a username prompt is not masked
		vscodeState.responses.showInputBox = [undefined];
		vscodeState.resetCalls();
		await runAskpassMain(['Username for', "'https://example.com':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe });
		assert.equal(fs.readFileSync(pipe, 'utf8'), '\n');
		assert.equal((vscodeState.callsTo('showInputBox')[0].args[0] as any).password, false);
	});

	it('askpassMain fails on bad arguments, missing environment, or an editor failure', async () => {
		const pipe = path.join(tmp, 'askpass-pipe-2');
		assert.equal((await runAskpassMain(['only-one'], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe })).code, 1);
		assert.equal((await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe, VSCODE_GIT_GRAPH_ASKPASS_HANDLE: '' })).code, 1);
		assert.equal((await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: '' })).code, 1);
		const unreachable = await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe, VSCODE_GIT_GRAPH_ASKPASS_HANDLE: path.join(tmp, 'no-such-socket') });
		assert.equal(unreachable.code, 1);
		assert.match(unreachable.stderr, /Error in request/);

		vscodeState.responses.showInputBox = [new Error('editor gone')];
		const failed = await runAskpassMain(['Password', "'h':"], { VSCODE_GIT_GRAPH_ASKPASS_PIPE: pipe });
		assert.equal(failed.code, 1);
		assert.match(failed.stderr, /Bad status code: 500/);
	});

	it('the server rejects malformed requests', async () => {
		const http = await import('node:http');
		const post = (body: string) => new Promise((resolve, reject) => {
			const req = http.request({ socketPath: manager.getEnv().VSCODE_GIT_GRAPH_ASKPASS_HANDLE, path: '/', method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
			req.on('error', reject);
			req.end(body);
		});
		assert.equal(await post('not json'), 400);
		assert.equal(await post(JSON.stringify({ request: 1, host: 'x' })), 400);
	});
});

/* ---------- a Memento that can be made to fail ---------- */
function createMemento(initial: Record<string, unknown> = {}) {
	const store = Object.assign({}, initial);
	return {
		store,
		failNext: false,
		get: (key: string, defaultValue: unknown) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue,
		update(this: { failNext: boolean, store: Record<string, unknown> }, key: string, value: unknown) {
			if (this.failNext) { this.failNext = false; return Promise.reject(new Error('memento unavailable')); }
			this.store[key] = value;
			return Promise.resolve();
		},
		keys: () => Object.keys(store)
	};
}

describe('activate()', () => {
	it('boots every subsystem against the workspace repository and tears them down through the subscriptions', async () => {
		const context = {
			subscriptions: [] as Array<{ dispose(): void }>,
			extensionPath: root,
			globalStoragePath: path.join(tmp, 'global-storage'),
			globalState: createMemento(),
			workspaceState: createMemento()
		};
		vscodeState.settings.enableLog = true;
		vscodeState.resetCalls();
		vscodeState.outputChannels.length = 0;
		vscodeState.statusBarItems.length = 0;

		await activate(context as never);
		const channel = vscodeState.outputChannels[0] as any;
		assert.ok(channel.lines.some((line: string) => line.includes('Starting Git Graph')));
		assert.ok(channel.lines.some((line: string) => /Using .* \(version: \d/.test(line)));
		assert.ok(channel.lines.some((line: string) => line.includes('Started Git Graph - Ready to use!')));
		assert.ok(fs.existsSync(path.join(tmp, 'global-storage', 'git-graph-rs.log')));
		assert.ok(vscodeState.registeredCommands.has('git-graph-rs.view'));
		assert.ok(vscodeState.textDocumentContentProviders.has('git-graph-rs'));
		assert.equal((context.globalState.store as Record<string, unknown>).lastKnownGitPath !== undefined, true);

		// The repository in the workspace is discovered, which shows the status bar item
		for (let i = 0; i < 100 && !(vscodeState.statusBarItems[0] as any)?.visible; i++) await sleep(50);
		assert.equal((vscodeState.statusBarItems[0] as any).visible, true);
		assert.ok(Object.keys(((context.workspaceState.store as any).repoStates?.data ?? {})).some((repo) => repo.endsWith('/repo')));

		// Configuration changes are forwarded (and toggle logging); a git.path change re-resolves Git
		vscodeState.settings.enableLog = false;
		vscodeState.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s: string) => s === 'git-graph-rs' });
		const linesBefore = channel.lines.length;
		vscodeState.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s: string) => s === 'git-graph-rs' });
		assert.equal(channel.lines.length, linesBefore);
		vscodeState.settings.enableLog = true;
		vscodeState.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s: string) => s === 'git-graph-rs' });

		vscodeState.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s: string) => s === 'git.path' }); // no paths configured: ignored
		vscodeState.settings['git.path'] = ['git'];
		vscodeState.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s: string) => s === 'git.path' });
		for (let i = 0; i < 100 && !vscodeState.callsTo('showInformationMessage').some((c) => /now using/i.test(String(c.args[0])) || c.args[0] === t('nowUsingGit' as never, 'git', String(c.args[0]).match(/version[^\d]*([\d.]+)/)?.[1] ?? '')); i++) await sleep(50);
		assert.ok(channel.lines.some((line: string) => line.includes('git') && /version/.test(line)));

		vscodeState.settings['git.path'] = [path.join(tmp, 'no-such-git')];
		vscodeState.emitters.onDidChangeConfiguration.fire({ affectsConfiguration: (s: string) => s === 'git.path' });
		for (let i = 0; i < 100 && !vscodeState.callsTo('showErrorMessage').some((c) => c.args[0] === t('gitPathInvalid' as never, path.join(tmp, 'no-such-git'), t('gitPathInvalidMatch' as never))); i++) await sleep(50);
		assert.ok(vscodeState.callsTo('showErrorMessage').some((c) => c.args[0] === t('gitPathInvalid' as never, path.join(tmp, 'no-such-git'), t('gitPathInvalidMatch' as never))));
		delete vscodeState.settings['git.path'];

		deactivate();
		for (const subscription of context.subscriptions) subscription.dispose();
		assert.equal(vscodeState.registeredCommands.size, 0);
		assert.equal(channel.disposed, true);
	}, 120000);

	it('reports a missing Git executable and still activates', async () => {
		const context = {
			subscriptions: [] as Array<{ dispose(): void }>,
			extensionPath: root,
			globalStoragePath: path.join(tmp, 'global-storage-2'),
			globalState: createMemento({ lastKnownGitPath: path.join(tmp, 'no-such-git') }),
			workspaceState: createMemento()
		};
		vscodeState.resetCalls();
		vscodeState.settings['git.path'] = [path.join(tmp, 'no-such-git')];
		const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
		const savedPath = process.env.PATH;
		// Route the platform search to a directory holding no git at all
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
		process.env.PATH = tmp;
		try {
			await activate(context as never);
		} finally {
			Object.defineProperty(process, 'platform', savedPlatform!);
			process.env.PATH = savedPath;
			delete vscodeState.settings['git.path'];
		}
		const messages = [...vscodeState.callsTo('showErrorMessage'), ...vscodeState.callsTo('showInformationMessage')].map((c) => c.args[0]);
		assert.ok(messages.includes(t('unableToFindGit' as never)) || messages.includes(t('noGitRunsOnEngine' as never)), messages.join('\n'));
		for (const subscription of context.subscriptions) subscription.dispose();
	}, 120000);
});

void waitFor;

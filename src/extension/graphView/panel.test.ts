import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvatarManager } from '../integrations/avatars/avatarManager';
import type { ExtensionState } from '../platform/storage';
import type { Logger } from '../platform/logger';
import type { GitCommitData, GitRepoInfo } from '../git/read/types';
import type { GitGraphViewSnapshot, RequestMessage, ResponseMessage } from '../../types';
import { setLiveGraphView } from '../../automation/graphViewPort';

/**
 * Panel tests with a fake 'vscode' module (REFACTOR-PLAN task 4.4's acceptance: panel
 * restoration and orphaned tabs have tests with a fake vscode): the panel lifecycle, the
 * generated HTML's CSP/nonce discipline, the orphaned-tab replacement (both the no-Tab-API
 * degradation and the in-place replacement), the message routing through the handler table,
 * and the open path of task 4.7 - the panel begins the merged loadView read at creation and
 * pushes it when the page reports `ready`, sending no loadRepoInfo/loadCommits at boot. The
 * heavier handler behaviors live in handlers/*.test.ts; the staged loading pipeline in
 * commitLoader.test.ts.
 */

/** The mutable state the hoisted vscode mock reads and the tests steer (plain recorders). */
const vs = vi.hoisted(() => {
	const state = {
		panelCalls: [] as unknown[][],
		createdPanels: [] as { webview: { html: string, options: unknown }, disposed: boolean }[],
		postMessages: [] as unknown[][],
		errorMessages: [] as string[],
		tabGroups: undefined as unknown
	};
	const makePanel = () => {
		const index = state.createdPanels.length;
		state.postMessages[index] = [];
		const panel = {
			webview: {
				html: '',
				cspSource: 'https://vscode-cdn.test',
				options: undefined as unknown,
				asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => 'webview://' + uri.fsPath }),
				postMessage: (msg: unknown) => {
					state.postMessages[index].push(msg);
					return Promise.resolve(true);
				},
				onDidReceiveMessage: () => ({ dispose: () => { } })
			},
			viewColumn: 1,
			visible: true,
			title: '',
			iconPath: undefined as unknown,
			disposed: false,
			onDidDispose: () => ({ dispose: () => { } }),
			onDidChangeViewState: () => ({ dispose: () => { } }),
			reveal: () => { },
			dispose: () => { panel.disposed = true; }
		};
		state.createdPanels.push(panel);
		return panel;
	};
	return { state: state, makePanel: makePanel };
});

vi.mock('vscode', () => ({
	Uri: { file: (p: string) => ({ fsPath: p, toString: () => 'file:///' + p }) },
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	// The repo file watcher constructs its watcher glob from one of these
	RelativePattern: class {
		constructor(public base: unknown, public pattern: string) {}
	},
	env: { uriScheme: 'vscode', language: 'en-US' },
	window: {
		activeTextEditor: undefined,
		createWebviewPanel: (...args: unknown[]) => {
			vs.state.panelCalls.push(args);
			return vs.makePanel();
		},
		showErrorMessage: (message: string) => {
			vs.state.errorMessages.push(message);
			return Promise.resolve(undefined); // utils/actions chains .then on the result
		},
		showInformationMessage: () => Promise.resolve(undefined),
		get tabGroups() { return vs.state.tabGroups; }
	},
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue: unknown) => defaultValue,
			inspect: () => undefined,
			update: async () => { }
		}),
		onDidChangeConfiguration: (_listener: unknown) => ({ dispose: () => { } }),
		createFileSystemWatcher: () => ({
			onDidCreate: () => ({ dispose: () => { } }),
			onDidChange: () => ({ dispose: () => { } }),
			onDidDelete: () => ({ dispose: () => { } })
		}),
		openTextDocument: async () => { throw new Error('not needed'); },
		showTextDocument: async () => { throw new Error('not needed'); }
	}
}));

import { GitGraphView } from './panel';

/** The collaborators the panel holds, as recording fakes. */
function fakeCollaborators() {
	const logger = {
		logs: [] as string[],
		log(message: string) { this.logs.push(message); },
		logError(message: string) { this.logs.push(message); },
		getLogFile: () => null
	};
	const extensionState = {
		getLastActiveRepo: vi.fn(() => '/repo'),
		setLastActiveRepo: vi.fn(),
		getGlobalViewState: vi.fn(() => ({})),
		getWorkspaceViewState: vi.fn(() => ({})),
		getViewSnapshot: vi.fn(() => ({ currentRepo: 'REPLACEMENT-SNAPSHOT' } as unknown as GitGraphViewSnapshot)),
		setViewSnapshot: vi.fn(),
		setGlobalViewState: vi.fn(async () => null),
		setWorkspaceViewState: vi.fn(async () => null),
		isAvatarStorageAvailable: vi.fn(() => false)
	};
	const commitPage: GitCommitData = {
		commits: [{ hash: 'a', parents: [], author: 'A', email: 'a@x', date: 1, message: 'm', heads: [], tags: [], remotes: [], stash: null }],
		head: 'a', tags: [], branches: ['main'], moreCommitsAvailable: false, error: null
	};
	const repoInfo: GitRepoInfo = { branches: ['main'], head: 'main', remotes: [], stashes: [], tags: [], error: null };
	// The GitRepository facade: the reads the merged loadView read (and the poll) consume.
	const repo = {
		read: {
			getCommits: vi.fn(async () => commitPage),
			getRepoInfo: vi.fn(async () => repoInfo),
			getOperationState: vi.fn(async () => ({ type: null, conflictedFiles: [], progress: null })),
			getUncommittedChangeCount: vi.fn(async () => 0),
			getRepoChangeSignature: vi.fn(async () => null),
			closeRepository: vi.fn()
		},
		write: {
			run: vi.fn(async () => null),
			policies: { signCommits: false, signTags: false },
			// The writer's repository-changed event (task 4.8's effect collection): no fake
			// writes happen in these tests, so the listener is registered and never fires.
			onRepositoryChanged: vi.fn(() => ({ dispose: () => undefined }))
		},
		getOperationState: vi.fn(async () => ({ type: null, conflictedFiles: [], progress: null }))
	};
	const git = {
		gitOutput: vi.fn(async () => ''),
		runGitCommand: vi.fn(async () => null),
		runGitCommandWithInput: vi.fn(async () => null),
		collect: vi.fn(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })),
		hasGit: vi.fn(() => true),
		gitPath: vi.fn(() => null),
		parseGerritMetas: null,
		listChangeRefs: null
	};
	const legacyViews = {
		openCompareTab: vi.fn(),
		openBinaryCompare: vi.fn()
	};
	const repoManager = {
		getRepos: vi.fn(() => ({ '/repo': 'repo' })),
		onDidChangeRepos: vi.fn(() => ({ dispose: () => { } })),
		checkReposExist: vi.fn(async () => false),
		searchWorkspaceForRepos: vi.fn(async () => true),
		setRepoState: vi.fn(),
		exportRepoConfig: vi.fn(async () => null)
	};
	const avatarManager = { onAvatar: vi.fn(() => ({ dispose: () => { } })) };
	return { logger, extensionState, repo, git, legacyViews, repoManager, avatarManager };
}

type Collaborators = ReturnType<typeof fakeCollaborators>;

/** The args the statics forward (everything but the panel object they may create or receive). */
type StaticArgs = [string, never, never, never, ExtensionState, AvatarManager, never, Logger];

function staticArgs(col: Collaborators): StaticArgs {
	return ['/ext', col.repo, col.git, col.legacyViews, col.extensionState, col.avatarManager, col.repoManager, col.logger] as unknown as StaticArgs;
}

function openView(col: Collaborators) {
	const panelsBefore = vs.state.createdPanels.length;
	GitGraphView.createOrShow(...staticArgs(col), null);
	const view = GitGraphView.currentPanel;
	expect(view).toBeDefined();
	return { view: view!, panelIndex: panelsBefore };
}

/** Let the dispatcher's async work settle (postMessage chains, follow-up promises). */
async function flush(times = 12): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
	GitGraphView.currentPanel?.dispose();
	GitGraphView.currentPanel = undefined;
	setLiveGraphView(null);
	vs.state.panelCalls.length = 0;
	vs.state.createdPanels.length = 0;
	vs.state.postMessages.length = 0;
	vs.state.errorMessages.length = 0;
	vs.state.tabGroups = undefined;
	vi.useRealTimers();
});

describe('GitGraphView panel', () => {
	it('renders the HTML shell with a nonce and a CSP without an unsafe-inline script source', () => {
		const col = fakeCollaborators();
		const { panelIndex } = openView(col);
		const html = vs.state.createdPanels[panelIndex].webview.html;
		expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src [^;]+ 'unsafe-inline'; script-src 'nonce-[A-Za-z0-9]{32}' https?:[^;"]+(?:;|")/);
		// The script-src directive carries the nonce plus the webview's own resource origin - the
		// module chunks of task 5.9's code splitting load through relative dynamic import(), which
		// a nonce cannot cover - but no unsafe-inline and no unsafe-eval (the automation shim is
		// not present under the test extension path)
		const scriptSrc = /script-src ([^;"]+)/.exec(html)![1];
		expect(scriptSrc).toMatch(/^'nonce-[A-Za-z0-9]{32}' https?:.+$/);
		expect(scriptSrc).not.toContain('unsafe-eval');
		expect(scriptSrc).not.toContain('unsafe-inline');
		// Every inline script the page carries is nonce-tagged
		expect(html).toMatch(/<script nonce="[A-Za-z0-9]{32}">var initialState =/);
		expect(html.match(/<script(?![^>]*nonce=)/g)).toBeNull();
		// The view's bundle loads as an ES MODULE (task 5.9): its on-demand chunks follow through
		// relative dynamic import(). The Markdown renderer's vendor preload is gone with it - the
		// renderer itself became one of those chunks.
		expect(html).toMatch(/<script nonce="[A-Za-z0-9]{32}" type="module" src="[^"]*out\.min\.js\?v=/);
		expect(html).not.toContain('vendor/markdown-it.min.js');
	});

	it('restore attaches a revived panel instead of creating a new one', () => {
		const col = fakeCollaborators();
		const revived = vs.makePanel();
		GitGraphView.restore(revived as never, ...staticArgs(col));
		expect(vs.state.panelCalls.length).toBe(0); // no panel created: the revived one is reused
		expect(revived.webview.options).toEqual({ enableScripts: true, localResourceRoots: [expect.objectContaining({ fsPath: expect.stringContaining('media') })] });
		expect(GitGraphView.currentPanel).toBeDefined();
		expect(revived.webview.html).toContain('initialState');
	});

	it('restore disposes a second revived panel: a second view cannot share the singleton state', () => {
		const col = fakeCollaborators();
		const first = openView(col);
		expect(first.view).toBeDefined();
		const revived = vs.makePanel();
		GitGraphView.restore(revived as never, ...staticArgs(col));
		expect(revived.disposed).toBe(true);
		expect(GitGraphView.currentPanel).toBe(first.view);
	});

	it('watchForOrphanedTabs degrades to a no-op without the Tab API (VS Code < 1.67)', () => {
		const col = fakeCollaborators();
		vs.state.tabGroups = undefined; // no Tab Groups API at all
		const watcher = GitGraphView.watchForOrphanedTabs(...staticArgs(col));
		expect(() => watcher.dispose()).not.toThrow();
		expect(vs.state.panelCalls.length).toBe(0);
	});

	it('watchForOrphanedTabs replaces a dead tab in place with a snapshot-carrying view', async () => {
		vi.useFakeTimers();
		const col = fakeCollaborators();
		let closed = 0;
		vs.state.tabGroups = {
			all: [{ viewColumn: 1, isActive: true, activeTab: { input: { viewType: 'git-graph-rs' } }, tabs: [{ input: { viewType: 'git-graph-rs' } }] }],
			close: async () => { closed++; return true; },
			onDidChangeTabs: (_listener: () => void) => ({ dispose: () => { } })
		};
		const watcher = GitGraphView.watchForOrphanedTabs(...staticArgs(col));
		// The debounce: a tab is judged only after the startup grace (5s), so advance past it
		await vi.advanceTimersByTimeAsync(5100);
		expect(vs.state.panelCalls.length).toBe(1); // the replacement, opened BEFORE the close
		expect(closed).toBe(1);
		// The replacement reopens on the stored snapshot: it is embedded into the fresh page
		expect(vs.state.createdPanels[0].webview.html).toContain('REPLACEMENT-SNAPSHOT');
		expect(GitGraphView.currentPanel).toBeDefined();
		watcher.dispose();
	});

	it('answers a message with an unknown command with one log line and an error notification', async () => {
		const col = fakeCollaborators();
		const { view, panelIndex } = openView(col);
		const errorLogsBefore = col.logger.logs.length;
		view.runAutomationRequest({ command: 'definitelyNotACommand' } as unknown as RequestMessage);
		await flush();
		// Exactly one new line naming the command (the merged open read's own log may interleave)
		const newLines = col.logger.logs.slice(errorLogsBefore).filter((line) => line.indexOf('definitelyNotACommand') !== -1);
		expect(newLines.length).toBe(1); // exactly one line
		expect(vs.state.errorMessages.length).toBe(1);
		expect(vs.state.postMessages[panelIndex]).toEqual([]); // nothing posted to the webview
	});

	it('routes a silent persistence command through the handler table', async () => {
		const col = fakeCollaborators();
		const { view } = openView(col);
		const snapshot = { currentRepo: '/repo' } as unknown as GitGraphViewSnapshot;
		view.runAutomationRequest({ command: 'setViewSnapshot', snapshot: snapshot });
		await flush();
		expect(col.extensionState.setViewSnapshot).toHaveBeenCalledWith(snapshot);
	});

	it('routes a responding command through the handler table and posts its response to the webview', async () => {
		const col = fakeCollaborators();
		const { view, panelIndex } = openView(col);
		view.runAutomationRequest({ command: 'loadRepos', check: false });
		await flush();
		const posted = (vs.state.postMessages[panelIndex] || []) as ResponseMessage[];
		const loadRepos = posted.find((msg) => msg.command === 'loadRepos') as { repos: unknown, lastActiveRepo: string | null, loadViewTo: unknown } | undefined;
		expect(loadRepos).toBeDefined();
		expect(loadRepos!.repos).toEqual({ '/repo': 'repo' });
		expect(loadRepos!.lastActiveRepo).toBe('/repo');
		expect(loadRepos!.loadViewTo).toBeNull();
	});

	it('the open path pushes the merged loadView on `ready` and sends no loadRepoInfo/loadCommits (task 4.7)', async () => {
		const col = fakeCollaborators();
		const { view, panelIndex } = openView(col);
		await flush();
		// The panel began the merged read at creation, but pushes NOTHING before the page's handshake
		const before = (vs.state.postMessages[panelIndex] || []) as ResponseMessage[];
		expect(before.filter((msg) => msg.command === 'loadRepoInfo' || msg.command === 'loadCommits' || msg.command === 'loadView')).toEqual([]);

		// The page reports `ready`: the merged result is pushed, with no partial repo-info load at
		// all; the only loadCommits responses are the push's own staged follow-ups (same refresh id)
		view.runAutomationRequest({ command: 'ready' } as unknown as RequestMessage);
		await flush();
		const posted = (vs.state.postMessages[panelIndex] || []) as ResponseMessage[];
		const loadView = posted.find((msg) => msg.command === 'loadView') as { repo: string, refreshId: number, repoInfo: { head: string | null }, commits: { commits: { hash: string }[] } } | undefined;
		expect(loadView).toBeDefined();
		expect(loadView!.repo).toBe('/repo');
		expect(loadView!.repoInfo.head).toBe('main');
		expect(loadView!.commits.commits.map((commit) => commit.hash)).toEqual(['a']);
		expect(posted.filter((msg) => msg.command === 'loadRepoInfo')).toEqual([]);
		for (const followUp of posted.filter((msg) => msg.command === 'loadCommits')) {
			expect((followUp as { refreshId: number }).refreshId).toBe(loadView!.refreshId);
		}

		// The pushed repository became the current one (watcher, poll baseline, last-active follow)
		expect(col.extensionState.setLastActiveRepo).toHaveBeenCalledWith('/repo');
	});
});

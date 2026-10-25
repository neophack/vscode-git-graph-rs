import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvatarManager } from '../../avatarManager';
import type { DataSource } from '../../dataSource';
import type { ExtensionState } from '../../extensionState';
import type { Logger } from '../../logger';
import type { GitGraphViewSnapshot, RequestMessage, ResponseMessage } from '../../types';
import { setLiveGraphView } from '../../automation/graphViewPort';

/**
 * Panel tests with a fake 'vscode' module (REFACTOR-PLAN task 4.4's acceptance: panel
 * restoration and orphaned tabs have tests with a fake vscode): the panel lifecycle, the
 * generated HTML's CSP/nonce discipline, the orphaned-tab replacement (both the no-Tab-API
 * degradation and the in-place replacement), and the message routing through the handler
 * table - including the one-line log + error notification for unknown commands. The heavier
 * handler behaviors live in handlers/*.test.ts; the staged loading pipeline in
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
	const dataSource = {
		isGitExecutableUnknown: vi.fn(() => false),
		getRepoChangeSignature: vi.fn(async () => null),
		gitOutput: vi.fn(async () => ''),
		closeRepository: vi.fn(),
		invalidateConfigCache: vi.fn(),
		gerrit: {}
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
	return { logger, extensionState, dataSource, repoManager, avatarManager };
}

type Collaborators = ReturnType<typeof fakeCollaborators>;

/** The args the statics forward (everything but the panel object they may create or receive). */
type StaticArgs = [string, DataSource, ExtensionState, AvatarManager, never, Logger];

function staticArgs(col: Collaborators): StaticArgs {
	return ['/ext', col.dataSource as unknown as DataSource, col.extensionState as unknown as ExtensionState, col.avatarManager as unknown as AvatarManager, col.repoManager as unknown as never, col.logger as unknown as Logger];
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
		expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src [^;]+ 'unsafe-inline'; script-src 'nonce-[A-Za-z0-9]{32}'(?:;|")/);
		// The script-src directive carries ONLY the nonce (no unsafe-inline, and no unsafe-eval in
		// the default build - the automation shim is not present under the test extension path)
		const scriptSrc = /script-src ([^;"]+)/.exec(html)![1];
		expect(scriptSrc).toMatch(/^'nonce-[A-Za-z0-9]{32}'$/);
		expect(scriptSrc).not.toContain('unsafe-eval');
		// Every inline script the page carries is nonce-tagged
		expect(html).toMatch(/<script nonce="[A-Za-z0-9]{32}">var initialState =/);
		expect(html.match(/<script(?![^>]*nonce=)/g)).toBeNull();
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
		expect(col.logger.logs.length).toBe(errorLogsBefore + 1); // exactly one line
		expect(col.logger.logs[errorLogsBefore]).toContain('definitelyNotACommand');
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
});

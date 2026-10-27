import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The module also carries the Git Graph Extension State absorbed from the former flat
 * src/extensionState.ts, which touches `vscode` types and (through the config reader) the
 * vscode configuration API - a minimal fake 'vscode' module backs it here.
 */
const vscodeMock = vi.hoisted(() => ({
	env: { language: 'en', uriScheme: 'vscode' },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ViewColumn: { Active: 1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: (_section?: string, _scope?: unknown): unknown => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue
		})
	}
}));

vi.mock('vscode', () => vscodeMock);

import type { ExtensionContext } from 'vscode';
import type { ConfigProvider } from './config';
import { DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE, DEFAULT_REPO_STATE, ExtensionState, MementoLike, Storage } from './storage';
import { STORAGE_STATE_VERSION, decodeVersionedState, encodeVersionedState } from './storageVersioned';
import { BooleanOverride, GitGraphViewSnapshot } from '../../shared/model/webview';

/** A memento fake recording every update and answering from a plain map. */
class FakeMemento implements MementoLike {
	private readonly store: Map<string, unknown>;
	public readonly updates: Array<{ key: string; value: unknown }> = [];

	public constructor(values: Record<string, unknown> = {}, private readonly failUpdates = false) {
		this.store = new Map(Object.entries(values));
	}

	/** Seed a stored value directly, bypassing the recorded update log. */
	public setSilently(key: string, value: unknown): void {
		this.store.set(key, value);
	}

	public get<T>(key: string, defaultValue?: T): T | undefined {
		return this.store.has(key) ? this.store.get(key) as T : defaultValue;
	}

	public update(key: string, value: unknown): Promise<void> {
		this.updates.push({ key, value });
		if (this.failUpdates) return Promise.reject(new Error('storage read-only'));
		this.store.set(key, value);
		return Promise.resolve();
	}
}

/** The configuration double: the manifest default the (mocked) configuration read used to answer. */
function testConfig(): ConfigProvider {
	// A structural stand-in: only the member the ExtensionState reads is declared.
	return { current: { repositoryShowRemoteBranches: true } } as unknown as ConfigProvider;
}

describe('Storage', () => {
	it('reads stored values and falls back to the given default', () => {
		const storage = new Storage(new FakeMemento({ 'lastActiveRepo': 'E:/repo', 'count': 3 }));

		expect(storage.get<string>('lastActiveRepo')).toBe('E:/repo');
		expect(storage.get<string>('lastActiveRepo', 'fallback')).toBe('E:/repo');
		expect(storage.get<string>('missing', 'fallback')).toBe('fallback');
		expect(storage.get<number>('count', 0)).toBe(3);
		expect(storage.get('missing')).toBeUndefined();
	});

	it('persists values and resolves TRUE', async () => {
		const memento = new FakeMemento();
		const storage = new Storage(memento);

		await expect(storage.set('lastActiveRepo', 'E:/other')).resolves.toBe(true);
		expect(storage.get<string>('lastActiveRepo')).toBe('E:/other');
		expect(memento.updates).toEqual([{ key: 'lastActiveRepo', value: 'E:/other' }]);
	});

	it('removes keys by updating them to undefined', async () => {
		const memento = new FakeMemento({ 'stale': true });
		const storage = new Storage(memento);

		await expect(storage.remove('stale')).resolves.toBe(true);
		expect(memento.updates).toEqual([{ key: 'stale', value: undefined }]);
	});

	it('is lenient without a store: get answers the default, writes resolve FALSE', async () => {
		const storage = new Storage(null);

		expect(storage.get('anything')).toBeUndefined();
		expect(storage.get('anything', 'default')).toBe('default');
		await expect(storage.set('anything', 1)).resolves.toBe(false);
		await expect(storage.remove('anything')).resolves.toBe(false);
		expect(new Storage(undefined).get('k', 7)).toBe(7);
	});

	it('resolves FALSE when the update rejects, instead of rejecting', async () => {
		const storage = new Storage(new FakeMemento({}, true));

		await expect(storage.set('key', 'value')).resolves.toBe(false);
		await expect(storage.remove('key')).resolves.toBe(false);
	});

	it('answers the default when a malformed store answers a throwing get', () => {
		const throwing: MementoLike = {
			get: () => { throw new Error('corrupt'); },
			update: () => Promise.resolve()
		};
		const storage = new Storage(throwing);

		expect(storage.get('key', 'safe')).toBe('safe');
		expect(storage.get('key')).toBeUndefined();
	});

	it('resolves FALSE when the store lacks update entirely', async () => {
		const storage = new Storage({} as MementoLike);
		await expect(storage.set('key', 'value')).resolves.toBe(false);
	});
});

describe('ExtensionState (absorbed from src/extensionState.ts)', () => {
	/** The shape of vscode.ExtensionContext this module reads, as a plain fake. */
	interface ContextFake {
		globalState: FakeMemento;
		workspaceState: FakeMemento;
		globalStoragePath: string;
	}

	let globalState: FakeMemento;
	let workspaceState: FakeMemento;
	let state: ExtensionState;

	beforeEach(() => {
		globalState = new FakeMemento();
		workspaceState = new FakeMemento();
		const globalStoragePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-storage-'));
		const context = { globalState, workspaceState, globalStoragePath } as ContextFake;
		const onDidChangeGitExecutable = (): { dispose(): void } => ({ dispose: () => undefined });
		state = new ExtensionState(context as unknown as ExtensionContext, onDidChangeGitExecutable, testConfig());
	});

	it('answers the full default repository state for repos without stored state', () => {
		workspaceState.setSilently('repoStates', { 'E:/repo': {} });
		const repos = state.getRepos();
		expect(repos['E:/repo']).toEqual(DEFAULT_REPO_STATE);
	});

	it('migrates a legacy showRemoteBranches value only when it differs from the configured default', () => {
		workspaceState.setSilently('repoStates', {
			'E:/explicitly-off': { showRemoteBranches: false },
			'E:/like-default': { showRemoteBranches: true }
		});
		const repos = state.getRepos();
		// The configured default is TRUE (vscodeMock answers manifest defaults), so only the
		// repository that turned them off gains an explicit V2 value
		expect(repos['E:/explicitly-off'].showRemoteBranchesV2).toBe(BooleanOverride.Disabled);
		expect(repos['E:/like-default'].showRemoteBranchesV2).toBe(BooleanOverride.Default);
	});

	it('round-trips the repo set, ignored repos and last active repo through the workspace state', async () => {
		await state.saveRepos({ 'E:/repo': DEFAULT_REPO_STATE });
		await state.setIgnoredRepos(['E:/ignored']);
		await state.setLastActiveRepo('E:/repo');

		expect(workspaceState.get('repoStates')).toEqual({ version: STORAGE_STATE_VERSION, data: { 'E:/repo': DEFAULT_REPO_STATE } });
		expect(state.getIgnoredRepos()).toEqual(['E:/ignored']);
		expect(state.getLastActiveRepo()).toBe('E:/repo');
	});

	it('reports the memento failure instead of rejecting on a read-only store', async () => {
		const failing = new FakeMemento({}, true);
		const context = {
			globalState: failing,
			workspaceState: failing,
			globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'gg-storage-'))
		};
		const onDidChangeGitExecutable = (): { dispose(): void } => ({ dispose: () => undefined });
		const failingState = new ExtensionState(context as unknown as ExtensionContext, onDidChangeGitExecutable, testConfig());

		await expect(failingState.setCodeReviews({})).resolves.toBe('Visual Studio Code was unable to save the Git Graph Workspace State Memento.');
		await expect(failingState.setGlobalViewState({ alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false })).resolves.toBe('Visual Studio Code was unable to save the Git Graph Global State Memento.');
	});

	it('transfers the last active repo and the code reviews of a renamed repository', async () => {
		await state.setLastActiveRepo('E:/old');
		await state.startCodeReview('E:/old', 'abc123', ['a.ts', 'b.ts'], null);

		state.transferRepo('E:/old', 'E:/new');

		expect(state.getLastActiveRepo()).toBe('E:/new');
		expect(state.getCodeReviews()).toEqual({
			'E:/new': { 'abc123': expect.objectContaining({ remainingFiles: ['a.ts', 'b.ts'] }) }
		});
	});

	it('runs the code review lifecycle: start, get, update, end', async () => {
		const started = await state.startCodeReview('E:/repo', 'abc123-def456', ['a.ts', 'b.ts'], 'a.ts');
		expect(started.error).toBeNull();
		expect(started.codeReview.remainingFiles).toEqual(['a.ts', 'b.ts']);

		const resumed = state.getCodeReview('E:/repo', 'abc123-def456');
		expect(resumed !== null && resumed.lastViewedFile).toBe('a.ts');

		await state.updateCodeReview('E:/repo', 'abc123-def456', ['b.ts'], 'b.ts');
		expect(state.getCodeReviews()['E:/repo']['abc123-def456'].remainingFiles).toEqual(['b.ts']);

		// An empty remaining-files list ends the review
		await state.updateCodeReview('E:/repo', 'abc123-def456', [], null);
		expect(state.getCodeReviews()).toEqual({});

		await expect(state.updateCodeReview('E:/repo', 'missing', [], null)).resolves.toBeTypeOf('string');
	});

	it('expires code reviews that have been idle for more than 90 days', async () => {
		const ninetyOneDaysAgo = new Date().getTime() - 91 * 24 * 60 * 60 * 1000;
		workspaceState.setSilently('codeReviews', {
			'E:/repo': {
				'stale': { lastActive: ninetyOneDaysAgo, lastViewedFile: null, remainingFiles: ['x.ts'] },
				'fresh': { lastActive: new Date().getTime(), lastViewedFile: null, remainingFiles: ['y.ts'] }
			}
		});

		state.expireOldCodeReviews();

		expect(state.getCodeReviews()).toEqual({
			'E:/repo': { 'fresh': expect.objectContaining({ remainingFiles: ['y.ts'] }) }
		});
	});

	it('answers the default global view state and keeps the view snapshot', async () => {
		expect(state.getGlobalViewState()).toEqual({ alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false });
		expect(state.getViewSnapshot()).toBeNull();

		const snapshot = {} as unknown as GitGraphViewSnapshot;
		await state.setViewSnapshot(snapshot);
		expect(state.getViewSnapshot()).toBe(snapshot);
	});

	it('normalises the avatar storage path', () => {
		expect(state.getAvatarStoragePath().indexOf('\\')).toBe(-1);
		expect(state.getAvatarStoragePath().endsWith('/avatars')).toBe(true);
	});
});

describe('versioned user data', () => {
	/** One sample directory per historical version: 1.0.27 (version 0), current (v1), v2-newer-writer. */
	const USER_DATA = ['test', 'fixtures', 'user-data'];

	interface MementoSample {
		global: Record<string, unknown>;
		workspace: Record<string, unknown>;
	}

	/** Load a `globalState.json` sample: the real memento keys of both scopes. */
	function mementoSample(name: string): MementoSample {
		return JSON.parse(fs.readFileSync(path.join(process.cwd(), ...USER_DATA, name), 'utf8')) as MementoSample;
	}

	/** An ExtensionState whose mementos are seeded from a sample's key/value pairs. */
	function extensionStateOver(globalValues: Record<string, unknown>, workspaceValues: Record<string, unknown>) {
		const global = new FakeMemento(globalValues);
		const workspace = new FakeMemento(workspaceValues);
		const context = {
			globalState: global,
			workspaceState: workspace,
			globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'gg-storage-'))
		};
		const onDidChangeGitExecutable = (): { dispose(): void } => ({ dispose: () => undefined });
		return { global: global, workspace: workspace, state: new ExtensionState(context as unknown as ExtensionContext, onDidChangeGitExecutable, testConfig()) };
	}

	it('reads the 1.0.27 sample (pre-versioning data) through the current readers', () => {
		const sample = mementoSample('1.0.27/globalState.json');
		const { state } = extensionStateOver(sample.global, sample.workspace);

		const repos = state.getRepos();
		// Every stored field of the project repo survives, merged over the defaults
		expect(repos['E:\\dev\\project'].name).toBe('Project');
		expect(repos['E:\\dev\\project'].commitOrdering).toBe('date');
		expect(repos['E:\\dev\\project'].showRemoteBranchesV2).toBe(BooleanOverride.Default);
		// The archive repo predates showRemoteBranchesV2: the reader migrates it against the
		// configured default (TRUE per the vscode mock), so the explicitly-off repo is Disabled
		expect(repos['E:\\dev\\archive'].showRemoteBranches).toBe(false);
		expect(repos['E:\\dev\\archive'].showRemoteBranchesV2).toBe(BooleanOverride.Disabled);

		expect(state.getGlobalViewState()).toEqual(sample.global.globalViewState);
		expect(state.getWorkspaceViewState()).toEqual(sample.workspace.workspaceViewState);
		expect(state.getLastActiveRepo()).toBe('E:\\dev\\project');
		expect(state.getLastKnownGitPath()).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
		expect(state.getIgnoredRepos()).toEqual(['E:\\dev\\sandbox']);
		expect(state.getGlobalAuthorWritten()).toEqual({ name: 'Dev User', email: 'dev@example.com' });
		expect(Object.keys(state.getCodeReviews()['E:\\dev\\project'])).toEqual(['3f2a9c1e-4b2d-4f6a']);
		expect(state.getViewSnapshot()).toEqual(sample.workspace.viewSnapshot);
	});

	it('round-trips the 1.0.27 sample: read, write (version stamped), read again', async () => {
		const sample = mementoSample('1.0.27/globalState.json');
		const { state, workspace } = extensionStateOver(sample.global, sample.workspace);

		const repos = state.getRepos();
		await state.saveRepos(repos);

		// The strict write enveloped the raw 1.0.27 value with the current version
		expect(workspace.get('repoStates')).toEqual({ version: STORAGE_STATE_VERSION, data: repos });
		// Reading the rewritten value answers exactly what the first read answered
		expect(state.getRepos()).toEqual(repos);

		await state.saveRepos(state.getRepos());
		expect(workspace.get('repoStates')).toEqual({ version: STORAGE_STATE_VERSION, data: repos });
	});

	it('leaves current-version (v1) data unchanged across a read-write cycle', async () => {
		const sample = mementoSample('current/globalState.json');
		const { state, workspace } = extensionStateOver(sample.global, sample.workspace);

		const repos = state.getRepos();
		await state.saveRepos(repos);

		// No behavior change for current-version data: the stored envelope is what the sample held
		expect(workspace.get('repoStates')).toEqual(sample.workspace.repoStates);
		expect(state.getRepos()).toEqual(repos);
	});

	it('preserves the unknown fields of a newer writer (version+1) when reading and rewriting', async () => {
		const sample = mementoSample('v2-newer-writer/globalState.json');
		const { state, global, workspace } = extensionStateOver(sample.global, sample.workspace);

		// The lenient read of version+1 data keeps the newer writer's unknown fields
		const repos = state.getRepos();
		expect((repos['E:\\dev\\project'] as unknown as Record<string, unknown>).compactRows).toBe(true);
		const viewState = state.getGlobalViewState() as unknown as Record<string, unknown>;
		expect(viewState.commitGraphStyle).toBe('linear');
		const workspaceView = state.getWorkspaceViewState() as unknown as Record<string, unknown>;
		expect(workspaceView.findFuzzy).toBe(true);

		// Rewriting stamps the current version (strict write) while the fields survive
		await state.saveRepos(repos);
		const stored = workspace.get('repoStates') as { version: number; data: Record<string, Record<string, unknown>> };
		expect(stored.version).toBe(STORAGE_STATE_VERSION);
		expect(stored.data['E:\\dev\\project'].compactRows).toBe(true);
		expect(state.getRepos()).toEqual(repos);

		// Writing one key never disturbs a newer-writer key it did not touch
		await state.setCodeReviews({});
		expect(global.get('globalViewState')).toEqual(sample.global.globalViewState);
	});

	it('answers defaults for corrupt values instead of throwing', () => {
		const { state } = extensionStateOver(
			{ 'lastKnownGitPath': 42, 'avatarCache': 'garbage', 'globalViewState': 7, 'globalAuthorWritten': 'nope' },
			{ 'repoStates': 'garbage', 'ignoredRepos': 42, 'lastActiveRepo': 3, 'codeReviews': [], 'viewSnapshot': 9 }
		);

		expect(state.getRepos()).toEqual({});
		expect(state.getIgnoredRepos()).toEqual([]);
		expect(state.getLastActiveRepo()).toBeNull();
		expect(state.getLastKnownGitPath()).toBeNull();
		expect(state.getAvatarCache()).toEqual({});
		expect(state.getGlobalViewState()).toEqual(DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE);
		expect(state.getCodeReviews()).toEqual({});
		expect(state.getGlobalAuthorWritten()).toBeNull();
		expect(state.getViewSnapshot()).toBe(9); // an opaque snapshot is passed through, never thrown on
	});

	it('envelopes are decoded idempotently and never strip unknown fields', () => {
		const payload = { 'a': 1, 'unknownNewerField': true };
		const encoded = encodeVersionedState(payload);

		expect(encoded).toEqual({ version: STORAGE_STATE_VERSION, data: payload });
		expect(decodeVersionedState(encoded)).toEqual(encoded);
		expect(decodeVersionedState(encodeVersionedState(payload))).toEqual(encoded);

		// A newer writer's envelope passes through untouched (downgrade support)
		const newer = { version: STORAGE_STATE_VERSION + 1, data: payload };
		expect(decodeVersionedState(newer)).toEqual(newer);

		// Legacy raw values are version 0 data, migrated to the current version
		expect(decodeVersionedState('raw 1.0.27 value')).toEqual({ version: STORAGE_STATE_VERSION, data: 'raw 1.0.27 value' });
		expect(decodeVersionedState(undefined)).toBeNull();
		expect(decodeVersionedState(null)).toEqual({ version: STORAGE_STATE_VERSION, data: null });
	});
});

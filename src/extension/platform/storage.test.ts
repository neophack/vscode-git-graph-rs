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
import { DEFAULT_REPO_STATE, ExtensionState, MementoLike, Storage } from './storage';
import { BooleanOverride, GitGraphViewSnapshot } from '../../types';

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
		state = new ExtensionState(context as unknown as ExtensionContext, onDidChangeGitExecutable);
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

		expect(workspaceState.get('repoStates')).toEqual({ 'E:/repo': DEFAULT_REPO_STATE });
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
		const failingState = new ExtensionState(context as unknown as ExtensionContext, onDidChangeGitExecutable);

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

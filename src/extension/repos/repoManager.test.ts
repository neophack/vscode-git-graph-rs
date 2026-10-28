import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationChangeEvent } from 'vscode';
import type { ProductionGitRepository } from '../git/gitRepository';
import type { GitRunnerPort } from '../graphView/gitRunner';
import type { GgEvent } from '../../shared/util/event';
import type { ExtensionState } from '../platform/storage';
import type { Logger } from '../platform/logger';
import { MAX_RECENT_REPOS, RepoManager, bumpRecentRepos, recentReposList } from './repoManager';

/**
 * The recently-opened repository list: the pure ordering/merge helpers
 * are tested directly, and the RepoManager wiring around them is tested through a constructed
 * instance whose heavy collaborators (the repository facade, the raw runner, ExtensionState,
 * Logger) are structural fakes -
 * the fake 'vscode' module backs the file system watchers and the configuration lookups the
 * constructor touches. No Git backend is involved.
 */
const vscodeMock = vi.hoisted(() => {
	const noDisposable = () => ({ dispose: () => undefined });
	return {
		env: { language: 'en', uriScheme: 'vscode' },
		Uri: { file: (p: string) => ({ fsPath: p }) },
		// The live config module builds its ViewColumn table at import time, so the enum map must
		// be present even though nothing in these tests opens a view
		ViewColumn: { Active: 1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
		window: null as unknown,
		workspace: {
			getConfiguration: (_section?: string, _scope?: unknown): unknown => ({
				get: (_key: string, defaultValue?: unknown) => defaultValue
			}),
			workspaceFolders: [{ uri: { fsPath: 'E:/ws' }, name: 'ws', index: 0 }],
			createFileSystemWatcher: (_pattern: string) => ({
				onDidCreate: noDisposable,
				onDidChange: noDisposable,
				onDidDelete: noDisposable,
				dispose: () => undefined
			}),
			onDidChangeWorkspaceFolders: (_listener: unknown) => ({ dispose: () => undefined })
		}
	};
});

vi.mock('vscode', () => vscodeMock);

/** Every fake repository lives inside the fake workspace folder, or startupTasks drops it. */
const REPO_A = 'E:/ws/repo-a';
const REPO_B = 'E:/ws/repo-b';

interface HarnessOptions {
	/** The known repositories (state is irrelevant; only the key set matters). */
	readonly repos?: readonly string[];
	/** The previous session's last-active repository. */
	readonly lastActiveRepo?: string | null;
	/** The repository root the fake repository facade answers `repoRoot` with, keyed by the asked path. */
	readonly rootOf?: (repo: string) => string | null;
}

function createRepoManager(options: HarnessOptions = {}) {
	const knownRepos: Record<string, object> = {};
	for (const repo of options.repos ?? []) knownRepos[repo] = {};
	const lastActiveRepo = options.lastActiveRepo ?? null;
	const extensionState = {
		getRepos: () => knownRepos,
		getIgnoredRepos: () => [] as string[],
		getLastActiveRepo: () => lastActiveRepo,
		saveRepos: () => undefined,
		setIgnoredRepos: () => undefined,
		transferRepo: () => undefined
	};
	// The read face answers the repository itself for the known ones and NULL for everything
	// else, so the startup workspace search (maxDepth 0) finds nothing new and checkReposExist
	// keeps them. The write face records nothing (the tag-tracking startup pass finds no remotes).
	const repo = {
		read: {
			repoRoot: (asked: string) => {
				const root = options.rootOf ? options.rootOf(asked) : (knownRepos[asked] !== undefined ? asked : null);
				return root !== null ? Promise.resolve(root) : Promise.reject(new Error('not a repository'));
			},
			getRemotes: () => Promise.resolve([] as string[]),
			openRepository: () => Promise.resolve(''),
			closeRepository: () => undefined,
			getSubmodules: () => Promise.resolve([] as string[])
		},
		write: { run: () => Promise.resolve(null) }
	};
	const git = { gitOutput: () => Promise.reject(new Error('no git')) } as unknown as GitRunnerPort;
	const onDidChangeConfiguration = (() => ({ dispose: () => undefined })) as unknown as GgEvent<ConfigurationChangeEvent>;
	const manager = new RepoManager({
		repo: repo as unknown as ProductionGitRepository,
		git: git,
		state: extensionState as unknown as ExtensionState,
		onDidChangeConfiguration: onDidChangeConfiguration,
		logger: { log: () => undefined } as unknown as Logger
	});
	return { manager, knownRepos };
}

/** Let the constructor's fire-and-forget startup tasks (and any transfer they trigger) settle. */
async function settleStartupTasks() {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('bumpRecentRepos (the ordering policy)', () => {
	it('moves the opened repository to the front', () => {
		expect(bumpRecentRepos(['a', 'b', 'c'], 'b', 3)).toEqual(['b', 'a', 'c']);
	});

	it('enters a new repository at the front without disturbing the others', () => {
		expect(bumpRecentRepos(['a', 'b'], 'c', 3)).toEqual(['c', 'a', 'b']);
	});

	it('drops the duplicate instead of listing a repository twice', () => {
		expect(bumpRecentRepos(['a', 'b'], 'a', 3)).toEqual(['a', 'b']);
	});

	it('caps the list length, evicting the least recently opened', () => {
		expect(bumpRecentRepos(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
		expect(bumpRecentRepos(['a', 'b', 'c'], 'a', 2)).toEqual(['a', 'b']);
	});

	it('answers an empty list for a zero cap', () => {
		expect(bumpRecentRepos(['a'], 'b', 0)).toEqual([]);
	});

	it('exposes the D11 cap of 3', () => {
		expect(MAX_RECENT_REPOS).toBe(3);
	});
});

describe('recentReposList (the merge policy)', () => {
	const isKnown = (repo: string) => ['a', 'b', 'c'].includes(repo);

	it('filters recorded opens to repositories that are still known', () => {
		expect(recentReposList(['a', 'gone'], null, isKnown)).toEqual(['a']);
	});

	it('appends the previous session\u2019s last-active repository until an open is recorded', () => {
		expect(recentReposList([], 'b', isKnown)).toEqual(['b']);
		expect(recentReposList(['a'], 'b', isKnown)).toEqual(['a', 'b']);
	});

	it('does not duplicate the last-active repository once it is recorded', () => {
		expect(recentReposList(['b', 'a'], 'b', isKnown)).toEqual(['b', 'a']);
	});

	it('drops a last-active repository that is no longer known', () => {
		expect(recentReposList([], 'deleted', isKnown)).toEqual([]);
	});

	it('answers an empty list when nothing was recorded and nothing was persisted', () => {
		expect(recentReposList([], null, isKnown)).toEqual([]);
	});
});

describe('RepoManager recently-opened tracking', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('seeds the list from the previous session\u2019s last-active repository', () => {
		const { manager } = createRepoManager({ repos: [REPO_A, REPO_B], lastActiveRepo: REPO_B });
		expect(manager.getRecentRepos()).toEqual([REPO_B]);
	});

	it('does not seed a last-active repository that is no longer known', () => {
		const { manager } = createRepoManager({ repos: [REPO_A], lastActiveRepo: 'E:/ws/gone' });
		expect(manager.getRecentRepos()).toEqual([]);
	});

	it('records opens most recent first, dropping duplicates, capped at ' + MAX_RECENT_REPOS, () => {
		const { manager } = createRepoManager({ repos: [REPO_A, REPO_B, 'E:/ws/repo-c', 'E:/ws/repo-d'], lastActiveRepo: null });

		manager.recordRepoOpened(REPO_B);
		manager.recordRepoOpened(REPO_A);
		expect(manager.getRecentRepos()).toEqual([REPO_A, REPO_B]);

		manager.recordRepoOpened(REPO_B);
		expect(manager.getRecentRepos()).toEqual([REPO_B, REPO_A]);

		manager.recordRepoOpened('E:/ws/repo-c');
		manager.recordRepoOpened('E:/ws/repo-d');
		expect(manager.getRecentRepos()).toEqual(['E:/ws/repo-d', 'E:/ws/repo-c', REPO_B]);
	});

	it('ignores opens of unknown repositories', () => {
		const { manager } = createRepoManager({ repos: [REPO_A] });
		manager.recordRepoOpened('E:/ws/unknown');
		expect(manager.getRecentRepos()).toEqual([]);
	});

	it('records an open made through the view-load path (sendRepos with a repo to load)', async () => {
		// A repo the repository facade can root but RepoManager does not know yet: registering it loads
		// it in the view, which must head the recently-opened list
		const { manager } = createRepoManager({
			repos: [],
			lastActiveRepo: null,
			rootOf: (repo) => repo === REPO_A ? REPO_A : null
		});
		await settleStartupTasks();

		await manager.registerRepo(REPO_A, true);
		expect(manager.getRecentRepos()).toEqual([REPO_A]);
	});

	it('follows a repository that moves on disk (state transfer remaps the list)', async () => {
		const { manager } = createRepoManager({
			repos: [REPO_A],
			lastActiveRepo: REPO_A,
			rootOf: (repo) => repo === REPO_A ? 'E:/ws/repo-moved' : repo
		});

		// The transfer waits on the root lookup's file system IO, which no fixed number of ticks covers.
		await vi.waitFor(() => expect(manager.getRecentRepos()).toEqual(['E:/ws/repo-moved']));
	});

	it('drops a repository from the list when it is ignored (removed)', async () => {
		const { manager } = createRepoManager({ repos: [REPO_A, REPO_B], lastActiveRepo: REPO_A });

		await settleStartupTasks();
		expect(manager.getRecentRepos()).toEqual([REPO_A]);

		expect(manager.ignoreRepo(REPO_A)).toBe(true);
		expect(manager.getRecentRepos()).toEqual([]);
	});
});

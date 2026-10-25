import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The repository discovery seam, extracted from the former flat src/repoManager.ts: the
 * directory search recursion, the submodule scan and the workspace-folder inclusion mapping.
 * The search takes its repository lookups as dependencies, so the recursion is tested against
 * a real temporary directory tree whose "repositories" are directories containing a `.git`
 * child - the fake 'vscode' module backs the mapping query and the transitive config chain.
 */
const vscodeMock = vi.hoisted(() => ({
	env: { language: 'en', uriScheme: 'vscode' },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ViewColumn: { Active: 1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: (_section?: string, _scope?: unknown): unknown => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue
		}),
		workspaceFolders: undefined as unknown
	}
}));

vi.mock('vscode', () => vscodeMock);

import { doesPathExist, getWorkspaceFolderInfoForRepoInclusionMapping, isDirectory, searchDirectoryForRepos, searchRepoForSubmodules } from './repoDiscovery';

/** A repository root detector over a real directory tree: a "repository" owns a `.git/HEAD`. */
function fakeRepoRoot(directory: string): Promise<string | null> {
	return Promise.resolve(fs.existsSync(path.join(directory, '.git', 'HEAD')) ? directory : null);
}

function makeSearchDeps(added: string[], withinKnown: (directory: string) => boolean = () => false) {
	return {
		repoRoot: fakeRepoRoot,
		isWithinKnownRepo: withinKnown,
		addRepo: (repo: string) => {
			added.push(repo);
			return Promise.resolve(true);
		}
	};
}

/** Mark a directory as a repository of the fake tree (a `.git/HEAD` marker, like a real repo). */
function markAsRepo(directory: string): void {
	fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
	fs.writeFileSync(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main');
}

describe('searchDirectoryForRepos', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-discovery-'));
		markAsRepo(path.join(root, 'repoA'));
		markAsRepo(path.join(root, 'nested', 'repoB'));
		fs.mkdirSync(path.join(root, '.git')); // a bare .git dir: not a repository marker, and skipped as a child entry
		fs.writeFileSync(path.join(root, 'plain.txt'), 'not a directory');
		fs.writeFileSync(path.join(root, '.gitignore'), 'still not a repository marker');
	});

	it('adds the directory itself when it is a repository root', async () => {
		const added: string[] = [];
		const repoA = root + '/repoA';

		await expect(searchDirectoryForRepos(repoA, 0, makeSearchDeps(added))).resolves.toBe(true);
		expect(added).toEqual([repoA]);
	});

	it('recurses into subdirectories down to the maximum depth', async () => {
		const added: string[] = [];
		// The search joins children with '/', exactly like the production repository paths
		const repoA = root + '/repoA';
		const repoB = root + '/nested/repoB';

		// maxDepth 1 reaches repoA (depth 1) but not nested/repoB (depth 2)
		await expect(searchDirectoryForRepos(root, 1, makeSearchDeps(added))).resolves.toBe(true);
		expect(added).toEqual([repoA]);

		added.length = 0;
		await expect(searchDirectoryForRepos(root, 2, makeSearchDeps(added))).resolves.toBe(true);
		expect(added.sort()).toEqual([repoB, repoA].sort());
	});

	it('answers FALSE without searching when the directory is already within a known repository', async () => {
		const added: string[] = [];
		let repoRootCalls = 0;
		const deps = {
			repoRoot: (directory: string) => {
				repoRootCalls++;
				return fakeRepoRoot(directory);
			},
			isWithinKnownRepo: () => true,
			addRepo: (repo: string) => {
				added.push(repo);
				return Promise.resolve(true);
			}
		};

		await expect(searchDirectoryForRepos(root, 3, deps)).resolves.toBe(false);
		expect(repoRootCalls).toBe(0);
		expect(added).toEqual([]);
	});

	it('answers FALSE for a tree without repositories, and for a failing repository lookup', async () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-discovery-'));
		fs.mkdirSync(path.join(empty, 'sub'));
		await expect(searchDirectoryForRepos(empty, 3, makeSearchDeps([]))).resolves.toBe(false);

		const deps = {
			repoRoot: () => Promise.reject(new Error('git executable missing')),
			isWithinKnownRepo: () => false,
			addRepo: () => Promise.resolve(true)
		};
		await expect(searchDirectoryForRepos(root, 3, deps)).resolves.toBe(false);
	});
});

describe('searchRepoForSubmodules', () => {
	it('adds only the submodules that are not known yet', async () => {
		const added: string[] = [];
		const deps = {
			getSubmodules: () => Promise.resolve(['E:/repo/sub-a', 'E:/repo/sub-b', 'E:/repo/sub-c']),
			isKnownRepo: (repo: string) => repo === 'E:/repo/sub-b',
			addRepo: (repo: string) => {
				added.push(repo);
				return Promise.resolve(true);
			}
		};

		await expect(searchRepoForSubmodules('E:/repo', deps)).resolves.toBe(true);
		expect(added).toEqual(['E:/repo/sub-a', 'E:/repo/sub-c']);
	});

	it('answers FALSE when every submodule is already known', async () => {
		const deps = {
			getSubmodules: () => Promise.resolve(['E:/repo/sub-a']),
			isKnownRepo: () => true,
			addRepo: () => Promise.resolve(true)
		};

		await expect(searchRepoForSubmodules('E:/repo', deps)).resolves.toBe(false);
	});
});

describe('file system predicates', () => {
	it('classifies directories and existence', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-discovery-'));
		fs.writeFileSync(path.join(directory, 'file.txt'), 'x');

		await expect(isDirectory(directory)).resolves.toBe(true);
		await expect(isDirectory(path.join(directory, 'file.txt'))).resolves.toBe(false);
		await expect(isDirectory(path.join(directory, 'missing'))).resolves.toBe(false);

		await expect(doesPathExist(directory)).resolves.toBe(true);
		await expect(doesPathExist(path.join(directory, 'missing'))).resolves.toBe(false);
	});
});

describe('getWorkspaceFolderInfoForRepoInclusionMapping', () => {
	it('maps every workspace folder onto an exact root and a folder root', () => {
		vscodeMock.workspace.workspaceFolders = [
			{ uri: { fsPath: 'E:\\w\\folderA' }, index: 0, name: 'folderA' },
			{ uri: { fsPath: 'E:/w/folderB' }, index: 1, name: 'folderB' }
		];

		const info = getWorkspaceFolderInfoForRepoInclusionMapping();

		expect(info.rootsExact).toEqual(['E:/w/folderA', 'E:/w/folderB']);
		expect(info.rootsFolder).toEqual(['E:/w/folderA/', 'E:/w/folderB/']);
		expect(info.workspaceFolders).toHaveLength(2);

		vscodeMock.workspace.workspaceFolders = undefined;
		const empty = getWorkspaceFolderInfoForRepoInclusionMapping();
		expect(empty.rootsExact).toEqual([]);
		expect(empty.workspaceFolders).toEqual([]);
	});
});

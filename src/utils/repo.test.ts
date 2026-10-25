/**
 * The repository-set ordering of src/utils/repo.ts (ported from tests/utils.test.mjs): the
 * repository dropdown's three orders — full path, name, and workspace folder then path.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
	Uri: { file: (p: string) => ({ fsPath: p, path: p }) },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	env: { language: 'en' },
	workspace: { getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue }) }
}));

import { GitRepoSet, RepoDropdownOrder } from '../types';
import { getSortedRepositoryPaths } from './repo';

describe('getSortedRepositoryPaths', () => {
	/* Only the name and workspaceFolderIndex fields feed the ordering; the rest of a repository's
	 * state is irrelevant to it. */
	const repos = <GitRepoSet><unknown>{
		'/w/b-repo': { name: null, workspaceFolderIndex: 1 },
		'/w/a-repo': { name: 'zed', workspaceFolderIndex: 0 },
		'/outside/c': { name: null, workspaceFolderIndex: null },
		'/w/a-repo/inner': { name: 'zed', workspaceFolderIndex: 0 }
	};

	it('orders by the full path', () => {
		expect(getSortedRepositoryPaths(repos, RepoDropdownOrder.FullPath)).toEqual(['/outside/c', '/w/a-repo', '/w/a-repo/inner', '/w/b-repo']);
	});

	it('orders by workspace folder first, then the full path (repositories outside the workspace last)', () => {
		expect(getSortedRepositoryPaths(repos, RepoDropdownOrder.WorkspaceFullPath)).toEqual(['/w/a-repo', '/w/a-repo/inner', '/w/b-repo', '/outside/c']);
	});

	it('orders by the displayed name (a configured name wins over the path-derived one), falling back to the path', () => {
		expect(getSortedRepositoryPaths(repos, RepoDropdownOrder.Name)).toEqual(['/w/b-repo', '/outside/c', '/w/a-repo', '/w/a-repo/inner']);
	});
});

/**
 * `DataSource.getWorktrees`/`addWorktree`/`removeWorktree`/`pruneWorktrees` back the Worktree
 * Widget's list + Add/Remove/Prune actions. `getWorktrees` parses `git worktree list --porcelain`
 * by walking its lines and starting a new record on every `worktree ` line (rather than assuming
 * a fixed blank-line block layout), so these tests exercise the parser against Git's REAL
 * porcelain output for the main worktree, a branch-based linked worktree, a newly-created-branch
 * linked worktree, and a detached one.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined
	},
	workspace: {
		getConfiguration: () => ({
			get: (_section, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { DataSource } = await import('../out/dataSource.js');

function makeDataSource() {
	return new DataSource(
		{ path: 'git', version: '2.45.0' },
		() => ({ dispose() {} }),
		() => ({ dispose() {} }),
		{ log() {}, logCmd() {} }
	);
}

describe('Worktree operations', () => {
	let dataSource;
	let repoPath;
	let worktreesRoot;

	function git(args, cwd = repoPath) {
		return execFileSync('git', args, { cwd, encoding: 'utf8' });
	}

	before(() => {
		dataSource = makeDataSource();
		// realpathSync immediately after creation: on Windows, os.tmpdir() can come back in the
		// short (8.3) path form while `git worktree list`'s own output always reports the long
		// form for the same directory - comparing the two without normalizing through the same
		// resolution first would spuriously fail every path comparison below.
		repoPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-worktree-repo-')));
		worktreesRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gg-worktree-dirs-')));
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Test']);
		fs.writeFileSync(path.join(repoPath, 'file.txt'), 'first\n');
		git(['add', 'file.txt']);
		git(['commit', '-m', 'first']);
		git(['branch', 'existing-branch']);
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
		fs.rmSync(worktreesRoot, { recursive: true, force: true });
	});

	it('lists only the main worktree in a fresh repository', async () => {
		const worktrees = await dataSource.getWorktrees(repoPath);
		assert.equal(worktrees.length, 1);
		assert.equal(worktrees[0].isMain, true);
		assert.equal(worktrees[0].branch, 'main');
		assert.equal(worktrees[0].detached, false);
		assert.equal(worktrees[0].locked, false);
		assert.equal(worktrees[0].prunable, false);
		assert.equal(path.resolve(worktrees[0].path), path.resolve(repoPath));
	});

	it('adds a worktree checking out an existing branch (branch set, newBranch not needed)', async () => {
		const worktreePath = path.join(worktreesRoot, 'existing');
		const error = await dataSource.addWorktree(repoPath, worktreePath, 'existing-branch', null);
		assert.equal(error, null);

		const worktrees = await dataSource.getWorktrees(repoPath);
		const added = worktrees.find((w) => path.resolve(w.path) === path.resolve(worktreePath));
		assert.ok(added !== undefined, 'the new worktree must appear in the list');
		assert.equal(added.isMain, false);
		assert.equal(added.branch, 'existing-branch');
		assert.equal(added.detached, false);
	});

	it('adds a worktree that creates a new branch at a given start point', async () => {
		const worktreePath = path.join(worktreesRoot, 'brand-new');
		const error = await dataSource.addWorktree(repoPath, worktreePath, 'main', 'brand-new-branch');
		assert.equal(error, null);

		const worktrees = await dataSource.getWorktrees(repoPath);
		const added = worktrees.find((w) => path.resolve(w.path) === path.resolve(worktreePath));
		assert.ok(added !== undefined);
		assert.equal(added.branch, 'brand-new-branch');

		// The branch itself now exists, at "main"'s current tip.
		assert.equal(git(['rev-parse', 'brand-new-branch']).trim(), git(['rev-parse', 'main']).trim());
	});

	it('adds a detached worktree (no branch, an explicit commit hash as the start point)', async () => {
		const commitHash = git(['rev-parse', 'main']).trim();
		const worktreePath = path.join(worktreesRoot, 'detached');
		const error = await dataSource.addWorktree(repoPath, worktreePath, commitHash, null);
		assert.equal(error, null);

		const worktrees = await dataSource.getWorktrees(repoPath);
		const added = worktrees.find((w) => path.resolve(w.path) === path.resolve(worktreePath));
		assert.ok(added !== undefined);
		assert.equal(added.branch, null);
		assert.equal(added.detached, true);
		assert.equal(added.hash, commitHash);
	});

	it('removes a worktree, dropping it from the list', async () => {
		const worktreePath = path.join(worktreesRoot, 'to-remove');
		assert.equal(await dataSource.addWorktree(repoPath, worktreePath, 'main', 'to-remove-branch'), null);
		assert.ok((await dataSource.getWorktrees(repoPath)).some((w) => path.resolve(w.path) === path.resolve(worktreePath)));

		const removeError = await dataSource.removeWorktree(repoPath, worktreePath, false);
		assert.equal(removeError, null);

		const worktrees = await dataSource.getWorktrees(repoPath);
		assert.ok(!worktrees.some((w) => path.resolve(w.path) === path.resolve(worktreePath)), 'the removed worktree must be gone from the list');
	});

	it('force-removes a worktree with uncommitted changes (plain remove would be refused)', async () => {
		const worktreePath = path.join(worktreesRoot, 'dirty');
		assert.equal(await dataSource.addWorktree(repoPath, worktreePath, 'main', 'dirty-branch'), null);
		fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'modified in the worktree\n');

		const plainRemoveError = await dataSource.removeWorktree(repoPath, worktreePath, false);
		assert.notEqual(plainRemoveError, null, 'a plain remove of a dirty worktree should fail');

		const forceRemoveError = await dataSource.removeWorktree(repoPath, worktreePath, true);
		assert.equal(forceRemoveError, null);
		assert.ok(!(await dataSource.getWorktrees(repoPath)).some((w) => path.resolve(w.path) === path.resolve(worktreePath)));
	});

	it('prunes administrative files for a worktree whose directory was deleted outside Git', async () => {
		const worktreePath = path.join(worktreesRoot, 'to-be-deleted-by-hand');
		assert.equal(await dataSource.addWorktree(repoPath, worktreePath, 'main', 'deleted-by-hand-branch'), null);

		// Simulate the user (or their OS) deleting the worktree folder directly, without `git
		// worktree remove` - Git still has administrative state for it until pruned.
		fs.rmSync(worktreePath, { recursive: true, force: true });
		const beforePrune = await dataSource.getWorktrees(repoPath);
		const stale = beforePrune.find((w) => path.resolve(w.path) === path.resolve(worktreePath));
		assert.ok(stale !== undefined, 'Git still lists it until pruned');
		assert.equal(stale.prunable, true);

		const pruneError = await dataSource.pruneWorktrees(repoPath);
		assert.equal(pruneError, null);

		const afterPrune = await dataSource.getWorktrees(repoPath);
		assert.ok(!afterPrune.some((w) => path.resolve(w.path) === path.resolve(worktreePath)), 'prune must drop the stale entry entirely');
	});

	it('rejects a worktree path that looks like a command-line flag, instead of passing it to git', async () => {
		const error = await dataSource.addWorktree(repoPath, '--upload-pack=evil', 'main', null);
		assert.notEqual(error, null);
	});
});

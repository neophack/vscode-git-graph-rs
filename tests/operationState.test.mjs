/**
 * `DataSource.getOperationState` backs the Conflict Banner: it detects a merge/rebase/
 * cherry-pick/revert left in progress (most commonly because it hit a conflict) by reading the
 * repository's `.git` marker files directly (no `git status` spawn), and lists the still-
 * unresolved files. `continueOperation`/`abortOperation` are the banner's two actions. These
 * tests drive REAL conflicts in a REAL throwaway repository - there is no way to trust marker-
 * file detection against a synthetic fixture, since the whole point is matching what Git itself
 * leaves behind.
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

describe('getOperationState / continueOperation / abortOperation', () => {
	let dataSource;
	let repoPath;

	function git(args, options = {}) {
		return execFileSync('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
	}

	function writeAndCommit(content, message) {
		fs.writeFileSync(path.join(repoPath, 'file.txt'), content);
		git(['add', 'file.txt']);
		git(['commit', '-m', message]);
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-opstate-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Test']);
		writeAndCommit('line1\n', 'base');
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('reports no operation in progress in a clean repository', async () => {
		const state = await dataSource.getOperationState(repoPath);
		assert.deepStrictEqual(state, { type: null, conflictedFiles: [], progress: null });
	});

	it('detects a merge conflict and lists the conflicted file, then abortOperation clears it', async () => {
		git(['checkout', '-b', 'merge-conflict-branch']);
		writeAndCommit('line1\nbranch-change\n', 'branch change');
		git(['checkout', 'main']);
		writeAndCommit('line1\nmain-change\n', 'main change');

		try {
			git(['merge', 'merge-conflict-branch']);
			assert.fail('expected the merge to conflict');
		} catch (error) {
			// `git merge`'s "CONFLICT" report goes to stdout, not stderr.
			assert.match((error.stdout ?? '') + (error.stderr ?? ''), /conflict/i);
		}

		const duringMerge = await dataSource.getOperationState(repoPath);
		assert.equal(duringMerge.type, 'merge');
		assert.deepStrictEqual(duringMerge.conflictedFiles, ['file.txt']);
		assert.equal(duringMerge.progress, null);

		const abortError = await dataSource.abortOperation(repoPath, 'merge');
		assert.equal(abortError, null);

		const afterAbort = await dataSource.getOperationState(repoPath);
		assert.deepStrictEqual(afterAbort, { type: null, conflictedFiles: [], progress: null });

		git(['branch', '-D', 'merge-conflict-branch']);
	});

	it('detects a rebase conflict with step/total progress, and continueOperation completes it once resolved', async () => {
		git(['checkout', '-b', 'rebase-conflict-branch']);
		writeAndCommit('line1\nbranch-change\n', 'branch change for rebase');
		git(['checkout', 'main']);
		writeAndCommit('line1\nmain-change-2\n', 'main change 2');

		try {
			git(['rebase', 'main', 'rebase-conflict-branch']);
			assert.fail('expected the rebase to conflict');
		} catch (error) {
			assert.match(error.stderr ?? String(error), /conflict/i);
		}

		const duringRebase = await dataSource.getOperationState(repoPath);
		assert.equal(duringRebase.type, 'rebase');
		assert.deepStrictEqual(duringRebase.conflictedFiles, ['file.txt']);
		assert.ok(duringRebase.progress !== null, 'a rebase in progress reports step/total progress');
		assert.equal(duringRebase.progress.step, 1);
		assert.equal(duringRebase.progress.total, 1);

		// Resolve the conflict exactly as the Conflict Banner instructs: stage the resolved file, continue.
		fs.writeFileSync(path.join(repoPath, 'file.txt'), 'line1\nresolved\n');
		git(['add', 'file.txt']);

		const continueError = await dataSource.continueOperation(repoPath, 'rebase');
		assert.equal(continueError, null);

		const afterContinue = await dataSource.getOperationState(repoPath);
		assert.deepStrictEqual(afterContinue, { type: null, conflictedFiles: [], progress: null });

		git(['checkout', 'main']);
		git(['branch', '-D', 'rebase-conflict-branch']);
	});

	it('detects a cherry-pick conflict', async () => {
		git(['checkout', '-b', 'cherry-pick-source']);
		writeAndCommit('line1\ncherry-change\n', 'change to cherry-pick');
		const cherryHash = git(['rev-parse', 'HEAD']).trim();
		git(['checkout', 'main']);
		writeAndCommit('line1\nmain-change-3\n', 'main change 3');

		try {
			git(['cherry-pick', cherryHash]);
			assert.fail('expected the cherry-pick to conflict');
		} catch (error) {
			assert.match(error.stderr ?? String(error), /conflict/i);
		}

		const duringCherryPick = await dataSource.getOperationState(repoPath);
		assert.equal(duringCherryPick.type, 'cherry-pick');
		assert.deepStrictEqual(duringCherryPick.conflictedFiles, ['file.txt']);

		const abortError = await dataSource.abortOperation(repoPath, 'cherry-pick');
		assert.equal(abortError, null);
		assert.deepStrictEqual(await dataSource.getOperationState(repoPath), { type: null, conflictedFiles: [], progress: null });

		git(['branch', '-D', 'cherry-pick-source']);
	});
});

/**
 * `DataSource.predictConflicts` powers the Merge/Rebase dialogs' advisory conflict preview: a
 * single `git merge-tree --write-tree` probe (no working-tree side effects), so the dialog can
 * warn the user before they click through. These tests drive it against a REAL repository with
 * both a genuinely clean and a genuinely conflicting merge, and confirm the probe never touches
 * the working tree either way (the whole point of using `merge-tree` over a real `git merge`).
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

describe('predictConflicts', () => {
	let dataSource;
	let repoPath;

	function git(args) {
		return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
	}

	function writeAndCommit(fileName, content, message) {
		fs.writeFileSync(path.join(repoPath, fileName), content);
		git(['add', fileName]);
		git(['commit', '-m', message]);
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-predict-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Test']);
		writeAndCommit('shared.txt', 'line1\n', 'base');
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('predicts no conflict for a clean fast-forwardable merge, and touches neither the index nor the working tree', async () => {
		git(['checkout', '-b', 'clean-branch']);
		writeAndCommit('other.txt', 'new file\n', 'unrelated addition');
		git(['checkout', 'main']);

		const statusBefore = git(['status', '--porcelain']);
		const prediction = await dataSource.predictConflicts(repoPath, 'main', 'clean-branch');
		assert.deepStrictEqual(prediction, { conflicted: false, files: [] });
		assert.equal(git(['status', '--porcelain']), statusBefore, 'the probe must not touch the working tree or index');

		git(['branch', '-D', 'clean-branch']);
	});

	it('predicts a conflict on the file both branches changed, without running a real merge', async () => {
		git(['checkout', '-b', 'conflicting-branch']);
		writeAndCommit('shared.txt', 'line1\nbranch-change\n', 'branch change');
		git(['checkout', 'main']);
		writeAndCommit('shared.txt', 'line1\nmain-change\n', 'main change');

		const statusBefore = git(['status', '--porcelain']);
		const prediction = await dataSource.predictConflicts(repoPath, 'main', 'conflicting-branch');
		assert.equal(prediction.conflicted, true);
		assert.deepStrictEqual(prediction.files, ['shared.txt']);
		// A real merge never ran: no MERGE_HEAD, no modified working tree, no staged conflict markers.
		assert.equal(git(['status', '--porcelain']), statusBefore, 'the probe must not touch the working tree or index even when it finds a conflict');
		assert.equal(fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD')), false);

		git(['branch', '-D', 'conflicting-branch']);
	});

	it('predicts no conflict when the two refs are identical', async () => {
		const prediction = await dataSource.predictConflicts(repoPath, 'main', 'main');
		assert.deepStrictEqual(prediction, { conflicted: false, files: [] });
	});

	it('resolves to NULL instead of throwing for a ref that does not exist', async () => {
		const prediction = await dataSource.predictConflicts(repoPath, 'main', 'this-branch-does-not-exist');
		assert.equal(prediction, null);
	});

	it('resolves to NULL (rather than passing it to git) for a ref value that looks like a command-line flag', async () => {
		const prediction = await dataSource.predictConflicts(repoPath, 'main', '--upload-pack=evil');
		assert.equal(prediction, null);
	});
});

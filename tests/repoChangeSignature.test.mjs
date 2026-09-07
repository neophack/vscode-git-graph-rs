/**
 * `DataSource.getRepoChangeSignature` feeds the background change poll of the Git Graph View:
 * a signature change means the repository changed without the file watcher reporting it, so the
 * view must refresh. The signature has to react to a new commit landing on an EXISTING branch -
 * the case the name-only lists of `getRepoInfo` cannot express (no branch name appears or
 * disappears, and `head` there is the checked-out branch's NAME), which used to leave a commit
 * invisible to the poll until some unrelated change happened.
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

/* The stand-in for the extension host (src/dataSource.ts only transitively requires 'vscode'). */
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

describe('getRepoChangeSignature', () => {
	let dataSource;
	let repoPath;

	function git(args) {
		execFileSync('git', args, { cwd: repoPath, stdio: ['ignore', 'ignore', 'pipe'] });
	}

	function commit(message) {
		fs.writeFileSync(path.join(repoPath, 'file.txt'), message);
		execFileSync('git', ['add', 'file.txt'], { cwd: repoPath });
		execFileSync('git', ['commit', '-m', message], { cwd: repoPath });
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-signature-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Test']);
		commit('first');
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('changes when a new commit lands on the existing checked-out branch', async () => {
		const before = await dataSource.getRepoChangeSignature(repoPath);
		commit('second'); // no branch name appears or disappears
		const after = await dataSource.getRepoChangeSignature(repoPath);
		assert.notStrictEqual(after, before);
		assert.notStrictEqual(after, null);
	});

	it('does not change for a working-tree-only edit (the poll must not fire on file saves)', async () => {
		const before = await dataSource.getRepoChangeSignature(repoPath);
		fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'content');
		const after = await dataSource.getRepoChangeSignature(repoPath);
		assert.strictEqual(after, before);
	});

	it('stays stable across consecutive reads of an unchanged repository', async () => {
		assert.strictEqual(await dataSource.getRepoChangeSignature(repoPath), await dataSource.getRepoChangeSignature(repoPath));
	});

	it('resolves (never rejects, never hangs) for a path that is not a repository', async () => {
		const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-not-a-repo-'));
		try {
			const signature = await dataSource.getRepoChangeSignature(notARepo);
			// The Git CLI backend reports every read of a non-repository as empty data rather than
			// an error, so the signature is a (stable) empty snapshot here - what matters to the
			// poll is that reading never rejects or stalls
			assert.notStrictEqual(signature, undefined);
		} finally {
			fs.rmSync(notARepo, { recursive: true, force: true });
		}
	});
});

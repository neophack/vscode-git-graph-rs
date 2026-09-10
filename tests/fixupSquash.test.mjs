/**
 * `DataSource.createFixupCommit`/`createSquashCommit` back the commit context menu's "Create
 * Fixup Commit"/"Create Squash Commit" actions (`git commit --fixup`/`--squash <hash>` - Git
 * itself resolves the target's subject and prefixes it, no subject lookup is done here). Folding
 * them back in is done by the existing interactive-rebase dialog's new "Automatically Squash
 * Commits" checkbox, which appends `--autosquash` to the `git rebase -i` command launched in an
 * integrated terminal (`DataSource.rebase`) - not something a headless test can drive through a
 * real terminal, so the last describe block instead verifies the git-level mechanism the feature
 * relies on directly (`git rebase -i --autosquash` run non-interactively via GIT_SEQUENCE_EDITOR/
 * GIT_EDITOR set to no-ops), pinning that fixup!/squash! commits this DataSource method creates
 * really do get folded into their targets the way the feature promises.
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

describe('createFixupCommit / createSquashCommit', () => {
	let dataSource;
	let repoPath;
	let targetHash;

	function git(args) {
		return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' });
	}

	function stage(content) {
		fs.writeFileSync(path.join(repoPath, 'file.txt'), content);
		git(['add', 'file.txt']);
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-fixup-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Test']);
		git(['config', 'core.autocrlf', 'false']);
		stage('base\n');
		git(['commit', '-m', 'add the base feature']);
		targetHash = git(['rev-parse', 'HEAD']).trim();
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('createFixupCommit commits the staged changes with a fixup! subject Git derives itself', async () => {
		stage('base\nfixup content\n');
		const error = await dataSource.createFixupCommit(repoPath, targetHash);
		assert.equal(error, null);

		const subject = git(['log', '-1', '--format=%s']).trim();
		assert.equal(subject, 'fixup! add the base feature');
		// No staged changes are left behind.
		assert.equal(git(['status', '--porcelain']), '');
	});

	it('createSquashCommit commits the staged changes with a squash! subject Git derives itself', async () => {
		stage('base\nfixup content\nsquash content\n');
		const error = await dataSource.createSquashCommit(repoPath, targetHash);
		assert.equal(error, null);

		const subject = git(['log', '-1', '--format=%s']).trim();
		assert.equal(subject, 'squash! add the base feature');
	});

	it('rejects a target hash that looks like a command-line flag, instead of passing it to git', async () => {
		stage('irrelevant\n');
		const error = await dataSource.createFixupCommit(repoPath, '--upload-pack=evil');
		assert.notEqual(error, null);
		git(['reset', '--hard']); // undo the stage() above so it doesn't leak into later tests
	});

	it('reports an error (rather than throwing) when there is nothing staged to commit', async () => {
		assert.equal(git(['status', '--porcelain']), '', 'precondition: a clean working tree');
		const error = await dataSource.createFixupCommit(repoPath, targetHash);
		assert.notEqual(error, null);
	});
});

describe('rebase --autosquash folds fixup!/squash! commits into their targets', () => {
	let dataSource;
	let repoPath;

	function git(args, extraEnv = {}) {
		return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
	}

	before(() => {
		dataSource = makeDataSource();
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-autosquash-'));
		git(['init', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Test']);
		git(['config', 'core.autocrlf', 'false']);
		// A root commit to rebase onto: the target commit itself has no parent otherwise, and
		// `git rebase -i --autosquash <root>` needs something below the target to replay from.
		git(['commit', '--allow-empty', '-m', 'root']);
	});

	after(() => {
		dataSource?.dispose();
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('a fixup! commit created via createFixupCommit is folded into its target and disappears as its own commit', async () => {
		const root = git(['rev-parse', 'HEAD']).trim();

		fs.writeFileSync(path.join(repoPath, 'file.txt'), 'base\n');
		git(['add', 'file.txt']);
		git(['commit', '-m', 'add the base feature']);
		const target = git(['rev-parse', 'HEAD']).trim();

		fs.writeFileSync(path.join(repoPath, 'file.txt'), 'base\nfixed\n');
		git(['add', 'file.txt']);
		const fixupError = await dataSource.createFixupCommit(repoPath, target);
		assert.equal(fixupError, null);

		assert.equal(git(['rev-list', '--count', `${root}..HEAD`]).trim(), '2', 'the base commit and its separate fixup! commit');

		// Exercise the real git mechanism DataSource.rebase's interactive+autosquash path hands
		// off to an integrated terminal for: `git rebase -i --autosquash <root>`, run
		// non-interactively (GIT_SEQUENCE_EDITOR/GIT_EDITOR are no-ops, so the autosquash-reordered
		// todo list - `fixup` instead of `pick` for the fixup! commit - and the resulting commit
		// message are both accepted exactly as git itself proposes them).
		git(['rebase', '-i', '--autosquash', root], { GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' });

		assert.equal(git(['rev-list', '--count', `${root}..HEAD`]).trim(), '1', 'the fixup! commit was folded into its target, not left standing on its own');
		assert.equal(fs.readFileSync(path.join(repoPath, 'file.txt'), 'utf8'), 'base\nfixed\n', 'the fixup content is present in the merged commit');
		assert.equal(git(['log', '-1', '--format=%s']).trim(), 'add the base feature', 'the target commit\'s own subject survives, not the fixup! one');
	});
});

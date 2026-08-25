/**
 * The data-loss warnings: operations that would silently lose work return a LossWarning —
 * { message } — instead of running, and only run when called with `confirmed` (what the view's
 * standard warning dialog sets when the user presses "I understand the risk"). These tests drive
 * the real DataSource against repositories in exactly the dangerous states.
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
		showWarningMessage: async () => undefined, // the native dialog must never be used
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

/** TRUE when the value is a data-loss warning rather than an ErrorInfo. */
const isWarning = (value) => value !== null && typeof value === 'object' && typeof value.message === 'string';

function makeDataSource() {
	return new DataSource(
		{ path: 'git', version: '2.45.0' },
		() => ({ dispose() {} }),
		() => ({ dispose() {} }),
		{ log() {}, logCmd() {} }
	);
}

describe('leaving a detached HEAD with its own commits', () => {
	let dataSource;
	let repoPath;
	let mainTip;
	let otherTip;
	let detachedCommit;

	const git = (args) =>
		execFileSync('git', args, {
			cwd: repoPath,
			encoding: 'utf8',
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoPath }
		});
	const head = () => git(['rev-parse', 'HEAD']).trim();
	/** How many of the commit's ancestors+itself are reachable from no branch, tag or remote. */
	const unanchoredCount = (hash) => parseInt(git(['rev-list', hash, '--not', '--branches', '--tags', '--remotes', '--count']).trim(), 10);

	before(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-detached-'));
		// The DataSource spawns git with this process's environment: isolate it the same way the
		// fixture's own git calls are, so the user's global configuration cannot leak in.
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repoPath;

		git(['init', '--quiet', '--initial-branch=main']);
		git(['config', 'user.name', 'Test User']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'commit.gpgsign', 'false']);

		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'first']);
		mainTip = head();

		git(['checkout', '--quiet', '-b', 'other']);
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'two\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'the other branch']);
		otherTip = head();

		// The scenario: check out a commit (detached, no branch name), commit on top of it
		git(['checkout', '--quiet', '--detach', mainTip]);
		fs.writeFileSync(path.join(repoPath, 'b.txt'), 'detached work\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'work committed on the detached HEAD']);
		detachedCommit = head();

		dataSource = makeDataSource();
	});

	after(() => {
		dataSource?.dispose();
		if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('holds the scenario together: the detached commit is reachable from no ref', () => {
		assert.equal(unanchoredCount(detachedCommit), 1, 'the commit is held only by HEAD itself');
		assert.equal(head(), detachedCommit);
	});

	it('switching away unconfirmed returns the warning and keeps HEAD', async () => {
		const warning = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.ok(isWarning(warning), 'a data-loss warning is returned instead of running');
		assert.match(warning.message, /1 commit\(s\)/, 'the warning carries the reflog-accurate message');
		assert.equal(head(), detachedCommit, 'HEAD must not have moved: the commits are safe');
		assert.equal(unanchoredCount(detachedCommit), 1);
	});

	it('switching away with no detached commits runs without a warning', async () => {
		// Anchor the work: a branch at the detached commit makes the switch safe
		git(['branch', 'rescue', detachedCommit]);
		const result = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.equal(result, null);
		assert.equal(head(), otherTip);
		git(['branch', '-D', 'rescue']);
	});

	it('a confirmed switch leaves the commits reflog-only (the hazard, made explicit)', async () => {
		git(['checkout', '--quiet', '--detach', detachedCommit]);

		const error = await dataSource.checkoutBranch(repoPath, 'other', null, true);
		assert.equal(error, null);
		assert.equal(head(), otherTip, 'the switch happened');
		assert.equal(unanchoredCount(detachedCommit), 1, 'the commit is now reachable from no ref — only the reflog keeps it');
		assert.equal(git(['branch', '--contains', detachedCommit]).trim(), '', 'no branch carries the commit');
	});

	it('guards checking out a commit from a detached position the same way', async () => {
		git(['checkout', '--quiet', '--detach', detachedCommit]);
		fs.writeFileSync(path.join(repoPath, 'c.txt'), 'more detached work\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'a second detached commit']);
		const secondCommit = head();

		const warning = await dataSource.checkoutCommit(repoPath, mainTip);

		assert.ok(isWarning(warning), 'the warning is returned instead of running');
		assert.equal(head(), secondCommit, 'moving to another commit is refused too when it would strand work');
	});
});

describe('other operations that can lose work', () => {
	let dataSource;
	let repoPath;
	let remotePath;
	let firstCommit;

	const git = (args, cwd = repoPath) =>
		execFileSync('git', args, {
			cwd,
			encoding: 'utf8',
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoPath }
		});
	const head = () => git(['rev-parse', 'HEAD']).trim();
	const branches = () => git(['branch', '--format=%(refname:short)']).trim().split('\n').filter((name) => name !== '');
	const isDirty = () => git(['status', '--porcelain']).trim() !== '';

	before(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-loss-'));
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repoPath;

		git(['init', '--quiet', '--initial-branch=main']);
		git(['config', 'user.name', 'Test User']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'commit.gpgsign', 'false']);
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'first']);
		firstCommit = head();

		// A local bare repository stands in for the remote
		remotePath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-loss-remote-'));
		git(['init', '--quiet', '--bare', remotePath], remotePath);
		git(['remote', 'add', 'origin', remotePath]);

		dataSource = makeDataSource();
	});

	after(() => {
		dataSource?.dispose();
		if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
		if (remotePath) fs.rmSync(remotePath, { recursive: true, force: true });
	});

	it('creating a branch elsewhere with checkout returns the warning, unconfirmed', async () => {
		git(['checkout', '--quiet', '--detach', firstCommit]);
		fs.writeFileSync(path.join(repoPath, 'b.txt'), 'detached work\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'committed while detached']);
		const detachedWork = head();

		const statuses = await dataSource.createBranch(repoPath, 'elsewhere', firstCommit, true, false);

		assert.ok(isWarning(statuses[0]), 'the warning is returned instead of running');
		assert.equal(head(), detachedWork, 'HEAD must not have moved');
		assert.ok(!branches().includes('elsewhere'), 'the branch must not have been created');
	});

	it('creating a branch at the detached HEAD anchors the commits, so no warning', async () => {
		const statuses = await dataSource.createBranch(repoPath, 'anchor', head(), true, false);

		assert.deepEqual(statuses, [null]);
		assert.ok(branches().includes('anchor'));
	});

	it('a hard reset with a dirty working tree returns the warning; confirmed, it runs', async () => {
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'uncommitted and unrecoverable\n');
		assert.ok(isDirty());

		const warning = await dataSource.resetToCommit(repoPath, firstCommit, 'hard');
		assert.ok(isWarning(warning), 'the warning is returned instead of running');
		assert.ok(isDirty(), 'the uncommitted changes must still be there');

		// Confirmed (the dialog's continue button): the reset runs
		const error = await dataSource.resetToCommit(repoPath, firstCommit, 'hard', true);
		assert.equal(error, null);
		assert.ok(!isDirty(), 'the hard reset ran');
	});

	it('a soft reset never warns', async () => {
		fs.writeFileSync(path.join(repoPath, 'd.txt'), 'to be committed\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'a commit to reset away']);

		const error = await dataSource.resetToCommit(repoPath, firstCommit, 'soft');

		assert.equal(error, null);
		assert.equal(head(), firstCommit, 'the branch moved as asked');
	});

	it('a normal push does not warn', async () => {
		git(['checkout', '--quiet', 'anchor']);
		git(['push', '--quiet', '--set-upstream', 'origin', 'anchor']);
		const error = await dataSource.pushBranch(repoPath, 'anchor', 'origin', false, '');

		assert.equal(error, null);
	});

	it('a force push returns the warning unconfirmed; confirmed, it runs', async () => {
		const remoteBefore = git(['rev-parse', 'refs/remotes/origin/anchor']).trim();

		const warning = await dataSource.pushBranch(repoPath, 'anchor', 'origin', false, 'force');
		assert.ok(isWarning(warning), 'the warning is returned instead of running');
		assert.match(warning.message, /anchor/, 'the warning names the branch');
		assert.equal(git(['rev-parse', 'refs/remotes/origin/anchor']).trim(), remoteBefore, 'the remote must be untouched');

		const error = await dataSource.pushBranch(repoPath, 'anchor', 'origin', false, 'force', true);
		assert.equal(error, null, 'the confirmed push runs');
	});
});

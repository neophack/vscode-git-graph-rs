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

	it('creating a branch elsewhere with checkout AND force warns before anything runs (the view only forwards the first status)', async () => {
		const detachedWork = head(); // still on the unanchored detached commit

		const statuses = await dataSource.createBranch(repoPath, 'forced', firstCommit, true, true);

		assert.ok(isWarning(statuses[0]), 'the warning must be the FIRST status: with force the checkout runs as a second step, and a warning returned there is never forwarded');
		assert.equal(statuses.length, 1, 'neither the branch creation nor the checkout may run before the warning is confirmed');
		assert.equal(head(), detachedWork, 'HEAD must not have moved');
		assert.ok(!branches().includes('forced'), 'the branch must not have been created');

		// Confirmed (the dialog's continue button): both steps run
		const errors = await dataSource.createBranch(repoPath, 'forced', firstCommit, true, true, true);
		assert.deepEqual(errors, [null, null]);
		assert.ok(branches().includes('forced'), 'the branch was force-created');
		assert.equal(head(), firstCommit, 'the checkout happened');

		// Restore the detached state for the tests that follow
		git(['checkout', '--quiet', '--detach', detachedWork]);
		git(['branch', '-D', 'forced']);
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

describe('a stash keeps the detached commits: which switches lose data and which do not', () => {
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
	const stashList = () => git(['stash', 'list', '--format=%H']).trim().split('\n').filter((line) => line !== '');
	const isDirty = () => git(['status', '--porcelain']).trim() !== '';
	/** How many of the commit's ancestors+itself are reachable from no branch, tag, remote or stash entry. */
	const unanchoredCount = (hash) => parseInt(git(['rev-list', hash, '--not', '--branches', '--tags', '--remotes', ...stashList(), '--count']).trim(), 10);
	const commitExists = (hash) => {
		try {
			git(['cat-file', '-e', hash + '^{commit}']);
			return true;
		} catch {
			return false;
		}
	};
	/** The shared starting state: back on the detached commit, clean tree, no stashes. */
	const backAtDetachedCommit = () => {
		git(['reset', '--quiet', '--hard']);
		git(['clean', '--quiet', '-fd']);
		git(['stash', 'clear']);
		git(['checkout', '--quiet', '--detach', detachedCommit]);
	};

	before(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-stash-guard-'));
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

	it('holds the scenario together: only a stash based on the detached history anchors it', () => {
		backAtDetachedCommit();
		assert.equal(unanchoredCount(detachedCommit), 1, 'with no stash the commit is held only by HEAD itself');

		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		git(['stash', 'push', '--quiet', '-m', 'on the detached work']);
		assert.equal(stashList().length, 1);
		assert.equal(unanchoredCount(detachedCommit), 0, 'the stash commit descends from the detached commit: nothing would be lost');
	});

	it('a stash at the detached HEAD: the switch runs with no warning, and the stash survives it', async () => {
		backAtDetachedCommit();
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		git(['stash', 'push', '--quiet', '-m', 'on the detached work']);

		const result = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.equal(result, null, 'no data-loss warning: the stash keeps the detached commits reachable');
		assert.equal(head(), otherTip, 'the switch happened');
		assert.equal(stashList().length, 1, 'switching branches never touches the stash');
		assert.ok(commitExists(detachedCommit), 'the detached commit is still alive, held by the stash');
	});

	it('a stash with untracked files (push -u) anchors the history the same way', async () => {
		backAtDetachedCommit();
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		fs.writeFileSync(path.join(repoPath, 'untracked.txt'), 'not yet added\n');
		git(['stash', 'push', '--quiet', '-u', '-m', 'with untracked files']);

		const result = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.equal(result, null);
		assert.equal(head(), otherTip);
		assert.equal(stashList().length, 1);
	});

	it('a stash made on an unrelated branch does not silence the warning', async () => {
		backAtDetachedCommit();
		git(['checkout', '--quiet', 'other']);
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed on other\n');
		git(['stash', 'push', '--quiet', '-m', 'made on other']);
		git(['checkout', '--quiet', '--detach', detachedCommit]);
		assert.equal(stashList().length, 1, 'a stash exists, but not on this history');

		const warning = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.ok(isWarning(warning), 'the detached commits are in no stash ancestry: they would be lost');
		assert.equal(head(), detachedCommit, 'HEAD must not have moved');
	});

	it('commits made after the stash are still stranded: the warning returns counting only them', async () => {
		backAtDetachedCommit();
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		git(['stash', 'push', '--quiet', '-m', 'on the detached work']);
		fs.writeFileSync(path.join(repoPath, 'b.txt'), 'detached work\nmore work after the stash\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'committed after the stash']);
		const afterStash = head();
		assert.equal(unanchoredCount(afterStash), 1, 'only the post-stash commit is unanchored');

		const warning = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.ok(isWarning(warning));
		assert.match(warning.message, /1 commit\(s\)/, 'the count names exactly the post-stash commit');
		assert.equal(head(), afterStash);
	});

	it('a non-top stash entry anchors too (the top one is based on another branch)', async () => {
		backAtDetachedCommit();
		// stash@{1}-to-be: based on the detached history
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		git(['stash', 'push', '--quiet', '-m', 'on the detached work']);
		// stash@{0}: made later on 'other', so refs/stash's tip does not reach the detached commits
		git(['checkout', '--quiet', 'other']);
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed on other\n');
		git(['stash', 'push', '--quiet', '-m', 'made on other']);
		git(['checkout', '--quiet', '--detach', detachedCommit]);
		assert.equal(stashList().length, 2);
		assert.equal(unanchoredCount(detachedCommit), 0, 'the older entry keeps the commits reachable');

		const result = await dataSource.checkoutBranch(repoPath, 'main', null);

		assert.equal(result, null, 'no warning: every stash entry counts as an anchor, not just the tip');
		assert.equal(head(), mainTip);
		assert.ok(commitExists(detachedCommit));
	});

	it('dropping the anchoring stash brings the warning back', async () => {
		backAtDetachedCommit();
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		git(['stash', 'push', '--quiet', '-m', 'temporary anchor']);
		git(['stash', 'drop', '--quiet', 'stash@{0}']);
		assert.equal(stashList().length, 0);

		const warning = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.ok(isWarning(warning), 'without the stash the commits are reflog-only again');
		assert.equal(head(), detachedCommit);
	});

	it('popping the anchoring stash brings the warning back too', async () => {
		backAtDetachedCommit();
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		git(['stash', 'push', '--quiet', '-m', 'to be popped']);
		git(['stash', 'pop', '--quiet']);
		assert.equal(stashList().length, 0);
		assert.ok(isDirty(), 'the changes are back in the working tree');

		const warning = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.ok(isWarning(warning));
		assert.equal(head(), detachedCommit);
	});

	it('the same relaxation guards checking out a commit and creating a branch elsewhere', async () => {
		backAtDetachedCommit();
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'stashed away\n');
		git(['stash', 'push', '--quiet', '-m', 'on the detached work']);

		const checkout = await dataSource.checkoutCommit(repoPath, mainTip);
		assert.equal(checkout, null, 'checking out another commit with a stash on the detached work loses nothing');

		git(['checkout', '--quiet', '--detach', detachedCommit]);
		const created = await dataSource.createBranch(repoPath, 'elsewhere', mainTip, true, false);
		assert.deepEqual(created, [null], 'creating a branch elsewhere is not asked either when a stash anchors the work');
		assert.equal(git(['branch', '--format=%(refname:short)']).trim().split('\n').filter((name) => name === 'elsewhere').length, 1);
	});

	it('a tag anchors the detached commits as well', async () => {
		backAtDetachedCommit();
		git(['tag', 'temporary-anchor', detachedCommit]);

		const result = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.equal(result, null);
		assert.equal(head(), otherTip);
		git(['tag', '-d', 'temporary-anchor']);
	});

	it('a detached HEAD with no commits of its own never warns', async () => {
		backAtDetachedCommit();
		git(['checkout', '--quiet', '--detach', mainTip]);

		const result = await dataSource.checkoutBranch(repoPath, 'other', null);

		assert.equal(result, null, 'detaching per se is not the hazard: only unanchored commits are');
		assert.equal(head(), otherTip);
	});

	it('a hard reset with the changes safely stashed does not warn', async () => {
		backAtDetachedCommit();
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'would be lost by a hard reset\n');
		assert.ok(isDirty());
		git(['stash', 'push', '--quiet', '-m', 'before the reset']);

		const result = await dataSource.resetToCommit(repoPath, mainTip, 'hard');

		assert.equal(result, null, 'the stash holds the changes: the reset discards nothing of value');
		assert.ok(!isDirty(), 'the hard reset ran on the now-clean tree');
		assert.equal(stashList().length, 1, 'the stash survives the reset');
	});

	it('an unborn HEAD cannot have detached commits: no warning', async () => {
		const emptyRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-unborn-'));
		try {
			execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
				cwd: emptyRepoPath,
				encoding: 'utf8',
				env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoPath }
			});

			const result = await dataSource.checkoutBranch(emptyRepoPath, 'main', null);

			assert.ok(!isWarning(result), 'the guard must not fire when there is nothing to strand');
			assert.ok(result !== null, 'git itself refuses to check out a branch that does not exist yet');
		} finally {
			fs.rmSync(emptyRepoPath, { recursive: true, force: true });
		}
	});
});

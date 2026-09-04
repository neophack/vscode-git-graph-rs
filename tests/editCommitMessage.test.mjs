/**
 * Editing the commit message of any local unpushed commit: HEAD is amended directly, an earlier
 * commit is reworded through the fully automated `git rebase -i` whose editor scripts
 * dataSource.ts embeds as string literals. Those scripts run standalone under plain Node, so the
 * bundle's own requireWithFallback rewrite (scripts/package-src.js) must never reach into their
 * sources — the bundle once shipped `requireWithFallback(...)` inside them and every reword died
 * with "ReferenceError: requireWithFallback is not defined". These tests drive the real compiled
 * DataSource against real repositories, so a regressed bundle fails them exactly the way the
 * extension failed.
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

function makeDataSource() {
	return new DataSource(
		{ path: 'git', version: '2.45.0' },
		() => ({ dispose() {} }),
		() => ({ dispose() {} }),
		{ log() {}, logCmd() {} }
	);
}

/** The gg-amend-* temporary files currently present in the system temp directory. */
const amendTempFiles = () => fs.readdirSync(os.tmpdir()).filter((name) => /^gg-amend-(seq|msg|message)-/.test(name));

/** Wait until no gg-amend-* file beyond the ones in `before` is left (unlink is asynchronous). */
async function waitForTempCleanup(before) {
	for (let i = 0; i < 100; i++) {
		if (amendTempFiles().every((name) => before.includes(name))) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Initialise a repository with the given commit subjects, each commit adding its own file. */
function initRepo(directory, subjects) {
	const git = (args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
	git(['init', '--quiet', '--initial-branch=main']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'commit.gpgsign', 'false']);
	subjects.forEach((subject, i) => {
		fs.writeFileSync(path.join(directory, `file-${i}.txt`), `${subject}\n`);
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', subject]);
	});
	return git;
}

describe('editing the message of an earlier commit', () => {
	let dataSource;
	let repoPath;
	let git;

	const subject = (ref) => git(['log', '-1', '--format=%s', ref]).trim();
	const body = (ref) => git(['log', '-1', '--format=%b', ref]).trim();
	const hash = (ref) => git(['rev-parse', ref]).trim();
	const rootHash = () => git(['rev-list', '--max-parents=0', 'HEAD']).trim();
	const commitCount = () => parseInt(git(['rev-list', '--count', 'HEAD']).trim(), 10);

	before(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-edit-'));
		// The DataSource spawns git with this process's environment: isolate it the same way the
		// fixture's own git calls are, so the user's global configuration cannot leak in.
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repoPath;
		git = initRepo(repoPath, ['first', 'second', 'third']);
		dataSource = makeDataSource();
	});

	after(() => {
		dataSource?.dispose();
		if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('rewords a commit in the middle of the history, keeping everything around it', async () => {
		const tempFilesBefore = amendTempFiles();
		const target = hash('HEAD~1');

		const error = await dataSource.editCommitMessage(repoPath, target, 'second, reworded\n\na body line for the reworded commit');

		assert.equal(error, null, `the reword must succeed, got: ${error}`);
		assert.equal(subject('HEAD~1'), 'second, reworded');
		assert.equal(body('HEAD~1'), 'a body line for the reworded commit');
		assert.equal(subject('HEAD'), 'third', 'the later commits are rewritten, not re-messaged');
		assert.equal(subject(rootHash()), 'first', 'the earlier history is untouched');
		assert.equal(commitCount(), 3, 'no commit is lost or added');
		await waitForTempCleanup(tempFilesBefore);
		assert.deepEqual(amendTempFiles(), tempFilesBefore, 'the temporary editor and message files are cleaned up');
	});

	it('rewords the root commit', async () => {
		const error = await dataSource.editCommitMessage(repoPath, rootHash(), 'first, reworded at the root\n\nroot body');

		assert.equal(error, null, `the root reword must succeed, got: ${error}`);
		assert.equal(subject(rootHash()), 'first, reworded at the root');
		assert.equal(body(rootHash()), 'root body');
		assert.equal(subject('HEAD'), 'third');
		assert.equal(commitCount(), 3);
	});

	it('amends the HEAD commit directly', async () => {
		const error = await dataSource.editCommitMessage(repoPath, hash('HEAD'), 'third, amended\n\namended body');

		assert.equal(error, null, `the amend must succeed, got: ${error}`);
		assert.equal(subject('HEAD'), 'third, amended');
		assert.equal(body('HEAD'), 'amended body');
		assert.equal(commitCount(), 3);
	});

	it('keeps uncommitted changes across the reword (autostash)', async () => {
		fs.writeFileSync(path.join(repoPath, 'uncommitted.txt'), 'work in progress\n');

		const error = await dataSource.editCommitMessage(repoPath, hash('HEAD~1'), 'second, reworded around a dirty tree');

		assert.equal(error, null, `the reword must succeed, got: ${error}`);
		assert.equal(fs.readFileSync(path.join(repoPath, 'uncommitted.txt'), 'utf8'), 'work in progress\n');
		assert.equal(git(['status', '--porcelain']).trim(), '?? uncommitted.txt');
	});
});

describe('the commits whose message cannot be edited', () => {
	let dataSource;
	let repoPath;
	let gitPath;
	let originPath;
	let midCommit;
	let mergeCommit;
	let foreignCommit;

	const subject = (ref) => execFileSync('git', ['log', '-1', '--format=%s', ref], { cwd: repoPath, encoding: 'utf8' }).trim();

	before(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-editno-'));
		originPath = repoPath + '-origin.git';
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repoPath;
		gitPath = initRepo(repoPath, ['first', 'second', 'third']);
		midCommit = gitPath(['rev-parse', 'HEAD~1']).trim();

		// A merge commit on main (mb carries one commit so the merge is a real merge), with a
		// commit on top so the merge is not HEAD — HEAD would take the plain --amend path
		gitPath(['checkout', '--quiet', '-b', 'mb']);
		fs.writeFileSync(path.join(repoPath, 'mb.txt'), 'branch work\n');
		gitPath(['add', '-A']);
		gitPath(['commit', '--quiet', '-m', 'on mb']);
		gitPath(['checkout', '--quiet', 'main']);
		gitPath(['merge', '--quiet', '--no-ff', '-m', 'merge mb into main', 'mb']);
		mergeCommit = gitPath(['rev-parse', 'HEAD']).trim();
		fs.writeFileSync(path.join(repoPath, 'after-merge.txt'), 'after the merge\n');
		gitPath(['add', '-A']);
		gitPath(['commit', '--quiet', '-m', 'after the merge']);

		// A commit on a branch main never merged: outside the current branch's history
		gitPath(['checkout', '--quiet', '-b', 'side', midCommit]);
		fs.writeFileSync(path.join(repoPath, 'side.txt'), 'side work\n');
		gitPath(['add', '-A']);
		gitPath(['commit', '--quiet', '-m', 'on the side branch']);
		foreignCommit = gitPath(['rev-parse', 'HEAD']).trim();
		gitPath(['checkout', '--quiet', 'main']);

		dataSource = makeDataSource();
	});

	after(() => {
		dataSource?.dispose();
		if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
		if (originPath) fs.rmSync(originPath, { recursive: true, force: true });
	});

	it('refuses a merge commit and changes nothing', async () => {
		const error = await dataSource.editCommitMessage(repoPath, mergeCommit, 'must not happen');

		assert.match(String(error), /merge commit cannot be edited/);
		assert.equal(subject(mergeCommit), 'merge mb into main');
	});

	it('refuses a commit outside the current branch\'s history', async () => {
		const error = await dataSource.editCommitMessage(repoPath, foreignCommit, 'must not happen');

		assert.match(String(error), /current branch's history/);
		assert.equal(subject(foreignCommit), 'on the side branch');
	});

	it('refuses a commit a remote already contains, naming the remote', async () => {
		execFileSync('git', ['init', '--quiet', '--bare', originPath]);
		gitPath(['remote', 'add', 'origin', originPath]);
		gitPath(['push', '--quiet', 'origin', 'main']);

		const error = await dataSource.editCommitMessage(repoPath, midCommit, 'must not happen');

		assert.match(String(error), /already been pushed/);
		assert.match(String(error), /origin/);
		assert.equal(subject(midCommit), 'second');
		assert.equal(subject('HEAD'), 'after the merge', 'HEAD has not moved');
	});
});

import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { writeHarness } from '../../support/writeHarness';
import { editCommitMessage } from '../../../src/extension/graphView/writeFlows';

/**
 * Editing the message and author of an unpushed commit over a REAL repository (the port of
 * `tests/editCommitMessage.test.mjs` off the deleted `DataSource`): HEAD is amended directly; an
 * earlier commit is reworded through the fully automated `git rebase -i` whose editor scripts the
 * flow embeds as string literals (a message-only edit rewords the commit; an author change
 * inserts an `exec git commit --amend` line after its pick), aborted and restored when it fails.
 * The webview half of the feature (the dialog's body fetch) stays with the webview suite in
 * `tests/editMessageDialog.test.mjs`.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * The failing-write case needs the flow's OWN fs writes to fail mid-sequence. ESM namespace
 * bindings cannot be monkey-patched (unlike the legacy CJS require), so 'fs' is mocked at the
 * module boundary: the mock delegates to the real fs until the case arms it, and then fails the
 * Nth staging writeFileSync like a full disk would. Only writes inside a gg-amend-* staging
 * directory count — an unrelated write landing in the armed window must not consume the count
 * and let the rebase run to success.
 */
const writeGate = vi.hoisted(() => ({ failAt: 0, writes: 0, stagingDirs: [] as string[] }));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	// The segment checks the mock needs, as plain string ops (no path import in the hoisted factory)
	const segments = (p: string) => p.replace(/\\/g, '/').split('/');
	return {
		...actual,
		default: actual,
		// Record the staging directory each rebase of this run creates, so the cleanup assertions
		// check exactly what this run staged — the shared temp directory serves every parallel suite
		mkdtempSync: ((prefix: string) => {
			const created = actual.mkdtempSync(prefix);
			if (segments(created).pop()!.startsWith('gg-amend-')) writeGate.stagingDirs.push(created);
			return created;
		}) as typeof fs.mkdtempSync,
		writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
			const target = args[0];
			if (writeGate.failAt > 0 && typeof target === 'string' && segments(target).some((segment) => segment.startsWith('gg-amend-'))) {
				writeGate.writes++;
				if (writeGate.writes === writeGate.failAt) {
					const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
					error.code = 'ENOSPC';
					throw error;
				}
			}
			return actual.writeFileSync(...args);
		}) as typeof fs.writeFileSync
	};
});

/** The number of gg-amend-* staging directories this run has created so far (the snapshot cursor). */
const stagedDirCount = (): number => writeGate.stagingDirs.length;

/** TRUE once every staging directory created since the `before` snapshot is gone from disk. */
const stagingDirsCleaned = (before: number): boolean =>
	writeGate.stagingDirs.slice(before).every((dir) => !fs.existsSync(dir));

/** Wait until no staging directory created since the snapshot is left (unlink is asynchronous). */
async function waitForTempCleanup(before: number): Promise<void> {
	for (let i = 0; i < 100 && !stagingDirsCleaned(before); i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Initialise a repository with the given commit subjects, each commit adding its own file. */
function initRepo(directory: string, subjects: ReadonlyArray<string>) {
	const git = (args: ReadonlyArray<string>) => execFileSync('git', [...args], { cwd: directory, encoding: 'utf8' });
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
	const { ctx } = writeHarness();
	let repoPath: string;

	const subject = (ref: string) => execFileSync('git', ['log', '-1', '--format=%s', ref], { cwd: repoPath, encoding: 'utf8' }).trim();
	const body = (ref: string) => execFileSync('git', ['log', '-1', '--format=%b', ref], { cwd: repoPath, encoding: 'utf8' }).trim();
	const author = (ref: string) => execFileSync('git', ['log', '-1', '--format=%an <%ae>', ref], { cwd: repoPath, encoding: 'utf8' }).trim();
	const hash = (ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: repoPath, encoding: 'utf8' }).trim();
	const rootHash = () => execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
	const commitCount = () => parseInt(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim(), 10);

	beforeAll(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-edit-'));
		// The flow spawns git with this process's environment: isolate it the same way the
		// fixture's own git calls are, so the user's global configuration cannot leak in.
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repoPath;
		initRepo(repoPath, ['first', 'second', 'third']);
	});

	afterAll(() => {
		if (repoPath !== undefined) fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('rewords a commit in the middle of the history, keeping everything around it', async () => {
		const stagedBefore = stagedDirCount();
		const target = hash('HEAD~1');

		const error = await editCommitMessage(ctx, repoPath, target, 'second, reworded\n\na body line for the reworded commit');

		expect(error).toBeNull();
		expect(subject('HEAD~1')).toBe('second, reworded');
		expect(body('HEAD~1')).toBe('a body line for the reworded commit');
		expect(subject('HEAD')).toBe('third');
		expect(subject(rootHash())).toBe('first');
		expect(commitCount()).toBe(3);
		await waitForTempCleanup(stagedBefore);
		expect(stagingDirsCleaned(stagedBefore)).toBe(true);
	});

	it('rewords the root commit', async () => {
		const error = await editCommitMessage(ctx, repoPath, rootHash(), 'first, reworded at the root\n\nroot body');

		expect(error).toBeNull();
		expect(subject(rootHash())).toBe('first, reworded at the root');
		expect(body(rootHash())).toBe('root body');
		expect(subject('HEAD')).toBe('third');
		expect(commitCount()).toBe(3);
	});

	it('amends the HEAD commit directly', async () => {
		const error = await editCommitMessage(ctx, repoPath, hash('HEAD'), 'third, amended\n\namended body');

		expect(error).toBeNull();
		expect(subject('HEAD')).toBe('third, amended');
		expect(body('HEAD')).toBe('amended body');
		expect(commitCount()).toBe(3);
	});

	it('keeps uncommitted changes across the reword (autostash)', async () => {
		fs.writeFileSync(path.join(repoPath, 'uncommitted.txt'), 'work in progress\n');

		const error = await editCommitMessage(ctx, repoPath, hash('HEAD~1'), 'second, reworded around a dirty tree');

		expect(error).toBeNull();
		expect(fs.readFileSync(path.join(repoPath, 'uncommitted.txt'), 'utf8')).toBe('work in progress\n');
		expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe('?? uncommitted.txt');
	});

	it('changes the author of the HEAD commit, keeping its message and author date', async () => {
		const target = hash('HEAD');
		const subjectBefore = subject('HEAD');
		const authorDateBefore = execFileSync('git', ['log', '-1', '--format=%at', target], { cwd: repoPath, encoding: 'utf8' }).trim();

		const error = await editCommitMessage(ctx, repoPath, target, subjectBefore, 'Head Author', 'head@example.com');

		expect(error).toBeNull();
		expect(subject('HEAD')).toBe(subjectBefore);
		expect(author('HEAD')).toBe('Head Author <head@example.com>');
		expect(execFileSync('git', ['log', '-1', '--format=%at', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe(authorDateBefore);
		expect(author('HEAD~1')).toBe('Test User <test@example.com>');
	});

	it('changes the author of a commit in the middle of the history', async () => {
		const stagedBefore = stagedDirCount();
		const target = hash('HEAD~1');
		const subjectBefore = subject('HEAD~1');

		const error = await editCommitMessage(ctx, repoPath, target, subjectBefore, 'Mid Author', 'mid@example.com');

		expect(error).toBeNull();
		expect(author('HEAD~1')).toBe('Mid Author <mid@example.com>');
		expect(subject('HEAD~1')).toBe(subjectBefore);
		expect(author(rootHash())).toBe('Test User <test@example.com>');
		expect(author('HEAD')).toBe('Head Author <head@example.com>');
		expect(commitCount()).toBe(3);
		await waitForTempCleanup(stagedBefore);
		expect(stagingDirsCleaned(stagedBefore)).toBe(true);
	});

	it('changes the author of the root commit', async () => {
		const error = await editCommitMessage(ctx, repoPath, rootHash(), subject(rootHash()), 'Root Author', 'root@example.com');

		expect(error).toBeNull();
		expect(author(rootHash())).toBe('Root Author <root@example.com>');
		expect(author('HEAD~1')).toBe('Mid Author <mid@example.com>');
	});

	it('records a name-only author when no email is given', async () => {
		const error = await editCommitMessage(ctx, repoPath, hash('HEAD'), subject('HEAD'), 'No Email');

		expect(error).toBeNull();
		expect(execFileSync('git', ['log', '-1', '--format=%an', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe('No Email');
		expect(execFileSync('git', ['log', '-1', '--format=%ae', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()).toBe('');
	});

	it('still cleans up the temp files when writing one of them fails', async () => {
		const stagedBefore = stagedDirCount();
		const target = hash('HEAD~1'); // the rebase path is the one that writes the temp files
		const subjectBefore = subject('HEAD~1');

		// Make the second staging write (the author file) fail like a full disk: the message
		// file written just before it must not leave the gg-amend-* staging directory behind.
		writeGate.failAt = 2;
		writeGate.writes = 0;
		let error: unknown;
		try {
			error = await editCommitMessage(ctx, repoPath, target, 'must not happen', 'Staged Author <staged@author>');
		} finally {
			writeGate.failAt = 0;
		}

		expect(String(error)).toMatch(/ENOSPC/);
		expect(subject('HEAD~1')).toBe(subjectBefore);
		await waitForTempCleanup(stagedBefore);
		expect(stagingDirsCleaned(stagedBefore)).toBe(true);
	});
});

describe('the commits whose message cannot be edited', () => {
	const { ctx } = writeHarness();
	let repoPath: string;
	let originPath: string;
	let midCommit: string;
	let mergeCommit: string;
	let foreignCommit: string;

	const subject = (ref: string) => execFileSync('git', ['log', '-1', '--format=%s', ref], { cwd: repoPath, encoding: 'utf8' }).trim();

	beforeAll(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-editno-'));
		originPath = repoPath + '-origin.git';
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repoPath;
		const git = initRepo(repoPath, ['first', 'second', 'third']);
		midCommit = git(['rev-parse', 'HEAD~1']).trim();

		// A merge commit on main (mb carries one commit so the merge is a real merge), with a
		// commit on top so the merge is not HEAD — HEAD would take the plain --amend path
		git(['checkout', '--quiet', '-b', 'mb']);
		fs.writeFileSync(path.join(repoPath, 'mb.txt'), 'branch work\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'on mb']);
		git(['checkout', '--quiet', 'main']);
		git(['merge', '--quiet', '--no-ff', '-m', 'merge mb into main', 'mb']);
		mergeCommit = git(['rev-parse', 'HEAD']).trim();
		fs.writeFileSync(path.join(repoPath, 'after-merge.txt'), 'after the merge\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'after the merge']);

		// A commit on a branch main never merged: outside the current branch's history
		git(['checkout', '--quiet', '-b', 'side', midCommit]);
		fs.writeFileSync(path.join(repoPath, 'side.txt'), 'side work\n');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'on the side branch']);
		foreignCommit = git(['rev-parse', 'HEAD']).trim();
		git(['checkout', '--quiet', 'main']);
	});

	afterAll(() => {
		if (repoPath !== undefined) fs.rmSync(repoPath, { recursive: true, force: true });
		if (originPath !== undefined) fs.rmSync(originPath, { recursive: true, force: true });
	});

	it('refuses a merge commit and changes nothing', async () => {
		const error = await editCommitMessage(ctx, repoPath, mergeCommit, 'must not happen');

		expect(String(error)).toMatch(/amendMergeCommit/);
		expect(subject(mergeCommit)).toBe('merge mb into main');
	});

	it('refuses a commit outside the current branch\'s history', async () => {
		const error = await editCommitMessage(ctx, repoPath, foreignCommit, 'must not happen');

		expect(String(error)).toMatch(/amendNotAncestor/);
		expect(subject(foreignCommit)).toBe('on the side branch');
	});

	it('refuses a commit a remote already contains, naming the remote', async () => {
		execFileSync('git', ['init', '--quiet', '--bare', originPath]);
		execFileSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath });
		execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: repoPath });

		const error = await editCommitMessage(ctx, repoPath, midCommit, 'must not happen');

		expect(String(error)).toMatch(/amendPushedCommit:origin/);
		expect(subject(midCommit)).toBe('second');
		expect(subject('HEAD')).toBe('after the merge');
	});
});

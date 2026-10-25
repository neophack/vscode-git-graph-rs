import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RepoBuilder } from '../../support/repoBuilder';
import { isWarning, writeHarness } from '../../support/writeHarness';
import {
	checkoutBranch, checkoutCommit, createBranch, pushBranch, resetToCommit
} from '../../../src/extension/graphView/writeFlows';
import { GitPushBranchMode } from '../../../src/types/git';

/**
 * The data-loss guards over REAL repositories (the port of `tests/checkoutProtection.test.mjs`
 * off the deleted `DataSource`): operations that would silently lose work return a LossWarning
 * instead of running, and only run when called with `confirmed`. The guards themselves
 * (`countDetachedOnlyCommits` / `detachedCommitsLossWarning` / `hardResetLossWarning`) are unit
 * tested in `src/extension/git/write/lossGuard.test.ts`; these cases pin them — and the flows
 * that consult them — against the dangerous states Git itself produces.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

describe('leaving a detached HEAD with its own commits', () => {
	const { ctx } = writeHarness();
	const repo = RepoBuilder.create('gg-loss-detached');
	let mainTip: string;
	let otherTip: string;
	let detachedCommit: string;

	/** How many of the commit's ancestors+itself are reachable from no branch, tag or remote. */
	const unanchoredCount = (hash: string) =>
		parseInt(repo.git(['rev-list', hash, '--not', '--branches', '--tags', '--remotes', '--count']).trim(), 10);

	beforeAll(() => {
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repo.path;

		repo.write('a.txt', 'one\n');
		mainTip = repo.commit('first');

		repo.git(['checkout', '--quiet', '-b', 'other']);
		repo.write('a.txt', 'two\n');
		otherTip = repo.commit('the other branch');

		// The scenario: check out a commit (detached, no branch name), commit on top of it
		repo.detach(mainTip);
		repo.write('b.txt', 'detached work\n');
		detachedCommit = repo.commit('work committed on the detached HEAD');
	});

	afterAll(() => {
		repo.dispose();
	});

	it('holds the scenario together: the detached commit is reachable from no ref', () => {
		expect(unanchoredCount(detachedCommit)).toBe(1);
		expect(repo.revParse('HEAD')).toBe(detachedCommit);
	});

	it('switching away unconfirmed returns the warning and keeps HEAD', async () => {
		const warning = await checkoutBranch(ctx, repo.path, 'other', null, false);

		expect(isWarning(warning)).toBe(true);
		expect(warning.message).toMatch(/leavingCommitsBehind:1\b/);
		expect(repo.revParse('HEAD')).toBe(detachedCommit);
		expect(unanchoredCount(detachedCommit)).toBe(1);
	});

	it('switching away with no detached commits runs without a warning', async () => {
		// Anchor the work: a branch at the detached commit makes the switch safe
		repo.branch('rescue', detachedCommit);
		expect(await checkoutBranch(ctx, repo.path, 'other', null, false)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(otherTip);
		repo.git(['branch', '-D', 'rescue']);
	});

	it('a confirmed switch leaves the commits reflog-only (the hazard, made explicit)', async () => {
		repo.detach(detachedCommit);

		expect(await checkoutBranch(ctx, repo.path, 'other', null, true)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(otherTip);
		expect(unanchoredCount(detachedCommit)).toBe(1);
		expect(repo.git(['branch', '--contains', detachedCommit]).trim()).toBe('');
	});

	it('guards checking out a commit from a detached position the same way', async () => {
		repo.detach(detachedCommit);
		repo.write('c.txt', 'more detached work\n');
		const secondCommit = repo.commit('a second detached commit');

		const warning = await checkoutCommit(ctx, repo.path, mainTip, false);

		expect(isWarning(warning)).toBe(true);
		expect(repo.revParse('HEAD')).toBe(secondCommit);
	});
});

describe('other operations that can lose work', () => {
	const { ctx } = writeHarness();
	const repo = RepoBuilder.create('gg-loss-mixed');
	let remotePath: string;
	let firstCommit: string;

	const branches = () => repo.git(['branch', '--format=%(refname:short)']).trim().split('\n').filter((name) => name !== '');
	const isDirty = () => repo.git(['status', '--porcelain']).trim() !== '';

	beforeAll(() => {
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repo.path;

		repo.write('a.txt', 'one\n');
		firstCommit = repo.commit('first');

		// A local bare repository stands in for the remote
		remotePath = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gg-loss-remote-'));
		repo.git(['init', '--quiet', '--bare', remotePath]);
		repo.git(['remote', 'add', 'origin', remotePath]);
	});

	afterAll(() => {
		repo.dispose();
		fs.rmSync(remotePath, { recursive: true, force: true });
	});

	it('creating a branch elsewhere with checkout returns the warning, unconfirmed', async () => {
		repo.detach(firstCommit);
		repo.write('b.txt', 'detached work\n');
		const detachedWork = repo.commit('committed while detached');

		const statuses = await createBranch(ctx, repo.path, 'elsewhere', firstCommit, true, false, false);

		expect(isWarning(statuses[0])).toBe(true);
		expect(repo.revParse('HEAD')).toBe(detachedWork);
		expect(branches()).not.toContain('elsewhere');
	});

	it('creating a branch elsewhere with checkout AND force warns before anything runs', async () => {
		const detachedWork = repo.revParse('HEAD'); // still on the unanchored detached commit

		const statuses = await createBranch(ctx, repo.path, 'forced', firstCommit, true, true, false);

		// The warning must be the FIRST status: with force the checkout runs as a second step, and
		// a warning returned there would sit behind the successful branch creation.
		expect(isWarning(statuses[0])).toBe(true);
		expect(statuses.length).toBe(1);
		expect(repo.revParse('HEAD')).toBe(detachedWork);
		expect(branches()).not.toContain('forced');

		// Confirmed (the dialog's continue button): both steps run
		expect(await createBranch(ctx, repo.path, 'forced', firstCommit, true, true, true)).toEqual([null, null]);
		expect(branches()).toContain('forced');
		expect(repo.revParse('HEAD')).toBe(firstCommit);

		// Restore the detached state for the tests that follow
		repo.detach(detachedWork);
		repo.git(['branch', '-D', 'forced']);
	});

	it('creating a branch at the detached HEAD anchors the commits, so no warning', async () => {
		const statuses = await createBranch(ctx, repo.path, 'anchor', repo.revParse('HEAD'), true, false, false);

		expect(statuses).toEqual([null]);
		expect(branches()).toContain('anchor');
	});

	it('a hard reset with a dirty working tree returns the warning; confirmed, it runs', async () => {
		repo.write('a.txt', 'uncommitted and unrecoverable\n');
		expect(isDirty()).toBe(true);

		const warning = await resetToCommit(ctx, repo.path, firstCommit, 'hard', false);
		expect(isWarning(warning)).toBe(true);
		expect(warning.message).toMatch(/hardResetLosesChanges/);
		expect(isDirty()).toBe(true);

		// Confirmed (the dialog's continue button): the reset runs
		expect(await resetToCommit(ctx, repo.path, firstCommit, 'hard', true)).toBeNull();
		expect(isDirty()).toBe(false);
	});

	it('a soft reset never warns', async () => {
		repo.write('d.txt', 'to be committed\n');
		repo.commit('a commit to reset away');

		expect(await resetToCommit(ctx, repo.path, firstCommit, 'soft', false)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(firstCommit);
	});

	it('a normal push does not warn', async () => {
		repo.checkout('anchor');
		repo.git(['push', '--quiet', '--set-upstream', 'origin', 'anchor']);
		expect(await pushBranch(ctx, repo.path, 'anchor', 'origin', false, GitPushBranchMode.Normal, false)).toBeNull();
	});

	it('a force push returns the warning unconfirmed; confirmed, it runs', async () => {
		const remoteBefore = repo.git(['rev-parse', 'refs/remotes/origin/anchor']).trim();

		const warning = await pushBranch(ctx, repo.path, 'anchor', 'origin', false, GitPushBranchMode.Force, false);
		expect(isWarning(warning)).toBe(true);
		expect(warning.message).toMatch(/anchor/);
		expect(repo.git(['rev-parse', 'refs/remotes/origin/anchor']).trim()).toBe(remoteBefore);

		expect(await pushBranch(ctx, repo.path, 'anchor', 'origin', false, GitPushBranchMode.Force, true)).toBeNull();
	});
});

describe('a stash keeps the detached commits: which switches lose data and which do not', () => {
	const { ctx } = writeHarness();
	const repo = RepoBuilder.create('gg-loss-stash');
	let mainTip: string;
	let otherTip: string;
	let detachedCommit: string;

	const stashList = () => repo.git(['stash', 'list', '--format=%H']).trim().split('\n').filter((line) => line !== '');
	const isDirty = () => repo.git(['status', '--porcelain']).trim() !== '';
	/** How many of the commit's ancestors+itself are reachable from no branch, tag, remote or stash entry. */
	const unanchoredCount = (hash: string) =>
		parseInt(repo.git(['rev-list', hash, '--not', '--branches', '--tags', '--remotes', ...stashList(), '--count']).trim(), 10);
	const commitExists = (hash: string) => {
		try {
			repo.git(['cat-file', '-e', hash + '^{commit}']);
			return true;
		} catch {
			return false;
		}
	};
	/** The shared starting state: back on the detached commit, clean tree, no stashes. */
	const backAtDetachedCommit = () => {
		repo.git(['reset', '--quiet', '--hard']);
		repo.git(['clean', '--quiet', '-fd']);
		repo.git(['stash', 'clear']);
		repo.detach(detachedCommit);
	};

	beforeAll(() => {
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repo.path;

		repo.write('a.txt', 'one\n');
		mainTip = repo.commit('first');

		repo.git(['checkout', '--quiet', '-b', 'other']);
		repo.write('a.txt', 'two\n');
		otherTip = repo.commit('the other branch');

		repo.detach(mainTip);
		repo.write('b.txt', 'detached work\n');
		detachedCommit = repo.commit('work committed on the detached HEAD');
	});

	afterAll(() => {
		repo.dispose();
	});

	it('holds the scenario together: only a stash based on the detached history anchors it', () => {
		backAtDetachedCommit();
		expect(unanchoredCount(detachedCommit)).toBe(1);

		repo.write('a.txt', 'stashed away\n');
		repo.stashPush('on the detached work');
		expect(stashList().length).toBe(1);
		expect(unanchoredCount(detachedCommit)).toBe(0);
	});

	it('a stash at the detached HEAD: the switch runs with no warning, and the stash survives it', async () => {
		backAtDetachedCommit();
		repo.write('a.txt', 'stashed away\n');
		repo.stashPush('on the detached work');

		expect(await checkoutBranch(ctx, repo.path, 'other', null, false)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(otherTip);
		expect(stashList().length).toBe(1);
		expect(commitExists(detachedCommit)).toBe(true);
	});

	it('a stash with untracked files (push -u) anchors the history the same way', async () => {
		backAtDetachedCommit();
		repo.write('a.txt', 'stashed away\n');
		repo.write('untracked.txt', 'not yet added\n');
		repo.git(['stash', 'push', '--quiet', '-u', '-m', 'with untracked files']);

		expect(await checkoutBranch(ctx, repo.path, 'other', null, false)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(otherTip);
		expect(stashList().length).toBe(1);
	});

	it('a stash made on an unrelated branch does not silence the warning', async () => {
		backAtDetachedCommit();
		repo.checkout('other');
		repo.write('a.txt', 'stashed on other\n');
		repo.stashPush('made on other');
		repo.detach(detachedCommit);
		expect(stashList().length).toBe(1);

		const warning = await checkoutBranch(ctx, repo.path, 'other', null, false);

		expect(isWarning(warning)).toBe(true);
		expect(repo.revParse('HEAD')).toBe(detachedCommit);
	});

	it('commits made after the stash are still stranded: the warning counts only them', async () => {
		backAtDetachedCommit();
		repo.write('a.txt', 'stashed away\n');
		repo.stashPush('on the detached work');
		repo.write('b.txt', 'detached work\nmore work after the stash\n');
		const afterStash = repo.commit('committed after the stash');
		expect(unanchoredCount(afterStash)).toBe(1);

		const warning = await checkoutBranch(ctx, repo.path, 'other', null, false);

		expect(isWarning(warning)).toBe(true);
		expect(warning.message).toMatch(/leavingCommitsBehind:1\b/);
		expect(repo.revParse('HEAD')).toBe(afterStash);
	});

	it('a non-top stash entry anchors too (the top one is based on another branch)', async () => {
		backAtDetachedCommit();
		// stash@{1}-to-be: based on the detached history
		repo.write('a.txt', 'stashed away\n');
		repo.stashPush('on the detached work');
		// stash@{0}: made later on 'other', so refs/stash's tip does not reach the detached commits
		repo.checkout('other');
		repo.write('a.txt', 'stashed on other\n');
		repo.stashPush('made on other');
		repo.detach(detachedCommit);
		expect(stashList().length).toBe(2);
		expect(unanchoredCount(detachedCommit)).toBe(0);

		expect(await checkoutBranch(ctx, repo.path, 'main', null, false)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(mainTip);
		expect(commitExists(detachedCommit)).toBe(true);
	});

	it('dropping the anchoring stash brings the warning back', async () => {
		backAtDetachedCommit();
		repo.write('a.txt', 'stashed away\n');
		repo.stashPush('temporary anchor');
		repo.git(['stash', 'drop', '--quiet', 'stash@{0}']);
		expect(stashList().length).toBe(0);

		const warning = await checkoutBranch(ctx, repo.path, 'other', null, false);

		expect(isWarning(warning)).toBe(true);
		expect(repo.revParse('HEAD')).toBe(detachedCommit);
	});

	it('popping the anchoring stash brings the warning back too', async () => {
		backAtDetachedCommit();
		repo.write('a.txt', 'stashed away\n');
		repo.stashPush('to be popped');
		repo.git(['stash', 'pop', '--quiet']);
		expect(stashList().length).toBe(0);
		expect(isDirty()).toBe(true);

		const warning = await checkoutBranch(ctx, repo.path, 'other', null, false);

		expect(isWarning(warning)).toBe(true);
		expect(repo.revParse('HEAD')).toBe(detachedCommit);
	});

	it('the same relaxation guards checking out a commit and creating a branch elsewhere', async () => {
		backAtDetachedCommit();
		repo.write('a.txt', 'stashed away\n');
		repo.stashPush('on the detached work');

		expect(await checkoutCommit(ctx, repo.path, mainTip, false)).toBeNull();

		repo.detach(detachedCommit);
		const created = await createBranch(ctx, repo.path, 'elsewhere', mainTip, true, false, false);
		expect(created).toEqual([null]);
		expect(repo.git(['branch', '--format=%(refname:short)']).trim().split('\n').filter((name) => name === 'elsewhere').length).toBe(1);
	});

	it('a tag anchors the detached commits as well', async () => {
		backAtDetachedCommit();
		repo.tag('temporary-anchor', detachedCommit);

		expect(await checkoutBranch(ctx, repo.path, 'other', null, false)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(otherTip);
		repo.git(['tag', '-d', 'temporary-anchor']);
	});

	it('a detached HEAD with no commits of its own never warns', async () => {
		backAtDetachedCommit();
		repo.detach(mainTip);

		expect(await checkoutBranch(ctx, repo.path, 'other', null, false)).toBeNull();
		expect(repo.revParse('HEAD')).toBe(otherTip);
	});

	it('a hard reset with the changes safely stashed does not warn', async () => {
		backAtDetachedCommit();
		repo.write('a.txt', 'would be lost by a hard reset\n');
		expect(isDirty()).toBe(true);
		repo.stashPush('before the reset');

		expect(await resetToCommit(ctx, repo.path, mainTip, 'hard', false)).toBeNull();
		expect(isDirty()).toBe(false);
		expect(stashList().length).toBe(1);
	});

	it('an unborn HEAD cannot have detached commits: no warning', async () => {
		const emptyRepoPath = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'gg-loss-unborn-'));
		try {
			execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
				cwd: emptyRepoPath,
				encoding: 'utf8',
				env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repo.path }
			});

			const result = await checkoutBranch(ctx, emptyRepoPath, 'main', null, false);

			expect(isWarning(result)).toBe(false);
			expect(result).not.toBeNull();
		} finally {
			fs.rmSync(emptyRepoPath, { recursive: true, force: true });
		}
	});
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RepoBuilder } from '../../support/repoBuilder';
import { adapterLegs, addonAvailable } from '../../support/adapters';
import { writeHarness } from '../../support/writeHarness';
import { addWorktree, pruneWorktrees, removeWorktree } from '../../../src/extension/graphView/writeFlows';

/**
 * The Worktree Widget over REAL repositories (the port of `tests/worktree.test.mjs` off the
 * deleted `DataSource`): `getWorktrees` parses `git worktree list --porcelain` by walking its
 * lines and starting a new record on every `worktree ` line (not assuming a fixed blank-line
 * block layout), so the read cases exercise the parser against Git's REAL porcelain output —
 * the main worktree, a branch-based linked worktree, a newly-created-branch linked worktree and
 * a detached one — once per backend leg, on the leg's own fixture; the Add/Remove/Prune actions
 * run once, through the write flows.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const legs = adapterLegs();
const { ctx } = writeHarness();

interface WorktreeLike {
	readonly path: string;
	readonly hash: string;
	readonly branch: string | null;
	readonly detached: boolean;
	readonly prunable: boolean;
	readonly isMain: boolean;
}

/**
 * The comparison key of a worktree path. Git prints the long user name where the temp directory
 * may spell the 8.3 short form (and native separators), so both sides go through realpath — of
 * the path itself when it exists, else of its deepest existing ancestor plus the missing tail
 * (a worktree whose directory was deleted outside Git).
 */
function worktreeKey(value: string): string {
	let prefix = value;
	const tail: string[] = [];
	for (;;) {
		try {
			const resolved = fs.realpathSync.native(prefix).replace(/\\/g, '/');
			return (tail.length > 0 ? resolved + '/' + tail.reverse().join('/') : resolved).toLowerCase();
		} catch {
			const parent = path.dirname(prefix);
			if (parent === prefix) return value.replace(/\\/g, '/').toLowerCase();
			tail.push(path.basename(prefix));
			prefix = parent;
		}
	}
}

const findWorktree = async (backend: { getWorktrees(repo: string): Promise<ReadonlyArray<WorktreeLike>> }, repoPath: string, worktreePath: string): Promise<WorktreeLike | undefined> => {
	const worktrees = await backend.getWorktrees(repoPath);
	return worktrees.find((worktree) => worktreeKey(worktree.path) === worktreeKey(worktreePath));
};

/** One leg's fixture: a repository carrying the four worktree shapes the parser must survive. */
function porcelainFixture(legName: string) {
	const repo = RepoBuilder.create('gg-worktrees-' + legName);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-worktrees-root-'));
	repo.write('file.txt', 'content\n');
	repo.commit('first');
	repo.branch('existing-branch');
	repo.git(['worktree', 'add', '--quiet', path.join(root, 'existing'), 'existing-branch']);
	repo.git(['worktree', 'add', '--quiet', '-b', 'created-branch', path.join(root, 'brand-new'), 'main']);
	repo.git(['worktree', 'add', '--quiet', '--detach', path.join(root, 'detached'), 'HEAD']);
	return { repo: repo, root: root, detachedHash: repo.revParse('HEAD') };
}

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`getWorktrees parses the real porcelain output (${leg.name})`, () => {
		const fixture = porcelainFixture(leg.name);

		afterAll(() => {
			leg.backend.closeAllRepositories();
			fixture.repo.dispose();
			fs.rmSync(fixture.root, { recursive: true, force: true });
		});

		it('lists the main worktree first, then the linked ones, with branch/detached/isMain resolved', async () => {
			const worktrees = await leg.backend.getWorktrees(fixture.repo.path);

			expect(worktrees.length).toBe(4);
			expect(worktreeKey(worktrees[0].path)).toBe(worktreeKey(fixture.repo.path));
			expect(worktrees[0].isMain).toBe(true);
			expect(worktrees[0].detached).toBe(false);
			expect(worktrees[0].branch).toBe('main');

			const existing = await findWorktree(leg.backend, fixture.repo.path, path.join(fixture.root, 'existing'));
			expect(existing?.isMain).toBe(false);
			expect(existing?.branch).toBe('existing-branch');
			expect(existing?.detached).toBe(false);

			const brandNew = await findWorktree(leg.backend, fixture.repo.path, path.join(fixture.root, 'brand-new'));
			expect(brandNew?.branch).toBe('created-branch');
			expect(fixture.repo.git(['rev-parse', 'created-branch']).trim()).toBe(fixture.repo.revParse('main'));

			const detached = await findWorktree(leg.backend, fixture.repo.path, path.join(fixture.root, 'detached'));
			expect(detached?.branch).toBeNull();
			expect(detached?.detached).toBe(true);
			expect(detached?.hash).toBe(fixture.detachedHash);
		});
	});
}

describe('the worktree write flows (add / remove / prune)', () => {
	const repo = RepoBuilder.create('gg-worktrees-writes');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-worktrees-writes-'));

	beforeAll(() => {
		repo.write('file.txt', 'content\n');
		repo.commit('first');
		repo.branch('existing-branch');
	});

	afterAll(() => {
		repo.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('adds a worktree checking out an existing branch (branch set, newBranch not needed)', async () => {
		const worktreePath = path.join(root, 'existing');
		expect(await addWorktree(ctx, repo.path, worktreePath, 'existing-branch', null)).toBeNull();
		const added = await findWorktree(ctx.repo.read, repo.path, worktreePath);
		expect(added).toBeDefined();
		expect(added?.branch).toBe('existing-branch');
		expect(added?.detached).toBe(false);
	});

	it('adds a worktree that creates a new branch at a given start point', async () => {
		const worktreePath = path.join(root, 'brand-new');
		expect(await addWorktree(ctx, repo.path, worktreePath, 'main', 'brand-new-branch')).toBeNull();
		const added = await findWorktree(ctx.repo.read, repo.path, worktreePath);
		expect(added?.branch).toBe('brand-new-branch');
		expect(repo.git(['rev-parse', 'brand-new-branch']).trim()).toBe(repo.revParse('main'));
	});

	it('adds a detached worktree (an explicit commit hash as the start point)', async () => {
		const commitHash = repo.revParse('main');
		const worktreePath = path.join(root, 'detached');
		expect(await addWorktree(ctx, repo.path, worktreePath, commitHash, null)).toBeNull();
		const added = await findWorktree(ctx.repo.read, repo.path, worktreePath);
		expect(added?.branch).toBeNull();
		expect(added?.detached).toBe(true);
		expect(added?.hash).toBe(commitHash);
	});

	it('removes a worktree, dropping it from the list', async () => {
		const worktreePath = path.join(root, 'to-remove');
		expect(await addWorktree(ctx, repo.path, worktreePath, 'main', 'to-remove-branch')).toBeNull();
		expect(await findWorktree(ctx.repo.read, repo.path, worktreePath)).toBeDefined();

		expect(await removeWorktree(ctx, repo.path, worktreePath, false)).toBeNull();
		expect(await findWorktree(ctx.repo.read, repo.path, worktreePath)).toBeUndefined();
	});

	it('force-removes a worktree with uncommitted changes (plain remove would be refused)', async () => {
		const worktreePath = path.join(root, 'dirty');
		expect(await addWorktree(ctx, repo.path, worktreePath, 'main', 'dirty-branch')).toBeNull();
		fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'modified in the worktree\n');

		const plainRemoveError = await removeWorktree(ctx, repo.path, worktreePath, false);
		expect(plainRemoveError).not.toBeNull();

		expect(await removeWorktree(ctx, repo.path, worktreePath, true)).toBeNull();
		expect(await findWorktree(ctx.repo.read, repo.path, worktreePath)).toBeUndefined();
	});

	it('prunes administrative files for a worktree whose directory was deleted outside Git', async () => {
		const worktreePath = path.join(root, 'to-be-deleted-by-hand');
		expect(await addWorktree(ctx, repo.path, worktreePath, 'main', 'deleted-by-hand-branch')).toBeNull();

		// Simulate the user (or their OS) deleting the worktree folder directly, without
		// `git worktree remove` — Git still has administrative state for it until pruned.
		fs.rmSync(worktreePath, { recursive: true, force: true });
		const stale = await findWorktree(ctx.repo.read, repo.path, worktreePath);
		expect(stale).toBeDefined();
		expect(stale?.prunable).toBe(true);

		expect(await pruneWorktrees(ctx, repo.path)).toBeNull();
		expect(await findWorktree(ctx.repo.read, repo.path, worktreePath)).toBeUndefined();
	});

	it('rejects a worktree path that looks like a command-line flag, instead of passing it to git', async () => {
		const error = await addWorktree(ctx, repo.path, '--upload-pack=evil', 'main', null);
		expect(error).not.toBeNull();
	});
});

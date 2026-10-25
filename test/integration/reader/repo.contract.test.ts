import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable, normalisePath } from '../../support/adapters';
import { RepoBuilder } from '../../support/repoBuilder';

/**
 * The repository-identity reads (REFACTOR-PLAN §6.1 L3): opening a repository, discovering its
 * root, and the branch/upstream/remote reads the view opens with. Representative cases only —
 * the engine's own behaviour against git is pinned in L1; this locks both adapters into the same
 * answers. The odd states (detached HEAD, linked worktrees) each build their own repository, so
 * the shared fixture stays immutable.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture = (() => {
	const repo = RepoBuilder.create('gg-contract-repo');
	repo.write('a.txt', 'one\n');
	repo.write('docs/note.txt', 'nested\n');
	repo.commit('the only commit');
	// A real remote with a tracking ref, so `@{upstream}` resolves the way it does in a clone.
	repo.git(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
	repo.updateRef('refs/remotes/origin/main', repo.revParse('HEAD'));
	repo.config('branch.main.remote', 'origin');
	repo.config('branch.main.merge', 'refs/heads/main');
	return repo;
})();

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.dispose();
});

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`repository reads (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.path);
		});

		it('opens the repository and reports its root', async () => {
			expect(normalisePath(root)).toBe(normalisePath(fixture.path));

			// Discovery also works from a nested directory of the work tree.
			const nested = await leg.backend.repoRoot(`${fixture.path}/docs`);
			expect(normalisePath(nested)).toBe(normalisePath(fixture.path));
		});

		it('names the checked-out branch and its upstream', async () => {
			await expect(leg.backend.currentBranchName(root)).resolves.toBe('main');
			await expect(leg.backend.getCurrentBranchUpstream(root)).resolves.toBe('origin/main');
		});

		it('lists the remotes and their fetch URLs', async () => {
			await expect(leg.backend.getRemotes(root)).resolves.toEqual(['origin']);
			await expect(leg.backend.getRemoteUrl(root, 'origin')).resolves.toBe('https://example.invalid/repo.git');
			await expect(leg.backend.getRemoteUrl(root, 'no-such-remote')).resolves.toBeNull();
		});

		it('answers repoRoot for a linked worktree with the worktree itself', async () => {
			const worktreeRepo = RepoBuilder.create('gg-contract-worktree');
			try {
				worktreeRepo.write('a.txt', 'one\n');
				worktreeRepo.commit('one');
				const worktreePath = worktreeRepo.addWorktree('linked', 'main');

				const discovered = await leg.backend.repoRoot(worktreePath);
				expect(normalisePath(discovered)).toBe(normalisePath(worktreePath));
			} finally {
				worktreeRepo.dispose();
			}
		});

		it('reads a detached HEAD as no branch at all', async () => {
			const detached = RepoBuilder.create('gg-contract-detached');
			try {
				detached.write('a.txt', 'one\n');
				detached.commit('one');
				detached.detach('HEAD');

				const detachedRoot = await leg.backend.openRepository(detached.path);
				try {
					await expect(leg.backend.currentBranchName(detachedRoot)).resolves.toBeNull();
				} finally {
					leg.backend.closeRepository(detachedRoot);
				}
			} finally {
				detached.dispose();
			}
		});
	});
}

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RepoBuilder } from '../../support/repoBuilder';
import { adapterLegs, addonAvailable } from '../../support/adapters';

/**
 * The merge/rebase conflict prediction over a REAL repository (the port of
 * `tests/conflictPrediction.test.mjs` off the deleted `DataSource`): the advisory preview of
 * the Merge/Rebase dialogs answers from a single `git merge-tree --write-tree` probe with no
 * working-tree side effects — the whole point of `merge-tree` over a real merge — so every case
 * asserts both the answer and that `git status --porcelain` is byte-identical before and after.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const legs = adapterLegs();

for (const leg of legs) {
// Each leg gets its OWN repository: the cases below branch, commit and reset on shared
// files, so a second leg replaying them against the first leg's repository would commit
// nothing (or read a reflog the first leg rewrote). Fresh repo per leg keeps the legs
// independent of each other and of the engine's presence.
const repo = RepoBuilder.create('gg-conflicts');
const writeAndCommit = (fileName: string, content: string, message: string) => {
	repo.write(fileName, content);
	repo.commit(message);
};
describe.skipIf(leg.needsAddon && !addonAvailable)(`predictConflicts (the merge/rebase advisory, ${leg.name})`, () => {
		it('predicts no conflict for a clean fast-forwardable merge, and touches neither the index nor the working tree', async () => {
			repo.git(['checkout', '-q', '-b', 'clean-branch']);
			writeAndCommit('other.txt', 'new file\n', 'unrelated addition');
			repo.checkout('main');

			const statusBefore = repo.git(['status', '--porcelain']);
			const prediction = await leg.backend.predictConflicts(repo.path, 'main', 'clean-branch');
			expect(prediction).toEqual({ conflicted: false, files: [] });
			expect(repo.git(['status', '--porcelain'])).toBe(statusBefore);

			repo.git(['branch', '-D', 'clean-branch']);
		});

		it('predicts a conflict on the file both branches changed, without running a real merge', async () => {
			repo.git(['checkout', '-q', '-b', 'conflicting-branch']);
			writeAndCommit('shared.txt', 'line1\nbranch-change\n', 'branch change');
			repo.checkout('main');
			writeAndCommit('shared.txt', 'line1\nmain-change\n', 'main change');

			const statusBefore = repo.git(['status', '--porcelain']);
			const prediction = await leg.backend.predictConflicts(repo.path, 'main', 'conflicting-branch');
			expect(prediction.conflicted).toBe(true);
			expect([...prediction.files]).toEqual(['shared.txt']);
			expect(repo.git(['status', '--porcelain'])).toBe(statusBefore);

			repo.git(['branch', '-D', 'conflicting-branch']);
		});

		it('predicts no conflict when the two refs are identical', async () => {
			const head = repo.revParse('HEAD');
			await expect(leg.backend.predictConflicts(repo.path, head, head)).resolves.toEqual({ conflicted: false, files: [] });
		});

		it('resolves to NULL instead of throwing for a ref that does not exist', async () => {
			await expect(leg.backend.predictConflicts(repo.path, 'main', 'refs/heads/no-such-branch')).resolves.toBeNull();
		});

		it('resolves to NULL (rather than passing it to git) for a ref value that looks like a command-line flag', async () => {
			await expect(leg.backend.predictConflicts(repo.path, 'main', '--upload-pack=evil')).resolves.toBeNull();
		});

		beforeAll(() => {
			writeAndCommit('shared.txt', 'line1\n', 'base');
		});

		afterAll(() => {
			leg.backend.closeAllRepositories();
			repo.dispose();
		});
	});
}

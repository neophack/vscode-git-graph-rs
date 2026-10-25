import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable } from '../../support/adapters';
import { buildStandardFixture, StandardFixture } from '../../support/repoBuilder';

/**
 * The statistics reads (REFACTOR-PLAN §6.1 L3): the author list, the per-author commit counts,
 * the activity heatmap and the ahead-count behind the fetch button. The heatmap case adds one
 * commit dated `2024-01-01T23:30:00+05:00` — the printed digits say Monday 23:00 although the
 * true UTC instant is 18:00, which is exactly where the two implementations once disagreed.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-stats');
fixture.repo.commit('a commit with an unusual offset', {
	allowEmpty: true,
	authorDate: '2024-01-01T23:30:00+05:00'
});
// A mailmap that renames the fixture's author: the raw identity reads must ignore it, exactly
// because the statistics views below apply it and the two spellings must not be confused.
fixture.repo.write('.mailmap', 'Mapped Name <test@example.com> Test User <test@example.com>\n');
fixture.repo.commit('add the mailmap');

const legs = adapterLegs();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`statistics reads (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
		});

		it('lists the raw author identities, ignoring .mailmap', async () => {
			const authors = await leg.backend.getAuthors(root);

			// The commit rows show raw identities, so the author list must be raw too — even
			// though the repository carries a .mailmap that renames Test User.
			expect(authors).toEqual([
				{ name: 'Second Author', email: 'second@example.com' },
				{ name: 'Test User', email: 'test@example.com' }
			]);
			expect(authors.some((author) => author.name === 'Mapped Name')).toBe(false);
		});

		it('counts commits per author across all refs, merges excluded', async () => {
			const stats = await leg.backend.getAuthorStatistics(root);

			const secondAuthor = stats.find((stat) => stat.email === 'second@example.com');
			expect(secondAuthor !== undefined && secondAuthor.commits).toBe(1);
			const testUser = stats.find((stat) => stat.email === 'test@example.com');
			expect(testUser !== undefined && testUser.commits > 1).toBe(true);
		});

		it('bins the heatmap by the printed weekday and hour digits', async () => {
			const cells = await leg.backend.getActivityHeatmap(root);

			expect(cells.length).toBeGreaterThan(0);
			expect(cells.every((cell) => cell.count > 0)).toBe(true);
			// 2024-01-01T23:30:00+05:00 is Monday (1) hour 23 by its printed digits; no other
			// commit of the fixture lands in that cell.
			const cell = cells.find((entry) => entry.weekday === 1 && entry.hour === 23);
			expect(cell !== undefined && cell.count).toBe(1);
		});

		it('counts the commits a branch is ahead by, like git rev-list does', async () => {
			// git is the oracle for the count itself: both adapters must answer what
			// `git rev-list --count` answers for the same range.
			const expected = Number.parseInt(fixture.repo.git(['rev-list', '--count', `${fixture.first}..main`]), 10);
			await expect(leg.backend.countCommitsBefore(root, ['main'], fixture.first, false, false)).resolves.toBe(expected);

			// An unknown hash never silently counts zero.
			await expect(
				leg.backend.countCommitsBefore(root, null, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', true, false)
			).rejects.toThrow();
		});
	});
}

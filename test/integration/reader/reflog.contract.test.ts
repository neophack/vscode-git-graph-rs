import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RepoBuilder } from '../../support/repoBuilder';
import { adapterLegs, addonAvailable } from '../../support/adapters';

/**
 * The reflog read of the Reflog Widget over REAL repositories (the port of
 * `tests/reflogDataSource.test.mjs` off the deleted `DataSource`): newest-first entries with
 * index-based selectors rebuilt from each entry's position (not trusted from `%gd`, which
 * switches to a date-based form once `--date` is given), pagination via `moreAvailable`, and
 * the dangling flag's no-false-positive guarantee — `git reset --hard` plus
 * `git prune --expire=now` must not flag the stranded entry, because prune treats the ref's own
 * reflog as a reachability root (the case's comment in the legacy file pinned why).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const legs = adapterLegs();

for (const leg of legs) {
// Each leg gets its OWN repository: the dangling case below resets HEAD, which would leave
// a `reset:` entry on top of the reflog the next leg reads. Fresh repo per leg keeps the
// legs independent of each other and of the engine's presence.
const repo = RepoBuilder.create('gg-reflog');
const commit = (message: string) => {
	repo.write('file.txt', message + '\n');
	repo.commit(message);
};
describe.skipIf(leg.needsAddon && !addonAvailable)(`getReflog (the Reflog Widget read, ${leg.name})`, () => {
	beforeAll(() => {
		commit('first');
		commit('second');
		commit('third');
	});

	afterAll(() => {
		leg.backend.closeAllRepositories();
		repo.dispose();
	});

		it('lists reflog entries newest-first, with index-based selectors and readable messages', async () => {
			const { entries, moreAvailable } = await leg.backend.getReflog(repo.path, 'HEAD', 200);

			expect(moreAvailable).toBe(false);
			expect(entries.length).toBeGreaterThanOrEqual(3);

			// Newest first: the most recent commit is entry 0.
			expect(entries[0].selector).toBe('HEAD@{0}');
			expect(entries[0].message).toMatch(/^commit:/);
			expect(entries[1].selector).toBe('HEAD@{1}');
			expect(entries[2].selector).toBe('HEAD@{2}');

			const thirdHash = repo.revParse('HEAD');
			expect(entries[0].hash).toBe(thirdHash);
			expect(entries[0].abbrevHash).toBe(thirdHash.substring(0, 7));

			// A fresh, still-reachable history: nothing should be flagged dangling.
			for (const entry of entries) expect(entry.dangling).toBe(false);
		});

		it('never flags an entry dangling merely for being unreachable from a branch (reset does not delete objects)', async () => {
			const strandedHash = repo.revParse('HEAD');
			repo.git(['reset', '--hard', 'HEAD~1']); // "third" is now unreachable from any branch, but still a real object
			repo.git(['prune', '--expire=now']);

			const { entries } = await leg.backend.getReflog(repo.path, 'HEAD', 200);
			const strandedEntry = entries.find((e) => e.hash === strandedHash);
			expect(strandedEntry).toBeDefined();
			expect(strandedEntry?.dangling).toBe(false);

			const currentHeadEntry = entries.find((e) => e.hash === repo.revParse('HEAD'));
			expect(currentHeadEntry?.dangling).toBe(false);
		});

		it('respects the limit and reports moreAvailable when there are more entries than the page size', async () => {
			const page = await leg.backend.getReflog(repo.path, 'HEAD', 2);
			expect(page.entries.length).toBe(2);
			expect(page.moreAvailable).toBe(true);
		});

		it('rejects for a ref git cannot resolve (the handler maps the rejection to the error field)', async () => {
			await expect(leg.backend.getReflog(repo.path, 'no-such-ref-anywhere', 50)).rejects.toBeTruthy();
		});
	});
}

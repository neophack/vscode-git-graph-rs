import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RepoBuilder } from '../../support/repoBuilder';
import { adapterLegs, addonAvailable } from '../../support/adapters';

/**
 * The reader contract for OUT-OF-BAND repository changes (the external/commit-appears E2E
 * scenario's reader half): a commit made by another process — a user's terminal, the automation
 * runner — while the extension holds an open handle. Two contracts:
 *
 * 1. The warm-handle remedy: the engine keeps one handle per repository for the session, and a
 *    handle opened before an out-of-band change can keep serving the pre-change graph (the
 *    E2E caught exactly that: a page whose head was the new commit while its commit list was
 *    the pre-commit page). Dropping the handle (`closeRepository`) is the remedy the Panel's
 *    file-watcher callback applies before every refresh — this pins that the seam works.
 * 2. The page invariant the E2E failure turned into an assertion: a `getCommits` answer whose
 *    head names a checked-out branch tip must carry that commit in its own list. The staged
 *    pipeline relies on it (the "Uncommitted Changes" follow-up only runs when HEAD is among
 *    the loaded commits), so a payload that violates it silently drops that follow-up.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const repo = RepoBuilder.create('gg-contract-external-change');
const legs = adapterLegs();

beforeAll(() => {
	repo.write('a.txt', 'one\n');
	repo.commit('base commit');
});

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	repo.dispose();
});

const pageOptions = {
	branches: null,
	authors: [] as string[],
	maxCommits: 300,
	showTags: true,
	showRemoteBranches: false,
	includeCommitsMentionedByReflogs: false,
	onlyFollowFirstParent: false,
	commitOrdering: 'date' as const,
	remotes: [] as string[],
	hideRemotes: [] as string[],
	stashes: [] as never[],
	gerritRefs: null,
	filterPath: null,
	deferUncommittedChanges: true,
	deferRemoteRefs: false
};

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`out-of-band changes (${leg.name})`, () => {
		it('serves the out-of-band commit after the handle was dropped (the Panel refresh remedy)', async () => {
			const root = await leg.backend.openRepository(repo.path);

			// A first load primes every warm cache the backend holds for the repository.
			const before = await leg.backend.getCommits(root, pageOptions);
			expect(before.commits.some((commit) => commit.message.includes('base commit'))).toBe(true);

			// The out-of-band commit, the way the E2E runner (a user's terminal) makes it.
			repo.commit('External automation commit', { allowEmpty: true });

			// The remedy: drop the handle before the refresh's reads, as the Panel's watcher
			// callback does. The next read must re-open the repository and see the commit.
			leg.backend.closeRepository(root);
			const after = await leg.backend.getCommits(root, pageOptions);
			expect(after.commits.some((commit) => commit.message.includes('External automation commit'))).toBe(true);
			expect(after.head).toBe(repo.revParse('HEAD'));
		});

		it('never answers a page whose head is missing from its own commit list', async () => {
			const root = await leg.backend.openRepository(repo.path);

			// Back-to-back loads across an out-of-band commit: whatever the warm caches serve,
			// head and list must agree (the invariant the staged pipeline's follow-ups build on).
			for (let round = 0; round < 3; round++) {
				if (round > 0) repo.commit('out-of-band commit ' + round, { allowEmpty: true });
				const page = await leg.backend.getCommits(root, pageOptions);
				if (page.head !== null && page.commits.length > 0) {
					expect(page.commits.some((commit) => commit.hash === page.head),
						'round ' + round + ': head ' + page.head + ' was not among the ' + page.commits.length + ' loaded commits').toBe(true);
				}
			}
		});
	});
}

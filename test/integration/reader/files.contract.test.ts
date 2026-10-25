import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable, changesByPath } from '../../support/adapters';
import { buildStandardFixture, StandardFixture, textLines } from '../../support/repoBuilder';

/**
 * The on-demand per-file and per-commit reads (REFACTOR-PLAN §6.1 L3): file contents and diffs
 * at a revision, commit bodies/subjects/summaries, history search, rename resolution and the
 * submodule roots. One or two representative cases per method; byte-level parser behaviour and
 * the engine-vs-git blob semantics are pinned in L1 and the CLI parsers' L2.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const fixture: StandardFixture = buildStandardFixture('gg-contract-files');
// The standard fixture gains a submodule, committed on top — a gitlink with .gitmodules, the
// way `git submodule add` leaves one without a network.
fixture.repo.initSubmodule('sub', 'https://example.invalid/sub.git');
fixture.repo.commit('add the submodule');

const legs = adapterLegs();

/** The change lines of a diff with the headers the two adapters legitimately spell differently. */
function diffBody(diff: string): string {
	return diff
		.trim()
		.split('\n')
		.filter((line) => !/^(index |similarity index |rename |--- |\+\+\+ |new file mode |diff --git )/.test(line))
		.join('\n');
}

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.repo.dispose();
});

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`file and metadata reads (${leg.name})`, () => {
		let root: string;

		beforeAll(async () => {
			root = await leg.backend.openRepository(fixture.repo.path);
		});

		it('reads a text file at a revision verbatim', async () => {
			const file = await leg.backend.getCommitFile(root, fixture.renamed, 'renamed.txt');
			expect(file.binary).toBe(false);
			expect(file.contents).toBe(textLines(40, 'line'));
		});

		it('reports a binary file as binary, with no contents', async () => {
			const file = await leg.backend.getCommitFile(root, fixture.binary, 'blob.bin');
			expect(file.binary).toBe(true);
			expect(file.contents).toBeNull();
		});

		it('fails a file the revision does not carry', async () => {
			// a.txt was renamed away before feature.txt existed — either reason misses.
			await expect(leg.backend.getCommitFile(root, fixture.first, 'feature.txt')).rejects.toThrow();
		});

		it('diffs one file of a commit, and a pure rename has no hunks', async () => {
			const added = await leg.backend.getCommitFileDiff(root, fixture.feature, 'feature.txt');
			// A one-line hunk spells its length without the `,1`.
			expect(added).toContain('@@ -0,0 +1 @@');
			expect(added).toContain('+feature work');

			const renamed = await leg.backend.getCommitFileDiff(root, fixture.renamed, 'renamed.txt');
			expect(diffBody(renamed)).toBe('');
		});

		it('diffs a file added by the root commit, and an untouched file to nothing', async () => {
			const rootCommit = await leg.backend.getCommitFileDiff(root, fixture.first, 'a.txt');
			expect(rootCommit).toContain('@@ -0,0 +1,40 @@');

			const untouched = await leg.backend.getCommitFileDiff(root, fixture.binary, 'renamed.txt');
			expect(untouched).toBe('');
		});

		it('reads the full commit bodies it is asked for, once per commit', async () => {
			const bodies = await leg.backend.getCommitBodies(root, [fixture.first, fixture.renamed]);
			expect(bodies).toEqual({ [fixture.first]: 'the first commit', [fixture.renamed]: 'rename a file' });

			// A commit named twice is one entry.
			const deduplicated = await leg.backend.getCommitBodies(root, [fixture.first, fixture.first]);
			expect(Object.keys(deduplicated)).toEqual([fixture.first]);

			// A missing hash fails the whole call.
			await expect(leg.backend.getCommitBodies(root, ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'])).rejects.toThrow();
		});

		it('reads a whitespace-normalised subject', async () => {
			await expect(leg.backend.getCommitSubject(root, fixture.renamed)).resolves.toBe('rename a file');
		});

		it('summarises commits for the graph tooltips', async () => {
			const summaries = await leg.backend.getCommitSummaries(root, [fixture.first, fixture.feature]);

			expect(Object.keys(summaries).sort()).toEqual([fixture.feature, fixture.first].sort());
			expect(summaries[fixture.first].author).toBe('Test User');
			expect(summaries[fixture.first].email).toBe('test@example.com');
			expect(summaries[fixture.first].message).toBe('the first commit');
			expect(summaries[fixture.feature].message).toBe('the feature commit');
		});

		it('searches history case-insensitively with extended patterns', async () => {
			const matches = await leg.backend.searchHistory(root, 'feature');
			expect(matches.some((match) => match.message === 'the feature commit')).toBe(true);

			const upperCase = await leg.backend.searchHistory(root, 'THE FEATURE');
			expect(upperCase.length).toBeGreaterThan(0);

			const pattern = await leg.backend.searchHistory(root, 'the (feature|main) commit');
			expect(pattern.length).toBeGreaterThanOrEqual(2);
		});

		it('resolves where a renamed file went, and misses politely otherwise', async () => {
			await expect(leg.backend.getNewPathOfRenamedFile(root, fixture.first, 'a.txt')).resolves.toBe('renamed.txt');
			await expect(leg.backend.getNewPathOfRenamedFile(root, fixture.first, 'no-such.txt')).resolves.toBeNull();
		});

		it('lists the roots of the initialised submodules', async () => {
			const submodules = await leg.backend.getSubmodules(root);
			expect(submodules).toHaveLength(1);
			// The roots are absolute paths; the adapters may spell the separator differently.
			const [submodule] = submodules;
			expect(submodule.replace(/\\/g, '/')).toContain('/sub');
		});

		it('lists the files of the submodule commit like any other commit', async () => {
			const submoduleCommit = fixture.repo.revParse('HEAD');
			const details = await leg.backend.getCommitDetails(root, submoduleCommit);
			expect(changesByPath(details.fileChanges).map((change) => change.newFilePath).sort())
				.toEqual(['.gitmodules', 'renamed.txt', 'sub', 'untracked.txt']);
		});
	});
}

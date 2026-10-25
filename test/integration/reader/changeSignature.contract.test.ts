import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RepoBuilder } from '../../support/repoBuilder';
import { adapterLegs, addonAvailable } from '../../support/adapters';

/**
 * The repository change signature over a REAL repository (the port of
 * `tests/repoChangeSignature.test.mjs` off the deleted `DataSource`): the signature feeds the
 * background change poll of the Git Graph View, so it must react to a new commit landing on an
 * EXISTING branch — the case the name-only lists of a repo-info read cannot express (no branch
 * name appears or disappears) — while a working-tree-only edit (a file save) must NOT fire the
 * poll, consecutive reads of an unchanged repository must agree, and a path that is not a
 * repository resolves to NULL (never rejects, never hangs).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const repo = RepoBuilder.create('gg-signature');
const legs = adapterLegs();

beforeAll(() => {
	repo.write('a.txt', 'one\n');
	repo.commit('first');
});

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	repo.dispose();
});

for (const leg of legs) {
	describe.skipIf(leg.needsAddon && !addonAvailable)(`getRepoChangeSignature (the change poll's baseline, ${leg.name})`, () => {
		it('changes when a new commit lands on the existing checked-out branch', async () => {
			const before = await leg.backend.getRepoChangeSignature(repo.path);

			repo.write('a.txt', 'one\ntwo\n');
			repo.commit('second'); // no branch name appears or disappears

			const after = await leg.backend.getRepoChangeSignature(repo.path);
			expect(after).not.toBeNull();
			expect(after).not.toBe(before);
		});

		it('does not change for a working-tree-only edit (the poll must not fire on file saves)', async () => {
			const before = await leg.backend.getRepoChangeSignature(repo.path);

			repo.write('uncommitted.txt', 'a file save the poll must ignore\n');

			expect(await leg.backend.getRepoChangeSignature(repo.path)).toBe(before);
		});

		it('stays stable across consecutive reads of an unchanged repository', async () => {
			const first = await leg.backend.getRepoChangeSignature(repo.path);
			expect(await leg.backend.getRepoChangeSignature(repo.path)).toBe(first);
		});

		it('resolves (never rejects, never hangs) for a path that is not a repository', async () => {
			// A plain directory that was never a repository. (The legacy `DataSource` wrapper mapped
			// the failed read to NULL; the read backend's own catch answers a signature whose HEAD is
			// NULL and whose lists are empty for the same situation — stable across reads, so the
			// poll neither fires on it nor hangs. Both contracts pin: never a rejection.)
			const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-signature-plain-'));
			try {
				const first = await leg.backend.getRepoChangeSignature(plain);
				expect(first).not.toBeNull();
				await expect(leg.backend.getRepoChangeSignature(plain)).resolves.toBe(first);
			} finally {
				fs.rmSync(plain, { recursive: true, force: true });
			}
		});
	});
}

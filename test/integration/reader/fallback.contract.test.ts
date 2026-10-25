import * as fs from 'node:fs';
import * as os from 'node:os';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { adapterLegs, addonAvailable } from '../../support/adapters';
import { RepoBuilder } from '../../support/repoBuilder';
import { createBackend, GitBackend, NativeBackend } from '../../../src/extension/git/read/backendIndex';
import { GitBackendError } from '../../../src/extension/git/read/types';

/**
 * The composition contract (REFACTOR-PLAN §6.1 L3): what `createBackend` users actually get —
 * the engine's declines routed to the git CLI per call, invisibly. Every case needs the native
 * addon (without one `createBackend({ prefer: 'rust' })` IS the CLI and there is nothing to
 * route), so the whole file skips cleanly when the engine is not built. The engine-side decline
 * semantics themselves are pinned in L1 (`reftable.rs`, `graph_and_diff.rs`).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const legs = adapterLegs();
const cliBackend: GitBackend | undefined = legs.find((leg) => leg.name === 'git-cli')?.backend;

/** A one-commit ordinary repository, shared by the composition cases. */
const fixture = (() => {
	const repo = RepoBuilder.create('gg-contract-fallback');
	repo.write('a.txt', 'one\n');
	repo.commit('the only commit');
	return repo;
})();

const reftableSupported = RepoBuilder.supportsRefFormat();

afterAll(() => {
	for (const leg of legs) leg.backend.closeAllRepositories();
	fixture.dispose();
});

describe.skipIf(!addonAvailable)('backend composition over the engine\'s declines', () => {
	let root: string;
	let fallbacks: string[];
	let backend: GitBackend;

	beforeAll(async () => {
		root = await cliBackend?.openRepository(fixture.path) ?? '';
	});

	beforeEach(() => {
		fallbacks = [];
		backend = createBackend({ prefer: 'rust', gitPath: 'git', onFallback: (method) => fallbacks.push(method) });
	});

	it('routes a --glob= branch selection to the CLI, with the CLI\'s answer', async () => {
		const head = fixture.revParse('HEAD');
		const glob = ['--glob=refs/heads/**'];
		const viaFallback = await backend.countCommitsBefore(root, glob, head, true, false);
		const viaCli = cliBackend !== undefined ? await cliBackend.countCommitsBefore(root, glob, head, true, false) : undefined;

		// The engine's tip resolution cannot resolve a glob; the decline must be what routed
		// the load, and the CLI's answer must be the one served.
		expect(viaFallback).toBe(viaCli);
		expect(fallbacks).toEqual(['countCommitsBefore']);
	});

	it('routes the reflog-inclusive count to the CLI the same way', async () => {
		const head = fixture.revParse('HEAD');
		const viaFallback = await backend.countCommitsBefore(root, null, head, true, true);
		const viaCli = cliBackend !== undefined ? await cliBackend.countCommitsBefore(root, null, head, true, true) : undefined;

		expect(viaFallback).toBe(viaCli);
		expect(fallbacks).toEqual(['countCommitsBefore']);
	});

	it('answers signature verification from the CLI after the engine declines it', async () => {
		// The engine does not implement the GPG keyring integration; the composed backend must
		// still answer (an unsigned commit verifies to no signature).
		await expect(backend.getCommitSignature(root, fixture.revParse('HEAD'))).resolves.toBeNull();
		expect(fallbacks).toEqual(['getCommitSignature']);
	});

	it('falls back over the engine\'s failure to open a non-repository path', async () => {
		// A directory that never was a repository is no repository for either backend; the
		// engine's NotARepository decline is the kind fallen back over, and the CLI's failure
		// is what surfaces.
		const outside = fs.mkdtempSync(`${os.tmpdir()}/gg-contract-notarepo-`);
		try {
			await expect(backend.openRepository(outside)).rejects.toThrow();
			expect(fallbacks).toEqual(['openRepository']);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it('keeps the engine\'s own decline visible when the caller holds the native backend', async () => {
		// The pure adapter still declines; only the composition hides the decline.
		const native = new NativeBackend();
		const opened = await native.openRepository(fixture.path);
		try {
			const decline = native.getCommitSignature(opened, fixture.revParse('HEAD'));
			await expect(decline).rejects.toBeInstanceOf(GitBackendError);
			await expect(decline).rejects.toMatchObject({ kind: 'Unsupported' });
		} finally {
			native.closeRepository(opened);
		}
	});

	it.runIf(reftableSupported)('hands a whole reftable repository to the CLI', async () => {
		// A `git init --ref-format=reftable` repository is unreadable by the engine's gitoxide:
		// the engine must DECLINE opening it (an empty answer would look like an empty
		// repository), and the composition must serve the view over the CLI.
		const reftable = RepoBuilder.createWithRefFormat('gg-contract-reftable', 'reftable');
		try {
			reftable.write('a.txt', 'one\n');
			reftable.commit('the only commit');

			const native = new NativeBackend();
			await expect(native.getRepoInfo(reftable.path, { showRemoteBranches: true }))
				.rejects.toMatchObject({ kind: 'Unsupported' });

			const info = await backend.getRepoInfo(reftable.path, { showRemoteBranches: true, showStashes: true });
			expect(info.error).toBeNull();
			expect(info.head).toBe('main');
			expect(info.branches).toEqual(['main']);
			expect(fallbacks).toContain('getRepoInfo');
		} finally {
			reftable.dispose();
		}
	});
});

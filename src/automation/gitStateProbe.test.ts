import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The GitStateProbe's L3 tests (REFACTOR-PLAN task 4.10): one real throwaway repository per
 * suite, known fixture mutations between assertions, and — for EVERY assertion kind — one case
 * that must HOLD and one that must FAIL. The probe judges through the git CLI, so these tests
 * prove each judgment against real git behavior, not a mock.
 */

vi.mock('vscode', () => ({
	version: '1.90.0',
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3 },
	window: {},
	Uri: { file: (p: string) => ({ scheme: 'file', fsPath: p, path: p }) },
	env: { clipboard: {} },
	commands: { executeCommand: () => Promise.resolve(undefined) },
	workspace: { getConfiguration: () => ({ get: (_k: string, d?: unknown) => d, has: () => false, inspect: () => undefined, update: () => Promise.resolve() }) }
}));

import { git } from './fixture';
import { GitStateProbe } from './gitStateProbe';

/** The shared throwaway repository every test mutates in a known order. */
let repo = '';
/** The HEAD hash of the third commit — the fixture's stable full hash. */
let headHash = '';
/** The empty stand-in global config keeping the probe's config reads hermetic. */
let isolatedGlobalConfig = '';
let previousGlobalConfig: string | undefined;
let previousNoSystem: string | undefined;

beforeAll(async () => {
	vi.setConfig({ testTimeout: 120000 });
	// Hermetic config (plan §6.8.6's isolation): the probe reads config exactly as git resolves
	// it, so the developer's real global user.name must not leak into the unset-judgments.
	isolatedGlobalConfig = path.join(os.tmpdir(), 'gg-probe-global-config-' + Date.now());
	fs.writeFileSync(isolatedGlobalConfig, '');
	previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
	previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
	process.env.GIT_CONFIG_GLOBAL = isolatedGlobalConfig;
	process.env.GIT_CONFIG_NOSYSTEM = '1';
	repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-probe-'));
	// Three commits with known subjects, a feature branch, a tag, a remote, a stash and an
	// untracked file — every dimension the probe judges.
	await git(['init', repo]);
	await git(['-C', repo, 'config', 'user.name', 'Probe']);
	await git(['-C', repo, 'config', 'user.email', 'probe@probe.dev']);
	for (const message of ['first commit', 'second commit', 'third commit']) {
		fs.writeFileSync(path.join(repo, 'file.txt'), message + '\n');
		await git(['-C', repo, 'add', 'file.txt']);
		await git(['-C', repo, 'commit', '-m', message]);
	}
	headHash = (await git(['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
	await git(['-C', repo, 'branch', 'feature']);
	await git(['-C', repo, 'tag', 'v1.0.0']);
	const remote = path.join(os.tmpdir(), 'gg-probe-remote-' + Date.now());
	fs.mkdirSync(remote, { recursive: true });
	await git(['init', '--bare', remote]);
	await git(['-C', repo, 'remote', 'add', 'origin', remote]);
	await git(['-C', repo, 'push', '-q', 'origin', 'main']);
	await git(['-C', repo, 'fetch', '-q', 'origin']);
	await git(['-C', repo, 'branch', '--set-upstream-to=origin/main', 'main']);
	fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
	fs.appendFileSync(path.join(repo, 'file.txt'), 'dirty\n');
	await git(['-C', repo, 'stash', 'push', '-m', 'probe-stash-one']);
	fs.appendFileSync(path.join(repo, 'file.txt'), 'dirty again\n');
}, 180000);

afterAll(async () => {
	if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
	if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
	if (repo === '') return;
	// Best-effort cleanup: the probe's git reads leave no locks; the OS owns temp hygiene.
	try {
		const marker = path.join(repo, '.git');
		if (fs.existsSync(marker)) {
			for (const entry of fs.readdirSync(repo)) {
				try { fs.chmodSync(path.join(repo, entry), 0o666); } catch (_) { /* removal reports real problems */ }
			}
			fs.rmSync(repo, { recursive: true, force: true });
		}
	} catch (_) {
		// left behind — harmless
	}
}, 180000);

describe('GitStateProbe refs', () => {
	it('holds for a present ref and fails for an absent one', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'refPresent', ref: 'main' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'refPresent', ref: 'feature' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'refPresent', ref: 'v1.0.0' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'refPresent', ref: 'origin/main' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'refPresent', ref: 'no-such-branch' })).resolves.toContain('expected ref "no-such-branch" to exist');
	});

	it('holds for absence after a known deletion and fails while the ref still exists', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'refAbsent', ref: 'main' })).resolves.toContain('expected ref "main" to be gone');
		await git(['-C', repo, 'branch', '-D', 'feature']); // the known fixture mutation
		await expect(probe.assert({ kind: 'refAbsent', ref: 'feature' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'refAbsent', ref: 'v1.0.0' })).resolves.toContain('to be gone');
	});
});

describe('GitStateProbe upstream', () => {
	it('holds for the configured tracking branch and fails for another or none', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'upstreamIs', branch: 'main', upstream: 'origin/main' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'upstreamIs', branch: 'main', upstream: 'origin/other' })).resolves.toContain('to track "origin/other"');
		await expect(probe.assert({ kind: 'upstreamIs', branch: 'main', upstream: null })).resolves.toContain('to track "null"');
		await git(['-C', repo, 'checkout', '-q', '-b', 'untracked-branch']);
		await expect(probe.assert({ kind: 'upstreamIs', branch: 'untracked-branch', upstream: null })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'upstreamIs', branch: 'untracked-branch', upstream: 'origin/main' })).resolves.toContain('got "null"');
		await git(['-C', repo, 'checkout', '-q', 'main']);
		await git(['-C', repo, 'branch', '-D', 'untracked-branch']);
	});
});

describe('GitStateProbe HEAD', () => {
	it('holds for the checked-out branch name and fails for another name', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'headIs', name: 'main' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'headIs', name: 'feature' })).resolves.toContain('expected HEAD to be "feature"');
	});

	it('matches a detached HEAD by hash (prefixes included) and fails for a wrong hash', async () => {
		const probe = new GitStateProbe(repo);
		await git(['-C', repo, 'checkout', '-q', '--detach', 'HEAD']);
		await expect(probe.assert({ kind: 'headIs', name: headHash })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'headIs', name: headHash.slice(0, 8) })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'headIs', name: '0'.repeat(40) })).resolves.toContain('got detached HEAD at');
		await git(['-C', repo, 'checkout', '-q', 'main']);
	});
});

describe('GitStateProbe commits', () => {
	it('counts a range exactly and fails on an off-by-one or an unreadable range', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'commitCount', range: 'HEAD', count: 3 })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'commitCount', range: 'HEAD', count: 2 })).resolves.toContain('expected 2 commits');
		await expect(probe.assert({ kind: 'commitCount', range: 'HEAD~2..HEAD', count: 2 })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'commitCount', range: 'no-such-ref..HEAD', count: 1 })).resolves.toContain('unreadable range');
	});

	it('compares the subjects of a range in order (newest first) and fails on any difference', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'commitMessages', range: 'HEAD', messages: ['third commit', 'second commit', 'first commit'] })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'commitMessages', range: 'HEAD', messages: ['second commit', 'third commit', 'first commit'] })).resolves.toContain('expected the subjects');
		await expect(probe.assert({ kind: 'commitMessages', range: 'HEAD', messages: ['third commit'] })).resolves.toContain('expected the subjects');
		// After a known mutation the old subjects no longer hold and the new one does.
		await git(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'fourth commit']);
		await expect(probe.assert({ kind: 'commitMessages', range: 'HEAD~1..HEAD', messages: ['fourth commit'] })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'commitMessages', range: 'HEAD', messages: ['third commit', 'second commit', 'first commit'] })).resolves.toContain('expected the subjects');
	});
});

describe('GitStateProbe worktree status', () => {
	it('judges clean/dirty and contained entries after known mutations', async () => {
		const probe = new GitStateProbe(repo);
		// The fixture is dirty (the appended, unstaged modification of file.txt).
		await expect(probe.assert({ kind: 'worktreeStatus', clean: false })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'worktreeStatus', clean: false, contains: ['M file.txt'] })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'worktreeStatus', clean: true })).resolves.toContain('expected a clean worktree');
		await expect(probe.assert({ kind: 'worktreeStatus', clean: false, contains: ['M nope.txt'] })).resolves.toContain('expected the worktree status to contain "M nope.txt"');
		// The known mutations: discard the modification AND remove the untracked file — only
		// then is the worktree clean.
		await git(['-C', repo, 'checkout', '-q', '--', 'file.txt']);
		fs.unlinkSync(path.join(repo, 'untracked.txt'));
		await expect(probe.assert({ kind: 'worktreeStatus', clean: true })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'worktreeStatus', clean: false })).resolves.toContain('expected a dirty worktree');
	});

	it('sees untracked files in the entry list', async () => {
		const probe = new GitStateProbe(repo);
		fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked again\n');
		await expect(probe.assert({ kind: 'worktreeStatus', clean: false, contains: ['?? untracked.txt'] })).resolves.toBeNull();
		fs.unlinkSync(path.join(repo, 'untracked.txt'));
		await expect(probe.assert({ kind: 'worktreeStatus', contains: ['?? untracked.txt'] })).resolves.toContain('expected the worktree status to contain "?? untracked.txt"');
		await expect(probe.assert({ kind: 'worktreeStatus', clean: true })).resolves.toBeNull();
	});
});

describe('GitStateProbe stashes', () => {
	it('counts the stash list and its messages, failing on the wrong count or message', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'stashCount', count: 1, messageContains: 'probe-stash-one' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'stashCount', count: 2 })).resolves.toContain('expected 2 stashes, got 1');
		await expect(probe.assert({ kind: 'stashCount', count: 1, messageContains: 'other-message' })).resolves.toContain('expected a stash message containing "other-message"');
		// The known mutation: drop the stash — zero now holds, one no longer does.
		await git(['-C', repo, 'stash', 'clear']);
		await expect(probe.assert({ kind: 'stashCount', count: 0 })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'stashCount', count: 1 })).resolves.toContain('expected 1 stashes, got 0');
	});
});

describe('GitStateProbe config', () => {
	it('matches set and unset values, observing the repository config (no -c overrides)', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'configValue', key: 'user.name', value: 'Probe' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'configValue', key: 'user.name', value: 'Someone Else' })).resolves.toContain('expected config "user.name" to be one of');
		await expect(probe.assert({ kind: 'configValue', key: 'probe.neverseen', value: null })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'configValue', key: 'probe.neverseen', value: 'x' })).resolves.toContain('expected config "probe.neverseen" to be one of');
		// The known mutation: unset user.name — null then holds.
		await git(['-C', repo, 'config', '--unset', 'user.name']);
		await expect(probe.assert({ kind: 'configValue', key: 'user.name', value: null })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'configValue', key: 'user.name', value: 'Probe' })).resolves.toContain('got unset');
	});

	it('matches any one value of a multi-valued key (--add semantics)', async () => {
		const probe = new GitStateProbe(repo);
		const headsRefspec = (await git(['-C', repo, 'config', '--get', 'remote.origin.fetch'])).stdout.trim();
		await git(['-C', repo, 'config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/remotes/origin/tags/*']);
		await expect(probe.assert({ kind: 'configValue', key: 'remote.origin.fetch', value: '+refs/tags/*:refs/remotes/origin/tags/*' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'configValue', key: 'remote.origin.fetch', value: headsRefspec })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'configValue', key: 'remote.origin.fetch', value: 'no-such-refspec' })).resolves.toContain('expected config "remote.origin.fetch" to be one of');
	});
});

describe('GitStateProbe remotes', () => {
	it('judges presence (with URL) and absence after a known removal', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assert({ kind: 'remotePresent', name: 'origin' })).resolves.toBeNull();
		const url = (await git(['-C', repo, 'remote', 'get-url', 'origin'])).stdout.trim();
		await expect(probe.assert({ kind: 'remotePresent', name: 'origin', url })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'remotePresent', name: 'origin', url: 'E:/wrong' })).resolves.toContain('to point at "E:/wrong"');
		await expect(probe.assert({ kind: 'remotePresent', name: 'upstream' })).resolves.toContain('expected remote "upstream" to exist');
		await expect(probe.assert({ kind: 'remoteAbsent', name: 'upstream' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'remoteAbsent', name: 'origin' })).resolves.toContain('expected remote "origin" to be gone');
		// The known mutation: remove origin — absence then holds.
		await git(['-C', repo, 'remote', 'remove', 'origin']);
		await expect(probe.assert({ kind: 'remoteAbsent', name: 'origin' })).resolves.toBeNull();
		await expect(probe.assert({ kind: 'remotePresent', name: 'origin' })).resolves.toContain('expected remote "origin" to exist');
	});
});

describe('GitStateProbe.assertAll', () => {
	it('resolves null only when every assertion holds, reporting the first failure with its index', async () => {
		const probe = new GitStateProbe(repo);
		await expect(probe.assertAll([
			{ kind: 'headIs', name: 'main' },
			{ kind: 'refPresent', ref: 'v1.0.0' }
		])).resolves.toBeNull();
		const failure = await probe.assertAll([
			{ kind: 'headIs', name: 'main' },
			{ kind: 'refAbsent', ref: 'v1.0.0' },
			{ kind: 'refAbsent', ref: 'also-failing-but-not-first' }
		]);
		expect(failure).toMatch(/^git\[1\] expected ref "v1\.0\.0" to be gone/);
	});
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RepoBuilder } from '../../support/repoBuilder';
import { writeHarness } from '../../support/writeHarness';
import { abortOperation, continueOperation, createFixupCommit, createSquashCommit } from '../../../src/extension/graphView/writeFlows';
import { GitConfigKey, setConfigValue, unsetConfigValue } from '../../../src/extension/git/write/ops/config';
import { GitConfigLocation, GitOperationType } from '../../../src/shared/model/git';
import { resolveGlobalAuthorAfterSave } from '../../../src/extension/graphView/globalSettings';

/**
 * The remaining write-path suites over REAL repositories, ported off the deleted `DataSource`:
 *
 * - `createFixupCommit`/`createSquashCommit` and the `rebase --autosquash` mechanism that folds
 *   them back in (from `tests/fixupSquash.test.mjs`);
 * - the Conflict Banner's operation-state detection and its continue/abort actions (from
 *   `tests/operationState.test.mjs`); the marker-file parsing itself is unit tested in
 *   `src/extension/git/operationState.test.ts`;
 * - the Author Identities feature's real-Git effects: applying an identity through the config
 *   write ops is what future commits record (the config-cache half from
 *   `tests/commitAuthors.test.mjs`; the decision functions are unit tested in
 *   `src/extension/graphView/globalSettings.test.ts` and the setting getter in
 *   `src/extension/platform/config.test.ts`).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// The author-identity half imports the global-settings decisions, whose module (legally) imports
// 'vscode' for its save flow; the mock stands in for that surface only.
vi.mock('vscode', () => ({
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ViewColumn: { One: 1 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	window: { showInformationMessage: async () => undefined, showErrorMessage: async () => undefined },
	workspace: {
		getConfiguration: () => ({ get: (_k: string, d: unknown) => d, inspect: () => undefined, update: async () => { } }),
		onDidChangeConfiguration: () => ({ dispose: () => { } })
	}
}));

/** A repository with one base commit; `stage()` stages new content for the commit ops. */
function fixupRepo(): { repo: RepoBuilder; target: string; stage: (content: string) => void } {
	const repo = RepoBuilder.create('gg-fixup');
	repo.write('file.txt', 'base\n');
	const target = repo.commit('add the base feature');
	return {
		repo: repo,
		target: target,
		stage: (content: string) => {
			repo.write('file.txt', content);
			repo.git(['add', 'file.txt']);
		}
	};
}

describe('createFixupCommit / createSquashCommit', () => {
	const { ctx } = writeHarness();
	const { repo, target, stage } = fixupRepo();

	beforeAll(() => {
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repo.path;
	});

	afterAll(() => {
		repo.dispose();
	});

	it('createFixupCommit commits the staged changes with a fixup! subject Git derives itself', async () => {
		stage('base\nfixup content\n');

		expect(await createFixupCommit(ctx, repo.path, target)).toBeNull();

		const subject = repo.git(['log', '-1', '--format=%s']).trim();
		expect(subject).toBe('fixup! add the base feature');
		expect(repo.git(['status', '--porcelain'])).toBe('');
	});

	it('createSquashCommit commits the staged changes with a squash! subject Git derives itself', async () => {
		stage('base\nsquash content\n');
		// An editor must never be needed (--no-edit): prove it with a core.editor that would fail
		repo.config('core.editor', 'gg-test-editor-must-not-run');

		expect(await createSquashCommit(ctx, repo.path, target)).toBeNull();

		repo.git(['config', '--unset', 'core.editor']);
		const subject = repo.git(['log', '-1', '--format=%s']).trim();
		expect(subject).toBe('squash! add the base feature');
		expect(repo.git(['status', '--porcelain'])).toBe('');
	});

	it('rejects a target hash that looks like a command-line flag, instead of passing it to git', async () => {
		stage('must not be committed\n');

		const error = await createFixupCommit(ctx, repo.path, '--upload-pack=evil');
		expect(error).toMatch(/commitHash/);

		repo.git(['reset', '--hard']); // undo the stage() above so it doesn't leak into later tests
	});

	it('reports an error (rather than throwing) when there is nothing staged to commit', async () => {
		expect(repo.git(['status', '--porcelain'])).toBe('');
		const error = await createFixupCommit(ctx, repo.path, target);
		expect(error).not.toBeNull();
	});
});

describe('rebase --autosquash folds fixup!/squash! commits into their targets', () => {
	const { ctx } = writeHarness();
	const repo = RepoBuilder.create('gg-autosquash');

	beforeAll(() => {
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repo.path;
		repo.commit('root', { allowEmpty: true });
	});

	afterAll(() => {
		repo.dispose();
	});

	it('a fixup! commit created via createFixupCommit is folded into its target and disappears as its own commit', async () => {
		const root = repo.revParse('HEAD');

		repo.write('file.txt', 'base feature\n');
		repo.git(['add', 'file.txt']);
		repo.commit('add the base feature');
		const target = repo.revParse('HEAD');

		repo.write('file.txt', 'base feature\nfixup content\n');
		repo.git(['add', 'file.txt']);
		expect(await createFixupCommit(ctx, repo.path, target)).toBeNull();
		expect(repo.git(['rev-list', '--count', `${root}..HEAD`]).trim()).toBe('2');

		// The interactive-rebase dialog's "Automatically Squash Commits" checkbox appends
		// --autosquash to `git rebase -i`; driven headless here exactly as the terminal handoff
		// would (the sequence editor is `true`, so git's own todo stands).
		const env = { ...process.env, GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' };
		execFileSync('git', ['rebase', '-i', '--autosquash', root], { cwd: repo.path, encoding: 'utf8', env });

		expect(repo.git(['rev-list', '--count', `${root}..HEAD`]).trim()).toBe('1');
		expect(repo.git(['log', '-1', '--format=%s']).trim()).toBe('add the base feature');
	});
});

describe('getOperationState / continueOperation / abortOperation', () => {
	const harness = writeHarness();
	const repo = RepoBuilder.create('gg-opstate');
	const writeAndCommit = (content: string, message: string) => {
		repo.write('file.txt', content);
		repo.commit(message);
	};

	beforeAll(() => {
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = repo.path;
		// The continue/abort flows spawn git through the product's own write layer, whose
		// environment inherits this process: an editor opening there hangs the run (the
		// first CI run died exactly that way - vi on the ubuntu leg, notepad on windows).
		process.env.GIT_EDITOR = ':';
		process.env.GIT_SEQUENCE_EDITOR = ':';
		writeAndCommit('line1\n', 'base');
	});

	afterAll(() => {
		repo.dispose();
	});

/** Run git expecting a failure, asserting its combined output matches (conflicts land on either stream). */
	function expectGitConflicts(args: ReadonlyArray<string>): void {
		try {
			repo.git([...args]);
		} catch (error) {
			const thrown = error as { stdout?: string, stderr?: string, message?: string };
			expect((thrown.stdout ?? '') + (thrown.stderr ?? '') + (thrown.message ?? '')).toMatch(/conflict/i);
			return;
		}
		throw new Error('expected the git call to conflict: ' + args.join(' '));
	}

	it('reports no operation in progress in a clean repository', async () => {
		expect(await harness.ctx.repo.getOperationState(repo.path)).toEqual({ type: null, conflictedFiles: [], progress: null });
	});

	it('detects a merge conflict and lists the conflicted file, then abortOperation clears it', async () => {
		repo.git(['checkout', '-q', '-b', 'merge-conflict-branch']);
		writeAndCommit('line1\nbranch-change\n', 'branch change');
		repo.checkout('main');
		writeAndCommit('line1\nmain-change\n', 'main change');

		expectGitConflicts(['merge', 'merge-conflict-branch']);

		const duringMerge = await harness.ctx.repo.getOperationState(repo.path);
		expect(duringMerge.type).toBe('merge');
		expect(duringMerge.conflictedFiles).toEqual(['file.txt']);
		expect(duringMerge.progress).toBeNull();

		expect(await abortOperation(harness.ctx, repo.path, GitOperationType.Merge)).toBeNull();
		expect(await harness.ctx.repo.getOperationState(repo.path)).toEqual({ type: null, conflictedFiles: [], progress: null });

		repo.git(['branch', '-D', 'merge-conflict-branch']);
	});

	it('detects a rebase conflict with step/total progress, and continueOperation completes it once resolved', async () => {
		repo.git(['checkout', '-q', '-b', 'rebase-conflict-branch']);
		writeAndCommit('line1\nbranch-change\n', 'branch change for rebase');
		repo.checkout('main');
		writeAndCommit('line1\nmain-change-2\n', 'main change 2');

		expectGitConflicts(['rebase', 'main', 'rebase-conflict-branch']);

		const duringRebase = await harness.ctx.repo.getOperationState(repo.path);
		expect(duringRebase.type).toBe('rebase');
		expect(duringRebase.conflictedFiles).toEqual(['file.txt']);
		expect(duringRebase.progress).not.toBeNull();
		expect(duringRebase.progress?.step).toBe(1);
		expect(duringRebase.progress?.total).toBe(1);

		// Resolve the conflict exactly as the Conflict Banner instructs: stage the resolved file, continue.
		repo.write('file.txt', 'line1\nresolved\n');
		repo.git(['add', 'file.txt']);

		expect(await continueOperation(harness.ctx, repo.path, GitOperationType.Rebase)).toBeNull();
		expect(await harness.ctx.repo.getOperationState(repo.path)).toEqual({ type: null, conflictedFiles: [], progress: null });

		repo.checkout('main');
		repo.git(['branch', '-D', 'rebase-conflict-branch']);
	});

	it('detects a cherry-pick conflict', async () => {
		repo.git(['checkout', '-q', '-b', 'cherry-pick-source']);
		writeAndCommit('line1\ncherry-change\n', 'change to cherry-pick');
		const cherryHash = repo.revParse('HEAD');
		repo.checkout('main');
		writeAndCommit('line1\nmain-change-3\n', 'main change 3');

		expectGitConflicts(['cherry-pick', cherryHash]);

		const duringCherryPick = await harness.ctx.repo.getOperationState(repo.path);
		expect(duringCherryPick.type).toBe('cherry-pick');
		expect(duringCherryPick.conflictedFiles).toEqual(['file.txt']);

		expect(await abortOperation(harness.ctx, repo.path, GitOperationType.CherryPick)).toBeNull();
		expect(await harness.ctx.repo.getOperationState(repo.path)).toEqual({ type: null, conflictedFiles: [], progress: null });

		repo.git(['branch', '-D', 'cherry-pick-source']);
	});
});

describe('the Author Identities feature against real repositories', () => {
	const { ctx } = writeHarness();
	const AUTHOR_A = { name: 'Alice', email: 'alice@example.com' };
	const AUTHOR_B = { name: 'Bob', email: 'bob@example.com' };
	const GLOBAL_IDENTITY = { name: 'The Global One', email: 'global@example.com' };

	/** A directory standing in for the user's HOME, so `--global` writes touch nothing real. */
	let globalConfigDir: string;
	let repo: RepoBuilder;

	const globalConfigValue = (key: string): string | null => {
		try {
			return execFileSync('git', ['config', '--global', '--get', key], { cwd: repo.path, encoding: 'utf8', env: { ...process.env, HOME: globalConfigDir } }).trim();
		} catch {
			return null;
		}
	};
	const localConfigValue = (key: string): string | null => {
		try {
			return repo.git(['config', '--local', '--get', key]).trim();
		} catch {
			return null;
		}
	};
	const lastCommitAuthor = () => gitGlobal(['log', '-1', '--format=%an <%ae>']).trim();
	/** Git with the controlled global-config HOME (what the flow's own spawns see). */
	const gitGlobal = (args: ReadonlyArray<string>, cwd: string = repo.path) =>
		execFileSync('git', [...args], { cwd: cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: globalConfigDir } }).trim();
	const setGlobal = (key: GitConfigKey, value: string) => ctx.repo.write.run(repo.path, setConfigValue({ key: key, value: value, location: GitConfigLocation.Global }));
	const setLocal = (key: GitConfigKey, value: string) => ctx.repo.write.run(repo.path, setConfigValue({ key: key, value: value, location: GitConfigLocation.Local }));
	const unsetLocal = (key: GitConfigKey) => ctx.repo.write.run(repo.path, unsetConfigValue({ key: key, location: GitConfigLocation.Local }));

	beforeAll(() => {
		globalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-authors-home-'));
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.HOME = globalConfigDir;

		repo = RepoBuilder.create('gg-authors');
		repo.commit('the base commit', { allowEmpty: true });
	});

	afterAll(() => {
		repo.dispose();
		fs.rmSync(globalConfigDir, { recursive: true, force: true });
	});

	it('reads the global identity of the global Git configuration (NULL when unset)', async () => {
		expect(await ctx.repo.read.getGlobalUserDetails(repo.path)).toEqual({ name: null, email: null });

		execFileSync('git', ['config', '--global', GitConfigKey.UserName, GLOBAL_IDENTITY.name], { cwd: repo.path, env: { ...process.env, HOME: globalConfigDir } });
		execFileSync('git', ['config', '--global', GitConfigKey.UserEmail, GLOBAL_IDENTITY.email], { cwd: repo.path, env: { ...process.env, HOME: globalConfigDir } });
		expect(await ctx.repo.read.getGlobalUserDetails(repo.path)).toEqual({ name: GLOBAL_IDENTITY.name, email: GLOBAL_IDENTITY.email });
	});

	it('applying an author to a repository (the switch click) is what future commits use', async () => {
		expect(await setLocal(GitConfigKey.UserName, AUTHOR_A.name)).toBeNull();
		expect(await setLocal(GitConfigKey.UserEmail, AUTHOR_A.email)).toBeNull();

		expect(localConfigValue(GitConfigKey.UserName)).toBe(AUTHOR_A.name);
		expect(localConfigValue(GitConfigKey.UserEmail)).toBe(AUTHOR_A.email);

		repo.write('a.txt', 'by the applied author\n');
		repo.git(['add', '-A']);
		repo.git(['commit', '--quiet', '-m', 'with the local identity']);
		expect(lastCommitAuthor()).toBe(AUTHOR_A.name + ' <' + AUTHOR_A.email + '>');
	});

	it('"Use Global Author" removes only the local override, so commits follow the global identity again', async () => {
		expect(await unsetLocal(GitConfigKey.UserName)).toBeNull();
		expect(await unsetLocal(GitConfigKey.UserEmail)).toBeNull();

		expect(localConfigValue(GitConfigKey.UserName)).toBeNull();
		expect(localConfigValue(GitConfigKey.UserEmail)).toBeNull();
		expect(globalConfigValue(GitConfigKey.UserName)).toBe(GLOBAL_IDENTITY.name);

		repo.write('b.txt', 'back on the global identity\n');
		gitGlobal(['add', '-A']);
		gitGlobal(['commit', '--quiet', '-m', 'with the global identity']);
		expect(lastCommitAuthor()).toBe(GLOBAL_IDENTITY.name + ' <' + GLOBAL_IDENTITY.email + '>');
	});

	it('materialising the default global author is what identity-less repositories commit with', async () => {
		// The host's save pipeline: [Alice, Bob] saved while the global configuration holds no
		// matching identity -> Alice becomes the global author
		execFileSync('git', ['config', '--global', '--unset-all', GitConfigKey.UserName], { cwd: repo.path, env: { ...process.env, HOME: globalConfigDir } });
		execFileSync('git', ['config', '--global', '--unset-all', GitConfigKey.UserEmail], { cwd: repo.path, env: { ...process.env, HOME: globalConfigDir } });

		const globalUser = await ctx.repo.read.getGlobalUserDetails(repo.path);
		const author = resolveGlobalAuthorAfterSave([AUTHOR_A, AUTHOR_B], { name: globalUser.name, email: globalUser.email });
		expect(author).toEqual(AUTHOR_A);
		expect(await setGlobal(GitConfigKey.UserName, author!.name)).toBeNull();
		expect(await setGlobal(GitConfigKey.UserEmail, author!.email)).toBeNull();

		expect(globalConfigValue(GitConfigKey.UserName)).toBe(AUTHOR_A.name);
		// An identity-less repository (no local override anywhere) commits with the new global author
		const identityLess = RepoBuilder.create('gg-authors-follow');
		try {
			execFileSync('git', ['config', '--local', '--unset-all', GitConfigKey.UserName], { cwd: identityLess.path });
			execFileSync('git', ['config', '--local', '--unset-all', GitConfigKey.UserEmail], { cwd: identityLess.path });
			identityLess.write('c.txt', 'no identity anywhere\n');
			gitGlobal(['add', '-A'], identityLess.path);
			gitGlobal(['commit', '--quiet', '-m', 'No identity anywhere'], identityLess.path);
			expect(gitGlobal(['log', '-1', '--format=%an <%ae>'], identityLess.path)).toBe(AUTHOR_A.name + ' <' + AUTHOR_A.email + '>');
		} finally {
			identityLess.dispose();
		}
	});

	it('deleting the global author from the list falls back to the new first identity', async () => {
		execFileSync('git', ['config', '--global', GitConfigKey.UserName, AUTHOR_A.name], { cwd: repo.path, env: { ...process.env, HOME: globalConfigDir } });
		execFileSync('git', ['config', '--global', GitConfigKey.UserEmail, AUTHOR_A.email], { cwd: repo.path, env: { ...process.env, HOME: globalConfigDir } });

		// Alice was the global author, then the user deleted her from the list
		const globalUser = await ctx.repo.read.getGlobalUserDetails(repo.path);
		const author = resolveGlobalAuthorAfterSave([AUTHOR_B], { name: globalUser.name, email: globalUser.email });
		expect(author).toEqual(AUTHOR_B);
		expect(await setGlobal(GitConfigKey.UserName, author!.name)).toBeNull();
		expect(await setGlobal(GitConfigKey.UserEmail, author!.email)).toBeNull();
		expect(globalConfigValue(GitConfigKey.UserName)).toBe(AUTHOR_B.name);
	});
});

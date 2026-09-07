/**
 * The `git-graph-rs.commitAuthors` Extension Setting: the author identities a repository can
 * switch between in the Settings widget. Three layers are covered:
 *
 * 1. The unit seams — the Config getter that reads the setting into the view (src/config.ts)
 *    and the validator guarding writes made from the webview (isCommitAuthors).
 * 2. resolveGlobalAuthorAfterSave — the decision of which identity the global Git
 *    configuration should hold after the list is saved (the "first author is the global
 *    author by default" rule).
 * 3. Real-repository end-to-end runs against the compiled DataSource: everything the Settings
 *    widget renders and every action it performs goes through these exact methods, so these
 *    tests pin the property the UI depends on — what the widget displays is what Git really
 *    holds, and what a click writes is what future commits use.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The stand-in for the extension host: only what config.ts, gitGraphView.ts and dataSource.ts
   read at import time; the `commitAuthors` setting value is swapped per test. */
let commitAuthorsSetting;
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined
	},
	workspace: {
		getConfiguration: () => ({
			get: (section, defaultValue) => section === 'commitAuthors' ? commitAuthorsSetting : defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

/*
 * Isolate the "global" Git configuration of the end-to-end tests from the developer's machine:
 * GIT_CONFIG_GLOBAL redirects every `git config --global` — both the ones these tests run and
 * the ones the DataSource spawns — to a throwaway file.
 */
const globalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-authors-global-'));
const globalConfigFile = path.join(globalConfigDir, 'gitconfig');
const resetGlobalConfig = () => fs.writeFileSync(globalConfigFile, '[commit]\n\tgpgsign = false\n');
resetGlobalConfig();
process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { getConfig } = await import('../out/config.js');
const { isCommitAuthors, resolveGlobalAuthorAfterSave } = await import('../out/gitGraphView.js');
const { DataSource } = await import('../out/dataSource.js');

/* The local Git config keys of the user identity (the values of dataSource's GitConfigKey). */
const USER_NAME = 'user.name';
const USER_EMAIL = 'user.email';

/** A repository directory created under a throwaway root, optionally with a local identity. */
function initRepo(name, identity = null) {
	const directory = path.join(repoRoot, name);
	fs.mkdirSync(directory, { recursive: true });
	git(directory, ['init', '--quiet', '--initial-branch=main']);
	if (identity !== null) {
		git(directory, ['config', USER_NAME, identity.name]);
		git(directory, ['config', USER_EMAIL, identity.email]);
	}
	repos.push(directory);
	return directory;
}

const repos = [];

const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });

/** Commit one file; the caller ensures SOME identity exists (local or global) by then. */
function commitFile(directory, name) {
	fs.writeFileSync(path.join(directory, name), name + '\n');
	git(directory, ['add', '-A']);
	git(directory, ['commit', '--quiet', '-m', 'Add ' + name]);
}

/** The `Name <email>` author of the last commit — what a real commit actually records. */
const lastCommitAuthor = (directory) => git(directory, ['log', '-1', '--format=%an <%ae>']).trim();

/** Read a LOCAL config key (NULL => not set), the way the widget's config read presents it. */
function localConfigValue(directory, key) {
	try {
		return git(directory, ['config', '--local', '--get', key]).trim();
	} catch {
		return null;
	}
}

/** Read the ISOLATED global config key (NULL => not set). */
function globalConfigValue(key) {
	try {
		return execFileSync('git', ['config', '--global', '--get', key], { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

function makeDataSource() {
	const dataSource = new DataSource(
		{ path: 'git', version: '2.45.0' },
		() => ({ dispose() {} }),
		() => ({ dispose() {} }),
		{ log() {}, logCmd() {} }
	);
	// The constructor starts the askpass server (and engine repository handles); disposing is
	// what lets the test process exit once every assertion has run
	dataSources.push(dataSource);
	return dataSource;
}

const dataSources = [];

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-authors-repos-'));
const GLOBAL_IDENTITY = { name: 'Global Person', email: 'global@example.com' };
const AUTHOR_A = { name: 'Alice Work', email: 'alice@corp.example' };
const AUTHOR_B = { name: 'Bob Oss', email: 'bob@example.com' };
const AUTHOR_C = { name: 'Carol', email: 'carol@example.com' };

after(() => {
	for (const repo of repos) {
		for (const dataSource of dataSources) dataSource.closeRepository(repo);
	}
	for (const dataSource of dataSources) dataSource.dispose();
	fs.rmSync(repoRoot, { recursive: true, force: true });
	fs.rmSync(globalConfigDir, { recursive: true, force: true });
});


describe('Config.commitAuthors', () => {
	it('returns the configured author identities', () => {
		commitAuthorsSetting = [{ name: 'Alice (Work)', email: 'alice@corp.example' }, { name: 'alice-oss', email: 'alice@example.com' }];
		assert.deepEqual(getConfig().commitAuthors, [
			{ name: 'Alice (Work)', email: 'alice@corp.example' },
			{ name: 'alice-oss', email: 'alice@example.com' }
		]);
	});

	it('returns an empty array when the setting is not an array', () => {
		commitAuthorsSetting = 'not an array';
		assert.deepEqual(getConfig().commitAuthors, []);
		commitAuthorsSetting = undefined;
		assert.deepEqual(getConfig().commitAuthors, []);
	});

	it('drops entries whose name or email is missing, not a string, or blank', () => {
		commitAuthorsSetting = [
			{ name: 'Alice', email: 'alice@example.com' },
			{ name: '', email: 'empty-name@example.com' },
			{ name: '   ', email: 'blank-name@example.com' },
			{ email: 'missing-name@example.com' },
			{ name: 'Missing Email' },
			{ name: 42, email: 'number-name@example.com' },
			{ name: 'Null Email', email: null },
			'A plain string entry',
			null
		];
		assert.deepEqual(getConfig().commitAuthors, [{ name: 'Alice', email: 'alice@example.com' }]);
	});
});

describe('isCommitAuthors', () => {
	it('accepts an array of author identities with non-empty names and emails', () => {
		assert.equal(isCommitAuthors([{ name: 'Alice', email: 'alice@example.com' }]), true);
		assert.equal(isCommitAuthors([{ name: 'Bob', email: 'bob@example.com' }, { name: 'Carol', email: 'carol@example.com' }]), true);
	});

	it('accepts an empty array', () => {
		assert.equal(isCommitAuthors([]), true);
	});

	it('rejects entries with an empty or whitespace-only name or email', () => {
		assert.equal(isCommitAuthors([{ name: '', email: 'alice@example.com' }]), false);
		assert.equal(isCommitAuthors([{ name: '   ', email: 'alice@example.com' }]), false);
		assert.equal(isCommitAuthors([{ name: 'Alice', email: '' }]), false);
		assert.equal(isCommitAuthors([{ name: 'Alice', email: ' \t ' }]), false);
	});

	it('rejects entries that are not name/email objects', () => {
		assert.equal(isCommitAuthors([{ name: 'Alice' }]), false);
		assert.equal(isCommitAuthors([{ email: 'alice@example.com' }]), false);
		assert.equal(isCommitAuthors([{ name: 'Alice', email: 'alice@example.com' }, null]), false);
		assert.equal(isCommitAuthors([{ name: 'Alice', email: 'alice@example.com' }, 'Alice <alice@example.com>']), false);
		assert.equal(isCommitAuthors([{ name: 42, email: 'alice@example.com' }]), false);
	});

	it('rejects arrays of more than 50 identities', () => {
		const authors = Array.from({ length: 51 }, (_, i) => ({ name: 'Author ' + i, email: 'author' + i + '@example.com' }));
		assert.equal(isCommitAuthors(authors), false);
		assert.equal(isCommitAuthors(authors.slice(0, 50)), true);
	});

	it('rejects values that are not arrays', () => {
		assert.equal(isCommitAuthors(null), false);
		assert.equal(isCommitAuthors(undefined), false);
		assert.equal(isCommitAuthors({ 0: { name: 'Alice', email: 'alice@example.com' }, length: 1 }), false);
		assert.equal(isCommitAuthors('Alice <alice@example.com>'), false);
	});
});

describe('resolveGlobalAuthorAfterSave', () => {
	it('writes nothing when the global configuration already matches an identity of the list', () => {
		assert.equal(resolveGlobalAuthorAfterSave([AUTHOR_A, AUTHOR_B], { name: AUTHOR_B.name, email: AUTHOR_B.email }), null);
	});

	it('defaults the global author to the FIRST identity when nothing matches', () => {
		assert.equal(resolveGlobalAuthorAfterSave([AUTHOR_A, AUTHOR_B], { name: 'Someone Else', email: 'other@example.com' }), AUTHOR_A);
	});

	it('defaults the global author to the first identity when the global configuration has no identity', () => {
		assert.equal(resolveGlobalAuthorAfterSave([AUTHOR_A, AUTHOR_B], { name: null, email: null }), AUTHOR_A);
	});

	it('defaults the global author to the first identity when the global identity is only partial', () => {
		assert.equal(resolveGlobalAuthorAfterSave([AUTHOR_A], { name: AUTHOR_A.name, email: null }), AUTHOR_A);
	});

	it('writes nothing for an empty identity list', () => {
		assert.equal(resolveGlobalAuthorAfterSave([], { name: null, email: null }), null);
	});
});

describe('the Author Identities feature against real repositories', () => {
	it('renders exactly the identities Git really holds', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('display', AUTHOR_A);
		git(repo, ['config', '--global', USER_NAME, GLOBAL_IDENTITY.name]);
		git(repo, ['config', '--global', USER_EMAIL, GLOBAL_IDENTITY.email]);

		const config = (await dataSource.getConfig(repo, [])).config;
		assert.equal(config.user.name.local, AUTHOR_A.name);
		assert.equal(config.user.email.local, AUTHOR_A.email);
		assert.equal(config.user.name.global, GLOBAL_IDENTITY.name);
		assert.equal(config.user.email.global, GLOBAL_IDENTITY.email);

		// The identity changing on disk (as any write does) is what the widget must re-read:
		// the cached read stays at the old value, the invalidated read matches Git again — the
		// reason the action handlers invalidate the cache explicitly
		git(repo, ['config', USER_NAME, AUTHOR_B.name]);
		git(repo, ['config', USER_EMAIL, AUTHOR_B.email]);
		assert.equal((await dataSource.getConfig(repo, [])).config.user.name.local, AUTHOR_A.name, 'the cached read predates the change');
		dataSource.invalidateConfigCache(repo);
		assert.equal((await dataSource.getConfig(repo, [])).config.user.name.local, AUTHOR_B.name);
		assert.equal((await dataSource.getConfig(repo, [])).config.user.email.local, AUTHOR_B.email);
	});

	it('reads the global identity of the global Git configuration (NULL when unset)', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('global-read', AUTHOR_A);

		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: null, email: null });

		git(repo, ['config', '--global', USER_NAME, GLOBAL_IDENTITY.name]);
		git(repo, ['config', '--global', USER_EMAIL, GLOBAL_IDENTITY.email]);
		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: GLOBAL_IDENTITY.name, email: GLOBAL_IDENTITY.email });
	});

	it('applying an author to a repository (the switch click) is what future commits use', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('apply-local', GLOBAL_IDENTITY);

		assert.equal(await dataSource.setConfigValue(repo, USER_NAME, AUTHOR_A.name, 'local'), null);
		assert.equal(await dataSource.setConfigValue(repo, USER_EMAIL, AUTHOR_A.email, 'local'), null);

		// What Git really holds after the click ...
		assert.equal(localConfigValue(repo, USER_NAME), AUTHOR_A.name);
		assert.equal(localConfigValue(repo, USER_EMAIL), AUTHOR_A.email);
		// ... is what the widget renders ...
		dataSource.invalidateConfigCache(repo);
		const config = (await dataSource.getConfig(repo, [])).config;
		assert.equal(config.user.name.local, AUTHOR_A.name);
		assert.equal(config.user.email.local, AUTHOR_A.email);
		// ... and what the next commit records
		commitFile(repo, 'a.txt');
		assert.equal(lastCommitAuthor(repo), AUTHOR_A.name + ' <' + AUTHOR_A.email + '>');
	});

	it('"Use Global Author" removes only the local override, so commits follow the global identity again', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('use-global', AUTHOR_A);
		git(repo, ['config', '--global', USER_NAME, GLOBAL_IDENTITY.name]);
		git(repo, ['config', '--global', USER_EMAIL, GLOBAL_IDENTITY.email]);

		assert.equal(await dataSource.unsetConfigValue(repo, USER_NAME, 'local'), null);
		assert.equal(await dataSource.unsetConfigValue(repo, USER_EMAIL, 'local'), null);

		assert.equal(localConfigValue(repo, USER_NAME), null);
		assert.equal(localConfigValue(repo, USER_EMAIL), null);
		assert.equal(globalConfigValue(USER_NAME), GLOBAL_IDENTITY.name);
		assert.equal(globalConfigValue(USER_EMAIL), GLOBAL_IDENTITY.email);

		commitFile(repo, 'b.txt');
		assert.equal(lastCommitAuthor(repo), GLOBAL_IDENTITY.name + ' <' + GLOBAL_IDENTITY.email + '>');
	});

	it('materialising the default global author is what identity-less repositories commit with', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('materialise', AUTHOR_A);
		const identityLessRepo = initRepo('materialise-follow', null);

		// The host's save pipeline: [Alice, Bob] saved while the global configuration holds no
		// matching identity -> Alice becomes the global author
		const globalUser = await dataSource.getGlobalUserDetails(repo);
		const author = resolveGlobalAuthorAfterSave([AUTHOR_A, AUTHOR_B], globalUser);
		assert.equal(author, AUTHOR_A);
		assert.equal(await dataSource.setConfigValue(repo, USER_NAME, author.name, 'global'), null);
		assert.equal(await dataSource.setConfigValue(repo, USER_EMAIL, author.email, 'global'), null);

		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: AUTHOR_A.name, email: AUTHOR_A.email });
		assert.equal(globalConfigValue(USER_NAME), AUTHOR_A.name);
		assert.equal(globalConfigValue(USER_EMAIL), AUTHOR_A.email);

		commitFile(identityLessRepo, 'c.txt');
		assert.equal(lastCommitAuthor(identityLessRepo), AUTHOR_A.name + ' <' + AUTHOR_A.email + '>');
	});

	it('seeding an empty list from the global identity never rewrites the global configuration', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('seed', AUTHOR_A);
		git(repo, ['config', '--global', USER_NAME, GLOBAL_IDENTITY.name]);
		git(repo, ['config', '--global', USER_EMAIL, GLOBAL_IDENTITY.email]);

		// The widget seeds exactly the identity getGlobalUserDetails read ...
		const globalUser = await dataSource.getGlobalUserDetails(repo);
		const seeded = [{ name: globalUser.name, email: globalUser.email }];
		// ... so the save pipeline that follows finds it already configured and writes nothing
		assert.equal(resolveGlobalAuthorAfterSave(seeded, await dataSource.getGlobalUserDetails(repo)), null);
		assert.equal(globalConfigValue(USER_NAME), GLOBAL_IDENTITY.name);
		assert.equal(globalConfigValue(USER_EMAIL), GLOBAL_IDENTITY.email);
	});

	it('deleting the global author from the list falls back to the new first identity', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('fallback', AUTHOR_A);

		// Alice was the global author, then the user deleted her from the list
		git(repo, ['config', '--global', USER_NAME, AUTHOR_A.name]);
		git(repo, ['config', '--global', USER_EMAIL, AUTHOR_A.email]);
		const author = resolveGlobalAuthorAfterSave([AUTHOR_B, AUTHOR_C], await dataSource.getGlobalUserDetails(repo));
		assert.equal(author, AUTHOR_B);
		assert.equal(await dataSource.setConfigValue(repo, USER_NAME, author.name, 'global'), null);
		assert.equal(await dataSource.setConfigValue(repo, USER_EMAIL, author.email, 'global'), null);
		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: AUTHOR_B.name, email: AUTHOR_B.email });
	});

	it('emptying the identity list clears the global author from the global Git configuration', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('clear-global', AUTHOR_A);

		// Alice was the global author, then the user deleted every identity from the list
		git(repo, ['config', '--global', USER_NAME, AUTHOR_A.name]);
		git(repo, ['config', '--global', USER_EMAIL, AUTHOR_A.email]);

		// The host's save pipeline for an empty list: the global author is cleared
		assert.equal(await dataSource.unsetConfigValue(repo, USER_NAME, 'global'), null);
		assert.equal(await dataSource.unsetConfigValue(repo, USER_EMAIL, 'global'), null);

		// Git really holds no global identity anymore, so nothing lingers for identity-less
		// repositories to commit with
		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: null, email: null });
		assert.equal(globalConfigValue(USER_NAME), null);
		assert.equal(globalConfigValue(USER_EMAIL), null);
	});

	it('deleting identities one by one promotes the first survivor until the LAST deletion clears the global author', async () => {
		resetGlobalConfig();
		const dataSource = makeDataSource();
		const repo = initRepo('stepwise', AUTHOR_A);

		// [Alice, Bob, Carol] with Alice the global author
		git(repo, ['config', '--global', USER_NAME, AUTHOR_A.name]);
		git(repo, ['config', '--global', USER_EMAIL, AUTHOR_A.email]);

		// The host's save pipeline for a non-empty list: promote the first identity the global
		// configuration no longer matches (NULL => the match survived, write nothing)
		const saveList = async (remaining) => {
			const author = resolveGlobalAuthorAfterSave(remaining, await dataSource.getGlobalUserDetails(repo));
			if (author !== null) {
				assert.equal(await dataSource.setConfigValue(repo, USER_NAME, author.name, 'global'), null);
				assert.equal(await dataSource.setConfigValue(repo, USER_EMAIL, author.email, 'global'), null);
			}
			return author;
		};

		// Deleting Alice (the global author): Bob - the first of the remaining - is promoted
		assert.equal(await saveList([AUTHOR_B, AUTHOR_C]), AUTHOR_B);
		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: AUTHOR_B.name, email: AUTHOR_B.email });

		// Deleting Bob: Carol is promoted - a global author exists for as long as the list does
		assert.equal(await saveList([AUTHOR_C]), AUTHOR_C);
		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: AUTHOR_C.name, email: AUTHOR_C.email });

		// Deleting Carol empties the list: the global author is cleared, not left at Carol
		assert.equal(await dataSource.unsetConfigValue(repo, USER_NAME, 'global'), null);
		assert.equal(await dataSource.unsetConfigValue(repo, USER_EMAIL, 'global'), null);
		assert.deepEqual(await dataSource.getGlobalUserDetails(repo), { name: null, email: null });
		assert.equal(globalConfigValue(USER_NAME), null);
		assert.equal(globalConfigValue(USER_EMAIL), null);
	});
});

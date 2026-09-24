/**
 * The engine's single dispatch seam (`request`), loaded the way a second host would load it:
 * the compiled `.node` binary required directly, no extension code in between. One JSON call
 * must answer what the typed exports answer, and failures must ride in-band with the same
 * `Kind:` prefixes the backend layer parses — that is the contract `git_graph_core::dispatch`
 * and `native/node`'s `request` export share.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/** The platform directories the build script stages the addon to (`scripts/build-addon.mjs`). */
const DIRECTORIES = {
	'win32-x64': 'win32-x64-msvc',
	'win32-arm64': 'win32-arm64-msvc',
	'linux-x64': 'linux-x64-gnu',
	'linux-arm64': 'linux-arm64-gnu',
	'darwin-x64': 'darwin-x64',
	'darwin-arm64': 'darwin-arm64'
};

const directory = DIRECTORIES[`${process.platform}-${process.arch}`];
const binary = directory ? path.join(root, 'native', directory, 'git-graph.node') : null;

/** One dispatch request as the wire sees it. The export is async, like every engine read. */
async function ask(addon, repo, method, params) {
	const raw = await addon.request(repo, JSON.stringify({ method, params }));
	return JSON.parse(raw);
}

describe('the single dispatch seam of the native addon', { skip: !binary || !fs.existsSync(binary) }, () => {
	let repoPath;
	let addon;
	let clock = 1_600_000_000;
	let first;
	let second;

	function git(args, date) {
		return execFileSync('git', args, {
			cwd: repoPath,
			encoding: 'utf8',
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: '1',
				HOME: repoPath,
				GIT_TERMINAL_PROMPT: '0',
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date
			}
		});
	}

	function commit(message) {
		clock += 60;
		git(['add', '-A']);
		git(['commit', '--quiet', '--allow-empty', '-m', message], `${clock} +0000`);
		return git(['rev-parse', 'HEAD']).trim();
	}

	before(() => {
		repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-dispatch-'));
		git(['init', '--quiet', '--initial-branch=main']);
		git(['config', 'user.name', 'Test User']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'commit.gpgsign', 'false']);
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\n', 'utf8');
		first = commit('first commit');
		git(['tag', 'v1']);
		fs.writeFileSync(path.join(repoPath, 'a.txt'), 'one\ntwo\n', 'utf8');
		second = commit('second commit');
		fs.writeFileSync(path.join(repoPath, 'b.txt'), 'uncommitted\n', 'utf8');
		addon = require(binary);
	});

	after(() => {
		try {
			addon.closeAllRepositories();
		} catch {
			// The checks below do not depend on the teardown succeeding.
		}
		fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('answers engineVersion the typed export answers', async () => {
		assert.equal((await ask(addon, repoPath, 'engineVersion')).valueOf(), addon.engineVersion());
	});

	it('answers the graph page the typed export answers', async () => {
		const options = JSON.stringify({ maxCommits: 300 });
		const typed = JSON.parse(await addon.loadCommits(repoPath, options));
		const single = await ask(addon, repoPath, 'loadCommits', { maxCommits: 300 });
		assert.deepEqual(single, typed);
		assert.deepEqual(
			single.commits.map((entry) => entry.hash),
			[second, first]
		);
	});

	it('opens the repository and answers its root', async () => {
		const answer = await ask(addon, repoPath, 'open');
		const normalize = (value) => path.normalize(value).replace(/\\/g, '/').toLowerCase();
		assert.equal(normalize(answer.root), normalize(repoPath));
	});

	it('carries the working tree in the count the typed export gives', async () => {
		const single = await ask(addon, repoPath, 'countUncommittedChanges', { includeUntracked: true });
		const typed = await addon.countUncommittedChanges(repoPath, true);
		assert.equal(single, 1);
		assert.equal(single, typed);
	});

	it('reads a commit in full: details, subject, file, diff', async () => {
		const details = await ask(addon, repoPath, 'loadCommitDetails', { hash: second });
		assert.equal(details.body, 'second commit');
		assert.equal(details.fileChanges[0].newFilePath, 'a.txt');
		assert.equal(await ask(addon, repoPath, 'loadCommitSubject', { hash: first }), 'first commit');
		const file = await ask(addon, repoPath, 'loadCommitFile', { commitHash: first, file: 'a.txt' });
		assert.equal(file.contents, 'one\n');
		const diff = await ask(addon, repoPath, 'loadCommitFileDiff', { commitHash: second, file: 'a.txt' });
		assert.match(diff, /\+two/);
	});

	it('answers failures in band with the kinds the backend layer parses', async () => {
		assert.match((await ask(addon, repoPath, 'noSuchMethod')).error, /^Unsupported: /);
		assert.match((await ask(addon, repoPath, 'loadCommitDetails', {})).error, /^InvalidArgument: /);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-nowhere-'));
		try {
			assert.match((await ask(addon, outside, 'repoRoot')).error, /^NotARepository: /);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it('drops every handle on closeAll, as the lifecycle methods promise', async () => {
		await ask(addon, repoPath, 'openCount');
		assert.ok((await ask(addon, repoPath, 'openCount')) >= 1);
		assert.equal(await ask(addon, repoPath, 'closeAll'), null);
		assert.equal(await ask(addon, repoPath, 'openCount'), 0);
	});
});

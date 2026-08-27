/**
 * The two backends, answering the same questions about the same repository.
 *
 * This is the test that matters most for the rewrite. The `git` CLI backend is a faithful port of
 * how the original extension read a repository, so anywhere the Rust engine disagrees with it, the
 * engine is wrong — and the webview above them cannot tell which one it is talking to, so any
 * disagreement is a user-visible behaviour change.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const { CliBackend, NativeBackend } = await import('../out/backend/index.js');

/* ---------- Fixture ---------- */

let repoPath;
let clock = 1_600_000_000;

function git(args, options = {}) {
	return execFileSync('git', args, {
		cwd: repoPath,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			HOME: repoPath,
			GIT_AUTHOR_DATE: options.date,
			GIT_COMMITTER_DATE: options.date
		}
	});
}

function write(file, contents) {
	const full = path.join(repoPath, file);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents);
}

function commit(message) {
	clock += 60;
	git(['add', '-A']);
	git(['commit', '--quiet', '--allow-empty', '-m', message], { date: `${clock} +0000` });
	return git(['rev-parse', 'HEAD']).trim();
}

/**
 * A repository with the shapes that have historically been where the two implementations drift:
 * a merge, both kinds of tag, a remote-tracking branch, Gerrit change refs, a stash, a rename, and
 * an uncommitted working tree.
 */
function buildFixture() {
	repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-'));
	git(['init', '--quiet', '--initial-branch=main']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'commit.gpgsign', 'false']);
	git(['config', 'remote.pushdefault', 'origin']);
	git(['config', 'diff.tool', 'gitgraph-test-tool']);
	git(['config', 'diff.guitool', 'gitgraph-test-gui']);

	write('a.txt', Array.from({ length: 40 }, (_, n) => `line ${n}\n`).join(''));
	const first = commit('the first commit');
	git(['tag', 'v1.0']);

	git(['checkout', '--quiet', '-b', 'feature']);
	write('feature.txt', 'feature work\n');
	const feature = commit('the feature commit');

	git(['checkout', '--quiet', 'main']);
	write('main.txt', 'main work\n');
	commit('the main commit');
	git(['merge', '--quiet', '--no-ff', '-m', 'merge the feature', 'feature'], {
		date: `${(clock += 60)} +0000`
	});

	git(['mv', 'a.txt', 'renamed.txt']);
	const renamed = commit('rename a file');
	git(['tag', '-a', 'v2.0', '-m', 'an annotated tag']);
	// A hierarchical tag name, which is legal git and must survive the engine's validation.
	git(['tag', 'release/v2.1', renamed]);
	// A tag whose message has paragraphs and trailing blank lines, to pin down how both sides
	// trim it for the Tag Details dialogue.
	write('tag-message.txt', 'line one\n\nline two\n\n\n');
	git(['tag', '-a', 'v3.0', '-F', 'tag-message.txt', renamed]);
	fs.rmSync(path.join(repoPath, 'tag-message.txt'));

	// A binary file, so that the two implementations have to agree about detecting it.
	write('blob.bin', '\u0000\u0001\u0002not text\u0000\u0003');
	const binary = commit('add a binary file');

	// An initialised submodule: a repository below its path, registered in .gitmodules. It is
	// committed (as a gitlink, the way `git submodule add` leaves it), so it disturbs neither the
	// working-tree status nor the graph the other tests compare.
	git(['init', '--quiet', 'sub']);
	git(['-C', 'sub', 'config', 'user.name', 'Sub User']);
	git(['-C', 'sub', 'config', 'user.email', 'sub@example.com']);
	git(['-C', 'sub', 'commit', '--quiet', '--allow-empty', '-m', 'inside the submodule']);
	write('.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = https://example.invalid/sub.git\n');
	git(['add', '.gitmodules', 'sub']);
	commit('add the submodule');

	// A second author with fewer commits, so the author aggregation has something to order.
	clock += 60;
	git(['-c', 'user.name=Second Author', '-c', 'user.email=second@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'a commit by the second author'], { date: `${clock} +0000` });

	// A remote, without any network: the tracking refs are written directly.
	git(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
	git(['update-ref', 'refs/remotes/origin/main', renamed]);
	git(['update-ref', 'refs/remotes/origin/HEAD', renamed]);
	git(['update-ref', 'refs/remotes/origin/changes/45/12345/1', first]);
	git(['update-ref', 'refs/remotes/origin/changes/45/12345/meta', first]);
	// The checked-out branch follows it, which is what `@{upstream}` reports.
	git(['config', 'branch.main.remote', 'origin']);
	git(['config', 'branch.main.merge', 'refs/heads/main']);
	// Both backends must spell configuration the way `git config --list` does: section and key
	// names lower-cased however the file spells them, a subsection's case kept. The macOS
	// runners' own global configuration carries camelCase advice keys, which is where a
	// mismatch between the backends first showed — so the same shape lives in this fixture.
	fs.appendFileSync(
		path.join(repoPath, '.git', 'config'),
		'[advice]\n\tamWorkDir = false\n[SomeSection "CamelCase"]\n\tSomeKey = mixed case\n'
	);

	// A stash, so that a commit no branch points at has to appear in the graph.
	write('renamed.txt', 'stashed change\n');
	git(['stash', 'push', '--quiet', '-m', 'the stashed work']);

	// An uncommitted working tree. The modified renamed.txt keeps most of a.txt's original
	// lines, so that the rename a.txt → renamed.txt is still detected against the working tree.
	write('renamed.txt', Array.from({ length: 39 }, (_, n) => `line ${n}\n`).join('') + 'line 39 (uncommitted)\n');
	write('untracked.txt', 'not added yet\n');

	return { first, feature, renamed, binary };
}

/* ---------- Comparison helpers ---------- */

/** Compare the fields both backends are expected to agree on, exactly. */
function assertSameCommits(actual, expected, context) {
	assert.equal(actual.length, expected.length, `${context}: different number of commits`);
	for (let i = 0; i < expected.length; i++) {
		const a = actual[i];
		const b = expected[i];
		assert.equal(a.hash, b.hash, `${context}: commit ${i} hash`);
		assert.deepEqual([...a.parents], [...b.parents], `${context}: commit ${i} parents`);
		assert.equal(a.author, b.author, `${context}: commit ${i} author`);
		assert.equal(a.email, b.email, `${context}: commit ${i} email`);
		assert.equal(a.message, b.message, `${context}: commit ${i} message`);
		assert.deepEqual([...a.heads].sort(), [...b.heads].sort(), `${context}: commit ${i} heads`);
		assert.deepEqual(
			[...a.tags].map((tag) => tag.name).sort(),
			[...b.tags].map((tag) => tag.name).sort(),
			`${context}: commit ${i} tags`
		);
		assert.deepEqual(
			[...a.remotes].map((remote) => remote.name).sort(),
			[...b.remotes].map((remote) => remote.name).sort(),
			`${context}: commit ${i} remotes`
		);
		assert.deepEqual(a.stash, b.stash, `${context}: commit ${i} stash`);
	}
}

function sortChanges(changes) {
	return [...changes]
		.map((change) => ({
			oldFilePath: change.oldFilePath,
			newFilePath: change.newFilePath,
			type: change.type
		}))
		.sort((a, b) => a.newFilePath.localeCompare(b.newFilePath));
}

/* ---------- The tests ---------- */

describe('the Rust engine and the git CLI agree', () => {
	let rust;
	let cli;
	let fixture;
	let root;

	before(async () => {
		fixture = buildFixture();
		rust = new NativeBackend();
		cli = new CliBackend();
		root = await rust.openRepository(repoPath);
		await cli.openRepository(repoPath);
	});

	after(() => {
		rust?.closeAllRepositories();
		if (repoPath) fs.rmSync(repoPath, { recursive: true, force: true });
	});

	it('resolves the same repository root', async () => {
		const fromCli = await cli.openRepository(repoPath);
		// The two disagree only about spelling: git prints forward slashes, and on Windows one of
		// them may report the 8.3 short form of a directory. Both are resolved to the real path
		// before being compared, which is what the extension has to do with them anyway.
		const normalise = (value) => fs.realpathSync.native(value).replace(/\\/g, '/').toLowerCase();
		assert.equal(normalise(root), normalise(fromCli));
	});

	it('reports the same repository info', async () => {
		const options = { showRemoteBranches: true, showStashes: true };
		const [a, b] = await Promise.all([
			rust.getRepoInfo(root, options),
			cli.getRepoInfo(root, options)
		]);

		assert.equal(a.error, null);
		assert.equal(b.error, null);
		assert.equal(a.head, b.head);
		assert.deepEqual([...a.branches].sort(), [...b.branches].sort());
		assert.deepEqual([...a.remotes], [...b.remotes]);
		assert.deepEqual([...a.tags], [...b.tags]);
		assert.deepEqual(
			[...a.stashes].map((stash) => ({ ...stash, selector: stash.selector })),
			[...b.stashes]
		);
	});

	it('reports the same refs', async () => {
		const options = { showRemoteBranches: true };
		const [a, b] = await Promise.all([rust.getRefs(root, options), cli.getRefs(root, options)]);

		assert.equal(a.head, b.head);
		const names = (refs) => [...refs].map((ref) => `${ref.name}@${ref.hash}`).sort();
		assert.deepEqual(names(a.heads), names(b.heads));
		assert.deepEqual(names(a.remotes), names(b.remotes));
		assert.deepEqual(
			[...a.tags].map((tag) => `${tag.name}@${tag.hash}:${tag.annotated}`).sort(),
			[...b.tags].map((tag) => `${tag.name}@${tag.hash}:${tag.annotated}`).sort()
		);
	});

	it('builds the same graph', async () => {
		const options = {
			maxCommits: 100,
			showTags: true,
			showRemoteBranches: true,
			showUncommittedChanges: true,
			showUntrackedFiles: true,
			remotes: ['origin'],
			commitOrdering: 'date'
		};
		const [a, b] = await Promise.all([rust.getCommits(root, options), cli.getCommits(root, options)]);

		assert.equal(a.error, null, `the engine failed: ${a.error}`);
		assert.equal(b.error, null, `the CLI failed: ${b.error}`);
		assert.equal(a.head, b.head);
		assert.equal(a.moreCommitsAvailable, b.moreCommitsAvailable);
		assert.deepEqual([...a.tags].sort(), [...b.tags].sort());
		// The complete load carries the complete branch list (local branches first, then the
		// `remotes/...` entries) — the same list getRepoInfo returns.
		assert.deepEqual([...a.branches].sort(), [...b.branches].sort());
		assert.ok(
			[...a.branches].some((branch) => branch.startsWith('remotes/')),
			'the complete load must list the remote branches'
		);
		assertSameCommits(a.commits, b.commits, 'getCommits');
	});

	it('defers the remote refs the same way', async () => {
		// The first response of a view load skips `refs/remotes/` (see
		// `LogOptions.deferRemoteRefs`): both backends must agree on that smaller graph — the local
		// and tag labels still annotated, and not a single remote label in sight.
		const options = {
			maxCommits: 100,
			showTags: true,
			showRemoteBranches: true,
			showUncommittedChanges: true,
			showUntrackedFiles: true,
			remotes: ['origin'],
			commitOrdering: 'date',
			deferRemoteRefs: true
		};
		const [a, b] = await Promise.all([rust.getCommits(root, options), cli.getCommits(root, options)]);

		assert.equal(a.error, null, `the engine failed: ${a.error}`);
		assert.equal(b.error, null, `the CLI failed: ${b.error}`);
		assertSameCommits(a.commits, b.commits, 'getCommits (remote refs deferred)');
		for (const commits of [a.commits, b.commits]) {
			assert.ok(commits.every((commit) => commit.remotes.length === 0), 'a deferred load must not carry remote labels');
			assert.ok(commits.some((commit) => commit.heads.length > 0), 'the local branch labels must still be annotated');
		}
		// The deferred response carries the LOCAL branch list only; the complete one (with the
		// `remotes/...` entries) rides along the complete load, completing the dropdown without a
		// second scan.
		assert.deepEqual([...a.branches].sort(), [...b.branches].sort());
		assert.ok(
			![...a.branches, ...b.branches].some((branch) => branch.startsWith('remotes/')),
			'a deferred load must not list remote branches'
		);
	});

	it('builds the same graph in every ordering', async () => {
		for (const commitOrdering of ['date', 'author-date', 'topo']) {
			const options = {
				maxCommits: 100,
				showTags: true,
				showRemoteBranches: true,
				remotes: ['origin'],
				commitOrdering
			};
			const [a, b] = await Promise.all([
				rust.getCommits(root, options),
				cli.getCommits(root, options)
			]);
			// The set of commits must match exactly; the order within it is checked separately,
			// because the two implementations break ties differently.
			assert.deepEqual(
				[...a.commits].map((commit) => commit.hash).sort(),
				[...b.commits].map((commit) => commit.hash).sort(),
				`${commitOrdering}: different commits`
			);

			// The invariant every ordering guarantees: a parent is never shown before its child.
			const position = new Map([...a.commits].map((commit, index) => [commit.hash, index]));
			for (const commit of a.commits) {
				for (const parent of commit.parents) {
					if (position.has(parent)) {
						assert.ok(
							position.get(parent) > position.get(commit.hash),
							`${commitOrdering}: the parent ${parent} was shown before its child ${commit.hash}`
						);
					}
				}
			}
		}
	});

	it('paginates the same way', async () => {
		const options = { maxCommits: 2, showTags: true, showRemoteBranches: true, remotes: ['origin'] };
		const [a, b] = await Promise.all([rust.getCommits(root, options), cli.getCommits(root, options)]);

		assert.equal(a.moreCommitsAvailable, true);
		assert.equal(b.moreCommitsAvailable, true);
		// A page can come back longer than it asked for: stash rows are spliced in *after* the page
		// is trimmed, which is what the original extension does and what the view expects. What
		// matters is that both backends do it identically.
		assertSameCommits(a.commits, b.commits, 'pagination');
		assert.equal(
			a.commits.filter((commit) => commit.stash === null).length,
			2,
			'the page must hold the requested number of real commits'
		);
	});

	it('shows Gerrit change refs only when asked', async () => {
		const hidden = await rust.getRefs(root, { showRemoteBranches: true, showChangeRefs: false });
		assert.ok(
			[...hidden.remotes].every((ref) => !ref.name.includes('changes/')),
			'change refs must stay out of the graph by default'
		);

		const shown = await rust.getRefs(root, { showRemoteBranches: true, showChangeRefs: true });
		const names = [...shown.remotes].map((ref) => ref.name);
		assert.ok(names.includes('origin/changes/45/12345/1'));
		assert.ok(!names.some((name) => name.endsWith('/meta')), 'meta refs are never displayed');

		const fromCli = await cli.getRefs(root, { showRemoteBranches: true, showChangeRefs: true });
		assert.deepEqual(names.sort(), [...fromCli.remotes].map((ref) => ref.name).sort());
	});

	it('reports the same commit details', async () => {
		const [a, b] = await Promise.all([
			rust.getCommitDetails(root, fixture.renamed),
			cli.getCommitDetails(root, fixture.renamed)
		]);

		assert.equal(a.hash, b.hash);
		assert.deepEqual([...a.parents], [...b.parents]);
		assert.equal(a.author, b.author);
		assert.equal(a.authorEmail, b.authorEmail);
		assert.equal(a.authorDate, b.authorDate);
		assert.equal(a.committer, b.committer);
		assert.equal(a.committerDate, b.committerDate);
		assert.equal(a.body.trim(), b.body.trim());
		assert.deepEqual(sortChanges(a.fileChanges), sortChanges(b.fileChanges));
		// The rename is the point of this commit: it must be one change, not an add and a delete.
		assert.equal(a.fileChanges.length, 1);
		assert.equal(a.fileChanges[0].type, 'R');
	});

	it('reports the same first commit, which has no parent to diff against', async () => {
		const [a, b] = await Promise.all([
			rust.getCommitDetails(root, fixture.first),
			cli.getCommitDetails(root, fixture.first)
		]);
		assert.deepEqual(sortChanges(a.fileChanges), sortChanges(b.fileChanges));
		assert.equal(a.fileChanges.length, 1);
		assert.equal(a.fileChanges[0].type, 'A');
	});

	it('counts uncommitted changes the same way', async () => {
		for (const includeUntracked of [true, false]) {
			const [a, b] = await Promise.all([
				rust.getUncommittedChangeCount(root, includeUntracked),
				cli.getUncommittedChangeCount(root, includeUntracked)
			]);
			assert.equal(a, b, `untracked=${includeUntracked}`);
		}
	});

	it('lists the same uncommitted files', async () => {
		const [a, b] = await Promise.all([
			rust.getUncommittedDetails(root),
			cli.getUncommittedDetails(root)
		]);
		const paths = (details) => [...details.fileChanges].map((change) => change.newFilePath).sort();
		assert.deepEqual(paths(a), paths(b));
	});

	it('reports the same stashes', async () => {
		const [a, b] = await Promise.all([rust.getStashes(root), cli.getStashes(root)]);
		assert.deepEqual([...a], [...b]);
		assert.equal(a.length, 1);
		assert.match(a[0].message, /the stashed work/);
	});

	it('compares two commits the same way', async () => {
		const [a, b] = await Promise.all([
			rust.compareCommits(root, fixture.first, fixture.renamed),
			cli.compareCommits(root, fixture.first, fixture.renamed)
		]);
		assert.deepEqual(sortChanges(a), sortChanges(b));
	});

	it('settles the same deferred line counts', async () => {
		// A commit's own diff (from null => against the first parent): the binary file reports
		// null counts, the way `git diff --numstat` prints a dash, and an untouched path is not
		// settled at all.
		const [a, b] = await Promise.all([
			rust.getLineCounts(root, null, fixture.binary, ['blob.bin', 'not-in-the-diff.txt']),
			cli.getLineCounts(root, null, fixture.binary, ['blob.bin', 'not-in-the-diff.txt'])
		]);
		assert.deepEqual(a, b);
		assert.deepEqual(a['blob.bin'], { additions: null, deletions: null });
		assert.equal(a['not-in-the-diff.txt'], undefined, 'an untouched path is not settled');

		// The rename commit: one change, carrying zero line counts because the content moved
		// unchanged — and the pre-rename path is consumed by the rename rather than deleted.
		const [r, s] = await Promise.all([
			rust.getLineCounts(root, null, fixture.renamed, ['renamed.txt', 'a.txt']),
			cli.getLineCounts(root, null, fixture.renamed, ['renamed.txt', 'a.txt'])
		]);
		assert.deepEqual(r, s);
		assert.deepEqual(r['renamed.txt'], { additions: 0, deletions: 0 });
		assert.equal(r['a.txt'], undefined);

		// The comparison-view spelling, with an explicit from: a file added in that range.
		const [c, d] = await Promise.all([
			rust.getLineCounts(root, fixture.first, fixture.renamed, ['feature.txt']),
			cli.getLineCounts(root, fixture.first, fixture.renamed, ['feature.txt'])
		]);
		assert.deepEqual(c, d);
		assert.deepEqual(c['feature.txt'], { additions: 1, deletions: 0 });

		// A root commit counts against the empty tree, exactly like its details list does.
		const [e, f] = await Promise.all([
			rust.getLineCounts(root, null, fixture.first, ['a.txt']),
			cli.getLineCounts(root, null, fixture.first, ['a.txt'])
		]);
		assert.deepEqual(e, f);
		assert.equal(e['a.txt'].additions, 40);

		// And asking for nothing costs nothing.
		assert.deepEqual(await rust.getLineCounts(root, null, fixture.first, []), {});
	});

	it('settles the same deferred counts of a merge, against its first parent', async () => {
		// A merge's own diff runs against its first parent: the feature side's file is in it, the
		// main side's file (which the merge carries unchanged from its second parent's sibling) is
		// not — a backend diffing against the wrong parent would swap the two answers.
		const merge = git(['rev-parse', `${fixture.renamed}^`]).trim();
		const [a, b] = await Promise.all([
			rust.getLineCounts(root, null, merge, ['feature.txt', 'main.txt']),
			cli.getLineCounts(root, null, merge, ['feature.txt', 'main.txt'])
		]);
		assert.deepEqual(a, b);
		assert.deepEqual(a['feature.txt'], { additions: 1, deletions: 0 });
		assert.equal(a['main.txt'], undefined, "the first parent already carries the main side's file");
	});

	it('settles the same deferred counts of a stash, against its base', async () => {
		// A stash is counted against the commit it was taken from — its base — not against its own
		// first parent; the stash replaced renamed.txt's 40 lines with a single one.
		const stash = (await rust.getStashes(root))[0];
		const [a, b] = await Promise.all([
			rust.getLineCounts(root, stash.baseHash, stash.hash, ['renamed.txt']),
			cli.getLineCounts(root, stash.baseHash, stash.hash, ['renamed.txt'])
		]);
		assert.deepEqual(a, b);
		assert.deepEqual(a['renamed.txt'], { additions: 1, deletions: 40 });
	});

	it('reports the same repository configuration', async () => {
		const [a, b] = await Promise.all([rust.getConfig(root), cli.getConfig(root)]);
		for (const key of ['userName', 'userEmail', 'pushDefault', 'diffTool', 'diffGuiTool']) {
			assert.equal(a[key], b[key], `getConfig: ${key}`);
		}
		const remote = (config) => [...config.remotes].map((r) => `${r.name}|${r.url}|${r.pushUrl}`).sort();
		assert.deepEqual(remote(a), remote(b), 'getConfig: remotes');

		// The fixture sets these, so the values must come back rather than merely agreeing.
		assert.equal(a.userName, 'Test User');
		assert.equal(a.userEmail, 'test@example.com');
		assert.equal(a.pushDefault, 'origin');
		assert.equal(a.diffTool, 'gitgraph-test-tool');
		assert.equal(a.diffGuiTool, 'gitgraph-test-gui');
	});

	it('returns the same file contents at a revision', async () => {
		const [a, b] = await Promise.all([
			rust.getCommitFile(root, fixture.renamed, 'renamed.txt'),
			cli.getCommitFile(root, fixture.renamed, 'renamed.txt')
		]);
		assert.equal(a.binary, b.binary, 'getCommitFile: binary flag of a text file');
		assert.equal(a.binary, false, 'getCommitFile: a text file is not binary');
		assert.equal(a.contents, b.contents, 'getCommitFile: contents of a text file');

		const [ab, bb] = await Promise.all([
			rust.getCommitFile(root, fixture.binary, 'blob.bin'),
			cli.getCommitFile(root, fixture.binary, 'blob.bin')
		]);
		assert.equal(ab.binary, bb.binary, 'getCommitFile: binary flag of a binary file');
		assert.equal(ab.binary, true, 'getCommitFile: a binary file is detected');
		assert.equal(ab.contents, null, 'getCommitFile: a binary file has no contents');
	});

	it('produces the same single-file diff', async () => {
		const [a, b] = await Promise.all([
			rust.getCommitFileDiff(root, fixture.renamed, 'renamed.txt'),
			cli.getCommitFileDiff(root, fixture.renamed, 'renamed.txt')
		]);
		// Header lines the two implementations legitimately spell differently (rename similarity,
		// blob indexes) are ignored: what must agree is the change itself.
		const body = (diff) =>
			diff
				.trim()
				.split('\n')
				.filter((line) => !/^(index |similarity index |--- |\+\+\+ |new file mode )/.test(line))
				.join('\n');
		assert.equal(body(a), body(b), 'getCommitFileDiff: the unified diffs differ');
	});

	it('reads the same file at an old revision, and rejects the same missing one', async () => {
		// a.txt only exists at the first commit: it was renamed later.
		const [a, b] = await Promise.all([
			rust.getCommitFile(root, fixture.first, 'a.txt'),
			cli.getCommitFile(root, fixture.first, 'a.txt')
		]);
		assert.equal(a.binary, false);
		assert.equal(a.contents, b.contents);
		assert.equal(a.contents.split('\n').length, 41, 'the 40 fixture lines plus the trailing newline');

		await assert.rejects(() => rust.getCommitFile(root, fixture.first, 'feature.txt'));
		await assert.rejects(() => cli.getCommitFile(root, fixture.first, 'feature.txt'));
	});

	it('diffs a file added by the root commit, and agrees an untouched file has no diff', async () => {
		const [rootA, rootB] = await Promise.all([
			rust.getCommitFileDiff(root, fixture.first, 'a.txt'),
			cli.getCommitFileDiff(root, fixture.first, 'a.txt')
		]);
		// A root commit diffs against the empty tree, and the empty side of the hunk header is
		// spelled the way git spells it.
		assert.ok(rootA.includes('@@ -0,0 +1,40 @@'), `the engine hunk header: ${rootA.slice(0, 120)}`);
		assert.ok(rootB.includes('@@ -0,0 +1,40 @@'), `the CLI hunk header: ${rootB.slice(0, 120)}`);
		const body = (diff) =>
			diff
				.trim()
				.split('\n')
				.filter((line) => !/^(index |similarity index |--- |\+\+\+ |new file mode |diff --git )/.test(line))
				.join('\n');
		assert.equal(body(rootA), body(rootB));

		// renamed.txt was not touched by the binary commit after it.
		const [sameA, sameB] = await Promise.all([
			rust.getCommitFileDiff(root, fixture.binary, 'renamed.txt'),
			cli.getCommitFileDiff(root, fixture.binary, 'renamed.txt')
		]);
		assert.equal(sameA, '');
		assert.equal(sameB, '');
	});

	it('filters the graph by author the same way', async () => {
		for (const authors of [['Test User'], ['Nobody Else <nobody@example.com>']]) {
			const options = { maxCommits: 100, authors, showTags: true, showRemoteBranches: true };
			const [a, b] = await Promise.all([
				rust.getCommits(root, options),
				cli.getCommits(root, options)
			]);
			assertSameCommits(a.commits, b.commits, `authors=${authors[0]}`);
		}
		const nobody = await rust.getCommits(root, {
			maxCommits: 100,
			authors: ['Nobody Else <nobody@example.com>']
		});
		assert.equal(nobody.commits.filter((commit) => commit.stash === null).length, 0);
	});

	it('filters the graph by path the same way', async () => {
		const options = { maxCommits: 100, filterPaths: ['feature.txt'], showRemoteBranches: true };
		const [a, b] = await Promise.all([rust.getCommits(root, options), cli.getCommits(root, options)]);
		assertSameCommits(a.commits, b.commits, 'filterPaths');
		// History simplification: the merge carries the feature branch's file in unchanged, so
		// only the commit that created feature.txt remains.
		const real = a.commits.filter((commit) => commit.stash === null);
		assert.deepEqual(real.map((commit) => commit.hash), [fixture.feature]);
	});

	it('follows only the first parent the same way', async () => {
		const options = {
			maxCommits: 100,
			branches: ['main'],
			onlyFollowFirstParent: true,
			showTags: true,
			showRemoteBranches: true,
			remotes: ['origin']
		};
		const [a, b] = await Promise.all([rust.getCommits(root, options), cli.getCommits(root, options)]);
		assertSameCommits(a.commits, b.commits, 'onlyFollowFirstParent');
		const hashes = a.commits.map((commit) => commit.hash);
		assert.ok(!hashes.includes(fixture.feature), 'the second-parent side must be excluded');
	});

	it('hides the named remotes the same way', async () => {
		const options = { showRemoteBranches: true, hideRemotes: ['origin'] };
		const [a, b] = await Promise.all([rust.getRefs(root, options), cli.getRefs(root, options)]);
		assert.deepEqual([...a.remotes], [...b.remotes]);
		assert.equal(a.remotes.length, 0, 'the only remote is origin, which is hidden here');
	});

	it('compares a commit against the working tree the same way', async () => {
		const [a, b] = await Promise.all([
			rust.compareCommits(root, fixture.renamed, ''),
			cli.compareCommits(root, fixture.renamed, '')
		]);
		assert.deepEqual(sortChanges(a), sortChanges(b));
		// The fixture's working tree modifies renamed.txt and adds untracked.txt on top of HEAD.
		const paths = a.map((change) => change.newFilePath).sort();
		assert.ok(paths.includes('renamed.txt'));
	});

	it('reports no counts against the working tree, on either side', async () => {
		// Counting a worktree-touched file means hashing the file on disk, so a comparison against
		// the working tree reports no counts at all — exact numbers beside uncounted ones would
		// read worse than none. The Uncommitted Changes row is statuses-only for the same reason.
		const [a, b] = await Promise.all([
			rust.compareCommits(root, fixture.renamed, ''),
			cli.compareCommits(root, fixture.renamed, '')
		]);
		const [u, v] = await Promise.all([rust.getUncommittedDetails(root), cli.getUncommittedDetails(root)]);
		for (const [changes, context] of [[a, 'compareCommits'], [b, 'compareCommits'], [u.fileChanges, 'uncommitted'], [v.fileChanges, 'uncommitted']]) {
			for (const change of changes) {
				assert.equal(change.additions, null, `${context}: ${change.newFilePath} additions`);
				assert.equal(change.deletions, null, `${context}: ${change.newFilePath} deletions`);
			}
		}
	});

	it('keeps the repository handle open across requests', async () => {
		const before = rust.openRepositoryCount;
		await rust.getRefs(root, { showRemoteBranches: true });
		await rust.getRefs(root, { showRemoteBranches: true });
		assert.equal(rust.openRepositoryCount, before, 'a second request must reuse the warm handle');
	});

	it('reads the same commit bodies', async () => {
		const hashes = [fixture.first, fixture.feature, fixture.renamed, fixture.binary];
		const [a, b] = await Promise.all([
			rust.getCommitBodies(root, hashes),
			cli.getCommitBodies(root, hashes)
		]);
		assert.deepEqual(a, b);
		assert.equal(a[fixture.renamed], 'rename a file');
		// A missing hash fails the whole call, on both sides.
		await assert.rejects(() => rust.getCommitBodies(root, ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']));
		await assert.rejects(() => cli.getCommitBodies(root, ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']));
	});

	it('reads the same commit subject', async () => {
		const merge = fixture.renamed; // any commit works; use several to be sure
		for (const hash of [fixture.first, merge, fixture.binary]) {
			const [a, b] = await Promise.all([
				rust.getCommitSubject(root, hash),
				cli.getCommitSubject(root, hash)
			]);
			assert.equal(a, b, `getCommitSubject: ${hash}`);
		}
		const subject = await cli.getCommitSubject(root, fixture.renamed);
		assert.equal(subject, 'rename a file');
	});

	it('reads the same commit summaries', async () => {
		const hashes = [fixture.first, fixture.feature];
		const [a, b] = await Promise.all([
			rust.getCommitSummaries(root, hashes),
			cli.getCommitSummaries(root, hashes)
		]);
		assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
		for (const hash of hashes) {
			assert.deepEqual({ ...a[hash] }, { ...b[hash] }, `getCommitSummaries: ${hash}`);
		}
		assert.equal(a[fixture.first].author, 'Test User');
		assert.equal(a[fixture.first].message, 'the first commit');
	});

	it('searches history the same way', async () => {
		const [a, b] = await Promise.all([rust.searchHistory(root, 'feature'), cli.searchHistory(root, 'feature')]);
		assert.deepEqual([...a], [...b]);
		assert.ok(a.some((match) => match.message === 'the feature commit'));

		// The search is case-insensitive and regex-flavoured, as `git log -E -i --grep` is.
		const [upperA, upperB] = await Promise.all([
			rust.searchHistory(root, 'THE FEATURE'),
			cli.searchHistory(root, 'THE FEATURE')
		]);
		assert.deepEqual([...upperA], [...upperB]);
		assert.ok(upperA.length > 0);

		const [noneA, noneB] = await Promise.all([
			rust.searchHistory(root, 'no-such-thing-at-all'),
			cli.searchHistory(root, 'no-such-thing-at-all')
		]);
		assert.deepEqual([...noneA], [...noneB]);
		assert.equal(noneA.length, 0);
	});

	it('reads the same tag details', async () => {
		const [annotatedA, annotatedB] = await Promise.all([
			rust.getTagDetails(root, 'v2.0'),
			cli.getTagDetails(root, 'v2.0')
		]);
		assert.deepEqual({ ...annotatedA }, { ...annotatedB });
		assert.equal(annotatedA.taggerName, 'Test User');
		assert.equal(annotatedA.message, 'an annotated tag');
		assert.equal(annotatedA.signature, null);

		const [lightA, lightB] = await Promise.all([
			rust.getTagDetails(root, 'v1.0'),
			cli.getTagDetails(root, 'v1.0')
		]);
		// A lightweight tag has no tagger: its hash is the commit's and its message the commit's.
		assert.equal(lightA.hash, lightB.hash);
		assert.equal(lightA.hash, fixture.first);
		assert.equal(lightA.message, lightB.message);
		assert.equal(lightA.message, 'the first commit');
		assert.equal(lightA.signature, null);
		assert.equal(lightB.signature, null);

		await assert.rejects(() => rust.getTagDetails(root, 'no-such-tag'));
		await assert.rejects(() => cli.getTagDetails(root, 'no-such-tag'));
	});

	it('reads tag details for hierarchical tag names', async () => {
		const [a, b] = await Promise.all([
			rust.getTagDetails(root, 'release/v2.1'),
			cli.getTagDetails(root, 'release/v2.1')
		]);
		assert.deepEqual({ ...a }, { ...b });
		// A lightweight tag below a slash: the hash is the commit it names.
		assert.equal(a.hash, fixture.renamed);
		assert.equal(a.message, 'rename a file');
	});

	it('reads the same remote urls', async () => {
		const [a, b] = await Promise.all([
			rust.getRemoteUrl(root, 'origin'),
			cli.getRemoteUrl(root, 'origin')
		]);
		assert.equal(a, b);
		assert.equal(a, 'https://example.invalid/repo.git');

		const [missingA, missingB] = await Promise.all([
			rust.getRemoteUrl(root, 'no-such-remote'),
			cli.getRemoteUrl(root, 'no-such-remote')
		]);
		assert.equal(missingA, null);
		assert.equal(missingB, null);
	});

	it('follows the same rename into the working tree', async () => {
		const [a, b] = await Promise.all([
			rust.getNewPathOfRenamedFile(root, fixture.first, 'a.txt'),
			cli.getNewPathOfRenamedFile(root, fixture.first, 'a.txt')
		]);
		assert.equal(a, b);
		assert.equal(a, 'renamed.txt');

		const [noneA, noneB] = await Promise.all([
			rust.getNewPathOfRenamedFile(root, fixture.first, 'no-such.txt'),
			cli.getNewPathOfRenamedFile(root, fixture.first, 'no-such.txt')
		]);
		assert.equal(noneA, null);
		assert.equal(noneB, null);
	});

	it('lists the same submodules', async () => {
		const [a, b] = await Promise.all([rust.getSubmodules(root), cli.getSubmodules(root)]);
		// The two may spell the separator differently; both must name the same directory.
		const normalise = (value) => fs.realpathSync.native(value).replace(/\\/g, '/').toLowerCase();
		assert.deepEqual(a.map(normalise), b.map(normalise));
		assert.equal(a.length, 1);
		assert.equal(path.basename(a[0]), 'sub');
	});

	it('serves the remaining reads the same way', async () => {
		// Repository discovery, from a subdirectory of the work tree.
		const nested = path.join(repoPath, 'sub');
		const [rootA, rootB] = await Promise.all([rust.repoRoot(nested), cli.repoRoot(nested)]);
		const normaliseRoot = (value) => fs.realpathSync.native(value).split(path.sep).join('/').toLowerCase();
		assert.equal(normaliseRoot(rootA), normaliseRoot(rootB));

		// Remote names.
		const [remotesA, remotesB] = await Promise.all([rust.getRemotes(root), cli.getRemotes(root)]);
		assert.deepEqual([...remotesA], [...remotesB]);
		assert.deepEqual([...remotesA], ['origin']);

		// The author list: aggregated, de-duplicated by name, sorted by name.
		const [authorsA, authorsB] = await Promise.all([rust.getAuthors(root), cli.getAuthors(root)]);
		assert.deepEqual([...authorsA], [...authorsB]);
		assert.deepEqual(authorsA.map((author) => author.name), ['Second Author', 'Test User']);
		assert.deepEqual(authorsA[1], { name: 'Test User', email: 'test@example.com' });

		// The configuration of both locations: the fixture's HOME holds no global file, so both
		// sides agree there is nothing global, and the local entries match key for key.
		const [localA, localB] = await Promise.all([rust.getConfigList(root, 'local'), cli.getConfigList(root, 'local')]);
		assert.deepEqual(localA, localB);
		assert.equal(localA['branch.main.remote'], 'origin');
		assert.equal(localA['remote.origin.url'], 'https://example.invalid/repo.git');
		const [globalA, globalB] = await Promise.all([rust.getConfigList(root, 'global'), cli.getConfigList(root, 'global')]);
		assert.deepEqual(globalA, globalB);

		// The checked-out branch.
		const [branchA, branchB] = await Promise.all([rust.currentBranchName(root), cli.currentBranchName(root)]);
		assert.equal(branchA, branchB);
		assert.equal(branchA, 'main');
	});

	it('reads the same current branch upstream', async () => {
		const [a, b] = await Promise.all([
			rust.getCurrentBranchUpstream(root),
			cli.getCurrentBranchUpstream(root)
		]);
		assert.equal(a, b);
		assert.equal(a, 'origin/main');
	});

	it('counts commits before the same way', async () => {
		for (const args of [
			{ branches: null, showRemoteBranches: true, includeReflogs: false },
			{ branches: null, showRemoteBranches: false, includeReflogs: false },
			{ branches: ['main'], showRemoteBranches: true, includeReflogs: false }
		]) {
			const [a, b] = await Promise.all([
				rust.countCommitsBefore(root, args.branches, fixture.first, args.showRemoteBranches, args.includeReflogs),
				cli.countCommitsBefore(root, args.branches, fixture.first, args.showRemoteBranches, args.includeReflogs)
			]);
			assert.equal(a, b, `countCommitsBefore: ${JSON.stringify(args)}`);
		}

		// An unknown hash is not counted, on either side.
		assert.equal(await rust.countCommitsBefore(root, null, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', true, false).catch(() => null), null);
		assert.equal(await cli.countCommitsBefore(root, null, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', true, false).catch(() => null), null);
	});

	it('routes what the engine declines to the CLI, invisibly', async () => {
		const { createBackend } = await import('../out/backend/index.js');
		const fallbacks = [];
		const backend = createBackend({ onFallback: (method) => fallbacks.push(method) });

		// A --glob= pattern: the engine's tip resolution does not understand it, so the CLI answers.
		const glob = ['--glob=refs/heads/**'];
		const viaFallback = await backend.countCommitsBefore(root, glob, fixture.first, true, false);
		const viaCli = await cli.countCommitsBefore(root, glob, fixture.first, true, false);
		assert.equal(viaFallback, viaCli);
		assert.deepEqual(fallbacks, ['countCommitsBefore']);

		// Reflog tips take the same path.
		fallbacks.length = 0;
		const reflogCount = await backend.countCommitsBefore(root, null, fixture.first, true, true);
		assert.equal(reflogCount, await cli.countCommitsBefore(root, null, fixture.first, true, true));
		assert.deepEqual(fallbacks, ['countCommitsBefore']);
	});

	it('returns no bodies for no commits, and searches with regex metacharacters', async () => {
		const [a, b] = await Promise.all([rust.getCommitBodies(root, []), cli.getCommitBodies(root, [])]);
		assert.deepEqual(a, {});
		assert.deepEqual(b, {});

		const pattern = 'the (feature|main) commit';
		const [ra, rb] = await Promise.all([rust.searchHistory(root, pattern), cli.searchHistory(root, pattern)]);
		assert.deepEqual([...ra], [...rb]);
		assert.ok(ra.length >= 2, 'the pattern matches at least the feature and main commits');

		// A dot in the pattern is a wildcard to both sides, as it is to POSIX ERE.
		const [da, db] = await Promise.all([rust.searchHistory(root, 'f.rst'), cli.searchHistory(root, 'f.rst')]);
		assert.deepEqual([...da], [...db]);
		assert.ok(da.length >= 1, "'f.rst' matches 'the first commit' through the wildcard");
	});

	it('returns one body per commit however often it is named', async () => {
		const hashes = [fixture.first, fixture.first, fixture.renamed];
		const [a, b] = await Promise.all([
			rust.getCommitBodies(root, hashes),
			cli.getCommitBodies(root, hashes)
		]);
		assert.deepEqual(a, b);
		assert.equal(Object.keys(a).length, 2, 'a commit named twice is one entry');
	});

	it('trims the same multi-paragraph tag message', async () => {
		const [a, b] = await Promise.all([
			rust.getTagDetails(root, 'v3.0'),
			cli.getTagDetails(root, 'v3.0')
		]);
		assert.deepEqual({ ...a }, { ...b });
		assert.equal(a.message, 'line one\n\nline two');
	});

	// Last in the block: this one pushes a second stash, which the earlier tests count on not
	// being there yet.
	it('orders multiple stashes newest first', async () => {
		write('renamed.txt', 'a second stashed change\n');
		git(['stash', 'push', '--quiet', '-m', 'the second stashed work']);

		const [a, b] = await Promise.all([rust.getStashes(root), cli.getStashes(root)]);
		assert.deepEqual([...a], [...b]);
		assert.equal(a.length, 2);
		assert.match(a[0].message, /the second stashed work/, 'the newest stash comes first');
		assert.match(a[1].message, /the stashed work/);
	});
});

describe('unusual remote names', () => {
	it('reads a hand-edited config subsection the same way', async () => {
		// `git remote add` refuses names with spaces, but nothing stops a hand-edited .git/config
		// from carrying one — and the remote URL lookup must read it exactly as `git config` does.
		const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-oddremote-'));
		const rust = new NativeBackend();
		const cli = new CliBackend();
		try {
			const gitOdd = (args) =>
				execFileSync('git', args, {
					cwd: repoPath,
					encoding: 'utf8',
					env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoPath }
				});
			gitOdd(['init', '--quiet']);
			gitOdd(['config', 'remote.up stream.url', 'https://example.invalid/spaced.git']);

			const [a, b] = await Promise.all([
				rust.getRemoteUrl(repoPath, 'up stream'),
				cli.getRemoteUrl(repoPath, 'up stream')
			]);
			assert.equal(a, b);
			assert.equal(a, 'https://example.invalid/spaced.git');
		} finally {
			rust.closeAllRepositories();
			fs.rmSync(repoPath, { recursive: true, force: true });
		}
	});
});

describe('a renamed directory', () => {
	// `git mv` of a folder: the engine's rewrite tracker pairs the deleted tree with the added one
	// as a rewrite of the directory itself, which must not surface as a file row anywhere — and
	// the deferred counts of the files under it must settle by their new paths, on both backends.
	let rust;
	let cli;
	let root;
	let repoDir;
	let moved;
	let gitIn;

	before(async () => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-movedir-'));
		gitIn = (args) =>
			execFileSync('git', args, {
				cwd: repoDir,
				encoding: 'utf8',
				env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoDir }
			});
		const writeIn = (file, contents) => {
			const full = path.join(repoDir, file);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, contents);
		};
		const commitIn = (message) => {
			gitIn(['add', '-A']);
			gitIn(['commit', '--quiet', '--allow-empty', '-m', message]);
			return gitIn(['rev-parse', 'HEAD']).trim();
		};

		gitIn(['init', '--quiet', '--initial-branch=main']);
		gitIn(['config', 'user.name', 'Test User']);
		gitIn(['config', 'user.email', 'test@example.com']);
		gitIn(['config', 'commit.gpgsign', 'false']);

		const lines = (prefix, count, changed) =>
			Array.from({ length: count }, (_, n) => `${prefix} ${changed.includes(n) ? 'changed' : n}\n`).join('');
		writeIn('docs/guide.txt', lines('line', 40, []));
		writeIn('docs/notes.txt', lines('note', 10, []));
		writeIn('docs/notes.txt.bak', lines('backup', 10, []));
		writeIn('with space.txt', 'one\ntwo\nthree\n');
		commitIn('the first commit');

		gitIn(['mv', 'docs', 'manual']);
		// Re-writing the moved files keeps them renames (most lines are shared), not add-plus-delete.
		writeIn('manual/notes.txt', lines('note', 10, [1, 9]));
		writeIn('manual/notes.txt.bak', lines('backup', 10, [1, 9]));
		writeIn('with space.txt', 'one\nTWO\nthree\n');
		writeIn('manual/added.txt', 'brand new\n');
		moved = commitIn('move the folder');

		rust = new NativeBackend();
		cli = new CliBackend();
		root = await rust.openRepository(repoDir);
		await cli.openRepository(repoDir);
	});

	after(() => {
		rust?.closeAllRepositories();
		if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
	});

	it('lists only the files under it, not the directory itself', async () => {
		const [a, b] = await Promise.all([rust.getCommitDetails(root, moved), cli.getCommitDetails(root, moved)]);
		assert.deepEqual(sortChanges(a.fileChanges), sortChanges(b.fileChanges));
		for (const details of [a, b]) {
			const paths = details.fileChanges.map((change) => change.newFilePath);
			assert.ok(!paths.includes('docs') && !paths.includes('manual'), `a directory must not be a file row: ${paths}`);
			// The details arrive as statuses only; the counts are the deferred second load.
			for (const change of details.fileChanges) {
				assert.equal(change.additions, null, `${change.newFilePath} additions`);
				assert.equal(change.deletions, null, `${change.newFilePath} deletions`);
			}
		}
		const guide = a.fileChanges.find((change) => change.newFilePath === 'manual/guide.txt');
		assert.equal(guide.type, 'R');
		assert.equal(guide.oldFilePath, 'docs/guide.txt');
	});

	it('settles the same deferred counts for the moved files', async () => {
		const paths = [
			'manual/guide.txt', // moved unchanged: a rename with zero counts
			'manual/notes.txt', // moved and edited: the edit's counts on the rename
			'manual/added.txt', // a plain addition under the moved folder
			'docs/guide.txt', // the pre-move path: consumed by the rename
			'with space.txt' // a path with a space, through both backends' spellings
		];
		const [a, b] = await Promise.all([
			rust.getLineCounts(root, null, moved, paths),
			cli.getLineCounts(root, null, moved, paths)
		]);
		assert.deepEqual(a, b);
		assert.deepEqual(a['manual/guide.txt'], { additions: 0, deletions: 0 });
		assert.deepEqual(a['manual/notes.txt'], { additions: 2, deletions: 2 });
		assert.deepEqual(a['manual/added.txt'], { additions: 1, deletions: 0 });
		assert.equal(a['docs/guide.txt'], undefined, 'the counts are keyed by the new path only');
		assert.deepEqual(a['with space.txt'], { additions: 1, deletions: 1 });
	});

	it('settles only the exact path asked for, not a longer name sharing it', async () => {
		const [a, b] = await Promise.all([
			rust.getLineCounts(root, null, moved, ['manual/notes.txt']),
			cli.getLineCounts(root, null, moved, ['manual/notes.txt'])
		]);
		assert.deepEqual(a, b);
		assert.deepEqual(Object.keys(a), ['manual/notes.txt'], 'notes.txt.bak must not ride along');
	});
});

describe('git semantics the fixtures do not cover', () => {
	// Four shapes taken straight from the git documentation, where the two backends disagreed
	// until each of these pinned them: diff headers that quote or share prefixes, .mailmap,
	// type changes, and --author being a regular expression.
	let rust;
	let cli;
	let root;
	let repoDir;
	let changed;
	let mailmapped;
	let alice;

	before(async () => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-docsem-'));
		const gitIn = (args, options = {}) =>
			execFileSync('git', args, {
				cwd: repoDir,
				encoding: 'utf8',
				input: options.input,
				env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoDir }
			});
		const writeIn = (file, contents) => fs.writeFileSync(path.join(repoDir, file), contents);
		const commitIn = (message, author) => {
			const identity = author === undefined ? [] : ['-c', `user.name=${author[0]}`, '-c', `user.email=${author[1]}`];
			gitIn([...identity, 'add', '-A']);
			gitIn([...identity, 'commit', '--quiet', '--allow-empty', '-m', message]);
			return gitIn(['rev-parse', 'HEAD']).trim();
		};

		gitIn(['init', '--quiet', '--initial-branch=main']);
		gitIn(['config', 'user.name', 'Test User']);
		gitIn(['config', 'user.email', 'test@example.com']);
		gitIn(['config', 'commit.gpgsign', 'false']);
		writeIn('a.txt', 'one\n');
		writeIn('a.txt.bak', 'backup\n');
		writeIn('ünïcode.txt', 'u\n');
		writeIn('with space.txt', 's\n');
		commitIn('the first commit');

		writeIn('a.txt', 'two\n');
		writeIn('a.txt.bak', 'backup2\n');
		writeIn('ünïcode.txt', 'ü2\n');
		writeIn('with space.txt', 's2\n');
		changed = commitIn('change everything');

		// A mailmap that renames Test User: `git shortlog` applies it by default; the author list
		// must not, or it would disagree with the names the commit rows themselves display.
		writeIn('.mailmap', 'Mapped Name <test@example.com> Test User <test@example.com>\n');
		mailmapped = commitIn('add the mailmap');

		alice = commitIn('by alice', ['Alice (ops)', 'ops@example.com']);

		rust = new NativeBackend();
		cli = new CliBackend();
		root = await rust.openRepository(repoDir);
		await cli.openRepository(repoDir);
	});

	after(() => {
		rust?.closeAllRepositories();
		if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
	});

	it("returns only the asked file's diff, not a longer name sharing it", async () => {
		// The engine normalises the `index`/similarity lines away; what must agree is the change
		// itself (the same comparison the fixture's single-file diff test makes).
		const body = (diff) =>
			diff
				.trim()
				.split('\n')
				.filter((line) => !/^(index |similarity index |--- |\+\+\+ |new file mode |diff --git )/.test(line))
				.join('\n');
		for (const file of ['a.txt', 'a.txt.bak', 'ünïcode.txt', 'with space.txt']) {
			const [a, b] = await Promise.all([
				rust.getCommitFileDiff(root, changed, file),
				cli.getCommitFileDiff(root, changed, file)
			]);
			assert.equal(body(a), body(b), `getCommitFileDiff: ${file}`);
			const sections = (diff) => (diff.match(/^diff --git /gm) ?? []).length;
			assert.equal(sections(a), 1, `${file}: exactly one file's diff, not every section mentioning it`);
			assert.ok(a.length > 0, `${file}: the diff must not be empty`);
		}
	});

	it('lists raw author identities, ignoring .mailmap', async () => {
		const [a, b] = await Promise.all([rust.getAuthors(root), cli.getAuthors(root)]);
		assert.deepEqual(a, b);
		const names = a.map((author) => author.name);
		assert.ok(names.includes('Test User'), `the raw spelling must be kept: ${names}`);
		assert.ok(!names.includes('Mapped Name'), '.mailmap must not be applied');
	});

	it('agrees a type change is not a listed status', async () => {
		// Replace a.txt.bak with a symlink through plumbing (a symlink's blob is its target path)
		const gitIn = (args, options = {}) =>
			execFileSync('git', args, {
				cwd: repoDir,
				encoding: 'utf8',
				input: options.input,
				env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repoDir }
			});
		const blob = gitIn(['hash-object', '-w', '--stdin'], { input: 'a.txt' }).trim();
		gitIn(['update-index', '--cacheinfo', `120000,${blob},a.txt.bak`]);
		gitIn(['commit', '--quiet', '-m', 'turn a.txt.bak into a symlink']);
		const typeChange = gitIn(['rev-parse', 'HEAD']).trim();

		const [a, b] = await Promise.all([rust.getCommitDetails(root, typeChange), cli.getCommitDetails(root, typeChange)]);
		assert.deepEqual(sortChanges(a.fileChanges), sortChanges(b.fileChanges));
		assert.ok(
			![...a.fileChanges, ...b.fileChanges].some((change) => change.newFilePath === 'a.txt.bak'),
			'both backends drop the T status (--diff-filter=AMDR semantics)'
		);
	});

	it('filters by an author whose name contains regular-expression metacharacters', async () => {
		const options = { maxCommits: 50, authors: ['Alice (ops)'] };
		const [a, b] = await Promise.all([rust.getCommits(root, options), cli.getCommits(root, options)]);
		assertSameCommits(a.commits, b.commits, 'authors=Alice (ops)');
		assert.deepEqual(
			a.commits.filter((commit) => commit.stash === null).map((commit) => commit.hash),
			[alice],
			'the parenthesised name must match literally, not as a regex group'
		);
	});
});

describe('the backend selection', () => {
	it('falls back to the CLI when the engine cannot open a path', async () => {
		const { createBackend } = await import('../out/backend/index.js');
		const fallbacks = [];
		const backend = createBackend({ onFallback: (method) => fallbacks.push(method) });

		// A path that is not a repository: both backends fail, but the engine's failure is the kind
		// that is fallen back over, so the CLI is asked as well.
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-empty-'));
		try {
			await assert.rejects(() => backend.openRepository(outside));
			assert.deepEqual(fallbacks, ['openRepository']);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it('can be forced onto the CLI', async () => {
		const { createBackend, describeBackend } = await import('../out/backend/index.js');
		assert.equal(describeBackend({ prefer: 'git-cli' }), 'git-cli');
		assert.equal(createBackend({ prefer: 'git-cli' }).name, 'git-cli');
	});
});

describe('running without a git CLI', () => {
	it('builds the engine alone when no git executable exists', async () => {
		const { createBackend, describeBackend } = await import('../out/backend/index.js');
		assert.equal(describeBackend({ gitPath: null }), 'rust (engine only; no git CLI found)');

		const fallbacks = [];
		const backend = createBackend({ gitPath: null, onFallback: (method) => fallbacks.push(method) });
		assert.equal(backend.name, 'rust', 'no fallback wrapper when there is nothing to fall back to');

		// Everything the engine serves still works...
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-nogit-'));
		try {
			execFileSync('git', ['init', '--quiet'], { cwd: outside, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: outside } });
			const root = await backend.openRepository(outside);
			const refs = await backend.getRefs(root, {});
			assert.deepEqual([...refs.heads], []);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}

		// ...and what it declines surfaces as an error rather than silently falling back.
		await assert.rejects(() => backend.getConfigList('C:\no-such-repo', 'local'));
		assert.deepEqual(fallbacks, [], 'with no CLI there is nothing to fall back to');
	});

	it('reports whether the git CLI is available', async () => {
		const { describeCapabilities } = await import('../out/backend/index.js');
		assert.equal(describeCapabilities().gitCliAvailable, true);
		assert.equal(describeCapabilities({ gitCliAvailable: false }).gitCliAvailable, false);
	});
});

describe('the backend capability report', () => {
	it('reports the engine split for this platform', async () => {
		const { describeCapabilities } = await import('../out/backend/index.js');
		const report = describeCapabilities();

		assert.equal(report.platform, `${process.platform}-${process.arch}`);
		assert.equal(report.engineAvailable, true);
		assert.match(report.engineVersion ?? '', /^\d+\.\d+\.\d+/);

		const byArea = Object.fromEntries(report.capabilities.map((capability) => [capability.area, capability]));
		for (const area of ['repoInfo', 'commits', 'details', 'diffs', 'onDemand', 'metadata']) {
			assert.equal(byArea[area].provider, 'rust', `${area} is served by the engine`);
		}
		// The documented splits: reflog/glob counting declines per call, and writes are always git.
		assert.equal(byArea.counting.provider, 'rust');
		assert.equal(byArea.counting.note, 'dynamic');
		assert.equal(byArea.config.provider, 'rust');
		assert.equal(byArea.config.note, undefined);
		assert.equal(byArea.writes.provider, 'git-cli');
		assert.equal(byArea.writes.note, 'writesAlways');
	});

	it('reports everything on the git CLI when no engine is present', async () => {
		const { describeCapabilities } = await import('../out/backend/index.js');
		const { resetAddonCache } = await import('../out/backend/addon.js');
		const withoutEngine = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-noengine-'));
		// The addon loader caches its first successful load globally, so the cache is dropped
		// before probing an engine-less root — and restored (dropped again) afterwards.
		resetAddonCache();
		try {
			const report = describeCapabilities({ addonRoot: withoutEngine });
			assert.equal(report.engineAvailable, false);
			assert.equal(report.engineVersion, null);
			assert.ok(report.capabilities.length >= 9);
			assert.ok(report.capabilities.every((capability) => capability.provider === 'git-cli'));
		} finally {
			resetAddonCache();
			fs.rmSync(withoutEngine, { recursive: true, force: true });
		}
	});
});

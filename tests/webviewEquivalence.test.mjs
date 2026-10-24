/**
 * The rewritten webview (src/webview, built into media/out.min.js) must behave exactly like the
 * v1.0 webview it replaces. The frozen v1.0 bundle is kept in tests/fixtures/v1.0; every scenario
 * below boots BOTH bundles under the same scripted extension host, drives them with the same
 * interactions, and requires the same document, the same requests and the same persisted state at
 * every checkpoint. Requires `npm run compile-web` first (it consumes media/).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bootBundle, NEW_BUNDLE, REPO, rootDir, V1_BUNDLE } from './webviewEquivalenceHarness.mjs';

const MARKDOWN_IT = fs.readFileSync(path.join(rootDir, 'media', 'vendor', 'markdown-it.min.js'), 'utf8');

/* ---------- fixtures ---------- */

const H = (i) => 'c' + String(i).padStart(4, '0') + 'a'.repeat(30);
const SUB_REPO = REPO + '/sub/module';

const AUTHORS = [
	{ name: 'Alice <script>', email: 'alice@example.com' },
	{ name: 'Bob "B" O\'Neil', email: 'bob+test@example.com' },
	{ name: '张三', email: 'zhangsan@example.cn' },
	{ name: 'Eve & Co', email: 'eve@example.com' }
];

/** A history that exercises every kind of row: refs of every type, a stash, a merge, escaping, links, emoji, CJK, the uncommitted row. */
function buildHistory(total = 40) {
	const commits = [];
	commits.push({ hash: '*', parents: [H(1)], author: '*', email: '', date: 1750000000, message: 'Uncommitted Changes (3)', heads: [], tags: [], remotes: [], stash: null });
	for (let i = 1; i < total; i++) {
		const author = AUTHORS[i % AUTHORS.length];
		const commit = {
			hash: H(i), parents: i + 1 < total ? [H(i + 1)] : [], author: author.name, email: author.email, date: 1749000000 - i * 3600,
			message: 'commit number ' + i, heads: [], tags: [], remotes: [], stash: null
		};
		commits.push(commit);
	}
	const c = (i) => commits[i];
	Object.assign(c(1), {
		message: 'Fix #123: handle <b>html</b> & "quotes" :bug: see https://example.com/x?y=1&z=2 and ' + H(5).substring(0, 8) + ' `code` **bold** _it_',
		heads: ['main', 'feature/a&b'],
		remotes: [{ name: 'origin/main', remote: 'origin' }, { name: 'origin/feature/a&b', remote: 'origin' }, { name: 'upstream/dev', remote: 'upstream' }, { name: 'orphan/x', remote: null }],
		tags: [{ name: 'v1.0.0', annotated: true }, { name: 'origin/v1.0.0', annotated: true }, { name: 'light<tag>', annotated: false }]
	});
	// A stash row (the host puts the stash commit among the page's commits)
	commits.splice(2, 0, {
		hash: H(90), parents: [H(3)], author: 'Alice <script>', email: 'alice@example.com', date: 1749999000,
		message: 'WIP on main: stash message', heads: [], tags: [], remotes: [],
		stash: { selector: 'refs/stash@{0}', baseHash: H(3), untrackedFilesHash: H(91) }
	});
	// A merge commit with a second parent deeper in the history
	const mergeIndex = commits.findIndex((x) => x.hash === H(3));
	Object.assign(commits[mergeIndex], { message: 'Merge branch \'feature\' into main', parents: [H(4), H(9)] });
	Object.assign(commits[commits.findIndex((x) => x.hash === H(6))], { message: '中文提交信息 :tada: with emoji and a very long subject that goes on and on and on to exercise the ellipsis handling of the description column', tags: [{ name: 'v0.9', annotated: false }], heads: ['release/1.0'] });
	Object.assign(commits[commits.findIndex((x) => x.hash === H(8))], { remotes: [{ name: 'origin/hotfix', remote: 'origin' }] });
	return commits;
}

const FILE_CHANGES = [
	{ oldFilePath: 'src/app.ts', newFilePath: 'src/app.ts', type: 'M', additions: null, deletions: null },
	{ oldFilePath: 'src/dir/new file.ts', newFilePath: 'src/dir/new file.ts', type: 'A', additions: null, deletions: null },
	{ oldFilePath: 'src/dir/deep/er/x.ts', newFilePath: 'src/dir/deep/er/x.ts', type: 'M', additions: null, deletions: null },
	{ oldFilePath: 'README.md', newFilePath: 'README.md', type: 'M', additions: null, deletions: null },
	{ oldFilePath: 'src/old&name.ts', newFilePath: 'src/renamed.ts', type: 'R', additions: null, deletions: null },
	{ oldFilePath: 'docs/gone.md', newFilePath: 'docs/gone.md', type: 'D', additions: null, deletions: null },
	{ oldFilePath: 'assets/logo.png', newFilePath: 'assets/logo.png', type: 'M', additions: null, deletions: null },
	{ oldFilePath: 'untracked.txt', newFilePath: 'untracked.txt', type: 'U', additions: null, deletions: null },
	{ oldFilePath: 'sub/module', newFilePath: 'sub/module', type: 'M', additions: null, deletions: null }
];

const FILE_COUNTS = {
	'src/app.ts': { additions: 10, deletions: 2 },
	'src/dir/new file.ts': { additions: 5, deletions: 0 },
	'src/dir/deep/er/x.ts': { additions: 1, deletions: 1 },
	'README.md': { additions: 3, deletions: 4 },
	'src/renamed.ts': { additions: 0, deletions: 0 },
	'docs/gone.md': { additions: 0, deletions: 7 },
	'assets/logo.png': { additions: null, deletions: null },
	'sub/module': { additions: 1, deletions: 1 }
};

const COMMIT_BODY = 'Subject of the commit\n\n# Heading\n\n- first item\n- second item with `code`\n\nSee [the docs](https://example.com/docs) & more <b>text</b>.\n\n> quoted\n\nSigned-off-by: Alice <alice@example.com>';

const REPO_CONFIG = {
	branches: { main: { pushRemote: null, remote: 'origin' }, 'feature/a&b': { pushRemote: 'upstream', remote: 'origin' } },
	authors: [{ name: 'Alice <script>', email: 'alice@example.com' }, { name: 'Bob "B" O\'Neil', email: 'bob+test@example.com' }],
	diffTool: 'meld',
	guiDiffTool: null,
	pushDefault: 'origin',
	remotes: [
		{ name: 'origin', url: 'https://github.com/example/repo.git', pushUrl: null },
		{ name: 'upstream', url: 'git@gitlab.com:example/repo.git', pushUrl: 'git@gitlab.com:example/push.git' }
	],
	user: { name: { local: 'Alice <script>', global: 'Global Name' }, email: { local: 'alice@example.com', global: 'global@example.com' } }
};

const GERRIT_STATES = [
	{ change: 4711, patchset: 3, codeReview: 2, verified: 1, status: 'new', wip: false, headHash: H(4), url: 'https://gerrit.example.com/c/4711', events: [
		{ type: 'created', patchset: 1, reviewer: 'alice', timestamp: 1749000000, raw: 'Create change', rawFull: 'full <record>' },
		{ type: 'vote', patchset: 3, reviewer: 'bob', timestamp: 1749001000, raw: 'Patch Set 3: Code-Review+2', rawFull: '', labels: [{ name: 'Code-Review', value: 2 }] }
	] },
	{ change: 4712, patchset: 1, codeReview: -1, verified: 0, status: 'merged', wip: false, headHash: H(7), url: null, events: [], eventsPending: true }
];

const PULL_REQUESTS = [
	{ number: 17, title: 'Add <feature> & fix', state: 'open', author: 'carol', url: 'https://github.com/example/repo/pull/17', sourceBranch: 'feature/x', targetBranch: 'main', headHash: H(5), body: 'Body with <b>html</b>\nand lines' },
	{ number: 18, title: 'Merged one', state: 'merged', author: '', url: '', sourceBranch: 'a', targetBranch: 'b', headHash: H(10), body: '' }
];

/** The scripted extension host. */
function makeHost(options = {}) {
	const history = options.history || buildHistory(options.total || 40);
	const state = { operationState: options.operationState || { type: null, conflictedFiles: [], progress: null }, gerritStates: options.gerrit ? GERRIT_STATES : null, more: options.more === true };
	return (message) => {
		switch (message.command) {
			case 'loadRepoInfo':
				return [{ command: 'loadRepoInfo', refreshId: message.refreshId, branches: ['main', 'feature/a&b', 'release/1.0', 'remotes/origin/main', 'remotes/origin/feature/a&b', 'remotes/upstream/dev'], head: 'main', remotes: ['origin', 'upstream'], stashes: [{ hash: H(90), baseHash: H(3), untrackedFilesHash: H(91), selector: 'refs/stash@{0}', author: 'Alice', email: 'a@b.c', date: 1749999000, message: 'WIP' }], isRepo: true, error: null, operationState: state.operationState }];
			case 'loadCommits':
				return [{ command: 'loadCommits', refreshId: message.refreshId, commits: history, head: H(1), tags: ['v1.0.0', 'light<tag>', 'v0.9'], moreCommitsAvailable: state.more, onlyFollowFirstParent: false, gerritStates: state.gerritStates, uncommittedPending: false, uncommittedCount: 3, error: null }];
			case 'loadConfig':
				return [{ command: 'loadConfig', repo: REPO, refreshId: message.refreshId, config: REPO_CONFIG, error: null }];
			case 'commitDetails': {
				const commit = history.find((x) => x.hash === message.commitHash);
				return [{
					command: 'commitDetails', error: null, avatar: options.avatar ? 'data:image/png;base64,iVBORw0KGgo=' : null, codeReview: options.codeReview || null, refresh: message.refresh,
					commitDetails: {
						hash: message.commitHash, parents: commit ? commit.parents : [], author: 'Alice <script>', authorEmail: 'alice@example.com', authorDate: 1749000000,
						committer: 'Bob "B"', committerEmail: 'bob@example.com', committerDate: 1749003600,
						signature: { key: 'ABCDEF', signer: 'Alice <alice@example.com>', status: 'G' },
						body: COMMIT_BODY, fileChanges: FILE_CHANGES
					}
				}];
			}
			case 'compareCommits':
				return [{ command: 'compareCommits', error: null, commitHash: message.commitHash, compareWithHash: message.compareWithHash, fileChanges: FILE_CHANGES, codeReview: null, refresh: message.refresh }];
			case 'commitFileCounts':
				return [{ command: 'commitFileCounts', error: null, commitHash: message.commitHash, compareWithHash: message.compareWithHash, counts: Object.fromEntries(message.paths.filter((p) => FILE_COUNTS[p]).map((p) => [p, FILE_COUNTS[p]])) }];
			case 'commitBodies':
				return [{ command: 'commitBodies', requestId: message.requestId, bodies: Object.fromEntries(message.commitHashes.map((h) => [h, 'Full body of ' + h.substring(0, 8) + '\n\nSecond paragraph with <tags> & more.'])) }];
			case 'reflog':
				return [{ command: 'reflog', error: null, repo: REPO, ref: message.ref, moreAvailable: true, entries: [
					{ hash: H(1), abbrevHash: 'c0001aaa', selector: 'HEAD@{0}', date: 1749000000, message: 'commit: fix <this>', dangling: false },
					{ hash: H(2), abbrevHash: 'c0002aaa', selector: 'HEAD@{1}', date: 1748990000, message: 'reset: moving to HEAD~1', dangling: true },
					{ hash: H(3), abbrevHash: 'c0003aaa', selector: 'HEAD@{2}', date: 1748980000, message: 'rebase (squash): x', dangling: false },
					{ hash: H(4), abbrevHash: 'c0004aaa', selector: 'HEAD@{3}', date: 1748970000, message: 'checkout: moving from a to b', dangling: false },
					{ hash: H(5), abbrevHash: 'c0005aaa', selector: 'HEAD@{4}', date: 1748960000, message: 'commit (amend): y', dangling: false }
				] }];
			case 'worktreeList':
				return [{ command: 'worktreeList', repo: REPO, worktrees: [
					{ path: REPO, hash: H(1), branch: 'main', detached: false, locked: false, prunable: false, isMain: true },
					{ path: REPO + '-wt/a&b', hash: H(2), branch: 'feature/a&b', detached: false, locked: true, prunable: false, isMain: false },
					{ path: REPO + '-wt/old', hash: H(3), branch: null, detached: true, locked: false, prunable: true, isMain: false }
				] }];
			case 'repoStatistics':
				return [{ command: 'repoStatistics', repo: REPO, authors: [{ name: 'Alice <script>', email: 'a@b.c', commits: 120 }, { name: 'Bob', email: 'b@b.c', commits: 40 }, { name: 'Zed', email: 'z@b.c', commits: 1 }], activity: [{ weekday: 1, hour: 9, count: 10 }, { weekday: 1, hour: 10, count: 4 }, { weekday: 6, hour: 23, count: 1 }, { weekday: 0, hour: 0, count: 7 }] }];
			case 'pullRequest':
			case 'fetchPullRequest':
				return [{ command: 'pullRequestStatus', repo: REPO, prs: PULL_REQUESTS }];
			case 'predictConflicts':
				return [{ command: 'predictConflicts', ours: message.ours, theirs: message.theirs, prediction: { conflicted: true, files: ['a&b.ts', 'c.ts'] } }];
			case 'countCommitsBefore':
				return [{ command: 'countCommitsBefore', hash: message.hash, count: 12 }];
			default:
				return undefined;
		}
	};
}

/* ---------- running scenarios against both bundles ---------- */

async function runScenario(bundle, options, script) {
	const shots = [];
	const boot = await bootBundle({ bundle, respond: options.respond || makeHost(options.host), configure: options.configure, configureRepos: options.configureRepos, ...options.boot });
	if (options.markdown) boot.window.eval(MARKDOWN_IT);
	const cp = (label) => shots.push({ label, html: boot.html() });
	await script(boot, cp);
	await boot.settle(40);
	cp('final');
	return {
		shots,
		errors: boot.errors,
		sent: boot.sent.filter((m) => m.command !== 'setViewSnapshot'),
		state: boot.states.length > 0 ? boot.states[boot.states.length - 1] : null
	};
}

function firstDifference(a, b) {
	const la = a.split('\n'), lb = b.split('\n');
	for (let i = 0; i < Math.max(la.length, lb.length); i++) {
		if (la[i] !== lb[i]) {
			return 'line ' + (i + 1) + '\n  v1.0: ' + (la[i] || '<end>') + '\n  new : ' + (lb[i] || '<end>') + '\n  context: ' + la.slice(Math.max(0, i - 3), i).join(' / ');
		}
	}
	return '';
}

async function assertEquivalent(name, options, script) {
	const v1 = await runScenario(V1_BUNDLE, options, script);
	const rewritten = await runScenario(NEW_BUNDLE, options, script);
	assert.deepEqual(rewritten.errors, v1.errors, name + ': uncaught errors differ');
	assert.deepEqual(rewritten.shots.map((s) => s.label), v1.shots.map((s) => s.label), name + ': checkpoints differ');
	for (let i = 0; i < v1.shots.length; i++) {
		if (v1.shots[i].html !== rewritten.shots[i].html) {
			assert.fail(name + ' / ' + v1.shots[i].label + ': the document differs at ' + firstDifference(v1.shots[i].html, rewritten.shots[i].html));
		}
	}
	for (let i = 0; i < Math.max(v1.sent.length, rewritten.sent.length); i++) {
		assert.deepEqual(rewritten.sent[i], v1.sent[i], name + ': request #' + i + ' differs');
	}
	assert.deepEqual(rewritten.state, v1.state, name + ': the persisted webview state differs');
	return { v1, rewritten };
}

/** Open a menu, click each of its items in turn (capturing what appears), and close it again. */
async function exploreMenu(h, cp, label, open, itemCount) {
	for (let i = 0; i < itemCount; i++) {
		open();
		const items = Array.from(h.document.querySelectorAll('.contextMenuItem'));
		if (i >= items.length) { h.key(h.document, 'Escape'); break; }
		const title = items[i].textContent;
		h.click(items[i]);
		await h.settle(30);
		cp(label + ' / ' + i + ' ' + title);
		const primary = h.document.getElementById('dialogAction');
		if (primary !== null) {
			h.click(primary);
			await h.settle(30);
			cp(label + ' / ' + i + ' ' + title + ' / confirmed');
		}
		h.key(h.document, 'Escape');
		await h.settle(20);
		h.key(h.document, 'Escape');
		await h.settle(220); // the closing dialog fades out for 180ms
	}
}

const rowOf = (h, id) => h.document.querySelector('tr.commit[data-id="' + id + '"]');

/* ---------- the scenarios ---------- */

test('equivalence: the initial load of a rich history', async () => {
	await assertEquivalent('initial load', { markdown: true }, async (h, cp) => {
		cp('loaded');
		h.click('#refreshBtn');
		await h.settle(60);
		cp('refreshed');
	});
});

test('equivalence: the commit details view, its file views and file context menu', async () => {
	await assertEquivalent('commit details', { markdown: true, host: { avatar: true } }, async (h, cp) => {
		h.click(rowOf(h, 3));
		await h.settle(80);
		cp('details open');
		h.click('#cdvMarkdownToggle');
		cp('markdown toggled');
		h.click('#cdvFileViewTypeList');
		// >300ms so the background counts chunk (LINE_COUNTS_CHUNK_DELAY) has deterministically
		// landed in both bundles before the checkpoint — otherwise the sample is timing-marginal
		await h.settle(400);
		cp('list view');
		h.click('#cdvFileViewTypeTree');
		await h.settle(60);
		cp('tree view');
		h.click('#cdvCollapse');
		cp('collapsed');
		h.click('#cdvExpand');
		cp('expanded');
		h.click('.fileTreeFolder');
		cp('folder toggled');
		h.rightClick('.fileTreeFileRecord');
		cp('file menu');
		h.key(h.document, 'Escape');
		h.click('.fileTreeFile');
		cp('file clicked (diff request)');
		h.click('.copyGitFile');
		h.click('.openGitFile');
		h.key(h.document, 'ArrowDown');
		await h.settle(60);
		cp('arrow down navigates');
		h.key(h.document, 'ArrowUp', { ctrlKey: true });
		// the keyboard navigation refetched the commit details, which re-arms the background
		// counts chunk — wait past its 300ms delay so the checkpoint is deterministic
		await h.settle(400);
		cp('ctrl arrow up');
		h.click('#cdvCodeReview');
		await h.settle(40);
		cp('code review start requested');
		h.dispatch({ command: 'startCodeReview', error: null, commitHash: h.document.querySelector('tr.commit.commitDetailsOpen').dataset.hash, compareWithHash: null, codeReview: { id: 'r1', lastActive: 1, lastViewedFile: 'README.md', remainingFiles: ['README.md', 'src/app.ts'] } });
		cp('code review started');
		h.rightClick('.fileTreeFileRecord');
		h.clickMenuItem('Mark as Not Reviewed');
		cp('marked reviewed');
		h.click('#cdvClose');
		cp('closed');
	});
});

test('equivalence: the context menus and the dialogs they open', async () => {
	await assertEquivalent('context menus', { markdown: false, host: { more: true } }, async (h, cp) => {
		const commitRow = () => rowOf(h, 5);
		await exploreMenu(h, cp, 'commit', () => h.rightClick(commitRow()), 18);
		await exploreMenu(h, cp, 'head commit', () => h.rightClick(rowOf(h, 1)), 18);
		await exploreMenu(h, cp, 'branch', () => h.rightClick(h.document.querySelector('.gitRef.head:not(.active)') || h.document.querySelector('.gitRef.head')), 14);
		await exploreMenu(h, cp, 'checked-out branch', () => h.rightClick(h.document.querySelector('.gitRef.head.active')), 14);
		await exploreMenu(h, cp, 'remote branch', () => h.rightClick(h.document.querySelector('.gitRef.remote')), 12);
		await exploreMenu(h, cp, 'combined remote', () => h.rightClick(h.document.querySelector('.gitRefHeadRemote')), 12);
		await exploreMenu(h, cp, 'annotated tag', () => h.rightClick(h.document.querySelector('.gitRef.tag[data-tagtype="annotated"]')), 8);
		await exploreMenu(h, cp, 'lightweight tag', () => h.rightClick(h.document.querySelector('.gitRef.tag[data-tagtype="lightweight"]')), 8);
		await exploreMenu(h, cp, 'stash', () => h.rightClick(h.document.querySelector('.gitRef.stash')), 8);
		await exploreMenu(h, cp, 'uncommitted', () => h.rightClick(h.document.getElementById('uncommittedChanges')), 8);
		h.rightClick('#tableColHeaders');
		cp('column header menu');
		h.clickMenuItem('Date');
		await h.settle(40);
		cp('date column hidden');
		h.rightClick('#tableColHeaders');
		h.clickMenuItem('Author');
		await h.settle(40);
		cp('widths reset');
		h.dblClick(h.document.querySelector('.gitRef.head'));
		await h.settle(40);
		cp('double click checkout');
	});
});

test('equivalence: responses, errors and warnings', async () => {
	await assertEquivalent('responses', { markdown: false }, async (h, cp) => {
		const shot = async (label, ...messages) => {
			for (const message of messages) h.dispatch(message);
			await h.settle(40);
			cp(label);
			h.key(h.document, 'Escape');
			await h.settle(220);
		};
		await shot('addTag error', { command: 'addTag', repo: REPO, errors: ['tag exists & <broken>'], tagName: 't', commitHash: H(1), pushToRemote: null });
		await shot('push tag: commit not on remote', { command: 'pushTag', repo: REPO, errors: ['VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:["origin","up&stream"]'], tagName: 'v1', remotes: ['origin', 'upstream'], commitHash: H(1) });
		await shot('delete branch not merged', { command: 'deleteBranch', repo: REPO, errors: ['error: The branch \'x\' is not fully merged.\nIf you are sure, run git branch -D x'], branchName: 'x<y>', forceDelete: false, deleteOnRemotes: [] });
		await shot('loss warning', { command: 'lossWarning', message: 'Data loss risk: 3 commits', retry: { command: 'checkoutCommit', repo: REPO, commitHash: H(2), confirmed: true } });
		await shot('tag details', { command: 'tagDetails', error: null, tagName: 'v1.0.0', commitHash: H(1), details: { hash: H(95), taggerName: 'Tagger <t>', taggerEmail: 'tag@example.com', taggerDate: 1749000000, message: 'Release 1.0 & more\n\n  indented line\nhttps://example.com ' + H(3).substring(0, 8), signature: { key: 'K', signer: 'S', status: 'B' } } });
		await shot('tag details lightweight', { command: 'tagDetails', error: null, tagName: 'x', commitHash: H(1), details: { hash: H(96), taggerName: '', taggerEmail: '', taggerDate: 0, message: 'lw', signature: null } });
		await shot('rebase error', { command: 'rebase', error: 'conflict & stuff', actionOn: 'Branch', interactive: false, repo: REPO });
		await shot('merge error', { command: 'merge', error: 'merge failed', actionOn: 'Commit', repo: REPO });
		await shot('commit details error', { command: 'commitDetails', error: 'cannot read', commitDetails: null, avatar: null, codeReview: null, refresh: false });
		await shot('unexpected', { command: 'commitDetails', error: null, commitDetails: { hash: 'zz' }, avatar: null, codeReview: null, refresh: false });
		await shot('conflict banner', { command: 'loadRepoInfo', refreshId: 999, branches: [], head: null, remotes: [], stashes: [], isRepo: true, error: null, operationState: { type: 'rebase', conflictedFiles: ['a&b.ts', 'c.ts'], progress: { step: 2, total: 5 } } });
		await shot('config changed', { command: 'refresh' });
		await shot('copy error', { command: 'copyToClipboard', error: 'no clipboard', type: 'Commit Hash' });
		await shot('create archive ok', { command: 'createArchive', error: null, repo: REPO });
		await shot('user details', { command: 'editUserDetails', errors: [null, 'oops'], repo: REPO });
	});
});

test('equivalence: dropdowns, filters and the toolbar', async () => {
	await assertEquivalent('toolbar', { markdown: false }, async (h, cp) => {
		h.click('#branchDropdown .dropdownCurrentValue');
		cp('branch dropdown open');
		h.type('#branchDropdown .dropdownFilterInput', 'feat');
		h.key('#branchDropdown .dropdownFilterInput', 'ArrowDown');
		h.key('#branchDropdown .dropdownFilterInput', 'Enter');
		await h.settle(60);
		cp('branch chosen via keyboard');
		h.click('#authorDropdown .dropdownCurrentValue');
		cp('author dropdown open');
		h.click('#authorDropdown .dropdownOption:nth-child(2)');
		await h.settle(60);
		cp('author chosen');
		h.click('#showRemoteBranchesCheckbox');
		await h.settle(60);
		cp('remote branches toggled');
		h.click('#repoDropdown .dropdownCurrentValue');
		h.click('#repoDropdown .dropdownOptionInfo');
		cp('repo info dialog');
		h.key(h.document, 'Escape');
		await h.settle(220);
		h.click('#filterBtn');
		cp('path filter dialog');
		h.type('#dialogInput0', 'src/a.ts, src/b.ts ,,');
		h.click('#dialogAction');
		await h.settle(60);
		cp('path filter applied');
		h.click('#terminalBtn');
		h.click('#fetchBtn');
		h.click('#currentBtn');
		await h.settle(40);
		cp('toolbar actions');
		h.click('#statisticsBtn');
		await h.settle(40);
		cp('statistics');
		h.click('#statisticsClose');
		await h.settle(40);
		cp('statistics closed');
	});
});

test('equivalence: the find widget', async () => {
	await assertEquivalent('find', { markdown: false }, async (h, cp) => {
		h.click('#findBtn');
		cp('find open');
		h.type('#findInput', 'commit number 1');
		await h.settle(300);
		cp('searched');
		h.key('#findInput', 'Enter');
		h.window.document.getElementById('findInput').dispatchEvent(new h.window.KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
		await h.settle(60);
		cp('next match');
		h.click('#findCaseSensitive');
		cp('case sensitive');
		h.click('#findRegex');
		h.type('#findInput', '(unclosed');
		await h.settle(300);
		cp('invalid regex');
		h.type('#findInput', 'ali.e');
		await h.settle(300);
		cp('regex author');
		h.click('#findOpenCdv');
		h.window.document.getElementById('findInput').dispatchEvent(new h.window.KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, shiftKey: true, bubbles: true }));
		await h.settle(80);
		cp('previous match opens details');
		h.click('#findClose');
		await h.settle(60);
		cp('closed');
	});
});

test('equivalence: the settings widget', async () => {
	await assertEquivalent('settings', { markdown: false, configureRepos: undefined, host: {} }, async (h, cp) => {
		h.click('#settingsBtn');
		await h.settle(80);
		cp('settings open');
		const exercise = async (label, selector) => {
			const elem = h.document.querySelector(selector);
			if (elem === null) { cp(label + ' (absent)'); return; }
			h.click(elem);
			await h.settle(40);
			cp(label);
			const primary = h.document.getElementById('dialogAction');
			if (primary !== null) {
				h.click(primary);
				await h.settle(40);
				cp(label + ' / confirmed');
			}
			h.key(h.document, 'Escape');
			await h.settle(220);
			if (h.document.querySelector('#settingsWidget.active') === null) h.click('#settingsBtn');
			await h.settle(60);
		};
		for (const [label, selector] of [
			['edit name', '#editRepoName'], ['edit initial branches', '#editInitialBranches'], ['add remote', '#settingsAddRemote'],
			['edit remote', '.editRemote'], ['delete remote', '.deleteRemote'], ['fetch remote', '.fetchRemote'], ['prune remote', '.pruneRemote'],
			['hide remote', '.hideRemoteBtn'], ['add issue linking', '#editIssueLinking'], ['configure pr', '#editPullRequestIntegration'],
			['add author', '#settingsAddAuthor'], ['edit author', '.editAuthor'], ['delete author', '.deleteAuthor'], ['set global author', '.setGlobalAuthor'],
			['switch author', '.authorSwitchRow[data-index="1"]'], ['use global author', '#useGlobalAuthorRow'], ['export config', '#exportRepositoryConfig'],
			['open log', '#openLogFile'], ['open settings', '#openExtensionSettings']
		]) await exercise(label, selector);
		for (const id of ['settingsShowStashesCheckbox', 'settingsShowTagsCheckbox', 'settingsOnlyFollowFirstParentCheckbox', 'settingsGerritFetchRefsCheckbox', 'settingsStickyHeaderCheckbox', 'settingsRenderMarkdownCheckbox', 'settingsFetchAndPruneCheckbox']) {
			const box = h.document.getElementById(id);
			if (box !== null) {
				box.checked = !box.checked;
				box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
				await h.settle(40);
				cp('toggle ' + id);
				h.key(h.document, 'Escape');
				await h.settle(220);
				if (h.document.querySelector('#settingsWidget.active') === null) h.click('#settingsBtn');
			}
		}
		for (const [id, value] of [['settingsGraphRowHeight', '30'], ['settingsInitialLoad', '99999999'], ['settingsGraphStyle', 'angular'], ['settingsInterfaceLanguage', 'zh-cn'], ['settingsDateFormat', 'Relative']]) {
			const input = h.document.getElementById(id);
			if (input !== null) {
				input.value = value;
				input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
				await h.settle(40);
				cp('set ' + id);
				h.key(h.document, 'Escape');
				await h.settle(220);
				if (h.document.querySelector('#settingsWidget.active') === null) h.click('#settingsBtn');
			}
		}
		h.click('#openReflogView');
		await h.settle(60);
		cp('reflog opened from settings');
		h.rightClick('.reflogRow');
		cp('reflog row menu');
		h.key(h.document, 'Escape');
		h.click('#reflogClose');
		await h.settle(40);
		h.click('#settingsBtn');
		await h.settle(40);
		h.click('#openWorktreeDialog');
		await h.settle(60);
		cp('worktrees');
		h.click('#worktreeAddBtn');
		cp('add worktree dialog');
		h.key(h.document, 'Escape');
		await h.settle(220);
		h.click('.worktreeRemoveBtn');
		cp('remove worktree dialog');
		h.key(h.document, 'Escape');
		await h.settle(220);
		h.click('#worktreePruneBtn');
		cp('prune worktrees dialog');
	});
});

test('equivalence: the Gerrit and pull request integrations', async () => {
	await assertEquivalent('integrations', { markdown: false, host: { gerrit: true }, configure: (config) => { config.pullRequests.enabled = true; config.gerrit.showReviewProgress = true; }, configureRepos: (repos) => { repos[REPO].gerritFetchRefs = true; repos[REPO].gerritStatusFilter = { new: true, merged: true, abandoned: false, wip: false }; } }, async (h, cp) => {
		cp('badges');
		h.click('.gitRef.gerrit');
		cp('gerrit dialog');
		h.click('.gg-event-expandable');
		cp('gerrit event expanded');
		h.click('#dialogCloseIcon');
		await h.settle(220);
		if (h.document.querySelector('.gitRef.pr') !== null) h.click('.gitRef.pr');
		cp('pull request dialog');
		h.key(h.document, 'Escape');
		await h.settle(220);
		h.click('#settingsBtn');
		await h.settle(80);
		cp('settings with gerrit');
		const box = h.document.getElementById('settingsGerritStatusAbandonedCheckbox');
		box.checked = true;
		box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
		await h.settle(300);
		cp('gerrit filter changed');
	});
});

test('equivalence: pinned commits and branches, and jumping to them', async () => {
	await assertEquivalent('pinned', { markdown: false, host: { more: true } }, async (h, cp) => {
		h.rightClick(rowOf(h, 6));
		h.clickMenuItem('Pin Commit');
		cp('commit pinned');
		h.rightClick(h.document.querySelector('.gitRef.head'));
		h.clickMenuItem('Pin Branch');
		cp('branch pinned');
		h.click('.pinnedChip[data-type="commit"]');
		await h.settle(40);
		cp('jumped to commit');
		h.click('.pinnedChip[data-type="branch"]');
		await h.settle(60);
		cp('filtered to branch');
		h.click('.pinnedChipRemove[data-type="commit"]');
		cp('commit unpinned');
		h.dispatch({ command: 'countCommitsBefore', hash: H(5), count: null });
		await h.settle(40);
		cp('unknown pinned commit');
	});
});

test('equivalence: a long history is windowed identically while scrolling and refreshing', async () => {
	await assertEquivalent('windowed', { markdown: false, host: { total: 400 }, boot: {} }, async (h, cp) => {
		cp('top');
		for (const row of [50, 137, 260, 399, 10]) {
			h.setScrollTop(row * 24);
			await h.settle(520);
			cp('scrolled to ' + row);
		}
		h.setScrollTop(130 * 24);
		await h.settle(520);
		h.click(rowOf(h, 135));
		await h.settle(100);
		cp('details open deep in the history');
		h.click('#refreshBtn');
		await h.settle(120);
		cp('refreshed while scrolled');
	});
});

test('equivalence: the mobile layout', async () => {
	await assertEquivalent('mobile', { markdown: true, boot: { width: 400 }, configure: (config) => { config.mobileAdaptation = true; } }, async (h, cp) => {
		cp('mobile list');
		h.click('#mobileMoreBtn');
		cp('overflow menu');
		h.key(h.document, 'Escape');
		h.click(rowOf(h, 3));
		await h.settle(80);
		cp('mobile details sheet');
		h.click('#cdvClose');
		await h.settle(40);
		cp('sheet closed');
		h.rightClick(rowOf(h, 4));
		cp('mobile action sheet');
	});
});

test('equivalence: the Chinese interface', async () => {
	await assertEquivalent('zh-cn', { markdown: true, configure: (config) => { config.interfaceLanguage = 'zh-cn'; config.interfaceLanguageSetting = 'zh-cn'; } }, async (h, cp) => {
		cp('zh list');
		h.rightClick(rowOf(h, 5));
		cp('zh commit menu');
		h.clickMenuItem('添加标签');
		cp('zh add tag dialog');
		h.key(h.document, 'Escape');
		await h.settle(220);
		h.click(rowOf(h, 3));
		await h.settle(80);
		cp('zh details');
		h.click('#settingsBtn');
		await h.settle(80);
		cp('zh settings');
	});
});

test('equivalence: a webview reload restores the persisted state', async () => {
	let saved = null;
	await assertEquivalent('reload', { markdown: false }, async (h, cp) => {
		h.click('#findBtn');
		h.type('#findInput', 'number 2');
		await h.settle(300);
		h.setScrollTop(0);
		cp('state before');
		saved = h.states.length > 0 ? h.states[h.states.length - 1] : null;
	});
	assert.ok(saved !== null);
	await assertEquivalent('reload restored', { markdown: false, boot: { state: saved } }, async (h, cp) => {
		cp('restored');
	});
	await assertEquivalent('snapshot restored', { markdown: false, boot: { restoredSnapshot: { currentRepo: REPO, scrollTop: 0, findWidget: { text: 'number 3', currentHash: null, visible: true }, settingsWidget: { currentRepo: null, scrollTop: 0, repoColumnScrollTop: 0, globalColumnScrollTop: 0 }, commitPathFilter: 'src', compareSourceHash: H(4) } } }, async (h, cp) => {
		cp('restored from the host snapshot');
	});
});

test('equivalence: loading to a commit asked for by the extension', async () => {
	await assertEquivalent('loadViewTo', { markdown: false, boot: { loadViewTo: { repo: REPO, commitDetails: { commitHash: H(6), compareWithHash: H(3) } } } }, async (h, cp) => {
		cp('opened the comparison');
	});
	await assertEquivalent('loadViewTo find', { markdown: false, boot: { loadViewTo: { repo: REPO, findCommitHash: H(7) } } }, async (h, cp) => {
		cp('found the commit');
	});
});

void fs;

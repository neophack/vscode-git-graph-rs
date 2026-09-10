/**
 * The pull request integration's pure logic: how a remote URL maps onto the GitHub/GitLab REST
 * APIs, which remote of a repository is queried (one named anything - not only "origin"), the
 * response parsing (including the commit each request points at), and the refspecs that fetch
 * the head commits of the still-open requests into the repository - so that requests opened from
 * a fork appear in the Git Graph View, while the refs of requests that closed are pruned.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
	parseRemoteUrl, parseGithubPulls, parseGitlabMergeRequests,
	parseGitRemoteVerbose, selectRemote, buildPullRequestHeadRefspecs, findStalePullRequestRefs,
	PullRequestDataSource, fetchJson
} = await import('../out/pullRequests.js');

/** A GitHub API pull request entry, as the REST API returns it. */
function githubPull(number, title, overrides = {}) {
	return Object.assign({
		number: number,
		title: title,
		state: 'open',
		draft: false,
		merged_at: null,
		user: { login: 'author' },
		html_url: 'https://github.com/owner/repo/pull/' + number,
		head: { ref: 'feature-' + number, sha: 'aaaa' + number },
		base: { ref: 'main' },
		body: ''
	}, overrides);
}

/** A GitLab API merge request entry, as the REST API returns it. */
function gitlabMr(iid, title, overrides = {}) {
	return Object.assign({
		iid: iid,
		title: title,
		state: 'opened',
		work_in_progress: false,
		author: { name: 'Author Name', username: 'author' },
		web_url: 'https://gitlab.com/group/repo/-/merge_requests/' + iid,
		source_branch: 'feature-' + iid,
		target_branch: 'main',
		sha: 'bbbb' + iid,
		description: ''
	}, overrides);
}

describe('parseRemoteUrl', () => {
	it('parses an HTTPS GitHub remote', () => {
		assert.deepEqual(parseRemoteUrl('https://github.com/neophack/vscode-git-graph-rs.git'), {
			platform: 'github', apiBase: 'https://api.github.com', owner: 'neophack', repo: 'vscode-git-graph-rs'
		});
	});

	it('parses an scp-style SSH GitHub remote', () => {
		assert.deepEqual(parseRemoteUrl('git@github.com:owner/repo.git'), {
			platform: 'github', apiBase: 'https://api.github.com', owner: 'owner', repo: 'repo'
		});
	});

	it('parses an ssh:// GitHub remote without a .git suffix', () => {
		assert.deepEqual(parseRemoteUrl('ssh://git@github.com/owner/repo'), {
			platform: 'github', apiBase: 'https://api.github.com', owner: 'owner', repo: 'repo'
		});
	});

	it('keeps the full project path of a nested-group GitLab remote', () => {
		assert.deepEqual(parseRemoteUrl('https://gitlab.com/group/sub/repo.git'), {
			platform: 'gitlab', apiBase: 'https://gitlab.com/api/v4', owner: 'group', repo: 'group/sub/repo'
		});
	});

	it('uses the host of a self-hosted GitLab remote as the API base', () => {
		assert.deepEqual(parseRemoteUrl('git@gitlab.example.com:team/repo.git'), {
			platform: 'gitlab', apiBase: 'https://gitlab.example.com/api/v4', owner: 'team', repo: 'team/repo'
		});
	});

	it('rejects unsupported and malformed remote URLs', () => {
		assert.equal(parseRemoteUrl('/some/local/path'), null);
		assert.equal(parseRemoteUrl('https://example.com/repo'), null); // no owner segment
		assert.equal(parseRemoteUrl(''), null);
	});
});

describe('parseGitRemoteVerbose', () => {
	it('deduplicates the fetch and push lines of each remote', () => {
		assert.deepEqual(
			parseGitRemoteVerbose('master\thttps://github.com/owner/repo (fetch)\nmaster\thttps://github.com/owner/repo (push)\n'),
			[{ name: 'master', url: 'https://github.com/owner/repo' }]
		);
	});

	it('parses multiple remotes and ignores blank lines', () => {
		assert.deepEqual(
			parseGitRemoteVerbose('origin\thttps://github.com/owner/repo (fetch)\n\nupstream\tgit@github.com:other/repo.git (fetch)\n'),
			[
				{ name: 'origin', url: 'https://github.com/owner/repo' },
				{ name: 'upstream', url: 'git@github.com:other/repo.git' }
			]
		);
	});

	it('returns no remotes for empty output', () => {
		assert.deepEqual(parseGitRemoteVerbose(''), []);
	});
});

describe('selectRemote', () => {
	it('prefers origin even when it is not the first remote', () => {
		assert.deepEqual(selectRemote([
			{ name: 'upstream', url: 'https://github.com/other/repo.git' },
			{ name: 'origin', url: 'https://github.com/owner/repo.git' }
		]), { name: 'origin', url: 'https://github.com/owner/repo.git' });
	});

	it('falls back to the first remote hosted on a supported platform when there is no origin', () => {
		assert.deepEqual(selectRemote([
			{ name: 'local', url: '/some/local/path' },
			{ name: 'master', url: 'https://github.com/owner/repo' }
		]), { name: 'master', url: 'https://github.com/owner/repo' });
	});

	it('returns null when no remote is hosted on a supported platform', () => {
		assert.equal(selectRemote([{ name: 'origin', url: '/some/local/path' }]), null);
		assert.equal(selectRemote([]), null);
	});
});

describe('parseGithubPulls', () => {
	it('parses every field, including the commit the request points at', () => {
		const pulls = parseGithubPulls([
			githubPull(8, 'fix: improve WebView help and icon interactions', {
				user: { login: 'unusuallman' },
				head: { ref: 'unusuallman-fix-info-icon-click', sha: 'fd671e0911f4988d003ac6d3093fb54b5bd9d2be' },
				base: { ref: 'main' },
				body: '## What changed\n- Fixed the icons'
			})
		]);
		assert.equal(pulls.length, 1);
		assert.deepEqual(pulls[0], {
			number: 8, title: 'fix: improve WebView help and icon interactions', state: 'open', author: 'unusuallman',
			url: 'https://github.com/owner/repo/pull/8', sourceBranch: 'unusuallman-fix-info-icon-click', targetBranch: 'main',
			headHash: 'fd671e0911f4988d003ac6d3093fb54b5bd9d2be', body: '## What changed\n- Fixed the icons'
		});
	});

	it('maps the draft, merged and closed states', () => {
		const pulls = parseGithubPulls([
			githubPull(1, 'a', { draft: true }),
			githubPull(2, 'b', { merged_at: '2026-01-01T00:00:00Z' }),
			githubPull(3, 'c', { state: 'closed' })
		]);
		assert.deepEqual(pulls.map((pull) => pull.state), ['draft', 'merged', 'closed']);
	});

	it('skips invalid entries and non-array bodies', () => {
		assert.deepEqual(parseGithubPulls([null, { title: 'no number' }, githubPull(4, 'd')]).length, 1);
		assert.deepEqual(parseGithubPulls({ message: 'Not Found' }), []);
	});
});

describe('parseGitlabMergeRequests', () => {
	it('parses every field, including the target branch and head commit', () => {
		const mrs = parseGitlabMergeRequests([gitlabMr(3, 'Add feature', { target_branch: 'release', sha: '56e72da8da916aaf0ddf1a69dfd67dc3076059b8', description: 'Adds the feature' })]);
		assert.equal(mrs.length, 1);
		assert.deepEqual(mrs[0], {
			number: 3, title: 'Add feature', state: 'open', author: 'Author Name',
			url: 'https://gitlab.com/group/repo/-/merge_requests/3', sourceBranch: 'feature-3', targetBranch: 'release',
			headHash: '56e72da8da916aaf0ddf1a69dfd67dc3076059b8', body: 'Adds the feature'
		});
	});

	it('maps the WIP, merged and closed states', () => {
		const mrs = parseGitlabMergeRequests([
			gitlabMr(1, 'a', { work_in_progress: true }),
			gitlabMr(2, 'b', { state: 'merged' }),
			gitlabMr(3, 'c', { state: 'closed' })
		]);
		assert.deepEqual(mrs.map((mr) => mr.state), ['draft', 'merged', 'closed']);
	});
});

describe('buildPullRequestHeadRefspecs', () => {
	it('fetches the head commits of the open and draft requests of a GitHub remote', () => {
		const prs = parseGithubPulls([
			githubPull(8, 'open'),
			githubPull(9, 'draft', { draft: true }),
			githubPull(7, 'merged', { merged_at: '2026-01-01T00:00:00Z' }),
			githubPull(6, 'closed', { state: 'closed' })
		]);
		assert.deepEqual(buildPullRequestHeadRefspecs('master', parseRemoteUrl('https://github.com/owner/repo.git'), prs), [
			'+refs/pull/8/head:refs/remotes/master/prs/8',
			'+refs/pull/9/head:refs/remotes/master/prs/9'
		]);
	});

	it('fetches from the merge-requests namespace of a GitLab remote', () => {
		const mrs = parseGitlabMergeRequests([gitlabMr(4, 'open')]);
		assert.deepEqual(buildPullRequestHeadRefspecs('origin', parseRemoteUrl('https://gitlab.com/group/repo.git'), mrs), [
			'+refs/merge-requests/4/head:refs/remotes/origin/prs/4'
		]);
	});

	it('returns no refspecs for an unsupported remote or without open requests', () => {
		assert.deepEqual(buildPullRequestHeadRefspecs('local', null, parseGithubPulls([githubPull(1, 'open')])), []);
		assert.deepEqual(buildPullRequestHeadRefspecs('origin', parseRemoteUrl('https://github.com/owner/repo.git'), parseGithubPulls([githubPull(1, 'merged', { merged_at: '2026-01-01T00:00:00Z' })])), []);
	});

	it('caps the number of fetched heads', () => {
		const many = [];
		for (let number = 1; number <= 40; number++) many.push(githubPull(number, 'pr ' + number));
		const refspecs = buildPullRequestHeadRefspecs('origin', parseRemoteUrl('https://github.com/owner/repo.git'), parseGithubPulls(many));
		assert.equal(refspecs.length, 25);
		assert.equal(refspecs[24], '+refs/pull/25/head:refs/remotes/origin/prs/25');
	});
});

describe('findStalePullRequestRefs', () => {
	it('prunes the refs of closed requests, keeping open, draft and merged ones', () => {
		const prs = parseGithubPulls([
			githubPull(8, 'open'),
			githubPull(9, 'draft', { draft: true }),
			githubPull(7, 'merged', { merged_at: '2026-01-01T00:00:00Z' }),
			githubPull(6, 'closed', { state: 'closed' })
		]);
		const existing = [
			'refs/remotes/master/prs/8',
			'refs/remotes/master/prs/9',
			'refs/remotes/master/prs/7',
			'refs/remotes/master/prs/6',
			'refs/remotes/master/prs/5'
		];
		assert.deepEqual(findStalePullRequestRefs(existing, 'master', prs), [
			'refs/remotes/master/prs/6',
			'refs/remotes/master/prs/5'
		]);
	});

	it('ignores refs outside the pull request namespace of the remote', () => {
		assert.deepEqual(findStalePullRequestRefs(['refs/remotes/master/main', 'refs/heads/prs/1'], 'master', parseGithubPulls([githubPull(1, 'open')])), []);
	});
});

describe('fetchJson', () => {
	it('rejects on connection errors', async () => {
		await assert.rejects(fetchJson('https://127.0.0.1:1/repos/owner/repo/pulls', {}, 2000));
	});

	it('rejects within its absolute deadline (a hung lookup must not stall the promise forever)', async () => {
		// A non-routable address: the connection neither establishes nor refuses - only the
		// deadline can settle the promise. CI networks that reject it fast still pass (any rejection).
		await assert.rejects(fetchJson('https://10.255.255.1/repos/owner/repo/pulls', {}, 250));
	});
});

describe('PullRequestDataSource', () => {
	/** A fetcher that records every request and replies with `bodies` per URL prefix, in order. */
	function recordingFetcher(bodies) {
		const calls = [];
		const fetcher = (url, headers, timeoutMs) => {
			calls.push({ url: url, headers: headers, timeoutMs: timeoutMs });
			const body = bodies.shift();
			if (body instanceof Error) return Promise.reject(body);
			return Promise.resolve(body);
		};
		fetcher.calls = calls;
		return fetcher;
	}

	it('queries the GitHub pulls API of the parsed remote', async () => {
		const fetcher = recordingFetcher([[]]);
		const source = new PullRequestDataSource(fetcher);
		await source.getPullRequests('https://github.com/owner/repo.git');
		assert.equal(fetcher.calls.length, 1);
		assert.equal(fetcher.calls[0].url, 'https://api.github.com/repos/owner/repo/pulls?state=all&per_page=100');
		assert.equal(fetcher.calls[0].headers['Accept'], 'application/vnd.github+json');
		assert.ok(fetcher.calls[0].timeoutMs > 0);
	});

	it('authenticates with GITHUB_TOKEN when it is set', async () => {
		const previous = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'secret-token';
		try {
			const fetcher = recordingFetcher([[]]);
			await new PullRequestDataSource(fetcher).getPullRequests('https://github.com/owner/repo.git');
			assert.equal(fetcher.calls[0].headers['Authorization'], 'Bearer secret-token');
		} finally {
			if (previous === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previous;
		}
	});

	it('url-encodes the project path of a GitLab remote and authenticates with GITLAB_TOKEN', async () => {
		const previous = process.env.GITLAB_TOKEN;
		process.env.GITLAB_TOKEN = 'gl-token';
		try {
			const fetcher = recordingFetcher([[]]);
			await new PullRequestDataSource(fetcher).getPullRequests('https://gitlab.com/group/sub/repo.git');
			assert.equal(fetcher.calls[0].url, 'https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/merge_requests?state=all&per_page=100');
			assert.equal(fetcher.calls[0].headers['PRIVATE-TOKEN'], 'gl-token');
		} finally {
			if (previous === undefined) delete process.env.GITLAB_TOKEN;
			else process.env.GITLAB_TOKEN = previous;
		}
	});

	it('degrades to null on an unsupported remote or a failed request (never throws)', async () => {
		const fetcher = recordingFetcher([new Error('HTTP 404'), new Error('request timed out')]);
		const source = new PullRequestDataSource(fetcher);
		assert.equal(await source.getPullRequests('/some/local/path'), null);
		assert.equal(fetcher.calls.length, 0); // an unsupported remote is never queried
		assert.equal(await source.getPullRequests('https://github.com/owner/repo.git'), null);
	});
});

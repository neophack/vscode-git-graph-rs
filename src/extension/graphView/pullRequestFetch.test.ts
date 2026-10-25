import { describe, expect, it, vi } from 'vitest';
import type { PullRequestInfo } from '../../types';
import { fetchPullRequestHeadRefs, fetchPullRequests } from './pullRequestFetch';
import type { PullRequestFetchDeps } from './pullRequestFetch';

/**
 * Pull-request fetch orchestration tests (REFACTOR-PLAN task 4.4): the degradation ladder
 * (integration disabled / no hosted remote / failed request), the completeness flag a failed
 * request must not claim, and the head-ref fetch + prune sequence - all against injected git
 * and HTTP reads, ported from the behaviors the GitGraphView methods carried.
 */

function pr(number: number): PullRequestInfo {
	return { number: number, title: 'pr ' + number, state: 'open', author: 'a', url: 'u', sourceBranch: 'topic', targetBranch: 'main', headHash: 'h' + number, body: '' };
}

const GITHUB_REMOTE_V = 'origin\thttps://github.com/owner/repo.git (fetch)\norigin\thttps://github.com/owner/repo.git (push)\n';

/** The configurable halves of the harness. */
interface HarnessOptions {
	/** Raw stdout per git invocation (the default: the GitHub remote, no existing prs refs). */
	answers?(args: string[]): string | null;
	/** The HTTP result of loading the remote's pull requests. */
	loadPullRequests?: PullRequestFetchDeps['loadPullRequests'];
	isEnabled?: () => boolean;
}

/**
 * The deps harness: a gitOutput fake answering raw stdout per command and resolving it through
 * the caller's parser (exactly as the real gitOutput does), plus a recording logger.
 */
function harness(options: HarnessOptions = {}): PullRequestFetchDeps & { calls: string[][], logs: string[] } {
	const calls: string[][] = [];
	const logs: string[] = [];
	const answers = options.answers || (() => {
		return null;
	});
	const deps: PullRequestFetchDeps = {
		gitOutput: ((args: string[], _repo: string, resolveValue: (stdout: string) => unknown) => {
			calls.push(args);
			const answer = args[0] === 'remote' && args[1] === '-v' ? GITHUB_REMOTE_V : answers(args);
			return Promise.resolve(resolveValue(answer === null ? '' : answer));
		}) as PullRequestFetchDeps['gitOutput'],
		loadPullRequests: options.loadPullRequests || vi.fn(async () => ({ prs: [pr(1)], complete: true })),
		isEnabled: options.isEnabled || (() => true),
		logger: { log(message: string) { logs.push(message); } }
	};
	return Object.assign(deps, { calls: calls, logs: logs });
}

describe('fetchPullRequests', () => {
	it('degrades to NULL without any git access when the integration is disabled', async () => {
		const d = harness({ isEnabled: () => false });
		expect(await fetchPullRequests(d, '/repo')).toBeNull();
		expect(d.calls.length).toBe(0);
	});

	it('degrades to NULL with a log line when no remote is hosted on GitHub or GitLab', async () => {
		const d = harness({ answers: () => null, loadPullRequests: vi.fn(async () => null) });
		// A local-path remote answers the remote -v read itself
		(d as unknown as { gitOutput: PullRequestFetchDeps['gitOutput'] }).gitOutput = ((args: string[], _repo: string, resolveValue: (stdout: string) => unknown) => {
			d.calls.push(args);
			return Promise.resolve(resolveValue('origin\t/srv/git/repo (fetch)\n'));
		}) as PullRequestFetchDeps['gitOutput'];
		expect(await fetchPullRequests(d, '/repo')).toBeNull();
		expect(d.logs.some((line) => line.indexOf('no remote of the repository is hosted') !== -1)).toBe(true);
	});

	it('returns the remote and its requests when the platform request succeeds', async () => {
		const d = harness();
		const remote = await fetchPullRequests(d, '/repo');
		expect(remote).toEqual({ name: 'origin', url: 'https://github.com/owner/repo.git', prs: [pr(1)], complete: true });
		expect(d.logs.some((line) => line.indexOf('1 request(s)') !== -1)).toBe(true);
	});

	it('reports a FAILED request as an empty but incomplete list (so nothing gets pruned)', async () => {
		const d = harness({ loadPullRequests: vi.fn(async () => null) });
		const remote = await fetchPullRequests(d, '/repo');
		expect(remote).toEqual({ name: 'origin', url: 'https://github.com/owner/repo.git', prs: [], complete: false });
		expect(d.logs.some((line) => line.indexOf('request for https://github.com/owner/repo.git failed') !== -1)).toBe(true);
	});

	it('degrades to NULL when the git remote read itself throws', async () => {
		const d = harness();
		(d as unknown as { gitOutput: PullRequestFetchDeps['gitOutput'] }).gitOutput = (() => Promise.reject(new Error('no git'))) as PullRequestFetchDeps['gitOutput'];
		expect(await fetchPullRequests(d, '/repo')).toBeNull();
		expect(d.logs.some((line) => line.indexOf('Pull requests unavailable: no git') !== -1)).toBe(true);
	});
});

describe('fetchPullRequestHeadRefs', () => {
	it('fetches the open pull requests\' head refs and prunes the closed ones', async () => {
		const d = harness({ answers: (args) => args[0] === 'for-each-ref' ? 'refs/remotes/origin/prs/2\nrefs/remotes/origin/prs/1\n' : null });
		await fetchPullRequestHeadRefs(d, '/repo', { name: 'origin', url: 'https://github.com/owner/repo.git', prs: [pr(1)], complete: true });
		// The ref of the closed pr 2 is deleted; the open pr 1's ref is (re)fetched
		expect(d.calls.some((args) => args[0] === 'update-ref' && args[1] === '-d' && args[2] === 'refs/remotes/origin/prs/2')).toBe(true);
		expect(d.calls.some((args) => args[0] === 'fetch' && args[1] === '--no-tags' && args[2] === 'origin'
			&& args.some((arg) => arg.indexOf('refs/remotes/origin/prs/1') !== -1))).toBe(true);
		expect(d.logs.some((line) => line.indexOf('open pull request(s)') !== -1)).toBe(true);
		expect(d.logs.some((line) => line.indexOf('no longer open') !== -1)).toBe(true);
	});

	it('prunes nothing when the list is incomplete (a failed request knows nothing)', async () => {
		const d = harness({ answers: (args) => args[0] === 'for-each-ref' ? 'refs/remotes/origin/prs/2\n' : null });
		await fetchPullRequestHeadRefs(d, '/repo', { name: 'origin', url: 'https://github.com/owner/repo.git', prs: [], complete: false });
		expect(d.calls.some((args) => args[0] === 'update-ref')).toBe(false);
	});

	it('logs and swallows a failing head-ref fetch', async () => {
		const d = harness();
		(d as unknown as { gitOutput: PullRequestFetchDeps['gitOutput'] }).gitOutput = (() => Promise.reject(new Error('fetch refused'))) as PullRequestFetchDeps['gitOutput'];
		await expect(fetchPullRequestHeadRefs(d, '/repo', { name: 'origin', url: 'https://github.com/owner/repo.git', prs: [pr(1)], complete: true })).resolves.toBeUndefined();
		expect(d.logs.some((line) => line.indexOf('head refs failed: fetch refused') !== -1)).toBe(true);
	});
});

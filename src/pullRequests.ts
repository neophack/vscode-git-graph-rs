import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { PullRequestInfo, PullRequestState } from './types';

/** The timeout of pull request API requests, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10000;

/** The hosting platforms supported by the pull request integration. */
export type PullRequestPlatform = 'github' | 'gitlab';

/** A remote repository hosted on GitHub or GitLab, parsed from its remote URL. */
export interface ParsedRemote {
	platform: PullRequestPlatform;
	/** The base URL of the REST API (no trailing slash), e.g. "https://api.github.com" or "https://gitlab.example.com/api/v4". */
	apiBase: string;
	owner: string;
	repo: string;
}

/**
 * Parse a Git remote URL into the hosting platform, API base and owner/repo.
 * Supports GitHub (github.com) and GitLab (gitlab.com or a self-hosted instance),
 * over both HTTPS and SSH remote URLs.
 * @param url The remote URL (e.g. "https://github.com/owner/repo.git" or "git@gitlab.com:group/repo.git").
 * @returns The parsed remote, or NULL if the URL isn't a supported GitHub/GitLab remote.
 */
export function parseRemoteUrl(url: string): ParsedRemote | null {
	if (typeof url !== 'string' || url === '') return null;
	let host = '', path = '';
	const httpsMatch = /^https?:\/\/([^\/]+)\/(.+)$/.exec(url.trim());
	const sshMatch = /^git@([^:]+):(.+)$/.exec(url.trim());
	const sshUrlMatch = /^ssh:\/\/git@([^\/]+)\/(.+)$/.exec(url.trim());
	if (httpsMatch !== null) {
		host = httpsMatch[1].toLowerCase();
		path = httpsMatch[2];
	} else if (sshMatch !== null) {
		host = sshMatch[1].toLowerCase();
		path = sshMatch[2];
	} else if (sshUrlMatch !== null) {
		host = sshUrlMatch[1].toLowerCase();
		path = sshUrlMatch[2];
	} else {
		return null;
	}
	path = path.replace(/\/+$/, '').replace(/\.git$/, '');
	// Strip Gerrit's authenticated prefix and GitLab's nested groups down to owner/repo
	// (GitLab projects in subgroups keep their full path for the API, GitHub takes owner/repo)
	const segments = path.split('/').filter((segment) => segment !== '');
	if (segments.length < 2) return null;
	if (host === 'github.com') {
		return { platform: 'github', apiBase: 'https://api.github.com', owner: segments[0], repo: segments[1] };
	}
	// GitLab (gitlab.com or a self-hosted instance): the full project path is url-encoded
	return { platform: 'gitlab', apiBase: 'https://' + host + '/api/v4', owner: segments[0], repo: segments.join('/') };
}

/**
 * Parse the response of GitHub's `GET /repos/{owner}/{repo}/pulls` API.
 * @param body The parsed JSON response body.
 * @returns The pull requests (invalid entries are skipped).
 */
export function parseGithubPulls(body: any): PullRequestInfo[] {
	if (!Array.isArray(body)) return [];
	const pulls: PullRequestInfo[] = [];
	for (const pr of body) {
		if (pr === null || typeof pr !== 'object' || typeof pr.number !== 'number' || typeof pr.title !== 'string') continue;
		pulls.push({
			number: pr.number,
			title: pr.title,
			state: githubState(pr),
			author: pr.user && typeof pr.user.login === 'string' ? pr.user.login : '',
			url: typeof pr.html_url === 'string' ? pr.html_url : '',
			sourceBranch: pr.head && typeof pr.head.ref === 'string' ? pr.head.ref : '',
			targetBranch: pr.base && typeof pr.base.ref === 'string' ? pr.base.ref : '',
			headHash: pr.head && typeof pr.head.sha === 'string' ? pr.head.sha : '',
			body: typeof pr.body === 'string' ? pr.body : ''
		});
	}
	return pulls;
}

function githubState(pr: any): PullRequestState {
	if (pr.draft === true) return 'draft';
	if (pr.merged_at !== null && pr.merged_at !== undefined) return 'merged';
	if (pr.state === 'closed') return 'closed';
	return 'open';
}

/**
 * Parse the response of GitLab's `GET /projects/{id}/merge_requests` API.
 * @param body The parsed JSON response body.
 * @returns The merge requests (invalid entries are skipped).
 */
export function parseGitlabMergeRequests(body: any): PullRequestInfo[] {
	if (!Array.isArray(body)) return [];
	const mrs: PullRequestInfo[] = [];
	for (const mr of body) {
		if (mr === null || typeof mr !== 'object' || typeof mr.iid !== 'number' || typeof mr.title !== 'string') continue;
		mrs.push({
			number: mr.iid,
			title: mr.title,
			state: gitlabState(mr),
			author: mr.author && typeof mr.author.name === 'string' ? mr.author.name : (mr.author && typeof mr.author.username === 'string' ? mr.author.username : ''),
			url: typeof mr.web_url === 'string' ? mr.web_url : '',
			sourceBranch: typeof mr.source_branch === 'string' ? mr.source_branch : '',
			targetBranch: typeof mr.target_branch === 'string' ? mr.target_branch : '',
			headHash: typeof mr.sha === 'string' ? mr.sha : '',
			body: typeof mr.description === 'string' ? mr.description : ''
		});
	}
	return mrs;
}

function gitlabState(mr: any): PullRequestState {
	if (mr.work_in_progress === true) return 'draft';
	if (mr.state === 'merged') return 'merged';
	if (mr.state === 'closed') return 'closed';
	return 'open';
}

/** The maximum number of open pull requests whose head commits are fetched into the repository. */
const MAX_FETCHED_PULL_REQUEST_HEADS = 25;

/**
 * The refspecs that fetch the head commits of the still-open pull requests into the repository
 * (under refs/remotes/&lt;remote&gt;/prs/), so that pull requests opened from a fork - whose
 * commits the repository wouldn't otherwise have - appear in the Git Graph View.
 * @param remoteName The name of the Git remote to fetch from.
 * @param remote The parsed remote (its platform decides the source ref namespace), or NULL.
 * @param prs The pull requests of the remote (as returned by the parse functions).
 * @returns The refspecs (empty when the remote isn't GitHub/GitLab or no request is open).
 */
export function buildPullRequestHeadRefspecs(remoteName: string, remote: ParsedRemote | null, prs: ReadonlyArray<PullRequestInfo>): string[] {
	if (remote === null) return [];
	const sourcePrefix = remote.platform === 'github' ? 'refs/pull/' : 'refs/merge-requests/';
	const refspecs: string[] = [];
	for (const pr of prs) {
		if (pr.state !== 'open' && pr.state !== 'draft') continue;
		if (refspecs.length >= MAX_FETCHED_PULL_REQUEST_HEADS) break;
		refspecs.push('+' + sourcePrefix + pr.number + '/head:refs/remotes/' + remoteName + '/prs/' + pr.number);
	}
	return refspecs;
}

/**
 * Of the pull request head refs already in the repository, the ones whose pull request is no
 * longer open (closed requests are pruned; merged ones keep their commits in the graph).
 * @param existingRefs The existing refs under refs/remotes/<remote>/prs/ (as `refs/remotes/<remote>/prs/<number>`).
 * @param remoteName The name of the Git remote the refs were fetched from.
 * @param prs The pull requests of the remote (as returned by the parse functions).
 * @returns The refs to delete.
 */
export function findStalePullRequestRefs(existingRefs: ReadonlyArray<string>, remoteName: string, prs: ReadonlyArray<PullRequestInfo>): string[] {
	const openOrMerged = new Set(prs.filter((pr) => pr.state === 'open' || pr.state === 'draft' || pr.state === 'merged').map((pr) => String(pr.number)));
	const prefix = 'refs/remotes/' + remoteName + '/prs/';
	const stale: string[] = [];
	for (const ref of existingRefs) {
		const number = ref.startsWith(prefix) ? ref.substring(prefix.length) : '';
		if (number !== '' && !openOrMerged.has(number)) stale.push(ref);
	}
	return stale;
}

/**
 * Parse the output of `git remote -v` into the repository's remotes.
 * @param stdout The output of `git remote -v` (a "name\turl (fetch)" and "name\turl (push)" line per remote URL).
 * @returns The remotes, one entry per name (the fetch URL; entries are deduplicated by name).
 */
export function parseGitRemoteVerbose(stdout: string): Array<{ name: string, url: string }> {
	const remotes: Array<{ name: string, url: string }> = [];
	for (const line of stdout.split('\n')) {
		const parts = line.trim().split('\t');
		if (parts.length !== 2) continue;
		const name = parts[0], url = parts[1].replace(/ \((?:fetch|push)\)$/, '');
		if (name === '' || remotes.some((remote) => remote.name === name)) continue;
		remotes.push({ name: name, url: url });
	}
	return remotes;
}

/**
 * Select the remote to query for pull requests: `origin` when it is hosted on a supported
 * platform, otherwise the first remote that is (a repository whose GitHub/GitLab remote is named
 * differently must still get its pull requests).
 * @param remotes The repository's remotes (as returned by parseGitRemoteVerbose).
 * @returns The selected remote (its name is needed for fetching, its URL for the API), or NULL when no remote is hosted on a supported platform.
 */
export function selectRemote(remotes: ReadonlyArray<{ name: string, url: string }>): { name: string, url: string } | null {
	let fallback: { name: string, url: string } | null = null;
	for (const remote of remotes) {
		if (parseRemoteUrl(remote.url) === null) continue;
		if (remote.name === 'origin') return remote;
		if (fallback === null) fallback = remote;
	}
	return fallback;
}

/**
 * Fetch a JSON document over HTTPS.
 * @param url The URL to fetch.
 * @param headers The request headers (e.g. authentication).
 * @param timeoutMs The request timeout in milliseconds.
 * @returns The parsed JSON body, rejected on any failure (non-2xx status, timeout, invalid JSON).
 */
export function fetchJson(url: string, headers: { [name: string]: string }, timeoutMs: number): Promise<any> {
	return new Promise<any>((resolve, reject) => {
		const target = new URL(url);
		let settled = false;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			callback();
		};
			// An ABSOLUTE deadline: request.setTimeout only covers socket inactivity, so a hung DNS
			// lookup or connect would otherwise leave the promise pending forever (no error, no badge).
			// Created only after the request: if https.get threw synchronously, the timer would fire
			// on an uninitialized `request` and crash the extension host with a ReferenceError.
			const request = https.get({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port,
			path: target.pathname + target.search,
			headers: headers
		}, (response: http.IncomingMessage) => {
			const status = response.statusCode === undefined ? 0 : response.statusCode;
			if (status < 200 || status >= 300) {
				response.resume();
				settle(() => reject('HTTP ' + status));
				return;
			}
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => settle(() => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (_) {
					reject('invalid JSON response');
				}
			}));
			response.on('error', (error) => settle(() => reject(error)));
		});
			request.on('error', (error) => settle(() => reject(error)));
			const deadline = setTimeout(() => {
				request.destroy(new Error('request timed out'));
			}, timeoutMs);
	});
}

/** A JSON fetcher (injectable for testing). */
export type JsonFetcher = (url: string, headers: { [name: string]: string }, timeoutMs: number) => Promise<any>;

/**
 * Provides pull/merge request data from GitHub and GitLab REST APIs.
 * Every public method degrades to NULL on any failure (never throws), so the
 * Git Graph View works unchanged when the API is unreachable or unauthorised.
 */
export class PullRequestDataSource {
	private readonly fetchJson: JsonFetcher;

	constructor(fetcher: JsonFetcher = fetchJson) {
		this.fetchJson = fetcher;
	}

	/**
	 * Get the pull/merge requests of a remote repository.
	 * @param remoteUrl The URL of the Git remote.
	 * @returns The pull requests, or NULL if the platform isn't supported or the request failed.
	 */
	public async getPullRequests(remoteUrl: string): Promise<PullRequestInfo[] | null> {
		const remote = parseRemoteUrl(remoteUrl);
		if (remote === null) return null;
		try {
			if (remote.platform === 'github') {
				const token = process.env.GITHUB_TOKEN;
				const headers: { [name: string]: string } = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'git-graph-rs' };
				if (token) headers['Authorization'] = 'Bearer ' + token;
				return parseGithubPulls(await this.fetchJson(remote.apiBase + '/repos/' + remote.owner + '/' + remote.repo + '/pulls?state=all&per_page=100', headers, REQUEST_TIMEOUT_MS));
			}
			const token = process.env.GITLAB_TOKEN;
			const headers: { [name: string]: string } = { 'User-Agent': 'git-graph-rs' };
			if (token) headers['PRIVATE-TOKEN'] = token;
			// state=all like GitHub: a merged or closed request must stay in the list, or the refs
			// of merged requests would be pruned by findStalePullRequestRefs (which keeps them
			// deliberately, so their commits stay in the graph)
			return parseGitlabMergeRequests(await this.fetchJson(remote.apiBase + '/projects/' + encodeURIComponent(remote.repo) + '/merge_requests?state=all&per_page=100', headers, REQUEST_TIMEOUT_MS));
		} catch (_) {
			return null; // silent degradation (e.g. anonymous access to a private repository, or no network)
		}
	}
}

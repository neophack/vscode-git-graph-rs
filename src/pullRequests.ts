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
			sourceBranch: pr.head && typeof pr.head.ref === 'string' ? pr.head.ref : ''
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
			sourceBranch: typeof mr.source_branch === 'string' ? mr.source_branch : ''
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

/**
 * Find the pull/merge request whose source branch matches the given branch name.
 * @param pulls The pull requests (as returned by the parse functions).
 * @param branch The branch name.
 * @returns The first matching pull request, or NULL if none matches.
 */
export function findPullRequestForBranch(pulls: ReadonlyArray<PullRequestInfo>, branch: string): PullRequestInfo | null {
	for (const pr of pulls) {
		if (pr.sourceBranch === branch) return pr;
	}
	return null;
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
				reject('HTTP ' + status);
				return;
			}
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (_) {
					reject('invalid JSON response');
				}
			});
			response.on('error', reject);
		});
		request.on('error', reject);
		request.setTimeout(timeoutMs, () => request.destroy(new Error('request timed out')));
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
			return parseGitlabMergeRequests(await this.fetchJson(remote.apiBase + '/projects/' + encodeURIComponent(remote.repo) + '/merge_requests?state=opened&per_page=100', headers, REQUEST_TIMEOUT_MS));
		} catch (_) {
			return null; // silent degradation (e.g. anonymous access to a private repository, or no network)
		}
	}

	/**
	 * Get the pull/merge request whose source branch matches the given branch.
	 * @param remoteUrl The URL of the Git remote.
	 * @param branch The branch name.
	 * @returns The matching pull request, or NULL if none was found (or the request failed).
	 */
	public async getPullRequestForBranch(remoteUrl: string, branch: string): Promise<PullRequestInfo | null> {
		const pulls = await this.getPullRequests(remoteUrl);
		return pulls === null ? null : findPullRequestForBranch(pulls, branch);
	}
}

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { resolve as resolveUrl } from 'url';
import { ErrorInfo } from '../../../shared/protocol/messages';
import { GerritChangeState } from '../../../shared/model/gerrit';
import { evalPromises } from '../../git/process/childProcess';
import type { AbortLike } from '../../git/process/gitProcess';
import { createAbortController } from '../../git/process/gitProcess';
import { buildKeepPatterns, changeShard, chunkFetchRefspecs, gerritRemoteServer, MetaCommitRecord, parseLsRemoteChanges, parseMetaHistory } from './gerritProtocol';

/**
 * Provides Gerrit integration data (change refs + NoteDb meta refs), all obtained via the Git
 * protocol.
 *
 * The pure parsing half of the integration — change refs, NoteDb metas, status filtering and the
 * sampling schedule — lives in `gerritProtocol.ts`; this module is the
 * data source that fetches, caches and schedules it.
 */

/**
 * A minimal structural interface for running Git commands (satisfied by the raw Git runner the
 * composition root and the panel wire in).
 */
export interface GitRunner {
	/** Spawn Git, resolving the value parsed out of its stdout; rejecting when it fails. The optional signal kills the child on abort. */
	gitOutput: <T>(args: string[], repo: string, resolveValue: { (stdout: string): T }, signal?: AbortLike) => Promise<T>;
	/** Run a Git command, resolving the `ErrorInfo` (NULL => success). The optional signal kills the child on abort. */
	runGitCommand: (args: string[], repo: string, signal?: AbortLike) => Promise<ErrorInfo>;
	runGitCommandWithInput: (args: string[], repo: string, input: string) => Promise<ErrorInfo>;
	/**
	 * The Rust-engine NoteDb meta parser: one native call parses every requested
	 * meta history in-process. Optional (absent in stand-in runners, e.g. the tests'): without it —
	 * or when it resolves NULL — the `git log` pool below serves the parse.
	 */
	parseGerritMetas?: (repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null) => Promise<Map<number, GerritChangeState | null> | null>;
	/**
	 * The Rust-engine change-ref scan: one native call resolves every
	 * `refs/remotes/<remote>/changes/**` refname and hash in-process. Optional (absent in stand-in
	 * runners, e.g. the tests'): without it — or when it resolves NULL — the `git for-each-ref`
	 * commands below serve the listing.
	 */
	listChangeRefHashes?: (repo: string, remote: string) => Promise<Map<string, string> | null>;
}

/** The maximum number of NoteDb meta histories parsed by concurrent Git commands. */
const META_PARSE_CONCURRENCY = 8;
/** The maximum number of parsed NoteDb states retained in the in-memory cache (LRU). */
const META_CACHE_LIMIT = 500;

/** The default timeout of remote Gerrit operations (ls-remote / fetch), in milliseconds (<= 0 => disabled). */
const DEFAULT_REMOTE_TIMEOUT_MS = 60000;
/** The Git hooks Gerrit serves under <origin>/tools/hooks/. */
const GERRIT_HOOK_FILES = ['commit-msg'];
/** The maximum number of HTTP redirects followed when downloading a file. */
const HTTP_REDIRECT_LIMIT = 3;

/**
 * Download a file over HTTP(S), following up to HTTP_REDIRECT_LIMIT redirects.
 *
 * A redirect may not step down from https to http: the caller chose a channel that
 * authenticates the server, and the server's own answer cannot revoke that choice.
 * @param url The URL to download.
 * @param redirectsRemaining The remaining redirect budget.
 * @returns The file contents.
 */
function downloadFile(url: string, redirectsRemaining: number): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const request = (/^https:/i.test(url) ? https : http).get(url, (response: http.IncomingMessage) => {
			const status = response.statusCode === undefined ? 0 : response.statusCode;
			if (status >= 300 && status < 400 && response.headers.location !== undefined) {
				response.resume(); // discard the body of the redirect response
				if (redirectsRemaining <= 0) {
					reject('too many redirects');
				} else {
					const target = resolveUrl(response.headers.location, url);
					if (/^https:/i.test(url) && !/^https:/i.test(target)) {
						reject('the server redirected the download off HTTPS (to ' + target + ')');
						return;
					}
					downloadFile(target, redirectsRemaining - 1).then(resolve, reject);
				}
				return;
			}
			if (status < 200 || status >= 300) {
				response.resume();
				reject('HTTP ' + status);
				return;
			}
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve(Buffer.concat(chunks)));
			response.on('error', reject);
		});
		request.on('error', reject);
		request.setTimeout(DEFAULT_REMOTE_TIMEOUT_MS, () => request.destroy(new Error('request timed out')));
	});
}

/** The engine fast paths a shared runner carries, in their array-shaped form. */
export interface RunnerEngineFastPaths {
	/** The Rust-engine NoteDb meta parser (array-shaped, one entry per requested change). */
	parseGerritMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<ReadonlyArray<GerritChangeState | null>>;
	/** The Rust-engine change-ref scan, as `[refname, hash]` pairs. */
	listChangeRefs(repo: string, remote: string): Promise<ReadonlyArray<readonly [string, string]>>;
}

/**
 * A Gerrit data source over the shared raw runner (the graph view's `GitRunnerPort`, taken
 * structurally so this module does not depend on `graphView/`): the runner's engine fast paths
 * answer in array shapes, which the `GitRunner` seam above consumes as Maps, so the two results
 * are adapted here (the same adaptation the panel performs inline).
 */
export function gerritDataSourceOver(runner: {
	gitOutput: GitRunner['gitOutput'];
	runGitCommand: GitRunner['runGitCommand'];
	runGitCommandWithInput: GitRunner['runGitCommandWithInput'];
	parseGerritMetas: RunnerEngineFastPaths['parseGerritMetas'] | null;
	listChangeRefs: RunnerEngineFastPaths['listChangeRefs'] | null;
}): GerritDataSource {
	const engineMetas = runner.parseGerritMetas;
	const engineChangeRefs = runner.listChangeRefs;
	return new GerritDataSource({
		gitOutput: runner.gitOutput,
		runGitCommand: runner.runGitCommand,
		runGitCommandWithInput: runner.runGitCommandWithInput,
		parseGerritMetas: engineMetas === null ? undefined : async (repo, remote, changes, urlBase) => {
			const states = await engineMetas(repo, remote, changes, urlBase);
			const parsed = new Map<number, GerritChangeState | null>();
			states.forEach((state, index) => parsed.set(changes[index], state));
			return parsed;
		},
		listChangeRefHashes: engineChangeRefs === null ? undefined : async (repo, remote) => {
			const refs = await engineChangeRefs(repo, remote);
			const hashes = new Map<string, string>();
			for (const [ref, hash] of refs) hashes.set(ref, hash);
			return hashes;
		}
	});
}

export class GerritDataSource {
	private readonly git: GitRunner;
	private readonly remoteTimeoutMs: number;
	private readonly metaCache = new Map<string, GerritChangeState>(); // key = <repo>|<metaRef>|<hash>

	constructor(git: GitRunner, remoteTimeoutMs: number = DEFAULT_REMOTE_TIMEOUT_MS) {
		this.git = git;
		this.remoteTimeoutMs = remoteTimeoutMs;
	}

	/**
	 * Run a remote Git operation under the remote timeout: when the timer fires, the operation's
	 * abort token is tripped, which KILLS the underlying Git child (a stalled SSH/HTTP connection
	 * to the Gerrit remote must neither block the Git Graph View indefinitely nor leave orphaned
	 * children — an ssh of every timed-out refresh — running for the rest of the session).
	 * @param run The remote operation, receiving the run's abort token.
	 * @param fallback The value to resolve with if the operation times out or fails.
	 * @returns The promise of the operation, or the fallback after the timeout/failure.
	 */
	private async withTimeout<T>(run: (signal?: AbortLike) => Promise<T>, fallback: T): Promise<T> {
		if (this.remoteTimeoutMs <= 0) return run();
		const controller = createAbortController();
		const timer = setTimeout(() => controller.abort(), this.remoteTimeoutMs);
		try {
			return await run(controller.signal);
		} catch {
			return fallback;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Get a cached NoteDb meta state, refreshing the recency of the entry (the Map preserves
	 * insertion order, so recently used entries are evicted last).
	 */
	private getCachedMeta(cacheKey: string) {
		const cached = this.metaCache.get(cacheKey);
		if (cached !== undefined) {
			this.metaCache.delete(cacheKey);
			this.metaCache.set(cacheKey, cached);
		}
		return cached;
	}

	/**
	 * Cache a NoteDb meta state, evicting the least recently used entries when the cache is full.
	 */
	private setCachedMeta(cacheKey: string, state: GerritChangeState) {
		if (this.metaCache.size >= META_CACHE_LIMIT) {
			let toEvict = this.metaCache.size - META_CACHE_LIMIT + 1;
			for (const key of this.metaCache.keys()) {
				if (toEvict <= 0) break;
				this.metaCache.delete(key);
				toEvict--;
			}
		}
		this.metaCache.set(cacheKey, state);
	}

	/**
	 * List the open change refs on a remote (without fetching any objects).
	 */
	public listRemoteChanges(repo: string, remote: string) {
		return this.withTimeout(
			(signal) => this.git.gitOutput(['ls-remote', remote, 'refs/changes/*'], repo, (stdout) => parseLsRemoteChanges(stdout), signal),
			new Map<number, number[]>()
		);
	}

	/**
	 * Fetch the specified change refspecs from a remote into `refs/remotes/<remote>/changes/`.
	 * The refspecs are fetched in command-line-sized batches (see [`chunkFetchRefspecs`]), stopping
	 * at the first batch that fails.
	 */
	public async fetchChanges(repo: string, remote: string, refspecs: string[]): Promise<ErrorInfo> {
		if (refspecs.length === 0) return null;
		for (const batch of chunkFetchRefspecs(refspecs)) {
			const error = await this.withTimeout(
				(signal) => this.git.runGitCommand(['fetch', '--no-tags', remote].concat(batch), repo, signal),
				<ErrorInfo>'Fetching the Gerrit changes from the remote timed out.'
			);
			if (error !== null) return error;
		}
		return null;
	}

	/**
	 * List the local change refs (under `refs/remotes/<remote>/changes/`) of a repository.
	 *
	 * The Rust engine serves the refnames from a single in-process scan when available; the Git
	 * CLI (`git for-each-ref`) is only spawned as the fallback.
	 */
	public async listLocalChangeRefs(repo: string, remote: string): Promise<string[]> {
		const engine = this.git.listChangeRefHashes !== undefined ? await this.git.listChangeRefHashes(repo, remote) : null;
		if (engine !== null) return Array.from(engine.keys());
		return this.git.gitOutput(['for-each-ref', 'refs/remotes/' + remote + '/changes/', '--format=%(refname)'], repo, (stdout) =>
			stdout.split(/\r?\n/).map((ref) => ref.trim()).filter((ref) => ref !== '')
		).catch(() => <string[]>[]);
	}

	/**
	 * Resolve the current hash of every local change ref of a repository in a SINGLE Git command
	 * (used to look up NoteDb meta hashes in bulk, instead of one `rev-parse` process per ref).
	 *
	 * The Rust engine resolves them all in one in-process scan when available; the Git CLI
	 * (`git for-each-ref`) is only spawned as the fallback.
	 */
	public async listLocalChangeRefHashes(repo: string, remote: string): Promise<Map<string, string>> {
		const engine = this.git.listChangeRefHashes !== undefined ? await this.git.listChangeRefHashes(repo, remote) : null;
		if (engine !== null) return engine;
		return this.git.gitOutput(['for-each-ref', 'refs/remotes/' + remote + '/changes/', '--format=%(refname)%00%(objectname)'], repo, (stdout) => {
			const hashes = new Map<string, string>();
			for (const line of stdout.split(/\r?\n/)) {
				const separator = line.indexOf('\0');
				if (separator === -1) continue;
				const ref = line.substring(0, separator);
				if (ref !== '') hashes.set(ref, line.substring(separator + 1));
			}
			return hashes;
		}).catch(() => new Map<string, string>());
	}

	/**
	 * Delete local change refs of changes that aren't in the keep list (keeps the repository at a
	 * constant size). All of the stale refs are deleted by a single batched `git update-ref --stdin`
	 * command (one process instead of one process per ref).
	 * @returns The ErrorInfo of the pruning (NULL => all refs were pruned successfully).
	 */
	public async pruneLocalChanges(repo: string, remote: string, keepChanges: ReadonlyArray<number>): Promise<ErrorInfo> {
		const prefixes = buildKeepPatterns(keepChanges, remote);
		const refs = await this.listLocalChangeRefs(repo, remote);
		const staleRefs = refs.filter((ref) => !prefixes.some((prefix) => ref.startsWith(prefix)));
		if (staleRefs.length === 0) return null;
		return this.git.runGitCommandWithInput(['update-ref', '--stdin'], repo, staleRefs.map((ref) => 'delete ' + ref).join('\n') + '\n');
	}

	/**
	 * Delete ALL local change refs (under `refs/remotes/<remote>/changes/`) of a repository with a
	 * single batched `git update-ref --stdin` command (the batch is applied atomically by Git).
	 * @returns The number of refs deleted, and the ErrorInfo of the failure (NULL => all succeeded).
	 */
	public async clearLocalChanges(repo: string, remote: string): Promise<{ error: ErrorInfo; cleared: number }> {
		const refs = await this.listLocalChangeRefs(repo, remote);
		if (refs.length === 0) return { error: null, cleared: 0 };
		const error = await this.git.runGitCommandWithInput(['update-ref', '--stdin'], repo, refs.map((ref) => 'delete ' + ref).join('\n') + '\n');
		return { error: error, cleared: error === null ? refs.length : 0 };
	}

	/**
	 * Download a Git hook from the Gerrit server of the remote and install it into the repository's
	 * hooks directory (<git-dir>/hooks/<hook>).
	 * @param repo The path of the repository.
	 * @param remote The remote whose Gerrit server the hook is downloaded from.
	 * @param hook The hook file name to install (must be one of GERRIT_HOOK_FILES).
	 * @returns An error, or whether the hook was (re-)installed. TRUE => installed; FALSE => an identical hook was already present.
	 */
	public async installHook(repo: string, remote: string, hook: string): Promise<{ error: ErrorInfo; installed: boolean }> {
		if (!GERRIT_HOOK_FILES.includes(hook)) return { error: 'The hook "' + hook + '" cannot be downloaded from the Gerrit server.', installed: false };

		// Derive the Gerrit server's base URL (e.g. "https://gerrit.example.com") from the remote's
		// URL. A hook is an executable script this extension installs into the repository, so for an
		// ssh remote — which says nothing about the web interface's scheme — it is downloaded over
		// HTTPS and never over plain HTTP: the ssh remote the user chose authenticates the server,
		// and a hook fetched in the clear could be anything a network attacker wanted to run. An
		// http remote keeps its own scheme: its repository contents already arrive over that channel.
		const origin = await this.git.gitOutput(['remote', 'get-url', remote], repo, (stdout) => {
			const server = gerritRemoteServer(stdout);
			if (server === null) return null;
			return (server.scheme !== null ? server.scheme : 'https') + '://' + server.host;
		}).catch(() => null);
		if (origin === null) return { error: 'Unable to derive the Gerrit server URL from the remote "' + remote + '" (only http(s) and ssh remotes are supported).', installed: false };

		const hookUrl = origin + '/tools/hooks/' + hook;
		let content: string;
		try {
			content = (await downloadFile(hookUrl, HTTP_REDIRECT_LIMIT)).toString('utf8');
		} catch (errorMessage) {
			return { error: 'Unable to download the ' + hook + ' hook from ' + hookUrl + ': ' + errorMessage, installed: false };
		}
		if (!/^#!/.test(content.replace(/^\s+/, ''))) return { error: 'The file downloaded from ' + hookUrl + ' is not a valid hook script.', installed: false };

		const hooksDir = await this.getHooksDir(repo);
		if (hooksDir === null) return { error: 'Unable to determine the Git directory of the repository.', installed: false };

		const hookPath = path.join(hooksDir, hook);
		try {
			const existing = await fs.promises.readFile(hookPath, 'utf8').catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				return null;
			});
			if (existing === content) return { error: null, installed: false }; // an identical hook is already installed
			try {
				await fs.promises.access(hooksDir);
			} catch {
				await fs.promises.mkdir(hooksDir);
			}
			await fs.promises.writeFile(hookPath, content, { mode: 0o755 });
			await fs.promises.chmod(hookPath, 0o755); // the mode above is only applied when the file is created
		} catch (errorMessage) {
			return { error: 'Unable to write the ' + hook + ' hook to ' + hookPath + ': ' + errorMessage, installed: false };
		}
		return { error: null, installed: true };
	}

	/**
	 * Resolve the hooks directory of a repository.
	 * @returns The absolute hooks directory path, or NULL if it couldn't be determined.
	 */
	private async getHooksDir(repo: string): Promise<string | null> {
		// `git rev-parse --git-path hooks` resolves where git will actually execute hooks from:
		// `core.hooksPath` when set, else the COMMON dir's hooks — `<git-dir>/hooks` alone points
		// into a linked worktree's private directory and misses both (the returned path may be
		// relative to the repository).
		return this.git.gitOutput(['rev-parse', '--git-path', 'hooks'], repo, (stdout) => path.resolve(repo, stdout.trim())).catch(() => null);
	}

	/**
	 * Parse the NoteDb meta refs of many changes into their states, concurrently.
	 *
	 * The Rust engine answers first when one is available: a single native call walks and parses
	 * every requested meta history in-process, over the repository handle the engine keeps warm.
	 * Otherwise — no engine binary, or it failed — the Git fallback runs: a single Git command
	 * resolves the hash of every local change ref (so already-parsed metas are served from the
	 * cache without any further Git command), and the meta histories of the remaining changes are
	 * each parsed by their own Git command, run by a pool of concurrent workers (each parse is an
	 * independent read-only Git operation). This avoids the cost of running 2 sequential Git
	 * processes per change, which dominated the Git Graph View load time on large Gerrit
	 * repositories.
	 * @param repo The repository.
	 * @param remote The remote the changes were fetched from.
	 * @param changes The change numbers to parse.
	 * @param urlBase The base URL of the Gerrit instance (or NULL).
	 * @returns A map of change number to its state (NULL => the meta ref isn't available locally),
	 *          in the order of the `changes` input.
	 */
	public async parseMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<Map<number, GerritChangeState | null>> {
		const engine = this.git.parseGerritMetas;
		if (engine !== undefined) {
			const parsed = await engine.call(this.git, repo, remote, changes, urlBase);
			if (parsed !== null) return parsed;
		}

		const hashes = await this.listLocalChangeRefHashes(repo, remote);
		const results = new Map<number, GerritChangeState | null>();
		const pending: { change: number, metaRef: string, hash: string }[] = [];

		for (const change of changes) {
			const metaRef = 'refs/remotes/' + remote + '/changes/' + changeShard(change) + '/' + change + '/meta';
			const hash = hashes.get(metaRef);
			if (hash === undefined) {
				results.set(change, null); // meta ref not available locally
				continue;
			}
			const cached = this.getCachedMeta(this.metaCacheKey(repo, metaRef, hash, urlBase));
			if (cached !== undefined) {
				results.set(change, cached);
			} else {
				pending.push({ change: change, metaRef: metaRef, hash: hash });
			}
		}

		const parsed = await evalPromises(pending, META_PARSE_CONCURRENCY, (item) => this.parseMetaLog(repo, item.change, item.metaRef, item.hash, urlBase));
		pending.forEach((item, i) => results.set(item.change, parsed[i]));

		// Preserve the input order (the workers complete in a nondeterministic order)
		const ordered = new Map<number, GerritChangeState | null>();
		for (const change of changes) ordered.set(change, <GerritChangeState | null>results.get(change));
		return ordered;
	}

	/**
	 * The meta cache key: the meta ref's hash pins the parsed history, and the URL base is part
	 * of the key because the cached state carries the change's web URL — a base that changed
	 * mid-session (remote URL edited, previously unset) must not be served the stale entry.
	 */
	private metaCacheKey(repo: string, metaRef: string, hash: string, urlBase: string | null) {
		return repo + '|' + metaRef + '|' + hash + '|' + (urlBase === null ? '' : urlBase);
	}

	/**
	 * Parse the NoteDb meta history of a change into its state (cached by the meta ref's hash).
	 * @param repo The repository.
	 * @param change The change number.
	 * @param metaRef The full name of the NoteDb meta ref.
	 * @param hash The current hash of the meta ref (the cache key component).
	 * @param urlBase The base URL of the Gerrit instance (or NULL).
	 */
	private async parseMetaLog(repo: string, change: number, metaRef: string, hash: string, urlBase: string | null) {
		const cacheKey = this.metaCacheKey(repo, metaRef, hash, urlBase);
		const cached = this.getCachedMeta(cacheKey);
		if (cached !== undefined) return cached;

		const state = await this.git.gitOutput(
			['log', metaRef, '--format=' + ['%cN', '%ct', '%B'].join('%x1f') + '%x1e'],
			repo,
			(stdout) => {
				const records: MetaCommitRecord[] = [];
				for (const record of stdout.split('\x1e')) {
					const parts = record.split('\x1f');
					if (parts.length < 3) continue;
					records.push({ committer: parts[0].trim(), timestamp: parseInt(parts[1], 10), message: parts.slice(2).join('\x1f') });
				}
				return parseMetaHistory(change, records);
			}
		).catch(() => null);

		if (state === null) return null;
		state.url = urlBase !== null ? urlBase + change : null;
		this.setCachedMeta(cacheKey, state);
		return state;
	}

	/**
	 * Derive the web URL of a Gerrit change from the remote's URL.
	 * @returns The base URL (ending with "/c/<project>/+/"), or NULL if the remote URL isn't an HTTP(S) URL.
	 */
	public getChangeUrlBase(repo: string, remote: string) {
		return this.git.gitOutput(['remote', 'get-url', remote], repo, (stdout) => {
			const server = gerritRemoteServer(stdout);
			if (server === null || server.project === '') return null;
			// Strip Gerrit's authenticated prefix ("a/") from the project path; it is not part of the web UI URL
			const project = server.project.replace(/^a\//, '');
			// An ssh remote names no web scheme: the link is followed by the user's browser, which an
			// http-serving Gerrit answers and an https-only one redirects, so http stays the guess it
			// has always been here (the hook download above cannot take that risk, and does not)
			return (server.scheme !== null ? server.scheme : 'http') + '://' + server.host + '/c/' + project + '/+/';
		}).catch(() => null);
	}
}

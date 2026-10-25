/**
 * The Git backend interface, and the native implementation of it.
 *
 * This is the seam the rewrite is built around. The extension talks to `GitBackend` and nothing
 * else; which implementation is behind it — the Rust engine or the `git` command line — is chosen
 * once, at startup, by `backendIndex.ts`. That makes the migration incremental: a capability the
 * engine does not have yet is answered by the CLI without the calling code knowing.
 */

import { cancel, loadAddon, request } from './addonLoader';
import { GerritChangeState } from '../../../types';
import {
	GitActivityCell,
	GitAuthor,
	GitAuthorStat,
	GitBackendError,
	GitCommitData,
	GitCommitDetails,
	GitCommitFile,
	GitCommitStash,
	GitCommitSummary,
	GitConfigSnapshot,
	GitFileChange,
	GitHistoryMatch,
	GitLineCounts,
	GitRefData,
	GitRepoInfo,
	GitSignature,
	GitStash,
	GitTagDetails,
	LogOptions,
	RefReadOptions
} from './types';
import { EngineMethod, EngineMethods } from '../../../shared/engine/protocol';

/**
 * Everything the Git Graph View needs to read from a repository.
 *
 * Only the read path is defined here. Write operations (checkout, merge, rebase and the rest) stay
 * with the `git` CLI for now — they are where git's behaviour is most subtle, and getting the read
 * path right first is what makes the view fast.
 */
export interface GitBackend {
	/** A name for the backend, for diagnostics and the status bar. */
	readonly name: string;

	/**
	 * Open a repository, returning its root — what `git rev-parse --show-toplevel` prints.
	 *
	 * The handle is kept open afterwards, which is where the performance comes from: the pack
	 * indexes and the object cache stay resident instead of being re-read on every request.
	 */
	openRepository(path: string): Promise<string>;

	/** Release a repository handle. */
	closeRepository(path: string): void;

	/** Release every repository handle. */
	closeAllRepositories(): void;

	/** The branches, checked-out branch, tags, remotes and stashes the view opens with. */
	getRepoInfo(repo: string, options?: RefReadOptions): Promise<GitRepoInfo>;

	/** A page of the graph. */
	getCommits(repo: string, options: LogOptions): Promise<GitCommitData>;

	/** The refs of a repository, without the commits. */
	getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData>;

	/** One commit in full, with the files it changed — their statuses only, without line counts. */
	getCommitDetails(repo: string, hash: string): Promise<GitCommitDetails>;

	/**
	 * Verify one commit's signature with Git/GPG. The Rust engine does not implement the keyring
	 * integration, so it declines this capability and lets the CLI fallback answer it.
	 */
	getCommitSignature(repo: string, hash: string): Promise<GitSignature | null>;

	/**
	 * The `+N/-M` line counts of the given paths between two revisions, keyed by the path.
	 *
	 * `from` is null to diff `to` against its first parent (the Commit Details view), or a revision
	 * (the Commit Comparison view, or a stash's base). Binary files report null counts.
	 */
	getLineCounts(repo: string, from: string | null, to: string, paths: ReadonlyArray<string>): Promise<{ [path: string]: GitLineCounts }>;

	/** The "Uncommitted Changes" row in full. */
	getUncommittedDetails(repo: string): Promise<GitCommitDetails>;

	/** A stash entry in full. */
	getStashDetails(repo: string, hash: string, stash: GitCommitStash): Promise<GitCommitDetails>;

	/** The files that differ between two revisions; an empty `to` compares against the working tree. */
	compareCommits(repo: string, from: string, to: string): Promise<ReadonlyArray<GitFileChange>>;

	/** How many uncommitted changes there are. */
	getUncommittedChangeCount(repo: string, includeUntracked: boolean): Promise<number>;

	/** The stashes of a repository, newest first. */
	getStashes(repo: string): Promise<ReadonlyArray<GitStash>>;

	/** The configuration values the view consumes (remotes, user identity, push default, diff tools). */
	getConfig(repo: string): Promise<GitConfigSnapshot>;

	/** The contents of one file at one revision; `contents` is NULL when the file is binary. */
	getCommitFile(repo: string, hash: string, file: string): Promise<GitCommitFile>;

	/** The unified diff of one file in one commit (against its first parent). */
	getCommitFileDiff(repo: string, hash: string, file: string): Promise<string>;

	/** The full commit message of each of the given commits, keyed by hash. */
	getCommitBodies(repo: string, hashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }>;

	/** The subject of one commit, whitespace-normalised. */
	getCommitSubject(repo: string, hash: string): Promise<string>;

	/** The summary of each of the given commits, keyed by hash. */
	getCommitSummaries(
		repo: string,
		hashes: ReadonlyArray<string>
	): Promise<{ [hash: string]: GitCommitSummary }>;

	/** The commits whose message matches a pattern (extended, case-insensitive), newest first. */
	searchHistory(repo: string, query: string): Promise<ReadonlyArray<GitHistoryMatch>>;

	/** A tag in full: tagger, message, and whether it is signed. */
	getTagDetails(repo: string, tagName: string): Promise<GitTagDetails>;

	/** Verify one annotated tag's signature with Git/GPG. */
	getTagSignature(repo: string, tagName: string): Promise<GitSignature | null>;

	/** The fetch URL of a remote, or NULL when it is not configured. */
	getRemoteUrl(repo: string, remote: string): Promise<string | null>;

	/** Where a file was renamed to between a commit and the working tree, or NULL when it was not. */
	getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string): Promise<string | null>;

	/** The roots of the repository's initialised submodules. */
	getSubmodules(repo: string): Promise<ReadonlyArray<string>>;

	/** The upstream of the checked-out branch (`origin/main`), or NULL when there is none. */
	getCurrentBranchUpstream(repo: string): Promise<string | null>;

	/**
	 * How many commits are reachable from the given branches (or from every ref, when NULL) but
	 * not from `hash` — `git rev-list --count <refs> ^<hash>`.
	 */
	countCommitsBefore(
		repo: string,
		branches: ReadonlyArray<string> | null,
		hash: string,
		showRemoteBranches: boolean,
		includeCommitsMentionedByReflogs: boolean
	): Promise<number>;

	/** The root of the repository containing a path, as `git rev-parse --show-toplevel` prints. */
	repoRoot(path: string): Promise<string>;

	/** The names of the repository's remotes, as `git remote` lists them. */
	getRemotes(repo: string): Promise<ReadonlyArray<string>>;

	/** The distinct commit authors of the current branch's history (`git shortlog -s -n -e`). */
	getAuthors(repo: string): Promise<ReadonlyArray<GitAuthor>>;

	/** Commit counts per author across all refs, merge commits excluded (`git shortlog -sne --all --no-merges`). */
	getAuthorStatistics(repo: string): Promise<ReadonlyArray<GitAuthorStat>>;

	/** The commit-activity heatmap (author-local weekday/hour) across all refs, merge commits excluded. */
	getActivityHeatmap(repo: string): Promise<ReadonlyArray<GitActivityCell>>;

	/** The config entries of one location, last value per key (`git config --list -z --includes`). */
	getConfigList(repo: string, location: 'local' | 'global'): Promise<{ [key: string]: string }>;

	/** The checked-out branch's short name, or NULL when HEAD is detached. */
	currentBranchName(repo: string): Promise<string | null>;
}

/** The defaults a view load uses when the caller does not say otherwise. */
const DEFAULT_REF_OPTIONS: Required<RefReadOptions> = {
	showRemoteBranches: true,
	showRemoteHeads: false,
	hideRemotes: [],
	showChangeRefs: false,
	showStashes: true
};

/**
 * One engine request in flight, together with the handle that cancels it (task 2.9).
 *
 * This is the shape the host scheduler (task 4.8) consumes: it issues a request, hands the
 * promise to whoever waits, and calls `cancel()` when a newer request of the same kind
 * supersedes this one. Cancelling is safe at any point in the request's life — see
 * {@link cancel} in `addon.ts`.
 */
export interface CancellableRequest<T> {
	/** The request's eventual answer or `GitBackendError` (kind `Cancelled` when cancelled). */
	readonly promise: Promise<T>;
	/** Ask the engine to stop the request; the promise then rejects with kind `Cancelled`. */
	cancel(): void;
}

/** The next request id, so callers that cancel never reuse an in-flight id. */
let nextRequestId = 1;

/** A fresh request id for {@link startCancellableRequest} (ids are unique per session). */
export function issueRequestId(): number {
	return nextRequestId++;
}

/**
 * Issue one engine request the caller can cancel (task 2.9), through the same typed seam as
 * `NativeBackend`'s methods. Not wired into the backend itself yet — the host scheduler (4.8)
 * decides which calls run under cancellation.
 */
export function startCancellableRequest<M extends EngineMethod>(
	repo: string,
	method: M,
	params: EngineMethods[M]['params'],
	requestId: number = issueRequestId(),
	root?: string
): CancellableRequest<EngineMethods[M]['result']> {
	return {
		promise: request(repo, method, params, root, { requestId }),
		cancel: () => cancel(requestId, root)
	};
}

/**
 * The Rust engine, reached through the native addon.
 *
 * Every method is one call across the boundary through the single typed request seam — never a
 * call per commit or per ref, which is what made the original extension's
 * process-per-question design expensive, and never a hand-written binding per method: the method
 * names, their parameters and their results are all fixed by the generated protocol
 * (`src/shared/engine/protocol.ts`), so this class only maps the `GitBackend` vocabulary onto it.
 */
export class NativeBackend implements GitBackend {
	public readonly name = 'rust';

	private readonly addon = loadAddon();

	/** The engine's version, for the diagnostics output. */
	public get version(): string {
		return this.addon.engineVersion();
	}

	public openRepository(path: string): Promise<string> {
		return request(path, 'open', {});
	}

	public closeRepository(path: string): void {
		this.addon.close(path);
	}

	public closeAllRepositories(): void {
		this.addon.closeAll();
	}

	/** How many repositories are currently held open. Exposed for the tests. */
	public get openRepositoryCount(): number {
		return this.addon.openCount();
	}

	public getRepoInfo(repo: string, options?: RefReadOptions): Promise<GitRepoInfo> {
		// The wire type ts-rs generates is all-required while the engine's serde defaults would
		// fill an omitted field anyway; the merge always produces every field, so the cast only
		// names that agreement rather than asserting anything about the caller's input.
		const payload = { ...DEFAULT_REF_OPTIONS, ...options } as EngineMethods['loadRepoInfo']['params'];
		return request(repo, 'loadRepoInfo', payload);
	}

	public getCommits(repo: string, options: LogOptions): Promise<GitCommitData> {
		// Custom Branch Glob Patterns (`--glob=…`) cannot reach the engine's walk: its tip
		// resolution skips what it cannot resolve, so a glob-only selection would come back as an
		// empty graph without any error (count_commits_before declines the same request). Decline
		// here instead, so the fallback routes the load to the git CLI, which serves it.
		if (options.branches?.some((branch) => branch.startsWith('--glob='))) {
			return Promise.reject(new GitBackendError('Unsupported', 'Custom branch glob patterns (--glob=) require the git CLI backend'));
		}
		// Unlike getRepoInfo/getRefs above, this payload isn't merged onto DEFAULT_REF_OPTIONS, so
		// an omitted showRemoteBranches would otherwise fall back to the engine's bare `false`
		// (via serde's derived default) instead of the CLI backend's `?? true` — the two backends
		// would then quietly disagree on every remote branch, tag and label whenever a caller
		// relies on "unset" meaning "on", the documented default everywhere else in this API.
		const payload: LogOptions = { ...options, showRemoteBranches: options.showRemoteBranches ?? true };
		// Omitted fields mean "the engine's default" on the wire (serde fills them in); ts-rs
		// types the struct as all-required, so the cast only records that the input bag is partial.
		return request(repo, 'loadCommits', payload as EngineMethods['loadCommits']['params']);
	}

	public getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData> {
		const payload = { ...DEFAULT_REF_OPTIONS, ...options } as EngineMethods['loadRefs']['params'];
		return request(repo, 'loadRefs', payload);
	}

	public getCommitDetails(repo: string, hash: string): Promise<GitCommitDetails> {
		return request(repo, 'commitDetails', { hash });
	}

	public getCommitSignature(_repo: string, _hash: string): Promise<GitSignature | null> {
		return Promise.reject(
			new GitBackendError('Unsupported', 'Signature verification requires the Git CLI and GPG keyring')
		);
	}

	public getLineCounts(
		repo: string,
		from: string | null,
		to: string,
		paths: ReadonlyArray<string>
	): Promise<{ [path: string]: GitLineCounts }> {
		return request(repo, 'lineCounts', { from, to, paths: [...paths] });
	}

	public getUncommittedDetails(repo: string): Promise<GitCommitDetails> {
		return request(repo, 'uncommittedDetails', {});
	}

	public getStashDetails(
		repo: string,
		hash: string,
		stash: GitCommitStash
	): Promise<GitCommitDetails> {
		return request(repo, 'stashDetails', { hash, stash });
	}

	public compareCommits(
		repo: string,
		from: string,
		to: string
	): Promise<ReadonlyArray<GitFileChange>> {
		return request(repo, 'compareCommits', { from, to });
	}

	public getUncommittedChangeCount(repo: string, includeUntracked: boolean): Promise<number> {
		return request(repo, 'countUncommittedChanges', { includeUntracked });
	}

	public getStashes(repo: string): Promise<ReadonlyArray<GitStash>> {
		return request(repo, 'stashes', {});
	}

	public getConfig(repo: string): Promise<GitConfigSnapshot> {
		return request(repo, 'config', {});
	}

	public getCommitFile(repo: string, hash: string, file: string): Promise<GitCommitFile> {
		return request(repo, 'fileContents', { revision: hash, path: file });
	}

	public getCommitFileDiff(repo: string, hash: string, file: string): Promise<string> {
		return request(repo, 'fileDiff', { revision: hash, path: file });
	}

	public getCommitBodies(repo: string, hashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
		return request(repo, 'commitBodies', { hashes: [...hashes] });
	}

	public getCommitSubject(repo: string, hash: string): Promise<string> {
		return request(repo, 'commitSubject', { hash });
	}

	public getCommitSummaries(
		repo: string,
		hashes: ReadonlyArray<string>
	): Promise<{ [hash: string]: GitCommitSummary }> {
		return request(repo, 'commitSummaries', { hashes: [...hashes] });
	}

	public searchHistory(repo: string, query: string): Promise<ReadonlyArray<GitHistoryMatch>> {
		return request(repo, 'searchHistory', { query });
	}

	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetails> {
		return request(repo, 'tagDetails', { tagName });
	}

	public getTagSignature(_repo: string, _tagName: string): Promise<GitSignature | null> {
		return Promise.reject(
			new GitBackendError('Unsupported', 'Signature verification requires the Git CLI and GPG keyring')
		);
	}

	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return request(repo, 'remoteUrl', { remote });
	}

	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string): Promise<string | null> {
		return request(repo, 'newPathOfRenamedFile', { commitHash, oldFilePath });
	}

	public getSubmodules(repo: string): Promise<ReadonlyArray<string>> {
		return request(repo, 'submodules', {});
	}

	public getCurrentBranchUpstream(repo: string): Promise<string | null> {
		return request(repo, 'currentBranchUpstream', {});
	}

	public countCommitsBefore(
		repo: string,
		branches: ReadonlyArray<string> | null,
		hash: string,
		showRemoteBranches: boolean,
		includeCommitsMentionedByReflogs: boolean
	): Promise<number> {
		return request(repo, 'countCommitsBefore', {
			branches: branches !== null ? [...branches] : null,
			hash,
			showRemoteBranches,
			includeReflogs: includeCommitsMentionedByReflogs
		});
	}

	public repoRoot(path: string): Promise<string> {
		return request(path, 'repoRoot', {});
	}

	public getRemotes(repo: string): Promise<ReadonlyArray<string>> {
		return request(repo, 'remoteNames', {});
	}

	public getAuthors(repo: string): Promise<ReadonlyArray<GitAuthor>> {
		return request(repo, 'authors', {});
	}

	public getAuthorStatistics(repo: string): Promise<ReadonlyArray<GitAuthorStat>> {
		return request(repo, 'authorStats', {});
	}

	public getActivityHeatmap(repo: string): Promise<ReadonlyArray<GitActivityCell>> {
		return request(repo, 'activityHeatmap', {});
	}

	public getConfigList(repo: string, location: 'local' | 'global'): Promise<{ [key: string]: string }> {
		return request(repo, 'configList', { local: location === 'local' });
	}

	public currentBranchName(repo: string): Promise<string | null> {
		return request(repo, 'currentBranchName', {});
	}

	/**
	 * The Gerrit NoteDb change states of the given changes, parsed in one in-process pass, aligned
	 * with the input order. An entry is NULL when the change's meta ref is not available locally.
	 */
	public parseGerritMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<(GerritChangeState | null)[]> {
		// The generated state type answers exactly what the engine serialises (`null` for an absent
		// reviewer or vote list), while the extension-side type marks those fields optional; the
		// bytes are identical, so the cast only bridges the two spellings.
		return request(repo, 'parseGerritMetas', { remote, changes: [...changes], urlBase }) as Promise<(GerritChangeState | null)[]>;
	}

	/**
	 * The local Gerrit change refs of a remote (`refs/remotes/<remote>/changes/**`), as
	 * `[refname, hash]` pairs from one in-process scan of the ref store.
	 */
	public listChangeRefs(repo: string, remote: string): Promise<[string, string][]> {
		return request(repo, 'listChangeRefs', { remote });
	}
}

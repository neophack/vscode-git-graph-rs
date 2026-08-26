/**
 * The Git backend interface, and the native implementation of it.
 *
 * This is the seam the rewrite is built around. The extension talks to `GitBackend` and nothing
 * else; which implementation is behind it — the Rust engine or the `git` command line — is chosen
 * once, at startup, by `index.ts`. That is what makes the migration incremental: a capability the
 * engine does not have yet is answered by the CLI without the calling code knowing.
 */

import { call, callJson, loadAddon } from './addon';
import { GerritChangeState } from '../types';
import {
	GitAuthor,
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
	GitStash,
	GitTagDetails,
	LogOptions,
	RefReadOptions
} from './types';

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

	/** The branches, tags, remotes, stashes and HEAD the view opens with. */
	getRepoInfo(repo: string, options?: RefReadOptions): Promise<GitRepoInfo>;

	/** A page of the graph. */
	getCommits(repo: string, options: LogOptions): Promise<GitCommitData>;

	/** The refs of a repository, without the commits. */
	getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData>;

	/** One commit in full, with the files it changed — their statuses only, without line counts. */
	getCommitDetails(repo: string, hash: string): Promise<GitCommitDetails>;

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
 * The Rust engine, reached through the native addon.
 *
 * Every method is a single call across the boundary carrying a single JSON payload — never a call
 * per commit or per ref, which is what made the original extension's process-per-question design
 * expensive.
 */
export class NativeBackend implements GitBackend {
	public readonly name = 'rust';

	private readonly addon = loadAddon();

	/** The engine's version, for the diagnostics output. */
	public get version(): string {
		return this.addon.engineVersion();
	}

	public openRepository(path: string): Promise<string> {
		return call(() => this.addon.openRepository(path));
	}

	public closeRepository(path: string): void {
		this.addon.closeRepository(path);
	}

	public closeAllRepositories(): void {
		this.addon.closeAllRepositories();
	}

	/** How many repositories are currently held open. Exposed for the tests. */
	public get openRepositoryCount(): number {
		return this.addon.openRepositoryCount();
	}

	public getRepoInfo(repo: string, options?: RefReadOptions): Promise<GitRepoInfo> {
		const payload = JSON.stringify({ ...DEFAULT_REF_OPTIONS, ...options });
		return callJson<GitRepoInfo>(() => this.addon.loadRepoInfo(repo, payload));
	}

	public getCommits(repo: string, options: LogOptions): Promise<GitCommitData> {
		return callJson<GitCommitData>(() => this.addon.loadCommits(repo, JSON.stringify(options)));
	}

	public getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData> {
		const payload = JSON.stringify({ ...DEFAULT_REF_OPTIONS, ...options });
		return callJson<GitRefData>(() => this.addon.loadRefs(repo, payload));
	}

	public getCommitDetails(repo: string, hash: string): Promise<GitCommitDetails> {
		return callJson<GitCommitDetails>(() => this.addon.loadCommitDetails(repo, hash));
	}

	public getLineCounts(
		repo: string,
		from: string | null,
		to: string,
		paths: ReadonlyArray<string>
	): Promise<{ [path: string]: GitLineCounts }> {
		return callJson(() => this.addon.loadLineCounts(repo, from, to, JSON.stringify(paths)));
	}

	public getUncommittedDetails(repo: string): Promise<GitCommitDetails> {
		return callJson<GitCommitDetails>(() => this.addon.loadUncommittedDetails(repo));
	}

	public getStashDetails(
		repo: string,
		hash: string,
		stash: GitCommitStash
	): Promise<GitCommitDetails> {
		return callJson<GitCommitDetails>(() =>
			this.addon.loadStashDetails(repo, hash, JSON.stringify(stash))
		);
	}

	public compareCommits(
		repo: string,
		from: string,
		to: string
	): Promise<ReadonlyArray<GitFileChange>> {
		return callJson<GitFileChange[]>(() => this.addon.compareCommits(repo, from, to));
	}

	public getUncommittedChangeCount(repo: string, includeUntracked: boolean): Promise<number> {
		return call(() => this.addon.countUncommittedChanges(repo, includeUntracked));
	}

	public getStashes(repo: string): Promise<ReadonlyArray<GitStash>> {
		return callJson<GitStash[]>(() => this.addon.loadStashes(repo));
	}

	public getConfig(repo: string): Promise<GitConfigSnapshot> {
		return callJson<GitConfigSnapshot>(() => this.addon.loadConfig(repo));
	}

	public getCommitFile(repo: string, hash: string, file: string): Promise<GitCommitFile> {
		return callJson<GitCommitFile>(() => this.addon.loadCommitFile(repo, hash, file));
	}

	public getCommitFileDiff(repo: string, hash: string, file: string): Promise<string> {
		return call(() => this.addon.loadCommitFileDiff(repo, hash, file));
	}

	public getCommitBodies(repo: string, hashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
		return callJson(() => this.addon.loadCommitBodies(repo, [...hashes]));
	}

	public getCommitSubject(repo: string, hash: string): Promise<string> {
		return call(() => this.addon.loadCommitSubject(repo, hash));
	}

	public getCommitSummaries(
		repo: string,
		hashes: ReadonlyArray<string>
	): Promise<{ [hash: string]: GitCommitSummary }> {
		return callJson(() => this.addon.loadCommitSummaries(repo, [...hashes]));
	}

	public searchHistory(repo: string, query: string): Promise<ReadonlyArray<GitHistoryMatch>> {
		return callJson(() => this.addon.searchHistory(repo, query));
	}

	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetails> {
		return callJson(() => this.addon.loadTagDetails(repo, tagName));
	}

	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return call(() => this.addon.remoteUrl(repo, remote));
	}

	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string): Promise<string | null> {
		return call(() => this.addon.newPathOfRenamedFile(repo, commitHash, oldFilePath));
	}

	public getSubmodules(repo: string): Promise<ReadonlyArray<string>> {
		return call(() => this.addon.submodules(repo));
	}

	public getCurrentBranchUpstream(repo: string): Promise<string | null> {
		return call(() => this.addon.currentBranchUpstream(repo));
	}

	public countCommitsBefore(
		repo: string,
		branches: ReadonlyArray<string> | null,
		hash: string,
		showRemoteBranches: boolean,
		includeCommitsMentionedByReflogs: boolean
	): Promise<number> {
		return call(() =>
			this.addon.countCommitsBefore(repo, branches !== null ? [...branches] : null, hash, showRemoteBranches, includeCommitsMentionedByReflogs)
		);
	}

	public repoRoot(path: string): Promise<string> {
		return call(() => this.addon.repoRoot(path));
	}

	public getRemotes(repo: string): Promise<ReadonlyArray<string>> {
		return call(() => this.addon.remoteNames(repo));
	}

	public getAuthors(repo: string): Promise<ReadonlyArray<GitAuthor>> {
		return callJson(() => this.addon.authors(repo));
	}

	public getConfigList(repo: string, location: 'local' | 'global'): Promise<{ [key: string]: string }> {
		return callJson(() => this.addon.configList(repo, location === 'local'));
	}

	public currentBranchName(repo: string): Promise<string | null> {
		return call(() => this.addon.currentBranchName(repo));
	}

	/**
	 * The Gerrit NoteDb change states of the given changes, parsed in one in-process pass, aligned
	 * with the input order. An entry is NULL when the change's meta ref is not available locally.
	 */
	public parseGerritMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<(GerritChangeState | null)[]> {
		return callJson(() => this.addon.parseGerritMetas(repo, remote, [...changes], urlBase));
	}
}

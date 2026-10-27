/**
 * The Git backend contract: the reader interface the fallback, CLI and native backends
 * implement.
 *
 * This is the seam the rewrite is built around. The extension talks to `GitBackend` and nothing
 * else; which implementation is behind it — the Rust engine or the `git` command line — is chosen
 * once, at startup, by `backendIndex.ts`. That makes the migration incremental: a capability the
 * engine does not have yet is answered by the CLI without the calling code knowing.
 *
 * The data shapes the contract speaks live in ./types.ts (generated from the engine where it can
 * be); the Rust-engine implementation lives in ./nativeBackend.ts. `gitReader.ts` re-exports both
 * for the importers that predate the split.
 */

import { GerritChangeState } from '../../../shared/model/gerrit';
import type { AbortLike } from '../process/gitProcess';
import {
	GitActivityCell,
	GitAuthor,
	GitAuthorStat,
	GitCommitData,
	GitCommitDetails,
	GitCommitFile,
	GitCommitStash,
	GitCommitSummary,
	GitConflictPrediction,
	GitConfigSnapshot,
	GitFileChange,
	GitHistoryMatch,
	GitLineCounts,
	GitRefData,
	GitReflogPage,
	GitRefSnapshot,
	GitAnnotation,
	GitRepoInfo,
	GitSignature,
	GitStash,
	GitTagDetails,
	GitWorktree,
	AnnotateReadOptions,
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

	/** The branches, checked-out branch, tags, remotes and stashes the view opens with. */
	getRepoInfo(repo: string, options?: RefReadOptions): Promise<GitRepoInfo>;

	/** A page of the graph. The optional signal cancels the walk (see {@link AbortLike}). */
	getCommits(repo: string, options: LogOptions, signal?: AbortLike): Promise<GitCommitData>;

	/** The refs of a repository, without the commits. */
	getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData>;

	/**
	 * One pass over the repository's refs, answering everything a refs-only refresh needs at
	 * once (task 4.8): the ref data, the view's branch list, the checked-out branch and the tag
	 * names — the engine's `refs` request, served by the same ref scan a view load runs, without
	 * any history walk.
	 */
	getRefSnapshot(repo: string, options?: RefReadOptions): Promise<GitRefSnapshot>;

	/**
	 * Re-annotate the given commits with freshly read refs (task 4.8's refs-only refresh): the
	 * answer carries exactly the labels a full page load of the same options would attach, plus
	 * the commit HEAD resolves to now — no traversal runs. The optional signal cancels the read.
	 */
	annotate(repo: string, commits: ReadonlyArray<string>, options?: AnnotateReadOptions, signal?: AbortLike): Promise<GitAnnotation>;

	/**
	 * A signature of everything at ref level that can change the commit graph: the resolved hash
	 * of HEAD, and the names AND hashes of every branch, tag, remote-tracking ref and stash. A
	 * change poller comparing name-only lists cannot see a new commit landing on an existing
	 * branch; reading the actual ref hashes is what makes it visible.
	 *
	 * Never rejects: a momentarily unreadable repository answers NULL (the change that was made
	 * while it was unreadable is picked up by the next successful read).
	 */
	getRepoChangeSignature(repo: string): Promise<string | null>;

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

	/**
	 * The unified diff of one file between two revisions (the Commit Comparison view); an empty
	 * `to` compares against the working tree. `oldFilePath` and `newFilePath` differ when the
	 * file was renamed between the two sides.
	 *
	 * The engine answers the plain single-commit case (same path, `to` a commit hash, `from` its
	 * parent) through its `fileDiff` method; everything else declines to the CLI, which runs the
	 * general two-revision diff.
	 */
	compareFileDiff(repo: string, from: string, to: string, oldFilePath: string, newFilePath: string): Promise<string>;

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

	/**
	 * A page of the reflog of a reference (defaulting to `HEAD`), newest first, with the dangling
	 * (unreachable-from-any-ref) commits flagged.
	 *
	 * The engine has no reflog walk, so it declines and the CLI fallback answers.
	 */
	getReflog(repo: string, ref: string, limit: number): Promise<GitReflogPage>;

	/**
	 * The worktrees of a repository, in the order Git reports them (the first is always the
	 * repository's own working directory). Never rejects: an unreadable list answers empty, as
	 * the worktree list is an advisory panel rather than a load the view depends on.
	 */
	getWorktrees(repo: string): Promise<ReadonlyArray<GitWorktree>>;

	/**
	 * Predict whether merging `theirs` into `ours` would conflict, via a single
	 * `git merge-tree --write-tree` probe (no working-tree side effects, so it is safe to run
	 * ahead of a merge/rebase confirmation dialog). Requires Git 2.40+.
	 *
	 * NULL means "no prediction available" — an older Git, or a probe that failed without naming
	 * conflicted files — since the prediction is advisory and must not block the action.
	 */
	predictConflicts(repo: string, ours: string, theirs: string): Promise<GitConflictPrediction | null>;

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

	/**
	 * The user identity of the global Git configuration (user.name / user.email); NULL members
	 * mean the key is not set globally. The Author Identities feature matches it against the
	 * configured authors to resolve the global author.
	 */
	getGlobalUserDetails(repo: string): Promise<{ name: string | null; email: string | null }>;

	/**
	 * The Gerrit NoteDb change states of the given changes, parsed over each change's meta
	 * history, aligned with the input order; an entry is NULL when the change's meta ref is not
	 * available locally.
	 *
	 * The engine answers this in one in-process pass over its warm repository handle. The CLI
	 * adapter declines: the meta parser lives with the Gerrit integration (whose own Git fallback
	 * serves it), and duplicating it here would only fork the two implementations.
	 */
	parseGerritMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<ReadonlyArray<GerritChangeState | null>>;

	/**
	 * The local Gerrit change refs of a remote (`refs/remotes/<remote>/changes/**`), as
	 * `[refname, hash]` pairs from one scan of the ref store.
	 */
	listChangeRefs(repo: string, remote: string): Promise<ReadonlyArray<readonly [string, string]>>;
}

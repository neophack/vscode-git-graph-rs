/**
 * The data contract between the extension and the Git engine.
 *
 * These types mirror `native/core/src/types.rs` field for field, and they are the same shapes the
 * original extension's `src/types.ts` already defines — which is what lets the existing webview
 * render this engine's output unchanged.
 */

/** The synthetic hash the view uses for the "Uncommitted Changes" row. */
export const UNCOMMITTED = '*';

/* ---------- Commits ---------- */

export interface GitCommit {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly email: string;
	/** Seconds since the Unix epoch. */
	readonly date: number;
	/** The commit subject (the first line of the message). */
	readonly message: string;
	readonly heads: ReadonlyArray<string>;
	readonly tags: ReadonlyArray<GitCommitTag>;
	readonly remotes: ReadonlyArray<GitCommitRemote>;
	/** NULL => not a stash, otherwise => the stash this row represents. */
	readonly stash: GitCommitStash | null;
}

export interface GitCommitTag {
	readonly name: string;
	readonly annotated: boolean;
}

export interface GitCommitRemote {
	readonly name: string;
	/** NULL => the ref's remote is not one of the repository's known remotes. */
	readonly remote: string | null;
}

export interface GitCommitStash {
	readonly selector: string;
	readonly baseHash: string;
	/** Only a stash taken with `--include-untracked` has one. */
	readonly untrackedFilesHash: string | null;
}

export interface GitCommitData {
	readonly commits: ReadonlyArray<GitCommit>;
	readonly head: string | null;
	readonly tags: ReadonlyArray<string>;
	/** TRUE => the page was truncated, and the view should offer "Load More". */
	readonly moreCommitsAvailable: boolean;
	readonly error: string | null;
}

/* ---------- Refs ---------- */

export interface GitRef {
	readonly hash: string;
	readonly name: string;
}

export interface GitTagRef extends GitRef {
	/** TRUE for the peeled record of an annotated tag, which points at the commit. */
	readonly annotated: boolean;
}

export interface GitRefData {
	readonly head: string | null;
	readonly heads: ReadonlyArray<GitRef>;
	readonly tags: ReadonlyArray<GitTagRef>;
	readonly remotes: ReadonlyArray<GitRef>;
}

export interface RefReadOptions {
	readonly showRemoteBranches?: boolean;
	readonly showRemoteHeads?: boolean;
	readonly hideRemotes?: ReadonlyArray<string>;
	/** Show Gerrit change refs as remote branch refs. */
	readonly showChangeRefs?: boolean;
	/** Only meaningful for `getRepoInfo`. */
	readonly showStashes?: boolean;
}

/* ---------- Repository ---------- */

export interface GitRepoInfo {
	readonly branches: ReadonlyArray<string>;
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly tags: ReadonlyArray<string>;
	readonly error: string | null;
}

export interface GitStash {
	readonly hash: string;
	readonly baseHash: string;
	readonly untrackedFilesHash: string | null;
	readonly selector: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

/* ---------- File changes ---------- */

export const enum GitFileStatus {
	Added = 'A',
	Modified = 'M',
	Deleted = 'D',
	Renamed = 'R',
	Untracked = 'U'
}

export interface GitFileChange {
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
	/** NULL for binary files, where git reports a dash instead of a line count. */
	readonly additions: number | null;
	readonly deletions: number | null;
}

/* ---------- Commit details ---------- */

export const enum GitSignatureStatus {
	GoodAndValid = 'G',
	GoodWithUnknownValidity = 'U',
	GoodButExpired = 'X',
	GoodButMadeByExpiredKey = 'Y',
	GoodButMadeByRevokedKey = 'R',
	CannotBeChecked = 'E',
	Bad = 'B'
}

export interface GitSignature {
	readonly key: string;
	readonly signer: string;
	readonly status: GitSignatureStatus;
}

export interface GitCommitDetails {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly signature: GitSignature | null;
	/** The full commit message, including the subject. */
	readonly body: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
}

/* ---------- Log options ---------- */

export type CommitOrdering = 'date' | 'author-date' | 'topo';

export interface LogOptions {
	/** The branch heads to show, or NULL to show all refs. */
	branches?: ReadonlyArray<string> | null;
	/** Only show commits whose author matches one of these. */
	authors?: ReadonlyArray<string> | null;
	maxCommits: number;
	showTags?: boolean;
	showRemoteBranches?: boolean;
	showRemoteHeads?: boolean;
	includeCommitsMentionedByReflogs?: boolean;
	onlyFollowFirstParent?: boolean;
	commitOrdering?: CommitOrdering;
	remotes?: ReadonlyArray<string>;
	hideRemotes?: ReadonlyArray<string>;
	/** The Gerrit change refs allowed into the graph; NULL disables the Gerrit integration. */
	gerritRefs?: ReadonlyArray<string> | null;
	gerritShowChangeRefs?: boolean;
	/** Only show commits touching these repository-relative paths. */
	filterPaths?: ReadonlyArray<string>;
	/** Skip the working-tree scan that produces the "Uncommitted Changes" row. */
	deferUncommittedChanges?: boolean;
	showUncommittedChanges?: boolean;
	showUntrackedFiles?: boolean;
	showCommitsOnlyReferencedByTags?: boolean;
}

/* ---------- Configuration & file contents ---------- */

/** A remote of the repository, as the configuration sees it. */
export interface GitRemoteConfig {
	readonly name: string;
	readonly url: string | null;
	readonly pushUrl: string | null;
}

/**
 * The Git configuration values the view consumes: the remotes (with their URLs), the user
 * identity, the push default and the diff tools.
 */
export interface GitConfigSnapshot {
	readonly remotes: ReadonlyArray<GitRemoteConfig>;
	readonly userName: string | null;
	readonly userEmail: string | null;
	readonly pushDefault: string | null;
	readonly diffTool: string | null;
	readonly diffGuiTool: string | null;
}

/** The contents of one file at one revision; `contents` is NULL when the file is binary. */
export interface GitCommitFile {
	readonly contents: string | null;
	readonly binary: boolean;
}

/* ---------- On-demand commit reads ---------- */

/** The fields the Commit Comparison View describes a commit with. */
export interface GitCommitSummary {
	readonly hash: string;
	readonly author: string;
	readonly email: string;
	/** The author date, which is what `git show --format=%at` reports. */
	readonly date: number;
	/** The full commit message, trimmed as `git show --format=%B` output is. */
	readonly message: string;
}

/** One hit of a commit-message search, as the Find dialogue lists them. */
export interface GitHistoryMatch {
	readonly hash: string;
	readonly author: string;
	readonly date: number;
	/** The commit subject. */
	readonly message: string;
}

/** A distinct commit author, as the settings widget's author dropdown lists them. */
export interface GitAuthor {
	readonly name: string;
	readonly email: string;
}

/* ---------- Tag details ---------- */

/**
 * An annotated tag in full, or the fields a lightweight tag can fill in (empty tagger, the tagged
 * commit's message).
 */
export interface GitTagDetails {
	/** The tag object for an annotated tag, the commit for a lightweight one. */
	readonly hash: string;
	readonly taggerName: string;
	readonly taggerEmail: string;
	readonly taggerDate: number;
	readonly message: string;
	/** Present when the tag carries a signature (reported as unverified, like commit signatures). */
	readonly signature: GitSignature | null;
}

/* ---------- Errors ---------- */

/**
 * Why an engine call failed.
 *
 * The distinction that matters is `NotARepository` and `Unsupported`: those mean "this backend
 * cannot answer, try another one", whereas the rest mean "the answer is that it failed", which the
 * user should see.
 */
export type GitErrorKind =
	| 'NotARepository'
	| 'NotFound'
	| 'InvalidArgument'
	| 'Git'
	| 'Io'
	| 'Cancelled'
	| 'Unsupported';

export class GitBackendError extends Error {
	public readonly kind: GitErrorKind;

	constructor(kind: GitErrorKind, message: string) {
		super(message);
		this.name = 'GitBackendError';
		this.kind = kind;
	}

	/** Should the caller try a different backend rather than showing this to the user? */
	public get isFallbackWorthy(): boolean {
		return this.kind === 'NotARepository' || this.kind === 'Unsupported';
	}
}

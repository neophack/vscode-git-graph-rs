/**
 * The data contract between the extension and the Git engine, generated from the engine itself.
 *
 * Every result shape the engine answers is generated from the Rust protocol table into
 * `src/shared/engine/protocol.ts` (by `cargo test`, via ts-rs) and re-exported here, so
 * TypeScript mirrors the engine instead of a hand-written copy: a Rust type change that is not
 * regenerated shows up as a compile error the moment it reaches this module.
 *
 * Only what the generated protocol cannot say lives in this file: the input-side option bags
 * (whose omitted fields mean "the usual" — the engine's serde defaults fill them in, while ts-rs
 * types the wire structs as all-required), the two literal enums the whole extension speaks
 * (whose members are the same wire literals as the generated unions), and the backend error
 * contract.
 */

import { CommitOrdering } from '../../../shared/engine/protocol';

/** The synthetic hash the view uses for the "Uncommitted Changes" row. */
export const UNCOMMITTED = '*';

/* ---------- Data shapes: generated from native/core/src (do not mirror by hand) ---------- */

export type {
	CommitOrdering,
	GerritChangeState,
	GitActivityCell,
	GitAuthor,
	GitAuthorStat,
	GitCommit,
	GitCommitData,
	GitCommitDetails,
	GitCommitRemote,
	GitCommitStash,
	GitCommitSummary,
	GitCommitTag,
	GitFileChange,
	GitHistoryMatch,
	GitLineCounts,
	GitRef,
	GitRefData,
	GitRepoInfo,
	GitSignature,
	GitStash,
	GitTagDetails,
	GitTagRef,
	GitViewData,
	ScmChange,
	CommitFile as GitCommitFile,
	ConfigSnapshot as GitConfigSnapshot,
	RemoteConfig as GitRemoteConfig
} from '../../../shared/engine/protocol';

/**
 * The answer of a refs-only re-annotation (task 4.8, the engine's `annotate` request): a fresh
 * HEAD together with the refs of each given commit — everything a full page load would have
 * attached to it, without the history walk.
 */
export type { AnnotateResult as GitAnnotation, GitCommitRefs, RefSnapshot as GitRefSnapshot } from '../../../shared/engine/protocol';

/**
 * The read-only shapes the engine does not generate (no engine method answers them yet), defined
 * once in `src/types/git.ts` beside the rest of the extension's data contract, imported here for
 * the backend's own bags and re-exported so the backend's vocabulary stays one table.
 */
import type { GitReflogEntry } from '../../../types/git';

export type { GitConflictPrediction, GitReflogEntry, GitWorktree } from '../../../types/git';

/* ---------- Wire literals the extension names ---------- */

/**
 * How a path changed in a commit, in `git diff --name-status` letters. The generated protocol
 * types the same literals as a string union; the enum keeps the named members every caller
 * already uses, and its member types are those literals, so the two are interchangeable.
 */
export const enum GitFileStatus {
	Added = 'A',
	Modified = 'M',
	Deleted = 'D',
	Renamed = 'R',
	Untracked = 'U'
}

/** A Git/GPG signature verification verdict, in `git verify-* --raw` status letters. */
export const enum GitSignatureStatus {
	GoodAndValid = 'G',
	GoodWithUnknownValidity = 'U',
	GoodButExpired = 'X',
	GoodButMadeByExpiredKey = 'Y',
	GoodButMadeByRevokedKey = 'R',
	CannotBeChecked = 'E',
	Bad = 'B'
}

/* ---------- Input-side option bags ---------- */

/**
 * A page of a reference's reflog, newest first, with the dangling commits flagged per entry
 * ({@link GitReflogEntry}). The rejection of the read carries the failure, so unlike the view
 * message that wraps this page there is no `error` field here.
 */
export interface GitReflogPage {
	readonly entries: ReadonlyArray<GitReflogEntry>;
	/** TRUE when the reference's reflog holds more entries beyond this page. */
	readonly moreAvailable: boolean;
}

/** The ref-reading options a ref scan accepts; an omitted field means "the usual". */
export interface RefReadOptions {
	readonly showRemoteBranches?: boolean;
	readonly showRemoteHeads?: boolean;
	readonly hideRemotes?: ReadonlyArray<string>;
	/** Show Gerrit change refs as remote branch refs. */
	readonly showChangeRefs?: boolean;
	/** Only meaningful for `getRepoInfo`. */
	readonly showStashes?: boolean;
}

/**
 * The options a refs-only re-annotation accepts (task 4.8): the ref-reading options (which refs
 * to attach) plus whether tags are annotated — the same "Show Tags" flag a page load receives.
 * An omitted field means "the usual".
 */
export interface AnnotateReadOptions extends RefReadOptions {
	readonly showTags?: boolean;
}

/** Everything a graph load accepts; an omitted field means "the usual" (the engine's defaults). */
export interface LogOptions {
	/** The branch heads to show, or NULL to show all refs. */
	readonly branches?: ReadonlyArray<string> | null;
	/** Only show commits whose author matches one of these. */
	readonly authors?: ReadonlyArray<string> | null;
	readonly maxCommits: number;
	readonly showTags?: boolean;
	readonly showRemoteBranches?: boolean;
	readonly showRemoteHeads?: boolean;
	/** Skip the `refs/remotes/` scan: the response carries the local refs only (the caller follows up with a complete load). */
	readonly deferRemoteRefs?: boolean;
	readonly includeCommitsMentionedByReflogs?: boolean;
	readonly onlyFollowFirstParent?: boolean;
	readonly commitOrdering?: CommitOrdering;
	readonly remotes?: ReadonlyArray<string>;
	readonly hideRemotes?: ReadonlyArray<string>;
	/** The Gerrit change refs allowed into the graph; NULL disables the Gerrit integration. */
	readonly gerritRefs?: ReadonlyArray<string> | null;
	readonly gerritShowChangeRefs?: boolean;
	/** Only show commits touching these repository-relative paths. */
	readonly filterPaths?: ReadonlyArray<string>;
	/** Skip the working-tree scan that produces the "Uncommitted Changes" row. */
	readonly deferUncommittedChanges?: boolean;
	readonly showUncommittedChanges?: boolean;
	readonly showUntrackedFiles?: boolean;
	readonly showCommitsOnlyReferencedByTags?: boolean;
	/** Apply `.mailmap` to author names and emails; the engine declines this to the CLI. */
	readonly useMailmap?: boolean;
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

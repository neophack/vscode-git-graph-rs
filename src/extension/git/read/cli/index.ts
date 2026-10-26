/**
 * The `git` command line, behind the same interface as the Rust engine.
 *
 * This exists so that the rewrite never has to be finished before it can ship. Anything the engine
 * cannot answer yet — an unusual repository layout, a platform with no prebuilt binary, a
 * capability still on the roadmap — is answered here instead, and the calling code cannot tell the
 * difference. As the engine grows, this shrinks; the interface does not move.
 *
 * It is a faithful port of how the original extension read a repository, down to the record
 * separator, because its output is what the engine is checked against.
 *
 * The readers live in the theme modules beside this one; this module is the assembly point that
 * keeps the public shape `dataSource.ts` and the tests were built against: one class, one
 * constructor, the same method signatures — and byte-identical output, arguments and error
 * strings, which the Reader contract suite locks.
 */

import { GitBackend } from '../gitReader';
import {
	AnnotateReadOptions,
	GitActivityCell,
	GitAnnotation,
	GitAuthor,
	GitAuthorStat,
	GitBackendError,
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
	GitRepoInfo,
	GitSignature,
	GitStash,
	GitTagDetails,
	GitWorktree,
	LogOptions,
	RefReadOptions
} from '../types';
import { GerritChangeState } from '../../../../shared/model/gerrit';
import type { AbortLike, GitSpawnFn } from '../../process/gitProcess';

import { getConfig, getConfigList, getGlobalUserDetails, getRemoteUrl } from './config';
import {
	compareCommits,
	getCommitDetails,
	getCommitSignature,
	getStashDetails,
	getUncommittedDetails
} from './details';
import {
	compareFileDiff,
	getCommitBodies,
	getCommitFile,
	getCommitFileDiff,
	getCommitSubject,
	getCommitSummaries,
	getNewPathOfRenamedFile,
	getSubmodules,
	repoRoot,
	searchHistory
} from './files';
import { getCommits, getUncommittedChangeCount } from './log';
import { GitCli } from './process';
import { getReflog } from './reflog';
import {
	annotate,
	currentBranchName,
	getCurrentBranchUpstream,
	getRemotes,
	getRepoChangeSignature,
	getRepoInfo,
	getRefSnapshot,
	getRefs,
	getStashes,
	listChangeRefs
} from './refs';
import { predictConflicts } from './conflicts';
import {
	countCommitsBefore,
	getActivityHeatmap,
	getAuthors,
	getAuthorStatistics,
	getLineCounts
} from './stats';
import { getTagDetails, getTagSignature } from './tags';
import { getWorktrees } from './worktrees';

export class CliBackend implements GitBackend {
	public readonly name = 'git-cli';

	private readonly cli: GitCli;

	constructor(
		gitPath: string = 'git',
		/** The Git version, when the host has looked it up; gates the versioned reads (merge-tree). */
		private readonly gitVersion?: string,
		/** The spawn implementation behind the cancellable runs; injected so tests fake the child. */
		spawnFn?: GitSpawnFn
	) {
		this.cli = new GitCli(gitPath, spawnFn);
	}

	/* ---------- Lifecycle ---------- */

	/**
	 * There is no handle to open: every call spawns its own process. The path is still resolved,
	 * so that the caller gets the same "which repository did I land in" answer either way.
	 */
	public openRepository(path: string): Promise<string> {
		return repoRoot(this.cli, path);
	}

	public closeRepository(): void {
		/* Nothing is held open. */
	}

	public closeAllRepositories(): void {
		/* Nothing is held open. */
	}

	/* ---------- Reads ---------- */

	public getRepoInfo(repo: string, options?: RefReadOptions): Promise<GitRepoInfo> {
		return getRepoInfo(this.cli, repo, options);
	}

	public getCommits(repo: string, options: LogOptions, signal?: AbortLike): Promise<GitCommitData> {
		return getCommits(this.cli, repo, options, signal);
	}

	public getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData> {
		return getRefs(this.cli, repo, options);
	}

	/** The one-pass ref snapshot of a refs-only refresh (task 4.8), over the CLI's split ref scans. */
	public getRefSnapshot(repo: string, options?: RefReadOptions): Promise<GitRefSnapshot> {
		return getRefSnapshot(this.cli, repo, options);
	}

	/** The CLI's refs-only re-annotation (task 4.8): one ref scan, no history walk. */
	public annotate(repo: string, commits: ReadonlyArray<string>, options?: AnnotateReadOptions): Promise<GitAnnotation> {
		return annotate(this.cli, repo, commits, options);
	}

	public getRepoChangeSignature(repo: string): Promise<string | null> {
		return getRepoChangeSignature(this.cli, repo);
	}

	public getCommitDetails(repo: string, hash: string): Promise<GitCommitDetails> {
		return getCommitDetails(this.cli, repo, hash);
	}

	public getCommitSignature(repo: string, hash: string): Promise<GitSignature | null> {
		return getCommitSignature(this.cli, repo, hash);
	}

	public getUncommittedDetails(repo: string): Promise<GitCommitDetails> {
		return getUncommittedDetails(this.cli, repo);
	}

	public getStashDetails(
		repo: string,
		hash: string,
		stash: GitCommitStash
	): Promise<GitCommitDetails> {
		return getStashDetails(this.cli, repo, hash, stash);
	}

	public compareCommits(repo: string, from: string, to: string): Promise<GitFileChange[]> {
		return compareCommits(this.cli, repo, from, to);
	}

	public getLineCounts(repo: string, from: string | null, to: string, paths: ReadonlyArray<string>): Promise<{ [path: string]: GitLineCounts }> {
		return getLineCounts(this.cli, repo, from, to, paths);
	}

	public getUncommittedChangeCount(repo: string, includeUntracked: boolean): Promise<number> {
		return getUncommittedChangeCount(this.cli, repo, includeUntracked);
	}

	public getStashes(repo: string): Promise<GitStash[]> {
		return getStashes(this.cli, repo);
	}

	public getConfig(repo: string): Promise<GitConfigSnapshot> {
		return getConfig(this.cli, repo);
	}

	public getCommitFile(repo: string, hash: string, file: string): Promise<GitCommitFile> {
		return getCommitFile(this.cli, repo, hash, file);
	}

	public getCommitFileDiff(repo: string, hash: string, file: string): Promise<string> {
		return getCommitFileDiff(this.cli, repo, hash, file);
	}

	public compareFileDiff(repo: string, from: string, to: string, oldFilePath: string, newFilePath: string): Promise<string> {
		return compareFileDiff(this.cli, repo, from, to, oldFilePath, newFilePath);
	}

	public getCommitBodies(repo: string, hashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
		return getCommitBodies(this.cli, repo, hashes);
	}

	public getCommitSubject(repo: string, hash: string): Promise<string> {
		return getCommitSubject(this.cli, repo, hash);
	}

	public getCommitSummaries(
		repo: string,
		hashes: ReadonlyArray<string>
	): Promise<{ [hash: string]: GitCommitSummary }> {
		return getCommitSummaries(this.cli, repo, hashes);
	}

	public searchHistory(repo: string, query: string): Promise<GitHistoryMatch[]> {
		return searchHistory(this.cli, repo, query);
	}

	public getReflog(repo: string, ref: string, limit: number): Promise<GitReflogPage> {
		return getReflog(this.cli, repo, ref, limit);
	}

	public getWorktrees(repo: string): Promise<GitWorktree[]> {
		return getWorktrees(this.cli, repo);
	}

	public predictConflicts(repo: string, ours: string, theirs: string): Promise<GitConflictPrediction | null> {
		return predictConflicts(this.cli, repo, ours, theirs, this.gitVersion);
	}

	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetails> {
		return getTagDetails(this.cli, repo, tagName);
	}

	public getTagSignature(repo: string, tagName: string): Promise<GitSignature | null> {
		return getTagSignature(this.cli, repo, tagName);
	}

	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return getRemoteUrl(this.cli, repo, remote);
	}

	public getNewPathOfRenamedFile(
		repo: string,
		commitHash: string,
		oldFilePath: string
	): Promise<string | null> {
		return getNewPathOfRenamedFile(this.cli, repo, commitHash, oldFilePath);
	}

	public getSubmodules(repo: string): Promise<string[]> {
		return getSubmodules(this.cli, repo);
	}

	public getCurrentBranchUpstream(repo: string): Promise<string | null> {
		return getCurrentBranchUpstream(this.cli, repo);
	}

	public countCommitsBefore(
		repo: string,
		branches: ReadonlyArray<string> | null,
		hash: string,
		showRemoteBranches: boolean,
		includeCommitsMentionedByReflogs: boolean
	): Promise<number> {
		return countCommitsBefore(this.cli, repo, branches, hash, showRemoteBranches, includeCommitsMentionedByReflogs);
	}

	public repoRoot(path: string): Promise<string> {
		return repoRoot(this.cli, path);
	}

	public getRemotes(repo: string): Promise<string[]> {
		return getRemotes(this.cli, repo);
	}

	public getAuthors(repo: string): Promise<GitAuthor[]> {
		return getAuthors(this.cli, repo);
	}

	public getAuthorStatistics(repo: string): Promise<GitAuthorStat[]> {
		return getAuthorStatistics(this.cli, repo);
	}

	public getActivityHeatmap(repo: string): Promise<GitActivityCell[]> {
		return getActivityHeatmap(this.cli, repo);
	}

	public getConfigList(repo: string, location: 'local' | 'global'): Promise<{ [key: string]: string }> {
		return getConfigList(this.cli, repo, location);
	}

	public currentBranchName(repo: string): Promise<string | null> {
		return currentBranchName(this.cli, repo);
	}

	public getGlobalUserDetails(repo: string): Promise<{ name: string | null; email: string | null }> {
		return getGlobalUserDetails(this.cli, repo);
	}

	public listChangeRefs(repo: string, remote: string): Promise<[string, string][]> {
		return listChangeRefs(this.cli, repo, remote);
	}

	/**
	 * The engine's one-pass meta parsing has no CLI counterpart here, by design: the meta parser
	 * and its parse cache live with the Gerrit integration (whose own Git fallback serves the
	 * read), and this tree must not import them. The decline keeps the method dispatchable
	 * through the fallback reader while preserving the integration's null-degrade path.
	 */
	public parseGerritMetas(_repo: string, _remote: string, _changes: ReadonlyArray<number>, _urlBase: string | null): Promise<ReadonlyArray<GerritChangeState | null>> {
		return Promise.reject(new GitBackendError('Unsupported', 'The Gerrit meta parsing over the git CLI is served by the Gerrit integration itself'));
	}
}

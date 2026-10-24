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
 * The readers themselves live in `src/extension/git/read/cli/`, split by theme; this module is the
 * assembly point that keeps the public shape `dataSource.ts` and the tests were built against: one
 * class, one constructor, the same method signatures — and byte-identical output, arguments and
 * error strings, which the Reader contract suite locks.
 */

import { GitBackend } from './api';
import {
	GitActivityCell,
	GitAuthor,
	GitAuthorStat,
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

import { getConfig, getConfigList, getRemoteUrl } from '../extension/git/read/cli/config';
import {
	compareCommits,
	getCommitDetails,
	getCommitSignature,
	getStashDetails,
	getUncommittedDetails
} from '../extension/git/read/cli/details';
import {
	getCommitBodies,
	getCommitFile,
	getCommitFileDiff,
	getCommitSubject,
	getCommitSummaries,
	getNewPathOfRenamedFile,
	getSubmodules,
	repoRoot,
	searchHistory
} from '../extension/git/read/cli/files';
import { getCommits, getUncommittedChangeCount } from '../extension/git/read/cli/log';
import { GitCli } from '../extension/git/read/cli/process';
import {
	currentBranchName,
	getCurrentBranchUpstream,
	getRemotes,
	getRepoInfo,
	getRefs,
	getStashes
} from '../extension/git/read/cli/refs';
import {
	countCommitsBefore,
	getActivityHeatmap,
	getAuthors,
	getAuthorStatistics,
	getLineCounts
} from '../extension/git/read/cli/stats';
import { getTagDetails, getTagSignature } from '../extension/git/read/cli/tags';

export class CliBackend implements GitBackend {
	public readonly name = 'git-cli';

	private readonly cli: GitCli;

	constructor(gitPath: string = 'git') {
		this.cli = new GitCli(gitPath);
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

	public getCommits(repo: string, options: LogOptions): Promise<GitCommitData> {
		return getCommits(this.cli, repo, options);
	}

	public getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData> {
		return getRefs(this.cli, repo, options);
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
}

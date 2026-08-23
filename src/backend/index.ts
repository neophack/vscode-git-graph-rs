/**
 * Choosing a backend, and falling back when one cannot answer.
 *
 * The extension asks for a `GitBackend` and gets one. Which implementation it is — and whether a
 * particular call was served by the Rust engine or by the `git` command line — is not the calling
 * code's concern, which is what lets the engine grow one capability at a time.
 */

import { GitBackend, NativeBackend } from './api';
import { isAddonAvailable, loadAddon, platformKey } from './addon';
import { CliBackend } from './cliBackend';
import { BackendCapability, BackendReport } from '../types';
import {
	GitBackendError,
	GitCommitData,
	GitCommitDetails,
	GitCommitFile,
	GitCommitStash,
	GitCommitSummary,
	GitConfigSnapshot,
	GitFileChange,
	GitHistoryMatch,
	GitRefData,
	GitRepoInfo,
	GitStash,
	GitTagDetails,
	LogOptions,
	RefReadOptions
} from './types';

export * from './types';
export { GitBackend } from './api';
export { NativeBackend } from './api';
export { CliBackend } from './cliBackend';

export interface BackendOptions {
	/** Force a particular backend, rather than preferring the engine. */
	readonly prefer?: 'rust' | 'git-cli';
	/** The `git` executable the fallback should use. */
	readonly gitPath?: string;
	/** Called whenever a call falls back, so the extension can log it. */
	readonly onFallback?: (method: string, error: GitBackendError) => void;
}

/**
 * A backend that prefers the Rust engine and falls back to the `git` CLI.
 *
 * Only two kinds of failure are fallen back over: "this is not a repository I can open" and "I do
 * not implement this". A genuine Git failure — a bad revision, a corrupt object — is the answer,
 * and re-running it through `git` would only produce the same failure more slowly.
 */
class FallbackBackend implements GitBackend {
	public readonly name: string;

	constructor(
		private readonly primary: GitBackend,
		private readonly secondary: GitBackend,
		private readonly onFallback?: (method: string, error: GitBackendError) => void
	) {
		this.name = `${primary.name} (falling back to ${secondary.name})`;
	}

	private async attempt<T>(
		method: string,
		call: (backend: GitBackend) => Promise<T>
	): Promise<T> {
		try {
			return await call(this.primary);
		} catch (error) {
			if (error instanceof GitBackendError && error.isFallbackWorthy) {
				this.onFallback?.(method, error);
				return call(this.secondary);
			}
			throw error;
		}
	}

	public openRepository(path: string): Promise<string> {
		return this.attempt('openRepository', (backend) => backend.openRepository(path));
	}

	public closeRepository(path: string): void {
		this.primary.closeRepository(path);
		this.secondary.closeRepository(path);
	}

	public closeAllRepositories(): void {
		this.primary.closeAllRepositories();
		this.secondary.closeAllRepositories();
	}

	public getRepoInfo(repo: string, options?: RefReadOptions): Promise<GitRepoInfo> {
		return this.attempt('getRepoInfo', (backend) => backend.getRepoInfo(repo, options));
	}

	public getCommits(repo: string, options: LogOptions): Promise<GitCommitData> {
		return this.attempt('getCommits', (backend) => backend.getCommits(repo, options));
	}

	public getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData> {
		return this.attempt('getRefs', (backend) => backend.getRefs(repo, options));
	}

	public getCommitDetails(repo: string, hash: string): Promise<GitCommitDetails> {
		return this.attempt('getCommitDetails', (backend) => backend.getCommitDetails(repo, hash));
	}

	public getUncommittedDetails(repo: string): Promise<GitCommitDetails> {
		return this.attempt('getUncommittedDetails', (backend) => backend.getUncommittedDetails(repo));
	}

	public getStashDetails(
		repo: string,
		hash: string,
		stash: GitCommitStash
	): Promise<GitCommitDetails> {
		return this.attempt('getStashDetails', (backend) => backend.getStashDetails(repo, hash, stash));
	}

	public compareCommits(
		repo: string,
		from: string,
		to: string
	): Promise<ReadonlyArray<GitFileChange>> {
		return this.attempt('compareCommits', (backend) => backend.compareCommits(repo, from, to));
	}

	public getUncommittedChangeCount(repo: string, includeUntracked: boolean): Promise<number> {
		return this.attempt('getUncommittedChangeCount', (backend) =>
			backend.getUncommittedChangeCount(repo, includeUntracked)
		);
	}

	public getStashes(repo: string): Promise<ReadonlyArray<GitStash>> {
		return this.attempt('getStashes', (backend) => backend.getStashes(repo));
	}

	public getConfig(repo: string): Promise<GitConfigSnapshot> {
		return this.attempt('getConfig', (backend) => backend.getConfig(repo));
	}

	public getCommitFile(repo: string, hash: string, file: string): Promise<GitCommitFile> {
		return this.attempt('getCommitFile', (backend) => backend.getCommitFile(repo, hash, file));
	}

	public getCommitFileDiff(repo: string, hash: string, file: string): Promise<string> {
		return this.attempt('getCommitFileDiff', (backend) => backend.getCommitFileDiff(repo, hash, file));
	}

	public getCommitBodies(repo: string, hashes: ReadonlyArray<string>): Promise<{ [hash: string]: string }> {
		return this.attempt('getCommitBodies', (backend) => backend.getCommitBodies(repo, hashes));
	}

	public getCommitSubject(repo: string, hash: string): Promise<string> {
		return this.attempt('getCommitSubject', (backend) => backend.getCommitSubject(repo, hash));
	}

	public getCommitSummaries(
		repo: string,
		hashes: ReadonlyArray<string>
	): Promise<{ [hash: string]: GitCommitSummary }> {
		return this.attempt('getCommitSummaries', (backend) => backend.getCommitSummaries(repo, hashes));
	}

	public searchHistory(repo: string, query: string): Promise<ReadonlyArray<GitHistoryMatch>> {
		return this.attempt('searchHistory', (backend) => backend.searchHistory(repo, query));
	}

	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetails> {
		return this.attempt('getTagDetails', (backend) => backend.getTagDetails(repo, tagName));
	}

	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return this.attempt('getRemoteUrl', (backend) => backend.getRemoteUrl(repo, remote));
	}

	public getNewPathOfRenamedFile(
		repo: string,
		commitHash: string,
		oldFilePath: string
	): Promise<string | null> {
		return this.attempt('getNewPathOfRenamedFile', (backend) =>
			backend.getNewPathOfRenamedFile(repo, commitHash, oldFilePath)
		);
	}

	public getSubmodules(repo: string): Promise<ReadonlyArray<string>> {
		return this.attempt('getSubmodules', (backend) => backend.getSubmodules(repo));
	}

	public getCurrentBranchUpstream(repo: string): Promise<string | null> {
		return this.attempt('getCurrentBranchUpstream', (backend) => backend.getCurrentBranchUpstream(repo));
	}

	public countCommitsBefore(
		repo: string,
		branches: ReadonlyArray<string> | null,
		hash: string,
		showRemoteBranches: boolean,
		includeCommitsMentionedByReflogs: boolean
	): Promise<number> {
		return this.attempt('countCommitsBefore', (backend) =>
			backend.countCommitsBefore(repo, branches, hash, showRemoteBranches, includeCommitsMentionedByReflogs)
		);
	}
}

/**
 * Build the backend the extension should use.
 *
 * On a platform with a prebuilt engine this is the engine, wrapped so that anything it cannot
 * answer reaches the `git` CLI. On a platform without one — or when the user has asked for the CLI
 * — it is the CLI alone, and the extension behaves exactly as the original did.
 */
export function createBackend(options: BackendOptions = {}): GitBackend {
	const cli = new CliBackend(options.gitPath);

	if (options.prefer === 'git-cli') return cli;
	if (!isAddonAvailable()) return cli;

	try {
		return new FallbackBackend(new NativeBackend(), cli, options.onFallback);
	} catch {
		// Loading the addon can fail for reasons the availability probe cannot see (a mismatched
		// Node ABI, a missing system library). The extension still works; it is just not faster.
		return cli;
	}
}

/** Which backend `createBackend` would pick, without building it. */
export function describeBackend(options: BackendOptions = {}): string {
	if (options.prefer === 'git-cli') return 'git-cli';
	return isAddonAvailable() ? 'rust' : 'git-cli';
}

/**
 * Which backend serves each area of the extension *on the platform this editor is running on*.
 *
 * The split differs per platform: everywhere the engine binary loads, the reads are served by
 * Rust (with the two documented hybrids), and the write path spawns `git`; on a platform without
 * a binary — an architecture the engine is not built for, or a package missing it — everything
 * runs over the `git` CLI. This report is what the Settings widget's backend section shows, so
 * a user can see at a glance what is fast and what is not, on their machine.
 */
export function describeCapabilities(options: { addonRoot?: string } = {}): BackendReport {
	const engineAvailable = isAddonAvailable(options.addonRoot);
	let engineVersion: string | null = null;
	if (engineAvailable) {
		try {
			engineVersion = (options.addonRoot === undefined ? loadAddon() : loadAddon(options.addonRoot)).engineVersion();
		} catch {
			// The availability probe succeeded but the version call failed: report without it.
		}
	}

	const onEngine: BackendCapability[] = [
		{ area: 'repoInfo', provider: 'rust' },
		{ area: 'commits', provider: 'rust' },
		{ area: 'details', provider: 'rust' },
		{ area: 'diffs', provider: 'rust' },
		{ area: 'onDemand', provider: 'rust' },
		{ area: 'metadata', provider: 'rust' },
		// Reflog tips and `--glob=` patterns are declined by the engine and answered by the CLI,
		// transparently, per call.
		{ area: 'counting', provider: 'rust', note: 'dynamic' },
		// Remotes, identity, push default and diff tools come from the engine; the branch-level
		// config and the author list still spawn git (the settings widget's own data source).
		{ area: 'config', provider: 'hybrid', note: 'configHybrid' },
		{ area: 'writes', provider: 'git-cli', note: 'writesAlways' }
	];
	const onCli: BackendCapability[] = [
		'repoInfo', 'commits', 'details', 'diffs', 'onDemand', 'metadata', 'counting', 'config', 'writes'
	].map((area) => ({ area, provider: 'git-cli' as const }));

	return {
		platform: platformKey(),
		engineAvailable,
		engineVersion,
		capabilities: engineAvailable ? onEngine : onCli
	};
}

/**
 * Choosing a backend, and falling back when one cannot answer.
 *
 * The extension asks for a `GitBackend` and gets one. Which implementation it is — and whether a
 * particular call was served by the Rust engine or by the `git` command line — is not the calling
 * code's concern, which is what lets the engine grow one capability at a time.
 */

import { GitBackend, NativeBackend } from './api';
import { isAddonAvailable } from './addon';
import { CliBackend } from './cliBackend';
import {
	GitBackendError,
	GitCommitData,
	GitCommitDetails,
	GitCommitFile,
	GitCommitStash,
	GitConfigSnapshot,
	GitFileChange,
	GitRefData,
	GitRepoInfo,
	GitStash,
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

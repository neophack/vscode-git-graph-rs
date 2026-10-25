import { checkUnsafeGitArgs, Localize } from '../git/write/argSafety';
import type { GitBackend } from '../git/read/gitReader';
import type { GitCommitDetails, GitRepoInfo, GitSignature } from '../git/read/types';
import { GitSignatureStatus, UNCOMMITTED } from '../git/read/types';
import type { GitRunnerPort } from './gitRunner';
import type {
	ErrorInfo, GitCommitDetails as CommitDetailsView, GitCommitStash, GitFileChange as FileChangeView, GitStash,
	GitTagDetails as TagDetailsView, GitLineCounts, GitRepoConfig, GitRepoConfigBranches
} from '../../types';
import { GitConfigKey } from '../git/write/ops/config';

/** The response shape of the commitDetails handler (the legacy `GitCommitDetailsData`). */
export interface CommitDetailsData { readonly commitDetails: CommitDetailsView | null; readonly error: ErrorInfo }
/** The response shape of the compareCommits handler (the legacy `GitCommitComparisonData`). */
export interface CommitComparisonData { readonly fileChanges: ReadonlyArray<FileChangeView>; readonly error: ErrorInfo }
/** The response shape of the commitFileCounts handler (the legacy `GitCommitFileCountsData`). */
export interface CommitFileCountsData { readonly counts: { [path: string]: GitLineCounts }; readonly error: ErrorInfo }
/** The response shape of the tagDetails handler (the legacy `GitTagDetailsData`). */
export interface TagDetailsData { readonly details: TagDetailsView | null; readonly error: ErrorInfo }

/**
 * The read-side helpers of the graph view over the new git layer (REFACTOR-PLAN task 3.6): the
 * response mappings and small compositions the legacy `DataSource` performed around backend
 * reads, ported onto the structural `GitBackend` — no vscode, no processes.
 */

/** The repository info a loadRepoInfo (or the merged loadView) response carries. */
export type RepoInfoData = {
	readonly branches: ReadonlyArray<string>;
	/** The checked-out branch's short name, or NULL when HEAD is detached. */
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly tags: ReadonlyArray<string>;
	/** Writable: the handler clears the error when the repository no longer exists. */
	error: ErrorInfo;
};

/** The per-repository configuration the loadConfig response carries. */
export type RepoConfigData = { readonly config: GitRepoConfig | null; readonly error: ErrorInfo };

/**
 * Read the repository info of a `loadRepoInfo` request, with the legacy error mapping: a failed
 * read answers the empty lists plus the error message, never a rejection (the handler clears the
 * error when the repository no longer exists).
 */
export function readRepoInfo(
	read: GitBackend,
	repo: string,
	options: { showRemoteBranches: boolean; showRemoteHeads: boolean; hideRemotes: ReadonlyArray<string>; showStashes: boolean }
): Promise<RepoInfoData> {
	return read.getRepoInfo(repo, {
		showRemoteBranches: options.showRemoteBranches,
		showRemoteHeads: options.showRemoteHeads,
		hideRemotes: options.hideRemotes,
		showChangeRefs: false,
		showStashes: options.showStashes
	}).then((info: GitRepoInfo) => ({
		branches: info.branches,
		head: info.head,
		remotes: info.remotes,
		stashes: info.stashes,
		tags: info.tags,
		error: info.error
	}), (errorMessage: unknown) => ({
		branches: [] as ReadonlyArray<string>,
		head: null,
		remotes: [] as ReadonlyArray<string>,
		stashes: [] as ReadonlyArray<GitStash>,
		tags: [] as ReadonlyArray<string>,
		error: errorText(errorMessage)
	}));
}

/**
 * Verify a commit's signature with the Git CLI when the engine could only report "cannot be
 * checked": the engine does not implement the keyring integration, so it declines and the CLI
 * fallback answers. A backend that is already the CLI (or a missing Git executable, or a
 * signature that carries a real verdict) needs no second read.
 */
export async function verifyCommitSignature(read: GitBackend, hasGit: boolean, repo: string, details: GitCommitDetails): Promise<GitCommitDetails> {
	if (!hasGit || read.name === 'git-cli' || details.signature === null || details.signature === undefined
		|| details.signature.status !== GitSignatureStatus.CannotBeChecked
		|| details.signature.key !== '' || details.signature.signer !== '') {
		return details;
	}
	try {
		const signature = await read.getCommitSignature(repo, details.hash);
		return signature === null ? details : { ...details, signature: signature };
	} catch (_) {
		// A failed verification read must not fail the details load: the placeholder status stays.
		return details;
	}
}

/**
 * The stash/commit details read of the Commit Details View: the backend read plus the signature
 * verification follow-up, with the legacy `{ commitDetails, error }` response shape.
 */
export async function readCommitDetails(
	read: GitBackend,
	hasGit: boolean,
	repo: string,
	readOnce: (repo: string) => Promise<GitCommitDetails>
): Promise<CommitDetailsData> {
	try {
		const details = await readOnce(repo);
		const verified = await verifyCommitSignature(read, hasGit, repo, details);
		return { commitDetails: verified as unknown as CommitDetailsView, error: null };
	} catch (error) {
		return { commitDetails: null, error: errorText(error) };
	}
}

/** The details read of the "Uncommitted Changes" row (no signature verification: it has none). */
export async function readUncommittedDetails(read: GitBackend, repo: string): Promise<CommitDetailsData> {
	try {
		const details = await read.getUncommittedDetails(repo);
		return { commitDetails: details as unknown as CommitDetailsView, error: null };
	} catch (error) {
		return { commitDetails: null, error: errorText(error) };
	}
}

/**
 * The tag details read of the tag dialog: the backend read plus the same signature verification
 * the commit details get.
 */
export async function readTagDetails(read: GitBackend, hasGit: boolean, repo: string, tagName: string): Promise<TagDetailsData> {
	try {
		const details = await read.getTagDetails(repo, tagName);
		if (hasGit && read.name !== 'git-cli' && details.signature !== null && details.signature !== undefined
			&& details.signature.status === GitSignatureStatus.CannotBeChecked
			&& details.signature.key === '' && details.signature.signer === '') {
			try {
				const signature: GitSignature | null = await read.getTagSignature(repo, tagName);
				return { details: (signature === null ? details : { ...details, signature: signature }) as unknown as TagDetailsView, error: null };
			} catch (_) {
				return { details: details as unknown as TagDetailsView, error: null };
			}
		}
		return { details: details as unknown as TagDetailsView, error: null };
	} catch (error) {
		return { details: null, error: errorText(error) };
	}
}

/** The Commit Comparison view's file list, with the legacy argument checks and error mapping. */
export async function readCommitComparison(read: GitBackend, t: Localize, repo: string, fromHash: string, toHash: string): Promise<CommitComparisonData> {
	const unsafe = checkUnsafeGitArgs(t,
		['fromHash', fromHash === UNCOMMITTED ? null : fromHash, 'hash'],
		['toHash', toHash === UNCOMMITTED ? null : toHash, 'hash']);
	if (unsafe !== null) return { fileChanges: [], error: unsafe };
	try {
		const fileChanges = await read.compareCommits(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash);
		return { fileChanges: [...fileChanges] as unknown as ReadonlyArray<FileChangeView>, error: null };
	} catch (error) {
		return { fileChanges: [], error: errorText(error) };
	}
}

/** The progressive +/- line counts of the details / comparison views, with the same mapping. */
export async function readFileCounts(read: GitBackend, t: Localize, repo: string, from: string | null, to: string, paths: ReadonlyArray<string>): Promise<CommitFileCountsData> {
	const unsafe = checkUnsafeGitArgs(t,
		['from', from, 'hash'],
		['to', to === UNCOMMITTED ? null : to, 'hash']);
	if (unsafe !== null) return { counts: {}, error: unsafe };
	try {
		const counts: { [path: string]: GitLineCounts } = await read.getLineCounts(repo, from, to, paths);
		return { counts: counts, error: null };
	} catch (error) {
		return { counts: {}, error: errorText(error) };
	}
}

/** The stash details read delegates to the same verification path as a plain commit. */
export function readStashDetails(read: GitBackend, hasGit: boolean, repo: string, hash: string, stash: GitCommitStash): Promise<CommitDetailsData> {
	return readCommitDetails(read, hasGit, repo, (r) => read.getStashDetails(r, hash, {
		selector: stash.selector,
		baseHash: stash.baseHash,
		untrackedFilesHash: stash.untrackedFilesHash
	}));
}

/**
 * The remotes of a repository whose branches contain the given commit (`git branch -r --contains`,
 * the preflight of `pushTag` and of the earlier-commit `editCommitMessage`): the read backend has
 * no dedicated method, so the runner asks the CLI, exactly as the legacy private helper did.
 * @returns The known remotes that contain the commit; the empty list on a failed read means
 *          "unknown" and must not be mistaken for "none" by callers that guard on it.
 */
export async function getRemotesContainingCommit(runner: GitRunnerPort, repo: string, commitHash: string, knownRemotes: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
	const stdout = await runner.gitOutput(['branch', '-r', '--no-color', '--contains=' + commitHash], repo, (out) => out);
	const branchNames = stdout.split(/\r\n|\r|\n/)
		.filter((line) => line.length > 2)
		.map((line) => line.substring(2).split(' -> ')[0])
		.filter((branchName) => !/^\(.* .*\)$/.test(branchName));
	return knownRemotes.filter((knownRemote) => {
		const prefix = knownRemote + '/';
		return branchNames.some((branchName) => branchName.startsWith(prefix));
	});
}

/**
 * The composed repository configuration read of the Settings widget (the legacy `loadConfig`):
 * the backend's config snapshot (remotes with URLs, push default, diff tools), the branch
 * remote/pushRemote map and the user identity from the local and global config lists, and the
 * author list — one response, cached per repository.
 */
export async function loadRepoConfig(read: GitBackend, repo: string): Promise<RepoConfigData> {
	try {
		const [snapshot, localConfigs, globalConfigs, authors] = await Promise.all([
			read.getConfig(repo),
			read.getConfigList(repo, 'local'),
			read.getConfigList(repo, 'global'),
			read.getAuthors(repo).then((list) => [...list], () => [])
		]);

		const branches: GitRepoConfigBranches = {};
		Object.keys(localConfigs).forEach((key) => {
			if (key.startsWith('branch.')) {
				if (key.endsWith('.remote')) {
					const branchName = key.substring(7, key.length - 7);
					branches[branchName] = {
						pushRemote: typeof branches[branchName] !== 'undefined' ? branches[branchName].pushRemote : null,
						remote: localConfigs[key]
					};
				} else if (key.endsWith('.pushremote')) {
					const branchName = key.substring(7, key.length - 11);
					branches[branchName] = {
						pushRemote: localConfigs[key],
						remote: typeof branches[branchName] !== 'undefined' ? branches[branchName].remote : null
					};
				}
			}
		});
		return {
			config: {
				branches: branches,
				authors: authors.map((author) => ({ name: author.name, email: author.email })),
				diffTool: snapshot.diffTool,
				guiDiffTool: snapshot.diffGuiTool,
				pushDefault: snapshot.pushDefault,
				remotes: snapshot.remotes.map((remote) => ({
					name: remote.name,
					url: remote.url,
					pushUrl: remote.pushUrl
				})),
				user: {
					name: {
						local: configValue(localConfigs, GitConfigKey.UserName),
						global: configValue(globalConfigs, GitConfigKey.UserName)
					},
					email: {
						local: configValue(localConfigs, GitConfigKey.UserEmail),
						global: configValue(globalConfigs, GitConfigKey.UserEmail)
					}
				}
			},
			error: null
		};
	} catch (error) {
		return { config: null, error: errorText(error) };
	}
}

/** The value of one config key in a `--list` set, or NULL when it is unset. */
function configValue(configs: { [key: string]: string }, key: string): string | null {
	return typeof configs[key] !== 'undefined' ? configs[key] : null;
}

/**
 * The per-repository configuration cache of the legacy `DataSource.getConfig`: the composed read
 * costs several Git reads, so identical requests (same remote set) are served from it, an error
 * result is not cached (it may be transient), and `invalidate` drops one repository or all.
 */
export class RepoConfigCache {
	private readonly cache = new Map<string, { remotesSignature: string; promise: Promise<RepoConfigData> }>();

	constructor(private readonly read: () => GitBackend) {}

	/** The cached composed configuration of a repository, keyed by its remote set. */
	public load(repo: string, remotes: ReadonlyArray<string>): Promise<RepoConfigData> {
		const remotesSignature = remotes.join('\n');
		const cached = this.cache.get(repo);
		if (cached !== undefined && cached.remotesSignature === remotesSignature) return cached.promise;
		const promise = loadRepoConfig(this.read(), repo).then((data) => {
			if (data.error !== null && this.cache.get(repo)?.promise === promise) this.cache.delete(repo);
			return data;
		});
		this.cache.set(repo, { remotesSignature: remotesSignature, promise: promise });
		return promise;
	}

	/** Drop the cached configuration of one repository (or every repository for NULL). */
	public invalidate(repo: string | null): void {
		if (repo === null) this.cache.clear();
		else this.cache.delete(repo);
	}
}

/** The failure message of a rejected backend read, as the legacy mappings surfaced it. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

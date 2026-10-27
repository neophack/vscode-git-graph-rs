/**
 * The Rust engine backend: `NativeBackend`, the `GitBackend` implementation reached through the
 * native addon, and the cancellable-request machinery that shares its typed request seam.
 *
 * The contract it implements lives in ./backend.ts; `gitReader.ts` re-exports both for the
 * importers that predate the split.
 */

import { cancel, loadAddon, request } from './addonLoader';
import { GerritChangeState } from '../../../shared/model/gerrit';
import type { AbortLike } from '../process/gitProcess';
import { isValidCommitHash } from '../write/argSafety';
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
import type { GitBackend } from './backend';
import { EngineMethod, EngineMethods } from '../../../shared/engine/protocol';

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

	public getCommits(repo: string, options: LogOptions, signal?: AbortLike): Promise<GitCommitData> {
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
		const params = payload as EngineMethods['loadCommits']['params'];
		if (signal === undefined) {
			return request(repo, 'loadCommits', params);
		}
		// The structural cancellation surface (task 2.9): an aborted signal cancels the in-flight
		// request by id, and the promise rejects with kind `Cancelled` — the same outcome the CLI
		// adapter produces by killing its child process.
		const requestId = issueRequestId();
		const onAbort = () => cancel(requestId);
		signal.addEventListener('abort', onAbort);
		return request(repo, 'loadCommits', params, undefined, { requestId }).finally(() => {
			signal.removeEventListener('abort', onAbort);
		});
	}

	public getRefs(repo: string, options?: RefReadOptions): Promise<GitRefData> {
		const payload = { ...DEFAULT_REF_OPTIONS, ...options } as EngineMethods['loadRefs']['params'];
		return request(repo, 'loadRefs', payload);
	}

	/** The engine's one-pass ref snapshot (task 4.8): dropdown data without a history walk. */
	public getRefSnapshot(repo: string, options?: RefReadOptions): Promise<GitRefSnapshot> {
		const payload = { ...DEFAULT_REF_OPTIONS, ...options } as EngineMethods['refs']['params'];
		return request(repo, 'refs', payload);
	}

	/**
	 * The engine's refs-only re-annotation (task 4.8): fresh labels for the commits the caller
	 * already holds, with the same signal-based cancellation a page walk gets.
	 */
	public annotate(repo: string, commits: ReadonlyArray<string>, options?: AnnotateReadOptions, signal?: AbortLike): Promise<GitAnnotation> {
		const payload = {
			commits: [...commits],
			refs: { ...DEFAULT_REF_OPTIONS, ...options } as EngineMethods['annotate']['params']['refs'],
			showTags: options?.showTags ?? true
		};
		if (signal === undefined) {
			return request(repo, 'annotate', payload);
		}
		const requestId = issueRequestId();
		const onAbort = () => cancel(requestId);
		signal.addEventListener('abort', onAbort);
		return request(repo, 'annotate', payload, undefined, { requestId }).finally(() => {
			signal.removeEventListener('abort', onAbort);
		});
	}

	public async getRepoChangeSignature(repo: string): Promise<string | null> {
		// The same composite the CLI adapter answers from its ref scan and stash reflog: the JSON
		// of HEAD and of every ref list with its hashes, so the two backends poll identically.
		try {
			const [refs, stashes] = await Promise.all([this.getRefs(repo, { showRemoteBranches: true }), this.getStashes(repo)]);
			return JSON.stringify([refs.head, refs.heads, refs.tags, refs.remotes, stashes]);
		} catch (error) {
			// A decline (Unsupported / NotARepository) must escape so the fallback reader routes
			// the composite to the git CLI; only a genuine failure resolves to null.
			if (error instanceof GitBackendError && error.isFallbackWorthy) throw error;
			return null;
		}
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

	public compareFileDiff(repo: string, from: string, to: string, oldFilePath: string, newFilePath: string): Promise<string> {
		if (oldFilePath === newFilePath && to !== '' && isValidCommitHash(to) && from === to + '^') {
			// The diff of a single file in a single commit: the engine's fileDiff answers it directly.
			return request(repo, 'fileDiff', { revision: to, path: newFilePath });
		}
		// A diff between two arbitrary revisions (or against the working tree) has no engine
		// method: decline, so the fallback serves the general CLI diff.
		return Promise.reject(new GitBackendError('Unsupported', 'A file diff between two arbitrary revisions requires the git CLI backend'));
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

	public getReflog(_repo: string, _ref: string, _limit: number): Promise<GitReflogPage> {
		return Promise.reject(new GitBackendError('Unsupported', 'The reflog read requires the git CLI backend'));
	}

	public getWorktrees(_repo: string): Promise<ReadonlyArray<GitWorktree>> {
		return Promise.reject(new GitBackendError('Unsupported', 'The worktree list requires the git CLI backend'));
	}

	public predictConflicts(_repo: string, _ours: string, _theirs: string): Promise<GitConflictPrediction | null> {
		return Promise.reject(new GitBackendError('Unsupported', 'Conflict prediction (git merge-tree) requires the git CLI backend'));
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

	public getGlobalUserDetails(repo: string): Promise<{ name: string | null; email: string | null }> {
		return this.getConfigList(repo, 'global').then((configs) => ({
			name: configs['user.name'] ?? null,
			email: configs['user.email'] ?? null
		}));
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

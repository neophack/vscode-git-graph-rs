import type { WriteEffect } from '../../shared/protocol/graphView';
import type { AnnotateReadOptions, GitCommitData, RefReadOptions } from '../git/read/types';
import type { CommitDataPort } from './commitLoader';
import type { GerritChangeState } from '../../shared/model/gerrit';
import type { GitStash } from '../../shared/model/git';
import type { RequestLoadCommits, ResponseLoadCommits, ResponseLoadRepoInfo } from '../../shared/protocol/loading';
import type { ResponseMessage } from '../../shared/protocol/messages';

/**
 * The loader surface the impact refresh needs: what the {@link CommitLoader} exposes
 * about the last load it served, plus its cache and the two push paths the partial updates ride.
 * Structural, so the loader satisfies it without importing this module (one dependency
 * direction: impactRefresh → commitLoader).
 */
export interface ImpactRefreshView {
	/** The last `loadCommits` request served for the repository (the refresh's options), or NULL. */
	lastLoadRequest(repo: string): RequestLoadCommits | null;
	/** The page (without the synthetic uncommitted row) the newest delivered response carried. */
	lastRenderedPage(repo: string): GitCommitData | null;
	/** The Gerrit states the newest delivered response carried (NULL when it carried none). */
	cachedGerritStates(repo: string): GerritChangeState[] | null;
	/** Drop every cached commit page (a history-affecting write made them stale). */
	dropCachedPages(): void;
	/** Re-run a recorded request as an incremental traversal refresh, pushing through `send`. */
	reload(msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void>;
	/** Re-read the uncommitted-changes count and push the row update (the worktree refresh). */
	pushUncommittedRow(repo: string, msg: RequestLoadCommits, send: (response: ResponseLoadCommits) => void): Promise<void>;
}

/**
 * The write-path impact refresh: after a
 * write operation completed, pick the MINIMAL refresh from the effects its write ops declared.
 * The webview does not refresh itself after a write (responses.ts); it waits for the partial
 * update pushed here, which rides
 * the EXISTING response commands with the refresh ids the view last used, so its staged-response
 * processors accept and reconcile it in place:
 *
 * - `config`   → drop the config cache and push one fresh `loadConfig` response.
 * - `refs`/`head` (no `commits`) → the engine's `Refs` + `Annotate` over the page the view
 *   already holds — NO traversal runs — pushed as one `loadRepoInfo` response (the dropdown
 *   data) and one `loadCommits` response (the re-annotated page; the webview re-renders the
 *   changed rows in place, reconciled by hash).
 * - `worktree` → re-read the "Uncommitted Changes" count and push the row update only.
 * - `commits`/`stash` → drop the cached pages and re-run the recorded request through the
 *   loader as one hard reload (the engine's incremental traversal walks only the new part).
 *
 * Combinations are the union of their parts, cheapest first (a `config` push never waits for a
 * read; a `refs` annotate rides along `worktree`'s row update; anything touching `commits`
 * subsumes the rest into the single reload). A failed annotate read degrades to the reload —
 * correct, only slower.
 */

/** The repository reads the impact refresh needs (the loader's {@link CommitDataPort}). */
export type ImpactRefreshReads = CommitDataPort;

/** Everything the impact refresh touches, injected so unit tests run without Git and without vscode. */
export interface ImpactRefreshDeps {
	readonly reads: ImpactRefreshReads;
	/** The loader's view surface: the last load, the cache and the reload/row pushes. */
	readonly view: ImpactRefreshView;
	/** Whether remote HEAD refs are shown (the same setting the page load's ref read applies). */
	readonly getConfig: () => { readonly showRemoteHeads: boolean };
	readonly logger: { log(message: string): void; logError(message: string): void };
	/** The refresh ids the current page was loaded under; the pushed responses carry them. */
	readonly refreshIds: () => { readonly loadRepoInfo: number; readonly loadCommits: number };
	/** Push one response to the webview (the panel's sendMessage). */
	readonly send: (msg: ResponseMessage) => void;
	/** Drop the cached repository configuration and push one fresh `loadConfig` response. */
	readonly pushConfig: (repo: string, remotes: ReadonlyArray<string>) => void;
}

/** The impact classes of one write, as the refresh consumes them. */
interface ImpactClasses {
	readonly config: boolean;
	readonly commits: boolean;
	readonly refs: boolean;
	readonly worktree: boolean;
}

/** Fold the declared write effects into the refresh's decision classes. */
function classify(effects: ReadonlyArray<WriteEffect>): ImpactClasses {
	return {
		config: effects.includes('config'),
		// A stash entry change rewrites the graph's stash commits: it needs the traversal reload
		commits: effects.includes('commits') || effects.includes('stash'),
		// 'head' is covered by the annotate read (it returns the commit HEAD resolves to now)
		refs: effects.includes('refs') || effects.includes('head'),
		worktree: effects.includes('worktree')
	};
}

/** The ref-reading options the recorded page load used, for the refs-only reads. */
function refOptionsOf(deps: ImpactRefreshDeps, msg: RequestLoadCommits): RefReadOptions {
	return {
		showRemoteBranches: msg.showRemoteBranches,
		showRemoteHeads: deps.getConfig().showRemoteHeads,
		hideRemotes: msg.hideRemotes,
		showChangeRefs: msg.gerritFetchRefs
	};
}

/** The tag-annotation flag the recorded page load used. */
function annotateOptionsOf(deps: ImpactRefreshDeps, msg: RequestLoadCommits): AnnotateReadOptions {
	return { ...refOptionsOf(deps, msg), showTags: msg.showTags };
}

/**
 * Push the impact-based refresh after one write of `repo` completed with `effects` (as the
 * GitWriter reported them, or the protocol's per-command fallback). Never rejects: a failed
 * minimal read degrades to the full reload, and a failing reload is the loader's own error
 * contract (an error response, never a rejection).
 */
export async function refreshAfterWrite(deps: ImpactRefreshDeps, repo: string, effects: ReadonlyArray<WriteEffect>): Promise<void> {
	const msg = deps.view.lastLoadRequest(repo);
	if (msg === null) return; // the view never loaded this repository: nothing to refresh in place
	const classes = classify(effects);
	if (classes.config) deps.pushConfig(repo, msg.remotes);
	if (classes.commits) {
		await refreshByReload(deps, repo, msg);
		return;
	}
	if (classes.refs) {
		await refreshByAnnotation(deps, repo, msg);
		if (classes.worktree) await deps.view.pushUncommittedRow(repo, msg, commitsSendOf(deps));
		return;
	}
	if (classes.worktree) {
		await deps.view.pushUncommittedRow(repo, msg, commitsSendOf(deps));
	}
}

/** The `commits`-class refresh: one hard reload of the recorded request (the engine walks incrementally). */
async function refreshByReload(deps: ImpactRefreshDeps, repo: string, msg: RequestLoadCommits): Promise<void> {
	// Any cached page may be stale now (history moved): the reload bypasses the cache for this
	// request, and every OTHER key (another maxCommits, another filter) must not be served stale.
	deps.view.dropCachedPages();
	// The branch/tag lists and the in-progress-operation state ride along — a fetch may have
	// added remote branches, a conflicted merge lights the banner.
	void pushRepoInfo(deps, repo, { ...refOptionsOf(deps, msg), showStashes: true });
	await deps.view.reload({ ...msg, hard: true }, commitsSendOf(deps));
}

/**
 * The `refs`-class refresh: the engine's `Refs` + `Annotate` over the cached page — no traversal
 * — pushed as the dropdown data plus the re-annotated page. Degrades to the reload on failure.
 */
async function refreshByAnnotation(deps: ImpactRefreshDeps, repo: string, msg: RequestLoadCommits): Promise<void> {
	const page = deps.view.lastRenderedPage(repo);
	if (page === null || page.error !== null) {
		await refreshByReload(deps, repo, msg);
		return;
	}
	try {
		const hashes = page.commits.filter((commit) => commit.hash !== '*').map((commit) => commit.hash);
		const [snapshot, annotation] = await Promise.all([
			deps.reads.getRefSnapshot(repo, refOptionsOf(deps, msg)),
			deps.reads.annotate(repo, hashes, annotateOptionsOf(deps, msg))
		]);
		const refsByHash = new Map(annotation.commits.map((refs) => [refs.hash, refs]));
		const reannotated = page.commits.map((commit) => {
			const refs = refsByHash.get(commit.hash);
			if (refs === undefined) return commit; // a hash the scan did not answer keeps its labels
			return { ...commit, heads: [...refs.heads], tags: [...refs.tags], remotes: [...refs.remotes] };
		});
		deps.send(repoInfoOf(deps, msg, snapshot.branches, snapshot.branchHead, remoteNamesOf(snapshot)));
		deps.send({
			command: 'loadCommits',
			refreshId: deps.refreshIds().loadCommits,
			onlyFollowFirstParent: msg.onlyFollowFirstParent,
			// The cached states ride along unchanged: a refs-only write did not touch them, and a
			// NULL here would wipe the rendered badges (the webview clears Gerrit data on NULL)
			gerritStates: deps.view.cachedGerritStates(repo),
			// The row is not re-read by a refs-only write: mark it pending so the view keeps the
			// rendered row (its count) instead of dropping it with the pushed list
			uncommittedPending: true,
			commits: reannotated,
			head: annotation.head,
			tags: [...snapshot.tagNames],
			moreCommitsAvailable: page.moreCommitsAvailable,
			branches: [...snapshot.branches],
			error: null
		});
	} catch (error) {
		deps.logger.logError('The refs-only refresh of ' + repo + ' failed, reloading instead: ' + (error instanceof Error ? error.message : String(error)));
		await refreshByReload(deps, repo, msg);
	}
}

/** Push one `loadRepoInfo` response (the dropdown data), carrying the operation state read. */
async function pushRepoInfo(deps: ImpactRefreshDeps, repo: string, options: RefReadOptions & { readonly showStashes: boolean }): Promise<void> {
	try {
		const info = await deps.reads.getRepoInfo(repo, options);
		deps.send({
			command: 'loadRepoInfo',
			refreshId: deps.refreshIds().loadRepoInfo,
			branches: info.branches,
			head: info.head,
			remotes: info.remotes,
			stashes: info.stashes,
			error: info.error,
			isRepo: info.isRepo,
			operationState: info.operationState
		});
	} catch (error) {
		deps.logger.logError('The repository info push of ' + repo + ' failed: ' + (error instanceof Error ? error.message : String(error)));
	}
}

/** Build the `loadRepoInfo` response of a refs-only refresh from the ref snapshot (no stashes rescan). */
function repoInfoOf(deps: ImpactRefreshDeps, msg: RequestLoadCommits, branches: ReadonlyArray<string>, head: string | null, remotes: ReadonlyArray<string>): ResponseLoadRepoInfo {
	return {
		command: 'loadRepoInfo',
		refreshId: deps.refreshIds().loadRepoInfo,
		branches: [...branches],
		head: head,
		remotes: remotes,
		// Stashes did not change under a refs-only write: the list the view's last request carried
		// is what it renders, handed back unchanged (the response field is mandatory).
		stashes: [...msg.stashes] as GitStash[],
		error: null,
		isRepo: true,
		operationState: { type: null, conflictedFiles: [], progress: null }
	};
}

/** The remote NAMES of a ref snapshot: the unique first path segments of its remote refs, in order. */
function remoteNamesOf(snapshot: Awaited<ReturnType<ImpactRefreshReads['getRefSnapshot']>>): string[] {
	const names: string[] = [];
	for (const ref of snapshot.refData.remotes) {
		const separator = ref.name.indexOf('/');
		const remote = separator > -1 ? ref.name.substring(0, separator) : ref.name;
		if (!names.includes(remote)) names.push(remote);
	}
	return names;
}

/** The loadCommits send of the impact refresh (the panel's sendMessage widened to the response type). */
function commitsSendOf(deps: ImpactRefreshDeps): (response: ResponseLoadCommits) => void {
	return (response) => deps.send(response);
}

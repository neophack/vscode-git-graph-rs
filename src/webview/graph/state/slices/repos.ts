/**
 * The repositories slice (OPTIMIZATION-PLAN §6 F1): the repository set, the repository loaded in
 * the view, and the load lifecycle's view-level bookkeeping (the deferred view load, the refresh
 * cycle flags the load machine projects onto the rest of the view). The ONLY writer of these
 * fields is this class. Its actions emit NO render changes: nothing that reads these fields is
 * rendered through the scheduler (the refresh button is rendered explicitly by the load machine's
 * effects; the repository dropdown by the loader), so an emission could only schedule renders the
 * view never used to do - a repository switch re-renders through the commit page's own path.
 */

import * as GG from '../../../common/protocol';
import { RefreshState } from '../types';

export class ReposSlice {
	private reposValue: GG.GitRepoSet;
	private currentRepoValue!: string;
	private currentRepoLoadingValue: boolean = true;
	private loadViewToValue: GG.LoadGitGraphViewTo = null;
	private refreshStateValue: RefreshState;

	constructor(initialState: GG.GitGraphViewInitialState) {
		this.reposValue = initialState.repos;
		this.refreshStateValue = {
			inProgress: false,
			snapshotRefreshing: false,
			hard: true,
			loadRepoInfoRefreshId: initialState.loadRepoInfoRefreshId,
			loadCommitsRefreshId: initialState.loadCommitsRefreshId,
			loadConfigRefreshId: initialState.loadConfigRefreshId,
			repoInfoChanges: false,
			configChanges: false,
			requestingRepoInfo: false,
			requestingConfig: false
		};
	}


	/* Reads */

	public get repos(): GG.GitRepoSet {
		return this.reposValue;
	}

	/** The repository loaded in the view (undefined until the first one is chosen). */
	public get currentRepo(): string {
		return this.currentRepoValue;
	}

	public get currentRepoLoading(): boolean {
		return this.currentRepoLoadingValue;
	}

	public get loadViewTo(): GG.LoadGitGraphViewTo {
		return this.loadViewToValue;
	}

	/** The refresh cycle of the current repository (loadRepoInfo → loadCommits → loadConfig). */
	public get refreshState(): RefreshState {
		return this.refreshStateValue;
	}

	/** Is a repository loaded (or being loaded) in the view. */
	public hasCurrentRepo(): boolean {
		return typeof this.currentRepoValue !== 'undefined';
	}


	/* Actions */

	/** Replace the repository set (a `loadRepos` response). */
	public setRepos(repos: GG.GitRepoSet): void {
		this.reposValue = repos;
	}

	/** Adopt a repository as the view's current one and mark it loading (a repository switch). */
	public switchTo(repo: string): void {
		this.currentRepoValue = repo;
		this.currentRepoLoadingValue = true;
	}

	/** The current repository's first page has been applied (or the view was cleared). */
	public setCurrentRepoLoading(loading: boolean): void {
		this.currentRepoLoadingValue = loading;
	}

	/** Set (or drop) the deferred view load of the open path (a no-op when already this value). */
	public setLoadViewTo(loadViewTo: GG.LoadGitGraphViewTo): void {
		this.loadViewToValue = loadViewTo;
	}

	/** Start a load cycle: the kind flags the cycle's responses are read under, changes reset. */
	public beginCycle(hard: boolean, configChanges: boolean): void {
		this.refreshStateValue.hard = hard;
		this.refreshStateValue.configChanges = configChanges;
		this.refreshStateValue.repoInfoChanges = false;
	}

	/** Join the in-flight cycle: the kind flags escalate, never de-escalate. */
	public joinCycle(hard: boolean, configChanges: boolean): void {
		this.refreshStateValue.hard = this.refreshStateValue.hard || hard;
		this.refreshStateValue.configChanges = this.refreshStateValue.configChanges || configChanges;
	}

	/** Note that the repository info of the running cycle changed (the dialog refresh reads it). */
	public noteRepoInfoChanges(): void {
		this.refreshStateValue.repoInfoChanges = true;
	}

	/** Allocate the request id of a new cycle (or of a join): the legacy id-invalidation bump. */
	public nextCommitsRequestId(): number {
		return ++this.refreshStateValue.loadCommitsRefreshId;
	}

	/** Stamp the repo-info request id (issuing, or adopting the accepted response's id). */
	public stampRepoInfoRequestId(requestId: number): void {
		this.refreshStateValue.loadRepoInfoRefreshId = requestId;
	}

	/** Stamp the commits request id (issuing, or adopting the accepted response's id). */
	public stampCommitsRequestId(requestId: number): void {
		this.refreshStateValue.loadCommitsRefreshId = requestId;
	}

	/** Allocate the configuration load's request id and open its pending window. */
	public beginConfigLoad(): number {
		this.refreshStateValue.requestingConfig = true;
		return ++this.refreshStateValue.loadConfigRefreshId;
	}

	/** Close the configuration load's pending window (its response arrived). */
	public endConfigLoad(): void {
		this.refreshStateValue.requestingConfig = false;
	}

	/** Project the load machine's state onto the flags the rest of the view reads (F2). */
	public projectLoadState(inProgress: boolean, snapshotRefreshing: boolean, requestingRepoInfo: boolean): void {
		this.refreshStateValue.inProgress = inProgress;
		this.refreshStateValue.snapshotRefreshing = snapshotRefreshing;
		this.refreshStateValue.requestingRepoInfo = requestingRepoInfo;
	}

	/**
	 * Update one value of a repository's persisted state (the column widths, the Commit Details
	 * View's height and divider, ...). The caller sends it to the extension host
	 * (`persistence.saveRepoState`); no change is emitted - the per-repository settings shape
	 * queries, not the rendered view of the current data.
	 */
	public updateRepoState<K extends keyof GG.GitRepoState>(repo: string, key: K, value: GG.GitRepoState[K]): void {
		const repoState = this.reposValue[repo];
		if (repoState === undefined) return;
		repoState[key] = value;
	}
}

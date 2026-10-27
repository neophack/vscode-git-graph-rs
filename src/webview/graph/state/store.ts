/**
 * The Store: the single source of truth of the
 * Git Graph View's data, organised into SLICES - `repos`, `refs`, `commits`, `details`, `ui`,
 * `integrations` - each the ONLY writer of its own fields, changed from outside only through the
 * slice's named actions. Every action emits a typed change (`{ slice, keys }`, see changes.ts)
 * that the render scheduler collects per frame and routes to the renderers subscribed to the
 * changed slices. The store's own surface is read-only: getters delegate to the slices, and two
 * notification channels sit beside them - the Extension Settings' `config` listeners, and the
 * render-invalidation channel (`invalidateRender()` = the coalesced FULL invalidation; slices
 * emit the precise per-slice changes).
 *
 * The Extension Settings have exactly one home, `config`: a `configChanged` message replaces it
 * (`setConfig`), and every reader - formatters included - takes the value from here, so no
 * component can keep running on the configuration the page was created with.
 */

import { strings, formatStr } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { SHOW_ALL_BRANCHES } from '../../common/util';
import { StoreChange } from './changes';
import { CommitsSlice } from './slices/commits';
import { DetailsSlice } from './slices/details';
import { IntegrationsSlice } from './slices/integrations';
import { RefsSlice } from './slices/refs';
import { ReposSlice } from './slices/repos';
import { UiSlice } from './slices/ui';
import { ExpandedCommit, RefreshState } from './types';

/** An option of a dialog select input or a dropdown. */
export interface SelectOption {
	readonly name: string;
	readonly value: string;
}

/** A render-change listener: the change an action emitted, or NULL for a full invalidation. */
export type RenderChangeListener = (change: StoreChange | null) => void;

export class Store {
	/* Extension Settings & environment */
	private configValue: GG.GitGraphViewConfig;
	private readonly configListeners: Array<(config: GG.GitGraphViewConfig, previous: GG.GitGraphViewConfig) => void> = [];
	/**
	 * Render-change listeners: every slice action's change (and every
	 * `invalidateRender()`) reaches them; the subscriber (main.ts wires the render scheduler)
	 * coalesces the notifications into ONE render on the next frame - however many changes a
	 * response made.
	 */
	private readonly renderListeners: Array<RenderChangeListener> = [];
	public readonly backend: GG.BackendReport;
	public readonly globalViewState: GG.DeepWriteable<GG.GitGraphViewGlobalState>;
	public readonly workspaceViewState: GG.DeepWriteable<GG.GitGraphViewWorkspaceState>;

	/* The slices (each the only writer of its fields; readonly from outside) */
	public readonly slices: {
		readonly repos: ReposSlice;
		readonly refs: RefsSlice;
		readonly commits: CommitsSlice;
		readonly details: DetailsSlice;
		readonly ui: UiSlice;
		readonly integrations: IntegrationsSlice;
	};

	constructor(initialState: GG.GitGraphViewInitialState, globalViewState: GG.GitGraphViewGlobalState, workspaceViewState: GG.GitGraphViewWorkspaceState) {
		this.configValue = initialState.config;
		this.backend = initialState.backend;
		this.globalViewState = globalViewState;
		this.workspaceViewState = workspaceViewState;
		this.slices = {
			repos: new ReposSlice(initialState),
			refs: new RefsSlice(this.emitRenderChange.bind(this)),
			commits: new CommitsSlice(initialState, this.emitRenderChange.bind(this)),
			details: new DetailsSlice(),
			ui: new UiSlice(),
			integrations: new IntegrationsSlice(this.emitRenderChange.bind(this))
		};
	}


	/* Extension Settings */

	/** The Extension Settings the view runs on. */
	public get config(): GG.GitGraphViewConfig {
		return this.configValue;
	}

	/** Replace the Extension Settings (a `configChanged` message), notifying the subscribers. */
	public setConfig(config: GG.GitGraphViewConfig) {
		const previous = this.configValue;
		this.configValue = config;
		for (let i = 0; i < this.configListeners.length; i++) this.configListeners[i](config, previous);
	}

	/** Subscribe to replacements of the Extension Settings. */
	public onConfigChange(listener: (config: GG.GitGraphViewConfig, previous: GG.GitGraphViewConfig) => void) {
		this.configListeners.push(listener);
	}


	/* Render invalidation */

	/**
	 * Subscribe to render changes: the typed change of each slice action (NULL for a full
	 * invalidation). @returns The unsubscribe function.
	 */
	public onRenderChange(listener: RenderChangeListener): () => void {
		this.renderListeners.push(listener);
		return () => {
			const index = this.renderListeners.indexOf(listener);
			if (index >= 0) this.renderListeners.splice(index, 1);
		};
	}

	/**
	 * Mark the rendered view fully stale: whatever changed, the DOM may not reflect the store.
	 * The subscribers merge any number of these into a single render on the next animation frame.
	 * Slice actions do NOT call this - they emit their typed change, which routes precisely; this
	 * is the whole-view invalidation (the configuration applier, the Gerrit filter).
	 */
	public invalidateRender(): void {
		this.emitRenderChange(null);
	}

	private emitRenderChange(change: StoreChange | null): void {
		for (let i = 0; i < this.renderListeners.length; i++) this.renderListeners[i](change);
	}


	/* Repositories */

	/** The persisted state of the current repository. */
	public get repoState(): GG.GitRepoState {
		return this.slices.repos.repos[this.slices.repos.currentRepo];
	}

	/** The Issue Linking configuration in effect: the current repository's own, else the global one. */
	public getIssueLinkingConfig(): GG.IssueLinkingConfig | null {
		const repos = this.slices.repos.repos, currentRepo = this.slices.repos.currentRepo;
		const repoConfig = this.slices.repos.hasCurrentRepo() && typeof repos[currentRepo] !== 'undefined' ? repos[currentRepo].issueLinkingConfig : null;
		return repoConfig !== null ? repoConfig : this.globalViewState.issueLinkingConfig;
	}

	/** The persisted state of a repository, or NULL if it is unknown. */
	public getRepoState(repo: string): Readonly<GG.GitRepoState> | null {
		const repos = this.slices.repos.repos;
		return typeof repos[repo] !== 'undefined' ? repos[repo] : null;
	}

	/** Is a repository loaded (or being loaded) in the view. */
	public hasCurrentRepo() {
		return this.slices.repos.hasCurrentRepo();
	}


	/* The current repository's refs and query filters (the refs slice) */

	public get repos(): GG.GitRepoSet {
		return this.slices.repos.repos;
	}

	public get currentRepo(): string {
		return this.slices.repos.currentRepo;
	}

	public get currentRepoLoading(): boolean {
		return this.slices.repos.currentRepoLoading;
	}

	public get refreshState(): RefreshState {
		return this.slices.repos.refreshState;
	}

	public get loadViewTo(): GG.LoadGitGraphViewTo {
		return this.slices.repos.loadViewTo;
	}

	public get gitBranches(): ReadonlyArray<string> {
		return this.slices.refs.branches;
	}

	public get gitBranchHead(): string | null {
		return this.slices.refs.head;
	}

	public get gitConfig(): GG.GitRepoConfig | null {
		return this.slices.refs.repoConfig;
	}

	public get gitRemotes(): ReadonlyArray<string> {
		return this.slices.refs.remotes;
	}

	public get gitStashes(): ReadonlyArray<GG.GitStash> {
		return this.slices.refs.stashes;
	}

	public get gitTags(): ReadonlyArray<string> {
		return this.slices.refs.tags;
	}

	public get currentBranches(): string[] | null {
		return this.slices.refs.branchSelection;
	}

	public get currentAuthors(): string[] | null {
		return this.slices.refs.authorSelection;
	}

	public get commitPathFilter(): string | null {
		return this.slices.refs.pathFilter;
	}


	/* The loaded commits (the commits slice) */

	public get commits(): GG.GitCommit[] {
		return this.slices.commits.page;
	}

	public get commitHead(): string | null {
		return this.slices.commits.head;
	}

	/** The index of a loaded commit, or NULL. */
	public getCommitId(hash: string) {
		return this.slices.commits.indexOf(hash);
	}

	/** A loaded commit, or undefined. */
	public getCommit(hash: string): GG.GitCommit | undefined {
		return this.slices.commits.getCommit(hash);
	}

	/** The commit a rendered row (`data-id`) stands for, or NULL. */
	public getCommitOfElem(elem: HTMLElement) {
		const id = parseInt(elem.dataset.id!);
		return id < this.slices.commits.page.length ? this.slices.commits.page[id] : null;
	}

	/** Which of two loaded commits is older (`from`) and which newer (`to`). */
	public getCommitOrder(hash1: string, hash2: string) {
		return this.slices.commits.getCommitOrder(hash1, hash2);
	}

	public get onlyFollowFirstParent(): boolean {
		return this.slices.commits.onlyFollowFirstParent;
	}

	public get moreCommitsAvailable(): boolean {
		return this.slices.commits.moreCommitsAvailable;
	}

	public get maxCommits(): number {
		return this.slices.commits.maxCommits;
	}

	public get uncommittedCount(): number | null {
		return this.slices.commits.uncommittedCount;
	}

	/** The branch the rendered rows were built for (a change forces a re-render of the rows). */
	public get renderedGitBranchHead(): string | null {
		return this.slices.commits.renderedHead;
	}

	public get avatars(): { [email: string]: string } {
		return this.slices.commits.avatars;
	}


	/* The view's selections */

	public get compareSourceHash(): string | null {
		return this.slices.ui.compareSourceHash;
	}

	public get scrollTop(): number {
		return this.slices.ui.scrollTop;
	}

	/** The commit whose Commit Details View (or Commit Comparison) is open. */
	public get expandedCommit(): ExpandedCommit | null {
		return this.slices.details.expanded;
	}


	/* Integrations */

	public get gerritStates(): { [hash: string]: GG.GerritChangeState } {
		return this.slices.integrations.gerritStates;
	}

	/** TRUE when the Gerrit states changed in a way the rendered rows don't reflect yet (forces a re-render). */
	public get gerritStatesDirty(): boolean {
		return this.slices.integrations.gerritStatesDirty;
	}

	public get pullRequestsByHead(): { [hash: string]: GG.PullRequestInfo } {
		return this.slices.integrations.pullRequestsByHead;
	}


	/* Dropdown options */

	public getBranchOptions(includeShowAll?: boolean): ReadonlyArray<SelectOption> {
		const options: SelectOption[] = [];
		if (includeShowAll) {
			options.push({ name: strings.settingsShowAll, value: SHOW_ALL_BRANCHES });
		}
		options.push({ name: 'HEAD', value: 'HEAD' });
		const globPatterns = this.config.customBranchGlobPatterns;
		for (let i = 0; i < globPatterns.length; i++) {
			options.push({ name: formatStr(strings.globPrefix, globPatterns[i].name), value: globPatterns[i].glob });
		}
		const branches = this.gitBranches;
		for (let i = 0; i < branches.length; i++) {
			options.push({ name: branches[i].indexOf('remotes/') === 0 ? branches[i].substring(8) : branches[i], value: branches[i] });
		}
		return options;
	}

	public getAuthorOptions(): ReadonlyArray<SelectOption> {
		const options: SelectOption[] = [];
		options.push({ name: strings.authorsAll, value: SHOW_ALL_BRANCHES });
		if (this.gitConfig && this.gitConfig.authors) {
			for (let i = 0; i < this.gitConfig.authors.length; i++) {
				const author = this.gitConfig.authors[i];
				options.push({ name: author.name, value: author.name });
			}
		}
		return options;
	}

	/** The glob patterns of the custom branch glob patterns setting. */
	public getBranchGlobPatterns() {
		return this.config.customBranchGlobPatterns.map((pattern) => pattern.glob);
	}

	/** The branches selected in the branches dropdown, NULL for "Show All". */
	public getSelectedBranchesFilter() {
		const currentBranches = this.currentBranches;
		return currentBranches === null || (currentBranches.length === 1 && currentBranches[0] === SHOW_ALL_BRANCHES) ? null : currentBranches;
	}

	/** The authors selected in the authors dropdown, NULL for "All Authors". */
	public getSelectedAuthorsFilter() {
		const currentAuthors = this.currentAuthors;
		return currentAuthors === null || (currentAuthors.length === 1 && currentAuthors[0] === SHOW_ALL_BRANCHES) ? null : currentAuthors;
	}

	/**
	 * The remote a branch is pushed to by default: its configured push remote or remote, the
	 * repository's push default, or "origin" - whichever exists first - else the first remote.
	 */
	public getPushRemote(branch: string | null = null) {
		const possibleRemotes: Array<string | null> = [];
		if (this.gitConfig !== null) {
			if (branch !== null && typeof this.gitConfig.branches[branch] !== 'undefined') {
				possibleRemotes.push(this.gitConfig.branches[branch].pushRemote, this.gitConfig.branches[branch].remote);
			}
			possibleRemotes.push(this.gitConfig.pushDefault);
		}
		possibleRemotes.push('origin');
		return possibleRemotes.find((remote) => remote !== null && this.gitRemotes.includes(remote)) || this.gitRemotes[0];
	}

	/** Is the configuration of the current repository being (re)loaded. */
	public isConfigLoading(): boolean {
		return this.refreshState.requestingConfig;
	}


	/* Pinned commits & branches */

	public getPinnedCommits(): GG.PinnedCommit[] {
		const repo = this.repos[this.currentRepo];
		return repo !== undefined && repo.pinnedCommits !== undefined ? repo.pinnedCommits : [];
	}

	public getPinnedBranches(): string[] {
		const repo = this.repos[this.currentRepo];
		return repo !== undefined && repo.pinnedBranches !== undefined ? repo.pinnedBranches : [];
	}

	public isCommitPinned(hash: string) {
		return this.getPinnedCommits().some((pinned) => pinned.hash === hash);
	}


	/* Gerrit */

	/**
	 * Does a Gerrit change pass the repository's status filter (the checkboxes of the Repository
	 * Settings)? Mirrors the extension's `filterChangeStates`, which selects the change refs
	 * injected into the commit graph: a WIP change is shown iff "Work in Progress" is checked,
	 * any other change iff its status is checked.
	 */
	public gerritPassesFilter(state: GG.GerritChangeState): boolean {
		const filter = this.repos[this.currentRepo].gerritStatusFilter;
		if (state.wip) return filter.wip;
		return filter[state.status];
	}

	/**
	 * The Gerrit changes whose badge is rendered: the `gerrit.fetchLimit` (or the repository's own
	 * override) most recent changes passing the status filter whose head commit has a row on the
	 * page (the extension injects their change refs, which pins their commits onto the page; a
	 * change without a row has nothing to carry its badge, so it claims none of the limit's badge
	 * slots). Mirrors the extension's `selectDisplayedChangeStates` selection on the same page, so
	 * the fetch limit counts the badges DISPLAYED: the number set is the number of pills shown -
	 * one per change number / patchset.
	 */
	public getGerritVisibleChanges(): Set<number> {
		const limit = this.repos[this.currentRepo].gerritFetchLimit;
		const effective = typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 10000 ? limit : this.config.gerrit.fetchLimit;
		const gerritStates = this.gerritStates;
		const passing = Object.keys(gerritStates).map((hash) => gerritStates[hash])
			.filter((state) => this.gerritPassesFilter(state) && this.slices.commits.indexOf(state.headHash) !== null)
			.sort((a, b) => b.change - a.change);
		return new Set((effective > 0 ? passing.slice(0, effective) : passing).map((state) => state.change));
	}
}

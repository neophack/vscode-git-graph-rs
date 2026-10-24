/**
 * The Store (REFACTOR-PLAN task 5.4): the single source of truth of the Git Graph View's data -
 * the repositories, the current repository's refs, commits and configuration, the Extension
 * Settings, the open Commit Details View and the integration states. Components read it, and
 * change it through the controllers that own each slice; rendering caches stay in the components.
 *
 * The Extension Settings have exactly one home, `config`: a `configChanged` message replaces it
 * (`setConfig`), and every reader - formatters included - takes the value from here, so no
 * component can keep running on the configuration the page was created with.
 */

import { strings, formatStr } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { SHOW_ALL_BRANCHES } from '../../common/util';
import { ExpandedCommit, RefreshState } from './types';

/** An option of a dialog select input or a dropdown. */
export interface SelectOption {
	readonly name: string;
	readonly value: string;
}

export class Store {
	/* Extension Settings & environment */
	private configValue: GG.GitGraphViewConfig;
	private readonly configListeners: Array<(config: GG.GitGraphViewConfig, previous: GG.GitGraphViewConfig) => void> = [];
	public readonly backend: GG.BackendReport;
	public readonly globalViewState: GG.DeepWriteable<GG.GitGraphViewGlobalState>;
	public readonly workspaceViewState: GG.DeepWriteable<GG.GitGraphViewWorkspaceState>;

	/* Repositories */
	public repos: GG.GitRepoSet;
	/** The repository loaded in the view (undefined until the first one is chosen). */
	public currentRepo!: string;
	public currentRepoLoading: boolean = true;
	public refreshState: RefreshState;
	public loadViewTo: GG.LoadGitGraphViewTo = null;

	/* The current repository's refs and configuration */
	public gitBranches: ReadonlyArray<string> = [];
	public gitBranchHead: string | null = null;
	public gitConfig: GG.GitRepoConfig | null = null;
	public gitRemotes: ReadonlyArray<string> = [];
	public gitStashes: ReadonlyArray<GG.GitStash> = [];
	public gitTags: ReadonlyArray<string> = [];

	/* The loaded commits */
	public commits: GG.GitCommit[] = [];
	public commitHead: string | null = null;
	public commitLookup: { [hash: string]: number } = {};
	public onlyFollowFirstParent: boolean = false;
	public moreCommitsAvailable: boolean = false;
	public maxCommits: number;
	/**
	 * The "Uncommitted Changes" file count the view last knew about (NULL => not known yet, no
	 * final follow-up has arrived). Kept as view state so the row can be kept rendered (and its
	 * number updated in place) across responses whose commit list doesn't carry the row.
	 */
	public uncommittedCount: number | null = null;
	/** The branch the rendered rows were built for (a change forces a re-render of the rows). */
	public renderedGitBranchHead: string | null = null;
	public avatars: { [email: string]: string } = {};

	/* The view's selections */
	public currentBranches: string[] | null = null;
	public currentAuthors: string[] | null = null;
	public commitPathFilter: string | null = null; // the path filter applied to the loaded commits (persisted with the webview state)
	public compareSourceHash: string | null = null; // the commit selected via "Select for Compare" (persisted with the webview state)
	public scrollTop: number = 0;
	public expandedCommit: ExpandedCommit | null = null;

	/* Integrations */
	/** The Gerrit change states of the current repository, keyed by the head commit hash of each change. */
	public gerritStates: { [hash: string]: GG.GerritChangeState } = {};
	/** TRUE when the Gerrit states changed in a way the rendered rows don't reflect yet (forces a re-render). */
	public gerritStatesDirty: boolean = false;
	/** The pull requests of the current repository's remote, keyed by the commit each one points at. */
	public pullRequestsByHead: { [hash: string]: GG.PullRequestInfo } = {};

	constructor(initialState: GG.GitGraphViewInitialState, globalViewState: GG.GitGraphViewGlobalState, workspaceViewState: GG.GitGraphViewWorkspaceState) {
		this.configValue = initialState.config;
		this.backend = initialState.backend;
		this.globalViewState = globalViewState;
		this.workspaceViewState = workspaceViewState;
		this.repos = initialState.repos;
		this.maxCommits = initialState.config.initialLoadCommits;
		this.refreshState = {
			inProgress: false,
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


	/* Repositories */

	/** The persisted state of the current repository. */
	public get repoState(): GG.GitRepoState {
		return this.repos[this.currentRepo];
	}

	/** The Issue Linking configuration in effect: the current repository's own, else the global one. */
	public getIssueLinkingConfig(): GG.IssueLinkingConfig | null {
		const repoConfig = this.hasCurrentRepo() && typeof this.repos[this.currentRepo] !== 'undefined' ? this.repos[this.currentRepo].issueLinkingConfig : null;
		return repoConfig !== null ? repoConfig : this.globalViewState.issueLinkingConfig;
	}

	/** The persisted state of a repository, or NULL if it is unknown. */
	public getRepoState(repo: string): Readonly<GG.GitRepoState> | null {
		return typeof this.repos[repo] !== 'undefined' ? this.repos[repo] : null;
	}

	/** Is a repository loaded (or being loaded) in the view. */
	public hasCurrentRepo() {
		return typeof this.currentRepo !== 'undefined';
	}


	/* Commits */

	/** The index of a loaded commit, or NULL. */
	public getCommitId(hash: string) {
		return typeof this.commitLookup[hash] === 'number' ? this.commitLookup[hash] : null;
	}

	/** A loaded commit, or undefined. */
	public getCommit(hash: string): GG.GitCommit | undefined {
		return this.commits[this.commitLookup[hash]];
	}

	/** The commit a rendered row (`data-id`) stands for, or NULL. */
	public getCommitOfElem(elem: HTMLElement) {
		const id = parseInt(elem.dataset.id!);
		return id < this.commits.length ? this.commits[id] : null;
	}

	/** Which of two loaded commits is older (`from`) and which newer (`to`). */
	public getCommitOrder(hash1: string, hash2: string) {
		if (this.commitLookup[hash1] > this.commitLookup[hash2]) {
			return { from: hash1, to: hash2 };
		} else {
			return { from: hash2, to: hash1 };
		}
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
		for (let i = 0; i < this.gitBranches.length; i++) {
			options.push({ name: this.gitBranches[i].indexOf('remotes/') === 0 ? this.gitBranches[i].substring(8) : this.gitBranches[i], value: this.gitBranches[i] });
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
		return this.currentBranches === null || (this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES) ? null : this.currentBranches;
	}

	/** The authors selected in the authors dropdown, NULL for "All Authors". */
	public getSelectedAuthorsFilter() {
		return this.currentAuthors === null || (this.currentAuthors.length === 1 && this.currentAuthors[0] === SHOW_ALL_BRANCHES) ? null : this.currentAuthors;
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
		const passing = Object.keys(this.gerritStates).map((hash) => this.gerritStates[hash])
			.filter((state) => this.gerritPassesFilter(state) && typeof this.commitLookup[state.headHash] === 'number')
			.sort((a, b) => b.change - a.change);
		return new Set((effective > 0 ? passing.slice(0, effective) : passing).map((state) => state.change));
	}
}

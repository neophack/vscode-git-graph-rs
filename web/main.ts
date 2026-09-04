class GitGraphView {
	public gitRepos: GG.GitRepoSet;
	public gitBranches: ReadonlyArray<string> = [];
	public gitBranchHead: string | null = null;
	public gitConfig: GG.GitRepoConfig | null = null;
	public gitRemotes: ReadonlyArray<string> = [];
	private gitStashes: ReadonlyArray<GG.GitStash> = [];
	public gitTags: ReadonlyArray<string> = [];
	public commits: GG.GitCommit[] = [];
	public commitHead: string | null = null;
	public commitLookup: { [hash: string]: number } = {};
	public onlyFollowFirstParent: boolean = false;
	private avatars: AvatarImageCollection = {};
	/**
	 * The "Uncommitted Changes" file count the view last knew about (NULL => not known yet, no
	 * final follow-up has arrived). Kept as view state so the row can be kept rendered (and its
	 * number updated in place) across responses whose commit list doesn't carry the row.
	 */
	private uncommittedCount: number | null = null;
	private currentBranches: string[] | null = null;
	private currentAuthors: string[] | null = null;

	public currentRepo!: string;
	private currentRepoLoading: boolean = true;
	public currentRepoRefreshState: {
		inProgress: boolean;
		hard: boolean;
		loadRepoInfoRefreshId: number;
		loadCommitsRefreshId: number;
		repoInfoChanges: boolean;
		configChanges: boolean;
		requestingRepoInfo: boolean;
		requestingConfig: boolean;
	};
	private loadViewTo: GG.LoadGitGraphViewTo = null;
	private pendingScrollCommitHash: string | null = null;
	// TRUE between sending a countCommitsBefore request and its response: the response (not
	// checkPendingScrollCommit) decides how the pending scroll commit is loaded, so the checks run
	// on intervening loadCommits responses must not error out or start paging on their own
	private countCommitsBeforePending: boolean = false;

	public readonly graph: Graph;
	public readonly config: Config;
	/** Which backend serves each area on this platform — shown by the Settings widget. */
	public readonly backend: GG.BackendReport;

	public moreCommitsAvailable: boolean = false;
	public expandedCommit: ExpandedCommit | null = null;
	/** The Gerrit change states of the current repository, keyed by the head commit hash of each change. */
	public gerritStates: { [hash: string]: GG.GerritChangeState } = {};
	/** TRUE when the Gerrit states changed in a way the rendered rows don't reflect yet (forces a re-render). */
	private gerritStatesDirty: boolean = false;
	/** The debounce timer of the background reload triggered by a Gerrit status filter change. */
	private gerritFilterRefreshTimer: number | null = null;
	private maxCommits: number;
	public scrollTop = 0;
	private renderedGitBranchHead: string | null = null;
	/**
	 * Full commit message bodies, fetched on demand (the commit list only carries subjects, so the
	 * bodies are only requested for the rows that are actually rendered with "Show Commit Body
	 * Inline" enabled). Keyed by commit hash.
	 */
	private commitBodies: { [hash: string]: string } = {};
	private readonly commitBodiesRequested = new Set<string>(); // hashes already requested (avoids re-requesting)
	private static readonly COMMIT_BODIES_BATCH_LIMIT = 200;

	/**
	 * Windowed ("virtualized") rendering: when the loaded commit list is large, only the rows in
	 * and near the viewport are rendered, with spacer rows above and below preserving the scroll
	 * height and the graph alignment. NULL => all rows are rendered (small lists, or any state
	 * with variable row heights: an open Commit Details View, an active
	 * find query).
	 */
	private renderedRange: { start: number, end: number } | null = null;
	/**
	 * The HTML each rendered row was built from, minus the parts that are patched in place (its
	 * index, its lane colour, the checked-out marker). A row is rebuilt only when this changes, so
	 * an update that does not affect a row leaves its DOM node completely alone. Held outside the
	 * elements themselves so the nodes stay pristine.
	 */
	private readonly rowSignatures = new WeakMap<HTMLElement, string>();
	/** Which columns the rendered header row was built for (see renderTable). */
	private renderedHeaderKey: string | null = null;
	private static readonly VIRTUAL_ROW_BUFFER = 10;

	/**
	 * The scroll position saved before a webview reload, to be re-applied after the repository's
	 * commits have been rendered (the view is still empty when the state is restored, so applying
	 * it immediately would be clamped to 0). NULL => no scroll position is pending restoration.
	 */
	private restoreScrollTop: number | null = null;

	/** The branch the current pull request status was requested for (NULL => none requested). */
	private prStatusBranch: string | null = null;
	public compareSourceHash: string | null = null; // the commit selected via "Select for Compare" (persisted with the webview state)
	private commitPathFilter: string | null = null; // the path filter applied to the loaded commits (persisted with the webview state)

	private lastScrollToStash: {
		time: number,
		hash: string | null
	} = { time: 0, hash: null };

	public readonly findWidget: FindWidget;
	public readonly settingsWidget: SettingsWidget;
	public readonly repoDropdown: Dropdown;
	public readonly branchDropdown: Dropdown;
	public readonly authorDropdown: Dropdown;

	public readonly viewElem: HTMLElement;
	public readonly controlsElem: HTMLElement;
	private readonly pinnedControlsElem: HTMLElement | null;
	public readonly tableElem: HTMLElement;
	private readonly footerElem: HTMLElement;
	private readonly showRemoteBranchesElem: HTMLInputElement;
	private readonly refreshBtnElem: HTMLElement;

	constructor(viewElem: HTMLElement, prevState: WebViewState | null) {
		this.gitRepos = initialState.repos;
		this.config = initialState.config;
		this.backend = initialState.backend;
		setInterfaceLanguage(this.config.interfaceLanguage);
		this.renderToolbarText();
		this.maxCommits = this.config.initialLoadCommits;
		this.viewElem = viewElem;
		this.currentRepoRefreshState = {
			inProgress: false,
			hard: true,
			loadRepoInfoRefreshId: initialState.loadRepoInfoRefreshId,
			loadCommitsRefreshId: initialState.loadCommitsRefreshId,
			repoInfoChanges: false,
			configChanges: false,
			requestingRepoInfo: false,
			requestingConfig: false
		};

		this.controlsElem = document.getElementById('controls')!;
		this.pinnedControlsElem = document.getElementById('pinnedControls');
		if (this.pinnedControlsElem !== null) {
			this.pinnedControlsElem.addEventListener('click', (e) => this.onPinnedChipClick(<HTMLElement>e.target));
		}
		this.tableElem = document.getElementById('commitTable')!;
		this.footerElem = document.getElementById('footer')!;

		viewElem.focus();

		this.graph = new Graph('commitGraph', viewElem, this.config.graph, this.config.mute);

		this.repoDropdown = new Dropdown('repoDropdown', true, false, strings.dropdownRepos, (values) => {
			this.loadRepo(values[0]);
		});

		this.branchDropdown = new Dropdown('branchDropdown', false, true, strings.dropdownBranches, (values) => {
			this.currentBranches = values;
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		});
		this.authorDropdown = new Dropdown('authorDropdown', false, true, strings.dropdownAuthors, (values) => {
			this.currentAuthors = values;
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		});
		this.showRemoteBranchesElem = <HTMLInputElement>document.getElementById('showRemoteBranchesCheckbox')!;
		this.showRemoteBranchesElem.addEventListener('change', () => {
			this.saveRepoStateValue(this.currentRepo, 'showRemoteBranchesV2', this.showRemoteBranchesElem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
			this.refresh(true);
		});

		this.refreshBtnElem = document.getElementById('refreshBtn')!;
		this.refreshBtnElem.addEventListener('click', () => {
			if (!this.refreshBtnElem.classList.contains(CLASS_REFRESHING)) {
				this.refresh(true, true);
			}
		});
		this.renderRefreshButton();
		if (prevState) {
			if (prevState.commitPathFilter !== null && prevState.commitPathFilter !== undefined) this.commitPathFilter = prevState.commitPathFilter;
		}

		this.findWidget = new FindWidget(this);
		this.settingsWidget = new SettingsWidget(this);

		alterClass(document.body, CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH, this.config.referenceLabels.branchLabelsAlignedToGraph);
		alterClass(document.body, CLASS_TAG_LABELS_RIGHT_ALIGNED, this.config.referenceLabels.tagLabelsOnRight);
		document.body.style.setProperty('--git-graph-fontSize', this.config.graph.fontSize + 'px');
		document.body.style.setProperty('--git-graph-rowHeight', this.config.graph.rowHeight + 'px');

		observeWindowSizeChanges(this);
		observeWebviewStyleChanges(this);
		observeViewScroll(this);
		observeKeyboardEvents(this);
		observeUrls(this);
		observeTableEvents(this);

		if (prevState) {
			// Only the lightweight state is restored directly (find widget, settings widget): the
			// commit list is NOT persisted, so after a webview reload the repository is always
			// reloaded (via the loadViewTo path below)
			this.findWidget.restoreState(prevState.findWidget);
			this.settingsWidget.restoreState(prevState.settingsWidget);
		}

		let loadViewTo = initialState.loadViewTo;
		if (loadViewTo === null && prevState && typeof prevState.currentRepo !== 'undefined') {
			// Reload the previously open repository after a webview reload, re-applying its path filter
			loadViewTo = prevState.commitPathFilter !== null && prevState.commitPathFilter !== undefined
				? { repo: prevState.currentRepo, filterPath: prevState.commitPathFilter }
				: { repo: prevState.currentRepo };
			// Restore the scroll position after the repository's commits have been rendered (the view
			// is still empty at this point, so scrolling immediately would be clamped to 0)
			this.scrollTop = prevState.scrollTop;
			this.restoreScrollTop = prevState.scrollTop;
		}

		if (!this.loadRepos(this.gitRepos, initialState.lastActiveRepo, loadViewTo)) {
			this.requestLoadRepoInfoAndCommits(false, false);
		}
		if (prevState && prevState.compareSourceHash !== null && prevState.compareSourceHash !== undefined
			&& prevState.currentRepo === this.currentRepo) {
			// Restore the "Select for Compare" selection after a webview reload, so it survives
			// switching away from the panel and back (loadRepo above clears it when the repo changes)
			this.compareSourceHash = prevState.compareSourceHash;
			this.saveState();
		}

		const currentBtn = document.getElementById('currentBtn')!, fetchBtn = document.getElementById('fetchBtn')!, findBtn = document.getElementById('findBtn')!, settingsBtn = document.getElementById('settingsBtn')!, terminalBtn = document.getElementById('terminalBtn')!;
		currentBtn.title = strings.scrollToHeadTitle;
		currentBtn.innerHTML = SVG_ICONS.current;
		currentBtn.addEventListener('click', () => {
			if (this.commitHead) {
				this.scrollToCommit(this.commitHead, true, true);
			}
		});
		fetchBtn.title = this.config.fetchAndPrune ? strings.fetchAndPruneTitle : strings.fetchTitle;
		fetchBtn.innerHTML = SVG_ICONS.download;
		fetchBtn.addEventListener('click', () => fetchFromRemotesAction(this));
		findBtn.title = strings.findTitle;
		findBtn.innerHTML = SVG_ICONS.search;
		findBtn.addEventListener('click', () => this.findWidget.show(true));
		settingsBtn.title = strings.settingsTitle;
		settingsBtn.innerHTML = SVG_ICONS.gear;
		settingsBtn.addEventListener('click', () => this.settingsWidget.show(this.currentRepo));
		terminalBtn.title = strings.terminalTitle;
		terminalBtn.innerHTML = SVG_ICONS.terminal;
		terminalBtn.addEventListener('click', () => {
			runAction({
				command: 'openTerminal',
				repo: this.currentRepo,
				name: this.gitRepos[this.currentRepo].name || getRepoName(this.currentRepo)
			}, strings.openingTerminal);
		});
		const filterBtn = document.getElementById('filterBtn');
		if (filterBtn !== null) {
			filterBtn.addEventListener('click', () => this.showPathFilterDialog());
			this.renderFilterButton();
		}
	}


	/* Loading Data */

	public loadRepos(repos: GG.GitRepoSet, lastActiveRepo: string | null, loadViewTo: GG.LoadGitGraphViewTo) {
		this.gitRepos = repos;
		this.saveState();

		let newRepo: string;
		if (loadViewTo !== null && this.currentRepo !== loadViewTo.repo && typeof repos[loadViewTo.repo] !== 'undefined') {
			newRepo = loadViewTo.repo;
		} else if (typeof repos[this.currentRepo] === 'undefined') {
			newRepo = lastActiveRepo !== null && typeof repos[lastActiveRepo] !== 'undefined'
				? lastActiveRepo
				: getSortedRepositoryPaths(repos, this.config.repoDropdownOrder)[0];
		} else {
			newRepo = this.currentRepo;
		}

		alterClass(this.controlsElem, 'singleRepo', Object.keys(repos).length === 1);
		this.renderRepoDropdownOptions(newRepo);

		if (loadViewTo !== null) {
			if (loadViewTo.repo === newRepo) {
				this.loadViewTo = loadViewTo;
			} else {
				this.loadViewTo = null;
				showErrorMessage(formatStr(strings.unableToLoadRepo, loadViewTo.repo));
			}
		} else {
			this.loadViewTo = null;
		}

		let filterChanged = false;
		if (loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.filterPath === 'string') {
			// Apply the file path filter the view was requested to be loaded with
			const newFilter = loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null;
			filterChanged = newFilter !== this.commitPathFilter;
		}

		if (this.currentRepo !== newRepo) {
			this.loadRepo(newRepo);
			// loadRepo resets the path filter, so re-apply it before the commits are requested
			if (loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.filterPath === 'string') {
				this.commitPathFilter = loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null;
				this.renderFilterButton();
			}
			return true;
		} else if (filterChanged) {
			// The repository is already loaded, but the path filter changed: reload the commits
			this.commitPathFilter = loadViewTo !== null && typeof loadViewTo.filterPath === 'string' && loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null;
			this.renderFilterButton();
			this.viewElem.scrollTop = 0;
			this.refresh(false);
			return false;
		} else {
			this.finaliseRepoLoad(false);
			return false;
		}
	}

	private loadRepo(repo: string) {
		this.currentRepo = repo;
		this.currentRepoLoading = true;
		this.showRemoteBranchesElem.checked = getShowRemoteBranches(this.gitRepos[this.currentRepo].showRemoteBranchesV2);
		this.maxCommits = this.config.initialLoadCommits;
		this.gitConfig = null;
		this.gitRemotes = [];
		this.gitStashes = [];
		this.gitTags = [];
		this.currentBranches = null;
		this.currentAuthors = null;
		this.commitPathFilter = null;
		this.compareSourceHash = null;
		this.prStatusBranch = null;
		this.renderPullRequestStatus(null);
		this.renderFetchButton();
		this.renderFilterButton();
		closeCommitDetails(this, false);
		this.settingsWidget.close();
		this.saveState();
		this.refresh(true);
	}

	private loadRepoInfo(branchOptions: ReadonlyArray<string>, branchHead: string | null, remotes: ReadonlyArray<string>, stashes: ReadonlyArray<GG.GitStash>, isRepo: boolean, remoteRefsPending: boolean = false) {
		// Changes to this.gitStashes are reflected as changes to the commits when loadCommits is run
		this.gitStashes = stashes;

		if (!isRepo || (!this.currentRepoRefreshState.hard && arraysStrictlyEqual(this.gitBranches, branchOptions) && this.gitBranchHead === branchHead && arraysStrictlyEqual(this.gitRemotes, remotes))) {
			this.saveState();
			this.finaliseLoadRepoInfo(false, isRepo);
			return;
		}

		// Changes to these properties must be indicated as a repository info change
		this.gitBranches = branchOptions;
		this.gitBranchHead = branchHead;
		this.gitRemotes = remotes;

		// Update the state of the fetch button
		this.renderFetchButton();

		// While the remote-tracking refs are still being scanned, a `remotes/...` name cannot be
		// validated against the (local-only) branch list — such selections and configured branches
		// are kept until the complete list arrives with a loadCommits response.
		const keepRemoteSelections = (branch: string) => remoteRefsPending && branch.startsWith('remotes/');
		const filterCurrentBranches = () => {
			// Configure current branches
			if (this.currentBranches !== null && !(this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES)) {
				// Filter any branches that are currently selected, but no longer exist
				const globPatterns = this.config.customBranchGlobPatterns.map((pattern: { glob: string; }) => pattern.glob);
				this.currentBranches = this.currentBranches.filter((branch) =>
					this.gitBranches.includes(branch) || globPatterns.includes(branch) || branch === 'HEAD' || keepRemoteSelections(branch)
				);
			}
		};

		filterCurrentBranches();
		if (this.currentBranches === null || this.currentBranches.length === 0) {
			// No branches are currently selected
			const onRepoLoadShowCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.gitRepos[this.currentRepo].onRepoLoadShowCheckedOutBranch);
			const onRepoLoadShowSpecificBranches = getOnRepoLoadShowSpecificBranches(this.gitRepos[this.currentRepo].onRepoLoadShowSpecificBranches);
			this.currentBranches = [];
			if (onRepoLoadShowSpecificBranches.length > 0) {
				// Show specific branches if they exist in the repository
				const globPatterns = this.config.customBranchGlobPatterns.map((pattern: { glob: string; }) => pattern.glob);
				this.currentBranches.push(...onRepoLoadShowSpecificBranches.filter((branch) =>
					this.gitBranches.includes(branch) || globPatterns.includes(branch) || keepRemoteSelections(branch)
				));
			}
			if (onRepoLoadShowCheckedOutBranch && this.gitBranchHead !== null && !this.currentBranches.includes(this.gitBranchHead)) {
				// Show the checked-out branch, and it hasn't already been added as a specific branch
				this.currentBranches.push(this.gitBranchHead);
			}
			if (this.currentBranches.length === 0) {
				this.currentBranches.push(SHOW_ALL_BRANCHES);
			}
		}
		filterCurrentBranches();

		this.saveState();
		if (this.currentAuthors === null || this.currentAuthors.length === 0) {
			this.currentAuthors = [SHOW_ALL_BRANCHES];
		}

		// Set up branch dropdown options
		this.branchDropdown.setOptions(this.getBranchOptions(true), this.currentBranches);
		this.authorDropdown.setOptions(this.getAuthorOptions(), this.currentAuthors);

		// Remove hidden remotes that no longer exist
		let hiddenRemotes = this.gitRepos[this.currentRepo].hideRemotes;
		let hideRemotes = hiddenRemotes.filter((hiddenRemote: string) => remotes.includes(hiddenRemote));
		if (hiddenRemotes.length !== hideRemotes.length) {
			this.saveRepoStateValue(this.currentRepo, 'hideRemotes', hideRemotes);
		}

		this.finaliseLoadRepoInfo(true, isRepo);
	}

	/**
	 * Apply a branch list that arrived with a `loadCommits` response (the complete list, once the
	 * remote-tracking refs have been scanned): update the dropdown in place and drop selections
	 * that no longer exist — the same validation the `loadRepoInfo` response performs, arriving
	 * late. This never re-triggers the load chain: the commits of the same response are already it.
	 */
	private applyBranches(branchOptions: ReadonlyArray<string>) {
		if (arraysStrictlyEqual(this.gitBranches, branchOptions)) return;
		this.gitBranches = branchOptions;
		let selectionReset = false;
		if (this.currentBranches !== null && !(this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES)) {
			const globPatterns = this.config.customBranchGlobPatterns.map((pattern: { glob: string; }) => pattern.glob);
			this.currentBranches = this.currentBranches.filter((branch) =>
				this.gitBranches.includes(branch) || globPatterns.includes(branch) || branch === 'HEAD'
			);
			if (this.currentBranches.length === 0) {
				this.currentBranches = [SHOW_ALL_BRANCHES];
				selectionReset = true;
			}
		}
		this.branchDropdown.setOptions(this.getBranchOptions(true), this.currentBranches);
		this.saveState();
		if (selectionReset) {
			// The commits of this response were loaded with the now-dropped selection: reload so the
			// graph matches the "Show All Branches" the dropdown now shows.
			this.requestLoadRepoInfoAndCommits(false, true);
		}
	}

	private finaliseLoadRepoInfo(repoInfoChanges: boolean, isRepo: boolean) {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			if (isRepo) {
				refreshState.repoInfoChanges = refreshState.repoInfoChanges || repoInfoChanges;
				refreshState.requestingRepoInfo = false;
				this.requestLoadCommits();
			} else {
				dialog.closeActionRunning();
				refreshState.inProgress = false;
				this.loadViewTo = null;
				this.renderRefreshButton();
				sendMessage({ command: 'loadRepos', check: true });
			}
		}
	}

	private loadCommits(commits: GG.GitCommit[], commitHead: string | null, tags: ReadonlyArray<string>, moreAvailable: boolean, onlyFollowFirstParent: boolean, uncommittedPending: boolean = false) {
		// This list of tags is just used to provide additional information in the dialogs. Tag information included in commits is used for all other purposes (e.g. rendering, context menus)
		const tagsChanged = !arraysStrictlyEqual(this.gitTags, tags);
		this.gitTags = tags;

		if (uncommittedPending && commits.length > 0 && commits[0].hash !== UNCOMMITTED && commitHead !== null
			&& this.uncommittedCount !== null && this.uncommittedCount > 0) {
			// Deferred response: the "Uncommitted Changes" status arrives in a follow-up response.
			// Keep the row rendered so it never flickers away and back on a refresh - the follow-up
			// just updates its number in place. The row is reused when it is already rendered, and
			// synthesized from the last known count otherwise: any response of the load pipeline
			// (initial, remote refs, Gerrit stages) carries a list without the row, and none of
			// them may drop it.
			commits = [this.commits.length > 0 && this.commits[0].hash === UNCOMMITTED
				? { ...this.commits[0], parents: [commitHead] }
				: {
					hash: UNCOMMITTED,
					parents: [commitHead],
					author: '*',
					email: '',
					date: Math.round(Date.now() / 1000),
					message: formatStr(strings.uncommittedChangesRow, String(this.uncommittedCount)),
					heads: [],
					tags: [],
					remotes: [],
					stash: null
				}, ...commits];
		}

		if (!this.currentRepoLoading && !this.currentRepoRefreshState.hard && this.moreCommitsAvailable === moreAvailable && this.onlyFollowFirstParent === onlyFollowFirstParent && this.commitHead === commitHead && commits.length > 0 && arraysEqual(this.commits, commits, (a, b) =>
			a.hash === b.hash &&
			arraysStrictlyEqual(a.heads, b.heads) &&
			arraysEqual(a.tags, b.tags, (a: GG.GitCommitTag, b: GG.GitCommitTag) => a.name === b.name && a.annotated === b.annotated) &&
			arraysEqual(a.remotes, b.remotes, (a: GG.GitCommitRemote, b: GG.GitCommitRemote) => a.name === b.name && a.remote === b.remote) &&
			arraysStrictlyEqual(a.parents, b.parents) &&
			((a.stash === null && b.stash === null) || (a.stash !== null && b.stash !== null && a.stash.selector === b.stash.selector))
		) && this.renderedGitBranchHead === this.gitBranchHead && !this.gerritStatesDirty) {

			if (this.commits[0].hash === UNCOMMITTED) {
				this.commits[0] = commits[0];
				this.saveState();
				this.renderUncommittedChanges();
				if (this.expandedCommit !== null && this.expandedCommit.commitElem !== null) {
					if (this.expandedCommit.compareWithHash === null) {
						// Commit Details View is open
						if (this.expandedCommit.commitHash === UNCOMMITTED) {
							this.requestCommitDetails(this.expandedCommit.commitHash, true);
						}
					} else {
						// Commit Comparison is open
						if (this.expandedCommit.compareWithElem !== null && (this.expandedCommit.commitHash === UNCOMMITTED || this.expandedCommit.compareWithHash === UNCOMMITTED)) {
							this.requestCommitComparison(this.expandedCommit.commitHash, this.expandedCommit.compareWithHash, true);
						}
					}
				}
			} else if (tagsChanged) {
				this.saveState();
			}
			this.finaliseLoadCommits();
			return;
		}

		// Everything else - a commit landing at the top, the Uncommitted Changes row appearing or
		// vanishing, a "Load More Commits" page arriving at the bottom, a background fetch moving a
		// label deep in the history, a rebase rewriting the middle - goes through this one path.
		// There used to be three hand-written incremental paths here (append / prepend / patch
		// metadata), each with a predicate deciding whether it was safe to take: they existed only
		// because rendering rebuilt the whole table, so anything that could avoid a rebuild was
		// worth a special case. Rendering now reconciles rows by commit identity and rebuilds only
		// the rows that actually differ (see syncCommitRows), which is strictly better than any of
		// them - and correct for every shape of change, not three enumerated ones.
		const currentRepoLoading = this.currentRepoLoading;
		// A background refresh reaching this full re-render changes the table's shape under the
		// user (a commit inserted/removed anywhere, a rebase rewriting mid-history, the Gerrit
		// states arriving). Anchor the rebuild on the commit the user is looking at, exactly like
		// every other update path does.
		const anchor = currentRepoLoading ? null : this.captureViewportAnchor();
		this.currentRepoLoading = false;
		this.moreCommitsAvailable = moreAvailable;
		this.onlyFollowFirstParent = onlyFollowFirstParent;
		this.commits = commits;
		this.commitHead = commitHead;
		this.commitLookup = {};

		let i: number, expandedCommitVisible = false, expandedCompareWithCommitVisible = false, avatarsNeeded: { [email: string]: string[] } = {}, commit;
		for (i = 0; i < this.commits.length; i++) {
			commit = this.commits[i];
			this.commitLookup[commit.hash] = i;
			if (this.expandedCommit !== null) {
				if (this.expandedCommit.commitHash === commit.hash) {
					expandedCommitVisible = true;
				} else if (this.expandedCommit.compareWithHash === commit.hash) {
					expandedCompareWithCommitVisible = true;
				}
			}
			if (this.config.fetchAvatars && typeof this.avatars[commit.email] !== 'string' && commit.email !== '') {
				if (typeof avatarsNeeded[commit.email] === 'undefined') {
					avatarsNeeded[commit.email] = [commit.hash];
				} else {
					avatarsNeeded[commit.email].push(commit.hash);
				}
			}
		}

		if (this.expandedCommit !== null && (!expandedCommitVisible || (this.expandedCommit.compareWithHash !== null && !expandedCompareWithCommitVisible))) {
			closeCommitDetails(this, false);
		}

		this.saveState();

		this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent);

		// Put the scroll where the anchored commit needs it BEFORE rendering, so the window is
		// computed at its final position and every row in it is reconciled exactly once. (Rendering
		// first and correcting afterwards would window the list at the stale position, then move -
		// destroying and rebuilding the rows at both edges of the window for nothing.)
		this.applyViewportAnchor(anchor);
		this.render();
		this.gerritStatesDirty = false;
		// A full render has variable row heights, so its anchor can only be measured now that the
		// rows are on screen. Windowed rendering already landed exactly, and this is a no-op.
		if (this.renderedRange === null) this.applyViewportAnchor(anchor);

		if (currentRepoLoading) {
			if (this.config.onRepoLoad.scrollToHead && this.commitHead !== null) {
				this.scrollToCommit(this.commitHead, true);
			} else if (this.restoreScrollTop !== null) {
				// Webview reload: re-apply the scroll position saved before the reload
				this.viewElem.scrollTop = this.restoreScrollTop;
				this.updateVirtualWindow(); // re-render the window around the restored position
			}
			this.restoreScrollTop = null;
		}

		this.finaliseLoadCommits();
		this.requestAvatars(avatarsNeeded);
	}

	private finaliseLoadCommits() {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			dialog.closeActionRunning();

			if (dialog.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					dialog.close();
				} else {
					dialog.refresh(this.getCommits());
				}
			}

			if (contextMenu.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					contextMenu.close();
				} else {
					contextMenu.refresh(this.getCommits());
				}
			}

			refreshState.inProgress = false;
			this.renderRefreshButton();
		}

		this.checkPendingScrollCommit();
		this.finaliseRepoLoad(true);
	}

	/**
	 * Continue (or finish) an auto-load triggered by clicking a pinned commit chip that is not in
	 * the view: scroll to it once loaded, keep paging while more commits are available, or show an
	 * error once the whole repository history has been loaded without finding it.
	 */
	private checkPendingScrollCommit() {
		if (this.pendingScrollCommitHash === null) return;
		if (this.countCommitsBeforePending) return; // the count response drives the jump (or reports "not found")
		const hash = this.pendingScrollCommitHash;
		if (this.commitLookup[hash] !== undefined) {
			this.pendingScrollCommitHash = null;
			this.scrollToCommit(hash, true, true);
		} else if (this.moreCommitsAvailable) {
			this.loadMoreCommits();
		} else {
			this.pendingScrollCommitHash = null;
			dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInLoadedHistory, strings.dialogClose, null);
		}
	}

	/**
	 * Handle the response of a countCommitsBefore request (made when jumping to a pinned commit
	 * that is not in the view): load enough commits to include it in a single request.
	 */
	public processCountCommitsBefore(msg: GG.ResponseCountCommitsBefore) {
		this.countCommitsBeforePending = false;
		if (this.pendingScrollCommitHash !== msg.hash) return;
		if (msg.count === null) {
			this.pendingScrollCommitHash = null;
			dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInRepo, strings.dialogClose, null);
			return;
		}
		// Jump straight to the commit: load everything up to it (plus a margin), then
		// checkPendingScrollCommit scrolls to it once the load completes
		this.maxCommits = Math.max(this.maxCommits, msg.count + this.config.loadMoreCommits);
		this.footerElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + strings.loading + '</h2>';
		this.saveState();
		this.requestLoadRepoInfoAndCommits(false, true);
	}

	private finaliseRepoLoad(didLoadRepoData: boolean) {
		if (this.loadViewTo !== null && this.currentRepo === this.loadViewTo.repo) {
			if (this.loadViewTo.findCommitHash) {
				const commitIndex = this.getCommitId(this.loadViewTo.findCommitHash);
				if (commitIndex !== null) {
					const commitElem = findCommitElemWithId(commitIndex);
					if (commitElem !== null) {
						this.scrollToCommit(this.loadViewTo!.findCommitHash!, true, true);
						loadCommitDetails(this, commitElem);
					}
					this.loadViewTo = null;
				} else if (this.moreCommitsAvailable) {
					this.loadMoreCommits();
					return; // Wait for next load
				} else {
					showErrorMessage(strings.commitNotFound);
					this.loadViewTo = null;
				}
			} else if (this.loadViewTo.commitDetails && (this.expandedCommit === null || this.expandedCommit.commitHash !== this.loadViewTo.commitDetails.commitHash || this.expandedCommit.compareWithHash !== this.loadViewTo.commitDetails.compareWithHash)) {
				const commitIndex = this.getCommitId(this.loadViewTo.commitDetails.commitHash);
				const compareWithIndex = this.loadViewTo.commitDetails.compareWithHash !== null ? this.getCommitId(this.loadViewTo.commitDetails.compareWithHash) : null;
				const commitElem = findCommitElemWithId(commitIndex);
				const compareWithElem = findCommitElemWithId(compareWithIndex);

				if (commitElem !== null && (this.loadViewTo.commitDetails.compareWithHash === null || compareWithElem !== null)) {
					if (compareWithElem !== null) {
						loadCommitComparison(this, commitElem, compareWithElem);
					} else {
						loadCommitDetails(this, commitElem);
					}
				} else {
					showErrorMessage(formatStr(strings.unableToResumeCodeReview, String(this.maxCommits)));
				}
			} else if (this.loadViewTo.runCommandOnLoad) {
				switch (this.loadViewTo.runCommandOnLoad) {
					case 'fetch':
						fetchFromRemotesAction(this);
						break;
				}
			}
		}
		this.loadViewTo = null;

		if (this.gitConfig === null || (didLoadRepoData && this.currentRepoRefreshState.configChanges)) {
			this.requestLoadConfig();
		}
	}

	private clearCommits() {
		closeDialogAndContextMenu();
		this.moreCommitsAvailable = false;
		this.pendingScrollCommitHash = null;
		this.countCommitsBeforePending = false;
		this.commits = [];
		this.commitHead = null;
		this.commitLookup = {};
		this.uncommittedCount = null;
		this.renderedGitBranchHead = null;
		this.gerritStates = {};
		this.gerritStatesDirty = false;
		this.commitBodies = {};
		this.commitBodiesRequested.clear();
		this.renderedRange = null;
		closeCommitDetails(this, false);
		this.saveState();
		this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent);
		this.tableElem.innerHTML = '';
		this.footerElem.innerHTML = '';
		this.renderGraph();
		this.findWidget.refresh();
	}

	/**
	 * Does a Gerrit change pass the repository's status filter (the checkboxes of the Repository
	 * Settings)? Mirrors the extension's `filterChangeStates`, which selects the change refs
	 * injected into the commit graph: a WIP change is shown iff "Work in Progress" is checked,
	 * any other change iff its status is checked.
	 */
	public gerritPassesFilter(state: GG.GerritChangeState): boolean {
		const filter = this.gitRepos[this.currentRepo].gerritStatusFilter;
		if (state.wip) return filter.wip;
		return filter[state.status];
	}

	/**
	 * Apply a change of the Gerrit status filter (the Repository Settings checkboxes): the badges
	 * re-render immediately from the already-loaded states, and the commit graph is reloaded in
	 * the background (debounced, so toggling several checkboxes triggers a single load), because
	 * only the extension knows which change refs to inject for the new filter.
	 * @param status The status whose checkbox changed ('merged' never affects the graph).
	 */
	public applyGerritFilterChange(status: keyof GG.GerritStatusFilter) {
		this.render();
		if (status === 'merged') return; // merged changes are never injected into the graph (see the extension's buildGerritViewData)
		if (this.gerritFilterRefreshTimer !== null) window.clearTimeout(this.gerritFilterRefreshTimer);
		this.gerritFilterRefreshTimer = window.setTimeout(() => {
			this.gerritFilterRefreshTimer = null;
			this.requestLoadRepoInfoAndCommits(false, true);
		}, 120);
	}

	public processLoadRepoInfoResponse(msg: GG.ResponseLoadRepoInfo) {
		// A response superseded by a newer loadRepoInfo request (e.g. the repository changed while
		// this one was in flight) must not apply the old repository's branches/head/remotes to the
		// current view.
		if (this.currentRepoRefreshState.loadRepoInfoRefreshId !== msg.refreshId) return;
		if (msg.error === null) {
			this.loadRepoInfo(msg.branches, msg.head, msg.remotes, msg.stashes, msg.isRepo, msg.remoteRefsPending === true);
			this.requestPullRequestStatus();
		} else {
			this.displayLoadDataError(strings.errLoadRepoInfo, msg.error);
		}
	}

	/**
	 * Request the pull/merge request status of the checked-out branch from the extension host
	 * (only when the pull request integration is enabled). One request per branch: the request
	 * is skipped when the status of this branch was already requested.
	 */
	private requestPullRequestStatus() {
		const branch = this.gitBranchHead;
		if (!this.config.pullRequests.enabled || branch === null) {
			this.prStatusBranch = null;
			this.renderPullRequestStatus(null);
			return;
		}
		if (this.prStatusBranch === branch) return;
		this.prStatusBranch = branch;
		sendMessage({ command: 'fetchPullRequest', repo: this.currentRepo, branch: branch });
	}

	/**
	 * Process a pull request status response (ignored when the checked-out branch changed since).
	 */
	public processPullRequestStatus(msg: GG.ResponsePullRequestStatus) {
		if (this.gitBranchHead !== msg.branch || this.prStatusBranch !== msg.branch) return;
		this.renderPullRequestStatus(msg.pr);
	}

	/**
	 * Render the pull request status badge in the header (hidden when there is no matching PR/MR).
	 */
	private renderPullRequestStatus(pr: GG.PullRequestInfo | null) {
		const elem = document.getElementById('prStatus');
		if (elem === null) return;
		if (pr === null) {
			elem.style.display = 'none';
			elem.innerHTML = '';
			return;
		}
		const stateText = pr.state === 'merged' ? strings.prStateMerged : pr.state === 'closed' ? strings.prStateClosed : pr.state === 'draft' ? strings.prStateDraft : strings.prStateOpen;
		const author = pr.author !== '' ? ' · ' + escapeHtml(pr.author) : '';
		elem.innerHTML = '<a class="prBadge st-' + pr.state + '" tabindex="-1" title="' + escapeHtml(formatStr(strings.prStatusTitle, '#' + pr.number, pr.title)) + '">' + strings.prLabel + ' #' + pr.number + ' · ' + stateText + author + '</a>';
		elem.style.display = 'block';
		const badge = elem.querySelector('.prBadge');
		if (badge !== null) {
			badge.addEventListener('click', () => {
				if (pr.url !== '') runAction({ command: 'openExternalUrl', url: pr.url }, strings.prOpening);
			});
		}
	}

	public processLoadCommitsResponse(msg: GG.ResponseLoadCommits) {
		const refreshState = this.currentRepoRefreshState;
		if (msg.error === null) {
			// A loadCommits request can be answered by MULTIPLE responses with the same refresh id:
			// the deferred "Uncommitted Changes" follow-up of a cold-cache load arrives after the
			// first response finalised the refresh (inProgress === false). The refresh id alone
			// identifies whether the response belongs to the current view state: every new request
			// increments it.
			if (refreshState.loadCommitsRefreshId === msg.refreshId) {
				// The Gerrit states ride along every loadCommits response: swap the map in and force
				// a re-render when it changed (the extension serves ALL cached states, so the status
				// filter of the Repository Settings is applied locally by this view). The array is
				// checked (not merely non-null): a response from a mismatched extension build that
				// omits the field entirely (undefined) must keep the current states, never crash.
				//
				// The staged Gerrit load delivers the states in two parts: the light part the badges
				// render (arriving with the change refs), then the event timelines (which only the
				// review dialog reads). A change confined to the timelines therefore swaps the map
				// without re-rendering the commit table, refreshing an open review dialog in place.
				if (Array.isArray(msg.gerritStates)) {
					const newStates: { [hash: string]: GG.GerritChangeState } = {};
					for (const state of msg.gerritStates) newStates[state.headHash] = state;
					const changed = !gerritStatesEqual(this.gerritStates, newStates);
					const badgesChanged = !gerritStatesEqual(this.gerritStates, newStates, false);
					this.gerritStatesDirty = badgesChanged;
					this.gerritStates = newStates;
					if (changed) refreshGerritReviewDialog(this);
				} else if (Object.keys(this.gerritStates).length > 0) {
					this.gerritStatesDirty = true;
					this.gerritStates = {};
				}
				// The branch list of the ref scan this page was built from: the deferred view load
				// delivers the remote-tracking entries here (they are the same scan the remote
				// pills come from), completing the branch dropdown without another request.
				if (Array.isArray(msg.branches)) this.applyBranches(msg.branches);
				// The exact "Uncommitted Changes" count arrives with the final follow-up: record it
				// as view state so subsequent deferred responses can keep the row rendered
				if (typeof msg.uncommittedCount === 'number') this.uncommittedCount = msg.uncommittedCount;
				this.loadCommits(msg.commits, msg.head, msg.tags, msg.moreCommitsAvailable, msg.onlyFollowFirstParent, msg.uncommittedPending === true);
			}
		} else if (refreshState.loadCommitsRefreshId === msg.refreshId) {
			// A stale error response (superseded by a newer load whose data is already rendered)
			// must not clear the view or abort the in-flight sequence - the same guard the success
			// path applies above.
			const error = this.gitBranches.length === 0 && msg.error.indexOf('bad revision \'HEAD\'') > -1
				? strings.noCommitsInRepo
				: msg.error;
			this.displayLoadDataError(strings.errLoadCommits, error);
		}
	}

	public processLoadConfig(msg: GG.ResponseLoadConfig) {
		if (this.currentRepo === msg.repo) {
			this.currentRepoRefreshState.requestingConfig = false;
			if (msg.config !== null) {
				this.gitConfig = msg.config;
				this.saveState();

				renderCdvExternalDiffBtn(this);
			}
			this.settingsWidget.refresh();
			this.authorDropdown.setOptions(this.getAuthorOptions(), this.currentAuthors);
		}
	}

	private displayLoadDataError(message: string, reason: string) {
		this.clearCommits();
		this.currentRepoRefreshState.inProgress = false;
		this.loadViewTo = null;
		this.renderRefreshButton();
		dialog.showError(message, reason, strings.retryAction, () => {
			this.refresh(true);
		});
	}

	public loadAvatar(email: string, image: string) {
		this.avatars[email] = image;
		this.saveState();
		// Scope the update to the rows of this author (attribute selector) instead of scanning
		// every avatar element of the (potentially very large) table
		const escapedEmail = email.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		const avatarElems = document.querySelectorAll<HTMLElement>('.avatar[data-email="' + escapedEmail + '"]');
		for (let i = 0; i < avatarElems.length; i++) {
			avatarElems[i].innerHTML = '<img class="avatarImg" decoding="sync" src="' + image + '">';
		}
	}


	/* Getters */

	public getBranches(): ReadonlyArray<string> {
		return this.gitBranches;
	}

	public getBranchOptions(includeShowAll?: boolean): ReadonlyArray<DialogSelectInputOption> {
		const options: DialogSelectInputOption[] = [];
		if (includeShowAll) {
			options.push({ name: strings.settingsShowAll, value: SHOW_ALL_BRANCHES });
		}
		options.push({ name: 'HEAD', value: 'HEAD' });
		for (let i = 0; i < this.config.customBranchGlobPatterns.length; i++) {
			options.push({ name: formatStr(strings.globPrefix, this.config.customBranchGlobPatterns[i].name), value: this.config.customBranchGlobPatterns[i].glob });
		}
		for (let i = 0; i < this.gitBranches.length; i++) {
			options.push({ name: this.gitBranches[i].indexOf('remotes/') === 0 ? this.gitBranches[i].substring(8) : this.gitBranches[i], value: this.gitBranches[i] });
		}
		return options;
	}
	public getAuthorOptions(): ReadonlyArray<DialogSelectInputOption> {
		const options: DialogSelectInputOption[] = [];
		options.push({ name: strings.authorsAll, value: SHOW_ALL_BRANCHES });
		if (this.gitConfig && this.gitConfig.authors) {
			for (let i = 0; i < this.gitConfig.authors.length; i++) {
				const author = this.gitConfig.authors[i];
				options.push({ name: author.name, value: author.name });
			}
		}
		return options;
	}
	public getCommitId(hash: string) {
		return typeof this.commitLookup[hash] === 'number' ? this.commitLookup[hash] : null;
	}

	public getCommitOfElem(elem: HTMLElement) {
		let id = parseInt(elem.dataset.id!);
		return id < this.commits.length ? this.commits[id] : null;
	}

	public getCommits(): ReadonlyArray<GG.GitCommit> {
		return this.commits;
	}

	public getPushRemote(branch: string | null = null) {
		const possibleRemotes = [];
		if (this.gitConfig !== null) {
			if (branch !== null && typeof this.gitConfig.branches[branch] !== 'undefined') {
				possibleRemotes.push(this.gitConfig.branches[branch].pushRemote, this.gitConfig.branches[branch].remote);
			}
			possibleRemotes.push(this.gitConfig.pushDefault);
		}
		possibleRemotes.push('origin');
		return possibleRemotes.find((remote) => remote !== null && this.gitRemotes.includes(remote)) || this.gitRemotes[0];
	}

	public getRepoConfig(): Readonly<GG.GitRepoConfig> | null {
		return this.gitConfig;
	}

	public getRepoState(repo: string): Readonly<GG.GitRepoState> | null {
		return typeof this.gitRepos[repo] !== 'undefined'
			? this.gitRepos[repo]
			: null;
	}

	public isConfigLoading(): boolean {
		return this.currentRepoRefreshState.requestingConfig;
	}


	/* Refresh */

	public refresh(hard: boolean, configChanges: boolean = false) {
		if (hard) {
			this.clearCommits();
		}
		this.requestLoadRepoInfoAndCommits(hard, false, configChanges);
	}


	/* Requests */

	private requestLoadRepoInfo() {
		const repoState = this.gitRepos[this.currentRepo];
		sendMessage({
			command: 'loadRepoInfo',
			repo: this.currentRepo,
			refreshId: ++this.currentRepoRefreshState.loadRepoInfoRefreshId,
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
			showStashes: getShowStashes(repoState.showStashes),
			hideRemotes: repoState.hideRemotes
		});
	}

	private requestCountCommitsBefore(hash: string) {
		const repoState = this.gitRepos[this.currentRepo];
		sendMessage({
			command: 'countCommitsBefore',
			repo: this.currentRepo,
			hash: hash,
			branches: this.currentBranches === null || (this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES) ? null : this.currentBranches,
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
			includeCommitsMentionedByReflogs: getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs)
		});
	}

	private requestLoadCommits() {
		const repoState = this.gitRepos[this.currentRepo];
		sendMessage({
			command: 'loadCommits',
			repo: this.currentRepo,
			refreshId: ++this.currentRepoRefreshState.loadCommitsRefreshId,
			hard: this.currentRepoRefreshState.hard,
			branches: this.currentBranches === null || (this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES) ? null : this.currentBranches,
			authors: this.currentAuthors === null || (this.currentAuthors.length === 1 && this.currentAuthors[0] === SHOW_ALL_BRANCHES) ? null : this.currentAuthors,
			maxCommits: this.maxCommits,
			showTags: getShowTags(repoState.showTags),
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
			includeCommitsMentionedByReflogs: getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs),
			onlyFollowFirstParent: getOnlyFollowFirstParent(repoState.onlyFollowFirstParent),
			commitOrdering: getCommitOrdering(repoState.commitOrdering),
			remotes: this.gitRemotes,
			hideRemotes: repoState.hideRemotes,
			stashes: this.gitStashes,
			gerritFetchRefs: repoState.gerritFetchRefs,
			gerritFetchLimit: repoState.gerritFetchLimit ?? null,
			gerritStatusFilter: repoState.gerritStatusFilter,
			filterPath: this.commitPathFilter
		});
	}

	public requestLoadRepoInfoAndCommits(hard: boolean, skipRepoInfo: boolean, configChanges: boolean = false) {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			refreshState.hard = refreshState.hard || hard;
			refreshState.configChanges = refreshState.configChanges || configChanges;
			if (!skipRepoInfo) {
				// This request will trigger a loadCommit request after the loadRepoInfo request has completed.
				// Invalidate any previous commit requests in progress.
				refreshState.loadCommitsRefreshId++;
			}
		} else {
			// A deferred load's follow-ups (remote refs, Gerrit, "Uncommitted Changes") can still be
			// in flight carrying the previous refresh id even though inProgress is false: the first
			// response already finalised the sequence. Invalidate them before the new sequence starts,
			// otherwise they would render the previous repository's data over the new one and
			// finalise it, leaving the new repository's commits never requested.
			refreshState.loadCommitsRefreshId++;
			refreshState.hard = hard;
			refreshState.inProgress = true;
			refreshState.repoInfoChanges = false;
			refreshState.configChanges = configChanges;
			refreshState.requestingRepoInfo = false;
		}

		this.renderRefreshButton();
		if (this.commits.length === 0) {
			this.tableElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + strings.loading + '</h2><div class="skeletonRows">' + '<div class="skeletonRow"></div>'.repeat(10) + '</div>';
		}

		if (skipRepoInfo) {
			if (!refreshState.requestingRepoInfo) {
				this.requestLoadCommits();
			}
		} else {
			refreshState.requestingRepoInfo = true;
			this.requestLoadRepoInfo();
		}
	}

	public requestLoadConfig() {
		this.currentRepoRefreshState.requestingConfig = true;
		sendMessage({ command: 'loadConfig', repo: this.currentRepo, remotes: this.gitRemotes });
		this.settingsWidget.refresh();
	}

	public requestCommitDetails(hash: string, refresh: boolean) {
		let commit = this.commits[this.commitLookup[hash]];
		if (commit === undefined) return; // The commit is no longer loaded (e.g. after a refresh)
		sendMessage({
			command: 'commitDetails',
			repo: this.currentRepo,
			commitHash: hash,
			hasParents: commit.parents.length > 0,
			stash: commit.stash,
			avatarEmail: this.config.fetchAvatars && hash !== UNCOMMITTED ? commit.email : null,
			refresh: refresh
		});
	}

	public requestCommitComparison(hash: string, compareWithHash: string, refresh: boolean) {
		let commitOrder = getCommitOrder(this, hash, compareWithHash);
		sendMessage({
			command: 'compareCommits',
			repo: this.currentRepo,
			commitHash: hash, compareWithHash: compareWithHash,
			fromHash: commitOrder.from, toHash: commitOrder.to,
			refresh: refresh
		});
	}

	/**
	 * Open the changes between two commits in a dedicated Commit Comparison View tab
	 * (instead of expanding the inline comparison in the commit table).
	 */
	public openCompareTab(hash: string, compareWithHash: string) {
		let commitOrder = getCommitOrder(this, hash, compareWithHash);
		sendMessage({
			command: 'openCompareTab',
			repo: this.currentRepo,
			fromHash: commitOrder.from, toHash: commitOrder.to
		});
	}

	private requestAvatars(avatars: { [email: string]: string[] }) {
		let emails = Object.keys(avatars), remote = this.gitRemotes.length > 0 ? this.gitRemotes.includes('origin') ? 'origin' : this.gitRemotes[0] : null;
		for (let i = 0; i < emails.length; i++) {
			sendMessage({ command: 'fetchAvatar', repo: this.currentRepo, remote: remote, email: emails[i], commits: avatars[emails[i]] });
		}
	}


	/* State */

	public saveState() {
		// The persisted state is a LIGHTWEIGHT snapshot: the commit list (even subject-only),
		// avatars are deliberately NOT included - cloning them into the webview
		// state on every save (which fires on every scroll, toggle and paging load) is O(n) per
		// interaction on large repositories. After a webview reload the repository is simply
		// reloaded (the extension's commit cache makes that fast), restoring the scroll target via
		// the loadViewTo path.
		VSCODE_API.setState({
			currentRepo: this.currentRepo,
			currentRepoLoading: true, // always reload the repo data after a webview reload
			gitRepos: this.gitRepos,
			gitBranches: this.gitBranches,
			gitBranchHead: this.gitBranchHead,
			gitConfig: this.gitConfig,
			gitRemotes: this.gitRemotes,
			gitStashes: this.gitStashes,
			gitTags: this.gitTags,
			commitHead: this.commitHead,
			currentBranches: this.currentBranches,
			currentAuthors: this.currentAuthors,
			moreCommitsAvailable: this.moreCommitsAvailable,
			maxCommits: this.maxCommits,
			onlyFollowFirstParent: this.onlyFollowFirstParent,
			scrollTop: this.scrollTop,
			findWidget: this.findWidget.getState(),
			settingsWidget: this.settingsWidget.getState(),
			commitPathFilter: this.commitPathFilter,
			compareSourceHash: this.compareSourceHash
		});
	}

	public saveRepoState() {
		sendMessage({ command: 'setRepoState', repo: this.currentRepo, state: this.gitRepos[this.currentRepo] });
	}

	public saveColumnWidths(columnWidths: GG.ColumnWidth[]) {
		this.gitRepos[this.currentRepo].columnWidths = [columnWidths[0], columnWidths[2], columnWidths[3], columnWidths[4]];
		this.saveRepoState();
	}

	public saveExpandedCommitLoading(index: number, commitHash: string, commitElem: HTMLElement, compareWithHash: string | null, compareWithElem: HTMLElement | null) {
		this.expandedCommit = {
			index: index,
			commitHash: commitHash,
			commitElem: commitElem,
			compareWithHash: compareWithHash,
			compareWithElem: compareWithElem,
			commitDetails: null,
			fileChanges: null,
			fileTree: null,
			avatar: null,
			codeReview: null,
			lastViewedFile: null,
			loading: true,
			entered: false,
			lineCounts: {
				pending: null,
				requested: new Set<string>(),
				queue: [],
				byPath: null,
				chunkInFlight: false,
				scrollTimer: 0
			},
			scrollTop: {
				summary: 0,
				fileView: 0
			},
			contextMenuOpen: {
				summary: false,
				fileView: -1
			}
		};
		this.saveState();
	}

	public saveRepoStateValue<K extends keyof GG.GitRepoState>(repo: string, key: K, value: GG.GitRepoState[K]) {
		if (repo === this.currentRepo) {
			this.gitRepos[this.currentRepo][key] = value;
			this.saveRepoState();
		}
	}


	/* Pinned Commits & Branches */

	private getPinnedCommits(): GG.PinnedCommit[] {
		const repo = this.gitRepos[this.currentRepo];
		return repo !== undefined && repo.pinnedCommits !== undefined ? repo.pinnedCommits : [];
	}

	public getPinnedBranches(): string[] {
		const repo = this.gitRepos[this.currentRepo];
		return repo !== undefined && repo.pinnedBranches !== undefined ? repo.pinnedBranches : [];
	}

	public isCommitPinned(hash: string) {
		return this.getPinnedCommits().some((pinned) => pinned.hash === hash);
	}

	public togglePinCommit(hash: string, commit: GG.GitCommit | null) {
		if (hash === UNCOMMITTED) return;
		const wasPinned = this.isCommitPinned(hash);
		const pinned = this.getPinnedCommits().filter((pinned) => pinned.hash !== hash);
		if (!wasPinned && commit !== null) {
			// The author and date are captured alongside the subject, so the chip's tooltip keeps
			// describing the commit even once it has scrolled out of the loaded page.
			pinned.push({
				hash: hash,
				summary: commit.message.split(/\r?\n/)[0],
				author: commit.author,
				email: commit.email,
				date: commit.date
			});
		}
		this.saveRepoStateValue(this.currentRepo, 'pinnedCommits', pinned);
		this.render();
	}

	public togglePinBranch(branch: string) {
		const wasPinned = this.getPinnedBranches().includes(branch);
		const pinned = this.getPinnedBranches().filter((pinnedBranch) => pinnedBranch !== branch);
		if (!wasPinned) pinned.push(branch);
		this.saveRepoStateValue(this.currentRepo, 'pinnedBranches', pinned);
		this.render();
	}

	/**
	 * The tooltip of a pinned commit chip: what clicking it does, followed by the commit's own
	 * details — subject, author and date. A commit that is in the loaded page is described from
	 * the page (always current); one that has scrolled out falls back to what was captured at pin
	 * time, so the chip never degrades to a bare hash.
	 */
	private pinnedCommitChipTitle(pinned: GG.PinnedCommit): string {
		const index = this.commitLookup[pinned.hash];
		const commit = typeof index === 'number' ? this.commits[index] : undefined;
		const summary = commit !== undefined ? commit.message.split(/\r?\n/)[0] : pinned.summary;
		const author = commit !== undefined ? commit.author : pinned.author;
		const email = commit !== undefined ? commit.email : pinned.email;
		const date = commit !== undefined ? commit.date : pinned.date;

		let title = formatStr(strings.pinnedCommitChipTitle, pinned.hash);
		if (typeof summary === 'string' && summary !== '') title += '\n' + summary;
		if (typeof author === 'string' && author !== '') {
			title += '\n' + author + (typeof email === 'string' && email !== '' ? ' <' + email + '>' : '');
		}
		if (typeof date === 'number') title += '\n' + formatLongDate(date);
		return title;
	}

	/**
	 * Render the Pinned row at the top of the graph, listing the pinned branches and commits of the
	 * current repository as chips (click to jump, click the ✕ to unpin).
	 */
	private renderPinnedControls() {
		const controls = this.pinnedControlsElem;
		if (controls === null) return;
		if (typeof this.currentRepo === 'undefined') {
			controls.style.display = 'none';
			return;
		}

		const pinnedBranches = this.getPinnedBranches();
		const pinnedCommits = this.getPinnedCommits();

		let html = '<span class="unselectable pinnedRowLabel">' + strings.pinnedLabel + '</span>';
		for (const branch of pinnedBranches) {
			const name = escapeHtml(branch);
			html += '<span class="pinnedChip" data-type="branch" data-value="' + name + '" title="' + formatStr(strings.pinnedBranchChipTitle, name) + '">\uD83D\uDCCC ' + name +
				'<span class="pinnedChipRemove" data-type="branch" data-value="' + name + '" title="' + formatStr(strings.pinnedUnpinBranch, name) + '">&times;</span></span>';
		}
		for (const pinned of pinnedCommits) {
			const hash = escapeHtml(pinned.hash);
			const summary = escapeHtml(pinned.summary.length > 30 ? pinned.summary.substring(0, 30) + '…' : pinned.summary);
			html += '<span class="pinnedChip" data-type="commit" data-value="' + hash + '" title="' + escapeHtml(this.pinnedCommitChipTitle(pinned)) + '">\uD83D\uDCCC <b>' + abbrevCommit(pinned.hash) + '</b>' + (summary !== '' ? ' ' + summary : '') +
				'<span class="pinnedChipRemove" data-type="commit" data-value="' + hash + '" title="' + formatStr(strings.pinnedUnpinCommit, hash) + '">&times;</span></span>';
		}
		controls.innerHTML = html;
		controls.style.display = pinnedBranches.length + pinnedCommits.length > 0 ? 'block' : 'none';
	}

	private onPinnedChipClick(target: HTMLElement) {
		const remove = <HTMLElement | null>target.closest('.pinnedChipRemove');
		if (remove !== null && remove.dataset.value !== undefined) {
			if (remove.dataset.type === 'commit') this.togglePinCommit(remove.dataset.value, null);
			else this.togglePinBranch(remove.dataset.value);
			return;
		}

		const chip = <HTMLElement | null>target.closest('.pinnedChip');
		if (chip === null || chip.dataset.value === undefined) return;
		if (chip.dataset.type === 'commit') {
			if (this.commitLookup[chip.dataset.value] === undefined) {
				if (!this.moreCommitsAvailable) {
					dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInView, strings.dialogClose, null);
					return;
				}
				// The pinned commit is beyond the currently loaded commits: ask the extension how
				// many commits precede it, so the view can jump straight to it in one load
				this.pendingScrollCommitHash = chip.dataset.value;
				this.countCommitsBeforePending = true;
				this.requestCountCommitsBefore(chip.dataset.value);
				return;
			}
			this.scrollToCommit(chip.dataset.value, true, true);
		} else {
			this.branchDropdown.selectOnlyOption(chip.dataset.value);
		}
	}


	/* Renderers */

	public render() {
		this.renderPinnedControls();
		this.renderTable();
		this.renderGraph();
		// The graph column's automatic width follows the lanes the graph just drew, so it can only
		// be measured once renderGraph() has run - makeTableResizable() applies it from inside
		// renderTable(), which is one step too early to see newly opened branch lanes.
		applyGraphColumnAutoLayout(this);
	}

	public renderGraph() {
		if (typeof this.currentRepo === 'undefined') {
			// Only render the graph if a repo is loaded (or a repo is currently being loaded)
			return;
		}

		const colHeadersElem = document.getElementById('tableColHeaders');
		const cdvHeight = this.gitRepos[this.currentRepo].cdvHeight;
		const headerHeight = colHeadersElem !== null ? colHeadersElem.clientHeight + 1 : 0;
		const expandedCommit = isCdvDocked(this) ? null : this.expandedCommit;
		const expandedCommitElem = expandedCommit !== null ? document.getElementById('cdv') : null;

		// Extra in-table row expansions (e.g. meta event rows) are no longer produced; the graph
		// API still accepts them for the inline Commit Details View
		const metaExpansions: { index: number, height: number }[] = [];
		const metaRowsHeight = 0;

		// Update the graphs grid dimensions
		this.config.graph.grid.expandY = expandedCommitElem !== null
			? expandedCommitElem.getBoundingClientRect().height
			: cdvHeight;
		this.config.graph.grid.y = this.commits.length > 0 && this.tableElem.children.length > 0
			? (this.tableElem.children[0].clientHeight - headerHeight - (expandedCommit !== null ? cdvHeight : 0) - metaRowsHeight) / this.commits.length
			: this.config.graph.grid.y;
		this.config.graph.grid.offsetY = headerHeight + this.config.graph.grid.y / 2;

		this.graph.render(expandedCommit, metaExpansions, this.renderedRange);
	}

	/**
	 * Cache of formatted message texts (keyed by the raw text): commit subjects repeat heavily in
	 * large repositories (merges, reverts, chores), and the regex-heavy formatting is a major
	 * per-row render cost. Bounded, and simply cleared when the bound is exceeded.
	 */
	private readonly formattedTextCache = new Map<string, string>();
	private formattedTextCacheSignature = '';
	private static readonly FORMATTED_TEXT_CACHE_LIMIT = 5000;

	private formatText(textFormatter: TextFormatter, text: string): string {
		// The cache is only valid for the current formatting configuration (markdown setting and
		// the repository's issue linking configuration): bust it when either changes
		const formatSignature = (this.config.markdown ? '1' : '0') + '|' + this.gitRepos[this.currentRepo].issueLinkingConfig;
		if (formatSignature !== this.formattedTextCacheSignature) {
			this.formattedTextCache.clear();
			this.formattedTextCacheSignature = formatSignature;
		}
		const cached = this.formattedTextCache.get(text);
		if (cached !== undefined) return cached;
		const formatted = textFormatter.format(text);
		if (this.formattedTextCache.size >= GitGraphView.FORMATTED_TEXT_CACHE_LIMIT) {
			this.formattedTextCache.clear();
		}
		this.formattedTextCache.set(text, formatted);
		return formatted;
	}

	/**
	 * Context shared by the commit row rendering: computed once per render (full or incremental)
	 * and consumed once per rendered commit row.
	 */
	private createRowRenderingContext() {
		const currentHash = this.commits.length > 0 && this.commits[0].hash === UNCOMMITTED ? UNCOMMITTED : this.commitHead;
		return {
			colVisibility: this.getColumnVisibility(),
			currentHash: currentHash,
			vertexColours: this.graph.getVertexColours(),
			widthsAtVertices: this.config.referenceLabels.branchLabelsAlignedToGraph ? this.graph.getWidthsAtVertices() : [],
			mutedCommits: this.graph.getMutedCommits(currentHash),
			pinnedCommitHashes: new Set(this.getPinnedCommits().map((pinned) => pinned.hash)),
			textFormatter: new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
				emoji: true,
				issueLinking: true,
				markdown: this.config.markdown
			})
		};
	}

	private getCommitRowHtml(i: number, ctx: ReturnType<GitGraphView['createRowRenderingContext']>) {
		function getResizeColHtml(col: number) {
			return (col > 0 ? '<span class="resizeCol left" data-col="' + (col - 1) + '"></span>' : '') + (col < 4 ? '<span class="resizeCol right" data-col="' + col + '"></span>' : '');
		}

		const colVisibility = ctx.colVisibility, currentHash = ctx.currentHash, vertexColours = ctx.vertexColours, widthsAtVertices = ctx.widthsAtVertices, mutedCommits = ctx.mutedCommits, pinnedCommitHashes = ctx.pinnedCommitHashes, textFormatter = ctx.textFormatter;

		let commit = this.commits[i];
		let subject = commit.message.split(/\r?\n/)[0];
		let body = '';

		if (this.config.showBodyInline) {
			// The full body is fetched on demand (the commit list only carries subjects)
			const fullMessage = this.commitBodies[commit.hash];
			if (typeof fullMessage === 'string') {
				let splitMessage = fullMessage.split(/\r?\n/);
				if (splitMessage.length > 1) {
					subject = splitMessage[0];
					splitMessage.shift();
					body = splitMessage.join(' ').replace(/\s+/g, ' ').trim();
				}
			}
		}

		let message = '<span class="text">' + this.formatText(textFormatter, subject);
		if (body !== '' && this.config.showBodyInline) {
			message += ' <span class="commitbody">' + this.formatText(textFormatter, body) + '</span>';
		}
		message += '</span>';
		let date = formatShortDate(commit.date);
		let branchLabels = getBranchLabels(commit.heads, commit.remotes);
		let refBranches = '', refTags = '', j, k, refName, remoteName, refActive, refHtml, branchCheckedOutAtCommit: string | null = null;

		for (j = 0; j < branchLabels.heads.length; j++) {
			refName = escapeHtml(branchLabels.heads[j].name);
			refActive = branchLabels.heads[j].name === this.gitBranchHead;
			refHtml = '<span class="gitRef head' + (refActive ? ' active' : '') + '" data-name="' + refName + '">' + SVG_ICONS.branch + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span>';
			for (k = 0; k < branchLabels.heads[j].remotes.length; k++) {
				remoteName = escapeHtml(branchLabels.heads[j].remotes[k]);
				refHtml += '<span class="gitRefHeadRemote" data-remote="' + remoteName + '" data-fullref="' + escapeHtml(branchLabels.heads[j].remotes[k] + '/' + branchLabels.heads[j].name) + '">' + remoteName + '</span>';
			}
			refHtml += '</span>';
			refBranches = refActive ? refHtml + refBranches : refBranches + refHtml;
			if (refActive) branchCheckedOutAtCommit = this.gitBranchHead;
		}
		for (j = 0; j < branchLabels.remotes.length; j++) {
			refName = escapeHtml(branchLabels.remotes[j].name);
			refBranches += '<span class="gitRef remote" data-name="' + refName + '" data-remote="' + (branchLabels.remotes[j].remote !== null ? escapeHtml(branchLabels.remotes[j].remote!) : '') + '">' + SVG_ICONS.branch + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span></span>';
		}

		let tagMap: { [name: string]: { name: string, remotes: string[], annotated: boolean, local: boolean } } = {};
		for (j = 0; j < commit.tags.length; j++) {
			let parts = commit.tags[j].name.split('/');
			let tName = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
			let tRemote = parts.length > 1 ? parts[0] : null;
			if (!tagMap[tName]) { tagMap[tName] = { name: tName, remotes: [], annotated: commit.tags[j].annotated, local: false }; }
			if (tRemote) { tagMap[tName].remotes.push(tRemote); } else { tagMap[tName].local = true; }
		}
		for (let tName in tagMap) {
			let tag = tagMap[tName];
			refName = escapeHtml(tag.name);
			let refHtml = '<span class="gitRef tag" data-name="' + refName + '" data-tagtype="' + (tag.annotated ? 'annotated' : 'lightweight') + '">' + SVG_ICONS.tag + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span>';
			for (k = 0; k < tag.remotes.length; k++) {
				remoteName = escapeHtml(tag.remotes[k]);
				refHtml += '<span class="gitRefHeadRemote" data-remote="' + remoteName + '" data-fullref="' + escapeHtml(tag.remotes[k] + '/tags/' + tag.name) + '">' + remoteName + '</span>';
			}
			refHtml += '</span>';
			refTags += refHtml;
		}

		let refGerrit = '';
		const gerritState = this.gerritStates[commit.hash];
		if (typeof gerritState !== 'undefined' && this.gerritPassesFilter(gerritState)) {
			refGerrit = getGerritBadgeHtml(this, gerritState);
		}

		if (commit.stash !== null) {
			refName = escapeHtml(commit.stash.selector);
			refBranches = '<span class="gitRef stash" data-name="' + refName + '">' + SVG_ICONS.stash + '<span class="gitRefName" data-fullref="' + refName + '">' + escapeHtml(commit.stash.selector.substring(5)) + '</span></span>' + refBranches;
		}

		const commitDot = commit.hash === this.commitHead
			? '<span class="commitHeadDot" title="' + (branchCheckedOutAtCommit !== null
				? escapeHtml(formatStr(strings.checkedOutBranchAtCommit, branchCheckedOutAtCommit))
				: strings.commitCurrentlyCheckedOut
			) + '"></span>'
			: '';
		const pinnedBadge = pinnedCommitHashes.has(commit.hash)
			? '<span class="pinnedBadge" title="' + escapeHtml(strings.pinnedBadgeTitle) + '">\uD83D\uDCCC</span>'
			: '';
		let html = '<tr class="commit' + (commit.hash === currentHash ? ' current' : '') + (mutedCommits[i] ? ' mute' : '') + '"' + (commit.hash !== UNCOMMITTED ? '' : ' id="uncommittedChanges"') + ' data-id="' + i + '" data-hash="' + commit.hash + '" data-color="' + vertexColours[i] + '">' +
			(this.config.referenceLabels.branchLabelsAlignedToGraph ? '<td>' + getResizeColHtml(0) + (refBranches !== '' ? '<span style="margin-left:' + (widthsAtVertices[i] - 4) + 'px"' + refBranches.substring(5) : '') + '</td><td>' + getResizeColHtml(1) + '<span class="description">' + commitDot + pinnedBadge : '<td>' + getResizeColHtml(0) + '</td><td>' + getResizeColHtml(1) + '<span class="description">' + commitDot + pinnedBadge + refBranches) + (this.config.referenceLabels.tagLabelsOnRight ? refGerrit + message + (refTags !== '' ? '<span class="tagsWrapper">' + refTags + '</span>' : '') : refTags + refGerrit + message) + '</span></td>' +
			(colVisibility.date ? '<td class="dateCol text" title="' + date.title + '">' + getResizeColHtml(2) + date.formatted + '</td>' : '') +
			(colVisibility.author ? '<td class="authorCol text" title="' + escapeHtml(commit.author + ' <' + commit.email + '>') + '">' + getResizeColHtml(3) + (this.config.fetchAvatars ? '<span class="avatar" data-email="' + escapeHtml(commit.email) + '">' + (typeof this.avatars[commit.email] === 'string' ? '<img class="avatarImg" decoding="sync" src="' + this.avatars[commit.email] + '">' : '') + '</span>' : '') + escapeHtml(commit.author) + '</td>' : '') +
			(colVisibility.commit ? '<td class="text" title="' + escapeHtml(commit.hash) + '">' + getResizeColHtml(4) + abbrevCommit(commit.hash) + '</td>' : '') +
			'</tr>';

		return html;
	}

	/**
	 * Should the commit table be rendered windowed (only the rows in and near the viewport, with
	 * spacer rows preserving the scroll height)? Requires uniform row heights, so any state with
	 * variable-height rows (open Commit Details View) or that needs
	 * every row in the DOM (an active find query) falls back to a full render.
	 */
	private canVirtualize() {
		if (this.commits.length <= 100) return false; // small lists: not worth the window churn
		if (!(this.config.graph.rowHeight > 0)) return false; // no uniform row height available
		if (this.expandedCommit !== null) return false;
		if (this.findWidget.isSearching()) return false;
		if (this.viewElem.clientHeight <= 0) return false; // unmeasured (e.g. hidden view): keep a full render
		return true;
	}

	/**
	 * Compute the range of commit rows to render (viewport plus a buffer).
	 */
	private computeVisibleRange() {
		const rowHeight = this.config.graph.rowHeight;
		const start = Math.max(0, Math.floor((this.viewElem.scrollTop - this.getHeaderHeight()) / rowHeight) - GitGraphView.VIRTUAL_ROW_BUFFER);
		const count = Math.ceil(this.viewElem.clientHeight / rowHeight) + 1 + 2 * GitGraphView.VIRTUAL_ROW_BUFFER;
		return { start: start, end: Math.min(this.commits.length, start + count) };
	}


	/**
	 * The scroll position at which commit row `index` sits exactly at the top of the viewport,
	 * while windowed rendering is active: rows then have a uniform height, so the position is pure
	 * arithmetic and holds whether or not that row is currently in the DOM. Unlike
	 * `computeVisibleRange` - which only has to pick a window and is deliberately generous - this
	 * is exact, and includes the sticky table column headers `getHeaderHeight()` leaves out.
	 */
	private getRowTop(index: number) {
		const colHeadersElem = document.getElementById('tableColHeaders');
		return this.getHeaderHeight()
			+ (colHeadersElem !== null ? colHeadersElem.offsetHeight : this.config.graph.rowHeight)
			+ index * this.config.graph.rowHeight;
	}

	/**
	 * The commit the user is currently looking at: the topmost commit row intersecting the
	 * viewport, plus how far it is scrolled past the top edge.
	 *
	 * This - not `scrollTop` - is the thing that must survive an update. `scrollTop` is a pixel
	 * offset into a document whose shape changes underneath it: insert or remove k rows above the
	 * viewport and the same `scrollTop` points k rows away from what the user was reading, which
	 * is exactly what "the view jumps" means. An anchor is immune to that by construction, because
	 * it names a commit rather than a distance.
	 */
	private captureViewportAnchor(): { hash: string, offset: number, atTop: boolean } | null {
		if (this.viewElem.clientHeight <= 0 || this.commits.length === 0) return null;
		const atTop = this.viewElem.scrollTop <= 0;

		if (this.canVirtualize()) {
			// Windowed rendering: row heights are uniform (that is its precondition), so which
			// commit sits at the top of the viewport is exact arithmetic - the inverse of
			// getRowTop(). Preferred over measuring the DOM because it also holds for a row that
			// windowing left out of the DOM entirely.
			const index = Math.min(this.commits.length - 1, Math.max(0, Math.floor((this.viewElem.scrollTop - this.getRowTop(0)) / this.config.graph.rowHeight)));
			return { hash: this.commits[index].hash, offset: this.viewElem.scrollTop - this.getRowTop(index), atTop: atTop };
		}

		// Full render: rows may have any height (an open Commit Details View), so the topmost
		// visible row has to be found by measuring
		const viewTop = this.viewElem.getBoundingClientRect().top;
		for (const elem of <HTMLElement[]><any>this.tableElem.querySelectorAll('tr.commit')) {
			const rect = elem.getBoundingClientRect();
			if (rect.bottom > viewTop + 1) { // the first row intersecting the viewport
				const index = parseInt(elem.dataset.id!);
				if (isNaN(index) || index < 0 || index >= this.commits.length) return null;
				return { hash: this.commits[index].hash, offset: viewTop - rect.top, atTop: atTop };
			}
		}
		return null;
	}

	/**
	 * Put the anchored commit back at the exact on-screen position it had, whatever the update did
	 * to the list: rows inserted or removed above it, history rewritten, the "Uncommitted Changes"
	 * row appearing or vanishing, even the header growing by a Pinned row. Rows below the viewport
	 * cannot affect it by construction.
	 *
	 * Nothing here is a delta, so nothing can accumulate: the position is restored absolutely,
	 * measured from the DOM where the row is rendered (correct with variable row heights, e.g. an
	 * open Commit Details View) and computed arithmetically where windowed rendering left it out
	 * of the DOM. Must run once the DOM already represents the new list.
	 */
	private applyViewportAnchor(anchor: { hash: string, offset: number, atTop: boolean } | null) {
		if (anchor === null) return;

		if (anchor.atTop) {
			// At the very top of the history the user is following the newest commits, so rows
			// arriving above must be SEEN: the list stays pinned to the top and the content below
			// slides down, rather than the view scrolling to keep the old first row still. Pinning
			// to the edge IS the anchor here - the same rule the browser's own scroll anchoring
			// applies, and the only place where the visible rows are expected to move.
			this.viewElem.scrollTop = 0;
			return;
		}

		const index = this.commitLookup[anchor.hash];
		if (typeof index !== 'number') return; // the anchored commit is gone (e.g. it was rewritten)

		let target: number;
		if (this.canVirtualize()) {
			// Windowed: exact arithmetic, needing neither layout nor the row to be in the DOM -
			// which is what lets this run BEFORE the rows are rendered, so the window is computed
			// at the final scroll position and the rows in it are reconciled exactly once.
			target = this.getRowTop(index) + anchor.offset;
		} else {
			// Full render: measured, so it is correct with variable row heights too (the Commit
			// Details View inserts a <tr> of its own height above the rows below it). Only valid
			// once the DOM already shows the new list.
			const elem = findCommitElemWithId(index);
			if (elem === null) return;
			target = this.viewElem.scrollTop + (elem.getBoundingClientRect().top - this.viewElem.getBoundingClientRect().top) + anchor.offset;
		}

		this.viewElem.scrollTop = Math.max(0, Math.round(target));
	}

	/**
	 * Build a single `<tr>` from its HTML. Rows have to be parsed in table context or the browser
	 * drops them, which `<template>` does correctly.
	 */
	private createRowElem(html: string) {
		const tpl = document.createElement('template');
		tpl.innerHTML = '<table><tbody>' + html + '</tbody></table>';
		return <HTMLElement>tpl.content.querySelector('tr')!;
	}

	/**
	 * Make the rendered commit rows match `commits[from..to)` exactly, reusing the existing DOM
	 * node of every row that has not changed.
	 *
	 * This is what makes the virtual table's contract true: rows are matched by COMMIT HASH, not
	 * by index, and re-rendered only when their own HTML actually differs. A commit inserted or
	 * removed outside the window therefore touches nothing inside it - the rows keep their very
	 * DOM nodes, and with them the column widths the browser already laid out, the find-widget
	 * highlights and the open Commit Details View. Only the `data-id` index label is restamped.
	 *
	 * Doing it here, once, is what replaces the hand-written "can I take a fast path?" predicates
	 * this used to need (append / prepend / patch-metadata), each of which had to re-derive that
	 * same conclusion for one particular shape of change - and got it wrong at the edges.
	 */
	private syncCommitRows(ctx: ReturnType<GitGraphView['createRowRenderingContext']>, from: number, to: number) {
		// Rows live inside the <tbody> (implicit or explicit), not directly under the <table>
		const tableBody = <HTMLElement | null>(this.tableElem.querySelector('table > tbody') || this.tableElem.querySelector('table'));
		if (tableBody === null) return;

		const existing = new Map<string, HTMLElement>();
		for (const row of <HTMLElement[]><any>tableBody.querySelectorAll('tr.commit')) {
			const hash = row.dataset.hash;
			if (typeof hash === 'string' && !existing.has(hash)) existing.set(hash, row);
		}

		// Walk the desired rows in order, keeping a cursor on the node each one should sit before
		const headerRow = tableBody.querySelector('#tableColHeaders');
		const topSpacer = tableBody.querySelector('#tableColHeaders + tr.virtSpacer');
		let cursor: Node | null = (topSpacer !== null ? topSpacer : headerRow) as Node | null;
		cursor = cursor !== null ? cursor.nextSibling : tableBody.firstChild;

		const kept = new Set<HTMLElement>();
		for (let i = from; i < to; i++) {
			const html = this.getCommitRowHtml(i, ctx);
			// Three things change without the ROW changing - its index label, its graph lane colour
			// and whether it is the checked-out commit - and all three can be applied to an existing
			// node in place. Keeping them out of the comparison is what lets a row survive a commit
			// arriving above it, or HEAD moving elsewhere, as the very same DOM node.
			const signature = html
				.replace(/ data-id="\d+"/, '')
				.replace(/ data-color="\d+"/, '')
				.replace(/^<tr class="commit current/, '<tr class="commit');
			const hash = this.commits[i].hash;
			let row = existing.get(hash);

			if (row === undefined || this.rowSignatures.get(row) !== signature) {
				// The row's own content changed (or it was not rendered at all): build it, put it in
				// place, and only then drop the stale node - which may be the very node `cursor`
				// points at, so it must not be detached while the cursor still needs it.
				const fresh = this.createRowElem(html);
				this.rowSignatures.set(fresh, signature);
				tableBody.insertBefore(fresh, cursor);
				if (row !== undefined && row.parentNode !== null) row.remove();
				row = fresh;
			} else {
				// Unchanged: keep the node, restamping only what is allowed to differ. Moving it is
				// what absorbs rows inserted or removed above without rebuilding anything.
				if (row.dataset.id !== String(i)) row.dataset.id = String(i);
				if (row.dataset.color !== String(ctx.vertexColours[i])) row.dataset.color = String(ctx.vertexColours[i]);
				row.classList.toggle('current', hash === ctx.currentHash);
				if (row !== cursor) tableBody.insertBefore(row, cursor);
			}

			// The next row goes immediately after this one, whatever just happened to the nodes
			cursor = row.nextSibling;
			kept.add(row);
			existing.delete(hash);
		}

		// Whatever is left is no longer in the window (scrolled out, or the commit is gone)
		for (const row of <HTMLElement[]><any>tableBody.querySelectorAll('tr.commit')) {
			if (!kept.has(row)) row.remove();
		}
	}

	/**
	 * Keep the spacer row that stands in for the `rows` unrendered commit rows above (`top`) or
	 * below the window, so the scroll height - and with it the scroll bar and the "Load More
	 * Commits" bottom detection - stays proportional to the whole commit list. The element is
	 * created once and afterwards only resized, so the rows around it are never disturbed.
	 */
	private syncSpacerRow(tableBody: HTMLElement, top: boolean, rows: number) {
		let spacer = <HTMLElement | null>tableBody.querySelector(top ? '#virtSpacerTop' : '#virtSpacerBottom');
		if (this.renderedRange === null) {
			// Full render: every row is in the DOM, nothing to stand in for
			if (spacer !== null) spacer.remove();
			return;
		}
		if (spacer === null) {
			spacer = this.createRowElem('<tr id="' + (top ? 'virtSpacerTop' : 'virtSpacerBottom') + '" class="virtSpacer" aria-hidden="true"><td style="height:0;padding:0"></td></tr>');
			if (top) {
				tableBody.querySelector('#tableColHeaders')!.insertAdjacentElement('afterend', spacer);
			}
		}
		if (!top) tableBody.appendChild(spacer); // always the last row, whatever was appended before it
		const td = <HTMLElement | null>spacer.querySelector('td');
		if (td !== null) {
			const height = Math.max(0, rows) * this.config.graph.rowHeight + 'px';
			if (td.style.height !== height) td.style.height = height;
			const colspan = String(this.getNumColumns());
			if (td.getAttribute('colspan') !== colspan) td.setAttribute('colspan', colspan);
		}
	}

	/**
	 * Re-render the visible window after the view was scrolled (no-op unless windowed rendering is
	 * active and the window actually moved).
	 */
	public updateVirtualWindow() {
		if (this.renderedRange === null) return;
		if (!this.canVirtualize()) {
			// Windowed rendering is no longer allowed (e.g. a find query became active): fall back
			// to a full render, otherwise scrolling would keep swapping the windowed rows in and out
			this.render();
			return;
		}
		const range = this.computeVisibleRange();
		if (range.start === this.renderedRange.start && range.end === this.renderedRange.end) return;
		this.renderTable();
		this.renderGraph();
	}

	/**
	 * Switch from windowed rendering to a full render if it is currently active. Used by the Find
	 * Widget before scanning for matches: matching only sees rows that are in the DOM, so every
	 * commit row must be rendered (see `canVirtualize`).
	 */
	public exitWindowedRender() {
		if (this.renderedRange === null) return;
		this.render();
	}

	private renderTable() {
		// The expanded Commit Details View is a <tr> living inside this table (non-docked layout).
		// Detach it while the rows are reconciled and put it back afterwards: it must not be
		// treated as one of the commit rows, and re-creating it would discard its scroll position,
		// its file-tree open/closed state and every event listener - which is what makes an
		// unrelated background refresh look like the commit "closing and reopening".
		const cdvElem = this.expandedCommit !== null && !isCdvDocked(this) ? document.getElementById('cdv') : null;
		if (cdvElem !== null && cdvElem.parentNode !== null) cdvElem.parentNode.removeChild(cdvElem);

		const ctx = this.createRowRenderingContext();
		const colVisibility = ctx.colVisibility;

		const headerHtml = '<tr id="tableColHeaders"><th id="tableHeaderGraphCol" class="tableColHeader" data-col="0">' + strings.columnGraph + '</th><th class="tableColHeader" data-col="1">' + strings.columnDescription + '</th>' +
			(colVisibility.date ? '<th class="tableColHeader dateCol" data-col="2">' + strings.columnDate + '</th>' : '') +
			(colVisibility.author ? '<th class="tableColHeader authorCol" data-col="3">' + strings.columnAuthor + '</th>' : '') +
			(colVisibility.commit ? '<th class="tableColHeader commitCol" data-col="4">' + strings.columnCommit + '</th>' : '') +
			'</tr>';

		// A full re-render can shrink the commit list (e.g. applying a path filter). A stale scroll
		// position beyond the shrunken list is clamped BEFORE the rendered window is computed,
		// otherwise it selects an empty window (start beyond the list) and no rows or graph vertices
		// are rendered at all. The clamp only acts in that case: the #footer ("Load More Commits")
		// also contributes to the scrollable height, so clamping to the table's height alone would
		// nudge the view up on every re-render while the user is scrolled to the very bottom.
		if (this.canVirtualize() && this.computeVisibleRange().start >= this.commits.length) {
			const maxScroll = Math.max(0, this.getHeaderHeight() + this.commits.length * this.config.graph.rowHeight - this.viewElem.clientHeight);
			if (this.viewElem.scrollTop > maxScroll) this.viewElem.scrollTop = maxScroll;
		}
		this.renderedRange = this.canVirtualize() ? this.computeVisibleRange() : null;
		const from = this.renderedRange !== null ? this.renderedRange.start : 0;
		const to = this.renderedRange !== null ? this.renderedRange.end : this.commits.length;

		// The table skeleton (<tbody>, the column header row, and the two spacers standing in for
		// the rows outside the window) is created once and then kept - never rebuilt - so that
		// reconciling the rows below can reuse the DOM nodes that did not change.
		let tableBody = <HTMLElement | null>this.tableElem.querySelector('table > tbody');
		if (tableBody === null) {
			this.tableElem.innerHTML = '<table><tbody></tbody></table>';
			tableBody = <HTMLElement>this.tableElem.querySelector('table > tbody')!;
		}
		// Rebuild the header row only when the set of visible columns actually changes - never by
		// comparing its HTML, which the column-resizing code decorates with inline widths, so it
		// would never match what is generated here and the header (and the widths on it) would be
		// thrown away on every single refresh.
		const headerKey = String(colVisibility.date) + String(colVisibility.author) + String(colVisibility.commit);
		const headerElem = tableBody.querySelector('#tableColHeaders');
		if (headerElem === null) {
			tableBody.insertAdjacentHTML('afterbegin', headerHtml);
			this.renderedHeaderKey = headerKey;
		} else if (this.renderedHeaderKey !== headerKey) {
			headerElem.outerHTML = headerHtml;
			this.renderedHeaderKey = headerKey;
		}
		this.syncSpacerRow(tableBody, true, this.renderedRange !== null ? from : 0);
		this.syncCommitRows(ctx, from, to);
		this.syncSpacerRow(tableBody, false, this.renderedRange !== null ? this.commits.length - to : 0);

		if (cdvElem !== null) {
			// Re-attach it now, before the expandedCommit handling below runs: showCommitDetails()
			// / renderCommitDetailsView() find it via document.getElementById('cdv') and reuse it in
			// place (only repositioning it if its row moved) instead of creating a new one.
			const commitElem = findCommitElemWithId(this.getCommitId(this.expandedCommit!.commitHash));
			if (commitElem !== null) insertAfter(cdvElem, commitElem);
		}
		this.footerElem.innerHTML = this.moreCommitsAvailable ? '<div id="loadMoreCommitsBtn" class="roundedBtn">' + strings.loadMoreCommits + '</div>' : '';
		makeTableResizable(this);
		this.findWidget.refresh();
		this.renderedGitBranchHead = this.gitBranchHead;

		if (this.moreCommitsAvailable) {
			document.getElementById('loadMoreCommitsBtn')!.addEventListener('click', () => {
				this.loadMoreCommits();
			});
		}

		if (this.expandedCommit !== null) {
			const expandedCommit = this.expandedCommit;
			const commitElem = findCommitElemWithId(this.getCommitId(expandedCommit.commitHash));
			const compareWithElem = expandedCommit.compareWithHash !== null ? findCommitElemWithId(this.getCommitId(expandedCommit.compareWithHash)) : null;

			if (commitElem === null || (expandedCommit.compareWithHash !== null && compareWithElem === null)) {
				closeCommitDetails(this, false);
				this.saveState();
			} else {
				expandedCommit.index = parseInt(commitElem.dataset.id!);
				expandedCommit.commitElem = commitElem;
				expandedCommit.compareWithElem = compareWithElem;
				this.saveState();
				if (expandedCommit.compareWithHash === null) {
					// Commit Details View is open
					if (!expandedCommit.loading && expandedCommit.commitDetails !== null && expandedCommit.fileTree !== null) {
						showCommitDetails(this, expandedCommit.commitDetails, expandedCommit.fileTree, expandedCommit.avatar, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED) {
							this.requestCommitDetails(expandedCommit.commitHash, true);
						}
					} else {
						loadCommitDetails(this, commitElem);
					}
				} else {
					// Commit Comparison is open
					if (!expandedCommit.loading && expandedCommit.fileChanges !== null && expandedCommit.fileTree !== null) {
						showCommitComparison(this, expandedCommit.commitHash, expandedCommit.compareWithHash, expandedCommit.fileChanges, expandedCommit.fileTree, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED || expandedCommit.compareWithHash === UNCOMMITTED) {
							this.requestCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, true);
						}
					} else {
						loadCommitComparison(this, commitElem, compareWithElem!);
					}
				}
			}
		}

		this.requestCommitBodiesForRows(from, to);
	}

	/**
	 * Request the full message bodies of the commits in the given (rendered) row range, on demand:
	 * the commit list only carries subjects, and bodies are only displayed when "Show Commit Body
	 * Inline" is enabled (no-op otherwise).
	 */
	private requestCommitBodiesForRows(from: number, to: number) {
		if (!this.config.showBodyInline) return;
		const missing: string[] = [];
		for (let i = from; i < to && missing.length < GitGraphView.COMMIT_BODIES_BATCH_LIMIT; i++) {
			const commit = this.commits[i];
			if (commit.hash === UNCOMMITTED || commit.stash !== null) continue;
			if (typeof this.commitBodies[commit.hash] !== 'string' && !this.commitBodiesRequested.has(commit.hash)) {
				this.commitBodiesRequested.add(commit.hash);
				missing.push(commit.hash);
			}
		}
		if (missing.length > 0) sendMessage({ command: 'commitBodies', repo: this.currentRepo, commitHashes: missing });
	}

	/**
	 * Store a batch of commit message bodies fetched on demand, and re-render the rows so the
	 * inline bodies ("Show Commit Body Inline") become visible.
	 */
	public processCommitBodies(msg: GG.ResponseCommitBodies) {
		let received = false;
		for (const hash in msg.bodies) {
			this.commitBodies[hash] = msg.bodies[hash];
			received = true;
		}
		if (!received) return;
		this.renderTable();
		this.renderGraph();
	}





	private renderUncommittedChanges() {
		const uncommittedElem = document.getElementById('uncommittedChanges');
		if (uncommittedElem === null) return; // not rendered (e.g. outside the windowed render range)
		const colVisibility = this.getColumnVisibility(), date = formatShortDate(this.commits[0].date);
		uncommittedElem.innerHTML = '<td></td><td><b>' + escapeHtml(this.commits[0].message) + '</b></td>' +
			(colVisibility.date ? '<td class="dateCol text" title="' + date.title + '">' + date.formatted + '</td>' : '') +
			(colVisibility.author ? '<td class="authorCol text" title="* <>">*</td>' : '') +
			(colVisibility.commit ? '<td class="text" title="*">*</td>' : '');
	}

	private renderFetchButton() {
		alterClass(this.controlsElem, CLASS_FETCH_SUPPORTED, this.gitRemotes.length > 0);
	}

	/**
	 * Update the filter button to reflect the active path filter.
	 */
	private renderFilterButton() {
		const filterBtn = document.getElementById('filterBtn');
		if (filterBtn === null) return;
		filterBtn.innerHTML = SVG_ICONS.filter;
		filterBtn.title = this.commitPathFilter !== null
			? formatStr(strings.filterTitleActive, this.commitPathFilter)
			: strings.filterTitle;
		alterClass(filterBtn, 'active', this.commitPathFilter !== null);
	}

	/**
	 * Show the dialog used to filter the loaded commits by a file path.
	 */
	private showPathFilterDialog() {
		dialog.showForm(strings.filterByPathMessage, [{
			type: DialogInputType.Text,
			name: strings.filterPathName,
			default: this.commitPathFilter !== null ? this.commitPathFilter : '',
			placeholder: strings.filterPathPlaceholder
		}], strings.dialogApply, (values) => {
			// Normalise the comma-separated paths: trim whitespace around each path and drop
			// empty segments, so git receives clean pathspecs
			const filterPath = (<string>values[0]).split(',').map((path) => path.trim()).filter((path) => path !== '').join(',');
			this.commitPathFilter = filterPath !== '' ? filterPath : null;
			this.renderFilterButton();
			// The filtered list is unrelated to the scrolled position in the full list
			this.viewElem.scrollTop = 0;
			this.requestLoadRepoInfoAndCommits(true, true);
		}, null, strings.dialogClearFilter, () => {
			this.commitPathFilter = null;
			this.renderFilterButton();
			this.viewElem.scrollTop = 0;
			this.requestLoadRepoInfoAndCommits(true, true);
		});
	}

	public renderToolbarText() {
		const setText = (id: string, text: string) => {
			const elem = document.getElementById(id);
			if (elem !== null) elem.textContent = text;
		};
		setText('repoControlLabel', strings.repoLabel);
		setText('branchControlLabel', strings.branchesLabel);
		setText('authorControlLabel', strings.authorsLabel);
		setText('showRemoteBranchesLabel', strings.showRemoteBranchesLabel);
		const showRemoteBranchesControl = document.getElementById('showRemoteBranchesControl');
		if (showRemoteBranchesControl !== null) showRemoteBranchesControl.title = strings.showRemoteBranchesTitle;
		const filterBtn = document.getElementById('filterBtn');
		if (filterBtn !== null) {
			filterBtn.title = this.commitPathFilter !== null
				? formatStr(strings.filterTitleActive, this.commitPathFilter)
				: strings.filterTitle;
		}
		setText('pinnedRowLabel', strings.pinnedLabel);
	}

	public renderRefreshButton() {
		const enabled = !this.currentRepoRefreshState.inProgress;
		this.refreshBtnElem.title = enabled ? strings.refreshTitle : strings.refreshingTitle;
		this.refreshBtnElem.innerHTML = enabled ? SVG_ICONS.refresh : SVG_ICONS.loading;
		alterClass(this.refreshBtnElem, CLASS_REFRESHING, !enabled);
	}

	public renderTagDetails(tagName: string, commitHash: string, details: GG.GitTagDetails) {
		const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
			commits: true,
			emoji: true,
			issueLinking: true,
			markdown: this.config.markdown,
			multiline: true,
			urls: true
		});
		dialog.showMessage(
			formatStr(strings.tagDetailsTitle, escapeHtml(tagName)) + '<br><span class="messageContent">' +
			strings.tagDetailsObject + escapeHtml(details.hash) + '<br>' +
			strings.tagDetailsCommit + escapeHtml(commitHash) + '<br>' +
			// A lightweight tag has no tagger of its own, so there is no tagger or date to show.
			(details.taggerName !== '' || details.taggerEmail !== ''
				? strings.tagDetailsTagger + escapeHtml(details.taggerName) + ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(details.taggerEmail) + '" tabindex="-1">' + escapeHtml(details.taggerEmail) + '</a>&gt;' + (details.signature !== null ? generateSignatureHtml(details.signature) : '') + '<br>' +
				  strings.tagDetailsDate + formatLongDate(details.taggerDate) + '<br>'
				: '') +
			'<br>' +
			textFormatter.format(details.message) +
			'</span>'
		);
	}

	public renderRepoDropdownOptions(repo?: string) {
		this.repoDropdown.setOptions(getRepoDropdownOptions(this.gitRepos), [repo || this.currentRepo]);
	}


	/* Context Menu Generation */



	/**
	 * Build the "Fixup into HEAD" / "Squash into HEAD" commit context menu item.
	 * @param mode Fold the uncommitted changes into the commit preserving its Change-Id (fixup), or combining messages (squash).
	 * @param hash The hash of the commit to autosquash into.
	 * @param target The context menu's target.
	 */







	/* Actions */









	/* Table Utils */


	public getColumnVisibility() {
		let colWidths = this.gitRepos[this.currentRepo].columnWidths;
		if (colWidths !== null) {
			return { date: colWidths[1] !== COLUMN_HIDDEN, author: colWidths[2] !== COLUMN_HIDDEN, commit: colWidths[3] !== COLUMN_HIDDEN };
		} else {
			let defaults = this.config.defaultColumnVisibility;
			return { date: defaults.date, author: defaults.author, commit: defaults.commit };
		}
	}

	public getNumColumns() {
		let colVisibility = this.getColumnVisibility();
		return 2 + (colVisibility.date ? 1 : 0) + (colVisibility.author ? 1 : 0) + (colVisibility.commit ? 1 : 0);
	}

	/**
	 * Scroll the view to the previous or next stash.
	 * @param next TRUE => Jump to the next stash, FALSE => Jump to the previous stash.
	 */
	public scrollToStash(next: boolean) {
		const stashCommits = this.commits.filter((commit) => commit.stash !== null);
		if (stashCommits.length > 0) {
			const curTime = (new Date()).getTime();
			if (this.lastScrollToStash.time < curTime - 5000) {
				// Reset the lastScrollToStash hash if it was more than 5 seconds ago
				this.lastScrollToStash.hash = null;
			}

			const lastScrollToStashCommitIndex = this.lastScrollToStash.hash !== null
				? stashCommits.findIndex((commit) => commit.hash === this.lastScrollToStash.hash)
				: -1;
			let scrollToStashCommitIndex = lastScrollToStashCommitIndex + (next ? 1 : -1);
			if (scrollToStashCommitIndex >= stashCommits.length) {
				scrollToStashCommitIndex = 0;
			} else if (scrollToStashCommitIndex < 0) {
				scrollToStashCommitIndex = stashCommits.length - 1;
			}
			this.scrollToCommit(stashCommits[scrollToStashCommitIndex].hash, true, true);
			this.lastScrollToStash.time = curTime;
			this.lastScrollToStash.hash = stashCommits[scrollToStashCommitIndex].hash;
		}
	}

	/**
	 * Scroll the view to a commit (if it exists).
	 * @param hash The hash of the commit to scroll to.
	 * @param alwaysCenterCommit TRUE => Always scroll the view to be centered on the commit. FALSE => Don't scroll the view if the commit is already within the visible portion of commits.
	 * @param flash Should the commit flash after it has been scrolled to.
	 */
	public scrollToCommit(hash: string, alwaysCenterCommit: boolean, flash: boolean = false) {
		const id = this.getCommitId(hash);
		if (id === null) return;

		if (this.renderedRange !== null) {
			// Windowed rendering: the row's position derives from its index (uniform row heights),
			// then the window is re-rendered around the new scroll position so the row exists
			const elemTop = this.getRowTop(id);
			if (alwaysCenterCommit || elemTop - 8 < this.viewElem.scrollTop || elemTop + 32 - this.viewElem.clientHeight > this.viewElem.scrollTop) {
				this.viewElem.scroll(0, Math.max(0, elemTop + 12 - this.viewElem.clientHeight / 2));
			}
			this.updateVirtualWindow();
			const virtualElem = findCommitElemWithId(id);
			if (flash && virtualElem !== null && !virtualElem.classList.contains('flash')) {
				virtualElem.classList.add('flash');
				setTimeout(() => {
					virtualElem.classList.remove('flash');
				}, 850);
			}
			return;
		}

		const elem = findCommitElemWithId(id);
		if (elem === null) return;

		let elemTop = this.getHeaderHeight() + elem.offsetTop;
		if (alwaysCenterCommit || elemTop - 8 < this.viewElem.scrollTop || elemTop + 32 - this.viewElem.clientHeight > this.viewElem.scrollTop) {
			this.viewElem.scroll(0, this.getHeaderHeight() + elem.offsetTop + 12 - this.viewElem.clientHeight / 2);
		}

		if (flash && !elem.classList.contains('flash')) {
			elem.classList.add('flash');
			setTimeout(() => {
				elem.classList.remove('flash');
			}, 850);
		}
	}

	public loadMoreCommits() {
		this.footerElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + strings.loading + '</h2>';
		this.maxCommits += this.config.loadMoreCommits;
		this.saveState();
		this.requestLoadRepoInfoAndCommits(false, true);
	}

	/**
	 * Get the total height of the header rows (the main controls row + the Pinned row).
	 */
	public getHeaderHeight() {
		return this.controlsElem.clientHeight
			+ (this.pinnedControlsElem !== null && this.pinnedControlsElem.style.display !== 'none' ? this.pinnedControlsElem.clientHeight : 0);
	}


	/* Observers */


	/**
	 * Apply the automatic graph column layout, limiting the graph column width relative to the
	 * current view width. Called when the table is rendered, and when the view is resized while the
	 * graph column has an automatic width.
	 */







	/* Commit Details View */






	/* Commit Comparison View */





	/* Render Commit Details / Comparison View */






	/**
	 * Updates the state of a file in the Commit Details View.
	 * @param file The file that was affected.
	 * @param fileElem The HTML Element of the file.
	 * @param isReviewed TRUE/FALSE => Set the files reviewed state accordingly, NULL => Don't update the files reviewed state.
	 * @param fileWasViewed Was the file viewed - if so, set it to be the last viewed file.
	 */














	/* Code Review */
}


/* Main */

const contextMenu = new ContextMenu(), dialog = new Dialog(), eventOverlay = new EventOverlay();
let loaded = false;

window.addEventListener('load', () => {
	if (loaded) return;
	loaded = true;

	TextFormatter.registerCustomEmojiMappings(initialState.config.customEmojiShortcodeMappings);

	const viewElem = document.getElementById('view');
	if (viewElem === null) return;

	const gitGraph = new GitGraphView(viewElem, VSCODE_API.getState());
	const imageResizer = new ImageResizer();

	/* Command Processing */
	window.addEventListener('message', event => {
		const msg: GG.ResponseMessage = event.data;
		try {
			handleResponseMessage(msg);
		} catch (error) {
			// Isolate handler errors so that a malformed message cannot break the handling of
			// subsequent messages
			dialog.showError('Git Graph RS', formatStr(strings.unexpectedErrorHandlingMessage, String(error)), null, null);
		}
	});

	/**
	 * Handle a response message sent by the extension.
	 * @param msg The message that was received.
	 */
	function handleResponseMessage(msg: GG.ResponseMessage) {
		switch (msg.command) {
			case 'addRemote':
				refreshOrDisplayError(msg.error, strings.errAddRemote, true);
				break;
			case 'addTag':
				if (msg.pushToRemote !== null && msg.errors.length === 2 && msg.errors[0] === null && isExtensionErrorInfo(msg.errors[1], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
					gitGraph.refresh(false);
					handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.errors[1]!);
				} else {
					refreshAndDisplayErrors(msg.errors, strings.errAddTag);
				}
				break;
			case 'applyStash':
				refreshOrDisplayError(msg.error, strings.errApplyStash);
				break;
			case 'branchFromStash':
				refreshOrDisplayError(msg.error, strings.errBranchFromStash);
				break;
			case 'checkoutBranch':
				refreshAfterCheckout(msg.errors, msg.pullAfterwards !== null ? strings.errCheckoutBranchPull : strings.errCheckoutBranch);
				break;
			case 'checkoutCommit':
				refreshAfterCheckout([msg.error], strings.errCheckoutCommit);
				break;
			case 'cherrypickCommit':
				refreshAndDisplayErrors(msg.errors, strings.errCherryPick);
				break;
			case 'cleanUntrackedFiles':
				refreshOrDisplayError(msg.error, strings.errCleanUntracked);
				break;
			case 'commitDetails':
				if (msg.commitDetails !== null) {
					showCommitDetails(gitGraph, msg.commitDetails, createFileTree(gitGraph, msg.commitDetails.fileChanges, msg.codeReview), msg.avatar, msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
				} else {
					closeCommitDetails(gitGraph, true);
					dialog.showError(strings.errCommitDetails, msg.error, null, null);
				}
				break;
			case 'compareCommits':
				if (msg.error === null) {
					showCommitComparison(gitGraph, msg.commitHash, msg.compareWithHash, msg.fileChanges, createFileTree(gitGraph, msg.fileChanges, msg.codeReview), msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
				} else {
					closeCommitComparison(gitGraph, true);
					dialog.showError(strings.errCommitComparison, msg.error, null, null);
				}
				break;
			case 'copyFilePath':
				finishOrDisplayError(msg.error, strings.errCopyFilePath);
				break;
			case 'copyToClipboard':
				finishOrDisplayError(msg.error, formatStr(strings.errCopyToClipboard, msg.type));
				break;
			case 'createArchive':
				finishOrDisplayError(msg.error, strings.errCreateArchive, true);
				break;
			case 'createBranch':
				refreshAndDisplayErrors(msg.errors, strings.errCreateBranch);
				break;
			case 'createPullRequest':
				finishOrDisplayErrors(msg.errors, strings.errCreatePullRequest, () => {
					if (msg.push) {
						gitGraph.refresh(false);
					}
				}, true);
				break;
			case 'deleteBranch':
				handleResponseDeleteBranch(msg);
				break;
			case 'deleteRemote':
				refreshOrDisplayError(msg.error, strings.errDeleteRemote, true);
				break;
			case 'deleteRemoteBranch':
				refreshOrDisplayError(msg.error, strings.errDeleteRemoteBranch);
				break;
			case 'deleteTag':
				refreshOrDisplayError(msg.error, strings.errDeleteTag);
				break;
			case 'deleteUserDetails':
				finishOrDisplayErrors(msg.errors, strings.errDeleteUserDetails, () => gitGraph.requestLoadConfig(), true);
				break;
			case 'dropCommit':
				refreshOrDisplayError(msg.error, strings.errDropCommit);
				break;
			case 'dropStash':
				refreshOrDisplayError(msg.error, strings.errDropStash);
				break;
			case 'editRemote':
				refreshOrDisplayError(msg.error, strings.errEditRemote, true);
				break;
			case 'editUserDetails':
				finishOrDisplayErrors(msg.errors, strings.errEditUserDetails, () => gitGraph.requestLoadConfig(), true);
				break;
			case 'exportRepoConfig':
				refreshOrDisplayError(msg.error, strings.errExportRepoConfig);
				break;
			case 'fetch':
				refreshOrDisplayError(msg.error, strings.errFetch, false);
				break;
			case 'gerritSetFetchRefs':
				// The extension cleared its commit cache and (when disabling) deleted the local
				// change refs, so the reload below re-renders without the change commits and badges
				refreshOrDisplayError(msg.error, strings.errGerritSetFetchRefs, true);
				break;
			case 'fetchAvatar':
				imageResizer.resize(msg.image, (resizedImage) => {
					gitGraph.loadAvatar(msg.email, resizedImage);
				});
				break;
			case 'fetchIntoLocalBranch':
				refreshOrDisplayError(msg.error, strings.errFetchIntoLocalBranch);
				break;
			case 'commitBodies':
				gitGraph.processCommitBodies(msg);
				break;
			case 'commitFileCounts':
				applyLineCounts(gitGraph, msg);
				break;
			case 'lossWarning':
				// The standard data-loss warning: confirm re-sends the original request with its
				// confirmed flag set, so the action runs without asking again
				dialog.showDataLossWarning(msg.message, () => sendMessage(msg.retry));
				break;
			case 'countCommitsBefore':
				gitGraph.processCountCommitsBefore(msg);
				break;
			case 'loadCommits':
				gitGraph.processLoadCommitsResponse(msg);
				break;
			case 'loadConfig':
				gitGraph.processLoadConfig(msg);
				break;
			case 'loadRepoInfo':
				gitGraph.processLoadRepoInfoResponse(msg);
				break;
			case 'loadRepos':
				gitGraph.loadRepos(msg.repos, msg.lastActiveRepo, msg.loadViewTo);
				break;
			case 'pullRequestStatus':
				gitGraph.processPullRequestStatus(msg);
				break;
			case 'setInterfaceLanguage':
				finishOrDisplayError(msg.error, strings.settingsUnableToSaveLanguage);
				break;
			case 'setGlobalSetting':
				finishOrDisplayError(msg.error, strings.settingsUnableToSaveSetting);
				break;
			case 'merge':
				refreshOrDisplayError(msg.error, formatStr(strings.errMergeActionOn, getMergeActionOnName(msg.actionOn)));
				break;
			case 'openExtensionSettings':
				finishOrDisplayError(msg.error, strings.errOpenExtensionSettings);
				break;
			case 'openLogFile':
				finishOrDisplayError(msg.error, strings.errOpenLogFile);
				break;
			case 'openExternalDirDiff':
				finishOrDisplayError(msg.error, strings.errOpenExternalDirDiff, true);
				break;
			case 'openExternalUrl':
				finishOrDisplayError(msg.error, strings.errOpenExternalUrl);
				break;
			case 'openFile':
				finishOrDisplayError(msg.error, strings.errOpenFile);
				break;
			case 'openTerminal':
				finishOrDisplayError(msg.error, strings.errOpenTerminal, true);
				break;
			case 'popStash':
				refreshOrDisplayError(msg.error, strings.errPopStash);
				break;
			case 'pruneRemote':
				refreshOrDisplayError(msg.error, strings.errPruneRemote);
				break;
			case 'pullBranch':
				refreshOrDisplayError(msg.error, strings.errPullBranch);
				break;
			case 'pushBranch':
				refreshAndDisplayErrors(msg.errors, strings.errPushBranch, msg.willUpdateBranchConfig);
				break;
			case 'pushStash':
				refreshOrDisplayError(msg.error, strings.errPushStash);
				break;
			case 'pushTag':
				if (msg.errors.length === 1 && isExtensionErrorInfo(msg.errors[0], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
					handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.errors[0]!);
				} else {
					refreshAndDisplayErrors(msg.errors, strings.errPushTag);
				}
				break;
			case 'rebase':
				if (msg.error === null) {
					if (msg.interactive) {
						dialog.closeActionRunning();
					} else {
						gitGraph.refresh(false);
					}
				} else {
					dialog.showError(formatStr(strings.errRebaseActionOn, getRebaseActionOnName(msg.actionOn)), msg.error, null, null);
				}
				break;
			case 'refresh':
				gitGraph.refresh(false);
				break;
			case 'renameBranch':
				refreshOrDisplayError(msg.error, strings.errRenameBranch);
				break;
			case 'resetFileToRevision':
				refreshOrDisplayError(msg.error, strings.errResetFileToRevision);
				break;
			case 'resetToCommit':
				refreshOrDisplayError(msg.error, strings.errResetToCommit);
				break;
			case 'undoLastCommit':
				refreshOrDisplayError(msg.error, strings.errResetLastCommit);
				break;

			case 'revertCommit':
				refreshOrDisplayError(msg.error, strings.errRevertCommit);
				break;
			case 'editCommitMessage':
				refreshOrDisplayError(msg.error, strings.errEditCommitMessage);
				break;

			case 'setGlobalViewState':
				finishOrDisplayError(msg.error, strings.errSaveGlobalViewState);
				break;
			case 'setWorkspaceViewState':
				finishOrDisplayError(msg.error, strings.errSaveWorkspaceViewState);
				break;
			case 'startCodeReview':
				if (msg.error === null) {
					startCodeReview(gitGraph, msg.commitHash, msg.compareWithHash, msg.codeReview);
				} else {
					dialog.showError(strings.errStartCodeReview, msg.error, null, null);
				}
				break;
			case 'tagDetails':
				if (msg.details !== null) {
					gitGraph.renderTagDetails(msg.tagName, msg.commitHash, msg.details);
				} else {
					dialog.showError(strings.errTagDetails, msg.error, null, null);
				}
				break;
			case 'updateCodeReview':
				if (msg.error !== null) {
					dialog.showError(strings.errUpdateCodeReview, msg.error, null, null);
				}
				break;
			case 'viewDiff':
				finishOrDisplayError(msg.error, strings.errViewDiff);
				break;
			case 'viewDiffWithWorkingFile':
				finishOrDisplayError(msg.error, strings.errViewDiffWithWorkingFile);
				break;
			case 'viewFileAtRevision':
				finishOrDisplayError(msg.error, strings.errViewFileAtRevision);
				break;
			case 'viewScm':
				finishOrDisplayError(msg.error, strings.errViewScm);
				break;
		}
	}

	function handleResponseDeleteBranch(msg: GG.ResponseDeleteBranch) {
		if (msg.errors.length > 0 && msg.errors[0] !== null && msg.errors[0].includes('git branch -D')) {
			dialog.showConfirmation(formatStr(strings.branchNotFullyMerged, escapeHtml(msg.branchName)), strings.yesForceDeleteBranch, () => {
				runAction({ command: 'deleteBranch', repo: msg.repo, branchName: msg.branchName, forceDelete: true, deleteOnRemotes: msg.deleteOnRemotes }, strings.deletingBranch);
			}, { type: TargetType.Repo });
		} else {
			refreshAndDisplayErrors(msg.errors, strings.errDeleteBranch);
		}
	}

	function handleResponsePushTagCommitNotOnRemote(repo: string, tagName: string, remotes: string[], commitHash: string, error: string) {
		const remotesNotContainingCommit: string[] = parseExtensionErrorInfo(error, GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote);
		const plural = remotesNotContainingCommit.length > 1;

		const html = '<span class="dialogAlert">' + SVG_ICONS.alert + (plural ? strings.warnCommitNotOnRemotes : strings.warnCommitNotOnRemote) + '</span><br>' +
			'<span class="messageContent">' +
			'<p style="margin:0 0 6px 0;">' + formatStr(plural ? strings.tagCommitNotOnRemotePlural : strings.tagCommitNotOnRemoteSingular, escapeHtml(tagName), formatCommaSeparatedList(remotesNotContainingCommit.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>'))) + '</p>' +
			'<p style="margin:0;">' + formatStr(remotes.length > 1 ? strings.proceedPushTagPlural : strings.proceedPushTagSingular, formatCommaSeparatedList(remotes.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>'))) + '</p>' +
			'</span>';

		dialog.showForm(html, [{ type: DialogInputType.Checkbox, name: strings.alwaysProceedCheckbox, value: false }], strings.proceedToPushAction, (values) => {
			if (<boolean>values[0]) {
				updateGlobalViewState('pushTagSkipRemoteCheck', true);
			}
			runAction({
				command: 'pushTag',
				repo: repo,
				tagName: tagName,
				remotes: remotes,
				commitHash: commitHash,
				skipRemoteCheck: true
			}, strings.pushingTag);
		}, { type: TargetType.Repo }, strings.dialogCancel, null, true);
	}

	function refreshOrDisplayError(error: GG.ErrorInfo, errorMessage: string, configChanges: boolean = false) {
		if (error === null) {
			gitGraph.refresh(false, configChanges);
		} else {
			dialog.showError(errorMessage, error, null, null);
		}
	}

	function refreshAndDisplayErrors(errors: GG.ErrorInfo[], errorMessage: string, configChanges: boolean = false) {
		const reducedErrors = reduceErrorInfos(errors);
		if (reducedErrors.error !== null) {
			dialog.showError(errorMessage, reducedErrors.error, null, null);
		}
		if (reducedErrors.partialOrCompleteSuccess) {
			gitGraph.refresh(false, configChanges);
		} else if (configChanges) {
			gitGraph.requestLoadConfig();
		}
	}

	/**
	 * A checkout moved HEAD, so the current-position marker must follow immediately. The refresh is
	 * SOFT on purpose: the rendered table stays on screen (no loading state) while fresh data is
	 * fetched in the background — the extension drops its commit cache when the checkout command
	 * completes, so the reloaded data is always post-checkout, and the changed HEAD defeats the
	 * unchanged-commit-list render dedupe, re-rendering in place once the data arrives.
	 */
	function refreshAfterCheckout(errors: GG.ErrorInfo[], errorMessage: string) {
		const reducedErrors = reduceErrorInfos(errors);
		if (reducedErrors.error !== null) {
			dialog.showError(errorMessage, reducedErrors.error, null, null);
		}
		if (reducedErrors.partialOrCompleteSuccess) {
			gitGraph.refresh(false);
		}
	}

	function finishOrDisplayError(error: GG.ErrorInfo, errorMessage: string, dismissActionRunning: boolean = false) {
		if (error !== null) {
			dialog.showError(errorMessage, error, null, null);
		} else if (dismissActionRunning) {
			dialog.closeActionRunning();
		}
	}

	function finishOrDisplayErrors(errors: GG.ErrorInfo[], errorMessage: string, partialOrCompleteSuccessCallback: () => void, dismissActionRunning: boolean = false) {
		const reducedErrors = reduceErrorInfos(errors);
		finishOrDisplayError(reducedErrors.error, errorMessage, dismissActionRunning);
		if (reducedErrors.partialOrCompleteSuccess) {
			partialOrCompleteSuccessCallback();
		}
	}

	function reduceErrorInfos(errors: GG.ErrorInfo[]) {
		let error: GG.ErrorInfo = null, partialOrCompleteSuccess = false;
		for (let i = 0; i < errors.length; i++) {
			if (errors[i] !== null) {
				error = error !== null ? error + '\n\n' + errors[i] : errors[i];
			} else {
				partialOrCompleteSuccess = true;
			}
		}

		return {
			error: error,
			partialOrCompleteSuccess: partialOrCompleteSuccess
		};
	}

	/**
	 * Checks whether the given ErrorInfo has an ErrorInfoExtensionPrefix.
	 * @param error The ErrorInfo to check.
	 * @param prefix The ErrorInfoExtensionPrefix to test.
	 * @returns TRUE => ErrorInfo has the ErrorInfoExtensionPrefix, FALSE => ErrorInfo doesn\'t have the ErrorInfoExtensionPrefix
	 */
	function isExtensionErrorInfo(error: GG.ErrorInfo, prefix: GG.ErrorInfoExtensionPrefix) {
		return error !== null && error.startsWith(prefix);
	}

	/**
	 * Parses the JSON data from an ErrorInfo prefixed by the provided ErrorInfoExtensionPrefix.
	 * @param error The ErrorInfo to parse.
	 * @param prefix The ErrorInfoExtensionPrefix used by `error`.
	 * @returns The parsed JSON data.
	 */
	function parseExtensionErrorInfo(error: string, prefix: GG.ErrorInfoExtensionPrefix) {
		return JSON.parse(error.substring(prefix.length));
	}
});




/* Miscellaneous Helper Methods */


function abbrevCommit(commitHash: string) {
	return commitHash.substring(0, 8);
}


function getRepoDropdownOptions(repos: Readonly<GG.GitRepoSet>) {
	const repoPaths = getSortedRepositoryPaths(repos, initialState.config.repoDropdownOrder);
	const paths: string[] = [], names: string[] = [], distinctNames: string[] = [], firstSep: number[] = [];
	const resolveAmbiguous = (indexes: number[]) => {
		// Find ambiguous names within indexes
		let firstOccurrence: { [name: string]: number } = {}, ambiguous: { [name: string]: number[] } = {};
		for (let i = 0; i < indexes.length; i++) {
			let name = distinctNames[indexes[i]];
			if (typeof firstOccurrence[name] === 'number') {
				// name is ambiguous
				if (typeof ambiguous[name] === 'undefined') {
					// initialise ambiguous array with the first occurrence
					ambiguous[name] = [firstOccurrence[name]];
				}
				ambiguous[name].push(indexes[i]); // append current ambiguous index
			} else {
				firstOccurrence[name] = indexes[i]; // set the first occurrence of the name
			}
		}

		let ambiguousNames = Object.keys(ambiguous);
		for (let i = 0; i < ambiguousNames.length; i++) {
			// For each ambiguous name, resolve the ambiguous indexes
			let ambiguousIndexes = ambiguous[ambiguousNames[i]], retestIndexes = [];
			for (let j = 0; j < ambiguousIndexes.length; j++) {
				let ambiguousIndex = ambiguousIndexes[j];
				let nextSep = paths[ambiguousIndex].lastIndexOf('/', paths[ambiguousIndex].length - distinctNames[ambiguousIndex].length - 2);
				if (firstSep[ambiguousIndex] < nextSep) {
					// prepend the addition path and retest
					distinctNames[ambiguousIndex] = paths[ambiguousIndex].substring(nextSep + 1);
					retestIndexes.push(ambiguousIndex);
				} else {
					distinctNames[ambiguousIndex] = paths[ambiguousIndex];
				}
			}
			if (retestIndexes.length > 1) {
				// If there are 2 or more indexes that may be ambiguous
				resolveAmbiguous(retestIndexes);
			}
		}
	};

	// Initialise recursion
	const indexes = [];
	for (let i = 0; i < repoPaths.length; i++) {
		firstSep.push(repoPaths[i].indexOf('/'));
		const repo = repos[repoPaths[i]];
		if (repo.name) {
			// A name has been set for the repository
			paths.push(repoPaths[i]);
			names.push(repo.name);
			distinctNames.push(repo.name);
		} else if (firstSep[i] === repoPaths[i].length - 1 || firstSep[i] === -1) {
			// Path has no slashes, or a single trailing slash ==> use the path as the name
			paths.push(repoPaths[i]);
			names.push(repoPaths[i]);
			distinctNames.push(repoPaths[i]);
		} else {
			paths.push(repoPaths[i].endsWith('/') ? repoPaths[i].substring(0, repoPaths[i].length - 1) : repoPaths[i]); // Remove trailing slash if it exists
			let name = paths[i].substring(paths[i].lastIndexOf('/') + 1);
			names.push(name);
			distinctNames.push(name);
			indexes.push(i);
		}
	}
	resolveAmbiguous(indexes);

	const options: DropdownOption[] = [];
	for (let i = 0; i < repoPaths.length; i++) {
		let hint;
		if (names[i] === distinctNames[i]) {
			// Name is distinct, no hint needed
			hint = '';
		} else {
			// Hint path is the prefix of the distinctName before the common suffix with name
			let hintPath = distinctNames[i].substring(0, distinctNames[i].length - names[i].length - 1);

			// Keep two informative directories
			let hintComps = hintPath.split('/');
			let keepDirs = hintComps[0] !== '' ? 2 : 3;
			if (hintComps.length > keepDirs) hintComps.splice(keepDirs, hintComps.length - keepDirs, '...');

			// Construct the hint
			hint = (distinctNames[i] !== paths[i] ? '.../' : '') + hintComps.join('/');
		}
		options.push({ name: names[i], value: repoPaths[i], hint: hint });
	}
	return options;
}

/**
 * Assess whether an action can cause the user to lose data, and if so describe the risk.
 * Covers every write operation performed via runAction, so operations that bypass the
 * per-action confirmation dialogs are still guarded.
 * @param msg The request message describing the action that is about to be performed.
 * @returns The HTML describing the data loss risk, or null if the action cannot lose data.
 */
function getDataLossRisk(msg: GG.RequestMessage): string | null {
	switch (msg.command) {
		case 'resetToCommit':
			return msg.resetMode === GG.GitResetMode.Hard ? strings.riskResetHard : null;
		case 'cleanUntrackedFiles':
			return (msg.directories ? strings.riskCleanUntrackedDirectories : strings.riskCleanUntrackedFiles) + ' ' + strings.riskCleanUntrackedSuffix;
		case 'deleteBranch': {
			const risks: string[] = [];
			if (msg.forceDelete) risks.push(formatStr(strings.riskDeleteBranchForce, escapeHtml(msg.branchName)));
			if (msg.deleteOnRemotes.length > 0) risks.push(formatStr(strings.riskDeleteBranchRemote, escapeHtml(formatCommaSeparatedList(msg.deleteOnRemotes.map((remote) => '"' + remote + '"')))));
			return risks.length > 0 ? risks.join('<br>') : null;
		}
		case 'deleteRemoteBranch':
			return formatStr(strings.riskDeleteRemoteBranch, escapeHtml(msg.remote + '/' + msg.branchName));
		case 'pushBranch': {
			const target = escapeHtml(formatCommaSeparatedList(msg.remotes.map((remote) => remote + '/' + msg.branchName)));
			return msg.mode === GG.GitPushBranchMode.Force
				? formatStr(strings.riskPushForce, target)
				: msg.mode === GG.GitPushBranchMode.ForceWithLease
					? formatStr(strings.riskPushForceWithLease, target)
					: null;
		}
		case 'fetchIntoLocalBranch':
			return msg.force ? formatStr(strings.riskFetchIntoLocalBranchForce, escapeHtml(msg.localBranch)) : null;
		case 'dropCommit':
			return strings.riskDropCommit;
		case 'dropStash':
			return strings.riskDropStash;
		case 'resetFileToRevision':
			return formatStr(strings.riskResetFile, escapeHtml(msg.filePath));
		default:
			return null;
	}
}

function runAction(msg: GG.RequestMessage, action: string) {
	const risk = getDataLossRisk(msg);
	if (risk !== null) {
		dialog.showDataLossWarning(risk, () => {
			dialog.showActionRunning(action);
			sendMessage(msg);
		});
		return;
	}
	dialog.showActionRunning(action);
	sendMessage(msg);
}

function getBranchLabels(heads: ReadonlyArray<string>, remotes: ReadonlyArray<GG.GitCommitRemote>) {
	let headLabels: { name: string; remotes: string[] }[] = [], headLookup: { [name: string]: number } = {}, remoteLabels: ReadonlyArray<GG.GitCommitRemote>;
	for (let i = 0; i < heads.length; i++) {
		headLabels.push({ name: heads[i], remotes: [] });
		headLookup[heads[i]] = i;
	}
	if (initialState.config.referenceLabels.combineLocalAndRemoteBranchLabels) {
		let remainingRemoteLabels = [];
		for (let i = 0; i < remotes.length; i++) {
			if (remotes[i].remote !== null) { // If the remote of the remote branch ref is known
				let branchName = remotes[i].name.substring(remotes[i].remote!.length + 1);
				if (typeof headLookup[branchName] === 'number') {
					headLabels[headLookup[branchName]].remotes.push(remotes[i].remote!);
					continue;
				}
			}
			remainingRemoteLabels.push(remotes[i]);
		}
		remoteLabels = remainingRemoteLabels;
	} else {
		remoteLabels = remotes;
	}
	return { heads: headLabels, remotes: remoteLabels };
}

function findCommitElemWithId(id: number | null) {
	if (id === null) return null;
	// Use an attribute selector (backed by the browser's query engine) instead of scanning every
	// commit row: with many loaded commits this lookup runs on every vertex hover / interaction
	return document.querySelector('tr.commit[data-id="' + id.toString() + '"]') as HTMLElement | null;
}

function generateSignatureHtml(signature: GG.GitSignature) {
	const status: GG.GitSignatureStatus = signature.status;
	return '<span class="signatureInfo ' + status + '" title="' + getGitSignatureStatusDescription(status) + strings.signatureDescColon
		+ strings.signatureSignedBy + escapeHtml(signature.signer !== '' ? signature.signer : strings.signatureUnknown)
		+ strings.signatureGpgKeyIdPrefix + escapeHtml(signature.key !== '' ? signature.key : strings.signatureUnknown) + strings.signatureGpgKeyIdSuffix + '">'
		+ (status === GG.GitSignatureStatus.GoodAndValid
			? SVG_ICONS.passed
			: status === GG.GitSignatureStatus.Bad
				? SVG_ICONS.failed
				: SVG_ICONS.inconclusive)
		+ '</span>';
}

function closeDialogAndContextMenu() {
	if (dialog.isOpen()) dialog.close();
	if (contextMenu.isOpen()) contextMenu.close();
}

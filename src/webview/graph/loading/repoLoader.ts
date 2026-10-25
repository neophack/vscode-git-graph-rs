/**
 * Loading the data of the view: the repositories, the current repository's refs (loadRepoInfo),
 * commits (loadCommits) and configuration (loadConfig), the refresh cycle that sequences them,
 * the requests that bring in avatars and pull requests, and applying a changed Extension
 * Configuration to the running view.
 *
 * A refresh runs `loadRepoInfo` → `loadCommits` (→ `loadConfig`); the extension may answer a
 * `loadCommits` request with several responses carrying the same refresh id (the staged delivery:
 * remote refs, Gerrit, "Uncommitted Changes"), which is why the refresh id alone - not the
 * in-progress flag - identifies whether a response belongs to the current view state.
 */

import { alterClass } from '../../common/dom';
import { html, setHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { arraysEqual, arraysStrictlyEqual, getSortedRepositoryPaths, SHOW_ALL_BRANCHES, UNCOMMITTED } from '../../common/util';
import { fetchFromRemotesAction } from '../actions/dialogActions';
import { getRepoDropdownOptions } from '../controlBar/controlBar';
import { GraphContext } from '../context';
import { gerritStatesEqual, refreshGerritReviewDialog } from '../integrations/gerrit';
import { pullRequestMapsEqual } from '../integrations/pullRequests';
import {
	getIncludeCommitsMentionedByReflogs, getCommitOrdering, getOnlyFollowFirstParent, getOnRepoLoadShowCheckedOutBranch,
	getOnRepoLoadShowSpecificBranches, getShowRemoteBranches, getShowStashes, getShowTags
} from '../state/repoSettings';
import { WebViewState } from '../state/types';

const CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH = 'branchLabelsAlignedToGraph';
const CLASS_TAG_LABELS_RIGHT_ALIGNED = 'tagLabelsRightAligned';

export class RepoLoader {
	private pendingScrollCommitHash: string | null = null;
	// TRUE between sending a countCommitsBefore request and its response: the response (not
	// checkPendingScrollCommit) decides how the pending scroll commit is loaded, so the checks run
	// on intervening loadCommits responses must not error out or start paging on their own
	private countCommitsBeforePending: boolean = false;
	/** The debounce timer of the background reload triggered by a Gerrit status filter change. */
	private gerritFilterRefreshTimer: number | null = null;
	/** The repositories whose pull requests were already requested (one request per repository). */
	private readonly prStatusRepos: Set<string> = new Set();
	/**
	 * TRUE while the boot awaits the host's pushed `loadView` (the open path of task 4.7): the
	 * repository switch the boot performs must not start the request chain — the data is already
	 * in flight on the host side and arrives pushed.
	 */
	private bootPushExpected: boolean = false;

	constructor(private readonly ctx: () => GraphContext) { }


	/* Start-up */

	/**
	 * Load the first repository: restore what a webview reload keeps (the previous repository and
	 * its scroll position), and wait for the pushed data.
	 *
	 * The open path is push-based (REFACTOR-PLAN task 4.7): the extension host began the merged
	 * `loadView` read when the panel was created and pushes the result as soon as the page
	 * reports `ready` — which main.ts sends once this loader is composed. The boot sends NO
	 * loadRepoInfo/loadCommits requests; the loading state shows until the push arrives.
	 * @param prevState The state VS Code persisted for this webview (or the snapshot of a page left behind by an Extension Host restart).
	 * @param lastActiveRepo The repository that was last active.
	 * @param initialLoadViewTo Where the extension asked the view to load to.
	 */
	public start(prevState: WebViewState | null, lastActiveRepo: string | null, initialLoadViewTo: GG.LoadGitGraphViewTo) {
		const ctx = this.ctx(), store = ctx.store;
		let loadViewTo = initialLoadViewTo;
		if (loadViewTo === null && prevState && typeof prevState.currentRepo !== 'undefined') {
			// Reload the previously open repository after a webview reload, re-applying its path filter
			loadViewTo = prevState.commitPathFilter !== null && prevState.commitPathFilter !== undefined
				? { repo: prevState.currentRepo, filterPath: prevState.commitPathFilter }
				: { repo: prevState.currentRepo };
			// Restore the scroll position after the repository's commits have been rendered (the view
			// is still empty at this point, so scrolling immediately would be clamped to 0)
			store.scrollTop = prevState.scrollTop;
			ctx.viewport.restoreScrollTop = prevState.scrollTop;
		}

		this.bootPushExpected = true;
		this.loadRepos(store.repos, lastActiveRepo, loadViewTo);

		// The pushed response finalises through the same response processing as a refresh's; the
		// refresh state itself stays idle (the push is host-initiated, not a request cycle), and
		// the loading skeleton shows until the pushed commits arrive.
		store.refreshState.hard = false;
		if (store.commits.length === 0) {
			ctx.table.showLoadingSkeleton();
		}

		if (prevState && prevState.compareSourceHash !== null && prevState.compareSourceHash !== undefined
			&& prevState.currentRepo === store.currentRepo) {
			// Restore the "Select for Compare" selection after a webview reload, so it survives
			// switching away from the panel and back (loadRepo clears it when the repo changes)
			store.compareSourceHash = prevState.compareSourceHash;
			ctx.persistence.saveState();
		}
	}


	/* Loading Data */

	/**
	 * Set the repositories of the view and load one of them (a `loadRepos` response).
	 * @returns TRUE => a repository switch was started (it requests the data itself), FALSE => the caller must request the data.
	 */
	public loadRepos(repos: GG.GitRepoSet, lastActiveRepo: string | null, loadViewTo: GG.LoadGitGraphViewTo) {
		const ctx = this.ctx(), store = ctx.store;
		store.repos = repos;
		ctx.persistence.saveState();

		let newRepo: string;
		if (loadViewTo !== null && store.currentRepo !== loadViewTo.repo && typeof repos[loadViewTo.repo] !== 'undefined') {
			newRepo = loadViewTo.repo;
		} else if (typeof repos[store.currentRepo] === 'undefined') {
			newRepo = lastActiveRepo !== null && typeof repos[lastActiveRepo] !== 'undefined'
				? lastActiveRepo
				: getSortedRepositoryPaths(repos, store.config.repoDropdownOrder)[0];
		} else {
			newRepo = store.currentRepo;
		}

		alterClass(ctx.dom.controls, 'singleRepo', Object.keys(repos).length === 1);
		ctx.controls.renderRepoDropdownOptions(newRepo);

		if (loadViewTo !== null) {
			if (loadViewTo.repo === newRepo) {
				store.loadViewTo = loadViewTo;
			} else {
				store.loadViewTo = null;
				ctx.bridge.send({ command: 'showErrorMessage', message: formatStr(strings.unableToLoadRepo, loadViewTo.repo) });
			}
		} else {
			store.loadViewTo = null;
		}

		let filterChanged = false;
		if (loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.filterPath === 'string') {
			// Apply the file path filter the view was requested to be loaded with
			const newFilter = loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null;
			filterChanged = newFilter !== store.commitPathFilter;
		}

		if (store.currentRepo !== newRepo) {
			this.loadRepo(newRepo);
			// loadRepo resets the path filter, so re-apply it before the commits are requested
			if (loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.filterPath === 'string') {
				store.commitPathFilter = loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null;
				ctx.controls.renderFilterButton();
			}
			return true;
		} else if (filterChanged) {
			// The repository is already loaded, but the path filter changed: reload the commits
			store.commitPathFilter = loadViewTo !== null && typeof loadViewTo.filterPath === 'string' && loadViewTo.filterPath !== '' ? loadViewTo.filterPath : null;
			ctx.controls.renderFilterButton();
			ctx.dom.view.scrollTop = 0;
			this.finishRepoSwitchOrRefresh(false);
			return false;
		} else {
			this.finaliseRepoLoad(false);
			return false;
		}
	}

	/** Switch the view to a repository. */
	public loadRepo(repo: string) {
		const ctx = this.ctx(), store = ctx.store;
		// Only a switch between known repositories closes the widgets: on the very first load
		// (no repository yet) the settings widget holds the state restored for this webview
		// reload — closing it here would undo that restore before the first paint, making the
		// persisted settings-widget state dead.
		const switchingRepo = store.hasCurrentRepo() && store.currentRepo !== repo;
		store.currentRepo = repo;
		store.currentRepoLoading = true;
		// A repository switch/reload wants its own start position (the webview-reload path restores
		// via restoreScrollTop): a pre-collapse anchor belonging to the previous repository must
		// not leak into the first render of the new one
		ctx.viewport.pendingViewportAnchor = null;
		ctx.controls.syncShowRemoteBranches();
		store.maxCommits = store.config.initialLoadCommits;
		store.gitConfig = null;
		store.gitRemotes = [];
		store.gitStashes = [];
		store.gitTags = [];
		store.currentBranches = null;
		store.currentAuthors = null;
		store.commitPathFilter = null;
		store.compareSourceHash = null;
		// The pull requests of the previous repository don't apply to the new one: drop them and
		// forget which repositories were already requested, so switching back re-requests them
		// (otherwise the badges would never come back after the switch cleared them)
		store.pullRequestsByHead = {};
		this.prStatusRepos.clear();
		ctx.controls.renderFetchButton();
		ctx.controls.renderFilterButton();
		ctx.details.close(false);
		if (switchingRepo) ctx.widgets.settings.close();
		ctx.widgets.reflog.close();
		ctx.widgets.worktree.close();
		ctx.widgets.statistics.close();
		ctx.persistence.saveState();
		this.finishRepoSwitchOrRefresh(true);
	}

	/**
	 * The trailing data load of a repository switch (or of a same-repo reload): the boot path
	 * skips it — the data is already in flight on the host side and arrives with the pushed
	 * `loadView` — while every later switch refreshes as before.
	 */
	private finishRepoSwitchOrRefresh(hard: boolean) {
		if (this.bootPushExpected) {
			this.bootPushExpected = false;
			return;
		}
		this.refresh(hard);
	}

	private loadRepoInfo(branchOptions: ReadonlyArray<string>, branchHead: string | null, remotes: ReadonlyArray<string>, stashes: ReadonlyArray<GG.GitStash>, isRepo: boolean, remoteRefsPending: boolean = false) {
		const ctx = this.ctx(), store = ctx.store;
		// Changes to store.gitStashes are reflected as changes to the commits when loadCommits is run
		store.gitStashes = stashes;

		if (!isRepo || (!store.refreshState.hard && arraysStrictlyEqual(store.gitBranches, branchOptions) && store.gitBranchHead === branchHead && arraysStrictlyEqual(store.gitRemotes, remotes))) {
			ctx.persistence.saveState();
			this.finaliseLoadRepoInfo(false, isRepo);
			return;
		}

		// Changes to these properties must be indicated as a repository info change
		store.gitBranches = branchOptions;
		store.gitBranchHead = branchHead;
		store.gitRemotes = remotes;

		// Update the state of the fetch button
		ctx.controls.renderFetchButton();

		// While the remote-tracking refs are still being scanned, a `remotes/...` name cannot be
		// validated against the (local-only) branch list — such selections and configured branches
		// are kept until the complete list arrives with a loadCommits response.
		const keepRemoteSelections = (branch: string) => remoteRefsPending && branch.startsWith('remotes/');
		const filterCurrentBranches = () => {
			// Configure current branches
			if (store.currentBranches !== null && !(store.currentBranches.length === 1 && store.currentBranches[0] === SHOW_ALL_BRANCHES)) {
				// Filter any branches that are currently selected, but no longer exist
				const globPatterns = store.getBranchGlobPatterns();
				store.currentBranches = store.currentBranches.filter((branch) =>
					store.gitBranches.includes(branch) || globPatterns.includes(branch) || branch === 'HEAD' || keepRemoteSelections(branch)
				);
			}
		};

		filterCurrentBranches();
		if (store.currentBranches === null || store.currentBranches.length === 0) {
			// No branches are currently selected
			const onRepoLoadShowCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(store.repoState.onRepoLoadShowCheckedOutBranch, store.config);
			const onRepoLoadShowSpecificBranches = getOnRepoLoadShowSpecificBranches(store.repoState.onRepoLoadShowSpecificBranches, store.config);
			store.currentBranches = [];
			if (onRepoLoadShowSpecificBranches.length > 0) {
				// Show specific branches if they exist in the repository
				const globPatterns = store.getBranchGlobPatterns();
				store.currentBranches.push(...onRepoLoadShowSpecificBranches.filter((branch) =>
					store.gitBranches.includes(branch) || globPatterns.includes(branch) || keepRemoteSelections(branch)
				));
			}
			if (onRepoLoadShowCheckedOutBranch && store.gitBranchHead !== null && !store.currentBranches.includes(store.gitBranchHead)) {
				// Show the checked-out branch, and it hasn't already been added as a specific branch
				store.currentBranches.push(store.gitBranchHead);
			}
			if (store.currentBranches.length === 0) {
				store.currentBranches.push(SHOW_ALL_BRANCHES);
			}
		}
		filterCurrentBranches();

		ctx.persistence.saveState();
		if (store.currentAuthors === null || store.currentAuthors.length === 0) {
			store.currentAuthors = [SHOW_ALL_BRANCHES];
		}

		// Set up branch dropdown options
		ctx.controls.branchDropdown.setOptions(store.getBranchOptions(true), store.currentBranches);
		ctx.controls.authorDropdown.setOptions(store.getAuthorOptions(), store.currentAuthors);

		// Remove hidden remotes that no longer exist
		const hiddenRemotes = store.repoState.hideRemotes;
		const hideRemotes = hiddenRemotes.filter((hiddenRemote: string) => remotes.includes(hiddenRemote));
		if (hiddenRemotes.length !== hideRemotes.length) {
			ctx.persistence.saveRepoStateValue(store.currentRepo, 'hideRemotes', hideRemotes);
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
		const ctx = this.ctx(), store = ctx.store;
		if (arraysStrictlyEqual(store.gitBranches, branchOptions)) return;
		store.gitBranches = branchOptions;
		let selectionReset = false;
		if (store.currentBranches !== null && !(store.currentBranches.length === 1 && store.currentBranches[0] === SHOW_ALL_BRANCHES)) {
			const globPatterns = store.getBranchGlobPatterns();
			store.currentBranches = store.currentBranches.filter((branch) =>
				store.gitBranches.includes(branch) || globPatterns.includes(branch) || branch === 'HEAD'
			);
			if (store.currentBranches.length === 0) {
				store.currentBranches = [SHOW_ALL_BRANCHES];
				selectionReset = true;
			}
		}
		ctx.controls.branchDropdown.setOptions(store.getBranchOptions(true), store.currentBranches);
		ctx.persistence.saveState();
		if (selectionReset) {
			// The commits of this response were loaded with the now-dropped selection: reload so the
			// graph matches the "Show All Branches" the dropdown now shows.
			this.requestLoadRepoInfoAndCommits(false, true);
		}
	}

	private finaliseLoadRepoInfo(repoInfoChanges: boolean, isRepo: boolean) {
		const ctx = this.ctx(), store = ctx.store, refreshState = store.refreshState;
		if (refreshState.inProgress) {
			if (isRepo) {
				refreshState.repoInfoChanges = refreshState.repoInfoChanges || repoInfoChanges;
				refreshState.requestingRepoInfo = false;
				this.requestLoadCommits();
			} else {
				ctx.dialog.closeActionRunning();
				refreshState.inProgress = false;
				store.loadViewTo = null;
				ctx.controls.renderRefreshButton();
				ctx.bridge.send({ command: 'loadRepos', check: true });
			}
		}
	}

	private loadCommits(commits: GG.GitCommit[], commitHead: string | null, tags: ReadonlyArray<string>, moreAvailable: boolean, onlyFollowFirstParent: boolean, uncommittedPending: boolean = false) {
		const ctx = this.ctx(), store = ctx.store, viewport = ctx.viewport;
		// This list of tags is just used to provide additional information in the dialogs. Tag information included in commits is used for all other purposes (e.g. rendering, context menus)
		const tagsChanged = !arraysStrictlyEqual(store.gitTags, tags);
		store.gitTags = tags;

		if (uncommittedPending && commits.length > 0 && commits[0].hash !== UNCOMMITTED && commitHead !== null
			&& store.uncommittedCount !== null && store.uncommittedCount > 0) {
			// Deferred response: the "Uncommitted Changes" status arrives in a follow-up response.
			// Keep the row rendered so it never flickers away and back on a refresh - the follow-up
			// just updates its number in place. The row is reused when it is already rendered, and
			// synthesized from the last known count otherwise: any response of the load pipeline
			// (initial, remote refs, Gerrit stages) carries a list without the row, and none of
			// them may drop it.
			commits = [store.commits.length > 0 && store.commits[0].hash === UNCOMMITTED
				? { ...store.commits[0], parents: [commitHead] }
				: {
					hash: UNCOMMITTED,
					parents: [commitHead],
					author: '*',
					email: '',
					date: Math.round(Date.now() / 1000),
					message: formatStr(strings.uncommittedChangesRow, String(store.uncommittedCount)),
					heads: [],
					tags: [],
					remotes: [],
					stash: null
				}, ...commits];
		}

		if (!store.currentRepoLoading && !store.refreshState.hard && store.moreCommitsAvailable === moreAvailable && store.onlyFollowFirstParent === onlyFollowFirstParent && store.commitHead === commitHead && commits.length > 0 && arraysEqual(store.commits, commits, (a, b) =>
			a.hash === b.hash &&
			arraysStrictlyEqual(a.heads, b.heads) &&
			arraysEqual(a.tags, b.tags, (a: GG.GitCommitTag, b: GG.GitCommitTag) => a.name === b.name && a.annotated === b.annotated) &&
			arraysEqual(a.remotes, b.remotes, (a: GG.GitCommitRemote, b: GG.GitCommitRemote) => a.name === b.name && a.remote === b.remote) &&
			arraysStrictlyEqual(a.parents, b.parents) &&
			((a.stash === null && b.stash === null) || (a.stash !== null && b.stash !== null && a.stash.selector === b.stash.selector))
		) && store.renderedGitBranchHead === store.gitBranchHead && !store.gerritStatesDirty) {

			if (store.commits[0].hash === UNCOMMITTED) {
				store.commits[0] = commits[0];
				ctx.persistence.saveState();
				ctx.table.renderUncommittedChanges();
				if (store.expandedCommit !== null && store.expandedCommit.commitElem !== null) {
					if (store.expandedCommit.compareWithHash === null) {
						// Commit Details View is open
						if (store.expandedCommit.commitHash === UNCOMMITTED) {
							ctx.details.requestCommitDetails(store.expandedCommit.commitHash, true);
						}
					} else {
						// Commit Comparison is open
						if (store.expandedCommit.compareWithElem !== null && (store.expandedCommit.commitHash === UNCOMMITTED || store.expandedCommit.compareWithHash === UNCOMMITTED)) {
							ctx.details.requestCommitComparison(store.expandedCommit.commitHash, store.expandedCommit.compareWithHash, true);
						}
					}
				}
			} else if (tagsChanged) {
				ctx.persistence.saveState();
			}
			this.finaliseLoadCommits();
			return;
		}

		// Everything else - a commit landing at the top, the Uncommitted Changes row appearing or
		// vanishing, a "Load More Commits" page arriving at the bottom, a background fetch moving a
		// label deep in the history, a rebase rewriting the middle - goes through this one path.
		// Rendering reconciles rows by commit identity and rebuilds only the rows that actually
		// differ (see CommitTable.syncCommitRows), which is correct for every shape of change.
		const currentRepoLoading = store.currentRepoLoading;
		// A background refresh reaching this full re-render changes the table's shape under the
		// user (a commit inserted/removed anywhere, a rebase rewriting mid-history, the Gerrit
		// states arriving). Anchor the rebuild on the commit the user is looking at, exactly like
		// every other update path does. A pre-collapse anchor (a hard refresh or an error cleared
		// the table while the user was scrolled into the history) outranks the live capture: the
		// collapse already clamped scrollTop to 0, so the live capture would read "at the very
		// top" and pin the view there once the same commits render again.
		const anchorFromPending = viewport.pendingViewportAnchor !== null;
		const anchor = currentRepoLoading ? null
			: (anchorFromPending ? viewport.pendingViewportAnchor : viewport.captureViewportAnchor());
		viewport.pendingViewportAnchor = null; // one shot: consumed here, or dropped with its hash lookup
		store.currentRepoLoading = false;
		store.moreCommitsAvailable = moreAvailable;
		store.onlyFollowFirstParent = onlyFollowFirstParent;
		store.commits = commits;
		store.commitHead = commitHead;
		store.commitLookup = {};

		let expandedCommitVisible = false, expandedCompareWithCommitVisible = false;
		const avatarsNeeded: { [email: string]: string[] } = {};
		for (let i = 0; i < store.commits.length; i++) {
			const commit = store.commits[i];
			store.commitLookup[commit.hash] = i;
			if (store.expandedCommit !== null) {
				if (store.expandedCommit.commitHash === commit.hash) {
					expandedCommitVisible = true;
				} else if (store.expandedCommit.compareWithHash === commit.hash) {
					expandedCompareWithCommitVisible = true;
				}
			}
			if (store.config.fetchAvatars && typeof store.avatars[commit.email] !== 'string' && commit.email !== '') {
				if (typeof avatarsNeeded[commit.email] === 'undefined') {
					avatarsNeeded[commit.email] = [commit.hash];
				} else {
					avatarsNeeded[commit.email].push(commit.hash);
				}
			}
		}

		if (store.expandedCommit !== null && (!expandedCommitVisible || (store.expandedCommit.compareWithHash !== null && !expandedCompareWithCommitVisible))) {
			ctx.details.close(false);
		}

		ctx.persistence.saveState();

		ctx.graph.loadCommits(store.commits, store.commitHead, store.commitLookup, store.onlyFollowFirstParent);

		// Put the scroll where the anchored commit needs it BEFORE rendering, so the window is
		// computed at its final position and every row in it is reconciled exactly once.
		// (Rendering first and correcting afterwards would window the list at the stale position,
		// then move - destroying and rebuilding the rows at both edges of the window for nothing.)
		viewport.applyViewportAnchor(anchor);
		// The ONE render of this response (task 5.10): synchronous because the anchor re-application
		// below measures the rows this pass wrote, and it satisfies any render requested earlier in
		// the same response (the scheduler's pending flag), so nothing renders twice
		ctx.renderScheduler.renderSync();
		store.gerritStatesDirty = false;
		// A full render has variable row heights, so its anchor can only be measured now that the
		// rows are on screen. Windowed rendering already landed exactly, and this is a no-op.
		// A pre-collapse anchor additionally could not hold before the render: it was clamped away
		// by the collapsed scroll height of the cleared table, so it is re-applied now that the
		// reloaded rows give the view its full height back (absolute, never a delta - applying it
		// twice cannot accumulate).
		if (viewport.renderedRange === null || anchorFromPending) viewport.applyViewportAnchor(anchor);

		if (currentRepoLoading) {
			if (store.config.onRepoLoad.scrollToHead && store.commitHead !== null) {
				viewport.scrollToCommit(store.commitHead, true);
			} else if (viewport.restoreScrollTop !== null) {
				// Webview reload: re-apply the scroll position saved before the reload
				ctx.dom.view.scrollTop = viewport.restoreScrollTop;
				viewport.updateVirtualWindow(); // re-render the window around the restored position
			}
			viewport.restoreScrollTop = null;
		}

		this.finaliseLoadCommits();
		this.requestAvatars(avatarsNeeded);
	}

	private finaliseLoadCommits() {
		const ctx = this.ctx(), store = ctx.store, refreshState = store.refreshState;
		if (refreshState.inProgress) {
			ctx.dialog.closeActionRunning();

			if (ctx.dialog.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					ctx.dialog.close();
				} else {
					ctx.dialog.refresh(store.commits);
				}
			}

			if (ctx.contextMenu.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					ctx.contextMenu.close();
				} else {
					ctx.contextMenu.refresh(store.commits);
				}
			}

			refreshState.inProgress = false;
			ctx.controls.renderRefreshButton();
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
		const ctx = this.ctx(), store = ctx.store;
		if (this.pendingScrollCommitHash === null) return;
		if (this.countCommitsBeforePending) return; // the count response drives the jump (or reports "not found")
		const hash = this.pendingScrollCommitHash;
		if (store.commitLookup[hash] !== undefined) {
			this.pendingScrollCommitHash = null;
			ctx.viewport.scrollToCommit(hash, true, true);
		} else if (store.moreCommitsAvailable) {
			this.loadMoreCommits();
		} else {
			this.pendingScrollCommitHash = null;
			ctx.dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInLoadedHistory, null, null);
		}
	}

	/**
	 * Jump to a commit that is not in the loaded page (a pinned commit): ask the extension how
	 * many commits precede it, so the view can load straight to it.
	 */
	public jumpToUnloadedCommit(hash: string) {
		this.pendingScrollCommitHash = hash;
		this.countCommitsBeforePending = true;
		this.requestCountCommitsBefore(hash);
	}

	/**
	 * Handle the response of a countCommitsBefore request (made when jumping to a pinned commit
	 * that is not in the view): load enough commits to include it in a single request.
	 */
	public processCountCommitsBefore(msg: GG.ResponseCountCommitsBefore) {
		const ctx = this.ctx(), store = ctx.store;
		this.countCommitsBeforePending = false;
		if (this.pendingScrollCommitHash !== msg.hash) return;
		if (msg.count === null) {
			this.pendingScrollCommitHash = null;
			ctx.dialog.showError(strings.pinnedCommitTitle, strings.pinnedCommitNotInRepo, null, null);
			return;
		}
		// Jump straight to the commit: load everything up to it (plus a margin), then
		// checkPendingScrollCommit scrolls to it once the load completes
		store.maxCommits = Math.max(store.maxCommits, msg.count + store.config.loadMoreCommits);
		ctx.table.setFooterLoading();
		ctx.persistence.saveState();
		this.requestLoadRepoInfoAndCommits(false, true);
	}

	private finaliseRepoLoad(didLoadRepoData: boolean) {
		const ctx = this.ctx(), store = ctx.store;
		const loadViewTo = store.loadViewTo;
		if (loadViewTo !== null && store.currentRepo === loadViewTo.repo) {
			if (loadViewTo.findCommitHash) {
				const commitIndex = store.getCommitId(loadViewTo.findCommitHash);
				if (commitIndex !== null) {
					// Windowed rendering may not have the row in the DOM at all: scroll first
					// (which re-renders the window around the target), then resolve the row the
					// window now holds. Resolving before scrolling silently dropped the jump for
					// any commit outside the initially rendered window.
					ctx.viewport.scrollToCommit(loadViewTo.findCommitHash, true, true);
					const commitElem = ctx.table.findCommitElem(commitIndex);
					if (commitElem !== null) {
						ctx.details.load(commitElem);
					}
					store.loadViewTo = null;
				} else if (store.moreCommitsAvailable) {
					this.loadMoreCommits();
					return; // Wait for next load
				} else {
					ctx.bridge.send({ command: 'showErrorMessage', message: strings.commitNotFound });
					store.loadViewTo = null;
				}
			} else if (loadViewTo.commitDetails && (store.expandedCommit === null || store.expandedCommit.commitHash !== loadViewTo.commitDetails.commitHash || store.expandedCommit.compareWithHash !== loadViewTo.commitDetails.compareWithHash)) {
				const commitIndex = store.getCommitId(loadViewTo.commitDetails.commitHash);
				const compareWithIndex = loadViewTo.commitDetails.compareWithHash !== null ? store.getCommitId(loadViewTo.commitDetails.compareWithHash) : null;
				// Bring both rows into the rendered window first (as above), then resolve their
				// elements — under windowed rendering the elements only exist once the window
				// covers their indices.
				if (commitIndex !== null) ctx.viewport.scrollToCommit(loadViewTo.commitDetails.commitHash, true, true);
				if (compareWithIndex !== null) ctx.viewport.scrollToCommit(loadViewTo.commitDetails.compareWithHash!, false, false);
				const commitElem = ctx.table.findCommitElem(commitIndex);
				const compareWithElem = ctx.table.findCommitElem(compareWithIndex);

				if (commitElem !== null && (loadViewTo.commitDetails.compareWithHash === null || compareWithElem !== null)) {
					if (compareWithElem !== null) {
						ctx.details.loadComparison(commitElem, compareWithElem);
					} else {
						ctx.details.load(commitElem);
					}
				} else {
					ctx.bridge.send({ command: 'showErrorMessage', message: formatStr(strings.unableToResumeCodeReview, String(store.maxCommits)) });
				}
			} else if (loadViewTo.runCommandOnLoad) {
				switch (loadViewTo.runCommandOnLoad) {
					case 'fetch':
						fetchFromRemotesAction(ctx);
						break;
				}
			}
		}
		store.loadViewTo = null;

		if (store.gitConfig === null || (didLoadRepoData && store.refreshState.configChanges)) {
			this.requestLoadConfig();
		}
	}

	/** Empty the view of the current repository's commits (before they are reloaded). */
	public clearCommits() {
		const ctx = this.ctx(), store = ctx.store;
		ctx.closeDialogAndContextMenu();
		store.moreCommitsAvailable = false;
		this.pendingScrollCommitHash = null;
		this.countCommitsBeforePending = false;
		store.commits = [];
		store.commitHead = null;
		store.commitLookup = {};
		store.uncommittedCount = null;
		store.renderedGitBranchHead = null;
		store.gerritStates = {};
		store.gerritStatesDirty = false;
		ctx.commitBodies.clear();
		ctx.viewport.renderedRange = null;
		ctx.details.close(false);
		ctx.persistence.saveState();
		ctx.graph.loadCommits(store.commits, store.commitHead, store.commitLookup, store.onlyFollowFirstParent);
		ctx.table.clear();
		ctx.table.setFooter(html``);
		ctx.table.renderGraph();
		ctx.widgets.find.refresh();
	}

	/**
	 * Apply a change of the Gerrit status filter (the Repository Settings checkboxes): the badges
	 * re-render immediately from the already-loaded states (the fetch limit re-applied under the
	 * new filter), and the commit graph is reloaded in the background (debounced, so toggling
	 * several checkboxes triggers a single load): only the extension knows which change refs to
	 * inject for the new filter, and its response also carries the event timelines of the changes
	 * that became visible — they ride along the visible states only.
	 */
	public applyGerritFilterChange() {
		this.ctx().store.invalidateRender();
		if (this.gerritFilterRefreshTimer !== null) window.clearTimeout(this.gerritFilterRefreshTimer);
		this.gerritFilterRefreshTimer = window.setTimeout(() => {
			this.gerritFilterRefreshTimer = null;
			this.requestLoadRepoInfoAndCommits(false, true);
		}, 120);
	}


	/* Responses */

	/**
	 * The pushed merged view of the open path (task 4.7): the repo info and the first commit page
	 * in one message, followed by the same staged follow-ups the partial responses carry. Each
	 * half routes through the processing of the corresponding partial response, so nothing about
	 * the loading pipeline changes — only the boot's two round trips became zero.
	 */
	public processLoadView(msg: GG.ResponseLoadView) {
		const ctx = this.ctx(), store = ctx.store;
		this.bootPushExpected = false;
		// Adopt the refresh id the host stamped the merged read with (it also rode the regenerated
		// page's initialState): the staged follow-ups carry the same id and must be accepted,
		// while anything older is dropped.
		store.refreshState.loadRepoInfoRefreshId = msg.refreshId;
		store.refreshState.loadCommitsRefreshId = msg.refreshId;
		this.processLoadRepoInfoResponse({ command: 'loadRepoInfo', refreshId: msg.refreshId, ...msg.repoInfo });
		this.processLoadCommitsResponse({ command: 'loadCommits', refreshId: msg.refreshId, ...msg.commits });
		// The pushed page used the default view options (Show All branches, the extension's
		// defaults): a repository whose own settings select specific branches, a Gerrit feed or a
		// different ordering re-requests just the commits — one request instead of the two the
		// old boot sent.
		if (!this.pushedPageMatchesRepoSettings()) {
			this.requestLoadRepoInfoAndCommits(false, true);
		}
	}

	/** Whether the just-pushed default page matches this repository's own view settings. */
	private pushedPageMatchesRepoSettings(): boolean {
		const store = this.ctx().store, repoState = store.repoState, config = store.config;
		// The pushed page showed all branches under the extension-level defaults; a repository
		// whose own settings resolve to anything else must re-request under them.
		const showAll = store.currentBranches !== null && store.currentBranches.length === 1 && store.currentBranches[0] === SHOW_ALL_BRANCHES;
		const defaultsMatch =
			getCommitOrdering(repoState.commitOrdering, config) === config.commitOrdering
			&& getShowRemoteBranches(repoState.showRemoteBranchesV2, config) === config.showRemoteBranches
			&& getShowTags(repoState.showTags, config) === config.showTags
			&& getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs, config) === config.includeCommitsMentionedByReflogs
			&& getOnlyFollowFirstParent(repoState.onlyFollowFirstParent, config) === config.onlyFollowFirstParent
			&& repoState.gerritFetchRefs !== true;
		return showAll && defaultsMatch;
	}

	public processLoadRepoInfoResponse(msg: GG.ResponseLoadRepoInfo) {
		const ctx = this.ctx();
		// A response superseded by a newer loadRepoInfo request (e.g. the repository changed while
		// this one was in flight) must not apply the old repository's branches/head/remotes to the
		// current view.
		if (ctx.store.refreshState.loadRepoInfoRefreshId !== msg.refreshId) return;
		ctx.widgets.conflictBanner.update(msg.operationState);
		if (msg.error === null) {
			this.loadRepoInfo(msg.branches, msg.head, msg.remotes, msg.stashes, msg.isRepo, msg.remoteRefsPending === true);
			this.requestPullRequests();
		} else {
			this.displayLoadDataError(strings.errLoadRepoInfo, msg.error);
		}
	}

	/**
	 * Request the pull/merge requests of the current repository from the extension host (only
	 * when the pull request integration is enabled). One request per repository: the requests
	 * drive the badges on the commit rows, which don't depend on the checked-out branch.
	 */
	private requestPullRequests() {
		const ctx = this.ctx(), store = ctx.store;
		if (!store.config.pullRequests.enabled) return;
		if (this.prStatusRepos.has(store.currentRepo)) return;
		this.prStatusRepos.add(store.currentRepo);
		ctx.bridge.send({ command: 'fetchPullRequest', repo: store.currentRepo });
	}

	/** Drop the record that the pull requests of a repository were requested, so the next load requests them again. */
	public forgetPullRequestsRequest(repo: string) {
		this.prStatusRepos.delete(repo);
	}

	/**
	 * Process a pull request response (ignored for other repositories): index the requests by the
	 * commit each one points at and re-render, so the loaded commits carrying a pull request get
	 * their badge. A NULL list (the status couldn't be determined) keeps the current badges.
	 */
	public processPullRequestStatus(msg: GG.ResponsePullRequestStatus) {
		const ctx = this.ctx(), store = ctx.store;
		if (store.currentRepo !== msg.repo || msg.prs === null) return;
		const pullRequestsByHead: { [hash: string]: GG.PullRequestInfo } = {};
		for (const pr of msg.prs) {
			if (pr.headHash !== '') pullRequestsByHead[pr.headHash] = pr;
		}
		if (pullRequestMapsEqual(store.pullRequestsByHead, pullRequestsByHead)) return;
		store.pullRequestsByHead = pullRequestsByHead;
		// A store change: the invalidation channel (main.ts wires it to the render scheduler)
		// coalesces this with any other change of the same burst into one render
		store.invalidateRender();
	}

	public processLoadCommitsResponse(msg: GG.ResponseLoadCommits) {
		const ctx = this.ctx(), store = ctx.store, refreshState = store.refreshState;
		if (msg.error === null) {
			// A loadCommits request can be answered by MULTIPLE responses with the same refresh id:
			// the deferred "Uncommitted Changes" follow-up of a cold-cache load arrives after the
			// first response finalised the refresh (inProgress === false). The refresh id alone
			// identifies whether the response belongs to the current view state: every new request
			// increments it.
			if (refreshState.loadCommitsRefreshId === msg.refreshId) {
				// The Gerrit states ride along every loadCommits response: swap the map in and force
				// a re-render when it changed (the extension serves the fetched states of the cache
				// entry — the event timelines of the visible ones only — so the status filter and
				// the fetch limit of the Repository Settings are applied locally by this view). The
				// array is checked (not merely non-null): a response from a mismatched extension
				// build that omits the field entirely (undefined) must keep the current states,
				// never crash.
				//
				// The staged Gerrit load delivers the states in two parts: the light part the badges
				// render (arriving with the change refs), then the event timelines (which only the
				// review dialog reads). A change confined to the timelines therefore swaps the map
				// without re-rendering the commit table, refreshing an open review dialog in place.
				if (Array.isArray(msg.gerritStates)) {
					const newStates: { [hash: string]: GG.GerritChangeState } = {};
					for (const state of msg.gerritStates) newStates[state.headHash] = state;
					const changed = !gerritStatesEqual(store.gerritStates, newStates);
					const badgesChanged = !gerritStatesEqual(store.gerritStates, newStates, false);
					store.gerritStatesDirty = badgesChanged;
					store.gerritStates = newStates;
					if (changed) refreshGerritReviewDialog(ctx.dialog, store.gerritStates, store.config.dateFormat);
				} else if (Object.keys(store.gerritStates).length > 0) {
					store.gerritStatesDirty = true;
					store.gerritStates = {};
				}
				// The branch list of the ref scan this page was built from: the deferred view load
				// delivers the remote-tracking entries here (they are the same scan the remote
				// pills come from), completing the branch dropdown without another request.
				if (Array.isArray(msg.branches)) this.applyBranches(msg.branches);
				// The exact "Uncommitted Changes" count arrives with the final follow-up: record it
				// as view state so subsequent deferred responses can keep the row rendered
				if (typeof msg.uncommittedCount === 'number') store.uncommittedCount = msg.uncommittedCount;
				this.loadCommits(msg.commits, msg.head, msg.tags, msg.moreCommitsAvailable, msg.onlyFollowFirstParent, msg.uncommittedPending === true);
			}
		} else if (refreshState.loadCommitsRefreshId === msg.refreshId) {
			// A stale error response (superseded by a newer load whose data is already rendered)
			// must not clear the view or abort the in-flight sequence - the same guard the success
			// path applies above.
			const error = store.gitBranches.length === 0 && msg.error.indexOf('bad revision \'HEAD\'') > -1
				? strings.noCommitsInRepo
				: msg.error;
			this.displayLoadDataError(strings.errLoadCommits, error);
		}
	}

	public processLoadConfig(msg: GG.ResponseLoadConfig) {
		const ctx = this.ctx(), store = ctx.store;
		if (store.currentRepo === msg.repo) {
			// A response superseded by a newer loadConfig request must not apply: two requests can
			// be in flight at once (the settings widget's open and a load cycle's own reload), and
			// the older read — served from a pre-change snapshot — landing after the newer one
			// would otherwise overwrite the fresh configuration with stale data (the author
			// dropdown would go back to "All Authors" and nothing would ever re-request).
			if (store.refreshState.loadConfigRefreshId !== msg.refreshId) return;
			store.refreshState.requestingConfig = false;
			if (msg.config !== null) {
				store.gitConfig = msg.config;
				ctx.persistence.saveState();
				ctx.details.renderExternalDiffBtn();
			}
			ctx.widgets.settings.refresh();
			ctx.controls.authorDropdown.setOptions(store.getAuthorOptions(), store.currentAuthors);
		}
	}

	private displayLoadDataError(message: string, reason: string) {
		const ctx = this.ctx(), store = ctx.store;
		// A transient load failure (e.g. git index contention) clears the table while the user may
		// be scrolled deep into the history: remember the reading position so the retry renders
		// back around it - the collapse below already clamps the browser's scrollTop to 0, which
		// without the captured anchor would pin the reloaded view to the top
		ctx.viewport.capturePendingViewportAnchor();
		this.clearCommits();
		store.refreshState.inProgress = false;
		store.loadViewTo = null;
		ctx.controls.renderRefreshButton();
		ctx.dialog.showError(message, reason, strings.retryAction, () => {
			this.refresh(true);
		});
	}

	/** Set the avatar of an author (an author avatar response), updating the rows already rendered. */
	public loadAvatar(email: string, image: string) {
		const ctx = this.ctx();
		ctx.store.avatars[email] = image;
		ctx.persistence.saveState();
		// Scope the update to the rows of this author (attribute selector) instead of scanning
		// every avatar element of the (potentially very large) table
		const escapedEmail = email.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		const avatarElems = document.querySelectorAll<HTMLElement>('.avatar[data-email="' + escapedEmail + '"]');
		for (let i = 0; i < avatarElems.length; i++) {
			setHtml(avatarElems[i], html`<img class="avatarImg" decoding="sync" src="${image}">`);
		}
	}


	/* Refresh */

	/**
	 * Apply a changed Extension Configuration to the running view (a `configChanged` message):
	 * everything the generated HTML would have baked in is re-applied in place, then the commits
	 * are reloaded with a soft refresh - the page keeps its rendered content, scroll position and
	 * open Commit Details View instead of being regenerated (which flashed the whole view).
	 */
	public applyConfig(config: GG.GitGraphViewConfig) {
		const ctx = this.ctx(), store = ctx.store;
		const previousColours = store.config.graph.colours.length;
		store.setConfig(config);
		ctx.persistence.saveState();

		// What start-up applies from the configuration
		alterClass(document.body, CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH, config.referenceLabels.branchLabelsAlignedToGraph);
		alterClass(document.body, CLASS_TAG_LABELS_RIGHT_ALIGNED, config.referenceLabels.tagLabelsOnRight);
		document.body.style.setProperty('--git-graph-fontSize', config.graph.fontSize + 'px');
		// A fresh configuration carries the configured grid: re-apply the mobile row pitch over it
		if (ctx.layout.isMobileLayout()) ctx.layout.resetGraphRowGrid();
		document.body.style.setProperty('--git-graph-rowHeight', ctx.layout.getRowHeight() + 'px');
		for (let i = 0; i < config.graph.colours.length; i++) {
			document.body.style.setProperty('--git-graph-color' + i, config.graph.colours[i]);
		}
		for (let i = config.graph.colours.length; i < previousColours; i++) {
			document.body.style.removeProperty('--git-graph-color' + i);
		}
		alterClass(ctx.dom.headerRow, 'sticky', config.stickyHeader);
		document.getElementById('fetchBtn')!.title = config.fetchAndPrune ? strings.fetchAndPruneTitle : strings.fetchTitle;

		// The repo state defaults derive from the configuration, and the dropdowns carry
		// configuration-derived options (glob patterns, repository order)
		if (store.repoState !== undefined) {
			ctx.controls.syncShowRemoteBranches();
		}
		ctx.controls.repoDropdown.setOptions(getRepoDropdownOptions(store.repos, config.repoDropdownOrder), [store.currentRepo]);
		ctx.controls.branchDropdown.setOptions(store.getBranchOptions(true), store.currentBranches);
		ctx.widgets.settings.refresh();

		// Settings that shape the rendered output but not the commit data (graph style, date
		// format, column visibility, ...) would otherwise wait for the next render: run one now.
		// It reconciles, so unchanged rows keep their DOM nodes and the viewport its position -
		// and it coalesces onto the next frame with anything else this config change requested.
		store.invalidateRender();

		// Reload the commits under the new settings (the extension host dropped its commit cache
		// for the change): a soft refresh, answered with the complete data in one response, so
		// the view updates in place
		this.refresh(false);
	}

	/**
	 * Refresh the view.
	 * @param hard TRUE => clear the commits first (the view shows its loading state), FALSE => keep the rendered commits until the new ones arrive.
	 * @param configChanges Also reload the repository's configuration.
	 */
	public refresh(hard: boolean, configChanges: boolean = false) {
		if (hard) {
			this.clearCommits();
		}
		this.requestLoadRepoInfoAndCommits(hard, false, configChanges);
	}

	/** Load more commits (the footer button, auto-load when scrolled to the end, a jump to an unloaded commit). */
	public loadMoreCommits() {
		const ctx = this.ctx(), store = ctx.store;
		ctx.table.setFooterLoading();
		store.maxCommits += store.config.loadMoreCommits;
		ctx.persistence.saveState();
		this.requestLoadRepoInfoAndCommits(false, true);
	}


	/* Requests */

	private requestLoadRepoInfo() {
		const ctx = this.ctx(), store = ctx.store, repoState = store.repoState;
		ctx.bridge.send({
			command: 'loadRepoInfo',
			repo: store.currentRepo,
			refreshId: ++store.refreshState.loadRepoInfoRefreshId,
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2, store.config),
			showStashes: getShowStashes(repoState.showStashes, store.config),
			hideRemotes: repoState.hideRemotes
		});
	}

	private requestCountCommitsBefore(hash: string) {
		const ctx = this.ctx(), store = ctx.store, repoState = store.repoState;
		ctx.bridge.send({
			command: 'countCommitsBefore',
			repo: store.currentRepo,
			hash: hash,
			branches: store.getSelectedBranchesFilter(),
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2, store.config),
			includeCommitsMentionedByReflogs: getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs, store.config)
		});
	}

	private requestLoadCommits() {
		const ctx = this.ctx(), store = ctx.store, repoState = store.repoState;
		ctx.bridge.send({
			command: 'loadCommits',
			repo: store.currentRepo,
			refreshId: ++store.refreshState.loadCommitsRefreshId,
			hard: store.refreshState.hard,
			branches: store.getSelectedBranchesFilter(),
			authors: store.getSelectedAuthorsFilter(),
			maxCommits: store.maxCommits,
			showTags: getShowTags(repoState.showTags, store.config),
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2, store.config),
			includeCommitsMentionedByReflogs: getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs, store.config),
			onlyFollowFirstParent: getOnlyFollowFirstParent(repoState.onlyFollowFirstParent, store.config),
			commitOrdering: getCommitOrdering(repoState.commitOrdering, store.config),
			remotes: store.gitRemotes,
			hideRemotes: repoState.hideRemotes,
			stashes: store.gitStashes,
			gerritFetchRefs: repoState.gerritFetchRefs,
			gerritFetchLimit: repoState.gerritFetchLimit !== undefined ? repoState.gerritFetchLimit : null,
			gerritStatusFilter: repoState.gerritStatusFilter,
			filterPath: store.commitPathFilter
		});
	}

	/**
	 * Start (or join) the refresh cycle: request the repository info and then the commits, or just
	 * the commits.
	 * @param hard Clear the view's commits (the loading state is shown) for this refresh.
	 * @param skipRepoInfo Only request the commits (the repository info is unchanged).
	 * @param configChanges Also reload the repository's configuration once the commits are loaded.
	 */
	public requestLoadRepoInfoAndCommits(hard: boolean, skipRepoInfo: boolean, configChanges: boolean = false) {
		const ctx = this.ctx(), store = ctx.store, refreshState = store.refreshState;
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

		ctx.controls.renderRefreshButton();
		if (store.commits.length === 0) {
			ctx.table.showLoadingSkeleton();
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

	/** Request the repository's configuration (and show the settings widget as loading). */
	public requestLoadConfig() {
		const ctx = this.ctx(), store = ctx.store;
		store.refreshState.requestingConfig = true;
		ctx.bridge.send({ command: 'loadConfig', repo: store.currentRepo, refreshId: ++store.refreshState.loadConfigRefreshId, remotes: store.gitRemotes });
		ctx.widgets.settings.refresh();
	}

	private requestAvatars(avatars: { [email: string]: string[] }) {
		const ctx = this.ctx(), store = ctx.store;
		const emails = Object.keys(avatars), remote = store.gitRemotes.length > 0 ? store.gitRemotes.includes('origin') ? 'origin' : store.gitRemotes[0] : null;
		for (let i = 0; i < emails.length; i++) {
			ctx.bridge.send({ command: 'fetchAvatar', repo: store.currentRepo, remote: remote, email: emails[i], commits: avatars[emails[i]] });
		}
	}
}

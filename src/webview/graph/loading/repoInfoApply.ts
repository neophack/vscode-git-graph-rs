/**
 * Applying a repo-info payload (OPTIMIZATION-PLAN §6 F2): the branches / HEAD / remotes /
 * stashes half of a `loadRepoInfo` response, the late branch list a `loadCommits` response can
 * carry once the remote-tracking refs were scanned, and the pushed page's settings-match check.
 *
 * The machine decides WHETHER a payload applies (the `applyRepoInfo` effect fires only for an
 * accepted response); this module is the WHAT. The cycle sequencing legacy `loadRepoInfo`
 * performed in its tail (`finaliseLoadRepoInfo` → `requestLoadCommits`) is the machine's
 * `issueCommitsRequest` effect now.
 */

import { arraysStrictlyEqual, SHOW_ALL_BRANCHES } from '../../common/util';
import * as GG from '../../common/protocol';
import { getCommitOrdering, getIncludeCommitsMentionedByReflogs, getOnRepoLoadShowCheckedOutBranch, getOnRepoLoadShowSpecificBranches, getOnlyFollowFirstParent, getShowRemoteBranches, getShowTags } from '../state/repoSettings';
import { GraphContext } from '../context';

/** The repo-info half of a `loadRepoInfo` response (or of a pushed `loadView`). */
export interface RepoInfoPayload {
	readonly branches: ReadonlyArray<string>;
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GG.GitStash>;
	readonly isRepo: boolean;
	readonly remoteRefsPending: boolean;
}

export class RepoInfoApplier {
	constructor(private readonly ctx: () => GraphContext) { }

	/**
	 * Apply a repo-info payload.
	 *
	 * `trackChanges` is TRUE for a cycle's response (its changed/unchanged note feeds the dialog
	 * refresh decision of the cycle's commits application — legacy `finaliseLoadRepoInfo`'s
	 * `repoInfoChanges` OR, which only ran while the cycle was in progress) and FALSE for the
	 * boot push (no cycle runs there; the pushed page's commits application finalises nothing).
	 */
	public apply(payload: RepoInfoPayload, trackChanges: boolean): void {
		const ctx = this.ctx(), store = ctx.store;
		// Changes to store.gitStashes are reflected as changes to the commits when loadCommits is run
		store.gitStashes = payload.stashes;

		if (!payload.isRepo || (!store.refreshState.hard && arraysStrictlyEqual(store.gitBranches, payload.branches) && store.gitBranchHead === payload.head && arraysStrictlyEqual(store.gitRemotes, payload.remotes))) {
			ctx.persistence.saveState();
			return;
		}

		// Changes to these properties must be indicated as a repository info change
		store.gitBranches = payload.branches;
		store.gitBranchHead = payload.head;
		store.gitRemotes = payload.remotes;

		// Update the state of the fetch button
		ctx.controls.renderFetchButton();

		// While the remote-tracking refs are still being scanned, a `remotes/...` name cannot be
		// validated against the (local-only) branch list — such selections and configured branches
		// are kept until the complete list arrives with a loadCommits response.
		const keepRemoteSelections = (branch: string) => payload.remoteRefsPending && branch.startsWith('remotes/');
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
		const hideRemotes = hiddenRemotes.filter((hiddenRemote: string) => payload.remotes.includes(hiddenRemote));
		if (hiddenRemotes.length !== hideRemotes.length) {
			ctx.persistence.saveRepoStateValue(store.currentRepo, 'hideRemotes', hideRemotes);
		}

		// The repository info changed: note it for the cycle's commits application (its dialog
		// refresh closes instead of updating when the ref selections moved under it — legacy
		// `finaliseLoadRepoInfo`'s `repoInfoChanges` OR, which only ran while the cycle ran)
		if (trackChanges) store.refreshState.repoInfoChanges = true;
	}

	/**
	 * Apply a branch list that arrived with a `loadCommits` response (the complete list, once the
	 * remote-tracking refs have been scanned): update the dropdown in place and drop selections
	 * that no longer exist — the same validation the `loadRepoInfo` response performs, arriving
	 * late. This never re-triggers the load chain by itself: the commits of the same response are
	 * already it.
	 * @returns TRUE when the selection reset demands a commits-only reload (the graph must match
	 * the "Show All Branches" the dropdown now shows).
	 */
	public applyBranchList(branchOptions: ReadonlyArray<string>): boolean {
		const ctx = this.ctx(), store = ctx.store;
		if (arraysStrictlyEqual(store.gitBranches, branchOptions)) return false;
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
		return selectionReset;
	}

	/** Whether the just-pushed default page matches this repository's own view settings. */
	public pushedPageMatchesRepoSettings(): boolean {
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
}

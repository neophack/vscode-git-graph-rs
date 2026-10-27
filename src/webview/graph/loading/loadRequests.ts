/**
 * The request half of the load pipeline (OPTIMIZATION-PLAN §6 F2): issuing the host requests of a
 * load cycle and stamping them with the refresh ids the responses are validated against.
 *
 * The id counters stay on `store.refreshState` (the boot adopts the pushed `loadView`'s id into
 * both, and the persisted `initialState` seeds them); this class owns stamping and sending. The
 * decision WHEN a request is issued is the load machine's (`issueRepoInfoRequest` /
 * `issueCommitsRequest` effects) — nothing here inspects the load state.
 */

import * as GG from '../../common/protocol';
import { GraphContext } from '../context';
import {
	getCommitOrdering, getIncludeCommitsMentionedByReflogs, getOnlyFollowFirstParent, getShowRemoteBranches,
	getShowStashes, getShowTags
} from '../state/repoSettings';

export class LoadRequests {
	constructor(private readonly ctx: () => GraphContext) { }

	/**
	 * Allocate the request id of a new cycle (or of a join): the caller stamps its machine event
	 * with it, so every request the cycle issues carries it and every response of a SUPERSEDED
	 * cycle drops as stale. Bumping `loadCommitsRefreshId` is the legacy id-invalidation bump
	 * (repoLoader.ts:1065/:1073) — it retires every staged follow-up still in flight.
	 */
	public nextRequestId(): number {
		return this.ctx().store.slices.repos.nextCommitsRequestId();
	}

	/** Send the repo-info half of a cycle under the cycle's id (the `issueRepoInfoRequest` effect). */
	public issueRepoInfo(requestId: number): void {
		const ctx = this.ctx(), store = ctx.store, repoState = store.repoState;
		store.slices.repos.stampRepoInfoRequestId(requestId);
		ctx.bridge.send({
			command: 'loadRepoInfo',
			repo: store.currentRepo,
			refreshId: requestId,
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2, store.config),
			showStashes: getShowStashes(repoState.showStashes, store.config),
			hideRemotes: repoState.hideRemotes
		});
	}

	/**
	 * Send the commits half of a cycle under the cycle's id (the `issueCommitsRequest` effect).
	 * `hard` mirrors the cycle's kind (a `loading` cycle re-reads from an empty view).
	 */
	public issueCommits(requestId: number, hard: boolean): void {
		const ctx = this.ctx(), store = ctx.store, repoState = store.repoState;
		store.slices.repos.stampCommitsRequestId(requestId);
		ctx.bridge.send({
			command: 'loadCommits',
			repo: store.currentRepo,
			refreshId: requestId,
			hard: hard,
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
	 * Ask the extension how many commits precede a pinned commit that is not in the loaded page,
	 * so the view can load straight to it. Matched by hash on the response, not by a refresh id:
	 * it is a one-shot probe outside the load cycle (there is no machine state for it).
	 */
	public issueCountCommitsBefore(hash: string): void {
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

	/** Request the repository's configuration (and show the settings widget as loading). */
	public requestLoadConfig(): void {
		const ctx = this.ctx(), store = ctx.store;
		const refreshId = store.slices.repos.beginConfigLoad();
		ctx.bridge.send({ command: 'loadConfig', repo: store.currentRepo, refreshId: refreshId, remotes: store.gitRemotes });
		ctx.widgets.settings.refresh();
	}

	/**
	 * Apply a `loadConfig` response. The config load is its own one-shot request/response keyed
	 * by its own id (it never blocks, clears or re-shapes the view — see the loadMachine module
	 * docs), so it stays outside the machine: two requests can be in flight at once (the settings
	 * widget's open and a load cycle's own reload), and a response superseded by a newer one must
	 * not apply — the older read, served from a pre-change snapshot, landing after the newer
	 * would overwrite the fresh configuration with stale data.
	 */
	public processLoadConfig(msg: GG.ResponseLoadConfig): void {
		const ctx = this.ctx(), store = ctx.store;
		if (store.currentRepo !== msg.repo) return;
		if (store.refreshState.loadConfigRefreshId !== msg.refreshId) return;
		store.slices.repos.endConfigLoad();
		if (msg.config !== null) {
			store.slices.refs.setRepoConfig(msg.config);
			ctx.persistence.saveState();
			ctx.details.renderExternalDiffBtn();
		}
		ctx.widgets.settings.refresh();
		ctx.controls.authorDropdown.setOptions(store.getAuthorOptions(), store.currentAuthors);
	}
}

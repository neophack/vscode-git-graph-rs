/**
 * The integrations slice: the third-party badge data rendered onto the
 * commit rows - the Gerrit change states of the current repository and the pull requests of its
 * remote. The ONLY writer of these fields is this class; every change leaves as a typed
 * `SliceChange<'integrations'>` for the render scheduler (a row-badge change routes by slice
 * instead of a whole-view invalidation).
 */

import * as GG from '../../../common/protocol';
import { EmitChange, SliceChange } from '../changes';

export class IntegrationsSlice {
	/** The Gerrit change states of the current repository, keyed by the head commit hash of each change. */
	private gerritStatesValue: { [hash: string]: GG.GerritChangeState } = {};
	/** TRUE when the Gerrit states changed in a way the rendered rows don't reflect yet (forces a re-render). */
	private gerritStatesDirtyValue: boolean = false;
	/** The pull requests of the current repository's remote, keyed by the commit each one points at. */
	private pullRequestsByHeadValue: { [hash: string]: GG.PullRequestInfo } = {};

	constructor(private readonly emit: EmitChange<SliceChange<'integrations'>>) { }


	/* Reads */

	public get gerritStates(): { [hash: string]: GG.GerritChangeState } {
		return this.gerritStatesValue;
	}

	public get gerritStatesDirty(): boolean {
		return this.gerritStatesDirtyValue;
	}

	public get pullRequestsByHead(): { [hash: string]: GG.PullRequestInfo } {
		return this.pullRequestsByHeadValue;
	}


	/* Actions */

	/**
	 * Swap in the Gerrit states a loadCommits response carried. `badgesChanged` is TRUE when the
	 * BADGE-relevant part changed (the rendered rows must re-render for it); the timelines-only
	 * changes (which only the review dialog reads) leave the rows alone. `changed` is FALSE for a
	 * byte-identical payload: the map is swapped (the rows' build inputs are reference-based), but
	 * no change is emitted - nothing is stale, exactly like the seamless update.
	 */
	public setGerritStates(states: { [hash: string]: GG.GerritChangeState }, badgesChanged: boolean, changed: boolean): void {
		this.gerritStatesValue = states;
		this.gerritStatesDirtyValue = badgesChanged;
		if (changed) this.emit({ slice: 'integrations', keys: badgesChanged ? ['gerritStates', 'gerritVisible'] : ['gerritStates'] });
	}

	/** Drop the Gerrit states (a response that no longer carries any). */
	public clearGerritStates(): void {
		this.gerritStatesValue = {};
		this.gerritStatesDirtyValue = true;
		this.emit({ slice: 'integrations', keys: ['gerritStates', 'gerritVisible'] });
	}

	/** Reset the Gerrit states without marking the rows dirty (a view clear; renders its own way). */
	public resetGerritStates(): void {
		this.gerritStatesValue = {};
		this.gerritStatesDirtyValue = false;
	}

	/** The rendered rows now reflect the Gerrit states (written after the render pass; emits nothing). */
	public clearGerritStatesDirty(): void {
		this.gerritStatesDirtyValue = false;
	}

	/** Swap in the pull requests a fetch response carried (NULL-safe: the caller filters). */
	public setPullRequests(pullRequestsByHead: { [hash: string]: GG.PullRequestInfo }): void {
		this.pullRequestsByHeadValue = pullRequestsByHead;
		this.emit({ slice: 'integrations', keys: ['pullRequests'] });
	}

	/** Drop the pull requests of the previous repository (a repository switch re-renders its own way). */
	public resetPullRequests(): void {
		this.pullRequestsByHeadValue = {};
	}
}

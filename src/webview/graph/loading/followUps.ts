/**
 * The staged follow-ups of a load: the requests and responses that run
 * BESIDE the commit pipeline rather than in it — the pull/merge request badges (one request per
 * repository), the author avatars — plus the Gerrit status filter's debounced background reload.
 *
 * None of these shape the load lifecycle (the machine has no state for them, by design — see the
 * loadMachine module docs); they are keyed by repository or email on their own terms.
 */

import { html, setHtml } from '../../common/html';
import * as GG from '../../common/protocol';
import { pullRequestMapsEqual } from '../integrations/pullRequests';
import { GraphContext } from '../context';

export class FollowUps {
	/** The debounce timer of the background reload triggered by a Gerrit status filter change. */
	private gerritFilterRefreshTimer: number | null = null;
	/** The repositories whose pull requests were already requested (one request per repository). */
	private readonly prStatusRepos: Set<string> = new Set();

	constructor(private readonly ctx: () => GraphContext, private readonly refreshCommitsOnly: () => void) { }


	/* Pull requests */

	/**
	 * Request the pull/merge requests of the current repository from the extension host (only
	 * when the pull request integration is enabled). One request per repository: the requests
	 * drive the badges on the commit rows, which don't depend on the checked-out branch.
	 */
	public requestPullRequests(): void {
		const ctx = this.ctx(), store = ctx.store;
		if (!store.config.pullRequests.enabled) return;
		if (this.prStatusRepos.has(store.currentRepo)) return;
		this.prStatusRepos.add(store.currentRepo);
		ctx.bridge.send({ command: 'fetchPullRequest', repo: store.currentRepo });
	}

	/** Drop the record that the pull requests of a repository were requested, so the next load requests them again. */
	public forgetPullRequestsRequest(repo: string): void {
		this.prStatusRepos.delete(repo);
	}

	/** Forget every repository's record (a repository switch: switching back re-requests them). */
	public forgetAllPullRequestsRequests(): void {
		this.prStatusRepos.clear();
	}

	/**
	 * Process a pull request response (ignored for other repositories): index the requests by the
	 * commit each one points at and re-render, so the loaded commits carrying a pull request get
	 * their badge. A NULL list (the status couldn't be determined) keeps the current badges.
	 */
	public processPullRequestStatus(msg: GG.ResponsePullRequestStatus): void {
		const ctx = this.ctx(), store = ctx.store;
		if (store.currentRepo !== msg.repo || msg.prs === null) return;
		const pullRequestsByHead: { [hash: string]: GG.PullRequestInfo } = {};
		for (const pr of msg.prs) {
			if (pr.headHash !== '') pullRequestsByHead[pr.headHash] = pr;
		}
		if (pullRequestMapsEqual(store.pullRequestsByHead, pullRequestsByHead)) return;
		// The slice's typed change routes to the renderers that show the badges (the table), and
		// coalesces with any other change of the same burst into one render
		store.slices.integrations.setPullRequests(pullRequestsByHead);
	}


	/* Avatars */

	/** Request the avatars collected while a page was applied (one request per author). */
	public requestAvatars(avatars: { [email: string]: string[] }): void {
		const ctx = this.ctx(), store = ctx.store;
		const emails = Object.keys(avatars), remote = store.gitRemotes.length > 0 ? store.gitRemotes.includes('origin') ? 'origin' : store.gitRemotes[0] : null;
		for (let i = 0; i < emails.length; i++) {
			ctx.bridge.send({ command: 'fetchAvatar', repo: store.currentRepo, remote: remote, email: emails[i], commits: avatars[emails[i]] });
		}
	}

	/** Set the avatar of an author (an author avatar response), updating the rows already rendered. */
	public loadAvatar(email: string, image: string): void {
		const ctx = this.ctx();
		ctx.store.slices.commits.setAvatar(email, image);
		ctx.persistence.saveState();
		// Scope the update to the rows of this author (attribute selector) instead of scanning
		// every avatar element of the (potentially very large) table
		const escapedEmail = email.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		const avatarElems = document.querySelectorAll<HTMLElement>('.avatar[data-email="' + escapedEmail + '"]');
		for (let i = 0; i < avatarElems.length; i++) {
			setHtml(avatarElems[i], html`<img class="avatarImg" decoding="sync" src="${image}">`);
		}
	}


	/* Gerrit status filter */

	/**
	 * Apply a change of the Gerrit status filter (the Repository Settings checkboxes): the badges
	 * re-render immediately from the already-loaded states (the fetch limit re-applied under the
	 * new filter), and the commit graph is reloaded in the background (debounced, so toggling
	 * several checkboxes triggers a single load): only the extension knows which change refs to
	 * inject for the new filter, and its response also carries the event timelines of the changes
	 * that became visible — they ride along the visible states only.
	 */
	public applyGerritFilterChange(): void {
		this.ctx().store.invalidateRender();
		if (this.gerritFilterRefreshTimer !== null) window.clearTimeout(this.gerritFilterRefreshTimer);
		this.gerritFilterRefreshTimer = window.setTimeout(() => {
			this.gerritFilterRefreshTimer = null;
			this.refreshCommitsOnly();
		}, 120);
	}
}

/**
 * The error display of the load pipeline: the dialog half of a failed load. The machine decides
 * WHEN an error shows (the `showLoadError` effect) and whether the view is cleared around it
 * (`clearView` is a separate effect the applier runs first — the applier captures the
 * pre-collapse anchor up front whenever an error effect is coming, before the clear takes the
 * scroll position away).
 */

import { strings } from '../../common/i18n/index';
import { GraphContext } from '../context';
import type { Store } from '../state/store';

export class LoadErrors {
	constructor(private readonly ctx: () => GraphContext, private readonly retry: () => void) { }

	/**
	 * Show a load error with its retry action (the retry runs a hard refresh — the same path the
	 * refresh button takes). Also drops a pending deferred view load: whatever it waited for is
	 * gone with the failed cycle.
	 */
	public show(message: string, reason: string): void {
		const ctx = this.ctx();
		ctx.store.slices.repos.setLoadViewTo(null);
		ctx.dialog.showError(message, reason, strings.retryAction, () => this.retry());
	}

	/**
	 * Map the error of a `loadCommits` response: an empty repository reports `bad revision
	 * 'HEAD'` — against a view that has no branch list yet that is simply "no commits", not a
	 * failure to load.
	 */
	public static mapCommitsError(store: Store, error: string): string {
		return store.gitBranches.length === 0 && error.indexOf('bad revision \'HEAD\'') > -1
			? strings.noCommitsInRepo
			: error;
	}
}

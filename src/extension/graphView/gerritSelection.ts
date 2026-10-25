import type { GerritChangeState, GerritPatchsetsMode } from '../../types';

/**
 * The pure Gerrit ref/state selection math the staged loading pipeline needs (task 4.3), ported
 * verbatim from src/gerrit.ts. Importing that module here is impossible while it also carries the
 * `GerritDataSource` process code (its `evalPromises` util imports 'vscode', which would drag the
 * extension host into a module whose whole point is being unit-testable without it). When the
 * integrations/ split (Phase 5) extracts the pure helpers, this file should shrink to a re-export;
 * until then src/gerrit.ts remains the source of truth and the two must stay in lockstep - the
 * cases exercised here (through commitLoader.test.ts and this file's own tests) mirror the live
 * behavior.
 */

/**
 * The initial over-sampling factor of the Gerrit fetch: a change's status is only known once its
 * NoteDb meta has been fetched and parsed, so the fetch samples the most recent changes starting
 * at this multiple of the fetch limit, and deepens the sample (see `nextGerritSampleWindow`) while
 * too few of them pass the status filter, up to `GERRIT_FETCH_WINDOW_FACTOR_MAX`.
 */
export const GERRIT_FETCH_WINDOW_FACTOR = 4;

/**
 * The maximum over-sampling factor of the Gerrit fetch: the adaptive sampling may deepen the
 * window of most recent changes up to this multiple of the fetch limit, bounding the worst-case
 * cost on busy remotes (every sampled change costs a latest patchset and a NoteDb meta ref,
 * fetched and parsed on every refresh) of a status filter that few of the recent changes pass.
 */
export const GERRIT_FETCH_WINDOW_FACTOR_MAX = 16;

/** A parsed Gerrit change reference (see {@link parseChangeRef}). */
export interface ParsedChangeRef {
	change: number;
	patchset?: number;
	meta: boolean;
}

const CHANGE_REF_REGEX = /(?:^|\/)changes\/\d+\/(\d+)\/(meta|\d+)$/;

/**
 * Parse a Gerrit change reference (either a remote change ref such as `refs/changes/24/41466/1`
 * or `refs/remotes/origin/changes/24/41466/1`, or a NoteDb meta ref such as
 * `refs/changes/24/41466/meta`).
 * @param ref The reference to parse.
 * @returns The parsed change ref, or NULL if the reference isn't a change ref.
 */
export function parseChangeRef(ref: string): ParsedChangeRef | null {
	const match = CHANGE_REF_REGEX.exec(ref);
	if (match === null) return null;
	const change = parseInt(match[1], 10);
	if (!isFinite(change) || change <= 0) return null;
	return match[2] === 'meta'
		? { change: change, meta: true }
		: { change: change, patchset: parseInt(match[2], 10), meta: false };
}

/**
 * Get the two digit shard of a change number (e.g. 41466 -> "66", 5 -> "05").
 */
export function changeShard(change: number) {
	return ('0' + (change % 100)).slice(-2);
}

/**
 * Select the changes to fetch, keeping only the latest `limit` changes (by change number).
 * @param changes The map of changes to their patchsets.
 * @param limit The maximum number of changes to keep (<= 0 => keep all).
 */
export function limitChanges(changes: Map<number, number[]>, limit: number) {
	if (limit <= 0 || changes.size <= limit) return changes;
	const numbers = Array.from(changes.keys()).sort((a, b) => b - a).slice(0, limit);
	const limited = new Map<number, number[]>();
	for (const change of numbers) limited.set(change, changes.get(change)!);
	return limited;
}

/**
 * Build the fetch refspecs for a set of changes (including their NoteDb meta refs).
 * @param changes The map of changes to their patchsets.
 * @param remote The remote to fetch from.
 * @param patchsetMode Should all patchsets be fetched, or only the latest per change.
 * @returns The array of refspecs.
 */
export function buildFetchRefspecs(changes: Map<number, number[]>, remote: string, patchsetMode: GerritPatchsetsMode) {
	const refspecs: string[] = [];
	for (const [change, patchsets] of changes) {
		const shard = changeShard(change);
		const keep = patchsetMode === 'all' ? patchsets : [patchsets[patchsets.length - 1]];
		for (const patchset of keep) {
			refspecs.push('+refs/changes/' + shard + '/' + change + '/' + patchset + ':refs/remotes/' + remote + '/changes/' + shard + '/' + change + '/' + patchset);
		}
		refspecs.push('+refs/changes/' + shard + '/' + change + '/meta:refs/remotes/' + remote + '/changes/' + shard + '/' + change + '/meta');
	}
	return refspecs;
}

/**
 * Filter change states by the status filter.
 * @param states The change states.
 * @param filter The status filter.
 * @returns The states that pass the filter.
 */
export function filterChangeStates(states: GerritChangeState[], filter: { new: boolean; merged: boolean; abandoned: boolean; wip: boolean }) {
	return states.filter((state) => {
		if (state.wip) return filter.wip;
		return filter[state.status];
	});
}

/**
 * The Gerrit changes the fetch limit selects: the `limit` most recent changes (by change number)
 * that pass the status filter. Their latest patchset refs are injected into the graph, which pins
 * their commits onto the page — one badge per change number / patchset, so the number set is the
 * number of badges shown. The fetch itself over-samples the most recent changes and deepens the
 * sample adaptively (see `nextGerritSampleWindow`) precisely so that this post-filter selection
 * has `limit` changes to choose from.
 * @param states The change states (e.g. all states of a Gerrit cache entry).
 * @param filter The status filter.
 * @param limit The fetch limit (<= 0 => keep every passing change).
 * @returns The selected states, the most recent first.
 */
export function limitChangeStates(states: GerritChangeState[], filter: { new: boolean; merged: boolean; abandoned: boolean; wip: boolean }, limit: number): GerritChangeState[] {
	const passing = filterChangeStates(states, filter).sort((a, b) => b.change - a.change);
	return limit > 0 ? passing.slice(0, limit) : passing;
}

/**
 * The Gerrit changes whose badge IS displayed on a loaded page: the `limit` most recent changes
 * passing the status filter AND whose head commit has a row on the page — the `limitChangeStates`
 * selection, minus any change whose injected ref did not bring its commit onto the page (a ref
 * that does not resolve, a patchset commit missing locally). A change without a row has nothing to
 * carry its badge, so it must not claim one of the `limit` badge slots. The extension (per loaded
 * page) and the Webview (per render) apply this same selection, so they always agree on the badges.
 * @param states The change states (e.g. all states of a Gerrit cache entry).
 * @param filter The status filter.
 * @param limit The fetch limit (<= 0 => keep every passing change on the page).
 * @param onPage Whether a head commit has a row on the page.
 * @returns The displayed states, the most recent first.
 */
export function selectDisplayedChangeStates(states: GerritChangeState[], filter: { new: boolean; merged: boolean; abandoned: boolean; wip: boolean }, limit: number, onPage: (headHash: string) => boolean): GerritChangeState[] {
	const displayed = limitChangeStates(states, filter, 0).filter((state) => onPage(state.headHash));
	return limit > 0 ? displayed.slice(0, limit) : displayed;
}

/**
 * The next window of the adaptive Gerrit sampling: while fewer than `fetchLimit` of the sampled
 * changes pass the status filter, the window of the most recent changes (by change number)
 * doubles — the changes worth displaying can only be discovered by sampling deeper, because a
 * change's status is only known once its NoteDb meta has been fetched and parsed.
 * @param window The number of most recent changes sampled so far.
 * @param passing The number of sampled changes passing the status filter.
 * @param fetchLimit The display limit: the number of passing changes the sampling aims for.
 * @param remoteCount The total number of changes the remote offers.
 * @returns The next window to sample, or NULL when sampling is complete (enough passing changes
 *          collected, the remote exhausted, or the `GERRIT_FETCH_WINDOW_FACTOR_MAX` cap reached).
 */
export function nextGerritSampleWindow(window: number, passing: number, fetchLimit: number, remoteCount: number): number | null {
	if (fetchLimit > 0 && passing >= fetchLimit) return null;
	if (window >= remoteCount) return null;
	const cap = fetchLimit > 0 ? fetchLimit * GERRIT_FETCH_WINDOW_FACTOR_MAX : GERRIT_FETCH_WINDOW_FACTOR_MAX;
	if (window >= cap) return null;
	return Math.min(remoteCount, cap, Math.max(window * 2, 1));
}

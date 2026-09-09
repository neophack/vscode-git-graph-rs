/* Gerrit Integration Types */

export type GerritChangeEventType = 'created' | 'patchset' | 'vote' | 'merged' | 'abandoned' | 'restored' | 'wip' | 'ready' | 'comment';

export interface GerritChangeEvent {
	type: GerritChangeEventType;
	patchset: number;
	reviewer?: string; // e.g. "Gerrit User 1000018"
	labels?: { name: string; value: number }[]; // e.g. [{ name: 'Code-Review', value: +2 }]
	timestamp: number;
	raw: string;
	rawFull: string; // the verbatim NoteDb meta commit message (shown when the event is expanded)
}

export type GerritChangeStatus = 'new' | 'merged' | 'abandoned';

export interface GerritChangeState {
	change: number;
	patchset: number; // latest patchset
	codeReview: number; // -2..2, the vote with the greatest absolute value (most recent wins ties)
	verified: number; // -1..1
	status: GerritChangeStatus;
	wip: boolean;
	headHash: string; // code commit of the latest patchset (badge/anchor target)
	events: GerritChangeEvent[];
	/**
	 * True while the event timelines are still on their way: the staged Gerrit load sends the
	 * light part of the states (everything the badges show) first, and the timelines last. A
	 * review dialog opened in between shows a loading hint instead of an empty timeline.
	 */
	eventsPending?: boolean;
	url: string | null; // change web URL (derived from the remote URL), NULL => unknown
}

/** Which change statuses are displayed in the Git Graph View (WIP overrides the status). */
export interface GerritStatusFilter {
	new: boolean;
	merged: boolean;
	abandoned: boolean;
	wip: boolean;
}

export type GerritPatchsetsMode = 'latest' | 'all';

/** The `gerrit.*` Extension Settings the extension host consumes. */
export interface GerritConfig {
	remote: string;
	fetchLimit: number;
	showReviewProgress: boolean;
}

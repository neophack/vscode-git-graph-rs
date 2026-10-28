/**
 * The page-level load diagnostics: the load lifecycle's observable truth, mirrored onto the
 * page's <body> data attributes as it changes. An automation page step (or a developer in the
 * devtools console) can then distinguish "no refresh push arrived", "a push arrived but the
 * machine dropped the response" and "responses applied but the rows did not move" — the states
 * a rendered-table-only assertion cannot tell apart. Attributes:
 *
 * - `data-gg-refresh-cycles` — how many refresh cycles were started (the host's `refresh`
 *   push and the user's Refresh control both enter through RepoLoader.refresh);
 * - `data-gg-load-state` — the load machine's current state label (stateLabel);
 * - `data-gg-load-drops` — how many lifecycle events the machine dropped;
 * - `data-gg-load-drop-last` — the last drop's event, reason and state detail;
 * - `data-gg-commits-applied` — how many commit responses were actually applied to the view.
 */

interface BodyAttributeTarget {
	setAttribute(name: string, value: string): void;
}

/**
 * The <body> element, or NULL where there is no page (the unit tests run without a DOM; the
 * diagnostics are then collected but not mirrored).
 */
function body(): BodyAttributeTarget | null {
	if (typeof document === 'undefined') return null;
	return document.body;
}

/** The counters behind the attributes (readable in tests without a DOM). */
const counters = {
	refreshCycles: 0,
	drops: 0,
	commitsApplied: 0
};

/** How many history entries the ring keeps (a page step reads one attribute; no unbounded growth). */
const HISTORY_LIMIT = 40;

/** The recent lifecycle, oldest first: '<event/id> -> <state label>' lines plus drop records. */
const history: string[] = [];

/** Append one history line and mirror the ring onto the page (oldest entries fall off). */
function noteHistory(line: string): void {
	history.push(line);
	if (history.length > HISTORY_LIMIT) history.shift();
	setAttribute('data-gg-load-history', history.join(' | '));
}

/** The drop record the machine reports (the fields of loadMachine's DropRecord this needs). */
export interface LoadDropRecord {
	readonly event: string;
	readonly reason: string;
	readonly detail: string;
}

/** Set one diagnostic attribute when a page exists (the pre-ES2020 webview target: no chaining). */
function setAttribute(name: string, value: string): void {
	const target = body();
	if (target !== null) target.setAttribute(name, value);
}

/** One refresh cycle started (the host's `refresh` push, the Refresh control, a filter change). */
export function noteRefreshCycle(): void {
	counters.refreshCycles++;
	setAttribute('data-gg-refresh-cycles', String(counters.refreshCycles));
}

/** Mirror the machine's new state after every dispatch, with the event that caused it. */
export function noteLoadState(label: string, event: string): void {
	noteHistory(event + ' -> ' + label);
	setAttribute('data-gg-load-state', label);
}

/** One dropped lifecycle event: counted, kept in the history, and the last one kept readable. */
export function noteDrop(drop: LoadDropRecord): void {
	counters.drops++;
	noteHistory('DROP ' + drop.event + ' (' + drop.reason + '): ' + drop.detail);
	setAttribute('data-gg-load-drops', String(counters.drops));
	setAttribute('data-gg-load-drop-last', drop.event + ' (' + drop.reason + '): ' + drop.detail);
}

/**
 * One commit response applied to the view (the machine accepted it and its payload applied).
 * The summary mirrors the payload's own truth — how many commits, which head it names, whether
 * that head is among the commits, and the first hash — so "the response applied" and "the
 * response was FRESH" are separately observable (a stale-engine response applies just as
 * happily as a fresh one; the row count alone cannot tell them apart).
 */
export function noteCommitsApplied(summary: { count: number; head: string | null; headInList: boolean; first: string | null; headIndex: number; secondSubject: string | null }): void {
	counters.commitsApplied++;
	setAttribute('data-gg-commits-applied', String(counters.commitsApplied));
	setAttribute('data-gg-last-commits',
		'n=' + summary.count
		+ ' head=' + (summary.head === null ? 'null' : summary.head.slice(0, 8))
		+ ' inList=' + summary.headInList
		+ ' headIdx=' + summary.headIndex
		+ ' first=' + (summary.first === null ? 'null' : summary.first.slice(0, 8))
		+ ' second=' + (summary.secondSubject === null ? 'null' : summary.secondSubject.slice(0, 40)));
}

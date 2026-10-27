/**
 * The performance-trace message of the Git Graph view protocol:
 * the webview reports its collected performance marks (src/shared/perf/trace.ts) to the host
 * in ONE message after the T5 marker. This is deliberately NOT part of the graph-view request
 * map (shared/protocol/graphView.ts): the panel consumes it before the handler table, so it
 * has no entry in GraphViewRequests and no handler of its own.
 */

import type { BaseMessage } from './messages';

/** One performance mark collected in the webview: the marker name and the webview clock's `performance.now()` (its own epoch). */
export interface WebviewTraceMark {
	readonly name: string;
	readonly t: number;
}

/** The webview's collected marks (T2 script start, T4 data received, T5 rAF after first rows), sent once after T5; the host appends them to its 20-trace ring buffer. No response is sent. */
export interface RequestWebviewTraces extends BaseMessage {
	readonly command: 'webviewTraces';
	readonly marks: ReadonlyArray<WebviewTraceMark>;
}

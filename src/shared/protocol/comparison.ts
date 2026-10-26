/**
 * The host↔webview protocol of the Commit Comparison View (REFACTOR-PLAN task 6.1).
 *
 * This is a mechanical typing layer over the messages `src/comparisonView.ts` and its embedded
 * script have always exchanged — the command names and payload shapes are unchanged. One pair is
 * added by the frontend extraction itself: the `ready` / `init` boot handshake, which replaces the
 * file changes and commit summaries the host used to bake into the page's inline script (no inline
 * scripts are served any more, so that data now arrives as a message).
 *
 * The view also embeds the binary comparison area for binary files, so its request and response
 * unions include the whole of `binaryCompare.ts`'s protocol.
 */

import type { GitFileChange, GitLineCounts } from '../model/git';
import type { BinaryCompareRequest, BinaryCompareResponse } from './binaryCompare';

/** The boot signal of the extracted frontend: the page's script has loaded and is listening. */
export interface ComparisonReadyRequest {
	readonly command: 'ready';
}

/** The boot data of the Commit Comparison View page. */
export interface ComparisonInitResponse {
	readonly command: 'init';
	/** The compared file changes (empty when the comparison failed). */
	readonly changes: ReadonlyArray<GitFileChange>;
	/** The two ends of the comparison (UNCOMMITTED '*' or '' for the working tree). */
	readonly fromHash: string;
	readonly toHash: string;
	/** Whether the +N/-M line counts can be requested at all (false against the working tree). */
	readonly countsPossible: boolean;
	/** Whether the header presents the changes as those of `toHash` alone (the "Open Changes"
	 *  presentation) instead of pairing both ends of the comparison. */
	readonly singleCommit: boolean;
	/** The summaries of the commits shown in the header, by hash (empty while none resolved). */
	readonly summaries: { readonly [hash: string]: ComparisonCommitSummary };
	/** The number of commits strictly between the two ends, or NULL when undeterminable. */
	readonly commitsBetween: number | null;
	/** The error that replaced the comparison, or NULL when it loaded. */
	readonly error: string | null;
	/** The interface language the host rendered the page for ('en' or 'zh-cn'). */
	readonly language: string;
}

/** One commit description card of the header, as `getCommitSummaries` returns them. */
export interface ComparisonCommitSummary {
	readonly hash: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

export interface GetFileDiffRequest {
	readonly command: 'getFileDiff';
	readonly index: number;
}

export interface ViewDiffRequest {
	readonly command: 'viewDiff';
	readonly index: number;
}

export interface ViewDiffBinaryRequest {
	readonly command: 'viewDiffBinary';
	readonly index: number;
}

export interface RequestCountsRequest {
	readonly command: 'requestCounts';
	readonly paths: ReadonlyArray<string>;
}

export interface FileDiffResponse {
	readonly command: 'fileDiff';
	readonly index: number;
	readonly diff: string | null;
	readonly error: string | null;
}

export interface LineCountsResponse {
	readonly command: 'lineCounts';
	readonly counts: { readonly [path: string]: GitLineCounts };
}

/** Every message the Commit Comparison View sends to the extension host. */
export type ComparisonRequest =
	| ComparisonReadyRequest
	| GetFileDiffRequest
	| ViewDiffRequest
	| ViewDiffBinaryRequest
	| RequestCountsRequest
	| BinaryCompareRequest;

/** Every message the extension host sends to the Commit Comparison View. */
export type ComparisonResponse =
	| ComparisonInitResponse
	| FileDiffResponse
	| LineCountsResponse
	| BinaryCompareResponse;

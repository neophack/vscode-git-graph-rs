/**
 * The call surface of the Commit Details View: what the rest of the view may invoke on it. The
 * view joins the page lazily (widgets/lazy.ts) — its module sits OUTSIDE the first-paint bundle
 * and loads through dynamic import() on the first commit a user expands — so the surface is
 * exactly the API that must work before, during and after that load.
 *
 * The semantics of a not-yet-loaded view follow the on-demand widgets' rule (widgets/surfaces.ts):
 * a view that has not loaded is by definition not open — `isOpen` answers FALSE, `openElem` is
 * NULL, `close` / `closeComparison` / `closeContextMenuIfOpen` / `renderExternalDiffBtn` are
 * no-ops, and every response handler (`showDetails`, `showComparison`, `startCodeReview`,
 * `lineCounts.apply`) drops its message: only the loaded view ever issues the requests those
 * responses answer, so an earlier response cannot be for it. `load` and `loadComparison` are the
 * first uses that trigger the load (warm after the idle prefetch).
 *
 * The store's `expandedCommit` upholds the invariant this rests on: it is written ONLY by the
 * loaded view's own open path (CommitDetails.saveExpandedCommitLoading), so every caller that
 * reads a synchronous open-view fact (`openElem`, an expanded-commit re-request) runs at a point
 * where the module is already loaded.
 */

import type * as GG from '../../common/protocol';
import type { ExpandedCommit } from '../state/types';

/** The line-count half of the view (see {@link LineCounts}): the responses and the scroll hook. */
export interface LineCountsSurface {
	/** Apply a `commitFileCounts` response (dropped before the module has loaded: only it asks). */
	apply(msg: GG.ResponseCommitFileCounts): void;
	/** Settle the counts of the files near the viewport again after a scroll or a re-render. */
	scheduleVisible(): void;
}

/**
 * The Commit Details View's surface (see {@link CommitDetails} for the implementation): the
 * panel that expands a commit — or a comparison of two commits — under its row, docked to the
 * bottom of the view, or as a full-screen sheet in the mobile layout.
 */
export interface CommitDetailsSurface {
	/** The deferred line counts of the open view's file list. */
	readonly lineCounts: LineCountsSurface;
	/** The open view's element (#cdv), or NULL while the view is closed or the module is loading. */
	readonly openElem: HTMLElement | null;
	/** Open the Commit Details View of the commit whose row is `commitElem`. */
	load(commitElem: HTMLElement): void;
	/** Open the Commit Comparison of two commits inline. */
	loadComparison(commitElem: HTMLElement, compareWithElem: HTMLElement): void;
	/** Close the open Commit Details View (or Commit Comparison). */
	close(saveAndRender: boolean): void;
	/** Close the Commit Comparison, optionally returning to the Commit Details View of the first commit. */
	closeComparison(saveAndRequestCommitDetails: boolean): void;
	/** Is the Commit Details View (or Comparison) of exactly these commits open. */
	isOpen(commitHash: string, compareWithHash: string | null): boolean;
	/**
	 * The details of a commit arrived: show them (a `commitDetails` response). The file tree of
	 * the changed files is built inside the view, so a response carries no view-side product.
	 */
	showDetails(commitDetails: GG.GitCommitDetails, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean): void;
	/** The changes between two commits arrived: show them (a `compareCommits` response). */
	showComparison(commitHash: string, compareWithHash: string, fileChanges: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean): void;
	/** Ask the host for the details of a commit (re-issues only happen for an already-open view). */
	requestCommitDetails(hash: string, refresh: boolean): void;
	/** Ask the host for the changes between two commits (re-issues only happen for an open view). */
	requestCommitComparison(hash: string, compareWithHash: string, refresh: boolean): void;
	/** Open the changes between two commits in a dedicated Commit Comparison View tab. */
	openCompareTab(hash: string, compareWithHash: string, singleCommit?: boolean): void;
	/** The element the file list scrolls in: #cdvFiles, or #cdvContent in the touch layouts. */
	getFilesScrollElemId(): string;
	/** Reflect the configured external diff tool on the external diff button (a no-op while closed). */
	renderExternalDiffBtn(): void;
	/** Close the open context menu if it belongs to this view. */
	closeContextMenuIfOpen(expandedCommit: ExpandedCommit): void;
	/** Toggle one folder row of the file tree in the DOM (its icon, and its contents). */
	toggleFolder(folderElem: HTMLElement): void;
	/** Update the reviewed / last-viewed state of a file in the open view. */
	updateFileState(file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean): void;
	/** A code review was started (a `startCodeReview` response). */
	startCodeReview(commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview): void;
	/** Tear the view down (F3): removes its listeners. The real view carries it (Component); the facade forwards it once the module has loaded. */
	dispose(): void;
}

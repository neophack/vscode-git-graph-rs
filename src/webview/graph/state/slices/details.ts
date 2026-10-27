/**
 * The details slice: the open Commit Details View / Commit Comparison -
 * which commit (compared with which other) is open, the data its panel shows, and its transient
 * bookkeeping (scroll positions, context-menu flags, the deferred line counts). The ONLY writer
 * of the `expandedCommit` field is this class; every change leaves as a typed
 * `SliceChange<'details'>`.
 *
 * Emission discipline: NONE of the actions emit. The view's panel is rendered by its own
 * component (`CommitDetails.render`), the table learns of an open/close through the same response
 * or user action that drives it (commitPage closes the view before its renderSync), and the view's
 * bookkeeping (scroll, context-menu flags, entered animation, line counts) is read back by the
 * component that wrote it - an emission could only schedule renders the view never used to do.
 * The `lineCounts` state and the received `fileChanges` objects are the details subsystem's
 * working caches: its module (commitDetails/, lineCounts.ts) mutates them in place - the slice
 * owns the FIELD, not the interior of the caches.
 */

import * as GG from '../../../common/protocol';
import { ExpandedCommit } from '../types';

/** The fields of the open view a details response fills in (the panel's data). */
export type DetailsResponseData = Partial<Pick<ExpandedCommit,
	'commitDetails' | 'fileChanges' | 'fileTree' | 'avatar' | 'codeReview' | 'lastViewedFile' | 'loading'>>;

export class DetailsSlice {
	private expandedCommitValue: ExpandedCommit | null = null;

	constructor() { }


	/* Reads */

	/** The commit whose Commit Details View (or Commit Comparison) is open. */
	public get expanded(): ExpandedCommit | null {
		return this.expandedCommitValue;
	}


	/* Actions */

	/** Open the view for a commit (or a comparison of two), in its loading state. */
	public open(view: ExpandedCommit): void {
		this.expandedCommitValue = view;
	}

	/** Close the open view (if any). */
	public close(): void {
		this.expandedCommitValue = null;
	}

	/** Apply the data a details/comparison response filled in (fields absent = unchanged). */
	public applyResponseData(data: DetailsResponseData): void {
		const expanded = this.expandedCommitValue;
		if (expanded === null) return;
		if ('commitDetails' in data) expanded.commitDetails = data.commitDetails !== undefined ? data.commitDetails : null;
		if ('fileChanges' in data) expanded.fileChanges = data.fileChanges !== undefined ? data.fileChanges : null;
		if ('fileTree' in data) expanded.fileTree = data.fileTree !== undefined ? data.fileTree : null;
		if ('avatar' in data) expanded.avatar = data.avatar !== undefined ? data.avatar : null;
		if ('codeReview' in data) expanded.codeReview = data.codeReview !== undefined ? data.codeReview : null;
		if ('lastViewedFile' in data) expanded.lastViewedFile = data.lastViewedFile !== undefined ? data.lastViewedFile : null;
		if ('loading' in data) expanded.loading = data.loading !== undefined ? data.loading : false;
	}

	/** The entrance animation has played for this open view (suppress it on later re-renders). */
	public markEntered(): void {
		if (this.expandedCommitValue === null) return;
		this.expandedCommitValue.entered = true;
	}

	/** Toggle the Markdown rendering of the message body. */
	public toggleMarkdown(): void {
		const expanded = this.expandedCommitValue;
		if (expanded === null) return;
		expanded.showMarkdown = !expanded.showMarkdown;
	}

	/** Record the file the open view last looked at (restored when the view reopens). */
	public setLastViewedFile(path: string): void {
		if (this.expandedCommitValue === null) return;
		this.expandedCommitValue.lastViewedFile = path;
	}

	/** Replace the open view's code review state (a Gerrit response). */
	public setCodeReview(codeReview: GG.CodeReview | null): void {
		if (this.expandedCommitValue === null) return;
		this.expandedCommitValue.codeReview = codeReview;
	}

	/** Record a panel's scroll position (the summary pane or the file view). */
	public setScroll(panel: 'summary' | 'fileView', scrollTop: number): void {
		const expanded = this.expandedCommitValue;
		if (expanded === null) return;
		expanded.scrollTop[panel] = scrollTop;
	}

	/** Record whether a context menu is open over the summary pane. */
	public setContextMenuSummaryOpen(open: boolean): void {
		if (this.expandedCommitValue === null) return;
		this.expandedCommitValue.contextMenuOpen.summary = open;
	}

	/** Record which file view row a context menu is open over (-1 = none). */
	public setContextMenuFileView(index: number): void {
		if (this.expandedCommitValue === null) return;
		this.expandedCommitValue.contextMenuOpen.fileView = index;
	}

	/** Reset the deferred line counts for the file list that just arrived. */
	public resetLineCounts(lineCounts: ExpandedCommit['lineCounts']): void {
		const expanded = this.expandedCommitValue;
		if (expanded === null) return;
		expanded.lineCounts = lineCounts;
	}

	/** The open view's deferred line counts, for the subsystem that owns their content. */
	public get lineCounts(): ExpandedCommit['lineCounts'] | null {
		return this.expandedCommitValue !== null ? this.expandedCommitValue.lineCounts : null;
	}

	/** Flag a background line-count batch as in flight (or settled). */
	public setLineCountsChunkInFlight(inFlight: boolean): void {
		if (this.expandedCommitValue === null) return;
		this.expandedCommitValue.lineCounts.chunkInFlight = inFlight;
	}

	/** Record the debounce timer of a scroll-triggered line-count request. */
	public setLineCountsScrollTimer(timer: number): void {
		if (this.expandedCommitValue === null) return;
		this.expandedCommitValue.lineCounts.scrollTimer = timer;
	}

	/**
	 * Relink the open view to the rows it belongs to (written during a render: the row elements
	 * and the index the current window gave them). Emits nothing - no renderer consumes it.
	 */
	public relink(index: number, commitElem: HTMLElement, compareWithElem: HTMLElement | null): void {
		const expanded = this.expandedCommitValue;
		if (expanded === null) return;
		expanded.index = index;
		expanded.commitElem = commitElem;
		expanded.compareWithElem = compareWithElem;
	}
}

/**
 * The commits slice (OPTIMIZATION-PLAN §6 F1): the loaded commit page and everything derived
 * from it - the hash→index lookup (a `Map`, built by and kept in sync ONLY by this slice's
 * actions; before F1 it was a plain object whose consistency with `commits` was every caller's
 * job), the page's HEAD, the paging bookkeeping, the author avatars, and the render bookkeeping
 * ("which HEAD the rendered rows were built for").
 *
 * Emission discipline: `replacePage` and `clear` emit page-level changes - the response
 * application's own changes, satisfied by the response's render pass, and the (old, new) page
 * pair is what the keyed row patching of task 5.10 will diff by hash. Everything else is silent:
 * `patchUncommittedRow` is followed by the caller's own in-place row patch
 * (`renderUncommittedChanges`), which EXISTS so the row is never rebuilt - an emission here would
 * schedule exactly that rebuild; avatars patch their rows in place; the rendered-HEAD record is
 * written DURING a render; the paging/count fields feed requests and persistence, not the rows.
 */

import * as GG from '../../../common/protocol';
import { EmitChange, SliceChange } from '../changes';

/** A commit page to install: the commits, their HEAD, and the paging flags the page was built under. */
export interface CommitPage {
	readonly commits: GG.GitCommit[];
	readonly head: string | null;
	readonly moreCommitsAvailable: boolean;
	readonly onlyFollowFirstParent: boolean;
}

export class CommitsSlice {
	private commitsValue: GG.GitCommit[] = [];
	private commitHeadValue: string | null = null;
	private readonly commitLookupValue: Map<string, number> = new Map<string, number>();
	private onlyFollowFirstParentValue: boolean = false;
	private moreCommitsAvailableValue: boolean = false;
	private maxCommitsValue: number;
	private uncommittedCountValue: number | null = null;
	/** The branch the rendered rows were built for (a change forces a re-render of the rows). */
	private renderedGitBranchHeadValue: string | null = null;
	private avatarsValue: { [email: string]: string } = {};

	constructor(
		initialState: GG.GitGraphViewInitialState,
		private readonly emit: EmitChange<SliceChange<'commits'>>
	) {
		this.maxCommitsValue = initialState.config.initialLoadCommits;
	}


	/* Reads */

	public get page(): GG.GitCommit[] {
		return this.commitsValue;
	}

	public get head(): string | null {
		return this.commitHeadValue;
	}

	/** The hash → row index of the loaded page (owned and rebuilt by this slice's actions). */
	public get lookup(): ReadonlyMap<string, number> {
		return this.commitLookupValue;
	}

	public get onlyFollowFirstParent(): boolean {
		return this.onlyFollowFirstParentValue;
	}

	public get moreCommitsAvailable(): boolean {
		return this.moreCommitsAvailableValue;
	}

	public get maxCommits(): number {
		return this.maxCommitsValue;
	}

	/**
	 * The "Uncommitted Changes" file count the view last knew about (NULL => not known yet, no
	 * final follow-up has arrived). Kept as view state so the row can be kept rendered (and its
	 * number updated in place) across responses whose commit list doesn't carry the row.
	 */
	public get uncommittedCount(): number | null {
		return this.uncommittedCountValue;
	}

	public get avatars(): { [email: string]: string } {
		return this.avatarsValue;
	}

	/** The index of a loaded commit, or NULL. */
	public indexOf(hash: string): number | null {
		const index = this.commitLookupValue.get(hash);
		return typeof index === 'number' ? index : null;
	}

	/** A loaded commit, or undefined. */
	public getCommit(hash: string): GG.GitCommit | undefined {
		const index = this.commitLookupValue.get(hash);
		return index !== undefined ? this.commitsValue[index] : undefined;
	}

	/** Which of two loaded commits is older (`from`) and which newer (`to`). */
	public getCommitOrder(hash1: string, hash2: string): { from: string, to: string } {
		const first = this.commitLookupValue.get(hash1), second = this.commitLookupValue.get(hash2);
		// An unknown hash never counts as "older" (the plain-object lookup compared `undefined`,
		// which every `>` comparison answered false - identical outcomes here).
		if (first !== undefined && second !== undefined && first > second) {
			return { from: hash1, to: hash2 };
		}
		return { from: hash2, to: hash1 };
	}


	/* Actions */

	/**
	 * Install a commit page and rebuild the lookup with it (the ONLY place the lookup is written).
	 */
	public replacePage(page: CommitPage): void {
		this.commitsValue = page.commits;
		this.commitHeadValue = page.head;
		this.onlyFollowFirstParentValue = page.onlyFollowFirstParent;
		this.moreCommitsAvailableValue = page.moreCommitsAvailable;
		this.rebuildLookup();
		this.emit({ slice: 'commits', keys: ['page', 'head', 'lookup', 'moreAvailable'] });
	}

	/** Empty the page (a repository switch, a hard refresh, an error). */
	public clear(): void {
		this.commitsValue = [];
		this.commitHeadValue = null;
		this.moreCommitsAvailableValue = false;
		this.commitLookupValue.clear();
		this.emit({ slice: 'commits', keys: ['page', 'head', 'lookup', 'moreAvailable'] });
	}

	/**
	 * Patch the "Uncommitted Changes" row in place (the seamless update's row refresh): the page
	 * is otherwise untouched, and nothing is emitted - the caller renders the row's new number
	 * with `renderUncommittedChanges`, which is what keeps the row's DOM node (see the seamless
	 * update). @param commit The replacement row (the page's first entry).
	 */
	public patchUncommittedRow(commit: GG.GitCommit): void {
		this.commitsValue[0] = commit;
	}

	/** Record the exact "Uncommitted Changes" count (a final follow-up, a snapshot seed). */
	public setUncommittedCount(count: number | null): void {
		this.uncommittedCountValue = count;
	}

	/** Set the page size the next commits request asks for (a filter reset, load-more, a jump). */
	public setMaxCommits(maxCommits: number): void {
		this.maxCommitsValue = maxCommits;
	}

	/** Record an author avatar (an author avatar response; the rows patch themselves in place). */
	public setAvatar(email: string, image: string): void {
		this.avatarsValue[email] = image;
	}

	/** Record which branch HEAD the rendered rows were built for (written during a render). */
	public markRenderedHead(head: string | null): void {
		this.renderedGitBranchHeadValue = head;
	}

	/** The branch the rendered rows were built for. */
	public get renderedHead(): string | null {
		return this.renderedGitBranchHeadValue;
	}

	/** Rebuild the hash → index lookup from the current page. */
	private rebuildLookup(): void {
		this.commitLookupValue.clear();
		for (let i = 0; i < this.commitsValue.length; i++) {
			this.commitLookupValue.set(this.commitsValue[i].hash, i);
		}
	}
}

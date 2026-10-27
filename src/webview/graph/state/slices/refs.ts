/**
 * The refs slice (OPTIMIZATION-PLAN §6 F1): the current repository's refs (branches, HEAD,
 * remotes, stashes, tags), its git configuration, and the commit-query filters the dropdowns and
 * the path filter shape (branch selection, author selection, path filter). The ONLY writer of
 * these fields is this class. Emission discipline: the RESPONSE-application actions emit (their
 * changes route to the renderers the response's own render pass would run anyway, and feed the
 * keyed patcher); the query filters and the repo configuration emit nothing - no renderer reads
 * them through the scheduler (the dropdowns and the filter button are re-rendered explicitly by
 * the components that change them).
 *
 * The apply actions answer "did anything change" so the load pipeline keeps its unchanged-payload
 * short circuits (a repo-info response identical to the view's refs applies no change and forces
 * no re-render - the seamless update).
 */

import * as GG from '../../../common/protocol';
import { arraysStrictlyEqual } from '../../../common/util';
import { EmitChange, SliceChange } from '../changes';

/** The refs half of a `loadRepoInfo` response (or of a pushed `loadView`). */
export interface RefsInfo {
	readonly branches: ReadonlyArray<string>;
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
}

export class RefsSlice {
	private gitBranchesValue: ReadonlyArray<string> = [];
	private gitBranchHeadValue: string | null = null;
	private gitConfigValue: GG.GitRepoConfig | null = null;
	private gitRemotesValue: ReadonlyArray<string> = [];
	private gitStashesValue: ReadonlyArray<GG.GitStash> = [];
	private gitTagsValue: ReadonlyArray<string> = [];
	private currentBranchesValue: string[] | null = null;
	private currentAuthorsValue: string[] | null = null;
	private commitPathFilterValue: string | null = null;

	constructor(private readonly emit: EmitChange<SliceChange<'refs'>>) { }


	/* Reads */

	public get branches(): ReadonlyArray<string> {
		return this.gitBranchesValue;
	}

	public get head(): string | null {
		return this.gitBranchHeadValue;
	}

	public get repoConfig(): GG.GitRepoConfig | null {
		return this.gitConfigValue;
	}

	public get remotes(): ReadonlyArray<string> {
		return this.gitRemotesValue;
	}

	public get stashes(): ReadonlyArray<GG.GitStash> {
		return this.gitStashesValue;
	}

	public get tags(): ReadonlyArray<string> {
		return this.gitTagsValue;
	}

	/** The branches selected in the branches dropdown, NULL for "Show All". */
	public get branchSelection(): string[] | null {
		return this.currentBranchesValue;
	}

	/** The authors selected in the authors dropdown, NULL for "All Authors". */
	public get authorSelection(): string[] | null {
		return this.currentAuthorsValue;
	}

	/** The path filter applied to the loaded commits (persisted with the webview state). */
	public get pathFilter(): string | null {
		return this.commitPathFilterValue;
	}


	/* Actions */

	/** Replace the stash list (every `loadRepoInfo` response carries it; identical = no change). */
	public setStashes(stashes: ReadonlyArray<GG.GitStash>): void {
		if (arraysStrictlyEqual(this.gitStashesValue, stashes)) return;
		this.gitStashesValue = stashes;
		this.emit({ slice: 'refs', keys: ['stashes'] });
	}

	/** Replace the HEAD the view knows (a snapshot seed; the pushed repo info re-confirms it). */
	public setHead(head: string | null): void {
		if (this.gitBranchHeadValue === head) return;
		this.gitBranchHeadValue = head;
		this.emit({ slice: 'refs', keys: ['head'] });
	}

	/**
	 * Apply a repo-info payload's refs (branches, HEAD, remotes). @returns TRUE when anything
	 * changed (an identical payload is a no-op, exactly like the seamless update).
	 */
	public applyInfo(info: RefsInfo): boolean {
		const changed = !arraysStrictlyEqual(this.gitBranchesValue, info.branches)
			|| this.gitBranchHeadValue !== info.head
			|| !arraysStrictlyEqual(this.gitRemotesValue, info.remotes);
		if (!changed) return false;
		this.gitBranchesValue = info.branches;
		this.gitBranchHeadValue = info.head;
		this.gitRemotesValue = info.remotes;
		this.emit({ slice: 'refs', keys: ['branches', 'head', 'remotes'] });
		return true;
	}

	/**
	 * Apply a branch list that arrived with a `loadCommits` response (the complete list, once the
	 * remote-tracking refs were scanned). @returns TRUE when anything changed.
	 */
	public applyBranchList(branches: ReadonlyArray<string>): boolean {
		if (arraysStrictlyEqual(this.gitBranchesValue, branches)) return false;
		this.gitBranchesValue = branches;
		this.emit({ slice: 'refs', keys: ['branches'] });
		return true;
	}

	/** Replace the branches dropdown's selection (a no-op when already this array). */
	public setBranchSelection(branches: string[] | null): void {
		this.currentBranchesValue = branches;
	}

	/** Replace the authors dropdown's selection (a no-op when already this array). */
	public setAuthorSelection(authors: string[] | null): void {
		this.currentAuthorsValue = authors;
	}

	/** Set the path filter applied to the loaded commits (NULL = none; a no-op when unchanged). */
	public setPathFilter(filter: string | null): void {
		this.commitPathFilterValue = filter;
	}

	/** Replace the repository's git configuration (a `loadConfig` response). */
	public setRepoConfig(config: GG.GitRepoConfig): void {
		this.gitConfigValue = config;
	}

	/** Replace the tag list a commit page carried (dialog information only; identical = no change). */
	public setTags(tags: ReadonlyArray<string>): void {
		if (arraysStrictlyEqual(this.gitTagsValue, tags)) return;
		this.gitTagsValue = tags;
		this.emit({ slice: 'refs', keys: ['tags'] });
	}

	/** Drop everything a previous repository left behind (a repository switch). */
	public reset(): void {
		this.gitConfigValue = null;
		this.gitRemotesValue = [];
		this.gitStashesValue = [];
		this.gitTagsValue = [];
		this.currentBranchesValue = null;
		this.currentAuthorsValue = null;
		this.commitPathFilterValue = null;
	}
}

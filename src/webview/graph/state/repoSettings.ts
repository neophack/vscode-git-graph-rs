/**
 * The effective per-repository settings: a repository's own override (BooleanOverride / a
 * RepoCommitOrdering / a branch list) resolved against the Extension Settings it defaults to.
 */

import * as GG from '../../common/protocol';

export function getCommitOrdering(repoValue: GG.RepoCommitOrdering, config: GG.GitGraphViewConfig): GG.CommitOrdering {
	switch (repoValue) {
		case GG.RepoCommitOrdering.Default:
			return config.commitOrdering;
		case GG.RepoCommitOrdering.Date:
			return GG.CommitOrdering.Date;
		case GG.RepoCommitOrdering.AuthorDate:
			return GG.CommitOrdering.AuthorDate;
		case GG.RepoCommitOrdering.Topological:
			return GG.CommitOrdering.Topological;
	}
}

function resolve(repoValue: GG.BooleanOverride, defaultValue: boolean) {
	return repoValue === GG.BooleanOverride.Default ? defaultValue : repoValue === GG.BooleanOverride.Enabled;
}

export function getShowRemoteBranches(repoValue: GG.BooleanOverride, config: GG.GitGraphViewConfig) {
	return resolve(repoValue, config.showRemoteBranches);
}

export function getShowStashes(repoValue: GG.BooleanOverride, config: GG.GitGraphViewConfig) {
	return resolve(repoValue, config.showStashes);
}

export function getShowTags(repoValue: GG.BooleanOverride, config: GG.GitGraphViewConfig) {
	return resolve(repoValue, config.showTags);
}

export function getIncludeCommitsMentionedByReflogs(repoValue: GG.BooleanOverride, config: GG.GitGraphViewConfig) {
	return resolve(repoValue, config.includeCommitsMentionedByReflogs);
}

export function getOnlyFollowFirstParent(repoValue: GG.BooleanOverride, config: GG.GitGraphViewConfig) {
	return resolve(repoValue, config.onlyFollowFirstParent);
}

export function getOnRepoLoadShowCheckedOutBranch(repoValue: GG.BooleanOverride, config: GG.GitGraphViewConfig) {
	return resolve(repoValue, config.onRepoLoad.showCheckedOutBranch);
}

export function getOnRepoLoadShowSpecificBranches(repoValue: string[] | null, config: GG.GitGraphViewConfig) {
	return repoValue === null ? config.onRepoLoad.showSpecificBranches : repoValue;
}

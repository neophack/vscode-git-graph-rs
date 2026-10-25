import * as fs from 'fs';
import * as path from 'path';
import { t } from '../../i18n';
import { BooleanOverride, FileViewType, GitRepoState, PinnedCommit, PullRequestConfig, PullRequestConfigBase, PullRequestProvider, RepoCommitOrdering } from '../../types';
import { getPathFromStr } from '../../utils/paths';

/**
 * The External Repository Configuration File seam of the repository manager (REFACTOR-PLAN
 * §3.3 / Appendix A): everything that reads, writes, generates, validates and applies a
 * repository's `.vscode/git-graph-rs.json`. Extracted verbatim from the former flat
 * src/repoManager.ts so the file handling can be tested on its own.
 */

/** External Repo Config File */

export namespace ExternalRepoConfig {

	export const enum FileViewType {
		Tree = 'tree',
		List = 'list'
	}

	export interface IssueLinkingConfig {
		readonly issue: string;
		readonly url: string;
	}

	export const enum PullRequestProvider {
		Bitbucket = 'bitbucket',
		Custom = 'custom',
		GitHub = 'github',
		GitLab = 'gitlab'
	}

	interface PullRequestConfigBuiltIn extends PullRequestConfigBase {
		readonly provider: Exclude<PullRequestProvider, PullRequestProvider.Custom>;
		readonly custom: null;
	}

	interface PullRequestConfigCustom extends PullRequestConfigBase {
		readonly provider: PullRequestProvider.Custom;
		readonly custom: {
			readonly name: string,
			readonly templateUrl: string
		};
	}

	export type PullRequestConfig = PullRequestConfigBuiltIn | PullRequestConfigCustom;

	export interface File {
		commitOrdering?: RepoCommitOrdering;
		fileViewType?: FileViewType;
		hideRemotes?: string[];
		includeCommitsMentionedByReflogs?: boolean;
		issueLinkingConfig?: IssueLinkingConfig;
		name?: string | null;
		onlyFollowFirstParent?: boolean;
		onRepoLoadShowCheckedOutBranch?: boolean;
		onRepoLoadShowSpecificBranches?: string[];
		pinnedBranches?: string[];
		pinnedCommits?: PinnedCommit[];
		pullRequestConfig?: PullRequestConfig;
		showRemoteBranches?: boolean;
		showStashes?: boolean;
		showTags?: boolean;
		exportedAt?: number;
	}

}

/**
 * Reads the External Configuration File for a repository from the File System.
 * @param repo The path of the repository.
 * @returns A promise resolving to the parsed config file, or NULL if the file couldn't be read or parsed.
 */
export function readExternalConfigFile(repo: string) {
	return new Promise<Readonly<ExternalRepoConfig.File> | null>((resolve) => {
		fs.readFile(path.join(repo, '.vscode', 'git-graph-rs.json'), (err, data) => {
			if (err) {
				resolve(null);
			} else {
				try {
					const contents = JSON.parse(data.toString());
					resolve(typeof contents === 'object' ? contents : null);
				} catch (_) {
					resolve(null);
				}
			}
		});
	});
}

/**
 * Writes the External Configuration File of a repository to the File System.
 * @param repo The path of the repository.
 * @param file The file contents.
 * @returns A promise that resolves to a success message, or rejects to an error message.
 */
export function writeExternalConfigFile(repo: string, file: ExternalRepoConfig.File) {
	return new Promise<string>((resolve, reject) => {
		const vscodePath = path.join(repo, '.vscode');
		fs.mkdir(vscodePath, (err) => {
			if (!err || err.code === 'EEXIST') {
				const configPath = path.join(vscodePath, 'git-graph-rs.json');
				fs.writeFile(configPath, JSON.stringify(file, null, 4), (err) => {
					if (err) {
						reject(t('writeRepoConfigFailed', getPathFromStr(configPath)));
					} else {
						resolve(t('repoConfigExported', getPathFromStr(configPath)));
					}
				});
			} else {
				reject(t('checkVscodeDirFailed', getPathFromStr(vscodePath)));
			}
		});
	});
}

/**
 * Generate the External Config File's contents from the Git Repositories state.
 * @param state The state being exported.
 * @returns The file contents.
 */
export function generateExternalConfigFile(state: GitRepoState): Readonly<ExternalRepoConfig.File> {
	const file: ExternalRepoConfig.File = {};

	if (state.commitOrdering !== RepoCommitOrdering.Default) {
		file.commitOrdering = state.commitOrdering;
	}
	if (state.fileViewType !== FileViewType.Default) {
		switch (state.fileViewType) {
			case FileViewType.Tree:
				file.fileViewType = ExternalRepoConfig.FileViewType.Tree;
				break;
			case FileViewType.List:
				file.fileViewType = ExternalRepoConfig.FileViewType.List;
				break;
		}
	}
	if (state.hideRemotes.length > 0) {
		file.hideRemotes = state.hideRemotes;
	}
	if (state.includeCommitsMentionedByReflogs !== BooleanOverride.Default) {
		file.includeCommitsMentionedByReflogs = state.includeCommitsMentionedByReflogs === BooleanOverride.Enabled;
	}
	if (state.issueLinkingConfig !== null) {
		file.issueLinkingConfig = state.issueLinkingConfig;
	}
	if (state.name !== null) {
		file.name = state.name;
	}
	if (state.onlyFollowFirstParent !== BooleanOverride.Default) {
		file.onlyFollowFirstParent = state.onlyFollowFirstParent === BooleanOverride.Enabled;
	}
	if (state.onRepoLoadShowCheckedOutBranch !== BooleanOverride.Default) {
		file.onRepoLoadShowCheckedOutBranch = state.onRepoLoadShowCheckedOutBranch === BooleanOverride.Enabled;
	}
	if (state.onRepoLoadShowSpecificBranches !== null) {
		file.onRepoLoadShowSpecificBranches = state.onRepoLoadShowSpecificBranches;
	}
	file.pinnedBranches = state.pinnedBranches;
	file.pinnedCommits = state.pinnedCommits;
	if (state.pullRequestConfig !== null) {
		let provider: ExternalRepoConfig.PullRequestProvider;
		switch (state.pullRequestConfig.provider) {
			case PullRequestProvider.Bitbucket:
				provider = ExternalRepoConfig.PullRequestProvider.Bitbucket;
				break;
			case PullRequestProvider.Custom:
				provider = ExternalRepoConfig.PullRequestProvider.Custom;
				break;
			case PullRequestProvider.GitHub:
				provider = ExternalRepoConfig.PullRequestProvider.GitHub;
				break;
			case PullRequestProvider.GitLab:
				provider = ExternalRepoConfig.PullRequestProvider.GitLab;
				break;
		}
		file.pullRequestConfig = Object.assign({}, state.pullRequestConfig, { provider: provider });
	}
	if (state.showRemoteBranchesV2 !== BooleanOverride.Default) {
		file.showRemoteBranches = state.showRemoteBranchesV2 === BooleanOverride.Enabled;
	}
	if (state.showStashes !== BooleanOverride.Default) {
		file.showStashes = state.showStashes === BooleanOverride.Enabled;
	}
	if (state.showTags !== BooleanOverride.Default) {
		file.showTags = state.showTags === BooleanOverride.Enabled;
	}
	file.exportedAt = (new Date()).getTime();
	return file;
}

/**
 * Validate an external configuration file.
 * @param file The external configuration file.
 * @returns NULL => Value, String => The first field that is invalid.
 */
export function validateExternalConfigFile(file: Readonly<ExternalRepoConfig.File>) {
	if (typeof file.commitOrdering !== 'undefined' && file.commitOrdering !== RepoCommitOrdering.Date && file.commitOrdering !== RepoCommitOrdering.AuthorDate && file.commitOrdering !== RepoCommitOrdering.Topological) {
		return 'commitOrdering';
	}
	if (typeof file.fileViewType !== 'undefined' && file.fileViewType !== ExternalRepoConfig.FileViewType.Tree && file.fileViewType !== ExternalRepoConfig.FileViewType.List) {
		return 'fileViewType';
	}
	if (typeof file.hideRemotes !== 'undefined' && (!Array.isArray(file.hideRemotes) || file.hideRemotes.some((remote) => typeof remote !== 'string'))) {
		return 'hideRemotes';
	}
	if (typeof file.includeCommitsMentionedByReflogs !== 'undefined' && typeof file.includeCommitsMentionedByReflogs !== 'boolean') {
		return 'includeCommitsMentionedByReflogs';
	}
	if (typeof file.issueLinkingConfig !== 'undefined' && (typeof file.issueLinkingConfig !== 'object' || file.issueLinkingConfig === null || typeof file.issueLinkingConfig.issue !== 'string' || typeof file.issueLinkingConfig.url !== 'string')) {
		return 'issueLinkingConfig';
	}
	if (typeof file.name !== 'undefined' && typeof file.name !== 'string') {
		return 'name';
	}
	if (typeof file.onlyFollowFirstParent !== 'undefined' && typeof file.onlyFollowFirstParent !== 'boolean') {
		return 'onlyFollowFirstParent';
	}
	if (typeof file.onRepoLoadShowCheckedOutBranch !== 'undefined' && typeof file.onRepoLoadShowCheckedOutBranch !== 'boolean') {
		return 'onRepoLoadShowCheckedOutBranch';
	}
	if (typeof file.onRepoLoadShowSpecificBranches !== 'undefined' && (!Array.isArray(file.onRepoLoadShowSpecificBranches) || file.onRepoLoadShowSpecificBranches.some((branch) => typeof branch !== 'string'))) {
		return 'onRepoLoadShowSpecificBranches';
	}
	if (typeof file.pinnedBranches !== 'undefined' && (!Array.isArray(file.pinnedBranches) || file.pinnedBranches.some((branch) => typeof branch !== 'string'))) {
		return 'pinnedBranches';
	}
	if (typeof file.pinnedCommits !== 'undefined' && (!Array.isArray(file.pinnedCommits) || file.pinnedCommits.some((commit) => typeof commit !== 'object' || commit === null || typeof commit.hash !== 'string' || typeof commit.summary !== 'string'
		|| (typeof commit.author !== 'undefined' && typeof commit.author !== 'string')
		|| (typeof commit.email !== 'undefined' && typeof commit.email !== 'string')
		|| (typeof commit.date !== 'undefined' && typeof commit.date !== 'number')))) {
		return 'pinnedCommits';
	}
	if (typeof file.pullRequestConfig !== 'undefined' && (
		typeof file.pullRequestConfig !== 'object' ||
		file.pullRequestConfig === null ||
		(
			file.pullRequestConfig.provider !== ExternalRepoConfig.PullRequestProvider.Bitbucket &&
			(file.pullRequestConfig.provider !== ExternalRepoConfig.PullRequestProvider.Custom || typeof file.pullRequestConfig.custom !== 'object' || file.pullRequestConfig.custom === null || typeof file.pullRequestConfig.custom.name !== 'string' || typeof file.pullRequestConfig.custom.templateUrl !== 'string') &&
			file.pullRequestConfig.provider !== ExternalRepoConfig.PullRequestProvider.GitHub &&
			file.pullRequestConfig.provider !== ExternalRepoConfig.PullRequestProvider.GitLab
		) ||
		typeof file.pullRequestConfig.hostRootUrl !== 'string' ||
		typeof file.pullRequestConfig.sourceRemote !== 'string' ||
		typeof file.pullRequestConfig.sourceOwner !== 'string' ||
		typeof file.pullRequestConfig.sourceRepo !== 'string' ||
		(typeof file.pullRequestConfig.destRemote !== 'string' && file.pullRequestConfig.destRemote !== null) ||
		typeof file.pullRequestConfig.destOwner !== 'string' ||
		typeof file.pullRequestConfig.destRepo !== 'string' ||
		typeof file.pullRequestConfig.destProjectId !== 'string' ||
		typeof file.pullRequestConfig.destBranch !== 'string'
	)) {
		return 'pullRequestConfig';
	}
	if (typeof file.showRemoteBranches !== 'undefined' && typeof file.showRemoteBranches !== 'boolean') {
		return 'showRemoteBranches';
	}
	if (typeof file.showStashes !== 'undefined' && typeof file.showStashes !== 'boolean') {
		return 'showStashes';
	}
	if (typeof file.showTags !== 'undefined' && typeof file.showTags !== 'boolean') {
		return 'showTags';
	}
	return null;
}

/**
 * Apply the configuration provided in an external configuration file to a repository state.
 * @param file The file to apply.
 * @param state The state to be updated.
 */
export function applyExternalConfigFile(file: Readonly<ExternalRepoConfig.File>, state: GitRepoState) {
	if (typeof file.commitOrdering !== 'undefined') {
		state.commitOrdering = file.commitOrdering;
	}
	if (typeof file.fileViewType !== 'undefined') {
		switch (file.fileViewType) {
			case ExternalRepoConfig.FileViewType.Tree:
				state.fileViewType = FileViewType.Tree;
				break;
			case ExternalRepoConfig.FileViewType.List:
				state.fileViewType = FileViewType.List;
				break;
		}
	}
	if (typeof file.hideRemotes !== 'undefined') {
		state.hideRemotes = file.hideRemotes;
	}
	if (typeof file.includeCommitsMentionedByReflogs !== 'undefined') {
		state.includeCommitsMentionedByReflogs = file.includeCommitsMentionedByReflogs ? BooleanOverride.Enabled : BooleanOverride.Disabled;
	}
	if (typeof file.issueLinkingConfig !== 'undefined') {
		state.issueLinkingConfig = {
			issue: file.issueLinkingConfig.issue,
			url: file.issueLinkingConfig.url
		};
	}
	if (typeof file.name !== 'undefined') {
		state.name = file.name;
	}
	if (typeof file.onlyFollowFirstParent !== 'undefined') {
		state.onlyFollowFirstParent = file.onlyFollowFirstParent ? BooleanOverride.Enabled : BooleanOverride.Disabled;
	}
	if (typeof file.onRepoLoadShowCheckedOutBranch !== 'undefined') {
		state.onRepoLoadShowCheckedOutBranch = file.onRepoLoadShowCheckedOutBranch ? BooleanOverride.Enabled : BooleanOverride.Disabled;
	}
	if (typeof file.onRepoLoadShowSpecificBranches !== 'undefined') {
		state.onRepoLoadShowSpecificBranches = file.onRepoLoadShowSpecificBranches;
	}
	if (typeof file.pullRequestConfig !== 'undefined') {
		let provider: PullRequestProvider;
		switch (file.pullRequestConfig.provider) {
			case ExternalRepoConfig.PullRequestProvider.Bitbucket:
				provider = PullRequestProvider.Bitbucket;
				break;
			case ExternalRepoConfig.PullRequestProvider.Custom:
				provider = PullRequestProvider.Custom;
				break;
			case ExternalRepoConfig.PullRequestProvider.GitHub:
				provider = PullRequestProvider.GitHub;
				break;
			case ExternalRepoConfig.PullRequestProvider.GitLab:
				provider = PullRequestProvider.GitLab;
				break;
		}
		state.pullRequestConfig = <PullRequestConfig>{
			provider: provider,
			custom: provider === PullRequestProvider.Custom
				? {
					name: file.pullRequestConfig.custom!.name,
					templateUrl: file.pullRequestConfig.custom!.templateUrl
				}
				: null,
			hostRootUrl: file.pullRequestConfig.hostRootUrl,
			sourceRemote: file.pullRequestConfig.sourceRemote,
			sourceOwner: file.pullRequestConfig.sourceOwner,
			sourceRepo: file.pullRequestConfig.sourceRepo,
			destRemote: file.pullRequestConfig.destRemote,
			destOwner: file.pullRequestConfig.destOwner,
			destRepo: file.pullRequestConfig.destRepo,
			destProjectId: file.pullRequestConfig.destProjectId,
			destBranch: file.pullRequestConfig.destBranch
		};
	}
	if (typeof file.showRemoteBranches !== 'undefined') {
		state.showRemoteBranchesV2 = file.showRemoteBranches ? BooleanOverride.Enabled : BooleanOverride.Disabled;
	}
	if (typeof file.showStashes !== 'undefined') {
		state.showStashes = file.showStashes ? BooleanOverride.Enabled : BooleanOverride.Disabled;
	}
	if (typeof file.showTags !== 'undefined') {
		state.showTags = file.showTags ? BooleanOverride.Enabled : BooleanOverride.Disabled;
	}
}

/**
 * Compare the pinned branches and commits of two repository states by value.
 * @param a The first repository state (or a partial state with the pins to compare).
 * @param b The second repository state.
 * @returns TRUE if both the pinned branches and pinned commits are equal.
 */
export function pinsEqual(a: Pick<GitRepoState, 'pinnedBranches' | 'pinnedCommits'>, b: Pick<GitRepoState, 'pinnedBranches' | 'pinnedCommits'>) {
	if (a.pinnedBranches.length !== b.pinnedBranches.length || a.pinnedCommits.length !== b.pinnedCommits.length) return false;
	return a.pinnedBranches.every((branch, i) => branch === b.pinnedBranches[i])
		&& a.pinnedCommits.every((commit, i) => {
			const other = b.pinnedCommits[i];
			return other !== undefined && commit.hash === other.hash && commit.summary === other.summary
				&& commit.author === other.author && commit.email === other.email && commit.date === other.date;
		});
}

import * as vscode from 'vscode';
import { WorkspaceConfigurationLike, WorkspaceLike, takeSnapshot } from './snapshot';

/**
 * TRANSITIONAL (OPTIMIZATION-PLAN A4): the only remaining `getConfig` shim, kept solely because
 * `src/extension/repos/repoManager.ts` still imports it and that file is owned by the concurrent
 * watcher-bug workstream (the A4 do-not-touch list). The former per-key-getter `Config` class
 * (60+ getters, each re-reading vscode.workspace.getConfiguration) is deleted; this answers the
 * TWO settings repoManager reads, as a plain slice over one {@link takeSnapshot} of the live
 * configuration — scoped to the repository when one is given (identical values for these two
 * window-scoped settings; the scope only matters for resource-scoped ones, and neither is).
 *
 * Defaults come from the schema table through the snapshot — nothing here defines one.
 * DELETE THIS FILE (and its re-export in index.ts) when repoManager.ts migrates to the snapshot.
 * Nothing else may start using it: new code takes a snapshot or holds a ConfigProvider.
 */

/** The settings repos/repoManager.ts reads, under the (legacy) names its frozen code uses. */
export interface RepoManagerConfigSlice {
	/** The maximum workspace-folder depth the repository search descends to. */
	readonly maxDepthOfRepoSearch: number;
	/** Whether the repository's remotes track tags (the `+refs/tags/*` fetch refspec is added). */
	readonly trackRemoteTags: boolean;
}

/**
 * Read the settings repoManager consumes.
 * @deprecated A transitional answer for repos/repoManager.ts only. Use `takeSnapshot` / the
 * `ConfigService` instead.
 * @param repo An optional path of a repository (for workspace-folder-scoped resolution).
 * @returns The configuration slice.
 */
export function getConfig(repo?: string): RepoManagerConfigSlice {
	let workspace: WorkspaceLike = vscode.workspace;
	if (repo !== undefined) {
		// The repository-scoped reading: VS Code resolves resource-scoped settings against the
		// given folder (the exact scope the former `new Config(repo)` reader passed).
		workspace = {
			getConfiguration: (section?: string): WorkspaceConfigurationLike => vscode.workspace.getConfiguration(section, vscode.Uri.file(repo))
		};
	}
	const snapshot = takeSnapshot(workspace);
	return {
		maxDepthOfRepoSearch: snapshot.maxDepthOfRepoSearch,
		trackRemoteTags: snapshot.repositoryTrackRemoteTags
	};
}

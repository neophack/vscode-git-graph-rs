/**
 * The view-state store of the Git Graph Extension State: the global
 * view state, the workspace view state and the view snapshot the Git Graph View's page reports
 * - three keys over the one versioned KV (./storageVersioned.ts), split out of the former flat
 * platform/storage.ts. The `ExtensionState` facade delegates its view-state methods here.
 */

import { GitGraphViewGlobalState, GitGraphViewSnapshot, GitGraphViewWorkspaceState } from '../../shared/model/webview';
import { isStateRecord, VersionedStateKv } from './storageVersioned';

const GLOBAL_VIEW_STATE = 'globalViewState';
const VIEW_SNAPSHOT = 'viewSnapshot';
const WORKSPACE_VIEW_STATE = 'workspaceViewState';

export const DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE: GitGraphViewGlobalState = {
	alwaysAcceptCheckoutCommit: false,
	issueLinkingConfig: null,
	pushTagSkipRemoteCheck: false
};

const DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE: GitGraphViewWorkspaceState = {
	findIsCaseSensitive: false,
	findIsRegex: false,
	findOpenCommitDetailsView: false
};

/** The view-state keys of the Git Graph Extension State, over the one versioned KV. */
export class ViewStateStore {
	constructor(private readonly kv: VersionedStateKv) {}

	/**
	 * Get the global state of the Git Graph View.
	 * @returns The global state.
	 */
	public getGlobalViewState() {
		const globalViewState = this.kv.readGlobal<GitGraphViewGlobalState>(GLOBAL_VIEW_STATE, DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE);
		return Object.assign({}, DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE, isStateRecord(globalViewState) ? globalViewState : {});
	}

	/**
	 * Set the global state of the Git Graph View.
	 * @param state The global state.
	 */
	public setGlobalViewState(state: GitGraphViewGlobalState) {
		return this.kv.writeGlobal(GLOBAL_VIEW_STATE, state);
	}

	/**
	 * Get the workspace state of the Git Graph View.
	 * @returns The workspace state.
	 */
	public getWorkspaceViewState() {
		const workspaceViewState = this.kv.readWorkspace<GitGraphViewWorkspaceState>(WORKSPACE_VIEW_STATE, DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE);
		return Object.assign({}, DEFAULT_GIT_GRAPH_VIEW_WORKSPACE_STATE, isStateRecord(workspaceViewState) ? workspaceViewState : {});
	}

	/**
	 * Set the workspace state of the Git Graph View.
	 * @param state The workspace state.
	 */
	public setWorkspaceViewState(state: GitGraphViewWorkspaceState) {
		return this.kv.writeWorkspace(WORKSPACE_VIEW_STATE, state);
	}

	/**
	 * Get the last view state the Git Graph View's page reported in the current workspace.
	 * @returns The snapshot, or NULL if none was reported yet.
	 */
	public getViewSnapshot() {
		return this.kv.readWorkspace<GitGraphViewSnapshot | null>(VIEW_SNAPSHOT, null);
	}

	/**
	 * Set the last view state the Git Graph View's page reported in the current workspace.
	 * @param snapshot The snapshot.
	 */
	public setViewSnapshot(snapshot: GitGraphViewSnapshot) {
		this.kv.writeWorkspace(VIEW_SNAPSHOT, snapshot);
	}
}

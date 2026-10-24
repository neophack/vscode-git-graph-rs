/**
 * Persistence of the Git Graph View's state: the webview state VS Code restores after a reload,
 * the snapshot mirrored to the extension host (which reopens a page left behind by an Extension
 * Host restart on it), the per-repository state, and the global / workspace view states.
 */

import { HostBridge } from '../../common/host/bridge';
import * as GG from '../../common/protocol';
import { Store } from './store';
import { FindWidgetState, SettingsWidgetState, WebViewState } from './types';

/** The widgets whose state is persisted with the view's. */
export interface PersistedWidgets {
	getFindWidgetState(): FindWidgetState;
	getSettingsWidgetState(): SettingsWidgetState;
}

export class Persistence {
	/** The pending (debounced) report of the view state to the extension (see saveState). */
	private viewSnapshotTimer: number | null = null;
	private widgets: PersistedWidgets | null = null;

	constructor(private readonly store: Store, private readonly bridge: HostBridge<WebViewState>) { }

	/** Connect the widgets whose state is persisted (they are created after the persistence). */
	public setWidgets(widgets: PersistedWidgets) {
		this.widgets = widgets;
	}

	/**
	 * Save the webview state. The persisted state is a LIGHTWEIGHT snapshot: the commit list (even
	 * subject-only) and avatars are deliberately NOT included - cloning them into the webview
	 * state on every save (which fires on every scroll, toggle and paging load) is O(n) per
	 * interaction on large repositories. After a webview reload the repository is simply
	 * reloaded (the extension's commit cache makes that fast), restoring the scroll target via
	 * the loadViewTo path.
	 */
	public saveState() {
		const store = this.store, widgets = this.widgets;
		if (widgets === null) return;
		this.bridge.setState({
			currentRepo: store.currentRepo,
			currentRepoLoading: true, // always reload the repo data after a webview reload
			gitRepos: store.repos,
			gitBranches: store.gitBranches,
			gitBranchHead: store.gitBranchHead,
			gitConfig: store.gitConfig,
			gitRemotes: store.gitRemotes,
			gitStashes: store.gitStashes,
			gitTags: store.gitTags,
			commitHead: store.commitHead,
			currentBranches: store.currentBranches,
			currentAuthors: store.currentAuthors,
			moreCommitsAvailable: store.moreCommitsAvailable,
			maxCommits: store.maxCommits,
			onlyFollowFirstParent: store.onlyFollowFirstParent,
			scrollTop: store.scrollTop,
			findWidget: widgets.getFindWidgetState(),
			settingsWidget: widgets.getSettingsWidgetState(),
			commitPathFilter: store.commitPathFilter,
			compareSourceHash: store.compareSourceHash
		});

		// Mirror the part of the state a page reload restores to the extension: an Extension Host
		// restart leaves this page behind unreachable, and the page replacing it reopens on this
		// snapshot. Debounced - the state is saved on every scroll.
		if (this.viewSnapshotTimer !== null) window.clearTimeout(this.viewSnapshotTimer);
		this.viewSnapshotTimer = window.setTimeout(() => {
			this.viewSnapshotTimer = null;
			if (this.widgets === null) return;
			this.bridge.send({
				command: 'setViewSnapshot',
				snapshot: {
					currentRepo: this.store.currentRepo,
					scrollTop: this.store.scrollTop,
					findWidget: this.widgets.getFindWidgetState(),
					settingsWidget: this.widgets.getSettingsWidgetState(),
					commitPathFilter: this.store.commitPathFilter,
					compareSourceHash: this.store.compareSourceHash
				}
			});
		}, 1000);
	}

	/** Save the state of the current repository to the extension. */
	public saveRepoState() {
		this.bridge.send({ command: 'setRepoState', repo: this.store.currentRepo, state: this.store.repoState });
	}

	/** Save one value of a repository's state (ignored unless it is the current repository). */
	public saveRepoStateValue<K extends keyof GG.GitRepoState>(repo: string, key: K, value: GG.GitRepoState[K]) {
		if (repo === this.store.currentRepo) {
			this.store.repoState[key] = value;
			this.saveRepoState();
		}
	}

	/** Save the column widths of the commit table (the Description column is never stored). */
	public saveColumnWidths(columnWidths: GG.ColumnWidth[]) {
		this.store.repoState.columnWidths = [columnWidths[0], columnWidths[2], columnWidths[3], columnWidths[4]];
		this.saveRepoState();
	}

	/** Update a value of the Global View State. */
	public updateGlobalViewState<K extends keyof GG.GitGraphViewGlobalState>(key: K, value: GG.GitGraphViewGlobalState[K]) {
		(<GG.GitGraphViewGlobalState>this.store.globalViewState)[key] = value;
		this.bridge.send({ command: 'setGlobalViewState', state: this.store.globalViewState });
	}

	/** Update a value of the Workspace View State. */
	public updateWorkspaceViewState<K extends keyof GG.GitGraphViewWorkspaceState>(key: K, value: GG.GitGraphViewWorkspaceState[K]) {
		(<GG.GitGraphViewWorkspaceState>this.store.workspaceViewState)[key] = value;
		this.bridge.send({ command: 'setWorkspaceViewState', state: this.store.workspaceViewState });
	}
}

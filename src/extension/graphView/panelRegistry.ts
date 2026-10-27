import type * as vscode from 'vscode';
import { EventEmitter, GgEvent } from '../../shared/util/event';
import type { LoadGitGraphViewTo } from '../../shared/model/webview';
import type { ExtensionServices } from '../services';
import { setLiveGraphView } from '../automation/graphViewPort';
import { activeEditorColumn, GitGraphView } from './panel';
import { watchForOrphanedTabs } from './orphanedTabs';

/**
 * The registry of the one live Git Graph panel: an instance owned by the
 * composition root. A static panel field would double
 * as a service locator — anything could read the panel's state off the class — so the registry
 * inverts it: the panel PUBLISHES itself here at every point its lifecycle changes (creation,
 * serializer revival, orphaned-tab replacement, disposal) and publishes its activity (page
 * loaded, repository switched), and the rest of the host reads the registry's small surface:
 *
 * - `current()` for the automation port's live-view handoff paths,
 * - `onDidChangeActivity` to observe the view's activity transitions,
 * - the 2-method live-view port `currentRepo()` / `isBusy()` that the prewarm controller yields to.
 *
 * The panel lifecycle entries (`open`, `restore`, `watchForOrphanedTabs`) are registry
 * methods, so the singleton logic and the
 * singleton state live in the same object.
 *
 * The registry reads the panel's state through two public getters (`viewLoaded`, `shownRepo`);
 * every other collaborator of the panel arrives through the services bag, not through the
 * registry.
 */

/** The live view's activity state, as the registry reports and observes it. */
export interface PanelActivity {
	/** Whether the live view's page has finished loading (FALSE while none is open). */
	readonly viewLoaded: boolean;
	/** The repository the live view shows (NULL while none is open or none is shown). */
	readonly currentRepo: string | null;
}

export class PanelRegistry {
	/** The live view, or undefined while no Git Graph view exists. */
	private live: GitGraphView | undefined;
	/** The activity snapshot last emitted, so no-op transitions do not fire the event. */
	private lastActivity: PanelActivity = { viewLoaded: false, currentRepo: null };
	private readonly activityEmitter = new EventEmitter<PanelActivity>();

	constructor(private readonly services: ExtensionServices) {}

	/* ---------- the ports other subsystems read ---------- */

	/** The live view, or undefined when no Git Graph view is open. */
	public current(): GitGraphView | undefined {
		return this.live;
	}

	/** Fired when the live view's activity changes (opened, page loaded, repository switched, disposed). */
	public get onDidChangeActivity(): GgEvent<PanelActivity> {
		return this.activityEmitter.subscribe;
	}

	/** TRUE while a user action is in flight in the live view: background work yields (the prewarm port). */
	public isBusy(): boolean {
		const view = this.live;
		return view !== undefined && !view.viewLoaded;
	}

	/** The repository the live view shows, or NULL when no view is open (the prewarm port). */
	public currentRepo(): string | null {
		const view = this.live;
		return view !== undefined ? view.shownRepo : null;
	}

	/* ---------- the panel lifecycle (the former GitGraphView statics) ---------- */

	/**
	 * If a Git Graph view already exists, show and update it. Otherwise, create one.
	 * @param loadViewTo What to load the view to.
	 */
	public open(loadViewTo: LoadGitGraphViewTo): void {
		const column = activeEditorColumn();
		const live = this.live;
		if (live !== undefined) {
			// A view already exists
			if (live.panelVisible) {
				// The view is visible
				if (loadViewTo !== null) {
					live.respondLoadRepos(this.services.repos.getRepos(), loadViewTo);
				}
			} else {
				// The view is not visible: the request is stashed for its next render
				live.stashLoadViewTo(loadViewTo);
			}
			live.reveal(column);
			return;
		}
		this.attach(new GitGraphView(this.services, this, { loadViewTo: loadViewTo, column: column }));
	}

	/**
	 * Re-attach a Git Graph view to a Webview Panel VS Code revives through the serializer (a
	 * window reload restoring the open Git Graph tab). An Extension Host restart doesn't go
	 * through here: see {@link watchForOrphanedTabs}.
	 * @param panel The revived Webview Panel handed over by VS Code.
	 */
	public restore(panel: vscode.WebviewPanel): void {
		if (this.live !== undefined) {
			// A view is already open: a second one can't share the singleton state.
			panel.dispose();
			return;
		}
		this.attach(new GitGraphView(this.services, this, { loadViewTo: null, existingPanel: panel }));
	}

	/**
	 * Watch for Git Graph tabs an Extension Host restart leaves behind (see orphanedTabs.ts,
	 * which holds the logic): a Git Graph tab that is shown while no live view backs it gets a
	 * fresh view opened NEXT to it and only then the dead tab closed.
	 * @returns A disposable that stops watching.
	 */
	public watchForOrphanedTabs(): vscode.Disposable {
		return watchForOrphanedTabs({
			liveView: () => {
				const view = this.live;
				return view !== undefined ? { visible: view.panelVisible, viewColumn: view.panelViewColumn } : undefined;
			},
			openReplacement: (viewColumn, preserveFocus) => {
				this.attach(new GitGraphView(this.services, this, {
					loadViewTo: null,
					column: { viewColumn: viewColumn, preserveFocus: preserveFocus },
					restoredSnapshot: this.services.state.getViewSnapshot()
				}));
			},
			logger: this.services.logger
		});
	}

	/* ---------- the panel's registration hooks (called by GitGraphView) ---------- */

	/** Adopt `panel` as the live view (creation, revival, orphan replacement), publishing it to the automation port. */
	public attach(panel: GitGraphView): void {
		this.live = panel;
		setLiveGraphView(panel);
		this.emitActivity();
	}

	/** Drop `panel` from the registry (its disposal). Another view, if any, stays registered. */
	public detach(panel: GitGraphView): void {
		if (this.live === panel) {
			this.live = undefined;
			setLiveGraphView(null);
			this.emitActivity();
		}
	}

	/** Re-read the live view's activity (the panel calls this when its state transitions). */
	public noteActivity(panel: GitGraphView): void {
		if (this.live === panel) this.emitActivity();
	}

	/** Emit the current activity, unless it equals the last emitted snapshot. */
	private emitActivity(): void {
		const view = this.live;
		const next: PanelActivity = view !== undefined
			? { viewLoaded: view.viewLoaded, currentRepo: view.shownRepo }
			: { viewLoaded: false, currentRepo: null };
		const previous = this.lastActivity;
		if (previous.viewLoaded === next.viewLoaded && previous.currentRepo === next.currentRepo) return;
		this.lastActivity = next;
		this.activityEmitter.emit(next);
	}
}

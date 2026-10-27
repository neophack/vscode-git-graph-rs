/**
 * The composition of the Git Graph View: every component and controller, created once by main.ts
 * and handed to each other through this context. A component holds the context and reaches the
 * others only through it, so every dependency is explicit and typed, and the state they share
 * lives in one place (`store`) instead of in a god object's fields.
 */

import { EventOverlay } from '../common/eventOverlay';
import { HostBridge } from '../common/host/bridge';
import type { ActionRunner } from './actions/runAction';
import type { CommitDetails } from './commitDetails/commitDetails';
import type { ControlBar } from './controlBar/controlBar';
import type { PinnedRow } from './controlBar/pinnedRow';
import type { CommitBodies } from './loading/commitBodies';
import type { RepoLoader } from './loading/repoLoader';
import type { ColumnLayout } from './render/columns';
import type { CommitTable } from './render/commitTable';
import type { GraphView } from './render/graphSvg';
import type { LayoutMode } from './render/layoutMode';
import type { RenderScheduler } from './render/scheduler';
import type { Viewport } from './render/viewport';
import type { Persistence } from './state/persistence';
import type { Store } from './state/store';
import type { WebViewState } from './state/types';
import type { ConflictBanner } from './widgets/conflictBanner';
import type { ContextMenu } from './widgets/contextMenu';
import type { Dialog } from './widgets/dialog';
import type { FindWidgetSurface, ReflogViewSurface, SettingsWidgetSurface, StatisticsViewSurface, WorktreeDialogSurface } from './widgets/surfaces';

/** The static skeleton of the view, rendered by the extension host. */
export interface ViewDom {
	readonly view: HTMLElement;
	readonly headerRow: HTMLElement;
	readonly controls: HTMLElement;
	readonly pinnedControls: HTMLElement | null;
	readonly conflictBanner: HTMLElement;
	readonly commitGraph: HTMLElement;
	readonly table: HTMLElement;
	readonly footer: HTMLElement;
}

/**
 * The view's widgets. The Find widget, the Settings widget, the Reflog view, the Worktree dialog
 * and the Statistics view are LAZY: the context holds their facades, which load the
 * real modules through dynamic import() on first use - only the Conflict banner sits in the
 * first-paint bundle with the table, the graph and the control bar.
 */
export interface Widgets {
	readonly find: FindWidgetSurface;
	readonly settings: SettingsWidgetSurface;
	readonly conflictBanner: ConflictBanner;
	readonly reflog: ReflogViewSurface;
	readonly worktree: WorktreeDialogSurface;
	readonly statistics: StatisticsViewSurface;
}

export interface GraphContext {
	readonly store: Store;
	readonly bridge: HostBridge<WebViewState>;
	readonly persistence: Persistence;
	readonly dom: ViewDom;
	readonly eventOverlay: EventOverlay;
	readonly dialog: Dialog;
	readonly contextMenu: ContextMenu;
	readonly actions: ActionRunner;
	readonly layout: LayoutMode;
	readonly graph: GraphView;
	readonly table: CommitTable;
	readonly columns: ColumnLayout;
	/**
	 * The one render pass of the view: requesters that can wait a frame call
	 * `renderScheduler.request()` and merge into a single render; paths that must measure the DOM
	 * they just wrote call `renderSync()`, which satisfies the pending requests instead of adding
	 * another pass.
	 */
	readonly renderScheduler: RenderScheduler;
	readonly viewport: Viewport;
	readonly loader: RepoLoader;
	readonly commitBodies: CommitBodies;
	readonly details: CommitDetails;
	readonly controls: ControlBar;
	readonly pinned: PinnedRow;
	readonly widgets: Widgets;
	/** Close the open dialog and context menu (if any). */
	closeDialogAndContextMenu(): void;
	/**
	 * Tear every component down (F3 "Component lifecycle and DOM ownership"): the parent's hook,
	 * called when the view's page is reset. The components are page singletons — a repository
	 * switch does NOT dispose them (they keep serving the next repository); it only closes their
	 * open surfaces, and those close paths clear the surface listener stores.
	 */
	dispose(): void;
}

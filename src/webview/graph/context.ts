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
import type { Viewport } from './render/viewport';
import type { Persistence } from './state/persistence';
import type { Store } from './state/store';
import type { WebViewState } from './state/types';
import type { ConflictBanner } from './widgets/conflictBanner';
import type { ContextMenu } from './widgets/contextMenu';
import type { Dialog } from './widgets/dialog';
import type { FindWidget } from './widgets/findWidget';
import type { ReflogView } from './widgets/reflogView';
import type { SettingsWidget } from './widgets/settings/settingsWidget';
import type { StatisticsView } from './widgets/statisticsView';
import type { WorktreeDialog } from './widgets/worktreeDialog';

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

export interface Widgets {
	readonly find: FindWidget;
	readonly settings: SettingsWidget;
	readonly conflictBanner: ConflictBanner;
	readonly reflog: ReflogView;
	readonly worktree: WorktreeDialog;
	readonly statistics: StatisticsView;
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
	readonly viewport: Viewport;
	readonly loader: RepoLoader;
	readonly commitBodies: CommitBodies;
	readonly details: CommitDetails;
	readonly controls: ControlBar;
	readonly pinned: PinnedRow;
	readonly widgets: Widgets;
	/** Close the open dialog and context menu (if any). */
	closeDialogAndContextMenu(): void;
}

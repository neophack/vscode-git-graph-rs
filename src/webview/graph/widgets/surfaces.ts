/**
 * The call surfaces of the on-demand widgets (REFACTOR-PLAN task 5.9): what the rest of the view
 * may invoke on the Settings widget, the Reflog view, the Worktree dialog and the Statistics
 * view. Each widget class implements its surface (checked at compile time), and the view's
 * context holds LAZY facades implementing the same surface - the module loads through dynamic
 * import() on first use, so the surface is exactly the API that must work before, during and
 * after that load. A method that would need the widget to EXIST to mean anything (isVisible,
 * close, refresh, processResponse) is answered for a not-yet-loaded widget as "not open";
 * a method that opens the widget (show) triggers the load.
 */

import type * as GG from '../../common/protocol';
import type { SettingsWidgetState } from '../state/types';

/** The Settings widget's surface (see {@link SettingsWidget} for the implementation). */
export interface SettingsWidgetSurface {
	show(currentRepo: string, isInitialLoad?: boolean, scrollTop?: number, repoColumnScrollTop?: number, globalColumnScrollTop?: number): void;
	refresh(): void;
	close(): void;
	getState(): SettingsWidgetState;
	restoreState(state: SettingsWidgetState): void;
	isVisible(): boolean;
}

/** The Reflog view's surface (see {@link ReflogView} for the implementation). */
export interface ReflogViewSurface {
	show(): void;
	close(): void;
	isVisible(): boolean;
	refresh(): void;
	processResponse(msg: GG.ResponseReflog): void;
}

/** The Worktree dialog's surface (see {@link WorktreeDialog} for the implementation). */
export interface WorktreeDialogSurface {
	show(): void;
	close(): void;
	isVisible(): boolean;
	refresh(): void;
	processListResponse(msg: GG.ResponseWorktreeList): void;
}

/** The Statistics view's surface (see {@link StatisticsView} for the implementation). */
export interface StatisticsViewSurface {
	show(): void;
	close(): void;
	isVisible(): boolean;
	processResponse(msg: GG.ResponseRepoStatistics): void;
}

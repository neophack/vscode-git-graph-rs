/**
 * The call surfaces of the on-demand widgets: what the rest of the view
 * may invoke on the Find widget, the Settings widget, the Reflog view, the Worktree dialog and
 * the Statistics view. Each widget class implements its surface (checked at compile time), and
 * the view's context holds LAZY facades implementing the same surface - the module loads through
 * dynamic import() on first use, so the surface is exactly the API that must work before, during
 * and after that load. A method that would need the widget to EXIST to mean anything (isVisible,
 * close, refresh, processResponse) is answered for a not-yet-loaded widget as "not open";
 * a method that opens the widget (show) triggers the load.
 */

import type * as GG from '../../common/protocol';
import type { FindWidgetState, SettingsWidgetState } from '../state/types';

/**
 * The Find widget's surface (see {@link FindWidget} for the implementation). The widget joins
 * the view lazily, so a not-yet-loaded widget answers every
 * existence question as "not open, not searching": no query can exist before the module does.
 */
export interface FindWidgetSurface {
	show(transition: boolean): void;
	close(): void;
	/** Is a find query active (the view renders every row while this is TRUE)? */
	isSearching(): boolean;
	/** Refresh the matches after the commits changed (a no-op while closed). */
	refresh(): void;
	/** Set the CSS variables the match highlights read (works before the module loads). */
	setColour(colour: string): void;
	getState(): FindWidgetState;
	restoreState(state: FindWidgetState): void;
	isVisible(): boolean;
	/** Tear the widget down (F3): removes its listeners. The real widgets carry it (Component); the facades forward it once the module has loaded. */
	dispose(): void;
}

/** The Settings widget's surface (see {@link SettingsWidget} for the implementation). */
export interface SettingsWidgetSurface {
	show(currentRepo: string, isInitialLoad?: boolean, scrollTop?: number, repoColumnScrollTop?: number, globalColumnScrollTop?: number): void;
	refresh(): void;
	close(): void;
	getState(): SettingsWidgetState;
	restoreState(state: SettingsWidgetState): void;
	isVisible(): boolean;
	/** Tear the widget down (F3): removes its listeners. The real widgets carry it (Component); the facades forward it once the module has loaded. */
	dispose(): void;
}

/** The Reflog view's surface (see {@link ReflogView} for the implementation). */
export interface ReflogViewSurface {
	show(): void;
	close(): void;
	isVisible(): boolean;
	processResponse(msg: GG.ResponseReflog): void;
	/** Tear the widget down (F3): removes its listeners. The real widgets carry it (Component); the facades forward it once the module has loaded. */
	dispose(): void;
}

/** The Worktree dialog's surface (see {@link WorktreeDialog} for the implementation). */
export interface WorktreeDialogSurface {
	show(): void;
	close(): void;
	isVisible(): boolean;
	refresh(): void;
	processListResponse(msg: GG.ResponseWorktreeList): void;
	/** Tear the widget down (F3): removes its listeners. The real widgets carry it (Component); the facades forward it once the module has loaded. */
	dispose(): void;
}

/** The Statistics view's surface (see {@link StatisticsView} for the implementation). */
export interface StatisticsViewSurface {
	show(): void;
	close(): void;
	isVisible(): boolean;
	processResponse(msg: GG.ResponseRepoStatistics): void;
	/** Tear the widget down (F3): removes its listeners. The real widgets carry it (Component); the facades forward it once the module has loaded. */
	dispose(): void;
}

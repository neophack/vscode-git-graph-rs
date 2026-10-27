/**
 * The lazy facades of the on-demand widgets: the Settings widget, the
 * Reflog view, the Worktree dialog and the Statistics view sit OUTSIDE the first-paint bundle —
 * their modules load through dynamic import() on first use, and the facades stand in from boot
 * with the exact call surface the rest of the view uses (widgets/surfaces.ts).
 *
 * The split this buys: a widget that was never opened is never even downloaded, and one that is
 * opened pays only the module fetch (warm after the idle prefetch — scheduleIdlePrefetch). The
 * semantics before the load are deliberate:
 *   - a not-yet-loaded widget is by definition not open: isVisible() answers FALSE, close() and
 *     refresh() are no-ops;
 *   - a response for a not-yet-loaded widget is dropped — the widget only ever requests data
 *     after it was constructed, so a response arriving earlier cannot be for it;
 *   - show() (and the Settings widget's state restore) loads the module and forwards.
 */

import { modifyColourOpacity } from '../../common/util';
import type * as GG from '../../common/protocol';
import type { GraphContext } from '../context';
import type { FindWidgetState, SettingsWidgetState } from '../state/types';
import type { FindWidgetSurface, ReflogViewSurface, SettingsWidgetSurface, StatisticsViewSurface, WorktreeDialogSurface } from './surfaces';

/** The fallback Settings widget state reported before the module has loaded. */
const SETTINGS_STATE_DEFAULT: SettingsWidgetState = { currentRepo: null, scrollTop: 0, repoColumnScrollTop: 0, globalColumnScrollTop: 0 };

/** The fallback Find widget state reported before the module has loaded. */
const FIND_STATE_DEFAULT: FindWidgetState = { text: '', currentHash: null, visible: false };

/**
 * The shared machinery of one lazily loaded widget: the instance appears when the module first
 * loads, and every facade method answers through {@link loaded} or arms itself via {@link ensure}.
 */
class LazyWidget<W extends { dispose?(): void }> {
	private widget: W | null = null;
	private pending: Promise<W> | null = null;

	/**
	 * @param construct Loads and constructs the widget. The dynamic import inside resolves from
	 * the browser's module cache once loaded, so a repeated ensure() is a resolved promise.
	 */
	constructor(private readonly construct: () => Promise<W>) { }

	/** The constructed widget, or NULL while it has not loaded yet. */
	protected loaded(): W | null {
		return this.widget;
	}

	/** Load and construct the widget (idempotent; failures reset the attempt and propagate). */
	protected ensure(): Promise<W> {
		if (this.widget !== null) return Promise.resolve(this.widget);
		if (this.pending === null) {
			this.pending = this.construct().then((widget) => {
				this.widget = widget;
				this.pending = null;
				return widget;
			}, (error) => {
				this.pending = null;
				throw error;
			});
		}
		return this.pending;
	}

	/** Load the widget, then call into it; an import that fails leaves nothing to call. */
	protected ensureAndCall(call: (widget: W) => void): void {
		void this.ensure().then(call, () => undefined);
	}

	/** Tear the widget down (F3) once it has loaded: a facade before the load has nothing to remove. */
	public dispose(): void {
		const w = this.loaded();
		if (w !== null && typeof w.dispose === 'function') w.dispose();
	}
}

/** The Settings widget, loaded on first use (its chunk also carries its stylesheet). */
export class LazySettingsWidget extends LazyWidget<SettingsWidgetSurface> implements SettingsWidgetSurface {
	private restoredState: SettingsWidgetState | null = null;

	constructor(getContext: () => GraphContext) {
		super(() => import('./settings/settingsWidget').then((m) => new m.SettingsWidget(getContext)));
	}

	public show(currentRepo: string, isInitialLoad?: boolean, scrollTop?: number, repoColumnScrollTop?: number, globalColumnScrollTop?: number): void {
		this.ensureAndCall((w) => w.show(currentRepo, isInitialLoad, scrollTop, repoColumnScrollTop, globalColumnScrollTop));
	}

	public refresh(): void {
		const w = this.loaded();
		if (w !== null) w.refresh();
	}

	public close(): void {
		const w = this.loaded();
		if (w !== null) w.close();
	}

	public getState(): SettingsWidgetState {
		const w = this.loaded();
		if (w !== null) return w.getState();
		// Not loaded: nothing ever changed the state, so the restore staged for it (or the
		// default) is exactly what a loaded instance would report.
		return this.restoredState !== null ? this.restoredState : SETTINGS_STATE_DEFAULT;
	}

	public restoreState(state: SettingsWidgetState): void {
		this.restoredState = state;
		const w = this.loaded();
		if (w !== null) w.restoreState(state);
	}

	public isVisible(): boolean {
		const w = this.loaded();
		return w !== null && w.isVisible();
	}
}

/** The Find widget, loaded on first use (its chunk also carries its stylesheet). */
export class LazyFindWidget extends LazyWidget<FindWidgetSurface> implements FindWidgetSurface {
	private restoredState: FindWidgetState | null = null;

	constructor(getContext: () => GraphContext) {
		super(() => import('./findWidget').then((m) => new m.FindWidget(getContext)));
	}

	public show(transition: boolean): void {
		this.ensureAndCall((w) => w.show(transition));
	}

	public close(): void {
		const w = this.loaded();
		if (w !== null) w.close();
	}

	public isSearching(): boolean {
		const w = this.loaded();
		return w !== null && w.isSearching();
	}

	public refresh(): void {
		const w = this.loaded();
		if (w !== null) w.refresh();
	}

	/**
	 * The highlights read two CSS VARIABLES off the body, not widget state: setting them needs no
	 * module load (and must not trigger one - the theme observers call this at boot).
	 */
	public setColour(colour: string): void {
		document.body.style.setProperty('--git-graph-findMatch', colour);
		document.body.style.setProperty('--git-graph-findMatchCommit', modifyColourOpacity(colour, 0.5));
	}

	public getState(): FindWidgetState {
		const w = this.loaded();
		if (w !== null) return w.getState();
		// Not loaded: no query can exist, so the staged restore (or the default) is exactly what
		// a loaded instance would report.
		return this.restoredState !== null ? this.restoredState : FIND_STATE_DEFAULT;
	}

	public getCurrentHash(): string | null {
		const w = this.loaded();
		return w !== null ? w.getCurrentHash() : null;
	}

	public restoreState(state: FindWidgetState): void {
		this.restoredState = state;
		const w = this.loaded();
		if (w !== null) {
			w.restoreState(state);
			return;
		}
		// A restored state that left the widget VISIBLE must reopen it after a webview reload -
		// that reopen is the first use, so it triggers the load (warm after the idle prefetch).
		if (state.visible) this.ensureAndCall((widget) => widget.restoreState(state));
	}

	public isVisible(): boolean {
		const w = this.loaded();
		return w !== null && w.isVisible();
	}

	public isScanning(): boolean {
		const w = this.loaded();
		return w !== null && w.isScanning();
	}
}

/** The Reflog view, loaded on first use. */
export class LazyReflogView extends LazyWidget<ReflogViewSurface> implements ReflogViewSurface {
	constructor(getContext: () => GraphContext) {
		super(() => import('./reflogView').then((m) => new m.ReflogView(getContext)));
	}

	public show(): void {
		this.ensureAndCall((w) => w.show());
	}

	public close(): void {
		const w = this.loaded();
		if (w !== null) w.close();
	}

	public isVisible(): boolean {
		const w = this.loaded();
		return w !== null && w.isVisible();
	}

	public refresh(): void {
		const w = this.loaded();
		if (w !== null) w.refresh();
	}

	public processResponse(msg: GG.ResponseReflog): void {
		const w = this.loaded();
		if (w !== null) w.processResponse(msg);
	}
}

/** The Worktree dialog, loaded on first use. */
export class LazyWorktreeDialog extends LazyWidget<WorktreeDialogSurface> implements WorktreeDialogSurface {
	constructor(getContext: () => GraphContext) {
		super(() => import('./worktreeDialog').then((m) => new m.WorktreeDialog(getContext)));
	}

	public show(): void {
		this.ensureAndCall((w) => w.show());
	}

	public close(): void {
		const w = this.loaded();
		if (w !== null) w.close();
	}

	public isVisible(): boolean {
		const w = this.loaded();
		return w !== null && w.isVisible();
	}

	public refresh(): void {
		const w = this.loaded();
		if (w !== null) w.refresh();
	}

	public processListResponse(msg: GG.ResponseWorktreeList): void {
		const w = this.loaded();
		if (w !== null) w.processListResponse(msg);
	}
}

/** The Statistics view, loaded on first use. */
export class LazyStatisticsView extends LazyWidget<StatisticsViewSurface> implements StatisticsViewSurface {
	constructor(getContext: () => GraphContext) {
		super(() => import('./statisticsView').then((m) => new m.StatisticsView(getContext)));
	}

	public show(): void {
		this.ensureAndCall((w) => w.show());
	}

	public close(): void {
		const w = this.loaded();
		if (w !== null) w.close();
	}

	public isVisible(): boolean {
		const w = this.loaded();
		return w !== null && w.isVisible();
	}

	public processResponse(msg: GG.ResponseRepoStatistics): void {
		const w = this.loaded();
		if (w !== null) w.processResponse(msg);
	}
}

/**
 * Warm the on-demand modules while the user is idle after the first paint (a widget's
 * first open then costs no network wait). Only the MODULES are imported - no widget is
 * constructed, so nothing appears on screen. requestIdleCallback exists on the runtime floor
 * (Chromium 47+); the setTimeout fallback covers older shells and the test environment.
 */
export function prefetchOnIdle(modules: Array<() => Promise<unknown>>): void {
	const prefetch = () => {
		for (const load of modules) void load().catch(() => undefined);
	};
	if (typeof requestIdleCallback === 'function') {
		requestIdleCallback(() => prefetch(), { timeout: 2000 });
	} else {
		window.setTimeout(prefetch, 2000);
	}
}

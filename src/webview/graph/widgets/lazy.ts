/**
 * The lazy facades of the on-demand widgets and the Commit Details View: the Settings widget, the
 * Reflog view, the Worktree dialog and the Statistics view sit OUTSIDE the first-paint bundle —
 * their modules load through dynamic import() on first use, and the facades stand in from boot
 * with the exact call surface the rest of the view uses (widgets/surfaces.ts). The Commit Details
 * View rides the same mechanism (commitDetails/detailsSurface.ts): its panel only exists once a
 * user expands a commit, so its module — the view shell, the panes, the file tree — is not part
 * of what the browser must fetch before the first paint either.
 *
 * The split this buys: a widget that was never opened is never even downloaded, and one that is
 * opened pays only the module fetch (warm after the idle prefetch — scheduleIdlePrefetch). The
 * semantics before the load are deliberate:
 *   - a not-yet-loaded widget is by definition not open: isVisible() answers FALSE, close() and
 *     refresh() are no-ops — and close() also CANCELS the opens still queued behind the load, so
 *     a widget cannot pop open after the user dismissed it or the view switched repositories;
 *   - a response for a not-yet-loaded widget is dropped — the widget only ever requests data
 *     after it was constructed, so a response arriving earlier cannot be for it;
 *   - show() (and the widgets' state restore) loads the module and forwards.
 */

import { modifyColourOpacity } from '../../common/util';
import type * as GG from '../../common/protocol';
import type { CommitDetailsSurface } from '../commitDetails/detailsSurface';
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
 * Exported for the facades' tests (a controllable construct is the only way to test the
 * in-flight window from outside).
 */
export class LazyWidget<W extends { dispose?(): void }> {
	private widget: W | null = null;
	private pending: Promise<W> | null = null;
	/**
	 * Bumped by {@link cancelQueuedCalls}: a facade call queued behind the load captures the
	 * epoch when armed and turns itself into a no-op if a later close() superseded it.
	 */
	private epoch = 0;
	private disposed = false;

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
				// A dispose() that ran while the import was in flight could not see this instance;
				// tear it straight back down so it cannot outlive the view that asked for it.
				if (this.disposed && typeof widget.dispose === 'function') widget.dispose();
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
		const atEpoch = this.epoch;
		void this.ensure().then((widget) => {
			if (atEpoch !== this.epoch) return; // a close() superseded this call while it queued
			call(widget);
		}, () => undefined);
	}

	/**
	 * Drop the facade calls still queued behind the load: a close (or another end-of-interaction
	 * state change) after an open was queued but before the module settled must WIN over that
	 * open, or the widget would pop open over whatever the user already moved on to (a repo
	 * switch, an Escape) with no action of their own.
	 */
	protected cancelQueuedCalls(): void {
		this.epoch++;
	}

	/** Tear the widget down (F3) once it has loaded: a facade before the load has nothing to remove. */
	public dispose(): void {
		this.disposed = true;
		this.cancelQueuedCalls();
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
		// The close supersedes an open still queued behind the module load, in either direction
		// of the load window: cancelled while loading, or run before a queued call replays it.
		this.cancelQueuedCalls();
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
		if (w !== null) {
			w.restoreState(state);
			return;
		}
		// A restored state that left the widget OPEN (it was showing a repository) must reopen it
		// after a webview reload - that reopen is the first use, so it triggers the load (warm
		// after the idle prefetch), exactly as the Find widget reopens a restored visible state.
		if (state.currentRepo !== null) this.ensureAndCall((widget) => widget.restoreState(state));
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
		// The close supersedes an open still queued behind the module load, in either direction
		// of the load window: cancelled while loading, or run before a queued call replays it.
		this.cancelQueuedCalls();
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
		// The close supersedes an open still queued behind the module load, in either direction
		// of the load window: cancelled while loading, or run before a queued call replays it.
		this.cancelQueuedCalls();
		const w = this.loaded();
		if (w !== null) w.close();
	}

	public isVisible(): boolean {
		const w = this.loaded();
		return w !== null && w.isVisible();
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
		// The close supersedes an open still queued behind the module load, in either direction
		// of the load window: cancelled while loading, or run before a queued call replays it.
		this.cancelQueuedCalls();
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
		// The close supersedes an open still queued behind the module load, in either direction
		// of the load window: cancelled while loading, or run before a queued call replays it.
		this.cancelQueuedCalls();
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
 * The Commit Details View, loaded on first use. The semantics of the not-yet-loaded state are the
 * surface's own (commitDetails/detailsSurface.ts); the one subtlety beyond the widgets is
 * `openElem`: it is read only for an open view (the callers guard on `store.expandedCommit`, which
 * only the loaded module's open path ever sets), so the facade's NULL is never consulted.
 */
export class LazyCommitDetails extends LazyWidget<CommitDetailsSurface> implements CommitDetailsSurface {
	public readonly lineCounts: CommitDetailsSurface['lineCounts'];
	private readonly getContext: () => GraphContext;

	constructor(getContext: () => GraphContext) {
		super(() => import('../commitDetails/commitDetails').then((m) => new m.CommitDetails(getContext)));
		this.getContext = getContext;
		this.lineCounts = {
			apply: (msg) => {
				const w = this.loaded();
				if (w !== null) w.lineCounts.apply(msg);
			},
			scheduleVisible: () => {
				const w = this.loaded();
				if (w !== null) w.lineCounts.scheduleVisible();
			}
		};
	}

	/** The open view's element, or NULL while the view is closed or the module is loading. */
	public get openElem(): HTMLElement | null {
		const w = this.loaded();
		return w !== null ? w.openElem : null;
	}

	/**
	 * The clicked commit's identity is read NOW, while the row element is live: the module load
	 * inside is asynchronous, and a table re-render in that window can detach the row or re-index
	 * it (an inserted row shifts every `data-id`), so the element must be re-resolved from the
	 * hash after the load — the view then opens the commit the user clicked, not whatever the
	 * stale element's row stands for. A commit that fell off the page is dropped (not open).
	 */
	public load(commitElem: HTMLElement): void {
		const ctx = this.getContext(), store = ctx.store;
		const commit = store.getCommitOfElem(commitElem);
		if (commit === null) return;
		this.ensureAndCall((w) => {
			const elem = ctx.table.findCommitElem(store.getCommitId(commit.hash));
			if (elem !== null) w.load(elem);
		});
	}

	/** As {@link load}: both clicked rows are re-resolved from their hashes after the load. */
	public loadComparison(commitElem: HTMLElement, compareWithElem: HTMLElement): void {
		const ctx = this.getContext(), store = ctx.store;
		const commit = store.getCommitOfElem(commitElem);
		const compareWith = store.getCommitOfElem(compareWithElem);
		if (commit === null || compareWith === null) return;
		this.ensureAndCall((w) => {
			const elem = ctx.table.findCommitElem(store.getCommitId(commit.hash));
			const cmpElem = ctx.table.findCommitElem(store.getCommitId(compareWith.hash));
			if (elem !== null && cmpElem !== null) w.loadComparison(elem, cmpElem);
		});
	}

	public close(saveAndRender: boolean): void {
		this.cancelQueuedCalls(); // a close supersedes a load still queued behind the module load
		const w = this.loaded();
		if (w !== null) w.close(saveAndRender);
	}

	public closeComparison(saveAndRequestCommitDetails: boolean): void {
		this.cancelQueuedCalls();
		const w = this.loaded();
		if (w !== null) w.closeComparison(saveAndRequestCommitDetails);
	}

	public isOpen(commitHash: string, compareWithHash: string | null): boolean {
		const w = this.loaded();
		return w !== null && w.isOpen(commitHash, compareWithHash);
	}

	public showDetails(commitDetails: GG.GitCommitDetails, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean): void {
		const w = this.loaded();
		if (w !== null) w.showDetails(commitDetails, avatar, codeReview, lastViewedFile, refresh);
	}

	public showComparison(commitHash: string, compareWithHash: string, fileChanges: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean): void {
		const w = this.loaded();
		if (w !== null) w.showComparison(commitHash, compareWithHash, fileChanges, codeReview, lastViewedFile, refresh);
	}

	public requestCommitDetails(hash: string, refresh: boolean): void {
		const w = this.loaded();
		if (w !== null) w.requestCommitDetails(hash, refresh);
	}

	public requestCommitComparison(hash: string, compareWithHash: string, refresh: boolean): void {
		const w = this.loaded();
		if (w !== null) w.requestCommitComparison(hash, compareWithHash, refresh);
	}

	public openCompareTab(hash: string, compareWithHash: string, singleCommit?: boolean): void {
		this.ensureAndCall((w) => w.openCompareTab(hash, compareWithHash, singleCommit));
	}

	public getFilesScrollElemId(): string {
		const w = this.loaded();
		// Only the loaded view's own panes ask (they scroll the open panel's file list)
		return w !== null ? w.getFilesScrollElemId() : '';
	}

	public renderExternalDiffBtn(): void {
		const w = this.loaded();
		if (w !== null) w.renderExternalDiffBtn();
	}

	public closeContextMenuIfOpen(expandedCommit: Parameters<CommitDetailsSurface['closeContextMenuIfOpen']>[0]): void {
		const w = this.loaded();
		if (w !== null) w.closeContextMenuIfOpen(expandedCommit);
	}

	public toggleFolder(folderElem: HTMLElement): void {
		const w = this.loaded();
		if (w !== null) w.toggleFolder(folderElem);
	}

	public updateFileState(file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean): void {
		const w = this.loaded();
		if (w !== null) w.updateFileState(file, fileElem, isReviewed, fileWasViewed);
	}

	public startCodeReview(commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview): void {
		const w = this.loaded();
		if (w !== null) w.startCodeReview(commitHash, compareWithHash, codeReview);
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

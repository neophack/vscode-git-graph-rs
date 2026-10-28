/**
 * The entry point of the Git Graph View: composes the store, the host bridge, the components and
 * the observers into the running view, and routes the responses of the extension host to it.
 *
 * The extension host renders the view's skeleton (the control bar, the table and graph containers)
 * and the initial `initialState` / `globalState` / `workspaceState` into the page; everything else
 * is built here.
 */

import { alterClass } from '../common/dom';
import { EventOverlay } from '../common/eventOverlay';
import { observeHelpTooltips } from '../common/helpTooltip';
import { HostBridge } from '../common/host/bridge';
import { ensureInterfaceLanguage } from '../common/i18n/index';
import * as GG from '../common/protocol';
import { ActionRunner } from './actions/runAction';
import { ControlBar } from './controlBar/controlBar';
import { PinnedRow } from './controlBar/pinnedRow';
import { GraphContext, ViewDom } from './context';
import { observeLongPress, observeFastScroller } from './input/touchObservers';
import { loadContextMenuActions, observeTableEvents, observeUrls } from './input/tableEvents';
import { observeKeyboardEvents, observeViewScroll, observeWebviewStyleChanges, observeWindowSizeChanges } from './input/viewObservers';
import { CommitBodies } from './loading/commitBodies';
import { RepoLoader } from './loading/repoLoader';
import { ColumnLayout } from './render/columns';
import { CommitTable } from './render/commitTable';
import { GraphView } from './render/graphSvg';
import { LayoutMode } from './render/layoutMode';
import { measureClientSize } from './render/measure';
import { RenderScheduler, scheduleFrame } from './render/scheduler';
import { Viewport } from './render/viewport';
import { createResponseRouter } from './responses';
import { decodePersistedWebViewState, Persistence } from './state/persistence';
import { Store } from './state/store';
import { WebViewState } from './state/types';
import { clearMarks, collectMarks, hasMark, isEnabled, mark, MARK, setEnabled } from '../../shared/perf/trace';
import { loadMarkdown } from './text/markdown';
import { TextFormatter } from './text/textFormatter';
import { ConflictBanner } from './widgets/conflictBanner';
import { ContextMenu } from './widgets/contextMenu';
import { Dialog } from './widgets/dialog';
import { LazyCommitDetails, LazyFindWidget, LazyReflogView, LazySettingsWidget, LazyStatisticsView, LazyWorktreeDialog, prefetchOnIdle } from './widgets/lazy';

/* The state the extension host renders into the page (inline script, before this bundle) */
declare const initialState: GG.GitGraphViewInitialState;
declare const globalState: GG.GitGraphViewGlobalState;
declare const workspaceState: GG.GitGraphViewWorkspaceState;

const CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH = 'branchLabelsAlignedToGraph';
const CLASS_TAG_LABELS_RIGHT_ALIGNED = 'tagLabelsRightAligned';

// The webview half of the trace layer, gated by the same `enableLog` setting the host reads
// (embedded into the page's initialState). T2 fires at the
// first statement of the bundle; T4 is marked by the response router, and T5 - plus the single
// `webviewTraces` report to the host - happens once the first rows have painted (see
// observeFirstPaint).
setEnabled(initialState.config.enableLog);
mark(MARK.webviewStart);

// VS Code allows acquireVsCodeApi() to be called only once per webview: the bridge acquires it as
// soon as the bundle runs, sharing it with the automation shim (see HostBridge)
const bridge = new HostBridge<WebViewState>();

/** Find the elements of the view's skeleton, or NULL when the page is not the graph view (e.g. no repositories were found). */
function findViewDom(): ViewDom | null {
	const view = document.getElementById('view');
	if (view === null) return null;
	return {
		view: view,
		headerRow: document.getElementById('headerRow')!,
		controls: document.getElementById('controls')!,
		pinnedControls: document.getElementById('pinnedControls'),
		conflictBanner: document.getElementById('conflictBanner')!,
		commitGraph: document.getElementById('commitGraph')!,
		table: document.getElementById('commitTable')!,
		footer: document.getElementById('footer')!
	};
}

/** Build the view. */
function createView(dom: ViewDom, prevState: WebViewState | null): GraphContext {
	// Every component reaches the others through this context. It is filled in below, in the order
	// the components depend on each other; a component only reads it when it is used.
	const ctx = <{ -readonly [K in keyof GraphContext]: GraphContext[K] }>{};
	const getContext = () => ctx;

	const store = new Store(initialState, globalState, workspaceState);
	ctx.store = store;
	ctx.bridge = bridge;
	ctx.dom = dom;
	ctx.persistence = new Persistence(store, bridge);
	ctx.closeDialogAndContextMenu = () => {
		if (ctx.dialog.isOpen()) ctx.dialog.close();
		if (ctx.contextMenu.isOpen()) ctx.contextMenu.close();
	};
	const findCommitElem = (index: number) => ctx.table.findCommitElem(index);

	ctx.eventOverlay = new EventOverlay(() => {
		if (ctx.contextMenu.isOpen()) ctx.contextMenu.close();
	});
	ctx.contextMenu = new ContextMenu(findCommitElem);
	ctx.dialog = new Dialog({
		eventOverlay: ctx.eventOverlay,
		closeDialogAndContextMenu: () => ctx.closeDialogAndContextMenu(),
		findCommitElem: findCommitElem,
		getReferenceInputSpaceSubstitution: () => store.config.dialogDefaults.general.referenceInputSpaceSubstitution
	});
	ctx.actions = new ActionRunner(getContext);
	ctx.layout = new LayoutMode(store, dom.view);
	ctx.graph = new GraphView(store, dom.commitGraph, dom.view, {
		findCommitElem: findCommitElem,
		closeDialogAndContextMenu: () => ctx.closeDialogAndContextMenu()
	});
	ctx.viewport = new Viewport(getContext);
	ctx.table = new CommitTable(getContext);
	ctx.columns = new ColumnLayout(getContext);
	// The single render pass, routed by slice: store changes flow through the
	// scheduler, which merges every request made before the frame into ONE render - a response
	// with several changed slices of the store renders once, not once per change - and runs only
	// the renderers subscribed to the changed slices, in the pass's order (the pinned row, the
	// table, the graph, the graph column's auto layout). The subscriptions mirror what each step
	// renders from: the pinned row the repositories' pinned commits and the loaded page; the table
	// everything the rows show (commits, refs, integration badges, the open details view); the
	// graph the commits and refs plus the open view's geometry; the auto layout what the graph
	// just drew.
	ctx.renderScheduler = new RenderScheduler();
	ctx.renderScheduler.subscribe({ slices: ['repos', 'refs', 'commits'], render: () => ctx.pinned.render() });
	ctx.renderScheduler.subscribe({
		slices: ['repos', 'refs', 'commits', 'details', 'integrations'],
		render: () => ctx.table.renderTable()
	});
	ctx.renderScheduler.subscribe({ slices: ['repos', 'refs', 'commits', 'details'], render: () => ctx.table.renderGraph() });
	ctx.renderScheduler.subscribe({ slices: ['repos', 'refs', 'commits', 'details'], render: () => ctx.columns.applyGraphColumnAutoLayout() });
	store.onRenderChange((change) => ctx.renderScheduler.request(change));
	observeFirstPaint(store);
	ctx.loader = new RepoLoader(getContext);
	ctx.commitBodies = new CommitBodies(getContext);
	// The Commit Details View rides the widgets' lazy split: its facade loads the real module on
	// the first commit a user expands, so the view shell, the panes and the file tree sit outside
	// the first-paint bundle (widgets/lazy.ts)
	ctx.details = new LazyCommitDetails(getContext);
	ctx.controls = new ControlBar(getContext);
	ctx.pinned = new PinnedRow(getContext);

	// The F3 teardown: every top-level component answers to dispose(), which removes the
	// listeners it registered through its Component store. A repository switch does NOT run
	// this — the components are page singletons that close their surfaces instead (see
	// GraphContext.dispose); this is the page reset's hook.
	ctx.dispose = () => {
		ctx.controls.dispose();
		ctx.details.dispose();
		ctx.dialog.dispose();
		ctx.contextMenu.dispose();
		ctx.widgets.conflictBanner.dispose();
		ctx.widgets.find.dispose();
		ctx.widgets.settings.dispose();
		ctx.widgets.reflog.dispose();
		ctx.widgets.worktree.dispose();
		ctx.widgets.statistics.dispose();
	};
	ctx.controls.renderToolbarText();
	dom.view.focus();
	ctx.pinned.init();
	ctx.controls.init();

	if (prevState && prevState.commitPathFilter !== null && prevState.commitPathFilter !== undefined) {
		store.slices.refs.setPathFilter(prevState.commitPathFilter);
	}

	// The Find widget, the Settings widget, the Reflog view, the Worktree dialog and the
	// Statistics view are the LAZY half of the first-paint split: their facades load
	// the real modules through dynamic import() on first use, so none of them sits in the
	// first-paint bundle (widgets/lazy.ts)
	ctx.widgets = {
		find: new LazyFindWidget(getContext),
		settings: new LazySettingsWidget(getContext),
		conflictBanner: new ConflictBanner(getContext, dom.conflictBanner),
		reflog: new LazyReflogView(getContext),
		worktree: new LazyWorktreeDialog(getContext),
		statistics: new LazyStatisticsView(getContext)
	};
	ctx.persistence.setWidgets({
		getFindWidgetState: () => ctx.widgets.find.getState(),
		getSettingsWidgetState: () => ctx.widgets.settings.getState()
	});
	// The first-paint snapshot's capture reads the rendered row height and the viewport's height
	// for its visible-window check (read at capture time, so layout changes apply)
	ctx.persistence.setViewMetrics(() => ({ rowHeight: ctx.layout.getRowHeight(), viewHeight: measureClientSize(dom.view).height }));

	const config = store.config;
	alterClass(document.body, CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH, config.referenceLabels.branchLabelsAlignedToGraph);
	alterClass(document.body, CLASS_TAG_LABELS_RIGHT_ALIGNED, config.referenceLabels.tagLabelsOnRight);
	document.body.style.setProperty('--git-graph-fontSize', config.graph.fontSize + 'px');
	document.body.style.setProperty('--git-graph-rowHeight', config.graph.rowHeight + 'px');

	observeWindowSizeChanges(ctx);
	observeWebviewStyleChanges(ctx);
	observeViewScroll(ctx);
	observeKeyboardEvents(ctx);
	observeUrls(ctx);
	observeLongPress(ctx);
	observeFastScroller(ctx);
	observeTableEvents(ctx);

	if (prevState) {
		// Only the lightweight state is restored directly (find widget, settings widget): the
		// commit list is NOT persisted, so after a webview reload the repository is always
		// reloaded (via the loadViewTo path)
		ctx.widgets.find.restoreState(prevState.findWidget);
		ctx.widgets.settings.restoreState(prevState.settingsWidget);
	}

	ctx.loader.start(prevState, initialState.lastActiveRepo, initialState.loadViewTo);
	ctx.controls.initToolbar();
	return ctx;
}

let loaded = false;
/**
 * The view the last completed boot composed (F3 dispose wiring): the reset path of this page —
 * a `load` event reaching the module again — tears it down before a new view is composed, so
 * the components' document-level listeners (dropdowns' capture handlers, the context menu's
 * close listeners, the help tooltips' observers) cannot double up. A repository switch never
 * reaches this: components are page singletons whose close paths clear their surfaces (see
 * `GraphContext.dispose`).
 */
let activeView: GraphContext | null = null;

/**
 * The T5 marker: once the boot's data push (T4) has been routed,
 * the first render request it triggered schedules two animation frames - the first is the frame
 * the render scheduler's pass runs in (the rows enter the DOM), the second only fires once a
 * compositor frame has passed over the first rows - and then reports the webview's collected
 * marks to the host in ONE `webviewTraces` message (the host appends them to its open trace and
 * records it). Renders requested before T4 (e.g. the boot's own wiring) are not the first rows
 * and are ignored.
 */
function observeFirstPaint(store: Store): void {
	if (!isEnabled()) return;
	const stop = store.onRenderChange(() => {
		if (!hasMark(MARK.webviewDataReceived)) return;
		stop();
		scheduleFrame(() => {
			scheduleFrame(() => {
				mark(MARK.rafAfterFirstRows);
				bridge.send({ command: 'webviewTraces', marks: collectMarks() });
				clearMarks();
			});
		});
	});
}

window.addEventListener('load', () => {
	if (loaded) return;
	loaded = true;

	TextFormatter.registerCustomEmojiMappings(initialState.config.customEmojiShortcodeMappings);
	// The configured language's string table loads BEFORE anything renders: the zh-cn table is
	// one of the on-demand chunks and an English page skips the fetch entirely. The
	// boot continues only once the active table is in - exactly the state the pre-split bundle
	// was in when it ran, one module-fetch later for a Chinese page.
	void ensureInterfaceLanguage(initialState.config.interfaceLanguage).then(() => {
		observeHelpTooltips();

		const dom = findViewDom();
		if (dom === null) return;

		// A page replacing one left behind by an Extension Host restart has no state of its own yet:
		// it reopens on the snapshot the old page reported (only the fields a reload restores)
		if (activeView !== null) activeView.dispose();
		const ctx = createView(dom, decodePersistedWebViewState(bridge.getState()) || <WebViewState | null>initialState.restoredSnapshot);
		activeView = ctx;

		bridge.onMessage(createResponseRouter(ctx));

		// The open path is push-based: the extension host began the merged
		// `loadView` read when the panel was created and pushes the result now that this page's
		// response router is installed — the boot sent no loadRepoInfo/loadCommits requests of its
		// own. The handshake MUST follow the router registration above, or a fast push would arrive
		// before anything listens for it.
		bridge.send({ command: 'ready' });
		// The context menus' action builders stay off the first-paint bundle but load now, while
		// the host reads the repository, rather than on idle: a right click right after the rows
		// appear should find them loaded and open its menu synchronously (see tableEvents).
		void loadContextMenuActions().catch(() => undefined);

		// The on-demand modules and the widgets' stylesheet chunk prefetch while the user is idle
		// after the first paint: the first open of any widget, the first commit details view, the
		// first context menu - or the first Markdown-rendering commit body - then resolves from
		// the browser's module cache, not the network
		prefetchOnIdle([
			() => import('./widgets/findWidget'),
			() => import('./widgets/settings/settingsWidget'),
			() => import('./widgets/reflogView'),
			() => import('./widgets/worktreeDialog'),
			() => import('./widgets/statisticsView'),
			() => import('./commitDetails/commitDetails'),
			() => import('../styles/onDemand'),
			loadMarkdown
		]);
	});
});

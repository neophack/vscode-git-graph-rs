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
import { setInterfaceLanguage } from '../common/i18n/index';
import * as GG from '../common/protocol';
import { ActionRunner } from './actions/runAction';
import { CommitDetails } from './commitDetails/commitDetails';
import { ControlBar } from './controlBar/controlBar';
import { PinnedRow } from './controlBar/pinnedRow';
import { GraphContext, ViewDom } from './context';
import { observeLongPress, observeFastScroller } from './input/touchObservers';
import { observeTableEvents, observeUrls } from './input/tableEvents';
import { observeKeyboardEvents, observeViewScroll, observeWebviewStyleChanges, observeWindowSizeChanges } from './input/viewObservers';
import { CommitBodies } from './loading/commitBodies';
import { RepoLoader } from './loading/repoLoader';
import { ColumnLayout } from './render/columns';
import { CommitTable } from './render/commitTable';
import { GraphView } from './render/graphSvg';
import { LayoutMode } from './render/layoutMode';
import { Viewport } from './render/viewport';
import { createResponseRouter } from './responses';
import { Persistence } from './state/persistence';
import { Store } from './state/store';
import { WebViewState } from './state/types';
import { TextFormatter } from './text/textFormatter';
import { ConflictBanner } from './widgets/conflictBanner';
import { ContextMenu } from './widgets/contextMenu';
import { Dialog } from './widgets/dialog';
import { FindWidget } from './widgets/findWidget';
import { ReflogView } from './widgets/reflogView';
import { SettingsWidget } from './widgets/settings/settingsWidget';
import { StatisticsView } from './widgets/statisticsView';
import { WorktreeDialog } from './widgets/worktreeDialog';

/* The state the extension host renders into the page (inline script, before this bundle) */
declare const initialState: GG.GitGraphViewInitialState;
declare const globalState: GG.GitGraphViewGlobalState;
declare const workspaceState: GG.GitGraphViewWorkspaceState;

const CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH = 'branchLabelsAlignedToGraph';
const CLASS_TAG_LABELS_RIGHT_ALIGNED = 'tagLabelsRightAligned';

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
	ctx.loader = new RepoLoader(getContext);
	ctx.commitBodies = new CommitBodies(getContext);
	ctx.details = new CommitDetails(getContext);
	ctx.controls = new ControlBar(getContext);
	ctx.pinned = new PinnedRow(getContext);

	ctx.controls.renderToolbarText();
	dom.view.focus();
	ctx.pinned.init();
	ctx.controls.init();

	if (prevState && prevState.commitPathFilter !== null && prevState.commitPathFilter !== undefined) {
		store.commitPathFilter = prevState.commitPathFilter;
	}

	ctx.widgets = {
		find: new FindWidget(getContext),
		settings: new SettingsWidget(getContext),
		conflictBanner: new ConflictBanner(getContext, dom.conflictBanner),
		reflog: new ReflogView(getContext),
		worktree: new WorktreeDialog(getContext),
		statistics: new StatisticsView(getContext)
	};
	ctx.persistence.setWidgets({
		getFindWidgetState: () => ctx.widgets.find.getState(),
		getSettingsWidgetState: () => ctx.widgets.settings.getState()
	});

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

window.addEventListener('load', () => {
	if (loaded) return;
	loaded = true;

	TextFormatter.registerCustomEmojiMappings(initialState.config.customEmojiShortcodeMappings);
	setInterfaceLanguage(initialState.config.interfaceLanguage);
	observeHelpTooltips();

	const dom = findViewDom();
	if (dom === null) return;

	// A page replacing one left behind by an Extension Host restart has no state of its own yet:
	// it reopens on the snapshot the old page reported (only the fields a reload restores)
	const ctx = createView(dom, bridge.getState() || <WebViewState | null>initialState.restoredSnapshot);

	bridge.onMessage(createResponseRouter(ctx));
});

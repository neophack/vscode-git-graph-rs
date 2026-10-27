import * as vscode from 'vscode';

/**
 * The orphaned-tab replacement of the graph view. The Tab Groups API it reads is a post-1.38
 * API; platform/vscodeCompat.ts cannot express `onDidChangeTabs`, so the local feature
 * detection below probes its own narrow shape of that API.
 */

/** How long a Git Graph tab may be shown without a live view before it is treated as left behind by an Extension Host restart. */
const ORPHANED_TAB_GRACE_MS = 1500;
/**
 * How long after activation no Git Graph tab is treated as left behind: on a window reload VS Code
 * only hands the restored tab to the serializer once activation has finished, and on a busy
 * startup that round trip can outlast ORPHANED_TAB_GRACE_MS.
 */
const ORPHANED_TAB_STARTUP_GRACE_MS = 5000;

/** The slice of the Tab Groups API the watcher reads (VS Code 1.67+; absent on older versions). */
interface TabGroupsLike {
	readonly all: ReadonlyArray<{ viewColumn?: unknown, isActive?: boolean, activeTab?: unknown, tabs: ReadonlyArray<unknown> }>;
	close?(tab: unknown, preserveFocus?: boolean): Thenable<boolean>;
	onDidChangeTabs(listener: () => void): vscode.Disposable;
}

/** Everything the watcher needs, supplied by the Panel. */
export interface OrphanedTabDeps {
	/**
	 * The live view, when one exists: its panel visibility and column drive the live-tab logic
	 * (a hidden panel can still be its group's active tab, so visibility alone cannot tell a
	 * live tab from a dead one).
	 */
	liveView(): { readonly visible: boolean, readonly viewColumn: vscode.ViewColumn | undefined } | undefined;
	/** Open the replacement view next to the dead tab, before it is closed (so the replacement slides into its place). */
	openReplacement(viewColumn: vscode.ViewColumn, preserveFocus: boolean): void;
	readonly logger: { log(message: string): void };
}

/**
 * Watch for Git Graph tabs an Extension Host restart (manual, or after an extension install /
 * update) leaves behind. VS Code keeps such a tab open with its old page but never hands it to
 * the serializer (only a window reload does), so nothing on the extension side answers its
 * messages and it sits on "Loading..." forever. A Git Graph tab that is shown while no live
 * view backs it gets a fresh view opened NEXT to it and only then the dead tab closed, so the
 * replacement takes over the dead tab's position in the tab bar instead of the tab visibly
 * closing and a new one appearing at the end of the bar.
 * @returns A disposable that stops watching.
 */
export function watchForOrphanedTabs(deps: OrphanedTabDeps): vscode.Disposable {
	const tabGroups = (vscode.window as { readonly tabGroups?: unknown }).tabGroups as TabGroupsLike | undefined;
	if (tabGroups === undefined || typeof tabGroups.onDidChangeTabs !== 'function' || !Array.isArray(tabGroups.all)) {
		return { dispose: () => { } }; // The Tab API is unavailable (VS Code < 1.67)
	}
	const isGitGraphTab = (tab: unknown) => {
		const input = (tab as { input?: { readonly viewType?: unknown } } | undefined)?.input;
		return tab !== undefined && input !== undefined && typeof input.viewType === 'string'
			&& (input.viewType === 'git-graph-rs' || input.viewType.endsWith('-git-graph-rs'));
	};

	let timer: NodeJS.Timeout | null = null;
	// The live view's own tab, remembered while its panel is shown: a hidden panel can still be its
	// group's active tab (maximized panel, hidden editor area), so visibility alone can't tell it
	// apart from a dead tab
	let liveTab: unknown = null;
	const check = async () => {
		timer = null;
		const groups = tabGroups.all;
		const live = deps.liveView();
		if (live !== undefined && live.visible) {
			const liveGroup = groups.find((group) => group.viewColumn === live.viewColumn);
			if (liveGroup !== undefined && isGitGraphTab(liveGroup.activeTab)) liveTab = liveGroup.activeTab;
		}
		const numGitGraphTabs = groups.reduce((num, group) => num + group.tabs.filter(isGitGraphTab).length, 0);

		for (const group of groups) {
			const tab = group.activeTab;
			if (!isGitGraphTab(tab)) continue;
			const view = deps.liveView();

			if (view !== undefined) {
				// The live view's own tab, or the only Git Graph tab there is (which then must be it)
				if (tab === liveTab || numGitGraphTabs <= 1) continue;
				// Another live view already exists elsewhere: the dead tab was only a duplicate.
				// Close it — the live view stays where it is, nothing is reopened in its place.
				deps.logger.log('Closing a duplicate Git Graph tab left behind by an Extension Host restart');
				try {
					await tabGroups.close!(tab, true);
				} catch (_) { /* the tab is already gone */ }
				continue;
			}

			// The tab was left behind by an Extension Host restart. Open the replacement FIRST,
			// while the dead tab still holds its place in the tab bar, and close the dead tab
			// LAST: the new panel opens beside its group's active editor — the dead tab — and
			// slides into its index as it closes, so the tab bar reads as one tab refreshing
			// in place rather than a tab closing and a new one appearing elsewhere.
			// Reopen where the old page was (repository, path filter, scroll position, widgets),
			// with every bit of data loaded afresh from this Extension Host
			deps.logger.log('Refreshing a Git Graph tab left behind by an Extension Host restart in place');
			deps.openReplacement(group.viewColumn as vscode.ViewColumn, !group.isActive);
			try {
				await tabGroups.close!(tab, true);
			} catch (_) { /* the dead tab is already gone: the replacement is up either way */ }
		}
	};
	// Debounced: a tab is only judged once it has been shown for a while, so a tab VS Code is
	// reviving through the serializer (window reload, or a background tab shown for the first
	// time) is attached to its live view first and left alone. Tab events during startup can't
	// cut the startup grace short.
	const startupGraceEnd = Date.now() + ORPHANED_TAB_STARTUP_GRACE_MS;
	const schedule = () => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => void check(), Math.max(ORPHANED_TAB_GRACE_MS, startupGraceEnd - Date.now()));
	};
	schedule();
	const subscription = tabGroups.onDidChangeTabs(schedule);
	return {
		dispose: () => {
			subscription.dispose();
			if (timer !== null) clearTimeout(timer);
		}
	};
}

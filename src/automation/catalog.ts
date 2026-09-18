/**
 * The automation action catalog: the single source of truth that maps every user-facing Git
 * Graph View control (control-bar buttons, graph row interactions, context menus, dialogs,
 * view widgets) to a machine-runnable form. Each action declares both paths where available:
 *   - `request`: the exact RequestMessage(s) the control sends into the extension host, so a
 *     driver can replay the backend path directly (stable timing, no rendering in the loop);
 *   - `ui`: the DOM steps a user performs, executed by the in-page automation shim (tests the
 *     whole stack, wiring included).
 * Placeholders `{{name}}` in either path are expanded by the server from the run parameters
 * and live repository state (repo, head, branch, commit, ...) before execution.
 */

/** How a run is driven. `ui` clicks the real controls through the in-page shim; `request` injects the equivalent request(s) into the extension host. */
export type AutomationMode = 'ui' | 'request';

/** One step of a UI-mode run, executed sequentially by the in-page shim (resources/automation/shim.js). */
export type UiStep =
	| { readonly op: 'click' | 'dblclick'; readonly selector: string }
	| { readonly op: 'contextmenu'; readonly selector: string; readonly item: string } // right-click the element, then click the menu item with this exact text
	| { readonly op: 'key'; readonly key: string; readonly ctrlOrCmd?: boolean; readonly shift?: boolean } // keydown on the document (what the view's keybinding observer listens to)
	| { readonly op: 'waitFor' | 'waitForGone'; readonly selector: string; readonly timeoutMs?: number }
	| { readonly op: 'set'; readonly selector: string; readonly value: string; readonly event: 'change' | 'input' }
	| { readonly op: 'expectText'; readonly selector: string; readonly contains: string }
	| { readonly op: 'eval'; readonly expr: string }; // a JS expression evaluated in the page (gg.eval / debugging); result must be JSON-cloneable

/** A catalog entry: one user-facing control. */
export interface AutomationAction {
	/** Dotted id: `<group>/<name>`, e.g. `control-bar/refresh`, `menu-commit/checkout`. */
	readonly id: string;
	/** Human-readable control label (the button tooltip or menu item title). */
	readonly title: string;
	/** Grouping for suite selection, e.g. `control-bar`, `row`, `menu-commit`, `menu-branch`, `cdv`, `settings`, `find`, `reflog`, `worktree`, `statistics`, `host`. */
	readonly group: string;
	/** TRUE => the action mutates the repository (belongs to the `write` suite; the driver re-creates the fixture clone around it). */
	readonly mutable: boolean;
	/** Environment the action needs; the server skips the action when unavailable (`remote` => a configured remote; `stash` => at least one stash). */
	readonly requires?: readonly ('remote' | 'stash')[];
	/**
	 * TRUE declares the action awaits no host response (a pure view-state change, or traffic the
	 * host answers silently such as `setRepoState` / `openCompareTab`). Such actions MUST declare
	 * `expect: { responses: [] }` — the run is complete once the page steps finish (or, in request
	 * mode, once the requests are injected).
	 */
	readonly noHostTraffic?: boolean;
	readonly ui?: readonly UiStep[];
	/** RequestMessage template(s) for request mode, in send order. */
	readonly request?: readonly Record<string, unknown>[];
	/** Responses (by `command`) that must arrive from the extension host while the action runs. */
	readonly expect: { readonly responses: readonly string[] };
	/** Optional post-run repository state check, evaluated by the server against loadRepoInfo. */
	readonly verify?: { readonly kind: 'headIs' | 'headIsNot' | 'branchAbsent' | 'branchPresent'; readonly placeholder: string };
}

const PLACEHOLDER_REGEXP = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

/**
 * Expand every `{{name}}` placeholder in a template value from the context. Walks plain objects
 * and arrays; any other value passes through untouched. Throws on an unknown placeholder so a
 * bad catalog entry or missing run parameter fails loudly instead of reaching the host.
 */
export function expandTemplate<T>(template: T, context: Record<string, string>): T {
	if (typeof template === 'string') {
		return template.replace(PLACEHOLDER_REGEXP, (_match, name: string) => {
			if (!(name in context)) throw new Error('Unknown automation placeholder "' + name + '"');
			return context[name];
		}) as unknown as T;
	}
	if (Array.isArray(template)) {
		return template.map((item) => expandTemplate(item, context)) as unknown as T;
	}
	if (typeof template === 'object' && template !== null) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(template)) out[key] = expandTemplate((template as Record<string, unknown>)[key], context);
		return out as unknown as T;
	}
	return template;
}

/**
 * Structural validation of the whole catalog, run once at server start (and exercised by
 * tests/automationCatalog.test.mjs with stricter cross-checks against the message types).
 */
export function validateCatalog(catalog: readonly AutomationAction[]): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	const uiOps = new Set(['click', 'dblclick', 'contextmenu', 'key', 'waitFor', 'waitForGone', 'set', 'expectText', 'eval']);
	for (const action of catalog) {
		const where = 'action "' + action.id + '"';
		if (ids.has(action.id)) problems.push(where + ': duplicate id');
		ids.add(action.id);
		if (action.title.trim() === '') problems.push(where + ': empty title');
		if (action.group.trim() === '') problems.push(where + ': empty group');
		if (!action.ui && !action.request) problems.push(where + ': declares neither ui nor request path');
		if (action.ui) {
			for (const [i, step] of action.ui.entries()) {
				if (!uiOps.has(step.op)) problems.push(where + ': unknown ui op "' + step.op + '" (step ' + i + ')');
				if ('selector' in step && typeof step.selector === 'string' && step.selector.trim() === '') {
					problems.push(where + ': empty selector (step ' + i + ')');
				}
				if (step.op === 'contextmenu' && step.item.trim() === '') problems.push(where + ': empty menu item (step ' + i + ')');
				if (step.op === 'eval' && step.expr.trim() === '') problems.push(where + ': empty eval expression (step ' + i + ')');
			}
		}
		if (action.request) {
			for (const [i, msg] of action.request.entries()) {
				if (typeof msg.command !== 'string' || msg.command === '') problems.push(where + ': request step ' + i + ' has no command');
			}
		}
		if (action.noHostTraffic === true) {
			if (action.expect.responses.length > 0) problems.push(where + ': noHostTraffic actions must not declare expected responses');
		} else if (action.expect.responses.length === 0) problems.push(where + ': no expected responses');
		for (const response of action.expect.responses) {
			if (response.indexOf('__') === 0) problems.push(where + ': reserved response command "' + response + '"');
		}
		if (action.verify && (action.verify.placeholder.indexOf('{{') !== 0 || action.verify.placeholder.indexOf('}}') !== action.verify.placeholder.length - 2)) {
			problems.push(where + ': verify placeholder must be a single {{name}} reference');
		}
	}
	return problems;
}

/**
 * The catalog. Entries are grouped by the surface they drive; the groups mirror the suites the
 * test driver can select. Fixture-stable facts (scripts/automation/fixture.mjs): the remote is
 * `origin`, local branches are `main` / `local-ahead` (feature-NNN exist only as
 * origin/feature-NNN), tags are `v1.x.x` (spread over the whole history), three stashes are
 * seeded, and an untracked file keeps the Uncommitted Changes row alive — everything else is
 * referenced through `{{placeholder}}` context.
 */

/** The in-page eval that selects exactly `branch` (and nothing else) in the Branches Dropdown. */
const filterBranchDropdownExpr = (branch: string): string =>
	'(function(){var opts=function(){return Array.from(document.querySelectorAll("#branchDropdown .dropdownOption"));};' +
	'var sel=function(o){return o.className.split(/\\s+/).indexOf("selected")!==-1;};' +
	'var name=function(o){return o.textContent.trim();};' +
	'var find=function(){return opts().find(function(o){return name(o)===' + JSON.stringify(branch) + ';});};' +
	// Defensive reset: whatever a previous entry left selected, start the filter from "Show All"
	// so the target option is visible and the end state is independent of the incoming state.
	'var showAll=opts().find(function(o){return name(o)==="Show All";});if(showAll!==undefined&&!sel(showAll))showAll.click();' +
	'var target=find();if(target===undefined)throw new Error(' + JSON.stringify(branch) + '+" option missing");' +
	'if(!sel(target))target.click();' +
	'for(var again=true;again;){again=false;var other=opts().find(function(o){var n=name(o);return n!==' + JSON.stringify(branch) + '&&n!=="Show All"&&sel(o);});if(other!==undefined){other.click();again=true;}}' +
	'if(!sel(find()))find().click();' +
	'return "filtered";})()';

/**
 * UI steps that filter the Branches Dropdown to exactly `branch`. The remote branch label only
 * renders when its tip is in the loaded graph; on the fixture every origin/feature-NNN tip is
 * deep history, so the dropdown filter (which a user would use to find such a branch) is what
 * brings the tip into view. Re-render-safe: the options are re-queried after every click, since
 * each selection re-renders the list.
 */
const remoteBranchFilterSteps = (branch: string): readonly UiStep[] => [
	{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
	{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
	{ op: 'eval', expr: filterBranchDropdownExpr(branch) },
	{ op: 'key', key: 'Escape' },
	{ op: 'waitFor', selector: 'span.gitRef.remote[data-name="' + branch + '"]' }
];

/** UI steps that filter the Branches Dropdown to the context remote branch (origin/feature-000). */
const REMOTE_BRANCH_FILTER_STEPS: readonly UiStep[] = remoteBranchFilterSteps('origin/feature-000');

/** UI steps that reset the Branches Dropdown to "Show All" and wait for the reload to render. */
const SHOW_ALL_RESTORE_STEPS: readonly UiStep[] = [
	{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
	{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
	{ op: 'eval', expr: '[...document.querySelectorAll("#branchDropdown .dropdownOption")].find((o) => o.textContent.trim() === \'Show All\').click()' },
	{ op: 'key', key: 'Escape' },
	{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the restore reload has rendered
];

/**
 * A UI step that scrolls the commit table down until the row carrying `selector` renders
 * (windowed rendering keeps only the viewport rows in the DOM), then resolves. Starts from the
 * top — a preceding checkout may have scrolled the view deep — and is robust to the index shifts
 * earlier write-suite mutations cause; gives up after ~800 rows.
 */
const scrollUntilVisibleStep = (selector: string): UiStep => ({
	op: 'eval',
	expr: '(function(){return new Promise(function(resolve,reject){var v=document.getElementById("view");v.scrollTop=0;v.dispatchEvent(new Event("scroll"));var attempt=0;var step=function(){if(document.querySelector(' + JSON.stringify(selector) + '))return resolve("found");if(attempt++>40)return reject(new Error("row never rendered: ' + selector.replace(/"/g, '') + '"));v.scrollTop=attempt*20*24;v.dispatchEvent(new Event("scroll"));setTimeout(step,120);};setTimeout(step,150);});})()'
});

/**
 * A UI step that opens a Reflog row's action menu (the rows open their menu on CLICK, not
 * contextmenu — web/reflogView.ts) and clicks the item titled `item`. The click is dispatched
 * non-bubbling: the ContextMenu singleton closes itself on any document-level click, which would
 * otherwise remove the menu opened by this very event.
 */
const reflogRowMenuStep = (rowSelector: string, item: string): UiStep => ({
	op: 'eval',
	expr: '(function(){var row=document.querySelector(' + JSON.stringify(rowSelector) + ');if(row===null)throw new Error("reflog row not found: ' + rowSelector.replace(/"/g, '') + '");' +
		'row.dispatchEvent(new MouseEvent("click",{bubbles:false,cancelable:true}));' +
		'var items=document.querySelectorAll("ul.contextMenu li.contextMenuItem");' +
		'for(var i=0;i<items.length;i++){if(items[i].textContent.trim()===' + JSON.stringify(item) + '){items[i].click();return "clicked";}}' +
		'throw new Error("reflog menu item not found: ' + item + ' (saw " + Array.from(items).map(function(x){return x.textContent.trim();}).join("|") + ")");})()'
});

/** A UI step that closes the Reflog widget if a previous failed run left it open. */
const REFLOG_DEFENSIVE_CLOSE_STEP: UiStep = {
	op: 'eval',
	expr: '(function(){var w=document.getElementById("reflogWidget");if(w!==null&&w.className.split(/\\s+/).indexOf("active")!==-1){document.getElementById("reflogClose").click();return "closed";}return "clean";})()'
};

/**
 * A UI step that settles whatever dialog an action left open, so a mid-pass error can never
 * cascade into the next run. Responses are processed asynchronously relative to the step
 * execution, so it keeps acting and resolves once the page has been dialog-free for a moment:
 *   - a data-loss warning (a primary "Continue" and a "Cancel" secondary) is CONFIRMED — the
 *     webview then re-sends the request with its confirmed flag, which is what the automation
 *     driver does for request-mode loss warnings too;
 *   - an error dialog or the action-running overlay (secondary only) is dismissed;
 *   - anything else is removed.
 * A run whose expected responses never arrive still fails — this step only prevents the cascade.
 */
const DISMISS_ERROR_DIALOG_STEP: UiStep = {
	op: 'eval',
	expr: '(function(){return new Promise(function(resolve){var clear=0;var polls=0;var timer=setInterval(function(){var d=document.querySelector(".dialog");if(d!==null){clear=0;var p=d.querySelector("#dialogAction");var s=d.querySelector("#dialogSecondaryAction");if(p!==null)p.click();else if(s!==null)s.click();else d.remove();}else{clear++;polls++;if(clear>5||polls>100){clearInterval(timer);resolve("settled");}}},100);});})()'
};

/** UI steps that scroll the commit table back to the top and wait for the first row. */
const SCROLL_TOP_STEPS: readonly UiStep[] = [
	{ op: 'eval', expr: '(function(){var v=document.getElementById("view");v.scrollTop=0;v.dispatchEvent(new Event("scroll"));return 0;})()' },
	{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }
];

export const CATALOG: readonly AutomationAction[] = [
	/* ---------- Control bar ---------- */
	{
		id: 'control-bar/author-dropdown',
		title: 'Authors Dropdown',
		group: 'control-bar',
		mutable: false,
		// The dropdown lists the authors recorded in the repository config (the fixture's 40
		// "Fixture Author NN" identities), not the author of any single commit — the {{author}}
		// context value ("Fixture", the seed identity) is never an option, so the flow selects
		// the deterministic "Fixture Author 00" (author of every 40th fixture commit) and then
		// restores "All". A selection change reloads the commits only (the dropdown's change
		// callback skips the repo-info request), so no loadRepoInfo is expected.
		ui: [
			{ op: 'click', selector: '#authorDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#authorDropdown .dropdownOption' },
			{ op: 'eval', expr: '[...document.querySelectorAll("#authorDropdown .dropdownOption")].find((o) => o.textContent.trim() === \'Fixture Author 00\').click()' },
			{ op: 'key', key: 'Escape' }, // the multi-select dropdown stays open after a selection
			{ op: 'click', selector: '#authorDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#authorDropdown .dropdownOption' },
			{ op: 'eval', expr: '[...document.querySelectorAll("#authorDropdown .dropdownOption")].find((o) => o.textContent.trim() === \'All\').click()' },
			{ op: 'key', key: 'Escape' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the restore reload has rendered
		],
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'control-bar/branch-dropdown',
		title: 'Branches Dropdown',
		group: 'control-bar',
		mutable: false,
		// Selecting one branch (from the initial "Show All") reloads the commits only (the
		// dropdown's change callback skips the repo-info request), so no loadRepoInfo is expected.
		ui: [
			{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
			{ op: 'eval', expr: '[...document.querySelectorAll("#branchDropdown .dropdownOption")].find((o) => o.textContent.trim() === \'{{branch}}\').click()' },
			{ op: 'key', key: 'Escape' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the reload has rendered
		],
		// No request path: the reload derives from view state (currentBranches) only the live
		// view can assemble.
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'control-bar/current-btn',
		title: 'Scroll to the commit referenced by HEAD',
		group: 'control-bar',
		mutable: false,
		// Pure scroll — no host traffic.
		ui: [{ op: 'click', selector: '#currentBtn' }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'control-bar/fetch-btn',
		title: 'Fetch from Remote(s)',
		group: 'control-bar',
		mutable: true,
		requires: ['remote'],
		// No confirmation dialog: the click goes straight to the host; the only dialog is the
		// "Fetching..." action-running overlay, dismissed by the post-fetch refresh.
		ui: [
			{ op: 'click', selector: '#fetchBtn' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'fetch', repo: '{{repo}}', name: null, prune: false, pruneTags: false }],
		expect: { responses: ['fetch'] }
	},
	{
		id: 'control-bar/filter-btn',
		title: 'Filter Commits by Path',
		group: 'control-bar',
		mutable: false,
		// Applying (or clearing) a path filter reloads the commits only; the module file the
		// fixture guarantees (src/module-NNN/file-NN.ts) always yields a non-empty result. The
		// flow re-opens the dialog and clears the filter so later runs see the unfiltered graph.
		ui: [
			{ op: 'click', selector: '#filterBtn' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'set', selector: '#dialogInput0', value: 'src/module-000/file-00.ts', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{ op: 'click', selector: '#filterBtn' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogSecondaryAction' },
			{ op: 'waitForGone', selector: '.dialog' }
		],
		request: [{
			command: 'loadCommits', repo: '{{repo}}', refreshId: 0, hard: true,
			branches: null, authors: null, maxCommits: 10000, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date',
			remotes: [], hideRemotes: [], stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
			gerritStatusFilter: { new: false, merged: false, abandoned: false, wip: false }, filterPath: 'src/module-000/file-00.ts'
		}],
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'control-bar/find-open',
		title: 'Find',
		group: 'control-bar',
		mutable: false,
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'control-bar/load-more-commits',
		title: 'Load More Commits',
		group: 'control-bar',
		mutable: false,
		// The footer button exists only while moreCommitsAvailable (the fixture repository has
		// more commits than the initial page). Clicking it pages the commit list; completion is
		// gated by the loadCommits response.
		ui: [{ op: 'click', selector: '#loadMoreCommitsBtn' }],
		request: [{
			command: 'loadCommits', repo: '{{repo}}', refreshId: 0, hard: false,
			branches: null, authors: null, maxCommits: 10000, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date',
			remotes: [], hideRemotes: [], stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
			gerritStatusFilter: { new: false, merged: false, abandoned: false, wip: false }
		}],
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'control-bar/refresh',
		title: 'Refresh',
		group: 'control-bar',
		mutable: false,
		// The Refresh button is a hard reload: loadRepoInfo followed by loadCommits. Request
		// templates carry refreshId 0 — the live webview only honours responses echoing a
		// refreshId it sent, so an injected response can never corrupt its state.
		ui: [{ op: 'click', selector: '#refreshBtn' }],
		request: [
			{ command: 'loadRepoInfo', repo: '{{repo}}', refreshId: 0, showRemoteBranches: true, showStashes: true, hideRemotes: [] },
			{
				command: 'loadCommits', repo: '{{repo}}', refreshId: 0, hard: true,
				branches: null, authors: null, maxCommits: 10000, showTags: true, showRemoteBranches: true,
				includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date',
				remotes: [], hideRemotes: [], stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
				gerritStatusFilter: { new: false, merged: false, abandoned: false, wip: false }
			}
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'control-bar/settings-open',
		title: 'Settings',
		group: 'control-bar',
		mutable: false,
		// Opening the widget also re-requests the repository config; the flow closes the widget
		// again so later runs start from a clean surface.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadConfig'] }
	},
	{
		id: 'control-bar/show-remote-branches',
		title: 'Show Remote Branches',
		group: 'control-bar',
		mutable: true,
		// Toggling persists showRemoteBranchesV2 via a setRepoState the host answers silently,
		// then hard-refreshes. The flow toggles OFF and back ON: with the toggle left off the
		// host omits remote-tracking branches from the branch list, and every later entry that
		// needs a remote branch (the whole menu-remote-branch group) would break. No request
		// path: the setRepoState payload is the whole GitRepoState, which only the live view
		// can assemble.
		ui: [
			{ op: 'click', selector: '#showRemoteBranchesCheckbox' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the OFF reload has rendered
			{ op: 'click', selector: '#showRemoteBranchesCheckbox' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the ON reload has rendered
			DISMISS_ERROR_DIALOG_STEP
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'control-bar/statistics',
		title: 'Statistics',
		group: 'control-bar',
		mutable: false,
		ui: [
			{ op: 'click', selector: '#statisticsBtn' },
			{ op: 'waitFor', selector: '#statisticsWidget.active' },
			{ op: 'click', selector: '#statisticsClose' },
			{ op: 'waitForGone', selector: '#statisticsWidget.active' }
		],
		request: [{ command: 'repoStatistics', repo: '{{repo}}' }],
		expect: { responses: ['repoStatistics'] }
	},
	{
		id: 'control-bar/terminal',
		title: 'Open a Terminal for this Repository',
		group: 'control-bar',
		mutable: false,
		// The terminal button shows the action-running overlay until the host responds.
		ui: [
			{ op: 'click', selector: '#terminalBtn' },
			{ op: 'waitForGone', selector: '.dialog', timeoutMs: 10000 }
		],
		// `name` is display-only; the live view passes the repository's display name.
		request: [{ command: 'openTerminal', repo: '{{repo}}', name: '{{repo}}' }],
		expect: { responses: ['openTerminal'] }
	},

	/* ---------- Row interactions & column header menu ---------- */
	{
		id: 'row/column-ordering',
		title: 'Author Timestamp Order',
		group: 'row',
		mutable: true,
		// Right-clicking the column headers offers three orderings; picking one persists
		// commitOrdering in the repo state and hard-refreshes. No request path: the state write
		// is assembled by the live view. The trailing dismiss guards the run against a leftover
		// error dialog (the action answers through the refresh path).
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: 'Author Timestamp Order' },
			DISMISS_ERROR_DIALOG_STEP
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	// NOTE: "Reset Column Widths" has no entry: the webview only offers it after a manual column
	// resize froze the layout, and neither the shim's ops nor a plain driver can perform the
	// drag. Column-resize behaviour is covered by the view's unit tests instead.
	{
		id: 'row/column-toggle-date',
		title: 'Date',
		group: 'row',
		mutable: false,
		// Column visibility toggles persist columnWidths via a silent setRepoState and re-render.
		ui: [{ op: 'contextmenu', selector: '#tableColHeaders', item: 'Date' }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/compare-rows',
		title: 'Compare two commits (Ctrl+Click)',
		group: 'row',
		mutable: false,
		// The page path is a Ctrl+Click while a Commit Details View is open — a modifier click
		// the shim cannot express — so only the request path is modelled. getCommitOrder: the
		// commit nearer the top of the loaded table is `to`.
		request: [{
			command: 'compareCommits', repo: '{{repo}}',
			commitHash: '{{commit}}', compareWithHash: '{{commitParent}}',
			fromHash: '{{commitParent}}', toHash: '{{commit}}', refresh: false
		}],
		expect: { responses: ['compareCommits'] }
	},
	{
		id: 'row/dblclick-branch-checkout',
		title: 'Checkout Branch (double-click label)',
		group: 'row',
		mutable: true,
		// Double-clicking a local branch label checks the branch out directly — no dialog (the
		// data-loss guard does not cover checkoutBranch), only the action-running overlay.
		ui: [
			{ op: 'dblclick', selector: 'span.gitRef.head[data-name="{{branch}}"]' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'checkoutBranch', repo: '{{repo}}', branchName: '{{branch}}', remoteBranch: null, pullAfterwards: null }],
		expect: { responses: ['checkoutBranch'] },
		verify: { kind: 'headIs', placeholder: '{{branch}}' }
	},
	{
		id: 'row/open-changes-btn',
		title: 'Open Changes',
		group: 'row',
		mutable: false,
		// The per-row button opens the commit's changes (against its first parent) in a Commit
		// Comparison tab; the host answers openCompareTab with no response.
		ui: [{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"] .openChangesBtn' }],
		request: [{ command: 'openCompareTab', repo: '{{repo}}', fromHash: '{{commitParent}}', toHash: '{{commit}}', singleCommit: true }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/select-commit-row',
		title: 'Select Commit (expand Commit Details)',
		group: 'row',
		mutable: false,
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		// hasParents: the fixture's non-HEAD commit has a parent.
		request: [{ command: 'commitDetails', repo: '{{repo}}', commitHash: '{{commit}}', hasParents: true, stash: null, avatarEmail: null, refresh: false }],
		expect: { responses: ['commitDetails'] }
	},

	/* ---------- Commit context menu ---------- */
	{
		id: 'menu-commit/add-tag',
		title: 'Add Tag…',
		group: 'menu-commit',
		mutable: true,
		// The fixture's single remote adds a checked "push to remote" checkbox at #dialogInput3 —
		// unchecked here so the tag stays local. TextRef inputs validate on keyup, so the name
		// is typed through an eval (a plain `set` would leave the dialog's no-input state).
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Add Tag…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-tag";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogInput3' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		// type: TagType.Lightweight (numeric enum: Annotated = 0, Lightweight = 1).
		request: [{ command: 'addTag', repo: '{{repo}}', commitHash: '{{commit}}', tagName: 'automation-tag', type: 1, message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false }],
		expect: { responses: ['addTag'] }
	},
	{
		id: 'menu-commit/checkout',
		title: 'Checkout…',
		group: 'menu-commit',
		mutable: true,
		// "Always accept" stays unchecked so the confirmation dialog is part of the flow;
		// confirming detaches HEAD at the commit.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Checkout…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'checkoutCommit', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['checkoutCommit'] },
		// Detaching HEAD clears the checked-out branch name.
		verify: { kind: 'headIsNot', placeholder: '{{head}}' }
	},
	{
		id: 'menu-commit/cherry-pick',
		title: 'Cherry Pick…',
		group: 'menu-commit',
		mutable: true,
		// A non-merge commit gets no parent selector; both checkboxes keep their defaults.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Cherry Pick…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'cherrypickCommit', repo: '{{repo}}', commitHash: '{{commit}}', parentIndex: 0, recordOrigin: false, noCommit: false }],
		expect: { responses: ['cherrypickCommit'] }
	},
	{
		id: 'menu-commit/compare-with-selected',
		title: 'Compare with Selected Commit…',
		group: 'menu-commit',
		mutable: false,
		// Requires "Select for Compare" on another commit first (the live view keeps the source),
		// and the menu title carries a dynamic " (abbrevHash)" suffix — so only the request path
		// is modelled. The comparison opens a Commit Comparison tab, which has no response.
		request: [{ command: 'openCompareTab', repo: '{{repo}}', fromHash: '{{commitParent}}', toHash: '{{commit}}', singleCommit: false }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-commit/copy-hash',
		title: 'Copy Commit Hash to Clipboard',
		group: 'menu-commit',
		mutable: false,
		ui: [{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Copy Commit Hash to Clipboard' }],
		request: [{ command: 'copyToClipboard', type: 'Commit Hash', data: '{{commit}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-commit/copy-subject',
		title: 'Copy Commit Subject to Clipboard',
		group: 'menu-commit',
		mutable: false,
		// The copied subject is a runtime value the catalog cannot template (no subject
		// placeholder exists), so only the UI path is modelled.
		ui: [{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Copy Commit Subject to Clipboard' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-commit/create-branch',
		title: 'Create Branch…',
		group: 'menu-commit',
		mutable: true,
		// The checkout checkbox keeps its default (off), so HEAD stays put.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Create Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-branch";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commit}}', branchName: 'automation-branch', checkout: false, force: false }],
		expect: { responses: ['createBranch'] }
	},
	{
		// NOTE: no UI path. The menu item is only rendered when the repository config sets
		// diff.tool / gui.diffTool (web/contextMenuActions.ts), the fixture seed configures
		// neither, and no catalog step can write git config — so the item can never be reached
		// in a UI run. The request path below still exercises the host side.
		id: 'menu-commit/diff-working-tree',
		title: 'Diff with Working Tree…',
		group: 'menu-commit',
		mutable: false,
		request: [{ command: 'openExternalDirDiff', repo: '{{repo}}', fromHash: '{{commit}}', toHash: '*', isGui: false }],
		expect: { responses: ['openExternalDirDiff'] }
	},
	{
		id: 'menu-commit/drop',
		title: 'Drop…',
		group: 'menu-commit',
		mutable: true,
		// dropCommit always carries a data-loss risk: after the confirmation dialog, a second
		// (risk acknowledgement) dialog must be confirmed. The item is only offered when the
		// graph can drop the commit (not the checked-out tip).
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Drop…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'dropCommit', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['dropCommit'] }
	},
	{
		id: 'menu-commit/edit-message',
		title: 'Edit Message…',
		group: 'menu-commit',
		mutable: true,
		// Only offered for commits that are not merges and not on a remote (the host
		// re-validates before rewriting), so the fixture's `commit` must satisfy that.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Edit Message…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'set', selector: '#dialogInput0', value: 'Reworded via automation', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'editCommitMessage', repo: '{{repo}}', commitHash: '{{commit}}', message: 'Reworded via automation' }],
		expect: { responses: ['editCommitMessage'] }
	},
	{
		id: 'menu-commit/fixup',
		title: 'Create Fixup Commit',
		group: 'menu-commit',
		mutable: true,
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Create Fixup Commit' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'commitFixup', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['commitFixup'] }
	},
	{
		id: 'menu-commit/merge',
		title: 'Merge into current branch…',
		group: 'menu-commit',
		mutable: true,
		// The dialog fires a predictConflicts probe first (unawaited traffic); with the default
		// "create a commit" (no fast-forward) checkbox set, the merge commits.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Merge into current branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'merge', repo: '{{repo}}', obj: '{{commit}}', actionOn: 'Commit', createNewCommit: true, squash: false, noCommit: false }],
		expect: { responses: ['merge'] }
	},
	{
		id: 'menu-commit/rebase',
		title: 'Rebase current branch on this Commit…',
		group: 'menu-commit',
		mutable: true,
		// Checkbox defaults: interactive off, ignore-date on, autosquash off.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Rebase current branch on this Commit…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'rebase', repo: '{{repo}}', obj: '{{commit}}', actionOn: 'Commit', ignoreDate: true, interactive: false, autosquash: false }],
		expect: { responses: ['rebase'] }
	},
	{
		id: 'menu-commit/reset-soft',
		title: 'Reset Last Commit (Soft)…',
		group: 'menu-commit',
		mutable: true,
		// Offered only on the checked-out commit's row, which carries the commitHeadDot marker —
		// unlike the .current class, that excludes the uncommitted-changes row.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit:has(.commitHeadDot)', item: 'Reset Last Commit (Soft)…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'undoLastCommit', repo: '{{repo}}' }],
		expect: { responses: ['undoLastCommit'] }
	},
	{
		id: 'menu-commit/reset-to-commit',
		title: 'Reset current branch to this Commit…',
		group: 'menu-commit',
		mutable: true,
		// The mode selector is a CustomSelect left at its default (Mixed — no data-loss warning).
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Reset current branch to this Commit…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'resetToCommit', repo: '{{repo}}', commit: '{{commit}}', resetMode: 'mixed' }],
		expect: { responses: ['resetToCommit'] }
	},
	{
		id: 'menu-commit/revert',
		title: 'Revert…',
		group: 'menu-commit',
		mutable: true,
		// Non-merge commits get a plain confirmation with parentIndex 0.
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Revert…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'revertCommit', repo: '{{repo}}', commitHash: '{{commit}}', parentIndex: 0 }],
		expect: { responses: ['revertCommit'] }
	},
	{
		id: 'menu-commit/select-for-compare',
		title: 'Select for Compare',
		group: 'menu-commit',
		mutable: false,
		// Pure view state — no message leaves the webview.
		ui: [{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Select for Compare' }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-commit/squash',
		title: 'Create Squash Commit',
		group: 'menu-commit',
		mutable: true,
		ui: [
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: 'Create Squash Commit' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'commitSquash', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['commitSquash'] }
	},

	/* ---------- Uncommitted changes context menu ---------- */
	// The uncommitted-changes row only renders while HEAD is inside the loaded first page (the
	// host skips the status follow-up otherwise), so this group runs right after menu-commit —
	// later groups check out branches whose tips are deep history, which would strand HEAD
	// outside the loaded page and the row with it.
	{
		id: 'menu-uncommitted/clean-untracked',
		title: 'Clean untracked files…',
		group: 'menu-uncommitted',
		mutable: true,
		// The directories checkbox keeps its default (on); cleaning always carries a data-loss
		// risk, so a second (risk acknowledgement) dialog follows the confirmation.
		ui: [
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: 'Clean untracked files…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'cleanUntrackedFiles', repo: '{{repo}}', directories: true }],
		expect: { responses: ['cleanUntrackedFiles'] }
	},
	{
		id: 'menu-uncommitted/open-source-control',
		title: 'Open Source Control View',
		group: 'menu-uncommitted',
		mutable: false,
		ui: [{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: 'Open Source Control View' }],
		request: [{ command: 'viewScm' }],
		expect: { responses: ['viewScm'] }
	},
	{
		id: 'menu-uncommitted/reset',
		title: 'Reset uncommitted changes…',
		group: 'menu-uncommitted',
		mutable: true,
		// The mode selector is a CustomSelect left at its default (Mixed — no data-loss
		// warning). Resets 'HEAD', moving neither HEAD nor the branch name.
		ui: [
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: 'Reset uncommitted changes…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'resetToCommit', repo: '{{repo}}', commit: 'HEAD', resetMode: 'mixed' }],
		expect: { responses: ['resetToCommit'] }
	},
	{
		id: 'menu-uncommitted/stash',
		title: 'Stash uncommitted changes…',
		group: 'menu-uncommitted',
		mutable: true,
		// Message + include-untracked checkbox (default on, matching the request template).
		ui: [
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: 'Stash uncommitted changes…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'set', selector: '#dialogInput0', value: 'Automation stash', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'pushStash', repo: '{{repo}}', message: 'Automation stash', includeUntracked: true }],
		expect: { responses: ['pushStash'] }
	},
	/* ---------- Local branch context menu ---------- */
	{
		id: 'menu-branch/checkout',
		title: 'Checkout Branch',
		group: 'menu-branch',
		mutable: true,
		// A local checkout runs immediately — no confirmation (only the action-running overlay,
		// closed by the post-checkout refresh).
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Checkout Branch' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'checkoutBranch', repo: '{{repo}}', branchName: '{{branch}}', remoteBranch: null, pullAfterwards: null }],
		expect: { responses: ['checkoutBranch'] },
		verify: { kind: 'headIs', placeholder: '{{branch}}' }
	},
	{
		id: 'menu-branch/compare-with',
		title: 'Compare with...',
		group: 'menu-branch',
		mutable: false,
		// A branch-picker dialog whose Compare action opens a Commit Comparison tab (no host
		// response); the target defaults to the first other branch.
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Compare with...' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-branch/copy-name',
		title: 'Copy Branch Name to Clipboard',
		group: 'menu-branch',
		mutable: false,
		ui: [{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Copy Branch Name to Clipboard' }],
		request: [{ command: 'copyToClipboard', type: 'Branch Name', data: '{{branch}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-branch/create-archive',
		title: 'Create Archive',
		group: 'menu-branch',
		mutable: true,
		// Writes the archive into the working tree — the driver re-creates the fixture around it.
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Create Archive' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'createArchive', repo: '{{repo}}', ref: '{{branch}}' }],
		expect: { responses: ['createArchive'] }
	},
	{
		id: 'menu-branch/create-branch',
		title: 'Create Branch…',
		group: 'menu-branch',
		mutable: true,
		// Creates at the label's commit; `commit` approximates that hash in request mode.
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Create Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-branch-2";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commit}}', branchName: 'automation-branch-2', checkout: false, force: false }],
		expect: { responses: ['createBranch'] }
	},
	{
		id: 'menu-branch/delete',
		title: 'Delete Branch…',
		group: 'menu-branch',
		mutable: true,
		// The fixture's branches are mostly left open (unmerged), so the flow checks "force
		// delete" — which always carries a data-loss risk and adds a second (risk
		// acknowledgement) dialog after the confirmation. The remote-deletion checkbox (present
		// only for branches that exist on a remote) stays unchecked.
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Delete Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogInput0' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'deleteBranch', repo: '{{repo}}', branchName: '{{branch}}', forceDelete: true, deleteOnRemotes: [] }],
		expect: { responses: ['deleteBranch'] },
		verify: { kind: 'branchAbsent', placeholder: '{{branch}}' }
	},
	{
		id: 'menu-branch/merge',
		title: 'Merge into current branch…',
		group: 'menu-branch',
		mutable: true,
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Merge into current branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'merge', repo: '{{repo}}', obj: '{{branch}}', actionOn: 'Branch', createNewCommit: true, squash: false, noCommit: false }],
		expect: { responses: ['merge'] }
	},
	{
		id: 'menu-branch/pull',
		title: 'Pull Branch…',
		group: 'menu-branch',
		mutable: true,
		requires: ['remote'],
		// The dialog offers a force-update checkbox (default off — no data-loss warning); the
		// request fetches the branch from the first remote into the same-named local branch.
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Pull Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'fetchIntoLocalBranch', repo: '{{repo}}', remote: '{{remote}}', remoteBranch: '{{branch}}', localBranch: '{{branch}}', force: false }],
		expect: { responses: ['fetchIntoLocalBranch'] }
	},
	{
		id: 'menu-branch/push',
		title: 'Push Branch…',
		group: 'menu-branch',
		mutable: true,
		requires: ['remote'],
		// With a single remote the dialog is a set-upstream checkbox (default on) and a push-mode
		// radio left at Normal (a force mode would trigger the data-loss warning).
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Push Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		// mode: GitPushBranchMode.Normal ('').
		request: [{ command: 'pushBranch', repo: '{{repo}}', branchName: '{{branch}}', remotes: ['{{remote}}'], setUpstream: true, mode: '', willUpdateBranchConfig: true }],
		expect: { responses: ['pushBranch'] }
	},
	{
		id: 'menu-branch/rebase',
		title: 'Rebase current branch on Branch…',
		group: 'menu-branch',
		mutable: true,
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Rebase current branch on Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'rebase', repo: '{{repo}}', obj: '{{branch}}', actionOn: 'Branch', ignoreDate: true, interactive: false, autosquash: false }],
		expect: { responses: ['rebase'] }
	},
	{
		id: 'menu-branch/rename',
		title: 'Rename Branch…',
		group: 'menu-branch',
		mutable: true,
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: 'Rename Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="{{branch}}-renamed";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'renameBranch', repo: '{{repo}}', oldName: '{{branch}}', newName: '{{branch}}-renamed' }],
		expect: { responses: ['renameBranch'] },
		verify: { kind: 'branchAbsent', placeholder: '{{branch}}' }
	},
	{
		id: 'menu-branch/select-in-dropdown',
		title: 'Select in Branches Dropdown',
		group: 'menu-branch',
		mutable: false,
		// The item's title depends on the dropdown state: with "Show All" active (or the branch
		// selected) the menu offers "Unselect in Branches Dropdown", otherwise "Select in
		// Branches Dropdown" — Dropdown.isSelected() treats Show All as everything selected. The
		// eval clicks whichever the current state offers (both drive the same control), then the
		// dropdown is reset to "Show All" so later runs start from the known initial state.
		ui: [
			{ op: 'waitFor', selector: 'span.gitRef.head[data-name="main"]' },
			{
				op: 'eval',
				expr: '(function(){var l=document.querySelector(\'span.gitRef.head[data-name="main"]\');if(l===null)throw new Error(\'main label not rendered\');l.dispatchEvent(new MouseEvent(\'contextmenu\',{bubbles:true,cancelable:true,button:2}));var items=document.querySelectorAll(\'ul.contextMenu li.contextMenuItem\');for(var i=0;i<items.length;i++){var t=items[i].textContent.trim();if(t===\'Select in Branches Dropdown\'||t===\'Unselect in Branches Dropdown\'){items[i].click();return t;}}throw new Error(\'select/unselect item not found: \'+Array.from(items).map(function(x){return x.textContent.trim();}).join(\'|\'));})()'
			},
			{ op: 'waitFor', selector: 'span.gitRef.head[data-name="main"]' }, // the reload has rendered
			{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
			{ op: 'eval', expr: '[...document.querySelectorAll("#branchDropdown .dropdownOption")].find((o) => o.textContent.trim() === \'Show All\').click()' },
			{ op: 'key', key: 'Escape' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the restore reload has rendered
		],
		expect: { responses: ['loadCommits'] }
	},

	/* ---------- Remote branch context menu ---------- */
	{
		id: 'menu-remote-branch/checkout',
		title: 'Checkout Branch…',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		// The remote label only renders when its tip is in the loaded graph, which on the fixture
		// requires filtering the Branches Dropdown to that branch (its tip is ancient history) —
		// the preamble selects it, the epilogue restores "Show All". Checking out a remote branch
		// asks for the new local branch name; the prefill (the short name) usually exists locally,
		// so the flow types a fresh name and takes the create-new-branch path. The label's
		// data-name is the remote-prefixed ref.
		ui: [
			...REMOTE_BRANCH_FILTER_STEPS,
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="origin/feature-000"]', item: 'Checkout Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-remote-checkout";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'checkoutBranch', repo: '{{repo}}', branchName: 'automation-remote-checkout', remoteBranch: '{{remote}}/{{remoteBranch}}', pullAfterwards: null }],
		expect: { responses: ['checkoutBranch'] }
	},
	{
		id: 'menu-remote-branch/copy-name',
		title: 'Copy Branch Name to Clipboard',
		group: 'menu-remote-branch',
		mutable: false,
		requires: ['remote'],
		// The remote label only renders when its tip is in the loaded graph (see
		// REMOTE_BRANCH_FILTER_STEPS); the copied name is the remote-prefixed ref.
		ui: [
			...REMOTE_BRANCH_FILTER_STEPS,
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="origin/feature-000"]', item: 'Copy Branch Name to Clipboard' },
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'copyToClipboard', type: 'Branch Name', data: '{{remote}}/{{remoteBranch}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-remote-branch/create-archive',
		title: 'Create Archive',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		// Writes the archive into the working tree — the driver re-creates the fixture around it.
		// The fixture host answers with an error dialog (after the action-running overlay), which
		// the flow settles and dismisses.
		ui: [
			...REMOTE_BRANCH_FILTER_STEPS,
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="origin/feature-000"]', item: 'Create Archive' },
			{ op: 'waitFor', selector: '.dialog' },
			DISMISS_ERROR_DIALOG_STEP,
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'createArchive', repo: '{{repo}}', ref: '{{remote}}/{{remoteBranch}}' }],
		expect: { responses: ['createArchive'] }
	},
	{
		id: 'menu-remote-branch/create-branch',
		title: 'Create Branch…',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		// The checkout checkbox keeps its default (on): the new branch is created at the remote
		// branch's commit and checked out. `commit` approximates that commit in request mode.
		ui: [
			...REMOTE_BRANCH_FILTER_STEPS,
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="origin/feature-000"]', item: 'Create Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-remote-branch";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commit}}', branchName: 'automation-remote-branch', checkout: true, force: false }],
		expect: { responses: ['createBranch'] }
	},
	{
		id: 'menu-remote-branch/delete-remote-branch',
		title: 'Delete Remote Branch…',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		// Deleting a remote branch always carries a data-loss risk: after the confirmation
		// dialog, a second (risk acknowledgement) dialog must be confirmed. origin/feature-007 is
		// used (not the shared {{remoteBranch}}) so the branch survives for the later
		// remote-branch entries in the same write pass.
		ui: [
			...remoteBranchFilterSteps('origin/feature-007'),
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="origin/feature-007"]', item: 'Delete Remote Branch…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'deleteRemoteBranch', repo: '{{repo}}', branchName: 'feature-007', remote: '{{remote}}' }],
		expect: { responses: ['deleteRemoteBranch'] }
	},
	{
		// NOTE: no UI path. The item is only offered when a same-named local branch exists and is
		// not checked out; the fixture clone has just main / local-ahead locally (its remote
		// branches are origin/main and origin/feature-NNN), so no remote branch qualifies and the
		// item can never be reached in a UI run.
		id: 'menu-remote-branch/fetch-into',
		title: 'Fetch into local branch',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		request: [{ command: 'fetchIntoLocalBranch', repo: '{{repo}}', remote: '{{remote}}', remoteBranch: '{{remoteBranch}}', localBranch: '{{remoteBranch}}', force: false }],
		expect: { responses: ['fetchIntoLocalBranch'] }
	},
	{
		// NOTE: no UI path. In the write pass menu-remote-branch/create-branch checks out a local
		// branch at origin/feature-000's tip, after which the tip's remote label renders combined
		// with the local one (no .gitRef.remote element exists to right-click), and the Branches
		// Dropdown filter a UI flow needs would leave the graph filtered when the run fails. The
		// merge of origin/feature-000 into that checked-out branch resolves as already-up-to-date,
		// which the request path exercises directly.
		id: 'menu-remote-branch/merge',
		title: 'Merge into current branch…',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		request: [{ command: 'merge', repo: '{{repo}}', obj: 'origin/feature-000', actionOn: 'Remote-tracking Branch', createNewCommit: true, squash: false, noCommit: false }],
		expect: { responses: ['merge'] }
	},
	{
		// NOTE: no UI path — same order-sensitivity as menu-remote-branch/merge (the remote label
		// is combined with the checked-out local branch by the time this entry runs).
		id: 'menu-remote-branch/pull-into',
		title: 'Pull into current branch…',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		request: [{ command: 'pullBranch', repo: '{{repo}}', branchName: 'feature-000', remote: '{{remote}}', createNewCommit: false, squash: false }],
		expect: { responses: ['pullBranch'] }
	},
	{
		id: 'menu-remote-branch/select-in-dropdown',
		title: 'Unselect in Branches Dropdown',
		group: 'menu-remote-branch',
		mutable: false,
		requires: ['remote'],
		// With the dropdown filtered to the branch (the filter the other menu-remote-branch
		// entries use to reveal the label), the branch IS selected, so the menu offers
		// "Unselect in Branches Dropdown"; clicking it unselects the branch and — every other
		// option being off — the dropdown falls back to "Show All", restoring the initial state.
		ui: [
			...REMOTE_BRANCH_FILTER_STEPS,
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="origin/feature-000"]', item: 'Unselect in Branches Dropdown' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the fallback reload has rendered
		],
		expect: { responses: ['loadCommits'] }
	},

	/* ---------- Stash context menu ---------- */
	{
		id: 'menu-stash/apply',
		title: 'Apply Stash…',
		group: 'menu-stash',
		mutable: true,
		requires: ['stash'],
		// The reinstate-index checkbox keeps its default (off).
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: 'Apply Stash…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'applyStash', repo: '{{repo}}', selector: '{{stash}}', reinstateIndex: false }],
		expect: { responses: ['applyStash'] }
	},
	{
		id: 'menu-stash/branch-from-stash',
		title: 'Create Branch from Stash…',
		group: 'menu-stash',
		mutable: true,
		requires: ['stash'],
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: 'Create Branch from Stash…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-stash-branch";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'branchFromStash', repo: '{{repo}}', selector: '{{stash}}', branchName: 'automation-stash-branch' }],
		expect: { responses: ['branchFromStash'] }
	},
	{
		id: 'menu-stash/copy-hash',
		title: 'Copy Stash Hash to Clipboard',
		group: 'menu-stash',
		mutable: false,
		requires: ['stash'],
		// The stash commit hash is a runtime value with no placeholder, so only the UI path.
		ui: [{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: 'Copy Stash Hash to Clipboard' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-stash/copy-name',
		title: 'Copy Stash Name to Clipboard',
		group: 'menu-stash',
		mutable: false,
		requires: ['stash'],
		ui: [{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: 'Copy Stash Name to Clipboard' }],
		request: [{ command: 'copyToClipboard', type: 'Stash Name', data: '{{stash}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-stash/drop',
		title: 'Drop Stash…',
		group: 'menu-stash',
		mutable: true,
		requires: ['stash'],
		// Dropping a stash always carries a data-loss risk: after the confirmation dialog, a
		// second (risk acknowledgement) dialog must be confirmed.
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: 'Drop Stash…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'dropStash', repo: '{{repo}}', selector: '{{stash}}' }],
		expect: { responses: ['dropStash'] }
	},
	{
		id: 'menu-stash/pop',
		title: 'Pop Stash…',
		group: 'menu-stash',
		mutable: true,
		requires: ['stash'],
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: 'Pop Stash…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'popStash', repo: '{{repo}}', selector: '{{stash}}', reinstateIndex: false }],
		expect: { responses: ['popStash'] }
	},

	/* ---------- Tag context menu ---------- */
	{
		id: 'menu-tag/copy-name',
		title: 'Copy Tag Name to Clipboard',
		group: 'menu-tag',
		mutable: false,
		// The first page of the fixture graph renders no tag rows (they start ~100 commits deep),
		// and windowed rendering keeps only the viewport rows in the DOM — so the flow scrolls
		// until the deterministic v1.29.0 label (first tagged commit in the loaded page) renders,
		// then restores the scroll position. The request path uses v1.0.0, which always exists in
		// the repository.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="v1.29.0"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="v1.29.0"]', item: 'Copy Tag Name to Clipboard' },
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'copyToClipboard', type: 'Tag Name', data: 'v1.0.0' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-tag/create-archive',
		title: 'Create Archive',
		group: 'menu-tag',
		mutable: true,
		// The fixture host answers with an error dialog (after the action-running overlay),
		// which the flow settles and dismisses.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="v1.29.0"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="v1.29.0"]', item: 'Create Archive' },
			{ op: 'waitFor', selector: '.dialog' },
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'createArchive', repo: '{{repo}}', ref: 'v1.0.0' }],
		expect: { responses: ['createArchive'] }
	},
	{
		id: 'menu-tag/delete',
		title: 'Delete Tag…',
		group: 'menu-tag',
		mutable: true,
		// With a single remote the dialog is an "also delete on remote" checkbox (default off,
		// so the remote copy survives). v1.29.0 is used (not the request path's v1.0.0) so the
		// local tag survives until this entry runs; menu-tag/push uses a different tag again.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="v1.29.0"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="v1.29.0"]', item: 'Delete Tag…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'deleteTag', repo: '{{repo}}', tagName: 'v1.0.0', deleteOnRemote: null }],
		expect: { responses: ['deleteTag'] }
	},
	{
		id: 'menu-tag/push',
		title: 'Push Tag…',
		group: 'menu-tag',
		mutable: true,
		requires: ['remote'],
		// With a single remote the dialog is a plain confirmation. v1.28.0 (annotated) is used
		// because menu-tag/delete has already removed v1.29.0 in the same write pass. The tag
		// already exists on the fixture remote, so the host answers with an error dialog (after
		// the action-running overlay), which the flow settles and dismisses. `commit`
		// approximates the tagged commit (the live flow passes the tag's own commit hash).
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="v1.28.0"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="v1.28.0"]', item: 'Push Tag…' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'pushTag', repo: '{{repo}}', tagName: 'v1.0.0', remotes: ['{{remote}}'], commitHash: '{{commit}}', skipRemoteCheck: false }],
		expect: { responses: ['pushTag'] }
	},
	{
		id: 'menu-tag/view-details',
		title: 'View Details',
		group: 'menu-tag',
		mutable: false,
		// Only offered for annotated tags; v1.28.0 is the first annotated tag of the loaded page
		// (~200 commits deep — the flow scrolls to it and back). The details arrive in a dialog
		// (`.messageContent` distinguishes it from the action-running overlay, which also offers a
		// "Dismiss" secondary — dismissing the overlay before the response would let the details
		// dialog open behind it); it is closed with its Close action. `commit` approximates the
		// tagged commit; the response arrives regardless.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="v1.28.0"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="v1.28.0"]', item: 'View Details' },
			{ op: 'waitFor', selector: '.dialog .messageContent' },
			{ op: 'click', selector: '#dialogSecondaryAction' },
			{ op: 'waitForGone', selector: '.dialog', timeoutMs: 10000 },
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'tagDetails', repo: '{{repo}}', tagName: 'v1.0.0', commitHash: '{{commit}}' }],
		expect: { responses: ['tagDetails'] }
	},


	/* ---------- Commit Details View ---------- */
	{
		id: 'cdv/code-review',
		title: 'Start Code Review',
		group: 'cdv',
		mutable: true,
		// The review is ended again at the end of the flow (endCodeReview has no response) so
		// later runs see a clean state. The trailing dismiss guards the run against a leftover
		// error dialog (a startCodeReview failure would otherwise swallow the next run's steps).
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCodeReview' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitFor', selector: '#cdvCodeReview.active' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitForGone', selector: '#cdvCodeReview.active' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' },
			DISMISS_ERROR_DIALOG_STEP
		],
		expect: { responses: ['startCodeReview'] }
	},
	{
		id: 'cdv/collapse-folders',
		title: 'Collapse/Expand Folders (collapse)',
		group: 'cdv',
		mutable: false,
		// Folder open/closed state is webview state only — no host traffic.
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCollapse' },
			{ op: 'click', selector: '#cdvCollapse' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'cdv/expand-folders',
		title: 'Expand Folders',
		group: 'cdv',
		mutable: false,
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvExpand' },
			{ op: 'click', selector: '#cdvExpand' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		// NOTE: no UI path. #cdvExternalDiff always renders, but without the repository config
		// setting diff.tool / gui.diffTool its click handler returns early (commitDetailsView.ts),
		// and the fixture seed configures neither — so no openExternalDirDiff request can be
		// produced in a UI run. The request path below still exercises the host side.
		id: 'cdv/external-diff',
		title: 'Open External Directory Diff',
		group: 'cdv',
		mutable: false,
		// fromHash/toHash: a plain commit diffs against its first parent; `commitParent`
		// approximates that parent (identical unless the commit is a merge or root).
		request: [{ command: 'openExternalDirDiff', repo: '{{repo}}', fromHash: '{{commitParent}}', toHash: '{{commit}}', isGui: false }],
		expect: { responses: ['openExternalDirDiff'] }
	},
	{
		id: 'cdv/file-copy-path',
		title: 'Copy Absolute File Path to Clipboard',
		group: 'cdv',
		mutable: false,
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: 'Copy Absolute File Path to Clipboard' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'copyFilePath', repo: '{{repo}}', filePath: '{{file}}', absolute: true }],
		expect: { responses: ['copyFilePath'] }
	},
	{
		id: 'cdv/file-mark-reviewed',
		title: 'Mark as Reviewed',
		group: 'cdv',
		mutable: true,
		// Only offered while a code review is in progress and the file is still unreviewed, so
		// the flow starts a review first and ends it again afterwards. `file` (the first file of
		// the commit's details) is data-index 0 in the freshly opened view.
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCodeReview' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitFor', selector: '#cdvCodeReview.active' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: 'Mark as Reviewed' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitForGone', selector: '#cdvCodeReview.active' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' },
			DISMISS_ERROR_DIALOG_STEP
		],
		expect: { responses: ['startCodeReview', 'updateCodeReview'] }
	},
	{
		id: 'cdv/file-open-file',
		title: 'Open File',
		group: 'cdv',
		mutable: false,
		// `file` belongs to the context commit, which the fixture checks out only on local-ahead —
		// at HEAD=main the working tree does not contain it, so the host answers with an error
		// dialog that the flow dismisses (a leaked modal would swallow the keyboard shortcuts of
		// the later runs).
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: 'Open File' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'openFile', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['openFile'] }
	},
	{
		id: 'cdv/file-view-diff',
		title: 'View Diff',
		group: 'cdv',
		mutable: false,
		// A single commit diffs against its first parent. The fixture history only ever contains
		// Modified changes (no adds/deletes/renames), so type 'M' with oldFilePath ===
		// newFilePath is exact for it; other repositories would need the runtime values.
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: 'View Diff' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiff', repo: '{{repo}}', fromHash: '{{commit}}', toHash: '{{commit}}', oldFilePath: '{{file}}', newFilePath: '{{file}}', type: 'M' }],
		expect: { responses: ['viewDiff'] }
	},
	{
		id: 'cdv/file-view-diff-working-file',
		title: 'View Diff with Working File',
		group: 'cdv',
		mutable: false,
		// Only offered when the file still exists at this revision and is not binary.
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: 'View Diff with Working File' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiffWithWorkingFile', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['viewDiffWithWorkingFile'] }
	},
	{
		id: 'cdv/file-view-file-at-revision',
		title: 'View File at this Revision',
		group: 'cdv',
		mutable: false,
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: 'View File at this Revision' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewFileAtRevision', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['viewFileAtRevision'] }
	},
	{
		id: 'cdv/file-view-list',
		title: 'File List View',
		group: 'cdv',
		mutable: false,
		// The view-type change persists via a setRepoState the host answers silently.
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvFileViewTypeList' },
			{ op: 'click', selector: '#cdvFileViewTypeList' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'cdv/file-view-tree',
		title: 'File Tree View',
		group: 'cdv',
		mutable: false,
		ui: [
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvFileViewTypeTree' },
			{ op: 'click', selector: '#cdvFileViewTypeTree' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	// NOTE: "Toggle Markdown / Plain Text" has no entry: #cdvMarkdownToggle only renders while a
	// Markdown-looking file is open in the Commit Details View, and the fixture's history (and the
	// context commit) contains none — so the control cannot be reached in a catalog run. Markdown
	// rendering itself has unit coverage.

	/* ---------- Settings widget ---------- */
	{
		id: 'settings/add-author',
		title: 'Add Author',
		group: 'settings',
		mutable: true,
		// Saves the commitAuthors global setting; the host may also default the global Git
		// config, reported via authorConfigTouched.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsAddAuthor' },
			{ op: 'click', selector: '#settingsAddAuthor' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'set', selector: '#dialogInput0', value: 'Automation Author', event: 'input' },
			{ op: 'set', selector: '#dialogInput1', value: 'automation@example.com', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'setGlobalSetting', setting: 'commitAuthors', value: [{ name: 'Automation Author', email: 'automation@example.com' }] }],
		expect: { responses: ['setGlobalSetting'] }
	},
	{
		id: 'settings/add-remote',
		title: 'Add Remote',
		group: 'settings',
		mutable: true,
		// The URL reuses the repository's own path (always present); "fetch immediately" is
		// unchecked so no fetch runs against the stand-in URL.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsAddRemote' },
			{ op: 'click', selector: '#settingsAddRemote' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'set', selector: '#dialogInput0', value: 'automation-remote', event: 'input' },
			{ op: 'set', selector: '#dialogInput1', value: '{{repo}}', event: 'input' },
			{ op: 'click', selector: '#dialogInput3' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'addRemote', repo: '{{repo}}', name: 'automation-remote', url: '{{repo}}', pushUrl: null, fetch: false }],
		expect: { responses: ['addRemote'] }
	},
	{
		id: 'settings/delete-remote',
		title: 'Delete Remote',
		group: 'settings',
		mutable: true,
		// The first row of the remotes table (the fixture's origin).
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsWidget .deleteRemote' },
			{ op: 'click', selector: '#settingsWidget .deleteRemote' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'deleteRemote', repo: '{{repo}}', name: '{{remote}}' }],
		expect: { responses: ['deleteRemote'] }
	},
	{
		id: 'settings/edit-remote',
		title: 'Edit Remote',
		group: 'settings',
		mutable: true,
		// The dialog opens prefilled; confirming without changes rewrites the same values (a
		// no-op edit keeps the flow deterministic without knowing the live URL).
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsWidget .editRemote' },
			{ op: 'click', selector: '#settingsWidget .editRemote' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'editRemote', repo: '{{repo}}', nameOld: '{{remote}}', nameNew: '{{remote}}', urlOld: null, urlNew: null, pushUrlOld: null, pushUrlNew: null }],
		expect: { responses: ['editRemote'] }
	},
	{
		id: 'settings/export-repo-config',
		title: 'Export Repository Configuration',
		group: 'settings',
		mutable: true,
		// Writes the export file into the working tree — the driver re-creates the fixture
		// around it.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#exportRepositoryConfig' },
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'exportRepoConfig', repo: '{{repo}}' }],
		expect: { responses: ['exportRepoConfig'] }
	},
	{
		id: 'settings/first-parent',
		title: 'Only Follow First Parent',
		group: 'settings',
		mutable: true,
		// Each toggle persists via a silent setRepoState and then hard-refreshes.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#settingsOnlyFollowFirstParent' },
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/include-reflog',
		title: 'Include commits mentioned by reflogs',
		group: 'settings',
		mutable: true,
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#settingsIncludeCommitsMentionedByReflogs' },
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/open-reflog',
		title: 'View Reflog',
		group: 'settings',
		mutable: false,
		// The tool button closes the settings widget and opens the Reflog widget, which loads
		// the HEAD reflog.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '#reflogWidget.active' },
			{ op: 'waitFor', selector: '.reflogRow' },
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'reflog', repo: '{{repo}}', ref: 'HEAD', limit: 200 }],
		expect: { responses: ['reflog'] }
	},
	{
		id: 'settings/open-worktree-dialog',
		title: 'Manage Worktrees',
		group: 'settings',
		mutable: false,
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openWorktreeDialog' },
			{ op: 'waitFor', selector: '#worktreeAddBtn' },
			{ op: 'waitFor', selector: '.worktreeRow' },
			{ op: 'click', selector: '#worktreeClose' },
			{ op: 'waitForGone', selector: '#worktreeWidget.active' }
		],
		request: [{ command: 'worktreeList', repo: '{{repo}}' }],
		expect: { responses: ['worktreeList'] }
	},
	{
		id: 'settings/show-stashes',
		title: 'Show Stashes',
		group: 'settings',
		mutable: true,
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#settingsShowStashes' },
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/show-tags',
		title: 'Show Tags',
		group: 'settings',
		mutable: true,
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#settingsShowTags' },
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},

	/* ---------- Find widget ---------- */
	{
		id: 'find/close',
		title: 'Close Find',
		group: 'find',
		mutable: false,
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'find/find-next',
		title: 'Next Match',
		group: 'find',
		mutable: false,
		// Match navigation only scrolls and re-highlights — no host traffic.
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{branch}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'click', selector: '#findNext' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'find/find-prev',
		title: 'Previous Match',
		group: 'find',
		mutable: false,
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{branch}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'click', selector: '#findPrev' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'find/open-commit',
		title: 'Open Commit Details View for the current match',
		group: 'find',
		mutable: false,
		// The button toggles "open the Commit Details View for the current match" and applies it
		// immediately, requesting the commit details. Two states make a plain click unreliable:
		// the toggle persists across runs (a previous run may have left it on — then the click
		// turns it OFF), and an earlier entry may have left a Commit Details View open on the
		// match commit (then the view skips re-requesting the details). The flow closes a leaked
		// CDV first and only flips the toggle when it is off, restoring it afterwards.
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var c=document.getElementById("cdvClose");if(c!==null)c.click();return c!==null;})()' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{branch}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'eval', expr: '(function(){var b=document.getElementById("findOpenCdv");if(b.className.split(/\\s+/).indexOf("active")===-1){b.click();return "enabled";}return "already active";})()' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'eval', expr: '(function(){var b=document.getElementById("findOpenCdv");if(b.className.split(/\\s+/).indexOf("active")!==-1){b.click();return "disabled";}return "already off";})()' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		expect: { responses: ['commitDetails'] }
	},
	{
		id: 'find/type-query',
		title: 'Type a find query',
		group: 'find',
		mutable: false,
		// The widget matches on a keyup-driven 200 ms debounce, so the query is typed through an
		// eval (a plain `set` dispatches input/change, which the widget does not listen to).
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{branch}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'expectText', selector: '#findPosition', contains: ' of ' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},

	/* ---------- Keyboard shortcuts ---------- */
	{
		id: 'keyboard/key-find',
		title: 'Ctrl+F (open find)',
		group: 'keyboard',
		mutable: false,
		// Default keybinding: keyboardShortcut.find = 'f'.
		ui: [
			{ op: 'key', key: 'f', ctrlOrCmd: true },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'keyboard/key-refresh',
		title: 'Ctrl+R (refresh)',
		group: 'keyboard',
		mutable: false,
		// Default keybinding: keyboardShortcut.refresh = 'r'; the handler refreshes hard with
		// config changes, i.e. loadRepoInfo followed by loadCommits.
		ui: [{ op: 'key', key: 'r', ctrlOrCmd: true }],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'keyboard/key-scroll-to-head',
		title: 'Ctrl+H (scroll to HEAD)',
		group: 'keyboard',
		mutable: false,
		// Default keybinding: keyboardShortcut.scrollToHead = 'h'; pure scroll.
		ui: [{ op: 'key', key: 'h', ctrlOrCmd: true }],
		noHostTraffic: true,
		expect: { responses: [] }
	},

	/* ---------- Reflog widget ---------- */
	{
		id: 'reflog/checkout',
		title: 'Checkout…',
		group: 'reflog',
		mutable: true,
		// Row 1 (not the newest entry). `commit` approximates the reflog entry's hash in request
		// mode. The confirmation dialog's "always accept" checkbox stays unchecked. The row menu
		// opens on click (see reflogRowMenuStep), not on contextmenu. No verify: whether row 1
		// moves HEAD depends on what the earlier entries of the same pass did, so a headIsNot
		// check is order-sensitive — the checkoutCommit response is the assertion.
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '.reflogRow' },
			reflogRowMenuStep('.reflogRow[data-index="1"]', 'Checkout…'),
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'checkoutCommit', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['checkoutCommit'] }
	},
	{
		id: 'reflog/copy-hash',
		title: 'Copy Commit Hash to Clipboard',
		group: 'reflog',
		mutable: false,
		// The row menu opens on click (see reflogRowMenuStep), not on contextmenu.
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '.reflogRow' },
			reflogRowMenuStep('.reflogRow', 'Copy Commit Hash to Clipboard'),
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'copyToClipboard', type: 'Commit Hash', data: '{{commit}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		// NOTE: no UI path. #reflogLoadMoreBtn only renders when the reflog exceeds the
		// 200-entry first page (web/reflogView.ts), and the seeded fixture's HEAD reflog has
		// ~130 entries — so the button can never appear on this fixture. The request path below
		// still exercises the host side.
		id: 'reflog/load-more',
		title: 'Load More Entries',
		group: 'reflog',
		mutable: false,
		request: [{ command: 'reflog', repo: '{{repo}}', ref: 'HEAD', limit: 400 }],
		expect: { responses: ['reflog'] }
	},
	{
		id: 'reflog/open',
		title: 'View Reflog',
		group: 'reflog',
		mutable: false,
		// The tool button closes the settings widget and opens the Reflog widget, which loads
		// the HEAD reflog. The defensive close keeps the flow deterministic when a previous run
		// left the widget open (show() early-returns on an open widget, sending no request).
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '#reflogWidget.active' },
			{ op: 'waitFor', selector: '.reflogRow' },
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'reflog', repo: '{{repo}}', ref: 'HEAD', limit: 200 }],
		expect: { responses: ['reflog'] }
	},
	{
		id: 'reflog/reset',
		title: 'Reset current branch to here…',
		group: 'reflog',
		mutable: true,
		// Row 1 so the reset actually moves the branch. The mode selector is a CustomSelect left
		// at its default (Mixed — no data-loss warning). `commit` approximates the entry's hash.
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '.reflogRow' },
			reflogRowMenuStep('.reflogRow[data-index="1"]', 'Reset current branch to here…'),
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'resetToCommit', repo: '{{repo}}', commit: '{{commit}}', resetMode: 'mixed' }],
		expect: { responses: ['resetToCommit'] }
	},

	/* ---------- Worktree widget ---------- */
	{
		id: 'worktree/add',
		title: 'Add Worktree',
		group: 'worktree',
		mutable: true,
		// The dialog asks for a path, a start-point branch (CustomSelect left at its default —
		// the checked-out branch) and a new branch name; the new branch avoids the "already
		// checked out" collision. The list reload the host triggers after the add is unawaited.
		// The Add click is an eval because the widget content re-renders (list reload) between a
		// waitFor and a plain click, detaching the button in between.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openWorktreeDialog' },
			{ op: 'waitFor', selector: '#worktreeWidget.active' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var b=document.getElementById("worktreeAddBtn");if(b!==null){b.click();return resolve("clicked");}if(++n>50)return reject(new Error("worktreeAddBtn never appeared"));setTimeout(t,100);};t();});})()'
			},
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'set', selector: '#dialogInput0', value: '../ggs-auto-worktree', event: 'input' },
			{ op: 'set', selector: '#dialogInput2', value: 'automation-worktree-branch', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#worktreeClose' },
			{ op: 'waitForGone', selector: '#worktreeWidget.active' }
		],
		request: [{ command: 'worktreeAdd', repo: '{{repo}}', path: '../ggs-auto-worktree', branch: '{{branchHead}}', newBranch: 'automation-worktree-branch' }],
		expect: { responses: ['worktreeAdd'] }
	},
	{
		id: 'worktree/prune',
		title: 'Prune Worktrees',
		group: 'worktree',
		mutable: true,
		// A plain confirmation; the list reload the host triggers afterwards is unawaited. The
		// Prune click is an eval because the widget content re-renders (list reload) between a
		// waitFor and a plain click, detaching the button in between.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openWorktreeDialog' },
			{ op: 'waitFor', selector: '#worktreeWidget.active' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var b=document.getElementById("worktreePruneBtn");if(b!==null){b.click();return resolve("clicked");}if(++n>50)return reject(new Error("worktreePruneBtn never appeared"));setTimeout(t,100);};t();});})()'
			},
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#worktreeClose' },
			{ op: 'waitForGone', selector: '#worktreeWidget.active' }
		],
		request: [{ command: 'worktreePrune', repo: '{{repo}}' }],
		expect: { responses: ['worktreePrune'] }
	},
	{
		id: 'worktree/remove',
		title: 'Remove Worktree',
		group: 'worktree',
		mutable: true,
		// Requires a removable (non-main) worktree — run after worktree/add. The force checkbox
		// keeps its default (off). The request path removes the path worktree/add creates. The
		// Remove click is an eval because the widget content re-renders (list reload) between a
		// waitFor and a plain click, detaching the button in between.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openWorktreeDialog' },
			{ op: 'waitFor', selector: '#worktreeWidget.active' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var b=document.querySelector("#worktreeWidget .worktreeRemoveBtn");if(b!==null){b.click();return resolve("clicked");}if(++n>50)return reject(new Error("worktreeRemoveBtn never appeared"));setTimeout(t,100);};t();});})()'
			},
			{ op: 'waitFor', selector: '.dialog' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#worktreeClose' },
			{ op: 'waitForGone', selector: '#worktreeWidget.active' }
		],
		request: [{ command: 'worktreeRemove', repo: '{{repo}}', path: '../ggs-auto-worktree', force: false }],
		expect: { responses: ['worktreeRemove'] }
	},

	/* ---------- Statistics widget ---------- */
	{
		id: 'statistics/close',
		title: 'Close Statistics',
		group: 'statistics',
		mutable: false,
		// The view is read-only and has no refresh control — opening it is
		// control-bar/statistics, so only the close interaction lives here.
		ui: [
			{ op: 'click', selector: '#statisticsBtn' },
			{ op: 'waitFor', selector: '#statisticsWidget.active' },
			{ op: 'click', selector: '#statisticsClose' },
			{ op: 'waitForGone', selector: '#statisticsWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},

	/* ---------- Host-only requests ---------- */
	{
		id: 'host/copy-to-clipboard',
		title: 'Copy Commit Hash to Clipboard',
		group: 'host',
		mutable: false,
		request: [{ command: 'copyToClipboard', type: 'Commit Hash', data: '{{commit}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'host/open-extension-settings',
		title: 'Open Extension Settings',
		group: 'host',
		mutable: false,
		request: [{ command: 'openExtensionSettings' }],
		expect: { responses: ['openExtensionSettings'] }
	},
	{
		id: 'host/open-file',
		title: 'Open File',
		group: 'host',
		mutable: false,
		// The fixture's tracked files all live under src/module-NNN/; the host resolves the file
		// against the working tree first, so the path only needs to exist on disk.
		request: [{ command: 'openFile', repo: '{{repo}}', hash: '{{commit}}', filePath: 'src/module-000/file-00.ts' }],
		expect: { responses: ['openFile'] }
	},
	{
		id: 'host/open-log-file',
		title: 'Open Log File',
		group: 'host',
		mutable: false,
		// The Settings Widget's "Open Log File" tool. Session logging is disabled on the fixture,
		// so the host answers with an error dialog that the flow dismisses (a leaked modal would
		// swallow the keyboard shortcuts of the later runs).
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openLogFile' },
			{ op: 'waitFor', selector: '.dialog' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'openLogFile' }],
		expect: { responses: ['openLogFile'] }
	},
	{
		id: 'host/open-terminal',
		title: 'Open a Terminal for this Repository',
		group: 'host',
		mutable: false,
		// `name` is display-only; the live view passes the repository's display name.
		request: [{ command: 'openTerminal', repo: '{{repo}}', name: '{{repo}}' }],
		expect: { responses: ['openTerminal'] }
	},
	{
		id: 'host/view-scm',
		title: 'Open Source Control View',
		group: 'host',
		mutable: false,
		request: [{ command: 'viewScm' }],
		expect: { responses: ['viewScm'] }
	}
];

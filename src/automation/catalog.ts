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

/**
 * How a run is driven. `ui` clicks the real controls through the in-page shim; `request` injects
 * the equivalent request(s) into the extension host; `command` executes the VS Code command a
 * contributed menu item runs (package.json `contributes.menus`), with the argument shape that
 * menu passes.
 */
export type AutomationMode = 'ui' | 'request' | 'command';

/** One step of a UI-mode run, executed sequentially by the in-page shim (resources/automation/shim.js). */
export type UiStep =
	| { readonly op: 'click' | 'dblclick'; readonly selector: string }
	| { readonly op: 'contextmenu'; readonly selector: string; readonly item: string | readonly string[] } // right-click the element, then click the menu item whose visible text matches exactly (several texts => any of them, one per interface language)
	| { readonly op: 'key'; readonly key: string; readonly ctrlOrCmd?: boolean; readonly shift?: boolean } // keydown on the document (what the view's keybinding observer listens to)
	| { readonly op: 'waitFor' | 'waitForGone'; readonly selector: string; readonly timeoutMs?: number }
	| { readonly op: 'skipIfAbsent'; readonly selector: string; readonly timeoutMs?: number } // wait for the element; when it never appears the whole action is SKIPPED (the repository/view does not offer this control) instead of failed
	| { readonly op: 'set'; readonly selector: string; readonly value: string; readonly event: 'change' | 'input' }
	| { readonly op: 'expectText'; readonly selector: string; readonly contains: string | readonly string[] }
	| { readonly op: 'eval'; readonly expr: string } // a JS expression evaluated in the page (gg.eval / debugging); result must be JSON-cloneable
	/* Assertion steps (verification only — they never touch the page state). Sizes come from
	   getBoundingClientRect (CSS pixels, invariant under editor zoom) with generous tolerances:
	   the stylesheet's canonical value sits mid-range, so a small style tweak shifts a bound
	   instead of flaking the suite, while a broken layout (collapsed, zero-sized, exploded)
	   still falls far outside. */
	| { readonly op: 'expectSize'; readonly selector: string; readonly minW?: number; readonly maxW?: number; readonly minH?: number; readonly maxH?: number } // the element's rendered box: width/height must lie within [minW, maxW] inclusive (a bound left out is not checked); fails with the measured box
	| { readonly op: 'expectCount'; readonly selector: string; readonly min?: number; readonly max?: number } // how many elements the selector matches (defaults: min 1, no max)
	| { readonly op: 'expectChecked'; readonly selector: string; readonly checked: boolean }; // a checkbox's checked state — the rendered effect of a toggle step

/**
 * The argument one menu contribution passes to its command when its item is clicked — the shapes
 * `getUrisFromCommandArg` / `getRepoFromCommandArg` accept (src/commands.ts), so a command-mode
 * run exercises exactly the path the editor's menu takes:
 *   - `uri` — a bare `file` URI of the context file (or the repository root, `of: 'repo'`): what
 *     the Explorer, Editor and Editor Tab context menus pass;
 *   - `rootUri` — `{ rootUri }` of the context repository: what the Source Control view's title
 *     and Pull/Push menus pass;
 *   - `resourceStates` — `[{ resourceUri }]`: what the Source Control resource context menu
 *     passes;
 *   - `diffUri` — a git-graph-rs diff-document URI of the context commit/file: what the diff
 *     editor title's Open File button passes.
 */
export type CommandArgSpec =
	| { readonly kind: 'uri'; readonly of: 'file' | 'repo' }
	| { readonly kind: 'rootUri' }
	| { readonly kind: 'resourceStates' }
	| { readonly kind: 'diffUri' };

/** One VS Code command execution (command mode): what clicking a contributed menu item runs. */
export interface CommandStep {
	readonly command: string;
	readonly arg?: CommandArgSpec;
}

/** A catalog entry: one user-facing control. */
export interface AutomationAction {
	/** Dotted id: `<group>/<name>`, e.g. `control-bar/refresh`, `menu-commit/checkout`. */
	readonly id: string;
	/** Human-readable control label (the button tooltip or menu item title). */
	readonly title: string;
	/** Grouping for suite selection, e.g. `control-bar`, `row`, `menu-commit`, `menu-branch`, `cdv`, `settings`, `find`, `reflog`, `worktree`, `statistics`, `host`, `menu-vscode` (the extension's contributed VS Code menus). */
	readonly group: string;
	/** TRUE => the action mutates the repository (belongs to the `write` suite; the driver re-creates the fixture clone around it). */
	readonly mutable: boolean;
	/** Environment the action needs; the server skips the action when unavailable (`remote` => a configured remote; `stash` => at least one stash; `tag`/`annotatedTag` => tags in the loaded graph; `file` => a commit with (non-binary) file changes; `binaryFile`/`imageFile` => a commit that only changes a binary/image file (the fixture's dedicated `assets/` commits); `anotherBranch` => at least two branches; `anotherRepo` => at least two known repositories). */
	readonly requires?: readonly ('remote' | 'stash' | 'tag' | 'annotatedTag' | 'file' | 'binaryFile' | 'imageFile' | 'anotherBranch' | 'anotherRepo')[];
	/**
	 * TRUE => confirming the action opens the editor's NATIVE save dialog (utils.archive's
	 * showSaveDialog). A modal an automated run can neither drive nor dismiss — in the real
	 * editor it stalls the whole suite until someone clicks it away — so the suite runner
	 * reports the action as SKIPPED in every mode instead of running it.
	 */
	readonly nativeSaveDialog?: boolean;
	/**
	 * TRUE declares the action awaits no host response (a pure view-state change, or traffic the
	 * host answers silently such as `setRepoState` / `openCompareTab`). Such actions MUST declare
	 * `expect: { responses: [] }` — the run is complete once the page steps finish (or, in request
	 * mode, once the requests are injected).
	 */
	readonly noHostTraffic?: boolean;
	readonly ui?: readonly UiStep[];
	/** The VS Code command a contributed menu item runs (command mode), with the argument shape that menu passes. */
	readonly vscodeCommand?: CommandStep;
	/**
	 * Page steps run AFTER the command completed (command mode only): verification barriers and
	 * state restoration (e.g. clearing the file filter a `filterByFile` command set).
	 */
	readonly uiAfter?: readonly UiStep[];
	/** TRUE (command mode only) => the run asserts at least one new editor tab appeared while the command ran. */
	readonly expectTabs?: boolean;
	/**
	 * Substrings (command mode only) that must appear in the native notifications the command
	 * raises, as captured by the dialog auto-answer. A command whose whole observable outcome is a
	 * notification (e.g. a designed Gerrit refusal) is otherwise unverifiable — `expect: { responses: [] }`
	 * alone would pass even if the command silently did nothing. Each substring must occur in at
	 * least one captured message; use fragments that hold in every interface language (e.g.
	 * "Change-Id", "commit-msg"), since the captured text is the localized message.
	 */
	readonly expectNotifications?: readonly string[];
	/**
	 * TRUE (command mode only) => the command must raise at least one native notification
	 * (information / warning / error) while it runs. For commands whose whole observable outcome
	 * IS a notification whose text is fully localized (no language-invariant fragment exists to
	 * pin with expectNotifications) — presence is still a stronger check than nothing.
	 */
	readonly expectAnyNotification?: boolean;
	/**
	 * TRUE (command mode only) => the command must raise a native MODAL that the auto-answer
	 * answers (a confirmation the command cannot proceed without) — verifying the command really
	 * reached its confirmation point.
	 */
	readonly expectModal?: boolean;
	/** RequestMessage template(s) for request mode, in send order. */
	readonly request?: readonly Record<string, unknown>[];
	/** Responses (by `command`) that must arrive from the extension host while the action runs. */
	readonly expect: { readonly responses: readonly string[] };
	/**
	 * Expected responses whose ERROR payload the run accepts (by `command`). The host answers a
	 * failed operation with the same response command and the git error in its `error`/`errors`
	 * field — the run fails on any other error-bearing expected response, so an action whose
	 * designed outcome on the fixture IS the refusal (pulling a local-only branch from a remote
	 * without it, pushing a tag the remote already has, ...) lists that command here, with the
	 * reason documented on the entry. Anything NOT listed failing means the action did not
	 * achieve what its title says.
	 */
	readonly allowErrorOn?: readonly string[];
	/**
	 * Optional post-run repository state check, evaluated by the server against live repository
	 * state. `placeholder` is a single `{{name}}` context reference OR a plain literal (the
	 * exact branch/tag/remote name a write action of this catalog creates — literals keep the
	 * check independent of repository data).
	 */
	readonly verify?: {
		readonly kind: 'headIs' | 'headIsNot' | 'headSubjectStartsWith' | 'branchAbsent' | 'branchPresent' | 'tagAbsent' | 'tagPresent' | 'remoteAbsent' | 'remotePresent';
		readonly placeholder: string;
	};
}

const PLACEHOLDER_REGEXP = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

/**
 * The skip reason every layer reports for {@link AutomationAction.nativeSaveDialog} actions: the
 * modal they open (utils.archive's showSaveDialog) cannot be driven or dismissed by a run, so no
 * layer may ever execute them — the suite runner filters them before dispatching, and the engine
 * refuses them again as the backstop for a direct run() caller.
 */
export const NATIVE_SAVE_DIALOG_SKIP_REASON = 'opens the editor\'s native save dialog — not run by the automation suite';

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
	const uiOps = new Set(['click', 'dblclick', 'contextmenu', 'key', 'waitFor', 'waitForGone', 'skipIfAbsent', 'set', 'expectText', 'eval', 'expectSize', 'expectCount', 'expectChecked']);
	const validateSteps = (where: string, steps: readonly UiStep[]) => {
		for (const [i, step] of steps.entries()) {
			if (!uiOps.has(step.op)) problems.push(where + ': unknown ui op "' + step.op + '" (step ' + i + ')');
			if ('selector' in step && typeof step.selector === 'string' && step.selector.trim() === '') {
				problems.push(where + ': empty selector (step ' + i + ')');
			}
			if (step.op === 'contextmenu') {
				const items = Array.isArray(step.item) ? step.item : [step.item];
				if (items.some((text) => text.trim() === '')) problems.push(where + ': empty menu item (step ' + i + ')');
			}
			if (step.op === 'eval' && step.expr.trim() === '') problems.push(where + ': empty eval expression (step ' + i + ')');
			if (step.op === 'expectSize') {
				const { minW, maxW, minH, maxH } = step;
				if (minW !== undefined && maxW !== undefined && minW > maxW) problems.push(where + ': expectSize has minW > maxW (step ' + i + ')');
				if (minH !== undefined && maxH !== undefined && minH > maxH) problems.push(where + ': expectSize has minH > maxH (step ' + i + ')');
			}
			if (step.op === 'expectCount') {
				const { min, max } = step;
				if (min !== undefined && max !== undefined && min > max) problems.push(where + ': expectCount has min > max (step ' + i + ')');
			}
		}
	};
	for (const action of catalog) {
		const where = 'action "' + action.id + '"';
		if (ids.has(action.id)) problems.push(where + ': duplicate id');
		ids.add(action.id);
		if (action.title.trim() === '') problems.push(where + ': empty title');
		if (action.group.trim() === '') problems.push(where + ': empty group');
		if (!action.ui && !action.request && !action.vscodeCommand) problems.push(where + ': declares neither ui, request nor vscodeCommand path');
		if (action.ui) validateSteps(where, action.ui);
		if (action.uiAfter !== undefined) {
			if (action.vscodeCommand === undefined) problems.push(where + ': uiAfter steps are only meaningful for vscodeCommand actions');
			else validateSteps(where, action.uiAfter);
		}
		if (action.vscodeCommand !== undefined) {
			if (action.vscodeCommand.command.trim() === '') problems.push(where + ': empty vscode command');
			if (action.ui !== undefined) problems.push(where + ': declares both ui and vscodeCommand paths');
			if (action.request !== undefined) problems.push(where + ': declares both request and vscodeCommand paths');
		}
		if (action.expectTabs === true && action.vscodeCommand === undefined) problems.push(where + ': expectTabs is only meaningful for vscodeCommand actions');
		if (action.expectNotifications !== undefined) {
			if (action.vscodeCommand === undefined) problems.push(where + ': expectNotifications is only meaningful for vscodeCommand actions');
			else if (action.expectNotifications.length === 0) problems.push(where + ': expectNotifications must name at least one substring');
			else for (const needle of action.expectNotifications) {
				if (typeof needle !== 'string' || needle.trim() === '') problems.push(where + ': expectNotifications entries must be non-empty strings');
			}
		}
		if (action.expectAnyNotification === true && action.vscodeCommand === undefined) problems.push(where + ': expectAnyNotification is only meaningful for vscodeCommand actions');
		if (action.expectModal === true && action.vscodeCommand === undefined) problems.push(where + ': expectModal is only meaningful for vscodeCommand actions');
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
		if (action.allowErrorOn !== undefined) {
			for (const command of action.allowErrorOn) {
				if (!action.expect.responses.includes(command)) {
					problems.push(where + ': allowErrorOn lists "' + command + '", which is not an expected response');
				}
			}
		}
		if (action.verify !== undefined) {
			const placeholder = action.verify.placeholder;
			// Either a single {{name}} context reference or a plain literal the action itself names.
			if (placeholder.trim() === '' || (placeholder.indexOf('{{') !== -1
				&& (placeholder.indexOf('{{') !== 0 || placeholder.indexOf('}}') !== placeholder.length - 2 || placeholder.slice(2, -2) === ''))) {
				problems.push(where + ': verify placeholder must be a single {{name}} reference or a plain literal');
			}
		}
	}
	return problems;
}

/**
 * The catalog. Entries are grouped by the surface they drive; the groups mirror the suites the
 * test driver can select. Fixture-stable facts (src/automation/fixture.ts): the remote is
 * `origin`, local branches are `main` / `local-ahead` (feature-NNN exist only as
 * origin/feature-NNN), tags are `v1.x.x` (spread over the whole history), three stashes are
 * seeded, an untracked file keeps the Uncommitted Changes row alive, (near HEAD, needing
 * at least 25 commits) a real binary file and a real decodable image are each added then modified —
 * and a tiny submodule at `sub/fixture-sub` (gitlink + `.gitmodules` on the final main commit,
 * rebuilt deterministically by every reseed) provides the second known repository the Repos
 * dropdown requires. Everything else is referenced through `{{placeholder}}` context.
 */

/**
 * Exact-text candidates across the interface languages the extension ships (web/strings.ts):
 * the shim clicks/looks for whichever the rendered UI shows, so a catalog entry matches menu
 * items, dropdown options and labels under both the English and the zh-CN interface.
 */
const bi = (en: string, zh: string): readonly string[] => [en, zh];

/** The Branches Dropdown's "Show All" option in both shipped interface languages. */
const SHOW_ALL_TEXTS: readonly string[] = bi('Show All', '显示全部');

/**
 * A UI step that resolves once the Repository Dropdown's displayed value equals the page-global
 * `window[name]` (a value an earlier eval stored): the value element is re-rendered by the view
 * when the switch's reload lands, so this is the barrier that tells a real repository switch
 * from the previous repository's still-rendered table.
 */
const dropdownValueIs = (name: string): UiStep => ({
	op: 'eval',
	expr: '(function(){var want=window[' + JSON.stringify(name) + '];return new Promise(function(resolve,reject){var n=0;var t=function(){var v=document.querySelector("#repoDropdown .dropdownCurrentValue");if(v!==null&&v.textContent.trim()===want)return resolve(want);if(++n>100)return reject(new Error("repository dropdown never switched to "+want));setTimeout(t,100);};t();});})()'
});

/** The pinned-controls chip of `branch` (a `{{…}}` placeholder): rendered above the windowed commit table, so it exists at any scroll depth. */
const pinnedChipSelector = (branch: string): string => '.pinnedChip[data-type="branch"][data-value="' + branch + '"]';

/**
 * A UI step that snapshots whether the `{{branch}}` pinned-controls chip exists (the branch's
 * current pin state) into `window.__ggPinWasPinned` — pin state is repository data a catalog
 * entry cannot know, and the barriers below must observe the pin/unpin round-trip from whatever
 * state the run starts in.
 */
const PIN_SNAPSHOT_STEP: UiStep = {
	op: 'eval',
	expr: '(function(){window.__ggPinWasPinned=document.querySelector(' + JSON.stringify(pinnedChipSelector('{{branch}}')) + ')!==null;return window.__ggPinWasPinned;})()'
};

/**
 * A UI step that resolves once the `{{branch}}` pinned-controls chip presence has flipped from
 * (`flipped`) or returned to (`restored`) the `window.__ggPinWasPinned` snapshot captured by
 * PIN_SNAPSHOT_STEP. The chip row sits above the windowed commit table, so the barrier holds at
 * any scroll depth — a first-table-row wait never settles on a view left scrolled deep in
 * history (a real repository's branch label can sit far down the loaded page).
 */
const pinChipStateStep = (phase: 'flipped' | 'restored'): UiStep => ({
	op: 'eval',
	expr: '(function(){var sel=' + JSON.stringify(pinnedChipSelector('{{branch}}')) + ';var want=' + (phase === 'flipped' ? '!' : '') + 'window.__ggPinWasPinned;'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){var has=document.querySelector(sel)!==null;'
		+ 'if(has===want)return resolve(want?"pinned":"unpinned");'
		+ 'if(++n>200)return reject(new Error("pin state never changed"));setTimeout(t,25);};t();});})()'
});

/** The in-page eval that selects exactly `branch` (and nothing else) in the Branches Dropdown. */
const filterBranchDropdownExpr = (branch: string): string =>
	'(function(){var opts=function(){return Array.from(document.querySelectorAll("#branchDropdown .dropdownOption"));};' +
	'var sel=function(o){return o.className.split(/\\s+/).indexOf("selected")!==-1;};' +
	'var name=function(o){return o.textContent.trim();};' +
	'var showAllTexts=' + JSON.stringify(SHOW_ALL_TEXTS) + ';' +
	'var isShowAll=function(o){return showAllTexts.indexOf(name(o))!==-1;};' +
	'var find=function(){return opts().find(function(o){return name(o)===' + JSON.stringify(branch) + ';});};' +
	// Defensive reset: whatever a previous entry left selected, start the filter from "Show All"
	// so the target option is visible and the end state is independent of the incoming state.
	'var showAll=opts().find(function(o){return isShowAll(o);});if(showAll!==undefined&&!sel(showAll))showAll.click();' +
	'var target=find();if(target===undefined)throw new Error(' + JSON.stringify(branch) + '+" option missing");' +
	'if(!sel(target))target.click();' +
	'for(var again=true;again;){again=false;var other=opts().find(function(o){var n=name(o);return n!==' + JSON.stringify(branch) + '&&!isShowAll(o)&&sel(o);});if(other!==undefined){other.click();again=true;}}' +
	'if(!sel(find()))find().click();' +
	'return "filtered";})()';

/**
 * UI steps that filter the Branches Dropdown to exactly `branch` (a `{{…}}` placeholder —
 * the remote branch is repository data). The remote branch label only renders when its tip is
 * in the loaded graph; on repositories whose remote tips sit deep in history (the fixture's
 * origin/feature-NNN among them), the dropdown filter (which a user would use to find such a
 * branch) is what brings the tip into view. Re-render-safe: the options are re-queried after
 * every click, since each selection re-renders the list.
 */
const remoteBranchFilterSteps = (branch: string): readonly UiStep[] => [
	{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
	{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
	{ op: 'eval', expr: filterBranchDropdownExpr(branch) },
	{ op: 'key', key: 'Escape' },
	{ op: 'waitFor', selector: 'span.gitRef.remote[data-name="' + branch + '"]' }
];

/** UI steps that filter the Branches Dropdown to the context remote branch ({{remote}}/{{remoteBranch}}). */
const REMOTE_BRANCH_FILTER_STEPS: readonly UiStep[] = remoteBranchFilterSteps('{{remote}}/{{remoteBranch}}');

/** UI steps that reset the Branches Dropdown to "Show All" and wait for the reload to render. */
const SHOW_ALL_RESTORE_STEPS: readonly UiStep[] = [
	{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
	{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
	{ op: 'eval', expr: '(function(){var w=' + JSON.stringify(SHOW_ALL_TEXTS) + ';var o=[...document.querySelectorAll("#branchDropdown .dropdownOption")].find(function(o){return w.indexOf(o.textContent.trim())!==-1;});if(o===undefined)throw new Error("Show All option missing");o.click();return "clicked";})()' },
	{ op: 'key', key: 'Escape' },
	{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the restore reload has rendered
];

/**
 * A UI step that scrolls the commit table down until the row carrying `selector` renders
 * (windowed rendering keeps only the viewport rows in the DOM), then resolves. Starts from the
 * top — a preceding checkout or reveal may have scrolled the view deep — and scales its stride
 * to the table's full scroll height, so any depth within the loaded page is covered in the same
 * bounded number of attempts; gives up after ~50 attempts.
 */
const scrollUntilVisibleStep = (selector: string): UiStep => ({
	op: 'eval',
	expr: '(function(){return new Promise(function(resolve,reject){var v=document.getElementById("view");v.scrollTop=0;v.dispatchEvent(new Event("scroll"));var attempt=0;var step=function(){if(document.querySelector(' + JSON.stringify(selector) + '))return resolve("found");var max=v.scrollHeight-v.clientHeight;var stride=Math.max(20*24,Math.ceil(max/40));if(attempt++>50)return reject(new Error("row never rendered: ' + selector.replace(/"/g, '') + '"));if(max>0){v.scrollTop=Math.min(max,stride*attempt);v.dispatchEvent(new Event("scroll"));}setTimeout(step,120);};setTimeout(step,150);});})()'
});

/**
 * A UI step that opens a Reflog row's action menu (the rows open their menu on CLICK, not
 * contextmenu — web/reflogView.ts) and clicks the item titled `item`. The click is dispatched
 * non-bubbling: the ContextMenu singleton closes itself on any document-level click, which would
 * otherwise remove the menu opened by this very event.
 */
const reflogRowMenuStep = (rowSelector: string, item: string | readonly string[]): UiStep => ({
	op: 'eval',
	expr: '(function(){var row=document.querySelector(' + JSON.stringify(rowSelector) + ');if(row===null)throw new Error("reflog row not found: ' + rowSelector.replace(/"/g, '') + '");' +
		'row.dispatchEvent(new MouseEvent("click",{bubbles:false,cancelable:true}));' +
		'var wanted=' + JSON.stringify(Array.isArray(item) ? item : [item]) + ';' +
		'var items=document.querySelectorAll("ul.contextMenu li.contextMenuItem");' +
		'for(var i=0;i<items.length;i++){if(wanted.indexOf(items[i].textContent.trim())!==-1){items[i].click();return "clicked";}}' +
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

/**
 * A UI step that restores a Settings-widget load-option checkbox the preceding step toggled off.
 * It polls for the checkbox (the toggle's reload may be re-rendering the widget), clicks it only
 * while it is unchecked — going through the same save-and-reload pipeline as the tested
 * direction — and then closes the widget. Without the restore the per-repo override stays OFF in
 * the workspace state and silently outlives the run: the NEXT run's engine probes still resolve
 * the tag/stash placeholders (queryCommits forces the options on) while the rendered page omits
 * them, and every tag-row action fails "row never rendered" on a name the probe picked.
 */
const restoreSettingsCheckboxStep = (id: string): UiStep => ({
	op: 'eval',
	expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var c=document.getElementById(' + JSON.stringify(id) + ');if(c!==null){var flipped=false;if(!c.checked){c.click();flipped=true;}var cb=document.getElementById("settingsClose");if(cb!==null)cb.click();return resolve(flipped?"restored":"already on");}if(++n>100)return reject(new Error("the settings checkbox never appeared: ' + id + '"));setTimeout(t,100);};t();});})()'
});

/**
 * Assertions every dialog-opening flow makes once its modal is up: exactly ONE dialog is visible,
 * it renders a sane box (CSS px; skipped where no layout engine exists, e.g. the jsdom harness),
 * and it offers a labelled action. Either button counts: form dialogs label their primary, while
 * the action-running overlay offers only its secondary "Dismiss" — a dialog with NO labelled
 * action is a broken render. Entries that know their action label additionally assert its exact
 * text (both interface languages) right after these.
 */
const DIALOG_ASSERT_STEPS: readonly UiStep[] = [
	{ op: 'expectCount', selector: '.dialog', min: 1, max: 1 },
	{ op: 'expectSize', selector: '.dialog', minW: 200, maxW: 1400, minH: 50, maxH: 1000 },
	{ op: 'eval', expr: '(function(){var a=document.getElementById("dialogAction");var s=document.getElementById("dialogSecondaryAction");var t=(a===null?"":a.textContent.trim())+"|"+(s===null?"":s.textContent.trim());if(t==="|")throw new Error("the dialog offers no labelled action");return t;})()' }
];

/**
 * UI steps that clear the file path filter a `git-graph-rs.filterByFile` command set: the Filter
 * dialog's secondary action reloads the unfiltered graph. Without this every later entry would
 * run against a graph filtered to a single file (no branch labels, tags or stashes render), so
 * every filterByFile command entry runs these steps after its expected response arrived.
 */
const CLEAR_FILTER_STEPS: readonly UiStep[] = [
	{ op: 'click', selector: '#filterBtn' },
	{ op: 'waitFor', selector: '.dialog' },
	...DIALOG_ASSERT_STEPS,
	{ op: 'click', selector: '#dialogSecondaryAction' },
	{ op: 'waitForGone', selector: '.dialog' },
	{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the unfiltered reload has rendered
	// ...and the unfiltered graph really is back: the rendered window holds several rows again
	// (the filtered graph was one file's history, but "some rows" is what holds on every repo).
	{ op: 'expectCount', selector: 'tr.commit', min: 2 }
];

/**
 * The size every control-bar hit target must render at (main.css draws 24x24 buttons with 16-20px
 * icons; the bounds tolerate a redesign step, not a collapsed or exploded control).
 */
const controlSizeStep = (selector: string): UiStep => ({ op: 'expectSize', selector, minW: 14, maxW: 72, minH: 14, maxH: 44 });

/**
 * Row-level assertions for the {{commit}} target, run once its row is rendered (windowed rendering
 * keeps only viewport rows in the DOM, so the scroll steps come first): the row's height matches
 * the stylesheet's row height (24px line-height, tolerant), and the description cell shows the
 * commit's OWN subject — the view's text held against the repository's data, not just any text.
 */
const ROW_ASSERT_STEPS: readonly UiStep[] = [
	{ op: 'expectSize', selector: 'tr.commit[data-hash="{{commit}}"]', minH: 16, maxH: 44 },
	{ op: 'expectText', selector: 'tr.commit[data-hash="{{commit}}"] .description span.text', contains: '{{commitSubject}}' }
];

export const CATALOG: readonly AutomationAction[] = [
	/* ---------- Control bar ---------- */
	{
		id: 'control-bar/author-dropdown',
		title: 'Authors Dropdown',
		group: 'control-bar',
		mutable: false,
		// The dropdown lists the authors recorded in the repository config — repository data a
		// catalog entry cannot know, so the flow is generic: it captures the current selection,
		// picks any OTHER option (the selection change reloads the commits; the dropdown's change
		// callback skips the repo-info request, so no loadRepoInfo is expected) and restores the
		// captured selection afterwards, leaving later runs the initial state.
		ui: [
			controlSizeStep('#authorDropdown .dropdownCurrentValue'),
			{ op: 'click', selector: '#authorDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#authorDropdown .dropdownOption' },
			{
				op: 'eval',
				expr: '(function(){var opts=[...document.querySelectorAll("#authorDropdown .dropdownOption")];' +
					'var cur=document.querySelector("#authorDropdown .dropdownCurrentValue").textContent.trim();' +
					'var target=opts.find(function(o){return o.textContent.trim()!==cur;});' +
					'if(target===undefined)throw new Error("no author option other than the current selection ("+cur+")");' +
					'window.__ggAuthorRestore=cur;window.__ggAuthorSwitched=target.textContent.trim();target.click();return target.textContent.trim();})()'
			},
			{ op: 'key', key: 'Escape' }, // the multi-select dropdown stays open after a selection
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the filtered reload has rendered
			// the reload carried the selection: the dropdown's own value shows the author picked
			{
				op: 'eval',
				expr: '(function(){var v=document.querySelector("#authorDropdown .dropdownCurrentValue");var want=window.__ggAuthorSwitched;if(v===null||v.textContent.trim()!==want)throw new Error("authors dropdown shows \'" +(v===null?"(missing)":v.textContent.trim())+"\' after selecting "+want);return want;})()'
			},
			{ op: 'click', selector: '#authorDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#authorDropdown .dropdownOption' },
			{
				op: 'eval',
				expr: '(function(){var want=window.__ggAuthorRestore;var target=[...document.querySelectorAll("#authorDropdown .dropdownOption")].find(function(o){return o.textContent.trim()===want;});' +
					'if(target===undefined)throw new Error("restore option missing: "+want);target.click();return want;})()'
			},
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
		// The dropdown is reset to "Show All" afterwards: leaving the graph filtered to a single
		// branch would strand every later entry's targets (rows, ref labels) outside the filtered
		// graph — the branch tip may be old history.
		ui: [
			controlSizeStep('#branchDropdown .dropdownCurrentValue'),
			{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
			{ op: 'eval', expr: '[...document.querySelectorAll("#branchDropdown .dropdownOption")].find((o) => o.textContent.trim() === \'{{branch}}\').click()' },
			{ op: 'key', key: 'Escape' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the filtered reload has rendered
			// the graph is really filtered to the branch: the dropdown's value names it
			{ op: 'expectText', selector: '#branchDropdown .dropdownCurrentValue', contains: '{{branch}}' },
			...SHOW_ALL_RESTORE_STEPS
		],
		// No request path: the reload derives from view state (currentBranches) only the live
		// view can assemble.
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'control-bar/repo-dropdown',
		title: 'Repository Dropdown',
		group: 'control-bar',
		mutable: false,
		requires: ['anotherRepo'],
		// Switching repositories loads the other repository's info and commits (the dropdown's
		// change callback), then switches back to the original — the repository names are
		// repository data the catalog cannot know, so the flow is generic: it captures the
		// current selection, picks any OTHER option and restores the captured one afterwards.
		// The barriers poll the dropdown's own value: the table's row 0 still shows the previous
		// repository until its reload lands, so it cannot signal the switch. No request path:
		// the reload derives from view state only the live view can assemble.
		ui: [
			controlSizeStep('#repoDropdown .dropdownCurrentValue'),
			{ op: 'click', selector: '#repoDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#repoDropdown .dropdownOption' },
			{
				op: 'eval',
				expr: '(function(){var cur=document.querySelector("#repoDropdown .dropdownCurrentValue").textContent.trim();' +
					'var target=[...document.querySelectorAll("#repoDropdown .dropdownOption")].find(function(o){return o.textContent.trim()!==cur;});' +
					'if(target===undefined)throw new Error("no repository other than the current selection ("+cur+")");' +
					'window.__ggRepoRestore=cur;window.__ggRepoSwitched=target.textContent.trim();target.click();return window.__ggRepoSwitched;})()'
			},
			dropdownValueIs('__ggRepoSwitched'),
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the other repository has rendered
			{ op: 'click', selector: '#repoDropdown .dropdownCurrentValue' },
			{ op: 'waitFor', selector: '#repoDropdown .dropdownOption' },
			{
				op: 'eval',
				expr: '(function(){var want=window.__ggRepoRestore;var target=[...document.querySelectorAll("#repoDropdown .dropdownOption")].find(function(o){return o.textContent.trim()===want;});' +
					'if(target===undefined)throw new Error("restore option missing: "+want);target.click();return want;})()'
			},
			dropdownValueIs('__ggRepoRestore'),
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the original repository has rendered
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'control-bar/current-btn',
		title: 'Scroll to the commit referenced by HEAD',
		group: 'control-bar',
		mutable: false,
		// Pure scroll — no host traffic. The effect is asserted: after the scroll the HEAD row
		// (the one carrying the commitHeadDot marker) is inside the rendered window again.
		ui: [
			controlSizeStep('#currentBtn'),
			{ op: 'click', selector: '#currentBtn' },
			{ op: 'waitFor', selector: 'tr.commit:has(.commitHeadDot)' }
		],
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
			controlSizeStep('#fetchBtn'),
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
		requires: ['file'],
		// Applying (or clearing) a path filter reloads the commits only; the context file exists
		// by construction, so the filtered result is non-empty. The flow re-opens the dialog and
		// clears the filter so later runs see the unfiltered graph.
		ui: [
			controlSizeStep('#filterBtn'),
			{ op: 'click', selector: '#filterBtn' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'set', selector: '#dialogInput0', value: '{{file}}', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{ op: 'click', selector: '#filterBtn' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogSecondaryAction' },
			{ op: 'waitForGone', selector: '.dialog' }
		],
		request: [{
			command: 'loadCommits', repo: '{{repo}}', refreshId: 0, hard: true,
			branches: null, authors: null, maxCommits: 10000, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date',
			remotes: [], hideRemotes: [], stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
			gerritStatusFilter: { new: false, merged: false, abandoned: false, wip: false }, filterPath: '{{file}}'
		}],
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'control-bar/find-open',
		title: 'Find',
		group: 'control-bar',
		mutable: false,
		ui: [
			controlSizeStep('#findBtn'),
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'expectCount', selector: '.findWidget.active', min: 1, max: 1 },
			{ op: 'expectSize', selector: '.findWidget', minW: 120, maxW: 3000, minH: 28, maxH: 48 } // findWidget.css: 34px tall
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'control-bar/load-more-commits',
		title: 'Load More Commits',
		group: 'control-bar',
		mutable: false,
		// The footer button exists only while moreCommitsAvailable: on a repository whose history
		// fits the initial page there is nothing to load, and the action skips. Clicking the
		// button pages the commit list; completion is gated by the loadCommits response.
		ui: [
			{ op: 'skipIfAbsent', selector: '#loadMoreCommitsBtn' },
			{ op: 'expectSize', selector: '#loadMoreCommitsBtn', minW: 40, maxW: 400, minH: 20, maxH: 48 },
			{ op: 'click', selector: '#loadMoreCommitsBtn' }
		],
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
		ui: [
			controlSizeStep('#refreshBtn'),
			{ op: 'click', selector: '#refreshBtn' }
		],
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
			controlSizeStep('#settingsBtn'),
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'expectCount', selector: '#settingsWidget.active', min: 1, max: 1 },
			{ op: 'expectSize', selector: '#settingsWidget', minW: 260, maxW: 1400, minH: 100, maxH: 2400 },
			// The widget's load-option checkboxes are real rendered inputs. Only existence is
			// asserted here — this entry also runs against real repositories, whose per-repo
			// preferences (a user's own, untouched by the runner) set the checked direction; the
			// write-suite toggle entries assert the direction where the canonical state is ensured.
			{ op: 'expectCount', selector: '#settingsShowTagsCheckbox', min: 1, max: 1 },
			{ op: 'expectCount', selector: '#settingsShowStashesCheckbox', min: 1, max: 1 },
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
			controlSizeStep('#showRemoteBranchesCheckbox'),
			{ op: 'click', selector: '#showRemoteBranchesCheckbox' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the OFF reload has rendered
			{ op: 'expectChecked', selector: '#showRemoteBranchesCheckbox', checked: false },
			{ op: 'click', selector: '#showRemoteBranchesCheckbox' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the ON reload has rendered
			{ op: 'expectChecked', selector: '#showRemoteBranchesCheckbox', checked: true },
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
			controlSizeStep('#statisticsBtn'),
			{ op: 'click', selector: '#statisticsBtn' },
			{ op: 'waitFor', selector: '#statisticsWidget.active' },
			{ op: 'expectCount', selector: '#statisticsWidget.active', min: 1, max: 1 },
			{ op: 'expectSize', selector: '#statisticsWidget', minW: 260, maxW: 1400, minH: 80, maxH: 2400 },
			// The widget did not just open — it holds the computed statistics (author rows, the
			// activity heatmap): content-bearing children, not an empty shell.
			{ op: 'eval', expr: '(function(){var c=document.getElementById("statisticsContent");var n=c===null?0:c.children.length;if(n===0)throw new Error("the statistics widget rendered no content");return n;})()' },
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
			controlSizeStep('#terminalBtn'),
			{ op: 'click', selector: '#terminalBtn' },
			{ op: 'waitForGone', selector: '.dialog', timeoutMs: 10000 }
		],
		// `name` is display-only; the live view passes the repository's display name.
		request: [{ command: 'openTerminal', repo: '{{repo}}', name: '{{repo}}' }],
		expect: { responses: ['openTerminal'] }
	},

	/* ---------- VS Code menu commands (package.json contributes.menus) ---------- */
	// Command mode: each entry executes the VS Code command one contributed menu item runs, with
	// the argument shape that menu passes (see CommandArgSpec). The four filterByFile surfaces
	// (Explorer / Editor / Editor Tab context menus pass a bare file URI; the Source Control
	// resource context menu passes a SourceControlResourceState) all end in the view reloading
	// the graph filtered to that file — the post steps then clear the filter again, or every
	// later entry would run against a single file's history. The mutable entries (the Source
	// Control title / Pull-Push menus) are pure editor commands answered through VS Code
	// notifications, not the view pipeline: they declare no expected response, and they run in
	// the write suite's order FIRST (this group precedes menu-commit), right after the reseed —
	// the fixture then has HEAD = main = origin/main, so gerritPushRef takes its deterministic
	// "already pushed" refusal and resetCurrentBranchToRemote finds main's upstream.
	{
		id: 'menu-vscode/filter-by-file-explorer',
		title: 'Show File History in Git Graph RS (Explorer context menu)',
		group: 'menu-vscode',
		mutable: false,
		requires: ['file'],
		vscodeCommand: { command: 'git-graph-rs.filterByFile', arg: { kind: 'uri', of: 'file' } },
		uiAfter: CLEAR_FILTER_STEPS,
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'menu-vscode/filter-by-file-editor',
		title: 'Show File History in Git Graph RS (Editor context menu)',
		group: 'menu-vscode',
		mutable: false,
		requires: ['file'],
		// Same command and argument shape as the Explorer entry — the Editor context menu passes
		// the active document's URI — kept as its own entry so every menu location maps to one.
		vscodeCommand: { command: 'git-graph-rs.filterByFile', arg: { kind: 'uri', of: 'file' } },
		uiAfter: CLEAR_FILTER_STEPS,
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'menu-vscode/filter-by-file-editor-tab',
		title: 'Show File History in Git Graph RS (Editor tab context menu)',
		group: 'menu-vscode',
		mutable: false,
		requires: ['file'],
		// The editor/title/context menu passes the tab's resource URI.
		vscodeCommand: { command: 'git-graph-rs.filterByFile', arg: { kind: 'uri', of: 'file' } },
		uiAfter: CLEAR_FILTER_STEPS,
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'menu-vscode/filter-by-file-scm',
		title: 'Show File History in Git Graph RS (Source Control resource context menu)',
		group: 'menu-vscode',
		mutable: false,
		requires: ['file'],
		// The Source Control view passes SourceControlResourceStates — the resourceUri branch of
		// getUrisFromCommandArg, which the bare-URI entries never exercise.
		vscodeCommand: { command: 'git-graph-rs.filterByFile', arg: { kind: 'resourceStates' } },
		uiAfter: CLEAR_FILTER_STEPS,
		expect: { responses: ['loadCommits'] }
	},
	{
		id: 'menu-vscode/scm-view-button',
		title: 'Git Graph RS (Source Control view title menu)',
		group: 'menu-vscode',
		mutable: false,
		// The scm/title navigation button: with the view already showing the repository the
		// command only reveals the panel (no host traffic); when it was closed it loads it — the
		// post-step barrier (first commit row rendered) passes in both cases.
		vscodeCommand: { command: 'git-graph-rs.view', arg: { kind: 'rootUri' } },
		uiAfter: [{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-vscode/diff-open-file-button',
		title: 'Open File (diff editor title)',
		group: 'menu-vscode',
		mutable: false,
		requires: ['file'],
		// The editor/title button shown inside a git-graph-rs diff editor: the command receives
		// the diff document's URI and opens the working-tree file. The runner skips the action
		// where the context file no longer exists at HEAD (the command opens the working file,
		// and on such repositories there is nothing to open); the tab it opens is closed by the
		// runner's per-action cleanup.
		vscodeCommand: { command: 'git-graph-rs.openFile', arg: { kind: 'diffUri' } },
		expectTabs: true,
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-vscode/scm-gerrit-fetch-commit-msg-hook',
		title: 'Fetch commit-msg Hook (Gerrit) (Source Control view title menu)',
		group: 'menu-vscode',
		mutable: true,
		// On the fixture's local bare remote the hook download cannot resolve a Gerrit server and
		// the command answers with an error notification — the run exercises the menu-to-command
		// path end to end without touching the repository, and asserts the refusal (the
		// auto-answer captures and suppresses the toast; "commit-msg" holds in every language).
		vscodeCommand: { command: 'git-graph-rs.gerritFetchCommitMsgHook', arg: { kind: 'rootUri' } },
		expectNotifications: ['commit-msg'],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-vscode/scm-gerrit-push-ref',
		title: 'Push to Gerrit Ref for Current Branch (Source Control Pull/Push menu)',
		group: 'menu-vscode',
		mutable: true,
		// Runs right after the reseed, where main == origin/main: HEAD is contained by a remote
		// branch, so the command takes its "already pushed" refusal — no amend prompt, no push.
		// The refusal notification is captured and asserted ("Change-Id" holds in every language).
		vscodeCommand: { command: 'git-graph-rs.gerritPushRef', arg: { kind: 'rootUri' } },
		expectNotifications: ['Change-Id'],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-vscode/scm-amend-last-commit',
		title: 'Amend Last Commit (Source Control view title menu)',
		group: 'menu-vscode',
		mutable: true,
		// `git commit --amend --no-edit`: no dialog on the command path. Whether the amend
		// succeeds depends on the machine's Git identity (the fixture clone seeds none), and the
		// command answers through a notification either way — no view traffic, no state check.
		// The notification's presence is asserted (its text is fully localized, so no invariant
		// fragment can be pinned with expectNotifications).
		vscodeCommand: { command: 'git-graph-rs.amendLastCommit', arg: { kind: 'rootUri' } },
		expectAnyNotification: true,
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-vscode/scm-reset-current-branch-to-remote',
		title: 'Reset Current Branch to Remote (Soft) (Source Control view title menu)',
		group: 'menu-vscode',
		mutable: true,
		// The modal confirmation is answered with its primary button (the runner is not
		// interactive — the same policy as the webview's data-loss warning). The soft reset to
		// main's upstream keeps the tree identical, so the fixture stays in its seeded shape.
		// The confirmation modal itself is asserted: the command must reach (and pass) it.
		vscodeCommand: { command: 'git-graph-rs.resetCurrentBranchToRemote', arg: { kind: 'rootUri' } },
		expectModal: true,
		noHostTraffic: true,
		expect: { responses: [] }
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
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Author Timestamp Order', '按作者时间排序') },
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
		// The flow toggles the column OFF and back ON: leaving it hidden would change the layout
		// every later run (and the user's view) starts from.
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Date', '日期') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the re-render has landed
			{ op: 'expectCount', selector: 'td.dateCol', min: 0, max: 0 }, // the column is really gone
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Date', '日期') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'expectCount', selector: 'td.dateCol', min: 1 } // ...and really back
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/column-toggle-author',
		title: 'Author',
		group: 'row',
		mutable: false,
		// Same round-trip as the Date toggle, for the Author column.
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Author', '作者') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'expectCount', selector: 'td.authorCol', min: 0, max: 0 },
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Author', '作者') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'expectCount', selector: 'td.authorCol', min: 1 }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/column-toggle-commit',
		title: 'Commit',
		group: 'row',
		mutable: false,
		// Same round-trip as the Date toggle, for the Commit Hash column.
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Commit', '提交') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Commit', '提交') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }
		],
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'expectText', selector: 'span.gitRef.head[data-name="{{branch}}"]', contains: '{{branch}}' },
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
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'expectSize', selector: 'tr.commit[data-hash="{{commit}}"] .openChangesBtn', minW: 12, maxW: 48, minH: 12, maxH: 40 },
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"] .openChangesBtn' }
		],
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			// The CDV shell renders immediately; its FILE list arrives with the commitDetails
			// response — poll for the record instead of racing it with a one-shot count.
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'expectCount', selector: '#cdvFiles .fileTreeFileRecord', min: 1 },
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Add Tag…', '添加标签…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-tag";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogInput3' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
			// type: TagType.Lightweight (numeric enum: Annotated = 0, Lightweight = 1).
			request: [{ command: 'addTag', repo: '{{repo}}', commitHash: '{{commit}}', tagName: 'automation-tag', type: 1, message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false }],
			expect: { responses: ['addTag'] },
			// The tag this entry names must really exist afterwards — the dialog's action label is
			// asserted too (both interface languages).
			verify: { kind: 'tagPresent', placeholder: 'automation-tag' }
		},
	{
		id: 'menu-commit/checkout',
		title: 'Checkout…',
		group: 'menu-commit',
		mutable: true,
		// "Always accept" stays unchecked so the confirmation dialog is part of the flow;
		// confirming detaches HEAD at the commit.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Checkout…', '检出…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Cherry Pick…', '拣选(Cherry Pick)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'cherrypickCommit', repo: '{{repo}}', commitHash: '{{commit}}', parentIndex: 0, recordOrigin: false, noCommit: false }],
		expect: { responses: ['cherrypickCommit'] },
		// Designed refusal: by the time this entry runs, earlier write actions have moved HEAD
		// onto/ past {{commit}}'s changes, so git answers "the previous cherry-pick is now
		// empty" — applying an already-applied commit is the correct outcome, not a failure.
		allowErrorOn: ['cherrypickCommit']
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
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Copy Commit Hash to Clipboard', '复制提交哈希到剪贴板') }
		],
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
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Copy Commit Subject to Clipboard', '复制提交主题到剪贴板') }
		],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-commit/create-branch',
		title: 'Create Branch…',
		group: 'menu-commit',
		mutable: true,
		// The checkout checkbox keeps its default (off), so HEAD stays put.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Create Branch…', '创建分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-branch";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
			request: [{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commit}}', branchName: 'automation-branch', checkout: false, force: false }],
			expect: { responses: ['createBranch'] },
			verify: { kind: 'branchPresent', placeholder: 'automation-branch' }
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Drop…', '丢弃(Drop)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Edit Message…', '编辑提交信息…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'set', selector: '#dialogInput0', value: 'Reworded via automation', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'editCommitMessage', repo: '{{repo}}', commitHash: '{{commit}}', message: 'Reworded via automation' }],
		expect: { responses: ['editCommitMessage'] },
		// Designed refusal: the preceding checkout entry detached HEAD, and {{commit}} is not in
		// the detached position's own history — the host's re-validation correctly refuses to
		// rewrite it. The dialog-to-host path is what the entry exercises.
		allowErrorOn: ['editCommitMessage']
	},
	{
		id: 'menu-commit/edit-message-author',
		title: 'Edit Message… (rewrite the author)',
		group: 'menu-commit',
		mutable: true,
		// The same dialog as edit-message, additionally rewriting the commit's author through the
		// author fields of the Edit Commit Message dialog (#dialogInput1 name, #dialogInput2 email).
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Edit Message…', '编辑提交信息…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'set', selector: '#dialogInput0', value: 'Reworded and re-authored via automation', event: 'input' },
			{ op: 'set', selector: '#dialogInput1', value: 'Automation Author', event: 'input' },
			{ op: 'set', selector: '#dialogInput2', value: 'automation@example.com', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'editCommitMessage', repo: '{{repo}}', commitHash: '{{commit}}', message: 'Reworded and re-authored via automation', authorName: 'Automation Author', authorEmail: 'automation@example.com' }],
		expect: { responses: ['editCommitMessage'] },
		// Same designed refusal as edit-message (the detached-HEAD history check).
		allowErrorOn: ['editCommitMessage']
	},
	{
		id: 'menu-commit/fixup',
		title: 'Create Fixup Commit',
		group: 'menu-commit',
		mutable: true,
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Create Fixup Commit', '创建修正（fixup）提交') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'commitFixup', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['commitFixup'] },
		// The runner stages a fresh modification before this action (the menu commits the STAGED
		// changes — a precondition the editor's SCM UI owns, established out-of-band exactly like
		// the reseed establishes stashes), so the commit must really land: the newest commit's
		// subject is git's own "fixup! <target subject>" prefix.
		verify: { kind: 'headSubjectStartsWith', placeholder: 'fixup!' }
	},
	{
		id: 'menu-commit/merge',
		title: 'Merge into current branch…',
		group: 'menu-commit',
		mutable: true,
		// The dialog fires a predictConflicts probe first (unawaited traffic); with the default
		// "create a commit" (no fast-forward) checkbox set, the merge commits.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Merge into current branch…', '合并到当前分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Rebase current branch on this Commit…', '将当前分支变基到该提交…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			{ op: 'contextmenu', selector: 'tr.commit:has(.commitHeadDot)', item: bi('Reset Last Commit (Soft)…', '重置上一次提交(软重置)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Reset current branch to this Commit…', '将当前分支重置到该提交…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Revert…', '还原(Revert)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Select for Compare', '选择以比较') }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-commit/squash',
		title: 'Create Squash Commit',
		group: 'menu-commit',
		mutable: true,
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'contextmenu', selector: 'tr.commit[data-hash="{{commit}}"]', item: bi('Create Squash Commit', '创建压缩（squash）提交') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'commitSquash', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['commitSquash'] },
		// Same staged-change precondition and real-outcome check as fixup, with git's "squash!" prefix.
		verify: { kind: 'headSubjectStartsWith', placeholder: 'squash!' }
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
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Clean untracked files…', '清理未跟踪文件…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
		// The row only renders while the working tree has uncommitted changes: on a clean tree
		// there is nothing to right-click, and the action skips.
		ui: [
			{ op: 'skipIfAbsent', selector: 'tr#uncommittedChanges' },
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Open Source Control View', '打开源代码管理视图') }
		],
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
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Reset uncommitted changes…', '重置未提交的更改…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Stash uncommitted changes…', '贮藏未提交的更改…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Checkout Branch', '检出分支') },
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
		requires: ['anotherBranch'],
		// A branch-picker dialog whose Compare action opens a Commit Comparison tab (no host
		// response); the target defaults to the first other branch — which needs a second branch
		// to exist (the action skips on single-branch repositories).
		ui: [
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Compare with...', '比较...') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
		ui: [
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'expectText', selector: 'span.gitRef.head[data-name="{{branch}}"]', contains: '{{branch}}' },
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Copy Branch Name to Clipboard', '复制分支名称到剪贴板') }
		],
		request: [{ command: 'copyToClipboard', type: 'Branch Name', data: '{{branch}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-branch/create-archive',
		title: 'Create Archive',
		group: 'menu-branch',
		mutable: true,
		nativeSaveDialog: true,
		// Confirming opens the editor's native save dialog (utils.archive's showSaveDialog) —
		// the suite runner reports this action as skipped rather than stall the run on the modal.
		ui: [
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Create Archive', '创建归档') },
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Create Branch…', '创建分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-branch-2";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commit}}', branchName: 'automation-branch-2', checkout: false, force: false }],
		expect: { responses: ['createBranch'] },
		verify: { kind: 'branchPresent', placeholder: 'automation-branch-2' }
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Delete Branch…', '删除分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogInput0' },
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Merge into current branch…', '合并到当前分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Pull Branch…', '拉取分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'fetchIntoLocalBranch', repo: '{{repo}}', remote: '{{remote}}', remoteBranch: '{{branch}}', localBranch: '{{branch}}', force: false }],
		expect: { responses: ['fetchIntoLocalBranch'] },
		// {{branch}} resolves to local-ahead on the fixture — a branch the remote does not have —
		// so git's "couldn't find remote ref" refusal IS the correct outcome of pulling it: the
		// designed error the run accepts (the menu-to-host path is what the entry exercises).
		allowErrorOn: ['fetchIntoLocalBranch']
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Push Branch…', '推送分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Rebase current branch on Branch…', '将当前分支变基到该分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.head[data-name="{{branch}}"]', item: bi('Rename Branch…', '重命名分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="{{branch}}-renamed";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'renameBranch', repo: '{{repo}}', oldName: '{{branch}}', newName: '{{branch}}-renamed' }],
		expect: { responses: ['renameBranch'] },
		verify: { kind: 'branchAbsent', placeholder: '{{branch}}' }
	},
	{
		id: 'menu-branch/pin',
		title: 'Pin Branch',
		group: 'menu-branch',
		mutable: false,
		// Pinning persists via a silent setRepoState and re-renders; the item's title depends on
		// the pin state ("Pin Branch" / "Unpin Branch"), so the eval clicks whichever the current
		// state offers — twice, which returns the branch to its original pin state. The barriers
		// observe the pinned-controls chip (present at any scroll depth) flipping and restoring:
		// the flow scrolls the branch label into view first, which on a real repository can leave
		// the view deep in history where the first table row never renders.
		ui: [
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			PIN_SNAPSHOT_STEP,
			{
				op: 'eval',
				expr: '(function(){var l=document.querySelector(\'span.gitRef.head[data-name="{{branch}}"]\');if(l===null)throw new Error(\'branch label not rendered: {{branch}}\');l.dispatchEvent(new MouseEvent(\'contextmenu\',{bubbles:true,cancelable:true,button:2}));var wanted=' + JSON.stringify([...bi('Pin Branch', '固定分支'), ...bi('Unpin Branch', '取消固定分支')]) + ';var items=document.querySelectorAll(\'ul.contextMenu li.contextMenuItem\');for(var i=0;i<items.length;i++){var t=items[i].textContent.trim();if(wanted.indexOf(t)!==-1){items[i].click();return t;}}throw new Error(\'pin/unpin item not found: \'+Array.from(items).map(function(x){return x.textContent.trim();}).join(\'|\'));})()'
			},
			pinChipStateStep('flipped'), // the toggle's re-render has landed
			{
				op: 'eval',
				expr: '(function(){var l=document.querySelector(\'span.gitRef.head[data-name="{{branch}}"]\');if(l===null)throw new Error(\'branch label not rendered: {{branch}}\');l.dispatchEvent(new MouseEvent(\'contextmenu\',{bubbles:true,cancelable:true,button:2}));var wanted=' + JSON.stringify([...bi('Pin Branch', '固定分支'), ...bi('Unpin Branch', '取消固定分支')]) + ';var items=document.querySelectorAll(\'ul.contextMenu li.contextMenuItem\');for(var i=0;i<items.length;i++){var t=items[i].textContent.trim();if(wanted.indexOf(t)!==-1){items[i].click();return t;}}throw new Error(\'pin/unpin item not found: \'+Array.from(items).map(function(x){return x.textContent.trim();}).join(\'|\'));})()'
			},
			pinChipStateStep('restored') // the branch is back to its original pin state
		],
		noHostTraffic: true,
		expect: { responses: [] }
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
		// {{branchHead}} instead of a hardcoded branch name: the checked-out branch is repository
		// data, and its label may sit deep in the graph (windowed rendering keeps it out of the
		// DOM) — the scroll step reveals it.
		ui: [
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branchHead}}"]'),
			{
				op: 'eval',
				expr: '(function(){var s=\'span.gitRef.head[data-name="{{branchHead}}"]\';var l=document.querySelector(s);if(l===null)throw new Error(\'branch label not rendered: {{branchHead}}\');l.dispatchEvent(new MouseEvent(\'contextmenu\',{bubbles:true,cancelable:true,button:2}));var wanted=' + JSON.stringify([...bi('Select in Branches Dropdown', '在分支下拉列表中选中'), ...bi('Unselect in Branches Dropdown', '在分支下拉列表中取消选中')]) + ';var items=document.querySelectorAll(\'ul.contextMenu li.contextMenuItem\');for(var i=0;i<items.length;i++){var t=items[i].textContent.trim();if(wanted.indexOf(t)!==-1){items[i].click();return t;}}throw new Error(\'select/unselect item not found: \'+Array.from(items).map(function(x){return x.textContent.trim();}).join(\'|\'));})()'
			},
			{ op: 'waitFor', selector: 'span.gitRef.head[data-name="{{branchHead}}"]' }, // the reload has rendered
			...SHOW_ALL_RESTORE_STEPS
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
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="{{remote}}/{{remoteBranch}}"]', item: bi('Checkout Branch…', '检出分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-remote-checkout";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'checkoutBranch', repo: '{{repo}}', branchName: 'automation-remote-checkout', remoteBranch: '{{remote}}/{{remoteBranch}}', pullAfterwards: null }],
		expect: { responses: ['checkoutBranch'] },
		verify: { kind: 'branchPresent', placeholder: 'automation-remote-checkout' }
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
			{ op: 'expectText', selector: 'span.gitRef.remote[data-name="{{remote}}/{{remoteBranch}}"]', contains: '{{remoteBranch}}' },
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="{{remote}}/{{remoteBranch}}"]', item: bi('Copy Branch Name to Clipboard', '复制分支名称到剪贴板') },
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
		nativeSaveDialog: true,
		requires: ['remote'],
		// Confirming opens the editor's native save dialog (utils.archive's showSaveDialog) —
		// the suite runner reports this action as skipped rather than stall the run on the modal.
		ui: [
			...REMOTE_BRANCH_FILTER_STEPS,
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="{{remote}}/{{remoteBranch}}"]', item: bi('Create Archive', '创建归档') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="{{remote}}/{{remoteBranch}}"]', item: bi('Create Branch…', '创建分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-remote-branch";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commit}}', branchName: 'automation-remote-branch', checkout: true, force: false }],
		expect: { responses: ['createBranch'] },
		verify: { kind: 'branchPresent', placeholder: 'automation-remote-branch' }
	},
	{
		id: 'menu-remote-branch/delete-remote-branch',
		title: 'Delete Remote Branch…',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		// Deleting a remote branch always carries a data-loss risk: after the confirmation
		// dialog, a second (risk acknowledgement) dialog must be confirmed. The shared
		// {{remoteBranch}} is used: every action re-resolves its context, so the later
		// remote-branch entries of the same write pass simply move to the next branch.
		ui: [
			...remoteBranchFilterSteps('{{remote}}/{{remoteBranch}}'),
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="{{remote}}/{{remoteBranch}}"]', item: bi('Delete Remote Branch…', '删除远程分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SHOW_ALL_RESTORE_STEPS
		],
		request: [{ command: 'deleteRemoteBranch', repo: '{{repo}}', branchName: '{{remoteBranch}}', remote: '{{remote}}' }],
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
		request: [{ command: 'merge', repo: '{{repo}}', obj: '{{remote}}/{{remoteBranch}}', actionOn: 'Remote-tracking Branch', createNewCommit: true, squash: false, noCommit: false }],
		expect: { responses: ['merge'] },
		// Designed refusal: the current branch is another feature branch's checkout, and two
		// diverged feature branches touch the same files — the merge conflicts by construction.
		// The request-to-git pipeline is what this UI-less entry exercises; the runner aborts
		// the conflicted merge right after (POST_ACTION_CLEANUP) so it cannot poison later actions.
		allowErrorOn: ['merge']
	},
	{
		// NOTE: no UI path — same order-sensitivity as menu-remote-branch/merge (the remote label
		// is combined with the checked-out local branch by the time this entry runs).
		id: 'menu-remote-branch/pull-into',
		title: 'Pull into current branch…',
		group: 'menu-remote-branch',
		mutable: true,
		requires: ['remote'],
		request: [{ command: 'pullBranch', repo: '{{repo}}', branchName: '{{remoteBranch}}', remote: '{{remote}}', createNewCommit: false, squash: false }],
		expect: { responses: ['pullBranch'] },
		// Same designed conflict as the merge above (pulling a diverged branch into another
		// feature branch's checkout); the runner aborts the leftover merge state afterwards.
		allowErrorOn: ['pullBranch']
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
			{ op: 'contextmenu', selector: 'span.gitRef.remote[data-name="{{remote}}/{{remoteBranch}}"]', item: bi('Unselect in Branches Dropdown', '在分支下拉列表中取消选中') },
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
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Apply Stash…', '应用贮藏(Apply Stash)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Create Branch from Stash…', '从贮藏创建分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-stash-branch";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'branchFromStash', repo: '{{repo}}', selector: '{{stash}}', branchName: 'automation-stash-branch' }],
		expect: { responses: ['branchFromStash'] },
		verify: { kind: 'branchPresent', placeholder: 'automation-stash-branch' }
	},
	{
		id: 'menu-stash/copy-hash',
		title: 'Copy Stash Hash to Clipboard',
		group: 'menu-stash',
		mutable: false,
		requires: ['stash'],
		// The stash commit hash is a runtime value with no placeholder, so only the UI path.
		// A stash row can sit deep in the loaded page (windowed rendering keeps only viewport
		// rows in the DOM) — the flow scrolls to the label first; a stash outside the loaded
		// page never resolves {{stash}} (the server probes the loaded graph), so the action skips.
		ui: [
			scrollUntilVisibleStep('span.gitRef.stash[data-name="{{stash}}"]'),
			// The label renders the stash's own display name (the selector minus its "stash@"
			// prefix — stash rows render the short name in .gitRefName).
			{ op: 'expectCount', selector: 'span.gitRef.stash[data-name="{{stash}}"] .gitRefName', min: 1, max: 1 },
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Copy Stash Hash to Clipboard', '复制贮藏哈希到剪贴板') }
		],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-stash/copy-name',
		title: 'Copy Stash Name to Clipboard',
		group: 'menu-stash',
		mutable: false,
		requires: ['stash'],
		// Same scroll-to-the-label preamble as copy-hash: the stash row may render far below the viewport.
		ui: [
			scrollUntilVisibleStep('span.gitRef.stash[data-name="{{stash}}"]'),
			{ op: 'expectCount', selector: 'span.gitRef.stash[data-name="{{stash}}"] .gitRefName', min: 1, max: 1 },
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Copy Stash Name to Clipboard', '复制贮藏名称到剪贴板') }
		],
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
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Drop Stash…', '丢弃贮藏(Drop Stash)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Pop Stash…', '弹出贮藏(Pop Stash)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
		requires: ['tag'],
		// Tag rows sit deep in the graph and windowed rendering keeps only the viewport rows in
		// the DOM — the flow scrolls until the {{tag}} label (the first tag of the loaded page,
		// a repository value the server resolves) renders, then restores the scroll position.
		// The request path uses v1.0.0, the fixture's always-existing tag.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{tag}}"]'),
			{ op: 'expectText', selector: 'span.gitRef.tag[data-name="{{tag}}"]', contains: '{{tag}}' },
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{tag}}"]', item: bi('Copy Tag Name to Clipboard', '复制标签名称到剪贴板') },
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
		nativeSaveDialog: true,
		// Confirming opens the editor's native save dialog (utils.archive's showSaveDialog) —
		// the suite runner reports this action as skipped rather than stall the run on the modal.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="v1.29.0"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="v1.29.0"]', item: bi('Create Archive', '创建归档') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
		requires: ['annotatedTag'],
		// The annotated placeholder is the tag `menu-commit/add-tag` created near HEAD (the
		// fixture's own in-window tags are lightweight, so in the write pass the annotated one is
		// that fresh tag) — well inside the loaded page, unlike the v1.29.0 this entry once
		// hardcoded: that tag sits ~700 commits deep while the initial load is 300, and the
		// scroll step cannot trigger a load-more, so the row was unreachable by construction.
		// With a single remote the dialog is an "also delete on remote" checkbox (default off,
		// so a remote copy survives). `menu-tag/push` runs after this and resolves {{tag}} —
		// with the annotated tag gone it targets the newest fixture tag instead.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{annotatedTag}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{annotatedTag}}"]', item: bi('Delete Tag…', '删除标签…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'deleteTag', repo: '{{repo}}', tagName: 'v1.0.0', deleteOnRemote: null }],
		expect: { responses: ['deleteTag'] },
		// The UI path deletes the live {{annotatedTag}} (the entry above documents why); the state
		// check holds the flow's own target, so the delete must really have removed it.
		verify: { kind: 'tagAbsent', placeholder: '{{annotatedTag}}' }
	},
	{
		id: 'menu-tag/push',
		title: 'Push Tag…',
		group: 'menu-tag',
		mutable: true,
		requires: ['remote'],
		// {{tag}} — the first tag of the loaded page. In the write pass `menu-tag/delete` has
		// already removed the annotated add-tag tag, so this resolves to the newest fixture tag,
		// which exists on the fixture remote: the host answers with an error dialog (after the
		// action-running overlay), which the flow settles and dismisses — the designed path.
		// When delete skipped (no annotated tag), {{tag}} is whatever leads the page and the
		// flow tolerates a successful push through the same overlay. `commit` approximates the
		// tagged commit (the live flow passes the tag's own commit hash).
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{tag}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{tag}}"]', item: bi('Push Tag…', '推送标签…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'pushTag', repo: '{{repo}}', tagName: 'v1.0.0', remotes: ['{{remote}}'], commitHash: '{{commit}}', skipRemoteCheck: false }],
		expect: { responses: ['pushTag'] },
		// The fixture remote already carries the tag, so the push is rejected ("already exists")
		// — the designed outcome the comment above describes. Any OTHER error (a broken dialog
		// path, a wrong ref) still fails the entry.
		allowErrorOn: ['pushTag']
	},
	{
		id: 'menu-tag/view-details',
		title: 'View Details',
		group: 'menu-tag',
		mutable: false,
		requires: ['annotatedTag'],
		// Only offered for annotated tags; {{annotatedTag}} is the first annotated tag of the
		// loaded graph (the server picks it from the per-commit tag metadata), so the menu always
		// offers the item and repositories without annotated tags skip cleanly. The details
		// arrive in a dialog (`.messageContent` distinguishes it from the action-running overlay,
		// which also offers a "Dismiss" secondary — dismissing the overlay before the response
		// would let the details dialog open behind it); it is closed with its Close action.
		// `commit` approximates the tagged commit; the response arrives regardless.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{annotatedTag}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{annotatedTag}}"]', item: bi('View Details', '查看详情') },
			{ op: 'waitFor', selector: '.dialog .messageContent' },
			// The dialog really shows THIS tag's details — its name is in the message body.
			{ op: 'expectText', selector: '.dialog .messageContent', contains: '{{annotatedTag}}' },
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
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
		// Folder open/closed state is webview state only — no host traffic. The effect is asserted
		// state-independently (a real repository's folders may start in any per-repo saved state,
		// and a root-level-only commit has no folders at all — then the check is vacuously true):
		// after the collapse click EVERY folder is closed, not just some.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCollapse' },
			{ op: 'click', selector: '#cdvCollapse' },
			{
				op: 'eval',
				expr: '(function(){var folders=document.querySelectorAll("#cdvFiles .fileTreeFolder").length;var closed=document.querySelectorAll("#cdvFiles li.closed").length;if(folders!==closed)throw new Error("the collapse left "+(folders-closed)+" of "+folders+" folders open");return folders+" folders collapsed";})()'
			},
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
		// After the collapse click every folder must be open again — no closed marker left.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvExpand' },
			{ op: 'click', selector: '#cdvExpand' },
			{ op: 'expectCount', selector: '#cdvFiles li.closed', min: 0, max: 0 }, // every folder open again
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
		requires: ['file'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('Copy Absolute File Path to Clipboard', '复制绝对文件路径到剪贴板') },
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
		requires: ['file'],
		// Only offered while a code review is in progress and the file is still unreviewed, so
		// the flow starts a review first and ends it again afterwards. `file` (the first file of
		// the commit's details) is data-index 0 in the freshly opened view.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCodeReview' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitFor', selector: '#cdvCodeReview.active' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('Mark as Reviewed', '标记为已评审') },
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
		requires: ['file'],
		// `file` belongs to the context commit, which the fixture checks out only on local-ahead —
		// at HEAD=main the working tree does not contain it, so the host answers with an error
		// dialog that the flow dismisses (a leaked modal would swallow the keyboard shortcuts of
		// the later runs).
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('Open File', '打开文件') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'openFile', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['openFile'] },
		// Designed refusal, per the comment above: the context file need not exist at HEAD.
		allowErrorOn: ['openFile']
	},
	{
		id: 'cdv/file-view-diff',
		title: 'View Diff',
		group: 'cdv',
		mutable: false,
		requires: ['file'],
		// A single commit diffs against its first parent. The fixture history only ever contains
		// Modified changes (no adds/deletes/renames), so type 'M' with oldFilePath ===
		// newFilePath is exact for it; other repositories would need the runtime values.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff', '查看差异') },
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
		requires: ['file'],
		// Only offered when the file still exists at this revision and is not binary.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff with Working File', '与工作区文件比较差异') },
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
		requires: ['file'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View File at this Revision', '查看该版本的文件') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewFileAtRevision', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['viewFileAtRevision'] }
	},
	{
		// The fixture (fixture.mjs) seeds a dedicated commit whose ONLY change is a plain binary
		// file (assets/archive.bin) — data-index="0" is always that file, so this reliably drives
		// the binary compare view (binaryCompareView.ts) instead of the text diff `cdv/file-view-diff`
		// always exercises (its `file` context explicitly excludes binaries).
		id: 'cdv/file-view-diff-binary',
		title: 'View Diff (binary file)',
		group: 'cdv',
		mutable: false,
		requires: ['binaryFile'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{binaryCommit}}"]'),
			{ op: 'click', selector: 'tr.commit[data-hash="{{binaryCommit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff', '查看差异') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiff', repo: '{{repo}}', fromHash: '{{binaryCommit}}', toHash: '{{binaryCommit}}', oldFilePath: '{{binaryFile}}', newFilePath: '{{binaryFile}}', type: 'M' }],
		expect: { responses: ['viewDiff'] }
	},
	{
		// Same as above, but the dedicated commit's only change is a real, decodable image
		// (assets/logo.png) — drives the picture side of the binary compare view specifically
		// (isImageChange/imageMimeOf in binaryCompare.ts), not just "any binary file".
		id: 'cdv/file-view-diff-image',
		title: 'View Diff (image file)',
		group: 'cdv',
		mutable: false,
		requires: ['imageFile'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{imageCommit}}"]'),
			{ op: 'click', selector: 'tr.commit[data-hash="{{imageCommit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff', '查看差异') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiff', repo: '{{repo}}', fromHash: '{{imageCommit}}', toHash: '{{imageCommit}}', oldFilePath: '{{imageFile}}', newFilePath: '{{imageFile}}', type: 'M' }],
		expect: { responses: ['viewDiff'] }
	},
	{
		id: 'cdv/file-view-list',
		title: 'File List View',
		group: 'cdv',
		mutable: false,
		// The view-type change persists via a setRepoState the host answers silently.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
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
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
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
			...DIALOG_ASSERT_STEPS,
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
			...DIALOG_ASSERT_STEPS,
			{ op: 'set', selector: '#dialogInput0', value: 'automation-remote', event: 'input' },
			{ op: 'set', selector: '#dialogInput1', value: '{{repo}}', event: 'input' },
			{ op: 'click', selector: '#dialogInput3' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'addRemote', repo: '{{repo}}', name: 'automation-remote', url: '{{repo}}', pushUrl: null, fetch: false }],
		expect: { responses: ['addRemote'] },
		verify: { kind: 'remotePresent', placeholder: 'automation-remote' }
	},
	{
		id: 'settings/delete-remote',
		title: 'Delete Remote',
		group: 'settings',
		mutable: true,
		// The remotes table lists whatever remotes exist by then (add-remote ran first, so at
		// least two): the flow deletes the row NAMED {{remote}} — the verify checks that same
		// name is gone, so the click must target it however the table orders its rows.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsWidget .deleteRemote' },
			{
				op: 'eval',
				expr: '(function(){var want="{{remote}}";var rows=[...document.querySelectorAll("#settingsWidget table tr")];var row=rows.find(function(r){var c=r.querySelector("td.left");return c!==null&&c.textContent.trim()===want;});if(row===undefined)throw new Error("no remote row named "+want+" (saw: "+rows.map(function(r){var c=r.querySelector("td.left");return c===null?"":c.textContent.trim();}).filter(function(t){return t!=="";}).join(", ")+")");row.querySelector(".deleteRemote").click();return want;})()'
			},
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'deleteRemote', repo: '{{repo}}', name: '{{remote}}' }],
		expect: { responses: ['deleteRemote'] },
		verify: { kind: 'remoteAbsent', placeholder: '{{remote}}' }
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
			...DIALOG_ASSERT_STEPS,
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
			...DIALOG_ASSERT_STEPS,
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
		// The toggle flips the per-repo override OFF and reloads; the restore step flips it back
		// through the same control, so the run cannot leave the repository with stashes hidden
		// (see restoreSettingsCheckboxStep for the cross-run poisoning that a one-way toggle
		// caused). The suite runner additionally re-ensures the option at each phase start.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#settingsShowStashes' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the OFF reload has rendered
			restoreSettingsCheckboxStep('settingsShowStashesCheckbox'),
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/show-tags',
		title: 'Show Tags',
		group: 'settings',
		mutable: true,
		// Same toggle-and-restore shape as show-stashes: with the toggle left off the host omits
		// every tag from the loaded graph while the automation probes still see them, and the
		// whole menu-tag group fails on the next run against this repository.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#settingsShowTags' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the OFF reload has rendered
			restoreSettingsCheckboxStep('settingsShowTagsCheckbox'),
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
		// Match navigation only scrolls and re-highlights — no host traffic. The navigation is
		// asserted: the position indicator ("N of M") must advance when there is another match to
		// move to (a single-match query stays put — the barrier tolerates exactly that).
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'eval', expr: '(function(){window.__ggFindPosBefore=document.getElementById("findPosition").textContent.trim();return window.__ggFindPosBefore;})()' },
			{ op: 'click', selector: '#findNext' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var m=now.match(/[0-9]+[^0-9]+([0-9]+)/);if(now!==was)return resolve(was+" -> "+now);if(m!==null&&parseInt(m[1],10)===1)return resolve("single match - navigation is a no-op ("+was+")");if(++n>100)return reject(new Error("the Next Match click did not advance the position indicator ("+was+")"));setTimeout(t,25);};t();});})()'
			},
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
		// The mirror of find-next: the position indicator must move back (or wrap) — the same
		// single-match tolerance applies.
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'eval', expr: '(function(){window.__ggFindPosBefore=document.getElementById("findPosition").textContent.trim();return window.__ggFindPosBefore;})()' },
			{ op: 'click', selector: '#findPrev' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var m=now.match(/[0-9]+[^0-9]+([0-9]+)/);if(now!==was)return resolve(was+" -> "+now);if(m!==null&&parseInt(m[1],10)===1)return resolve("single match - navigation is a no-op ("+was+")");if(++n>100)return reject(new Error("the Previous Match click did not move the position indicator ("+was+")"));setTimeout(t,25);};t();});})()'
			},
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
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
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
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'expectText', selector: '#findPosition', contains: bi(' of ', '，共') },
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
		// Default keybinding: keyboardShortcut.scrollToHead = 'h'; pure scroll. The effect is
		// asserted: the HEAD row (the one carrying the commitHeadDot marker) is inside the
		// rendered window afterwards — windowed rendering keeps only viewport rows in the DOM.
		ui: [
			{ op: 'key', key: 'h', ctrlOrCmd: true },
			{ op: 'waitFor', selector: 'tr.commit:has(.commitHeadDot)' }
		],
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
			reflogRowMenuStep('.reflogRow[data-index="1"]', bi('Checkout…', '检出…')),
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			reflogRowMenuStep('.reflogRow', bi('Copy Commit Hash to Clipboard', '复制提交哈希到剪贴板')),
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
			reflogRowMenuStep('.reflogRow[data-index="1"]', bi('Reset current branch to here…', '将当前分支重置到此处…')),
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
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
			...DIALOG_ASSERT_STEPS,
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
			...DIALOG_ASSERT_STEPS,
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
			...DIALOG_ASSERT_STEPS,
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
		// The Settings Widget's "Open Log File" tool. With session logging disabled (the fixture)
		// the host answers with an error dialog; with it enabled (a developer machine) the log
		// simply opens and no dialog appears — so the settle step tolerates both instead of a
		// hard .dialog wait, and a leaked modal can never swallow the later runs' shortcuts.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openLogFile' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		request: [{ command: 'openLogFile' }],
		expect: { responses: ['openLogFile'] },
		// With session logging disabled the host's error IS the designed answer (see the comment
		// above); with logging enabled the same command succeeds. Both outcomes pass; anything
		// else the pipeline reports still fails.
		allowErrorOn: ['openLogFile']
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

/**
 * Step builders and shared step sequences referenced across the catalog's domain files: exact-text
 * candidates across interface languages, dropdown/pin/scroll barriers, dialog assertions and the
 * Gerrit settings toggles. Carved verbatim out of the former single-file catalog.ts (task 6.2);
 * the definitions are unchanged, only exported now.
 */

import { UiStep } from './types';

/**
 * Exact-text candidates across the interface languages the extension ships (web/strings.ts):
 * the shim clicks/looks for whichever the rendered UI shows, so a catalog entry matches menu
 * items, dropdown options and labels under both the English and the zh-CN interface.
 */
export const bi = (en: string, zh: string): readonly string[] => [en, zh];

/** The Branches Dropdown's "Show All" option in both shipped interface languages. */
export const SHOW_ALL_TEXTS: readonly string[] = bi('Show All', '显示全部');

/**
 * A UI step that resolves once the Repository Dropdown's displayed value equals the page-global
 * `window[name]` (a value an earlier eval stored): the value element is re-rendered by the view
 * when the switch's reload lands, so this is the barrier that tells a real repository switch
 * from the previous repository's still-rendered table.
 */
export const dropdownValueIs = (name: string): UiStep => ({
	op: 'eval',
	expr: '(function(){var want=window[' + JSON.stringify(name) + '];return new Promise(function(resolve,reject){var n=0;var t=function(){var v=document.querySelector("#repoDropdown .dropdownCurrentValue");if(v!==null&&v.textContent.trim()===want)return resolve(want);if(++n>100)return reject(new Error("repository dropdown never switched to "+want));setTimeout(t,100);};t();});})()'
});

/** The pinned-controls chip of `branch` (a `{{…}}` placeholder): rendered above the windowed commit table, so it exists at any scroll depth. */
export const pinnedChipSelector = (branch: string): string => '.pinnedChip[data-type="branch"][data-value="' + branch + '"]';

/**
 * A UI step that snapshots whether the `{{branch}}` pinned-controls chip exists (the branch's
 * current pin state) into `window.__ggPinWasPinned` — pin state is repository data a catalog
 * entry cannot know, and the barriers below must observe the pin/unpin round-trip from whatever
 * state the run starts in.
 */
export const PIN_SNAPSHOT_STEP: UiStep = {
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
export const pinChipStateStep = (phase: 'flipped' | 'restored'): UiStep => ({
	op: 'eval',
	expr: '(function(){var sel=' + JSON.stringify(pinnedChipSelector('{{branch}}')) + ';var want=' + (phase === 'flipped' ? '!' : '') + 'window.__ggPinWasPinned;'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){var has=document.querySelector(sel)!==null;'
		+ 'if(has===want)return resolve(want?"pinned":"unpinned");'
		+ 'if(++n>200)return reject(new Error("pin state never changed"));setTimeout(t,25);};t();});})()'
});

/** The in-page eval that selects exactly `branch` (and nothing else) in the Branches Dropdown. */
export const filterBranchDropdownExpr = (branch: string): string =>
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
export const remoteBranchFilterSteps = (branch: string): readonly UiStep[] => [
	{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
	{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
	{ op: 'eval', expr: filterBranchDropdownExpr(branch) },
	{ op: 'key', key: 'Escape' },
	{ op: 'waitFor', selector: 'span.gitRef.remote[data-name="' + branch + '"]' }
];

/** UI steps that filter the Branches Dropdown to the context remote branch ({{remote}}/{{remoteBranch}}). */
export const REMOTE_BRANCH_FILTER_STEPS: readonly UiStep[] = remoteBranchFilterSteps('{{remote}}/{{remoteBranch}}');

/** UI steps that reset the Branches Dropdown to "Show All" and wait for the reload to render. */
export const SHOW_ALL_RESTORE_STEPS: readonly UiStep[] = [
	{ op: 'click', selector: '#branchDropdown .dropdownCurrentValue' },
	{ op: 'waitFor', selector: '#branchDropdown .dropdownOption' },
	{ op: 'eval', expr: '(function(){var w=' + JSON.stringify(SHOW_ALL_TEXTS) + ';var o=[...document.querySelectorAll("#branchDropdown .dropdownOption")].find(function(o){return w.indexOf(o.textContent.trim())!==-1;});if(o===undefined)throw new Error("Show All option missing");o.click();return "clicked";})()' },
	{ op: 'key', key: 'Escape' },
	{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' } // the restore reload has rendered
];

/**
 * A UI step that scrolls the commit table down until the row carrying `selector` is VISIBLE IN
 * THE VIEWPORT, then resolves. Windowed rendering keeps only the viewport rows in the DOM - and
 * the scroll velocity lead renders rows BELOW the viewport as well, so "rendered" alone can
 * resolve a step early and the row can drop out of the window again once the lead decays;
 * requiring visibility keeps the row on screen for the steps that follow. A layout-less host
 * (jsdom reports every rect as zero) cannot measure visibility: the fallback centres the scroll
 * on the row's commit index instead, which places it inside the tight window. Starts from the
 * top — a preceding checkout or reveal may have scrolled the view deep — and scales its stride
 * to the table's full scroll height, so any depth within the loaded page is covered in the same
 * bounded number of attempts; gives up after ~50 attempts.
 */
export const scrollUntilVisibleStep = (selector: string): UiStep => ({
	op: 'eval',
	expr: '(function(){return new Promise(function(resolve,reject){var v=document.getElementById("view");v.scrollTop=0;v.dispatchEvent(new Event("scroll"));var attempt=0;var visible=function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(el===null)return false;var r=el.getBoundingClientRect();if(r.top===0&&r.bottom===0&&r.left===0&&r.right===0){var tr=el.closest?el.closest("tr"):null;if(tr&&tr.dataset&&/^\\d+$/.test(tr.dataset.id)){var id=parseInt(tr.dataset.id,10);v.scrollTop=Math.max(0,96+id*24-(v.clientHeight||600)/2);v.dispatchEvent(new Event("scroll"));}return true;}return r.bottom>0&&r.top<window.innerHeight;};var step=function(){if(visible())return resolve("found");var max=v.scrollHeight-v.clientHeight;var stride=Math.max(20*24,Math.ceil(max/40));if(attempt++>50)return reject(new Error("row never rendered: ' + selector.replace(/"/g, '') + '"));if(max>0){v.scrollTop=Math.min(max,stride*attempt);v.dispatchEvent(new Event("scroll"));}setTimeout(step,120);};setTimeout(step,150);});})()'
});

/**
 * A UI step that opens a Reflog row's action menu (the rows open their menu on CLICK, not
 * contextmenu — web/reflogView.ts) and clicks the item titled `item`. The click is dispatched
 * non-bubbling: the ContextMenu singleton closes itself on any document-level click, which would
 * otherwise remove the menu opened by this very event.
 */
export const reflogRowMenuStep = (rowSelector: string, item: string | readonly string[]): UiStep => ({
	op: 'eval',
	expr: '(function(){var row=document.querySelector(' + JSON.stringify(rowSelector) + ');if(row===null)throw new Error("reflog row not found: ' + rowSelector.replace(/"/g, '') + '");' +
		'row.dispatchEvent(new MouseEvent("click",{bubbles:false,cancelable:true}));' +
		'var wanted=' + JSON.stringify(Array.isArray(item) ? item : [item]) + ';' +
		'var items=document.querySelectorAll("ul.contextMenu li.contextMenuItem");' +
		'for(var i=0;i<items.length;i++){if(wanted.indexOf(items[i].textContent.trim())!==-1){items[i].click();return "clicked";}}' +
		'throw new Error("reflog menu item not found: ' + item + ' (saw " + Array.from(items).map(function(x){return x.textContent.trim();}).join("|") + ")");})()'
});

/** A UI step that closes the Reflog widget if a previous failed run left it open. */
export const REFLOG_DEFENSIVE_CLOSE_STEP: UiStep = {
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
export const DISMISS_ERROR_DIALOG_STEP: UiStep = {
	op: 'eval',
	expr: '(function(){return new Promise(function(resolve){var clear=0;var polls=0;var timer=setInterval(function(){var d=document.querySelector(".dialog");if(d!==null){clear=0;var p=d.querySelector("#dialogAction");var s=d.querySelector("#dialogSecondaryAction");if(p!==null)p.click();else if(s!==null)s.click();else d.remove();}else{clear++;polls++;if(clear>5||polls>100){clearInterval(timer);resolve("settled");}}},100);});})()'
};

/** UI steps that scroll the commit table back to the top and wait for the first row. */
export const SCROLL_TOP_STEPS: readonly UiStep[] = [
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
export const restoreSettingsCheckboxStep = (id: string): UiStep => ({
	op: 'eval',
	expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var c=document.getElementById(' + JSON.stringify(id) + ');if(c!==null){var flipped=false;if(!c.checked){c.click();flipped=true;}var cb=document.getElementById("settingsClose");if(cb!==null)cb.click();return resolve(flipped?"restored":"already on");}if(++n>100)return reject(new Error("the settings checkbox never appeared: ' + id + '"));setTimeout(t,100);};t();});})()'
});

/**
 * A UI step that flips the Settings widget's "Fetch Gerrit change refs" checkbox to `target` (a
 * JS expression over window globals, e.g. a snapshot captured earlier) and resolves once the
 * flip settled. Enabling runs straight through; disabling opens a confirmation whose primary
 * action the step clicks on the run's behalf (the same policy as every data-loss confirmation
 * in this suite). The checkbox is re-queried on every poll — setGerritFetchRefs re-renders the
 * whole widget, replacing the element — and the action-running overlay the host request raises
 * (a secondary-only dialog) is waited out, never dismissed: only a dialog that offers a primary
 * action (#dialogAction, the disable confirmation) is clicked.
 */
export const gerritFetchRefsFlipStep = (target: string): UiStep => ({
	op: 'eval',
	expr: '(function(){var target=' + target + ';var c=document.getElementById("settingsGerritFetchRefsCheckbox");'
		+ 'if(c===null)throw new Error("settingsGerritFetchRefsCheckbox missing");'
		+ 'if(c.checked!==target)c.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'var d=document.querySelector(".dialog");'
		+ 'if(d!==null){var a=document.getElementById("dialogAction");if(a!==null)a.click();}'
		+ 'var c2=document.getElementById("settingsGerritFetchRefsCheckbox");'
		+ 'var row=document.querySelector(\'tr.commit[data-id="0"]\');'
		+ 'if(c2!==null&&c2.checked===target&&d===null&&row!==null)return resolve("fetch refs "+(target?"on":"off"));'
		+ 'if(++n>200)return reject(new Error("the fetch-refs toggle never settled"));'
		+ 'setTimeout(t,100);};t();});})()'
});

/** A UI step that snapshots the "Fetch Gerrit change refs" checkbox state into window.__ggGerritWasOn (the run must return the repository to it). */
export const GERRIT_FETCH_REFS_SNAPSHOT_STEP: UiStep = {
	op: 'eval',
	expr: '(function(){var c=document.getElementById("settingsGerritFetchRefsCheckbox");if(c===null)throw new Error("settingsGerritFetchRefsCheckbox missing");window.__ggGerritWasOn=c.checked;return c.checked?"on":"off";})()'
};

/**
 * A UI step that flips the Gerrit status-filter checkbox `id` to `target` (a JS expression) and
 * resolves once the debounced reload (applyGerritFilterChange, 120 ms) settled: the checkbox
 * shows the target state and the first row is rendered again.
 */
export const gerritStatusFilterFlipStep = (id: string, target: string): UiStep => ({
	op: 'eval',
	expr: '(function(){var target=' + target + ';var c=document.getElementById(' + JSON.stringify(id) + ');'
		+ 'if(c===null)throw new Error("' + id + ' missing");'
		+ 'if(c.checked!==target)c.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'var c2=document.getElementById(' + JSON.stringify(id) + ');'
		+ 'var row=document.querySelector(\'tr.commit[data-id="0"]\');'
		+ 'if(c2!==null&&c2.checked===target&&row!==null)return resolve("' + id + '"+(target?" on":" off"));'
		+ 'if(++n>200)return reject(new Error("the status-filter toggle never settled"));'
		+ 'setTimeout(t,100);};t();});})()'
});

/**
 * Assertions every dialog-opening flow makes once its modal is up: exactly ONE dialog is visible,
 * it renders a sane box (CSS px; skipped where no layout engine exists, e.g. the jsdom harness),
 * and it offers a labelled action. Either button counts: form dialogs label their primary, while
 * the action-running overlay offers only its secondary "Dismiss" — a dialog with NO labelled
 * action is a broken render. Entries that know their action label additionally assert its exact
 * text (both interface languages) right after these.
 */
export const DIALOG_ASSERT_STEPS: readonly UiStep[] = [
	{ op: 'expectCount', selector: '.dialog', min: 1, max: 1 },
	// The box bounds are absolute because the stylesheet's are: the dialog's content is capped at
	// 460px, so every dialog renders 120px (the short action-running overlay) to ~470px (a form)
	// at ANY window size. The minW fits that overlay, a content-sized dialog whose whole content
	// is one short "Pushing Tag ..." line plus the Dismiss button (~150px).
	{ op: 'expectSize', selector: '.dialog', minW: 120, maxW: 620, minH: 50, maxH: 1000 },
	{ op: 'eval', expr: '(function(){var a=document.getElementById("dialogAction");var s=document.getElementById("dialogSecondaryAction");var t=(a===null?"":a.textContent.trim())+"|"+(s===null?"":s.textContent.trim());if(t==="|")throw new Error("the dialog offers no labelled action");return t;})()' }
];

/**
 * UI steps that clear the file path filter a `git-graph-rs.filterByFile` command set: the Filter
 * dialog's secondary action reloads the unfiltered graph. Without this every later entry would
 * run against a graph filtered to a single file (no branch labels, tags or stashes render), so
 * every filterByFile command entry runs these steps after its expected response arrived.
 */
export const CLEAR_FILTER_STEPS: readonly UiStep[] = [
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
export const controlSizeStep = (selector: string): UiStep => ({ op: 'expectSize', selector, minW: 14, maxW: 72, minH: 14, maxH: 44 });

/**
 * The size the control-bar dropdowns' value displays render at: unlike the 24x24 icon buttons
 * `controlSizeStep` bounds, a dropdown's value box is a select control whose width the stylesheet
 * caps in VW UNITS (main.css: max-width 12vw, 16vw in the single-repository control bar) — it is
 * content-sized up to that cap, so on a wide window it legitimately renders 150px+ and absolute
 * bounds would flake. The bounds are therefore viewport-relative: at most 16.5vw (the 16vw cap
 * plus sub-pixel slack), at least 3vw (well under the smallest real value box, so only a genuinely
 * collapsed/empty render can trip it). Height stays absolute — the stylesheet draws it 26px tall.
 */
export const dropdownValueSizeStep = (selector: string): UiStep => ({ op: 'expectSize', selector, minWVw: 3, maxWVw: 16.5, minH: 16, maxH: 44 });

/**
 * Row-level assertions for the {{commit}} target, run once its row is rendered (windowed rendering
 * keeps only viewport rows in the DOM, so the scroll steps come first): the row's height matches
 * the stylesheet's row height (24px line-height, tolerant), and the description cell shows the
 * commit's OWN subject — the view's text held against the repository's data, not just any text.
 */
export const ROW_ASSERT_STEPS: readonly UiStep[] = [
	{ op: 'expectSize', selector: 'tr.commit[data-hash="{{commit}}"]', minH: 16, maxH: 44 },
	{ op: 'expectText', selector: 'tr.commit[data-hash="{{commit}}"] .description span.text', contains: '{{commitSubject}}' }
];

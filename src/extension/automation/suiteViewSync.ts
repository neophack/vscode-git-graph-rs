import { tabGroups } from '../platform/vscodeCompat';
import { automationOpenTabs, automationTabKey } from './hostBridge';
import { AutomationServer } from './server';

/**
 * The suite's view and surface hygiene: between actions and phases the runner brings the editor
 * back to a clean state, so one action's leftovers never poison the next. Two halves:
 *   - surface cleanup — editor tabs and terminals an action opened are closed again;
 *   - page sync — the page's widgets are closed, and after a fixture generation or reseed the
 *     rendered page is reloaded onto the repository's new state, all driven through the view's
 *     own controls via the engine's eval (never behind its back).
 */

/** The Git Graph view's webview panel type — the one tab the cleanup must never close. */
const GIT_GRAPH_VIEW_TYPE = 'git-graph-rs';

/** Tab snapshot helpers shared with the automation engine ({@see automationTabKey}). */
const tabKey = automationTabKey;
const openTabs = automationOpenTabs;

/**
 * Close every editor tab that appeared while the action ran (diff views, compare pages, opened
 * files, the settings page, …) and dispose terminals it created. Tabs that existed before and
 * the Git Graph view itself (which the runner may have re-opened) are left alone, so the user's
 * own editors are never touched. The live editor terminals are read through `currentTerminals`
 * — the caller's vscode seam, keeping this module free of a direct vscode import.
 */
export async function cleanupActionSurfaces(
	beforeTabs: ReadonlySet<string>,
	beforeTerminals: ReadonlySet<unknown>,
	currentTerminals: () => readonly unknown[]
): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 150)); // let late-opening surfaces appear
	const groups = tabGroups();
	const closeTab = groups === null ? undefined : groups.close;
	if (typeof closeTab === 'function') {
		for (const tab of openTabs()) {
			if (tab.input !== undefined && tab.input.viewType === GIT_GRAPH_VIEW_TYPE) continue;
			if (beforeTabs.has(tabKey(tab))) continue;
			try { await closeTab(tab, true); } catch (_) { /* the tab is already gone */ }
		}
	}
	for (const terminal of currentTerminals()) {
		if (beforeTerminals.has(terminal)) continue;
		const dispose = (terminal as { dispose?: () => void }).dispose;
		if (typeof dispose === 'function') {
			try { dispose.call(terminal); } catch (_) { /* already disposed */ }
		}
	}
}

/**
 * Close any find / settings / reflog / worktree widget an action left open in the page. Every
 * catalogued action that opens one of these already closes it as the last step of its own `ui`
 * path — but the in-page shim aborts its whole step batch at the first failure, so an action that
 * fails or times out *after* opening one (a `waitFor` that never resolves, an unexpectedly absent
 * row, ...) skips its own closing step and leaves the widget open, where it would otherwise
 * occlude selectors or steal focus in every action that runs after it. Idempotent — a widget the
 * action already closed itself is left alone — and best-effort: no active view (between
 * repositories) is not fatal.
 */
export async function closeLeakedWidgets(server: AutomationServer): Promise<void> {
	const expr = '(function(){'
		+ 'var closed=[];'
		+ 'function closeIfActive(activeSelector,closeButtonId){'
		+ 'if(document.querySelector(activeSelector)!==null){'
		+ 'var btn=document.getElementById(closeButtonId);'
		+ 'if(btn!==null){btn.click();closed.push(closeButtonId);}'
		+ '}'
		+ '}'
		+ 'closeIfActive(".findWidget.active","findClose");'
		+ 'closeIfActive("#settingsWidget.active","settingsClose");'
		+ 'closeIfActive("#reflogWidget.active","reflogClose");'
		+ 'closeIfActive("#worktreeWidget.active","worktreeClose");'
		+ 'return closed;'
		+ '})()';
	try {
		await server.eval({ expr });
	} catch (_) {
		// No page to evaluate against right now (e.g. the view is between repositories) - nothing to clean up.
	}
}

/**
 * After the empty-repository fixture generation, bring the loaded view onto the generated
 * repository. The page still shows the repository as it loaded it (empty), and loadRepos skips a
 * repository it is already showing, so the reload is driven through the view's own controls
 * instead of racing the 5 s background change poll:
 *   1. click Refresh and wait for the first commit row (loadRepoInfo + loadCommits landed);
 *   2. open and close the Settings widget — the UI path that re-requests the repository config
 *      (the refresh flow never does) — and wait for the authors dropdown to offer a real author,
 *      so the suite's first action (author-dropdown) has a target to pick.
 */
export async function reloadViewAfterGeneration(server: AutomationServer): Promise<void> {
	const refreshExpr = '(function(){'
		+ 'var b=document.getElementById("refreshBtn");'
		+ 'if(b===null)throw new Error("refresh button missing");'
		// The generation and the reload race the host's watcher/poll-driven soft refreshes: a
		// click while one is in flight JOINS that cycle, whose loadRepoInfo/loadCommits responses
		// can be invalidated by the next 'refresh' push of the still-churning repository. Wait for
		// the button to be IDLE first (no cycle in progress, no painted snapshot pending), so the
		// click starts a clean cycle whose responses are the ones this wait observes.
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'if(b.className.split(/\\s+/).indexOf("refreshing")!==-1){'
		+ 'if(++n>250)return reject(new Error("a refresh cycle never finished before the reload could start"));'
		+ 'return setTimeout(t,100);}'
		+ 'b.click();return resolve("clicked");};t();});})()'
		+ '.then(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'if(document.querySelector(\'tr.commit[data-id="0"]\')!==null)return resolve("reloaded");'
		+ 'if(++n>250)return reject(new Error("the view never rendered the generated commits"));'
		+ 'setTimeout(t,100);};t();});})';
	const configExpr = '(function(){'
		+ 'var sb=document.getElementById("settingsBtn");'
		+ 'if(sb===null)throw new Error("settings button missing");'
		+ 'sb.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'var w=document.getElementById("settingsWidget");'
		+ 'var active=w!==null&&w.className.split(/\\s+/).indexOf("active")!==-1;'
		+ 'var authors=document.querySelectorAll("#authorDropdown .dropdownOption").length>1;'
		+ 'if(active&&authors){'
		+ 'var cb=document.getElementById("settingsClose");'
		+ 'if(cb!==null)cb.click();'
		+ 'return resolve("config reloaded");}'
		+ 'if(++n>250){'
		+ 'var opts=document.querySelectorAll("#authorDropdown .dropdownOption").length;'
		+ 'var loading=w!==null&&w.className.split(/\\s+/).indexOf("loading")!==-1;'
		+ 'var hasOrigin=w!==null&&w.innerHTML.indexOf(">origin<")!==-1;'
		+ 'return reject(new Error("the generated repository config never loaded'
		// The page state at the moment the wait gave up: whether the widget opened at all, a
		// config request still in flight, how many options the dropdown holds, and whether the
		// rendered settings content knows the generated remote (fresh config) or not (the
		// pre-generation config is still what the page holds).
		+ ' [widget "+(active?"open":"closed")'
		+ '+(loading?", config request in flight":", idle")'
		+ '+"; author dropdown options: "+opts'
		+ '+"; settings show remote origin: "+(hasOrigin?"yes":"no")+"]"));}'
		+ 'setTimeout(t,100);};t();});})()';
	for (const [what, expr] of [['view reload', refreshExpr], ['config reload', configExpr]] as const) {
		const outcome = await server.eval({ expr });
		if (!outcome.ok) throw new Error('post-generation ' + what + ' failed: ' + (outcome.error ?? 'eval failed'));
	}
}

/**
 * Re-sync the rendered page with the repository after a reseed. Every reseed rebuilds the seeded
 * volatile state, and those commits (the stashes, the local-ahead commit) carry fresh hashes each
 * time; the page still lists its pre-reseed commits — the view's cache has no notion of mutations
 * made behind its back — while an action's placeholders resolve against the engine's live state
 * (buildContext's hard probes). Until a refresh lands the two disagree, and the next ui action
 * fails its very first step ("row never rendered" for a commit the engine picked but the page has
 * already forgotten). The Refresh control is clicked and the wait is on the engine's own newest
 * commit appearing as a rendered row — that hash only exists after the reseed, a positive signal
 * that the fresh page arrived rather than just that some page rendered.
 */
export async function syncViewAfterReseed(server: AutomationServer, repo: string): Promise<void> {
	const commits = await server.queryCommits(repo, 1);
	const newest = commits.length > 0 ? String(commits[0].hash) : '';
	if (newest === '') return; // an empty repository has nothing to wait for
	const expr = '(function(){'
		+ 'var b=document.getElementById("refreshBtn");'
		+ 'if(b===null)throw new Error("refresh button missing");'
		+ 'b.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		// The hard refresh anchors the rebuild on the commit the view was reading (the
		// pre-collapse anchor): after a read phase that scrolled deep (Load More Commits), the
		// reloaded list renders back around that DEEP position and the newest row never enters
		// the windowed DOM. The wait needs the TOP of the list, so every tick pins the scroll
		// there — the scroll event re-renders the window around row 0, and the tick that lands
		// after the anchor's own re-application wins (setting scrollTop is idempotent).
		+ 'var v=document.getElementById("view");if(v!==null&&v.scrollTop!==0)v.scrollTop=0;'
		+ 'if(document.querySelector(\'tr.commit[data-hash="' + newest + '"]\')!==null)return resolve("reloaded");'
		+ 'if(++n>250)return reject(new Error("the view never rendered the reseeded repository"));'
		+ 'setTimeout(t,100);};t();});})()';
	const outcome = await server.eval({ expr });
	if (!outcome.ok) throw new Error('post-reseed view reload failed: ' + (outcome.error ?? 'eval failed'));
}

/**
 * Turn the suite-canonical load options (Show Tags, Show Stashes, Show Remote Branches) back on
 * when a previous run left one off. The catalog's toggle actions flip per-repo overrides through
 * the real controls, and a run that ends mid-flip — or a one-way toggle from an older catalog —
 * leaves the override stored OFF in the workspace state, where it silently outlives the run: the
 * next run's engine probes still see tags and stashes (queryCommits forces the options on) while
 * the rendered page omits them, and every tag/stash-row action fails "row never rendered" on a
 * name the probe resolved. The ensure drives the same controls a user would and is a no-op when
 * everything is already on; it never fails the suite — a problem here surfaces as (at most)
 * failed actions the report shows anyway.
 */
export async function ensureSuiteViewOptions(server: AutomationServer, logger: { logError(message: string): void }): Promise<void> {
	// The Show Remote Branches checkbox lives in the control bar (always in the DOM); the Show
	// Tags / Show Stashes checkboxes are built with the Settings widget, which must be opened.
	const remoteExpr = '(function(){'
		+ 'var c=document.getElementById("showRemoteBranchesCheckbox");'
		+ 'if(c===null)throw new Error("show remote branches checkbox missing");'
		+ 'var flip=!c.checked;if(flip)c.click();'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'if(document.querySelector(\'tr.commit[data-id="0"]\')!==null)return resolve(flip?"turned on":"already on");'
		+ 'if(++n>250)return reject(new Error("the view never re-rendered"));setTimeout(t,100);};t();});})()';
	const settingsExpr = '(function(){'
		+ 'var w=document.getElementById("settingsWidget");'
		+ 'var active=w!==null&&w.className.split(/\\s+/).indexOf("active")!==-1;'
		+ 'if(!active){var sb=document.getElementById("settingsBtn");'
		+ 'if(sb===null)throw new Error("settings button missing");sb.click();}'
		+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){'
		+ 'var w2=document.getElementById("settingsWidget");'
		+ 'var a=w2!==null&&w2.className.split(/\\s+/).indexOf("active")!==-1;'
		+ 'if(!a){if(++n>100)return reject(new Error("the settings widget never opened"));return setTimeout(t,100);}'
		+ 'var flipped=[];'
		+ '["settingsShowTagsCheckbox","settingsShowStashesCheckbox"].forEach(function(id){'
		+ 'var c=document.getElementById(id);'
		+ 'if(c===null)throw new Error(id+" missing");'
		+ 'if(!c.checked){c.click();flipped.push(id);}});'
		+ 'setTimeout(function(){var m=0;var u=function(){'
		+ 'if(document.querySelector(\'tr.commit[data-id="0"]\')!==null){'
		+ 'var cb=document.getElementById("settingsClose");if(cb!==null)cb.click();'
		+ 'return resolve(flipped.length>0?"turned on: "+flipped.join(", "):"already on");}'
		+ 'if(++m>250)return reject(new Error("the view never re-rendered"));setTimeout(u,100);};u();'
		+ '},flipped.length>0?300:0);};t();});})()';
	try {
		for (const [what, expr] of [['show remote branches', remoteExpr], ['show tags / show stashes', settingsExpr]] as const) {
			const outcome = await server.eval({ expr });
			if (!outcome.ok) throw new Error('ensuring ' + what + ' failed: ' + (outcome.error ?? 'eval failed'));
		}
	} catch (error) {
		logger.logError('view-option ensure failed: ' + (error instanceof Error ? error.message : String(error)));
	}
}

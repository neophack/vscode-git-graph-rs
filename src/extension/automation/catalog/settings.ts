/**
 * The settings actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { DISMISS_ERROR_DIALOG_STEP, restoreSettingsCheckboxStep, gerritFetchRefsFlipStep, GERRIT_FETCH_REFS_SNAPSHOT_STEP, gerritStatusFilterFlipStep, DIALOG_ASSERT_STEPS } from './helpers';

export const SETTINGS_ACTIONS: readonly AutomationAction[] = [
	// NOTE: "Toggle Markdown / Plain Text" has no entry: #cdvMarkdownToggle only renders while a
	// Markdown-looking file is open in the Commit Details View, and the fixture's history (and the
	// context commit) contains none — so the control cannot be reached in a catalog run. Markdown
	// rendering itself has unit coverage.

	/* ---------- Settings widget ---------- */
	{
		id: 'settings/add-author',
		title: 'Add Author',
		group: 'settings',
		tags: ['settings', 'dialog'],
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
		tags: ['settings', 'dialog'],
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
		tags: ['settings', 'dialog'],
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
		tags: ['settings', 'dialog'],
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
		tags: ['settings', 'dialog'],
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
		tags: ['settings'],
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
		tags: ['settings'],
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
		tags: ['settings'],
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
		tags: ['settings'],
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
		tags: ['settings'],
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
		tags: ['settings'],
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
	{
		id: 'settings/gerrit-fetch-refs',
		title: 'Fetch Gerrit change refs',
		group: 'settings',
		tags: ['settings', 'gerrit'],
		// Mutable despite its read-only suite neighbours: the flip's disable direction deletes the
		// repository's fetched Gerrit change refs (behind a confirmation), which must never run
		// against a user repository — a failed re-fetch (offline) would leave Gerrit disabled.
		mutable: true,
		// The checkbox drives gerritSetFetchRefs (enabling marks the repository's Gerrit data
		// stale, disabling deletes the fetched change refs behind a confirmation) and the response
		// reloads the view either way. The flow snapshots the state, flips to the other side
		// (driving BOTH directions — the plain enable and the confirmed disable), then restores
		// the snapshot: the run leaves the repository exactly as it found it, whatever it was.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsGerritFetchRefsCheckbox' },
			GERRIT_FETCH_REFS_SNAPSHOT_STEP,
			gerritFetchRefsFlipStep('!window.__ggGerritWasOn'),
			gerritFetchRefsFlipStep('window.__ggGerritWasOn'),
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['gerritSetFetchRefs', 'loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/gerrit-status-filter',
		title: 'Gerrit status filter (Open)',
		group: 'settings',
		tags: ['settings', 'gerrit'],
		mutable: true,
		// The four status-filter checkboxes and the fetch-limit row render only while "Fetch
		// Gerrit change refs" is ON, so the flow enables it as a preamble (a no-op click when
		// already on) and restores the snapshot at the end. The toggle itself persists via a
		// silent setRepoState and reloads the graph (applyGerritFilterChange, debounced 120 ms);
		// the New/Open checkbox is flipped OFF and back ON — with the checkbox left off, change
		// refs of that status would vanish from every later run's graph.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsGerritFetchRefsCheckbox' },
			GERRIT_FETCH_REFS_SNAPSHOT_STEP,
			gerritFetchRefsFlipStep('true'),
			{ op: 'skipIfAbsent', selector: '#settingsGerritStatusNewCheckbox' },
			{
				op: 'eval',
				expr: '(function(){var c=document.getElementById("settingsGerritStatusNewCheckbox");if(c===null)throw new Error("settingsGerritStatusNewCheckbox missing");window.__ggStatusWasChecked=c.checked;return c.checked?"on":"off";})()'
			},
			gerritStatusFilterFlipStep('settingsGerritStatusNewCheckbox', '!window.__ggStatusWasChecked'),
			gerritStatusFilterFlipStep('settingsGerritStatusNewCheckbox', 'window.__ggStatusWasChecked'),
			gerritFetchRefsFlipStep('window.__ggGerritWasOn'),
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/gerrit-fetch-limit',
		title: 'Gerrit fetch limit',
		group: 'settings',
		tags: ['settings', 'dialog', 'gerrit'],
		mutable: true,
		// Same fetch-refs preamble/epilogue as the status-filter entry (the row only renders while
		// Gerrit fetching is on). The pencil opens a form whose input is prefilled with the current
		// override (empty when following the Extension Setting); the flow snapshots that original
		// value, sets 200, saves (persisted via a silent setRepoState, then refresh(false) reloads
		// the graph under the new limit) and restores the snapshot — an empty restore clears the
		// override back to the setting default, so the run cannot leave a limit behind.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'waitFor', selector: '#settingsGerritFetchRefsCheckbox' },
			GERRIT_FETCH_REFS_SNAPSHOT_STEP,
			gerritFetchRefsFlipStep('true'),
			{ op: 'skipIfAbsent', selector: '#editGerritFetchLimit' },
			{ op: 'click', selector: '#editGerritFetchLimit' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{
				op: 'eval',
				expr: '(function(){var i=document.getElementById("dialogInput0");if(i===null)throw new Error("fetch limit dialog input missing");window.__ggGerritLimitOrig=i.value;i.value="200";i.dispatchEvent(new Event("input",{bubbles:true}));return "set 200";})()'
			},
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{ op: 'click', selector: '#editGerritFetchLimit' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{
				op: 'eval',
				expr: '(function(){var i=document.getElementById("dialogInput0");if(i===null)throw new Error("fetch limit dialog input missing");i.value=window.__ggGerritLimitOrig;i.dispatchEvent(new Event("input",{bubbles:true}));return "restored "+(window.__ggGerritLimitOrig===""?"(default)":window.__ggGerritLimitOrig);})()'
			},
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			gerritFetchRefsFlipStep('window.__ggGerritWasOn'),
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/rename-repo',
		title: 'Edit / Delete Repository Name',
		group: 'settings',
		tags: ['settings', 'dialog', 'dropdown'],
		mutable: false,
		// The name dialog saves repo state 'name' through a silent setRepoState and re-renders the
		// Repos dropdown — no host traffic. The round-trip covers BOTH controls state-independently:
		// the current dropdown value and the dialog's placeholder (the folder name) are captured,
		// the repository is renamed to a literal, the rename is verified on the dropdown, and the
		// original is restored through the control the state dictates — deleteRepoName (rendered
		// once a name exists) when the original was the default, editRepoName with the captured
		// name when it was explicit — so a user's own display name survives the read suite.
		ui: [
			{
				op: 'eval',
				expr: '(function(){var v=document.querySelector("#repoDropdown .dropdownCurrentValue");if(v===null)throw new Error("repository dropdown value missing");window.__ggNameOrig=v.textContent.trim();return window.__ggNameOrig;})()'
			},
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#editRepoName' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{
				op: 'eval',
				expr: '(function(){var i=document.getElementById("dialogInput0");if(i===null)throw new Error("name dialog input missing");window.__ggNamePlaceholder=i.placeholder;i.value="automation-repo-name";i.dispatchEvent(new Event("input",{bubbles:true}));return "renaming";})()'
			},
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var v=document.querySelector("#repoDropdown .dropdownCurrentValue");if(v!==null&&v.textContent.trim()==="automation-repo-name")return resolve("the dropdown shows the new name");if(++n>100)return reject(new Error("the repository name never changed"));setTimeout(t,100);};t();});})()'
			},
			{
				op: 'eval',
				expr: '(function(){var orig=window.__ggNameOrig;var ph=window.__ggNamePlaceholder;var viaDelete=orig===ph;'
					+ 'return new Promise(function(resolve,reject){var n=0;var step="start";'
					+ 'var val=function(){var v=document.querySelector("#repoDropdown .dropdownCurrentValue");return v===null?"":v.textContent.trim();};'
					+ 'var act=function(){var a=document.getElementById("dialogAction");if(a!==null)a.click();return a!==null;};'
					+ 'var t=function(){try{'
					+ 'if(step==="start"){'
					+ 'if(viaDelete){var d=document.getElementById("deleteRepoName");if(d===null)throw new Error("deleteRepoName missing");d.click();step="confirm";}'
					+ 'else{var e=document.getElementById("editRepoName");if(e===null)throw new Error("editRepoName missing");e.click();step="fill";}'
					+ '}else if(step==="confirm"){'
					+ 'if(document.querySelector(".dialog")!==null){if(act())step="settle";else if(++n>100)throw new Error("the delete confirmation never offered its action");}'
					+ 'else if(++n>100)throw new Error("the delete confirmation never appeared");'
					+ '}else if(step==="fill"){'
					+ 'var i=document.getElementById("dialogInput0");'
					+ 'if(i!==null){i.value=orig;i.dispatchEvent(new Event("input",{bubbles:true}));if(act())step="settle";else throw new Error("the name dialog has no action");}'
					+ 'else if(++n>100)throw new Error("the name dialog never appeared");'
					+ '}else{'
					+ 'if(val()===orig)return resolve(viaDelete?"cleared back to "+orig:"renamed back to "+orig);'
					+ 'if(++n>150)throw new Error("the repository name never returned to "+orig);'
					+ '}'
					+ '}catch(err){return reject(err);}setTimeout(t,100);};t();});})()'
			},
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'settings/initial-branches-dialog',
		title: 'Edit Initial Branches (unchanged save)',
		group: 'settings',
		tags: ['settings', 'dialog'],
		mutable: false,
		// The dialog's branch picker is a custom multi-select the shim cannot drive, so the flow
		// opens the form and saves it UNCHANGED: the widget's no-change guard then writes nothing
		// (and requests nothing) — the dialog round-trip is the coverage, the user's initial
		// branches are preserved exactly.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#editInitialBranches' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'settings/issue-linking',
		title: 'Add / Edit / Remove Issue Linking',
		group: 'settings',
		tags: ['settings', 'dialog'],
		mutable: false,
		// State-independent round-trip over the section's one button pair (editIssueLinking
		// renders as Add when nothing is configured, as Edit + Remove otherwise): on an
		// unconfigured repository a literal config is added (a valid group regex and a $1 URL —
		// the dialog's own validation — repo-scoped through the unchecked "use globally") and then
		// removed again through the confirmation, leaving nothing behind; on a configured one the
		// Edit dialog is saved UNCHANGED (a no-op rewrite of the same values, whatever scope they
		// came from). Saving runs setIssueLinkingConfig → refresh(true), hence the responses.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{
				op: 'eval',
				expr: '(function(){var rm=document.getElementById("removeIssueLinking");window.__ggIssueConfigured=rm!==null;var ed=document.getElementById("editIssueLinking");if(ed===null)throw new Error("editIssueLinking missing");ed.click();return rm!==null?"editing existing configuration":"adding new configuration";})()'
			},
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{
				op: 'eval',
				expr: '(function(){if(window.__ggIssueConfigured)return "no-op edit";var r=document.getElementById("dialogInput0");var u=document.getElementById("dialogInput1");if(r===null||u===null)throw new Error("issue linking dialog inputs missing");r.value="(\\\\d+)";r.dispatchEvent(new Event("input",{bubbles:true}));u.value="https://example.com/issues/$1";u.dispatchEvent(new Event("input",{bubbles:true}));return "filled";})()'
			},
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var d=document.querySelector(".dialog");var row=document.querySelector(\'tr.commit[data-id="0"]\');if(d===null&&row!==null)return resolve("saved");if(++n>150)return reject(new Error("the issue linking save never settled"));setTimeout(t,100);};t();});})()'
			},
			{
				op: 'eval',
				expr: '(function(){if(window.__ggIssueConfigured)return "kept the existing configuration";'
					+ 'return new Promise(function(resolve,reject){var n=0;var step="start";'
					+ 'var t=function(){try{'
					+ 'if(step==="start"){var rm=document.getElementById("removeIssueLinking");if(rm!==null){rm.click();step="confirm";}else if(++n>100)throw new Error("removeIssueLinking never appeared after saving");}'
					+ 'else if(step==="confirm"){var a=document.getElementById("dialogAction");if(document.querySelector(".dialog")!==null&&a!==null){a.click();step="settle";}else if(++n>100)throw new Error("the remove confirmation never appeared");}'
					+ 'else{var d=document.querySelector(".dialog");var row=document.querySelector(\'tr.commit[data-id="0"]\');if(d===null&&row!==null)return resolve("removed again");if(++n>150)throw new Error("the issue linking removal never settled");}'
					+ '}catch(err){return reject(err);}setTimeout(t,100);};t();});})()'
			},
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'settings/pull-request-dialog',
		title: 'Configure Pull Request Integration (open and cancel)',
		group: 'settings',
		tags: ['settings', 'dialog'],
		mutable: false,
		// The integration wizard is a multi-step form of custom selects the shim cannot drive, so
		// the flow verifies the entry point instead: the button (Add or Edit — the id is shared)
		// opens the wizard's first dialog, a sane form renders, and Cancel leaves every value as
		// it was. The wizard's deeper steps stay manual coverage.
		ui: [
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#editPullRequestIntegration' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogSecondaryAction' },
			{ op: 'waitForGone', selector: '.dialog' },
			{ op: 'click', selector: '#settingsClose' },
			{ op: 'waitForGone', selector: '#settingsWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	}
];

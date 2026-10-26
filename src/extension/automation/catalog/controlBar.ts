/**
 * The control-bar actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { dropdownValueIs, SHOW_ALL_RESTORE_STEPS, DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS, controlSizeStep, dropdownValueSizeStep } from './helpers';

export const CONTROL_BAR_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Control bar ---------- */
	{
		id: 'control-bar/author-dropdown',
		title: 'Authors Dropdown',
		group: 'control-bar',
		tags: ['control-bar', 'dropdown'],
		mutable: false,
		// The dropdown lists the authors recorded in the repository config — repository data a
		// catalog entry cannot know, so the flow is generic: it captures the current selection,
		// picks any OTHER option (the selection change reloads the commits; the dropdown's change
		// callback skips the repo-info request, so no loadRepoInfo is expected) and restores the
		// captured selection afterwards, leaving later runs the initial state.
		ui: [
			dropdownValueSizeStep('#authorDropdown .dropdownCurrentValue'),
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
		tags: ['control-bar', 'dropdown'],
		mutable: false,
		// Selecting one branch (from the initial "Show All") reloads the commits only (the
		// dropdown's change callback skips the repo-info request), so no loadRepoInfo is expected.
		// The dropdown is reset to "Show All" afterwards: leaving the graph filtered to a single
		// branch would strand every later entry's targets (rows, ref labels) outside the filtered
		// graph — the branch tip may be old history.
		ui: [
			dropdownValueSizeStep('#branchDropdown .dropdownCurrentValue'),
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
		tags: ['control-bar', 'dropdown'],
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
			dropdownValueSizeStep('#repoDropdown .dropdownCurrentValue'),
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
		tags: ['control-bar'],
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
		tags: ['control-bar'],
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
		tags: ['control-bar', 'dialog', 'gerrit'],
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
		tags: ['control-bar'],
		mutable: false,
		ui: [
			controlSizeStep('#findBtn'),
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'expectCount', selector: '.findWidget.active', min: 1, max: 1 },
			// findWidget.css: 34px tall, content-sized and vw-capped — the width bounds are
			// viewport-relative so they hold at any window size.
			{ op: 'expectSize', selector: '.findWidget', minWVw: 7, maxWVw: 95, minH: 28, maxH: 48 }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'control-bar/load-more-commits',
		title: 'Load More Commits',
		group: 'control-bar',
		tags: ['control-bar', 'gerrit'],
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
		tags: ['control-bar', 'gerrit'],
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
		tags: ['control-bar'],
		mutable: false,
		// Opening the widget also re-requests the repository config; the flow closes the widget
		// again so later runs start from a clean surface.
		ui: [
			controlSizeStep('#settingsBtn'),
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'expectCount', selector: '#settingsWidget.active', min: 1, max: 1 },
			// settingsWidget.css draws the widget at a fixed 840px shrunk by max-width:calc(100vw
			// - 56px) on narrow windows: the floor is viewport-relative so it holds at any width,
			// while the fixed 840px makes an absolute ceiling valid at every window size.
			{ op: 'expectSize', selector: '#settingsWidget', minWVw: 12, maxW: 900, minH: 100, maxH: 2400 },
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
		tags: ['control-bar'],
		mutable: true,
		// Toggling persists showRemoteBranchesV2 via a setRepoState the host answers silently,
		// then hard-refreshes. The flow toggles OFF and back ON: with the toggle left off the
		// host omits remote-tracking branches from the branch list, and every later entry that
		// needs a remote branch (the whole menu-remote-branch group) would break. No request
		// path: the setRepoState payload is the whole GitRepoState, which only the live view
		// can assemble.
		ui: [
			// The native input is hidden to 0x0 by the custom-checkbox CSS (main.css sizes all
			// inputs[type=checkbox] to nothing and draws the 15x15 .customCheckbox sibling instead),
			// so the VISIBLE box is what gets the size assertion; the clicks below still go to the
			// input — element.click() needs no rendered box, and it carries the checked state.
			controlSizeStep('#showRemoteBranchesControl > .customCheckbox'),
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
		tags: ['control-bar'],
		mutable: false,
		ui: [
			controlSizeStep('#statisticsBtn'),
			{ op: 'click', selector: '#statisticsBtn' },
			{ op: 'waitFor', selector: '#statisticsWidget.active' },
			{ op: 'expectCount', selector: '#statisticsWidget.active', min: 1, max: 1 },
			// statisticsView.css draws the widget at a fixed 560px shrunk by max-width:calc(100vw
			// - 56px) on narrow windows: viewport-relative floor, fixed-width absolute ceiling.
			{ op: 'expectSize', selector: '#statisticsWidget', minWVw: 12, maxW: 620, minH: 80, maxH: 2400 },
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
		tags: ['control-bar', 'dialog'],
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
	}
];

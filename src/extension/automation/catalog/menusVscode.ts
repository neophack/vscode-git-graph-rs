/**
 * The menu-vscode actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { CLEAR_FILTER_STEPS } from './helpers';

export const MENUS_VSCODE_ACTIONS: readonly AutomationAction[] = [
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
		tags: ['menu-vscode', 'command'],
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
		tags: ['menu-vscode', 'command'],
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
		tags: ['menu-vscode', 'command'],
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
		tags: ['menu-vscode', 'command'],
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
		tags: ['menu-vscode', 'command'],
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
		tags: ['menu-vscode', 'command'],
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
		tags: ['menu-vscode', 'command', 'gerrit'],
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
		tags: ['menu-vscode', 'command', 'gerrit'],
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
		tags: ['menu-vscode', 'command'],
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
		tags: ['menu-vscode', 'command'],
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
	{
		id: 'menu-vscode/palette-fetch',
		title: 'Fetch from Remote(s) (command palette)',
		group: 'menu-vscode',
		tags: ['menu-vscode', 'command'],
		mutable: true,
		requires: ['remote'],
		// The palette's Fetch command takes NO argument: with several repositories known it
		// shows a quick pick — the dialog auto-answer takes its first item, which the command
		// has unshifted to the front as the last active repository (the run's own) — and then
		// loads the Git Graph view on it with runCommandOnLoad 'fetch', so the page runs the
		// same fetch request the control-bar button does once it has loaded. The quick-pick
		// chain is not awaited by the command handler, so the run completes on the fetch
		// RESPONSE, not on the handler's return; the post-step barrier then waits for the view.
		vscodeCommand: { command: 'git-graph-rs.fetch' },
		uiAfter: [{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }],
		expect: { responses: ['fetch'] }
	},
	{
		id: 'menu-vscode/palette-clear-avatar-cache',
		title: 'Clear Avatar Cache (command palette)',
		group: 'menu-vscode',
		tags: ['menu-vscode', 'command'],
		mutable: false,
		// The command's whole observable outcome is a fully localized notification ("Avatar
		// cache cleared") — no language-invariant fragment exists, so its presence is pinned
		// (expectAnyNotification). The handler does not await the notification's .then chain,
		// so the post-step barrier gives it time to arrive before the assertion runs.
		vscodeCommand: { command: 'git-graph-rs.clearAvatarCache' },
		uiAfter: [{ op: 'eval', expr: '(function(){return new Promise(function(resolve){setTimeout(resolve,750);});})()' }],
		expectAnyNotification: true,
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'menu-vscode/palette-version',
		title: 'About Git Graph RS (command palette)',
		group: 'menu-vscode',
		tags: ['menu-vscode', 'command'],
		mutable: false,
		// The command raises a MODAL information message (auto-answered with its Copy button),
		// and the modal is shown synchronously before the handler returns, so expectModal is
		// deterministic: the command must reach its About dialog.
		vscodeCommand: { command: 'git-graph-rs.version' },
		expectModal: true,
		noHostTraffic: true,
		expect: { responses: [] }
	}
];

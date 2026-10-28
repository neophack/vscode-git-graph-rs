/**
 * The host actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { DISMISS_ERROR_DIALOG_STEP } from './helpers';

export const HOST_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Host-only requests ---------- */
	{
		id: 'host/copy-to-clipboard',
		title: 'Copy Commit Hash to Clipboard',
		group: 'host',
		tags: ['host'],
		mutable: false,
		request: [{ command: 'copyToClipboard', type: 'Commit Hash', data: '{{commit}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'host/open-extension-settings',
		title: 'Open Extension Settings',
		group: 'host',
		tags: ['host'],
		mutable: false,
		request: [{ command: 'openExtensionSettings' }],
		expect: { responses: ['openExtensionSettings'] }
	},
	{
		id: 'host/open-file',
		title: 'Open File',
		group: 'host',
		tags: ['host'],
		mutable: false,
		requires: ['file'],
		// Opens the context commit's file, as the Commit Details View's "Open File" does. The
		// file need not exist in the working tree at HEAD (the fixture checks it out only on
		// local-ahead — see cdv/file-open-file), so the refusal is the designed outcome, not a
		// failure: without allowErrorOn this would false-fail the read suite on any repository
		// whose context file is absent from the working tree.
		request: [{ command: 'openFile', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['openFile'] },
		allowErrorOn: ['openFile']
	},
	{
		id: 'host/open-log-file',
		title: 'Open Log File',
		group: 'host',
		tags: ['host'],
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
		tags: ['host'],
		mutable: false,
		// `name` is display-only; the live view passes the repository's display name.
		request: [{ command: 'openTerminal', repo: '{{repo}}', name: '{{repo}}' }],
		expect: { responses: ['openTerminal'] }
	},
	{
		id: 'host/view-scm',
		title: 'Open Source Control View',
		group: 'host',
		tags: ['host'],
		mutable: false,
		request: [{ command: 'viewScm' }],
		expect: { responses: ['viewScm'] }
	},
	{
		id: 'host/show-error-message',
		title: 'Show Error Message',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The webview's generic error surface: the message the page cannot render itself is
		// routed to the native toast through the handler context's showErrorMessage (which the
		// installed scripted port records and suppresses during automation runs). The host
		// answers nothing — the void response is the message having been raised — so the run
		// completes on the injected request alone.
		request: [{ command: 'showErrorMessage', message: 'Automation error dialog replay' }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'host/open-external-url',
		title: 'Open External URL',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The "Open URL" surface of issue links and pull requests. The replay passes a
		// SCHEME-LESS url: vscode.env.openExternal refuses it (it requires a valid scheme), so
		// the run takes the command's designed refusal — verifiable end to end without ever
		// opening the user's browser during a suite.
		request: [{ command: 'openExternalUrl', url: 'git-graph-rs-automation.invalid' }],
		expect: { responses: ['openExternalUrl'] },
		allowErrorOn: ['openExternalUrl']
	},
	{
		id: 'host/load-repos',
		title: 'Load Repositories',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The repository-list read the page sends at boot and before the Repos dropdown opens.
		// check: false skips the on-disk existence check, so the answer is the plain known set.
		request: [{ command: 'loadRepos', check: false }],
		expect: { responses: ['loadRepos'] }
	},
	{
		id: 'host/rescan-for-repos',
		title: 'Rescan Workspace for Repositories',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The rescan button of the "no repositories" state: a full workspace scan with no direct
		// answer (the host may push a fresh loadRepos, and shows its own notice when the scan
		// finds nothing — on any repository a suite runs against, it finds the run's own). The
		// run completes on the injected request; any repos push the scan triggers is recorded.
		request: [{ command: 'rescanForRepos' }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'host/load-view',
		title: 'Load View (the merged open-path read)',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The merged repoInfo + first-commits-page read the handler also serves to automation
		// replays (loading.ts's loadView comment names exactly this path). The shape mirrors the
		// refresh entry's loadCommits twin — Show All branches/authors, canonical view options —
		// and the page either applies the pushed response or drops it by refresh id; the run is
		// gated on the host's loadView answer, which is the read having run either way.
		request: [{
			command: 'loadView', repo: '{{repo}}', refreshId: 0, hard: true,
			branches: null, authors: null, maxCommits: 10000, showTags: true, showRemoteBranches: true,
			includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date',
			remotes: [], hideRemotes: [], stashes: [], filterPath: null
		}],
		expect: { responses: ['loadView'] }
	},
	{
		id: 'host/commit-bodies',
		title: 'Fetch Commit Bodies',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The lazy body read behind every expanded commit row: one hash (the context commit) and
		// a client request id the response echoes for pairing.
		request: [{ command: 'commitBodies', repo: '{{repo}}', commitHashes: ['{{commit}}'], requestId: 1 }],
		expect: { responses: ['commitBodies'] }
	},
	{
		id: 'host/commit-file-counts',
		title: 'Fetch File Change Counts',
		group: 'host',
		tags: ['host'],
		mutable: false,
		requires: ['file'],
		// The Commit Details View's progressive +N/-M line counts for one file of the context
		// commit, diffed against its first parent (from: null), as the view's settle pass sends.
		request: [{ command: 'commitFileCounts', repo: '{{repo}}', commitHash: '{{commit}}', compareWithHash: null, from: null, to: '{{commit}}', paths: ['{{file}}'] }],
		expect: { responses: ['commitFileCounts'] }
	},
	{
		id: 'host/count-commits-before',
		title: 'Count Commits Before HEAD',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The scroll-position read the view uses to restore the windowed table: how many commits
		// precede the HEAD commit under Show All branches.
		request: [{ command: 'countCommitsBefore', repo: '{{repo}}', hash: '{{head}}', branches: null, showRemoteBranches: true, includeCommitsMentionedByReflogs: false }],
		expect: { responses: ['countCommitsBefore'] }
	},
	{
		id: 'host/fetch-avatar',
		title: 'Fetch Avatar',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The avatar prefetch the page issues for a commit's author. The handler has no direct
		// answer: the image arrives later, pushed by the avatar manager's completion event (the
		// panel forwards it as a fetchAvatar message of its own) — asynchronously to this
		// request and possibly after the run window, so the run completes on the injection and
		// any push is recorded as extra evidence.
		request: [{ command: 'fetchAvatar', repo: '{{repo}}', remote: null, email: 'automation@example.com', commits: ['{{commit}}'] }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'host/fetch-pull-requests',
		title: 'Fetch Pull Requests',
		group: 'host',
		tags: ['host'],
		mutable: false,
		requires: ['remote'],
		// The pull-request integration's poll request. The response command is pullRequestStatus
		// (not the request's own name), and with the integration disabled — the fixture's and
		// the default configuration — it answers prs: null without any network access.
		request: [{ command: 'fetchPullRequest', repo: '{{repo}}' }],
		expect: { responses: ['pullRequestStatus'] }
	},
	{
		id: 'host/create-pull-request',
		title: 'Create Pull Request',
		group: 'host',
		tags: ['host'],
		mutable: false,
		// The Create Pull Request dialog's confirm action, with push: false so no branch is
		// pushed. The custom provider's template composes a scheme-less url that the external
		// opener refuses — the same designed refusal as host/open-external-url, assertable end
		// to end (the composed URL reaching the opener proves the whole dialog-to-command path)
		// without opening a browser during a suite.
		request: [{
			command: 'createPullRequest', repo: '{{repo}}', push: false,
			config: {
				provider: 1, custom: { name: 'Automation', templateUrl: 'git-graph-rs-automation.invalid' },
				hostRootUrl: 'git-graph-rs-automation.invalid', sourceRemote: 'origin',
				sourceOwner: 'automation', sourceRepo: 'fixture', destRemote: null,
				destOwner: 'automation', destRepo: 'fixture', destProjectId: '', destBranch: 'main'
			},
			sourceRemote: 'origin', sourceOwner: 'automation', sourceRepo: 'fixture', sourceBranch: 'main'
		}],
		expect: { responses: ['createPullRequest'] },
		allowErrorOn: ['createPullRequest']
	},
	{
		id: 'host/prune-remote',
		title: 'Prune Remote',
		group: 'host',
		tags: ['host'],
		mutable: true,
		requires: ['remote'],
		// The Settings widget's remote-row Prune action: `git remote prune <remote>`. On the
		// freshly reseeded fixture every remote-tracking ref is current, so the prune is a clean
		// no-op that reports no stale refs — proving the op ran without altering the fixture.
		request: [{ command: 'pruneRemote', repo: '{{repo}}', name: '{{remote}}' }],
		expect: { responses: ['pruneRemote'] }
	},
	{
		id: 'host/abort-operation',
		title: 'Abort Operation (merge)',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The conflict banner's Abort button for a merge. No merge is in progress on the
		// reseeded fixture, so `git merge --abort` answers git's "no merge to abort" refusal —
		// the designed outcome of replaying the control outside a conflict, and the proof the
		// request reached the real write chain.
		request: [{ command: 'abortOperation', repo: '{{repo}}', type: 'merge' }],
		expect: { responses: ['abortOperation'] },
		allowErrorOn: ['abortOperation']
	},
	{
		id: 'host/continue-operation',
		title: 'Continue Operation (rebase)',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The conflict banner's Continue button for a rebase. No rebase is in progress on the
		// reseeded fixture, so `git rebase --continue` answers git's "no rebase in progress"
		// refusal — the designed outcome, as above.
		request: [{ command: 'continueOperation', repo: '{{repo}}', type: 'rebase' }],
		expect: { responses: ['continueOperation'] },
		allowErrorOn: ['continueOperation']
	},
	{
		id: 'host/set-global-view-state',
		title: 'Persist the Global View State',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The page's debounced persistence write of the global view state. The replay carries
		// the schema's default values (alwaysAcceptCheckoutCommit false, no issue linking, no
		// push-tag remote-check skip) and the host answers with the write's outcome. Kept in the
		// write suite on purpose: the write lands in persisted extension state, so a real
		// repository's stored preferences must never be touched by a read-suite run.
		request: [{ command: 'setGlobalViewState', state: { alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false } }],
		expect: { responses: ['setGlobalViewState'] }
	},
	{
		id: 'host/set-workspace-view-state',
		title: 'Persist the Workspace View State',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The page's debounced persistence write of the workspace view state (the Find widget's
		// toggles), replayed with their default values. Write suite for the same reason as the
		// global-state entry: persisted state, never written against a real repository.
		request: [{ command: 'setWorkspaceViewState', state: { findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false } }],
		expect: { responses: ['setWorkspaceViewState'] }
	},
	{
		id: 'host/set-view-snapshot',
		title: 'Persist the View Snapshot',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The debounced scroll/widget snapshot the page persists for the next activation,
		// replayed with the boot-shaped snapshot of persistence.ts (the run's repository, top of
		// the table, no widgets open, no filter). The host stores it silently — no response —
		// so the run completes on the injection. Write suite: persisted state.
		request: [{
			command: 'setViewSnapshot',
			snapshot: { currentRepo: '{{repo}}', scrollTop: 0, findWidget: null, settingsWidget: null, commitPathFilter: null, compareSourceHash: null }
		}],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'host/set-interface-language',
		title: 'Set Interface Language',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The Settings widget's language dropdown: the request the page sends for the chosen
		// interface language. 'auto' is the setting's default value — the write is a semantic
		// no-op that still exercises the whole validate-and-save chain, whatever language the
		// machine currently shows. Write suite: the save lands in the user's Global settings.
		request: [{ command: 'setInterfaceLanguage', language: 'auto' }],
		expect: { responses: ['setInterfaceLanguage'] }
	},
	{
		id: 'host/edit-user-details',
		title: 'Edit User Details (local)',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The Settings widget's User Details save: an identity write into the FIXTURE clone's
		// own .git/config (location 'local' — never the machine's global Git configuration).
		// The delete-user-details twin below runs immediately after in catalog order and unsets
		// exactly these keys, returning the clone to its seeded identity-less state (which the
		// amend entry's identity-dependent outcome relies on).
		request: [{ command: 'editUserDetails', repo: '{{repo}}', name: 'Automation', email: 'automation@example.com', location: 'local', deleteLocalName: false, deleteLocalEmail: false }],
		expect: { responses: ['editUserDetails'] }
	},
	{
		id: 'host/delete-user-details',
		title: 'Delete User Details (local)',
		group: 'host',
		tags: ['host'],
		mutable: true,
		// The Settings widget's User Details delete, replayed right after host/edit-user-details:
		// both keys exist again, so the unsets succeed and the clone ends the pair in its seeded
		// identity-less state.
		request: [{ command: 'deleteUserDetails', repo: '{{repo}}', name: true, email: true, location: 'local' }],
		expect: { responses: ['deleteUserDetails'] }
	}
];

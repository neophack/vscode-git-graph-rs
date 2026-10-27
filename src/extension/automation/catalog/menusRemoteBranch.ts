/**
 * The menu-remote-branch actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, remoteBranchFilterSteps, REMOTE_BRANCH_FILTER_STEPS, SHOW_ALL_RESTORE_STEPS, DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS } from './helpers';

export const MENUS_REMOTE_BRANCH_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Remote branch context menu ---------- */
	{
		id: 'menu-remote-branch/checkout',
		title: 'Checkout Branch…',
		group: 'menu-remote-branch',
		tags: ['menu-remote-branch', 'context-menu', 'dialog', 'dropdown'],
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
		tags: ['menu-remote-branch', 'context-menu', 'dropdown'],
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
		tags: ['menu-remote-branch', 'context-menu', 'dialog', 'dropdown'],
		mutable: true,
		requires: ['remote'],
		// Confirming opens the editor's native save dialog — answered by the ScriptedUiPort the
		// suite runner installs, so the action RUNS in every mode.
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
		tags: ['menu-remote-branch', 'context-menu', 'dialog', 'dropdown'],
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
		tags: ['menu-remote-branch', 'context-menu', 'dialog', 'dropdown'],
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
		tags: ['menu-remote-branch'],
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
		tags: ['menu-remote-branch', 'dropdown'],
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
		tags: ['menu-remote-branch'],
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
		tags: ['menu-remote-branch', 'context-menu', 'dropdown'],
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
	}
];

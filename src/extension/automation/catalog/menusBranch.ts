/**
 * The menu-branch actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, PIN_SNAPSHOT_STEP, pinChipStateStep, SHOW_ALL_RESTORE_STEPS, scrollUntilVisibleStep, DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS } from './helpers';

export const MENUS_BRANCH_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Local branch context menu ---------- */
	{
		id: 'menu-branch/checkout',
		title: 'Checkout Branch',
		group: 'menu-branch',
		tags: ['menu-branch', 'context-menu'],
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch', 'context-menu'],
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
		tags: ['menu-branch', 'context-menu'],
		mutable: true,
		// Confirming opens the editor's native save dialog — answered by the ScriptedUiPort the
		// suite runner installs, so the action RUNS in every mode.
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch', 'context-menu', 'dialog'],
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
		tags: ['menu-branch'],
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
		tags: ['menu-branch', 'dropdown'],
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
	}
];

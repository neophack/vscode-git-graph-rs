/**
 * The menu-commit actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, scrollUntilVisibleStep, DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS, ROW_ASSERT_STEPS } from './helpers';

export const MENUS_COMMIT_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Commit context menu ---------- */
	{
		id: 'menu-commit/add-tag',
		title: 'Add Tag…',
		group: 'menu-commit',
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit'],
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
		tags: ['menu-commit', 'context-menu'],
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
		tags: ['menu-commit', 'context-menu'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit'],
		mutable: false,
		request: [{ command: 'openExternalDirDiff', repo: '{{repo}}', fromHash: '{{commit}}', toHash: '*', isGui: false }],
		expect: { responses: ['openExternalDirDiff'] }
	},
	{
		id: 'menu-commit/drop',
		title: 'Drop…',
		group: 'menu-commit',
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
		tags: ['menu-commit', 'context-menu'],
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
		tags: ['menu-commit', 'context-menu', 'dialog'],
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
	}
];

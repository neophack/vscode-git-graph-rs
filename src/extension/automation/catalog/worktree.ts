/**
 * The worktree actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS } from './helpers';

export const WORKTREE_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Worktree widget ---------- */
	{
		id: 'worktree/add',
		title: 'Add Worktree',
		group: 'worktree',
		tags: ['worktree', 'dialog'],
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
		tags: ['worktree', 'dialog'],
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
		tags: ['worktree', 'dialog'],
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
	}
];

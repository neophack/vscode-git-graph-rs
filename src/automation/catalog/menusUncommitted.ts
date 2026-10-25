/**
 * The menu-uncommitted actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS } from './helpers';

export const MENUS_UNCOMMITTED_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Uncommitted changes context menu ---------- */
	// The uncommitted-changes row only renders while HEAD is inside the loaded first page (the
	// host skips the status follow-up otherwise), so this group runs right after menu-commit —
	// later groups check out branches whose tips are deep history, which would strand HEAD
	// outside the loaded page and the row with it.
	{
		id: 'menu-uncommitted/clean-untracked',
		title: 'Clean untracked files…',
		group: 'menu-uncommitted',
		tags: ['menu-uncommitted', 'context-menu', 'dialog'],
		mutable: true,
		// The directories checkbox keeps its default (on); cleaning always carries a data-loss
		// risk, so a second (risk acknowledgement) dialog follows the confirmation.
		ui: [
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Clean untracked files…', '清理未跟踪文件…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'cleanUntrackedFiles', repo: '{{repo}}', directories: true }],
		expect: { responses: ['cleanUntrackedFiles'] }
	},
	{
		id: 'menu-uncommitted/open-source-control',
		title: 'Open Source Control View',
		group: 'menu-uncommitted',
		tags: ['menu-uncommitted', 'context-menu'],
		mutable: false,
		// The row only renders while the working tree has uncommitted changes: on a clean tree
		// there is nothing to right-click, and the action skips.
		ui: [
			{ op: 'skipIfAbsent', selector: 'tr#uncommittedChanges' },
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Open Source Control View', '打开源代码管理视图') }
		],
		request: [{ command: 'viewScm' }],
		expect: { responses: ['viewScm'] }
	},
	{
		id: 'menu-uncommitted/reset',
		title: 'Reset uncommitted changes…',
		group: 'menu-uncommitted',
		tags: ['menu-uncommitted', 'context-menu', 'dialog'],
		mutable: true,
		// The mode selector is a CustomSelect left at its default (Mixed — no data-loss
		// warning). Resets 'HEAD', moving neither HEAD nor the branch name.
		ui: [
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Reset uncommitted changes…', '重置未提交的更改…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'resetToCommit', repo: '{{repo}}', commit: 'HEAD', resetMode: 'mixed' }],
		expect: { responses: ['resetToCommit'] }
	},
	{
		id: 'menu-uncommitted/stash',
		title: 'Stash uncommitted changes…',
		group: 'menu-uncommitted',
		tags: ['menu-uncommitted', 'context-menu', 'dialog'],
		mutable: true,
		// Message + include-untracked checkbox (default on, matching the request template).
		ui: [
			{ op: 'contextmenu', selector: 'tr#uncommittedChanges', item: bi('Stash uncommitted changes…', '贮藏未提交的更改…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'set', selector: '#dialogInput0', value: 'Automation stash', event: 'input' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'pushStash', repo: '{{repo}}', message: 'Automation stash', includeUntracked: true }],
		expect: { responses: ['pushStash'] }
	}
];

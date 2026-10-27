/**
 * The menu-stash actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, scrollUntilVisibleStep, DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS } from './helpers';

export const MENUS_STASH_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Stash context menu ---------- */
	{
		id: 'menu-stash/apply',
		title: 'Apply Stash…',
		group: 'menu-stash',
		tags: ['menu-stash', 'context-menu', 'dialog'],
		mutable: true,
		requires: ['stash'],
		// The reinstate-index checkbox keeps its default (off).
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Apply Stash…', '应用贮藏(Apply Stash)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'applyStash', repo: '{{repo}}', selector: '{{stash}}', reinstateIndex: false }],
		expect: { responses: ['applyStash'] }
	},
	{
		id: 'menu-stash/branch-from-stash',
		title: 'Create Branch from Stash…',
		group: 'menu-stash',
		tags: ['menu-stash', 'context-menu', 'dialog'],
		mutable: true,
		requires: ['stash'],
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Create Branch from Stash…', '从贮藏创建分支…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'eval', expr: '(function(){var i=document.getElementById("dialogInput0");i.value="automation-stash-branch";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'branchFromStash', repo: '{{repo}}', selector: '{{stash}}', branchName: 'automation-stash-branch' }],
		expect: { responses: ['branchFromStash'] },
		verify: { kind: 'branchPresent', placeholder: 'automation-stash-branch' }
	},
	{
		id: 'menu-stash/copy-hash',
		title: 'Copy Stash Hash to Clipboard',
		group: 'menu-stash',
		tags: ['menu-stash', 'context-menu'],
		mutable: false,
		requires: ['stash'],
		// The stash commit hash is a runtime value with no placeholder, so only the UI path.
		// A stash row can sit deep in the loaded page (windowed rendering keeps only viewport
		// rows in the DOM) — the flow scrolls to the label first; a stash outside the loaded
		// page never resolves {{stash}} (the server probes the loaded graph), so the action skips.
		ui: [
			scrollUntilVisibleStep('span.gitRef.stash[data-name="{{stash}}"]'),
			// The label renders the stash's own display name (the selector minus its "stash@"
			// prefix — stash rows render the short name in .gitRefName).
			{ op: 'expectCount', selector: 'span.gitRef.stash[data-name="{{stash}}"] .gitRefName', min: 1, max: 1 },
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Copy Stash Hash to Clipboard', '复制贮藏哈希到剪贴板') }
		],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-stash/copy-name',
		title: 'Copy Stash Name to Clipboard',
		group: 'menu-stash',
		tags: ['menu-stash', 'context-menu'],
		mutable: false,
		requires: ['stash'],
		// Same scroll-to-the-label preamble as copy-hash: the stash row may render far below the viewport.
		ui: [
			scrollUntilVisibleStep('span.gitRef.stash[data-name="{{stash}}"]'),
			{ op: 'expectCount', selector: 'span.gitRef.stash[data-name="{{stash}}"] .gitRefName', min: 1, max: 1 },
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Copy Stash Name to Clipboard', '复制贮藏名称到剪贴板') }
		],
		request: [{ command: 'copyToClipboard', type: 'Stash Name', data: '{{stash}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-stash/drop',
		title: 'Drop Stash…',
		group: 'menu-stash',
		tags: ['menu-stash', 'context-menu', 'dialog'],
		mutable: true,
		requires: ['stash'],
		// Dropping a stash always carries a data-loss risk: after the confirmation dialog, a
		// second (risk acknowledgement) dialog must be confirmed.
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Drop Stash…', '丢弃贮藏(Drop Stash)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'dropStash', repo: '{{repo}}', selector: '{{stash}}' }],
		expect: { responses: ['dropStash'] }
	},
	{
		id: 'menu-stash/pop',
		title: 'Pop Stash…',
		group: 'menu-stash',
		tags: ['menu-stash', 'context-menu', 'dialog'],
		mutable: true,
		requires: ['stash'],
		ui: [
			{ op: 'contextmenu', selector: 'span.gitRef.stash[data-name="{{stash}}"]', item: bi('Pop Stash…', '弹出贮藏(Pop Stash)…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'popStash', repo: '{{repo}}', selector: '{{stash}}', reinstateIndex: false }],
		expect: { responses: ['popStash'] }
	}
];

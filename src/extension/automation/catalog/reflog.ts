/**
 * The reflog actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, reflogRowMenuStep, REFLOG_DEFENSIVE_CLOSE_STEP, DISMISS_ERROR_DIALOG_STEP, DIALOG_ASSERT_STEPS } from './helpers';

export const REFLOG_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Reflog widget ---------- */
	{
		id: 'reflog/checkout',
		title: 'Checkout…',
		group: 'reflog',
		tags: ['reflog', 'dialog'],
		mutable: true,
		// Row 1 (not the newest entry). `commit` approximates the reflog entry's hash in request
		// mode. The confirmation dialog's "always accept" checkbox stays unchecked. The row menu
		// opens on click (see reflogRowMenuStep), not on contextmenu. No verify: whether row 1
		// moves HEAD depends on what the earlier entries of the same pass did, so a headIsNot
		// check is order-sensitive — the checkoutCommit response is the assertion.
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '.reflogRow' },
			reflogRowMenuStep('.reflogRow[data-index="1"]', bi('Checkout…', '检出…')),
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'checkoutCommit', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['checkoutCommit'] }
	},
	{
		id: 'reflog/copy-hash',
		title: 'Copy Commit Hash to Clipboard',
		group: 'reflog',
		tags: ['reflog'],
		mutable: false,
		// The row menu opens on click (see reflogRowMenuStep), not on contextmenu.
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '.reflogRow' },
			reflogRowMenuStep('.reflogRow', bi('Copy Commit Hash to Clipboard', '复制提交哈希到剪贴板')),
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'copyToClipboard', type: 'Commit Hash', data: '{{commit}}' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		// NOTE: no UI path. #reflogLoadMoreBtn only renders when the reflog exceeds the
		// 200-entry first page (web/reflogView.ts), and the seeded fixture's HEAD reflog has
		// ~130 entries — so the button can never appear on this fixture. The request path below
		// still exercises the host side.
		id: 'reflog/load-more',
		title: 'Load More Entries',
		group: 'reflog',
		tags: ['reflog'],
		mutable: false,
		request: [{ command: 'reflog', repo: '{{repo}}', ref: 'HEAD', limit: 400 }],
		expect: { responses: ['reflog'] }
	},
	{
		id: 'reflog/open',
		title: 'View Reflog',
		group: 'reflog',
		tags: ['reflog'],
		mutable: false,
		// The tool button closes the settings widget and opens the Reflog widget, which loads
		// the HEAD reflog. The defensive close keeps the flow deterministic when a previous run
		// left the widget open (show() early-returns on an open widget, sending no request).
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
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
		id: 'reflog/reset',
		title: 'Reset current branch to here…',
		group: 'reflog',
		tags: ['reflog', 'dialog'],
		mutable: true,
		// Row 1 so the reset actually moves the branch. The mode selector is a CustomSelect left
		// at its default (Mixed — no data-loss warning). `commit` approximates the entry's hash.
		ui: [
			REFLOG_DEFENSIVE_CLOSE_STEP,
			{ op: 'click', selector: '#settingsBtn' },
			{ op: 'waitFor', selector: '#settingsWidget.active' },
			{ op: 'click', selector: '#openReflogView' },
			{ op: 'waitFor', selector: '.reflogRow' },
			reflogRowMenuStep('.reflogRow[data-index="1"]', bi('Reset current branch to here…', '将当前分支重置到此处…')),
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			{ op: 'click', selector: '#reflogClose' },
			{ op: 'waitForGone', selector: '#reflogWidget.active' }
		],
		request: [{ command: 'resetToCommit', repo: '{{repo}}', commit: '{{commit}}', resetMode: 'mixed' }],
		expect: { responses: ['resetToCommit'] }
	}
];

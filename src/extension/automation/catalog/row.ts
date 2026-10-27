/**
 * The row actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, scrollUntilVisibleStep, DISMISS_ERROR_DIALOG_STEP, ROW_ASSERT_STEPS } from './helpers';

export const ROW_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Row interactions & column header menu ---------- */
	{
		id: 'row/column-ordering',
		title: 'Author Timestamp Order',
		group: 'row',
		tags: ['row', 'context-menu'],
		mutable: true,
		// Right-clicking the column headers offers three orderings; picking one persists
		// commitOrdering in the repo state and hard-refreshes. No request path: the state write
		// is assembled by the live view. The trailing dismiss guards the run against a leftover
		// error dialog (the action answers through the refresh path).
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Author Timestamp Order', '按作者时间排序') },
			DISMISS_ERROR_DIALOG_STEP
		],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	// NOTE: "Reset Column Widths" has no entry: the webview only offers it after a manual column
	// resize froze the layout, and neither the shim's ops nor a plain driver can perform the
	// drag. Column-resize behaviour is covered by the view's unit tests instead.
	{
		id: 'row/column-toggle-date',
		title: 'Date',
		group: 'row',
		tags: ['row', 'context-menu'],
		mutable: false,
		// Column visibility toggles persist columnWidths via a silent setRepoState and re-render.
		// The flow toggles the column OFF and back ON: leaving it hidden would change the layout
		// every later run (and the user's view) starts from.
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Date', '日期') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }, // the re-render has landed
			{ op: 'expectCount', selector: 'td.dateCol', min: 0, max: 0 }, // the column is really gone
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Date', '日期') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'expectCount', selector: 'td.dateCol', min: 1 } // ...and really back
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/column-toggle-author',
		title: 'Author',
		group: 'row',
		tags: ['row', 'context-menu'],
		mutable: false,
		// Same round-trip as the Date toggle, for the Author column.
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Author', '作者') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'expectCount', selector: 'td.authorCol', min: 0, max: 0 },
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Author', '作者') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'expectCount', selector: 'td.authorCol', min: 1 }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/column-toggle-commit',
		title: 'Commit',
		group: 'row',
		tags: ['row', 'context-menu'],
		mutable: false,
		// Same round-trip as the Date toggle, for the Commit Hash column.
		ui: [
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Commit', '提交') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' },
			{ op: 'contextmenu', selector: '#tableColHeaders', item: bi('Commit', '提交') },
			{ op: 'waitFor', selector: 'tr.commit[data-id="0"]' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/compare-rows',
		title: 'Compare two commits (Ctrl+Click)',
		group: 'row',
		tags: ['row'],
		mutable: false,
		// The page path is a Ctrl+Click while a Commit Details View is open — a modifier click
		// the shim cannot express — so only the request path is modelled. getCommitOrder: the
		// commit nearer the top of the loaded table is `to`.
		request: [{
			command: 'compareCommits', repo: '{{repo}}',
			commitHash: '{{commit}}', compareWithHash: '{{commitParent}}',
			fromHash: '{{commitParent}}', toHash: '{{commit}}', refresh: false
		}],
		expect: { responses: ['compareCommits'] }
	},
	{
		id: 'row/dblclick-branch-checkout',
		title: 'Checkout Branch (double-click label)',
		group: 'row',
		tags: ['row'],
		mutable: true,
		// Double-clicking a local branch label checks the branch out directly — no dialog (the
		// data-loss guard does not cover checkoutBranch), only the action-running overlay.
		ui: [
			scrollUntilVisibleStep('span.gitRef.head[data-name="{{branch}}"]'),
			{ op: 'expectText', selector: 'span.gitRef.head[data-name="{{branch}}"]', contains: '{{branch}}' },
			{ op: 'dblclick', selector: 'span.gitRef.head[data-name="{{branch}}"]' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'checkoutBranch', repo: '{{repo}}', branchName: '{{branch}}', remoteBranch: null, pullAfterwards: null }],
		expect: { responses: ['checkoutBranch'] },
		verify: { kind: 'headIs', placeholder: '{{branch}}' }
	},
	{
		id: 'row/open-changes-btn',
		title: 'Open Changes',
		group: 'row',
		tags: ['row'],
		mutable: false,
		// The per-row button opens the commit's changes (against its first parent) in a Commit
		// Comparison tab; the host answers openCompareTab with no response. main.css hides the
		// button at WIDTH 0 (taking no space, so a truncated description runs to its boundary) until
		// the row is hovered or active, so the flow pins BOTH states: hidden at rest, revealed at
		// its 20x20 size once active. The shim cannot drive the CSS :hover state (synthetic mouse
		// events never set it), so the row is activated the other UI way the stylesheet reveals the
		// button for: clicking it opens the Commit Details View, which marks the row
		// commitDetailsOpen — the class is added synchronously before #cdv renders, and re-applied
		// on the CDV's own re-renders, so waitFor the class cannot race the reveal.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			// Hidden at rest: width 0, but height 20px (the box is never 0x0, so expectSize's
			// not-rendered guard does not fire) — the button ceding its space back to the
			// description text is exactly the behavior under test.
			{ op: 'expectSize', selector: 'tr.commit[data-hash="{{commit}}"] .openChangesBtn', maxW: 0, minH: 12, maxH: 40 },
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: 'tr.commit.commitDetailsOpen[data-hash="{{commit}}"]' },
			{ op: 'expectSize', selector: 'tr.commit[data-hash="{{commit}}"] .openChangesBtn', minW: 12, maxW: 48, minH: 12, maxH: 40 },
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"] .openChangesBtn' },
			// Close the Commit Details View again, leaving the view as later entries expect it.
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'openCompareTab', repo: '{{repo}}', fromHash: '{{commitParent}}', toHash: '{{commit}}', singleCommit: true }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'row/select-commit-row',
		title: 'Select Commit (expand Commit Details)',
		group: 'row',
		tags: ['row'],
		mutable: false,
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			// The CDV shell renders immediately; its FILE list arrives with the commitDetails
			// response — poll for the record instead of racing it with a one-shot count.
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'expectCount', selector: '#cdvFiles .fileTreeFileRecord', min: 1 },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		// hasParents: the fixture's non-HEAD commit has a parent.
		request: [{ command: 'commitDetails', repo: '{{repo}}', commitHash: '{{commit}}', hasParents: true, stash: null, avatarEmail: null, refresh: false }],
		expect: { responses: ['commitDetails'] }
	}
];

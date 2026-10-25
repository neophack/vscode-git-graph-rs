/**
 * The menu-tag actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, scrollUntilVisibleStep, DISMISS_ERROR_DIALOG_STEP, SCROLL_TOP_STEPS, DIALOG_ASSERT_STEPS } from './helpers';

export const MENUS_TAG_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Tag context menu ---------- */
	{
		id: 'menu-tag/copy-name',
		title: 'Copy Tag Name to Clipboard',
		group: 'menu-tag',
		tags: ['menu-tag', 'context-menu'],
		mutable: false,
		requires: ['tag'],
		// Tag rows sit deep in the graph and windowed rendering keeps only the viewport rows in
		// the DOM — the flow scrolls until the {{tag}} label (the first tag of the loaded page,
		// a repository value the server resolves) renders, then restores the scroll position.
		// The request path uses v1.0.0, the fixture's always-existing tag.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{tag}}"]'),
			{ op: 'expectText', selector: 'span.gitRef.tag[data-name="{{tag}}"]', contains: '{{tag}}' },
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{tag}}"]', item: bi('Copy Tag Name to Clipboard', '复制标签名称到剪贴板') },
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'copyToClipboard', type: 'Tag Name', data: 'v1.0.0' }],
		expect: { responses: ['copyToClipboard'] }
	},
	{
		id: 'menu-tag/create-archive',
		title: 'Create Archive',
		group: 'menu-tag',
		tags: ['menu-tag', 'context-menu', 'dialog'],
		mutable: true,
		// Confirming opens the editor's native save dialog — answered by the ScriptedUiPort the
		// suite runner installs (task 4.10), so the action RUNS in every mode.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="v1.29.0"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="v1.29.0"]', item: bi('Create Archive', '创建归档') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'createArchive', repo: '{{repo}}', ref: 'v1.0.0' }],
		expect: { responses: ['createArchive'] }
	},
	{
		id: 'menu-tag/delete',
		title: 'Delete Tag…',
		group: 'menu-tag',
		tags: ['menu-tag', 'context-menu', 'dialog'],
		mutable: true,
		requires: ['annotatedTag'],
		// The annotated placeholder is the tag `menu-commit/add-tag` created near HEAD (the
		// fixture's own in-window tags are lightweight, so in the write pass the annotated one is
		// that fresh tag) — well inside the loaded page, unlike the v1.29.0 this entry once
		// hardcoded: that tag sits ~700 commits deep while the initial load is 300, and the
		// scroll step cannot trigger a load-more, so the row was unreachable by construction.
		// With a single remote the dialog is an "also delete on remote" checkbox (default off,
		// so a remote copy survives). `menu-tag/push` runs after this and resolves {{tag}} —
		// with the annotated tag gone it targets the newest fixture tag instead.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{annotatedTag}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{annotatedTag}}"]', item: bi('Delete Tag…', '删除标签…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'deleteTag', repo: '{{repo}}', tagName: '{{annotatedTag}}', deleteOnRemote: null }],
		expect: { responses: ['deleteTag'] },
		// The UI path deletes the live {{annotatedTag}} (the entry above documents why); the state
		// check holds the flow's own target, so the delete must really have removed it.
		verify: { kind: 'tagAbsent', placeholder: '{{annotatedTag}}' }
	},
	{
		id: 'menu-tag/push',
		title: 'Push Tag…',
		group: 'menu-tag',
		tags: ['menu-tag', 'context-menu', 'dialog'],
		mutable: true,
		requires: ['remote'],
		// {{tag}} — the first tag of the loaded page. In the write pass `menu-tag/delete` has
		// already removed the annotated add-tag tag, so this resolves to the newest fixture tag,
		// which exists on the fixture remote: the host answers with an error dialog (after the
		// action-running overlay), which the flow settles and dismisses — the designed path.
		// When delete skipped (no annotated tag), {{tag}} is whatever leads the page and the
		// flow tolerates a successful push through the same overlay. `commit` approximates the
		// tagged commit (the live flow passes the tag's own commit hash).
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{tag}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{tag}}"]', item: bi('Push Tag…', '推送标签…') },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			{ op: 'click', selector: '#dialogAction' },
			{ op: 'waitFor', selector: '.dialog' },
			...DIALOG_ASSERT_STEPS,
			DISMISS_ERROR_DIALOG_STEP,
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'pushTag', repo: '{{repo}}', tagName: 'v1.0.0', remotes: ['{{remote}}'], commitHash: '{{commit}}', skipRemoteCheck: false }],
		expect: { responses: ['pushTag'] },
		// The fixture remote already carries the tag, so the push is rejected ("already exists")
		// — the designed outcome the comment above describes. Any OTHER error (a broken dialog
		// path, a wrong ref) still fails the entry.
		allowErrorOn: ['pushTag']
	},
	{
		id: 'menu-tag/view-details',
		title: 'View Details',
		group: 'menu-tag',
		tags: ['menu-tag', 'context-menu', 'dialog'],
		mutable: false,
		requires: ['annotatedTag'],
		// Only offered for annotated tags; {{annotatedTag}} is the first annotated tag of the
		// loaded graph (the server picks it from the per-commit tag metadata), so the menu always
		// offers the item and repositories without annotated tags skip cleanly. The details
		// arrive in a dialog (`.messageContent` distinguishes it from the action-running overlay,
		// which also offers a "Dismiss" secondary — dismissing the overlay before the response
		// would let the details dialog open behind it); it is closed with its Close action.
		// `commit` approximates the tagged commit; the response arrives regardless.
		ui: [
			scrollUntilVisibleStep('span.gitRef.tag[data-name="{{annotatedTag}}"]'),
			{ op: 'contextmenu', selector: 'span.gitRef.tag[data-name="{{annotatedTag}}"]', item: bi('View Details', '查看详情') },
			{ op: 'waitFor', selector: '.dialog .messageContent' },
			// The dialog really shows THIS tag's details — its name is in the message body.
			{ op: 'expectText', selector: '.dialog .messageContent', contains: '{{annotatedTag}}' },
			{ op: 'click', selector: '#dialogSecondaryAction' },
			{ op: 'waitForGone', selector: '.dialog', timeoutMs: 10000 },
			...SCROLL_TOP_STEPS
		],
		request: [{ command: 'tagDetails', repo: '{{repo}}', tagName: '{{annotatedTag}}', commitHash: '{{commit}}' }],
		expect: { responses: ['tagDetails'] }
	}
];

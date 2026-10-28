/**
 * The cdv actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi, scrollUntilVisibleStep, DISMISS_ERROR_DIALOG_STEP, ROW_ASSERT_STEPS } from './helpers';

export const CDV_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Commit Details View ---------- */
	{
		id: 'cdv/code-review',
		title: 'Start Code Review',
		group: 'cdv',
		tags: ['cdv'],
		mutable: true,
		// The review is ended again at the end of the flow (endCodeReview has no response) so
		// later runs see a clean state. The trailing dismiss guards the run against a leftover
		// error dialog (a startCodeReview failure would otherwise swallow the next run's steps).
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCodeReview' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitFor', selector: '#cdvCodeReview.active' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitForGone', selector: '#cdvCodeReview.active' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' },
			DISMISS_ERROR_DIALOG_STEP
		],
		expect: { responses: ['startCodeReview'] }
	},
	{
		id: 'cdv/collapse-folders',
		title: 'Collapse/Expand Folders (collapse)',
		group: 'cdv',
		tags: ['cdv'],
		mutable: false,
		// Folder open/closed state is webview state only — no host traffic. The effect is asserted
		// state-independently (a real repository's folders may start in any per-repo saved state,
		// and a root-level-only commit has no folders at all — then the check is vacuously true):
		// after the collapse click EVERY folder is closed, not just some.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCollapse' },
			{ op: 'click', selector: '#cdvCollapse' },
			{
				op: 'eval',
				expr: '(function(){var folders=document.querySelectorAll("#cdvFiles .fileTreeFolder").length;var closed=document.querySelectorAll("#cdvFiles li.closed").length;if(folders!==closed)throw new Error("the collapse left "+(folders-closed)+" of "+folders+" folders open");return folders+" folders collapsed";})()'
			},
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'cdv/expand-folders',
		title: 'Expand Folders',
		group: 'cdv',
		tags: ['cdv'],
		mutable: false,
		// After the collapse click every folder must be open again — no closed marker left.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvExpand' },
			{ op: 'click', selector: '#cdvExpand' },
			{ op: 'expectCount', selector: '#cdvFiles li.closed', min: 0, max: 0 }, // every folder open again
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		// NOTE: no UI path. #cdvExternalDiff always renders, but without the repository config
		// setting diff.tool / gui.diffTool its click handler returns early (commitDetailsView.ts),
		// and the fixture seed configures neither — so no openExternalDirDiff request can be
		// produced in a UI run. The request path below still exercises the host side.
		id: 'cdv/external-diff',
		title: 'Open External Directory Diff',
		group: 'cdv',
		tags: ['cdv'],
		mutable: false,
		// fromHash/toHash: a plain commit diffs against its first parent; `commitParent`
		// approximates that parent (identical unless the commit is a merge or root).
		request: [{ command: 'openExternalDirDiff', repo: '{{repo}}', fromHash: '{{commitParent}}', toHash: '{{commit}}', isGui: false }],
		expect: { responses: ['openExternalDirDiff'] }
	},
	{
		id: 'cdv/file-copy-path',
		title: 'Copy Absolute File Path to Clipboard',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['file'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('Copy Absolute File Path to Clipboard', '复制绝对文件路径到剪贴板') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'copyFilePath', repo: '{{repo}}', filePath: '{{file}}', absolute: true }],
		expect: { responses: ['copyFilePath'] }
	},
	{
		id: 'cdv/file-mark-reviewed',
		title: 'Mark as Reviewed',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: true,
		requires: ['file'],
		// Only offered while a code review is in progress and the file is still unreviewed, so
		// the flow starts a review first and ends it again afterwards. `file` (the first file of
		// the commit's details) is data-index 0 in the freshly opened view.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvCodeReview' },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitFor', selector: '#cdvCodeReview.active' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('Mark as Reviewed', '标记为已评审') },
			{ op: 'click', selector: '#cdvCodeReview' },
			{ op: 'waitForGone', selector: '#cdvCodeReview.active' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' },
			DISMISS_ERROR_DIALOG_STEP
		],
		expect: { responses: ['startCodeReview', 'updateCodeReview'] }
	},
	{
		id: 'cdv/file-open-file',
		title: 'Open File',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['file'],
		// `file` belongs to the context commit, which the fixture checks out only on local-ahead —
		// at HEAD=main the working tree does not contain it, so the host answers with an error
		// dialog that the flow dismisses (a leaked modal would swallow the keyboard shortcuts of
		// the later runs).
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('Open File', '打开文件') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' },
			DISMISS_ERROR_DIALOG_STEP
		],
		request: [{ command: 'openFile', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['openFile'] },
		// Designed refusal, per the comment above: the context file need not exist at HEAD.
		allowErrorOn: ['openFile']
	},
	{
		id: 'cdv/file-view-diff',
		title: 'View Diff',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['file'],
		// A single commit diffs against its first parent. The fixture history only ever contains
		// Modified changes (no adds/deletes/renames), so type 'M' with oldFilePath ===
		// newFilePath is exact for it; other repositories would need the runtime values.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff', '查看差异') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiff', repo: '{{repo}}', fromHash: '{{commit}}', toHash: '{{commit}}', oldFilePath: '{{file}}', newFilePath: '{{file}}', type: 'M' }],
		expect: { responses: ['viewDiff'] }
	},
	{
		id: 'cdv/file-view-diff-working-file',
		title: 'View Diff with Working File',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['file'],
		// Only offered when the file still exists at this revision and is not binary.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff with Working File', '与工作区文件比较差异') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiffWithWorkingFile', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['viewDiffWithWorkingFile'] }
	},
	{
		id: 'cdv/file-view-file-at-revision',
		title: 'View File at this Revision',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['file'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View File at this Revision', '查看该版本的文件') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewFileAtRevision', repo: '{{repo}}', hash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['viewFileAtRevision'] }
	},
	{
		// The fixture (fixture.mjs) seeds a dedicated commit whose ONLY change is a plain binary
		// file (assets/archive.bin) — data-index="0" is always that file, so this reliably drives
		// the binary compare view (binaryCompareView.ts) instead of the text diff `cdv/file-view-diff`
		// always exercises (its `file` context explicitly excludes binaries).
		id: 'cdv/file-view-diff-binary',
		title: 'View Diff (binary file)',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['binaryFile'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{binaryCommit}}"]'),
			{ op: 'click', selector: 'tr.commit[data-hash="{{binaryCommit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff', '查看差异') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiff', repo: '{{repo}}', fromHash: '{{binaryCommit}}', toHash: '{{binaryCommit}}', oldFilePath: '{{binaryFile}}', newFilePath: '{{binaryFile}}', type: 'M' }],
		expect: { responses: ['viewDiff'] }
	},
	{
		// Same as above, but the dedicated commit's only change is a real, decodable image
		// (assets/logo.png) — drives the picture side of the binary compare view specifically
		// (isImageChange/imageMimeOf in binaryCompare.ts), not just "any binary file".
		id: 'cdv/file-view-diff-image',
		title: 'View Diff (image file)',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['imageFile'],
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{imageCommit}}"]'),
			{ op: 'click', selector: 'tr.commit[data-hash="{{imageCommit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'contextmenu', selector: '#cdvFiles .fileTreeFileRecord[data-index="0"]', item: bi('View Diff', '查看差异') },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		request: [{ command: 'viewDiff', repo: '{{repo}}', fromHash: '{{imageCommit}}', toHash: '{{imageCommit}}', oldFilePath: '{{imageFile}}', newFilePath: '{{imageFile}}', type: 'M' }],
		expect: { responses: ['viewDiff'] }
	},
	{
		id: 'cdv/file-view-diff-binary-compare',
		title: 'View Diff (binary file, standalone compare view)',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: false,
		requires: ['binaryFile'],
		// The request the SAME "View Diff" menu item sends when the file is binary and has no
		// textual diff for the native Diff View (fileActions.ts routes on fileIsBinary): the
		// standalone Binary Compare tab opens instead, through the same ui surface the Commit
		// Comparison View uses. The host answers nothing — the tab opening IS the outcome — and
		// the runner's per-action cleanup closes the auxiliary view again.
		request: [{ command: 'viewDiffBinary', repo: '{{repo}}', fromHash: '{{binaryCommit}}', toHash: '{{binaryCommit}}', oldFilePath: '{{binaryFile}}', newFilePath: '{{binaryFile}}', type: 'M' }],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'cdv/file-reset-to-revision',
		title: 'Reset File to this Revision',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: true,
		requires: ['file'],
		// The confirmed request the "Reset File to this Revision" menu item's data-loss dialog
		// sends (the page confirms in the webview and re-sends with the go-ahead): the context
		// file is checked out from the context commit, and the response's clean error payload
		// proves the write chain ran.
		request: [{ command: 'resetFileToRevision', repo: '{{repo}}', commitHash: '{{commit}}', filePath: '{{file}}' }],
		expect: { responses: ['resetFileToRevision'] }
	},
	{
		id: 'cdv/file-view-list',
		title: 'File List View',
		group: 'cdv',
		tags: ['cdv'],
		mutable: false,
		// The view-type change persists via a setRepoState the host answers silently.
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvFileViewTypeList' },
			{ op: 'click', selector: '#cdvFileViewTypeList' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'cdv/file-view-tree',
		title: 'File Tree View',
		group: 'cdv',
		tags: ['cdv'],
		mutable: false,
		ui: [
			scrollUntilVisibleStep('tr.commit[data-hash="{{commit}}"]'),
			...ROW_ASSERT_STEPS,
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'waitFor', selector: '#cdvFileViewTypeTree' },
			{ op: 'click', selector: '#cdvFileViewTypeTree' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	}
];

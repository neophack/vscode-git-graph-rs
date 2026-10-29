/**
 * The entry point of the Commit Comparison View: a header with the overall statistics, a file tree
 * sidebar of the changed files, and the split diff view of the selected file, with the shared
 * binary comparison area embedded for binary files. The boot `init` message delivers the file
 * changes and the commit summaries; the per-file diffs arrive in response to `getFileDiff`
 * messages.
 */

import { ComparisonBridge } from './../binaryCompare/host';
import { BinaryCompareArea } from './../binaryCompare/binaryCompareArea';
import type { ComparisonInitResponse, ComparisonRequest } from '../../shared/protocol/comparison';
import { compareStrings as s, setCompareStringsLanguage } from './../binaryCompare/strings';
import { DiffView } from './diffView';
import { FileTreeSidebar } from './fileTree';
import { ComparisonHeader } from './headerView';
import { ComparisonLayout } from './layout';
import { ComparisonFileModel, changePath, statusColour, statusLetter } from './model';
import { measureBoundingClientRect } from '../common/measure';
import { escapeHtml, html, setHtml } from '../common/html';

const bridge = new ComparisonBridge();
const layout = new ComparisonLayout();
const commitCards = document.getElementById('commitCards');
const filesChangedLabel = document.getElementById('filesChangedLabel');
const sidebar = document.getElementById('sidebar');
const fileHeader = document.getElementById('fileHeader');
const diffAreaEl = document.getElementById('diffArea');

// The Escape key closes the phone layout's files sheet from wherever the focus sits.
document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') layout.closeFilesSheet();
});

if (commitCards !== null && filesChangedLabel !== null && sidebar !== null && fileHeader !== null && diffAreaEl !== null) {
	/* ---------- The phone layout's files sheet ---------- */
	// The "Files" bar (in the main column) opens the sheet, its title bar's close button closes
	// it, and picking a file dismisses it back to the diff (see selectFile below). Both buttons
	// live in the skeleton the host serves and are looked up under skeleton elements already
	// resolved — document-wide lookups are rationed here (OPTIMIZATION-PLAN §6 F3); the guards
	// keep older shells (the test harnesses') harmless.
	const mainColumn = diffAreaEl.closest('#main');
	const mobileFilesBtn = mainColumn !== null ? mainColumn.querySelector('#mobileFilesBtn') : null;
	if (mobileFilesBtn !== null) mobileFilesBtn.addEventListener('click', () => layout.openFilesSheet());
	const closeFilesSheetBtn = sidebar.querySelector('#closeFilesSheetBtn');
	if (closeFilesSheetBtn !== null) closeFilesSheetBtn.addEventListener('click', () => layout.closeFilesSheet());

	const header = new ComparisonHeader(commitCards, filesChangedLabel);
	const tree = new FileTreeSidebar(sidebar);
	const area = new BinaryCompareArea({
		root: diffAreaEl,
		send: (message) => bridge.send(message)
	});
	area.installGlobalInput();
	const diff = new DiffView({
		fileHeader: fileHeader,
		diffArea: diffAreaEl,
		sendFileRequest: (index, command) => { bridge.send(<ComparisonRequest>{ command: command, index: index }); },
		enterBinaryView: (index, isImage) => {
			area.setFileIsImage(isImage);
			if (isImage) area.enterImage(index);
			else area.enterHex(index);
		},
		statusColour: statusColour,
		statusLetter: statusLetter,
		countsHtml: (file, index) => tree.countsHtml(file, index)
	});
	const changes: ComparisonFileModel[] = [];

	/* ---------- Sidebar resizing ---------- */
	const resizer = document.getElementById('sidebarResizer');
	const body = document.getElementById('body');
	if (resizer !== null && body !== null) {
		const MIN_WIDTH = 170, MAX_WIDTH = 700;
		const clampWidth = (width: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.min(width, Math.floor(window.innerWidth * 0.8))));
		const savedWidth = (<{ sidebarWidth?: unknown }>bridge.getState() || {}).sidebarWidth;
		// A width saved on a wider window must not carry over unchanged: clamped to this one, it
		// would leave the diff area too little room to read (and never shrink on its own again)
		if (typeof savedWidth === 'number') sidebar.style.width = clampWidth(savedWidth) + 'px';
		// Pointer events (not mouse events): a finger or stylus drags the divider as well, kept on
		// the resizer by pointer capture
		resizer.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			resizer.classList.add('resizing');
			document.body.style.cursor = 'col-resize';
			document.body.style.userSelect = 'none';
			const bodyLeft = measureBoundingClientRect(body).left;
			const onPointerMove = (moveEvent: PointerEvent) => {
				sidebar.style.width = clampWidth(moveEvent.clientX - bodyLeft) + 'px';
			};
			const onPointerUp = () => {
				window.removeEventListener('pointermove', onPointerMove);
				window.removeEventListener('pointerup', onPointerUp);
				window.removeEventListener('pointercancel', onPointerUp);
				resizer.classList.remove('resizing');
				document.body.style.cursor = '';
				document.body.style.userSelect = '';
				bridge.setState(Object.assign({}, bridge.getState(), { sidebarWidth: measureBoundingClientRect(sidebar).width }));
			};
			try { resizer.setPointerCapture(e.pointerId); } catch (e) { /* the pointer ended already */ }
			window.addEventListener('pointermove', onPointerMove);
			window.addEventListener('pointerup', onPointerUp);
			window.addEventListener('pointercancel', onPointerUp);
		});
	}

	const selectFile = (index: number) => {
		const file = changes[index];
		if (file === undefined) return;
		area.leave();
		tree.select(index);
		diff.selectFile(file, index);
		// Picking a file is the sheet's whole job: dismiss it back to the diff (a no-op outside
		// the phone layout, and when the sheet is closed).
		layout.closeFilesSheet();
	};

	const renderInit = (init: ComparisonInitResponse) => {
		setCompareStringsLanguage(init.language);
		layout.setMobileAdaptation(init.mobileAdaptation === true);
		header.renderLabel(init.error);
		changes.length = 0;
		for (const file of init.changes) {
			changes.push({ oldFilePath: file.oldFilePath, newFilePath: file.newFilePath, type: file.type, additions: file.additions, deletions: file.deletions });
		}
		header.renderCards(init.fromHash, init.toHash, init.singleCommit, init.summaries, init.commitsBetween);
		diff.clearCache();
		if (init.error !== null) {
			setHtml(diffAreaEl, html`<div class="status">${escapeHtml(init.error)}</div>`);
			return;
		}
		if (changes.length === 0) {
			setHtml(diffAreaEl, html`<div class="status">${s.compareNoChanges}</div>`);
			return;
		}
		header.renderStats(changes);
		tree.render(changes, selectFile);
		if (init.countsPossible) {
			/* The +N/-M counts are asked for after the list itself has rendered — computing them
			   means reading two blobs per file, which on a large range is the slow half of the
			   load. A comparison against the working tree reports no counts by design, so none are
			   requested. */
			const pending: string[] = [];
			for (const file of changes) {
				if (file.type !== 'U' && file.additions === null) pending.push(changePath(file));
			}
			if (pending.length > 0) bridge.send({ command: 'requestCounts', paths: pending });
		}
		selectFile(0);
	};

	bridge.onMessage((msg) => {
		if (msg.command === 'init') {
			// This page's host answers the boot handshake with the comparison's init message.
			renderInit(<ComparisonInitResponse>msg);
			return;
		}
		if (msg.command === 'fileDiff') {
			diff.fileDiff(msg.index, msg.diff, msg.error);
			return;
		}
		if (msg.command === 'lineCounts') {
			const totalsChanged = tree.applyCounts(msg.counts, diff.selected(), (file, index) => tree.countsHtml(file, index));
			if (totalsChanged) header.renderStats(changes);
			return;
		}
		area.handle(msg);
	});

	// The page's script has loaded and is listening: ask for the boot data (the host answers with
	// the init message, and holds the request until its own data is ready).
	bridge.send({ command: 'ready' });
}

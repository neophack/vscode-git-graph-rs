/* The file tree / file list of the Commit Details View: building the tree from a commit's file
   changes, rendering it, and the review state of its files and folders. */

import { alterClass, getChildUl } from '../../common/dom';
import { getGitFileChangeTypeName } from '../../common/gitNames';
import { escapeHtml, helpTooltipAttrs, html, joinHtml, raw, replaceWithHtml, SafeHtml } from '../../common/html';
import { formatStr, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { arraysEqual } from '../../common/util';
import { CLASS_CONTEXT_MENU_ACTIVE } from '../widgets/contextMenu';
import { FileTreeFile, FileTreeFolder, FileTreeFolderContents, FileTreeLeaf, FileTreeNode } from '../state/types';

const CLASS_PENDING_REVIEW = 'pendingReview';

/** How the file view is rendered (Extension Settings). */
export interface FileViewOptions {
	readonly compactFolders: boolean;
	readonly enhancedAccessibility: boolean;
}

/** The placeholder shown in place of the counts chip while they are still being computed. */
const PENDING_COUNTS_CHIP_HTML = raw('<span class="fileTreeFileAddDel countsPending">(+…|-…)</span>');

/**
 * Build the file tree of a commit's file changes.
 * @param repo The current repository.
 * @param repos The known repositories (a path inside the commit that is a repository is a submodule).
 * @param gitFiles The file changes.
 * @param codeReview The code review in progress, if any (files still to review are marked).
 */
export function createFileTree(repo: string, repos: GG.GitRepoSet, gitFiles: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null): FileTreeFolder {
	let contents: FileTreeFolderContents = {};
	const files: FileTreeFolder = { type: 'folder', name: '', folderPath: '', contents: contents, open: true, reviewed: true };

	for (let i = 0; i < gitFiles.length; i++) {
		let cur = files;
		const path = gitFiles[i].newFilePath.split('/');
		let absPath = repo;
		for (let j = 0; j < path.length; j++) {
			absPath += '/' + path[j];
			if (typeof repos[absPath] !== 'undefined') {
				if (typeof cur.contents[path[j]] === 'undefined') {
					cur.contents[path[j]] = { type: 'repo', name: path[j], path: absPath };
				}
				break;
			} else if (j < path.length - 1) {
				if (typeof cur.contents[path[j]] === 'undefined') {
					contents = {};
					cur.contents[path[j]] = { type: 'folder', name: path[j], folderPath: absPath.substring(repo.length + 1), contents: contents, open: true, reviewed: true };
				}
				cur = <FileTreeFolder>cur.contents[path[j]];
			} else if (path[j] !== '') {
				cur.contents[path[j]] = { type: 'file', name: path[j], index: i, reviewed: codeReview === null || !codeReview.remainingFiles.includes(gitFiles[i].newFilePath) };
			}
		}
	}

	if (codeReview !== null) calcFileTreeFoldersReviewed(files);
	return files;
}

export function generateFileViewHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, type: GG.FileViewType, isUncommitted: boolean, pendingCounts: ReadonlySet<string> | null, options: FileViewOptions): SafeHtml {
	return type === GG.FileViewType.List
		? generateFileListHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, pendingCounts, options)
		: generateFileTreeHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, pendingCounts, true, options);
}

function generateFileTreeHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean, pendingCounts: ReadonlySet<string> | null, topLevelFolder: boolean, options: FileViewOptions): SafeHtml {
	const curFolderInfo = topLevelFolder || !options.compactFolders
		? { folder: folder, name: folder.name, pathSeg: folder.name }
		: getCurrentFolderInfo(folder, folder.name, folder.name);

	const children = sortFolderKeys(curFolderInfo.folder).map((key) => {
		const cur = curFolderInfo.folder.contents[key];
		return cur.type === 'folder'
			? generateFileTreeHtml(cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, pendingCounts, false, options)
			: generateFileTreeLeafHtml(cur.name, cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, pendingCounts, options);
	});

	const open = curFolderInfo.folder.open;
	return html`${topLevelFolder ? '' : html`<li${open ? '' : html` class="closed"`} data-pathseg="${encodeURIComponent(curFolderInfo.pathSeg)}"><span class="fileTreeFolder${curFolderInfo.folder.reviewed ? '' : ' pendingReview'}" title="./${curFolderInfo.folder.folderPath}" data-folderpath="${encodeURIComponent(curFolderInfo.folder.folderPath)}"><span class="fileTreeFolderIcon">${open ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder}</span><span class="gitFolderName">${curFolderInfo.name}</span></span>`}<ul class="fileTreeFolderContents${open ? '' : ' hidden'}">${joinHtml(children)}</ul>${topLevelFolder ? '' : raw('</li>')}`;
}

function getCurrentFolderInfo(folder: FileTreeFolder, name: string, pathSeg: string): { folder: FileTreeFolder, name: string, pathSeg: string } {
	const keys = Object.keys(folder.contents);
	let child: FileTreeNode;
	return keys.length === 1 && (child = folder.contents[keys[0]]).type === 'folder'
		? getCurrentFolderInfo(<FileTreeFolder>child, name + ' / ' + child.name, pathSeg + '/' + child.name)
		: { folder: folder, name: name, pathSeg: pathSeg };
}

function generateFileListHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean, pendingCounts: ReadonlySet<string> | null, options: FileViewOptions): SafeHtml {
	const sortLeaves = (folder: FileTreeFolder, folderPath: string) => {
		const keys = sortFolderKeys(folder);
		let items: { relPath: string, leaf: FileTreeLeaf }[] = [];
		for (let i = 0; i < keys.length; i++) {
			const cur = folder.contents[keys[i]];
			const relPath = (folderPath !== '' ? folderPath + '/' : '') + cur.name;
			if (cur.type === 'folder') {
				items = items.concat(sortLeaves(cur, relPath));
			} else {
				items.push({ relPath: relPath, leaf: cur });
			}
		}
		return items;
	};
	const sortedLeaves = sortLeaves(folder, '');
	return html`<ul class="fileTreeFolderContents">${sortedLeaves.map((item) => generateFileTreeLeafHtml(item.relPath, item.leaf, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, pendingCounts, options))}</ul>`;
}

/** The "M (a → b)" message describing what happened to a file, shown in tooltips. */
function fileChangeTypeMessage(file: GG.GitFileChange): string {
	return getGitFileChangeTypeName(file.type) + (file.type === GG.GitFileStatus.Renamed ? ' (' + escapeHtml(file.oldFilePath).html + ' → ' + escapeHtml(file.newFilePath).html + ')' : '');
}

/**
 * Whether a file's settled line counts mark it as binary (both null once counts are no longer
 * pending). Every file can be diffed — a binary one just opens the Binary Compare tab's hex or
 * picture view instead of the native text Diff View. Untracked files never carry counts (they
 * are diffed by opening the new file directly, so their content never needs to be known here).
 * A comparison against the working tree never has its counts computed at all (by design - see
 * initialiseLineCounts), so null counts there mean "never asked for", not "binary"; such files
 * fall back to the text Diff View, same as before the Binary Compare tab existed.
 */
export function fileIsBinary(file: GG.GitFileChange, type: GG.GitFileStatus, pending: boolean, isUncommitted: boolean): boolean {
	return !isUncommitted && !pending && type !== GG.GitFileStatus.Untracked && file.additions === null && file.deletions === null;
}

/** The tooltip of a file row: what clicking it does, then what happened to it. Only ever called once a file's counts have settled, so it is never in the working-tree comparison case. */
function fileRowTitle(file: GG.GitFileChange): string {
	return strings.clickToViewDiff + (fileIsBinary(file, file.type, false, false) ? strings.binaryFileSuffix : '') + ' • ' + fileChangeTypeMessage(file);
}

/** The `(+N|-M)` counts chip of a modified or renamed text file. */
function fileCountsChipHtml(file: GG.GitFileChange): SafeHtml {
	const additions = formatStr(file.additions !== 1 ? strings.additionPlural : strings.additionSingular, String(file.additions));
	const deletions = formatStr(file.deletions !== 1 ? strings.deletionPlural : strings.deletionSingular, String(file.deletions));
	return html`<span class="fileTreeFileAddDel">(<span ${helpTooltipAttrs(additions, 'fileTreeFileAdd')}>+${file.additions}</span>|<span ${helpTooltipAttrs(deletions, 'fileTreeFileDel')}>-${file.deletions}</span>)</span>`;
}

function generateFileTreeLeafHtml(name: string, leaf: FileTreeLeaf, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean, pendingCounts: ReadonlySet<string> | null, options: FileViewOptions): SafeHtml {
	if (leaf.type === 'file') {
		const fileTreeFile: GG.GitFileChange = gitFiles[leaf.index];
		const type = fileTreeFile.type;
		const pending = pendingCounts !== null && pendingCounts.has(fileTreeFile.newFilePath);
		const isBinary = fileIsBinary(fileTreeFile, fileTreeFile.type, pending, isUncommitted);
		const changeTypeMessage = fileChangeTypeMessage(fileTreeFile);
		let countsChip: SafeHtml | string = '';
		if (type !== GG.GitFileStatus.Added && type !== GG.GitFileStatus.Untracked && type !== GG.GitFileStatus.Deleted) {
			countsChip = fileTreeFile.additions !== null && fileTreeFile.deletions !== null
				? fileCountsChipHtml(fileTreeFile)
				: pending ? PENDING_COUNTS_CHIP_HTML : '';
		}
		return html`<li data-pathseg="${encodeURIComponent(name)}"><span class="fileTreeFileRecord${leaf.index === fileContextMenuOpen ? ' ' + CLASS_CONTEXT_MENU_ACTIVE : ''}" data-index="${leaf.index}"><span class="fileTreeFile gitDiffPossible${leaf.reviewed ? '' : ' ' + CLASS_PENDING_REVIEW}" title="${raw(strings.clickToViewDiff + (isBinary ? strings.binaryFileSuffix : '') + ' • ' + changeTypeMessage)}"><span class="fileTreeFileIcon">${SVG_ICONS.file}</span><span class="gitFileName ${type}">${name}</span></span>${options.enhancedAccessibility ? html`<span ${helpTooltipAttrs(changeTypeMessage, 'fileTreeFileType')}>${type}</span>` : ''}${countsChip}${fileTreeFile.newFilePath === lastViewedFile ? html`<span ${helpTooltipAttrs(strings.lastFileViewedTitle)} id="cdvLastFileViewed">${SVG_ICONS.eyeOpen}</span>` : ''}<button type="button" class="copyGitFile fileTreeFileAction" title="${strings.cdvMenuCopyAbsolutePath}" aria-label="${strings.cdvMenuCopyAbsolutePath}">${SVG_ICONS.copy}</button>${type !== GG.GitFileStatus.Deleted
			? html`${!isBinary && !isUncommitted ? html`<button type="button" class="viewGitFileAtRevision fileTreeFileAction" title="${strings.cdvMenuViewFileAtRevision}" aria-label="${strings.cdvMenuViewFileAtRevision}">${SVG_ICONS.commit}</button>` : ''}<button type="button" class="openGitFile fileTreeFileAction" title="${strings.cdvMenuOpenFile}" aria-label="${strings.cdvMenuOpenFile}">${SVG_ICONS.openFile}</button>`
			: ''}</span></li>`;
	} else {
		return html`<li data-pathseg="${encodeURIComponent(name)}"><span class="fileTreeRepo" data-path="${encodeURIComponent(leaf.path)}" title="${strings.clickToViewRepo}"><span class="fileTreeRepoIcon">${SVG_ICONS.closedFolder}</span>${name}</span></li>`;
	}
}

/**
 * Patch one rendered file row in place after its line counts arrived — the tooltip and the
 * counts chip — without rebuilding the list, so a background batch never disturbs the view.
 */
export function patchFileRowCounts(record: HTMLElement, file: GG.GitFileChange) {
	const fileElem = <HTMLElement>record.children[0]; // span.fileTreeFile
	if (fileElem === null || !fileElem.classList.contains('fileTreeFile')) return;
	const pendingChip = record.querySelector(':scope > .countsPending');
	fileElem.setAttribute('title', fileRowTitle(file));
	if (pendingChip !== null) {
		if (file.type !== GG.GitFileStatus.Added && file.type !== GG.GitFileStatus.Untracked && file.type !== GG.GitFileStatus.Deleted && file.additions !== null && file.deletions !== null) {
			replaceWithHtml(pendingChip, fileCountsChipHtml(file));
		} else {
			pendingChip.remove();
		}
	}
}

export function alterFileTreeFolderOpen(folder: FileTreeFolder, folderPath: string, open: boolean) {
	const path = folderPath.split('/');
	let cur = folder;
	for (let i = 0; i < path.length; i++) {
		if (typeof cur.contents[path[i]] !== 'undefined') {
			cur = <FileTreeFolder>cur.contents[path[i]];
			if (i === path.length - 1) cur.open = open;
		} else {
			return;
		}
	}
}

export function alterFileTreeFileReviewed(folder: FileTreeFolder, filePath: string, reviewed: boolean) {
	const path = filePath.split('/'), folders = [folder];
	let cur = folder;
	for (let i = 0; i < path.length; i++) {
		if (typeof cur.contents[path[i]] !== 'undefined') {
			if (i < path.length - 1) {
				cur = <FileTreeFolder>cur.contents[path[i]];
				folders.push(cur);
			} else {
				(<FileTreeFile>cur.contents[path[i]]).reviewed = reviewed;
			}
		} else {
			break;
		}
	}

	// Recalculate whether each of the folders leading to the file are now reviewed (deepest first).
	for (let i = folders.length - 1; i >= 0; i--) {
		const keys = Object.keys(folders[i].contents);
		let entireFolderReviewed = true;
		for (let j = 0; j < keys.length; j++) {
			const node = folders[i].contents[keys[j]];
			if ((node.type === 'folder' || node.type === 'file') && !node.reviewed) {
				entireFolderReviewed = false;
				break;
			}
		}
		folders[i].reviewed = entireFolderReviewed;
	}
}

export function setFileTreeReviewed(folder: FileTreeFolder, reviewed: boolean) {
	folder.reviewed = reviewed;
	const keys = Object.keys(folder.contents);
	for (let i = 0; i < keys.length; i++) {
		const cur = folder.contents[keys[i]];
		if (cur.type === 'folder') {
			setFileTreeReviewed(cur, reviewed);
		} else if (cur.type === 'file') {
			cur.reviewed = reviewed;
		}
	}
}

function calcFileTreeFoldersReviewed(folder: FileTreeFolder) {
	const calc = (folder: FileTreeFolder) => {
		let reviewed = true;
		const keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			const cur = folder.contents[keys[i]];
			if ((cur.type === 'folder' && !calc(cur)) || (cur.type === 'file' && !cur.reviewed)) reviewed = false;
		}
		folder.reviewed = reviewed;
		return reviewed;
	};
	calc(folder);
}

export function updateFileTreeHtml(elem: HTMLElement, folder: FileTreeFolder) {
	const ul = getChildUl(elem);
	if (ul === null) return;

	for (let i = 0; i < ul.children.length; i++) {
		const li = <HTMLLIElement>ul.children[i];
		const pathSeg = decodeURIComponent(li.dataset.pathseg!);
		const child = getChildByPathSegment(folder, pathSeg);
		if (child.type === 'folder') {
			alterClass(<HTMLSpanElement>li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
			updateFileTreeHtml(li, child);
		} else if (child.type === 'file') {
			alterClass(<HTMLSpanElement>li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
		}
	}
}

export function updateFileTreeHtmlFileReviewed(elem: HTMLElement, folder: FileTreeFolder, filePath: string) {
	let path = filePath;
	const update = (elem: HTMLElement, folder: FileTreeFolder) => {
		const ul = getChildUl(elem);
		if (ul === null) return;

		for (let i = 0; i < ul.children.length; i++) {
			const li = <HTMLLIElement>ul.children[i];
			const pathSeg = decodeURIComponent(li.dataset.pathseg!);
			if (path === pathSeg || path.startsWith(pathSeg + '/')) {
				const child = getChildByPathSegment(folder, pathSeg);
				if (child.type === 'folder') {
					alterClass(<HTMLSpanElement>li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
					path = path.substring(pathSeg.length + 1);
					update(li, child);
				} else if (child.type === 'file') {
					alterClass(<HTMLSpanElement>li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
				}
				break;
			}
		}
	};
	update(elem, folder);
}

/** The paths of the files in a tree, in tree order. */
export function getFilesInTree(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>) {
	const files: string[] = [];
	const scanFolder = (folder: FileTreeFolder) => {
		const keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			const cur = folder.contents[keys[i]];
			if (cur.type === 'folder') {
				scanFolder(cur);
			} else if (cur.type === 'file') {
				files.push(gitFiles[cur.index].newFilePath);
			}
		}
	};
	scanFolder(folder);
	return files;
}

function sortFolderKeys(folder: FileTreeFolder) {
	const keys = Object.keys(folder.contents);
	keys.sort((a, b) => folder.contents[a].type !== 'file' && folder.contents[b].type === 'file' ? -1 : folder.contents[a].type === 'file' && folder.contents[b].type !== 'file' ? 1 : folder.contents[a].name.localeCompare(folder.contents[b].name));
	return keys;
}

function getChildByPathSegment(folder: FileTreeFolder, pathSeg: string) {
	let cur: FileTreeNode = folder;
	const comps = pathSeg.split('/');
	for (let i = 0; i < comps.length; i++) {
		cur = (<FileTreeFolder>cur).contents[comps[i]];
	}
	return cur;
}

/** Whether the files of a commit changed (only the file identities take part, not their line counts). */
export function haveFilesChanged(oldFiles: ReadonlyArray<GG.GitFileChange> | null, newFiles: ReadonlyArray<GG.GitFileChange> | null) {
	if ((oldFiles === null) !== (newFiles === null)) {
		return true;
	} else if (oldFiles === null && newFiles === null) {
		return false;
	} else {
		// Only the file identities take part: the line counts are served lazily (the host
		// reports additions/deletions as NULL and the counts settle per file afterwards), so
		// counting them here would declare every refresh response "changed" — rebuilding the
		// tree, dropping the user's folder expansion and resetting every settled count.
		return !arraysEqual(oldFiles!, newFiles!, (a, b) => a.newFilePath === b.newFilePath && a.oldFilePath === b.oldFilePath && a.type === b.type);
	}
}

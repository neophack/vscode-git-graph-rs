/* The Commit Details View's file list pane: the changed-files list (flat or as a tree) - its view
   type controls, its folder rows, its scrolling, and the re-render a view type switch performs.
   The row interactions themselves live in fileActions.ts, the row markup in fileTree.ts. */

import { alterClass, CLASS_ACTIVE, ListenerGroup } from '../../common/dom';
import { setHtml } from '../../common/html';
import * as GG from '../../common/protocol';
import { SVG_ICONS } from '../../common/icons';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import type { Store } from '../state/store';
import { ExpandedCommit } from '../state/types';
import { makeFileViewInteractive } from './fileActions';
import { FileViewOptions, generateFileViewHtml, alterFileTreeFolderOpen } from './fileTree';
import { PanelSurface } from './panelSurface';
import { byId } from './panelDom';

/** The file view type in effect: the repository's own choice, or the setting's when it is Default. */
export function getFileViewType(store: Store): GG.FileViewType {
	return store.repoState.fileViewType === GG.FileViewType.Default
		? store.config.commitDetailsView.fileViewType
		: store.repoState.fileViewType;
}

export function getFileViewOptions(store: Store): FileViewOptions {
	const config = store.config;
	return { compactFolders: config.commitDetailsView.fileTreeCompactFolders, enhancedAccessibility: config.enhancedAccessibility };
}

/**
 * Switch the file view between its list and tree types: only the file view re-renders (its
 * listeners are rewired from their own store, F3 - the rest of the open panel's stay live).
 */
export function changeFileViewType(ctx: GraphContext, getScope: () => ParentNode, fileViewListeners: ListenerGroup, type: GG.FileViewType) {
	const store = ctx.store, expandedCommit = store.expandedCommit, filesElem = byId(getScope(), 'cdvFiles');
	if (expandedCommit === null || expandedCommit.fileTree === null || expandedCommit.fileChanges === null || filesElem === null) return;
	ctx.details.closeContextMenuIfOpen(expandedCommit);
	store.slices.repos.updateRepoState(store.currentRepo, 'fileViewType', type);
	ctx.persistence.saveRepoState();
	const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
	setHtml(filesElem, generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED, expandedCommit.lineCounts.pending, getFileViewOptions(store)));
	fileViewListeners.removeAll();
	makeFileViewInteractive(ctx, getScope(), fileViewListeners);
	renderFileViewTypeBtns(ctx, getScope);
	ctx.details.lineCounts.scheduleVisible();
}

/** Toggle one folder row of the file tree in the DOM (its icon, and its contents). */
export function toggleFolder(folderElem: HTMLElement) {
	const parent = folderElem.parentElement!;
	parent.classList.toggle('closed');
	const isOpen = !parent.classList.contains('closed');
	setHtml(parent.children[0].children[0], isOpen ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder);
	parent.children[1].classList.toggle('hidden');
}

/** Open or close every folder row of the file tree, in the DOM and in the open view's tree state. */
export function openFolders(ctx: GraphContext, getScope: () => ParentNode, open: boolean) {
	const store = ctx.store, expandedCommit = store.expandedCommit;
	if (expandedCommit === null || expandedCommit.fileTree === null) return;
	const folders = getScope().querySelectorAll('.fileTreeFolder');
	for (let i = 0; i < folders.length; i++) {
		const sourceElem = <HTMLElement>(folders[i]);
		const parent = sourceElem.parentElement!;
		if (open) {
			parent.classList.remove('closed');
			setHtml(sourceElem.children[0].children[0], SVG_ICONS.openFolder);
			parent.children[1].classList.remove('hidden');
		} else {
			parent.classList.add('closed');
			setHtml(sourceElem.children[0].children[0], SVG_ICONS.closedFolder);
			parent.children[1].classList.add('hidden');
		}
		alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath!), open);
	}
	ctx.persistence.saveState();
	ctx.details.lineCounts.scheduleVisible();
}

/** Reflect the effective file view type on the view type buttons (and hide the folder buttons in the list view). */
export function renderFileViewTypeBtns(ctx: GraphContext, getScope: () => ParentNode) {
	const store = ctx.store;
	if (store.expandedCommit === null) return;
	const scope = getScope();
	const treeBtnElem = byId(scope, 'cdvFileViewTypeTree'), listBtnElem = byId(scope, 'cdvFileViewTypeList');
	if (treeBtnElem === null || listBtnElem === null) return;

	const listView = getFileViewType(store) === GG.FileViewType.List;
	alterClass(treeBtnElem, CLASS_ACTIVE, !listView);
	alterClass(listBtnElem, CLASS_ACTIVE, listView);
	const btns = scope.querySelectorAll('.cdvFolderBtn');
	for (let i = 0; i < btns.length; i++) {
		if (listView) btns[i].classList.add('hidden');
		else btns[i].classList.remove('hidden');
	}
}

/** Wire the file view type and the folder expand/collapse buttons (their listeners live on the current render's surface store, F3). */
export function wireFileViewControls(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode, fileViewListeners: ListenerGroup) {
	surface.listen(byId(getScope(), 'cdvFileViewTypeTree')!, 'click', () => {
		changeFileViewType(ctx, getScope, fileViewListeners, GG.FileViewType.Tree);
	});
	surface.listen(byId(getScope(), 'cdvFileViewTypeList')!, 'click', () => {
		changeFileViewType(ctx, getScope, fileViewListeners, GG.FileViewType.List);
	});
	surface.listen(byId(getScope(), 'cdvCollapse')!, 'click', () => {
		openFolders(ctx, getScope, false);
	});
	surface.listen(byId(getScope(), 'cdvExpand')!, 'click', () => {
		openFolders(ctx, getScope, true);
	});
}

/** Observe the file list's scrolling: record its position, settle the visible rows' line counts, and close its context menu if one is open. */
export function wireFileViewScroll(ctx: GraphContext, surface: PanelSurface, getScope: () => ParentNode, expandedCommit: ExpandedCommit) {
	const store = ctx.store;
	surface.observeScroll(byId(getScope(), ctx.details.getFilesScrollElemId()), expandedCommit.scrollTop.fileView, (scrollTop) => {
		if (store.expandedCommit === null) return;
		store.slices.details.setScroll('fileView', scrollTop);
		ctx.details.lineCounts.scheduleVisible();
		if (store.expandedCommit.contextMenuOpen.fileView > -1) {
			store.slices.details.setContextMenuFileView(-1);
			ctx.contextMenu.close();
		}
	}, () => ctx.persistence.saveState());
}

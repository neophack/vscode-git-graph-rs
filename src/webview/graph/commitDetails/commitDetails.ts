/**
 * The Commit Details View: the panel that expands a commit (or a comparison of two commits) to
 * show its details and its changed files - inline under the commit's row, docked to the bottom of
 * the view, or as a full-screen sheet in the mobile layout - together with the file tree, the
 * deferred line counts and the code review.
 *
 * This module is the view's shell: it opens and closes the panel, places it in the layout, renders
 * its skeleton and hands the panes their wiring. `panelGeometry.ts` owns the panel's height and
 * divider; the panes render and wire their own content: `summaryPane.ts` (the summary card and the
 * message body), `fileViewPane.ts` (the file list and its controls), `codeReviewPane.ts` (the
 * review actions), with `fileTree.ts`, `fileActions.ts`, `mobileSummary.ts` and `lineCounts.ts`
 * as before.
 */

import { insertAfter, ListenerGroup } from '../../common/dom';
import { html, SafeHtml, setHtml } from '../../common/html';
import { strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { ensureWidgetStyles } from '../../common/onDemandStyles';
import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { Component } from '../component';
import { GraphContext } from '../context';
import { measureBoundingClientRect, measureClientSize, measureOffsetTop } from '../render/measure';
import { ExpandedCommit } from '../state/types';
import { renderExternalDiffBtn, startCodeReview, updateFileState, wireCodeReviewBtn, wireExternalDiffBtn } from './codeReviewPane';
import { CommitDetailsSurface } from './detailsSurface';
import { makeFileViewInteractive } from './fileActions';
import { createFileTree, generateFileViewHtml, haveFilesChanged } from './fileTree';
import { getFileViewOptions, getFileViewType, renderFileViewTypeBtns, toggleFolder, wireFileViewControls, wireFileViewScroll } from './fileViewPane';
import { LineCounts } from './lineCounts';
import { getMobileCdvTitle, renderMobileFilesHeader } from './mobileSummary';
import { makeDividerDraggable, makeHeightResizable, setDivider, setHeight } from './panelGeometry';
import { PanelSurface } from './panelSurface';
import { renderSummary, wireMessageBodyControls, wireSummaryScroll } from './summaryPane';

const CLASS_COMMIT_DETAILS_OPEN = 'commitDetailsOpen';

/**
 * The Commit Details View: the panel that expands a commit (or a comparison of two commits) to
 * show its details and its changed files - inline under the commit's row, docked to the bottom of
 * the view, or as a full-screen sheet in the mobile layout - together with the file tree, the
 * deferred line counts and the code review.
 *
 * One instance serves every open of the view (F3): the open panel (#cdv) is the component's
 * "surface" — the controls' listeners registered on each render live in the surface store,
 * cleared when the next render replaces the content or the view closes, and the file list's
 * listeners (rewired independently when only the file view changes) live in their own group.
 * Every DOM lookup runs under #cdv; the document is touched only to create or place it.
 */
export class CommitDetails extends Component implements CommitDetailsSurface {
	public readonly lineCounts: LineCounts;

	/** The open view's element (#cdv), or NULL while the view is closed. */
	private elem: HTMLElement | null = null;

	/** The open view's element (#cdv), or NULL when closed (for the commit table's sanctioned cross-component lookup). */
	public get openElem(): HTMLElement | null {
		return this.elem;
	}
	/** The file list's listeners, rewired when only the file view re-renders (a type switch). */
	private readonly fileViewListeners = new ListenerGroup();

	/**
	 * The panes' share of this render's wiring (F3): a pane registers its controls' listeners and
	 * scroll observers through this handle, and they land in the surface store — cleared together
	 * with the shell's own when the next render replaces the content or the view closes.
	 */
	private readonly surface: PanelSurface = {
		listen: (target, type, listener) => this.listenOnSurface(target, type, listener),
		makeKeyboardActivatable: (elem) => this.makeSurfaceKeyboardActivatable(elem),
		observeScroll: (elem, initialScrollTop, onScroll, onScrolled) => this.observeSurfaceElemScroll(elem, initialScrollTop, onScroll, onScrolled)
	};

	/** The subtree the panes' DOM lookups run against: the open view, or the document before one is open. */
	private readonly getScope = (): ParentNode => this.scope;

	constructor(private readonly ctx: () => GraphContext) {
		super(document);
		this.lineCounts = new LineCounts(ctx, () => this.elem);
	}

	/** The subtree DOM lookups run against: the open view, or the document before one is open. */
	protected override get scope(): HTMLElement | Document {
		return this.elem !== null ? this.elem : this.root;
	}

	/**
	 * Wire the rendered file list (folder toggles, file actions, its context menu). Its listeners
	 * live in their own group (F3): a file-view-only re-render (a type switch) replaces just this
	 * wiring, while the rest of the open panel's stays live.
	 */
	private wireFileView() {
		this.fileViewListeners.removeAll();
		if (this.elem !== null) makeFileViewInteractive(this.ctx(), this.elem, this.fileViewListeners);
	}

	/** A disposed view leaves no listeners and no open panel behind (F3). */
	protected override onDispose(): void {
		this.fileViewListeners.removeAll();
		this.close(false);
	}

	private get store() {
		return this.ctx().store;
	}


	/* Opening & closing */

	/**
	 * The details view's styles are on demand: opening is the first use,
	 * so it kicks their chunk (idle-prefetched after the first paint) before anything renders.
	 */
	private ensureStyles() {
		ensureWidgetStyles(() => import('../../styles/onDemand'));
	}

	/** Open the Commit Details View of the commit whose row is `commitElem`. */
	public load(commitElem: HTMLElement) {
		const commit = this.store.getCommitOfElem(commitElem);
		if (commit === null) return;

		this.ensureStyles();
		this.close(false);
		commitElem = this.reserveSidePane(commitElem);
		this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, null, null);
		commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		this.render(false);
		this.requestCommitDetails(commit.hash, false);
	}

	/**
	 * The tablet's side pane narrows the list to two-line rows: reserve the pane and render those
	 * rows BEFORE the view opens (nothing is expanded yet, so the render cannot reopen anything).
	 * Rows are rebuilt, so the clicked row's element is looked up again; the scroll position keeps
	 * the same row under the finger across the row height change.
	 */
	private reserveSidePane(commitElem: HTMLElement) {
		const ctx = this.ctx(), layout = ctx.layout;
		if (!layout.isCdvSidePane() || layout.isTwoLineRows()) return commitElem;
		const view = ctx.dom.view, before = layout.getRowHeight(), scrollTop = view.scrollTop;
		layout.openSidePane();
		ctx.table.render();
		const after = layout.getRowHeight();
		if (before > 0 && after !== before) view.scrollTop = Math.round(scrollTop * after / before);
		return ctx.table.findCommitElem(parseInt(commitElem.dataset.id!)) || commitElem;
	}

	/** Close the open Commit Details View (or Commit Comparison). */
	public close(saveAndRender: boolean) {
		const ctx = this.ctx(), store = ctx.store, expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return;

		// The panel's listeners go with it (F3): they lived on the surface and file-view stores
		this.clearSurfaceListeners();
		this.fileViewListeners.removeAll();
		const elem = this.elem, isDocked = ctx.layout.isCdvDocked();
		if (elem !== null) {
			elem.remove();
			this.elem = null;
		}
		if (isDocked) {
			ctx.dom.view.style.bottom = '0px';
		}
		if (ctx.layout.isCdvSidePane()) {
			// The tablet layout's list-detail split: the list takes the pane's width back
			ctx.layout.closeSidePane();
			ctx.columns.applyGraphColumnAutoLayout();
			// The single-line rows come back with the full width (deferred: close() may run inside a render)
			ctx.renderScheduler.request();
		}
		if (expandedCommit.commitElem !== null) {
			expandedCommit.commitElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		if (expandedCommit.compareWithElem !== null) {
			expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		this.closeContextMenuIfOpen(expandedCommit);
		store.slices.details.close();
		if (saveAndRender) {
			ctx.persistence.saveState();
			if (!isDocked) {
				ctx.table.renderGraph();
			}
		}
	}

	/** Is the Commit Details View (or Comparison) of exactly these commits open. */
	public isOpen(commitHash: string, compareWithHash: string | null) {
		const expandedCommit = this.store.expandedCommit;
		return expandedCommit !== null && expandedCommit.commitHash === commitHash && expandedCommit.compareWithHash === compareWithHash;
	}

	private saveExpandedCommitLoading(index: number, commitHash: string, commitElem: HTMLElement, compareWithHash: string | null, compareWithElem: HTMLElement | null) {
		this.store.slices.details.open({
			index: index,
			commitHash: commitHash,
			commitElem: commitElem,
			compareWithHash: compareWithHash,
			compareWithElem: compareWithElem,
			commitDetails: null,
			fileChanges: null,
			fileTree: null,
			avatar: null,
			codeReview: null,
			lastViewedFile: null,
			loading: true,
			entered: false,
			showMarkdown: true,
			lineCounts: {
				pending: null,
				requested: new Set<string>(),
				queue: [],
				byPath: null,
				chunkInFlight: false,
				scrollTimer: 0
			},
			scrollTop: {
				summary: 0,
				fileView: 0
			},
			contextMenuOpen: {
				summary: false,
				fileView: -1
			}
		});
		this.ctx().persistence.saveState();
	}

	/**
	 * The details of a commit arrived: show them (a `commitDetails` response). The file tree is
	 * built here, from the response's own file changes, only when the files changed since the
	 * open view's data — an unchanged set keeps the built tree (and its folder toggles) as is.
	 */
	public showDetails(commitDetails: GG.GitCommitDetails, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.commitHash !== commitDetails.hash || expandedCommit.compareWithHash !== null) return;

		const filesChanged = haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges);
		this.store.slices.details.applyResponseData(filesChanged ? {
			commitDetails: commitDetails, fileChanges: commitDetails.fileChanges, fileTree: createFileTree(this.store.currentRepo, this.store.repos, commitDetails.fileChanges, codeReview),
			avatar: avatar, codeReview: codeReview, lastViewedFile: refresh ? undefined : lastViewedFile, loading: false
		} : {
			commitDetails: commitDetails, avatar: avatar, codeReview: codeReview,
			lastViewedFile: refresh ? undefined : lastViewedFile, loading: false
		});
		if (filesChanged) {
			this.closeContextMenuIfOpen(expandedCommit);
			this.lineCounts.initialise();
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		this.ctx().persistence.saveState();

		this.render(refresh);
	}

	/** Open the Commit Comparison of two commits inline. */
	public loadComparison(commitElem: HTMLElement, compareWithElem: HTMLElement) {
		const store = this.store;
		const commit = store.getCommitOfElem(commitElem);
		const compareWithCommit = store.getCommitOfElem(compareWithElem);

		if (commit !== null && compareWithCommit !== null) {
			this.ensureStyles();
			if (store.expandedCommit !== null) {
				if (store.expandedCommit.commitHash !== commit.hash) {
					this.close(false);
				} else if (store.expandedCommit.compareWithHash !== compareWithCommit.hash) {
					this.closeComparison(false);
				}
			}

			this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, compareWithCommit.hash, compareWithElem);
			commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
			compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
			this.render(false);
			this.requestCommitComparison(commit.hash, compareWithCommit.hash, false);
		}
	}

	/** Close the Commit Comparison, optionally returning to the Commit Details View of the first commit. */
	public closeComparison(saveAndRequestCommitDetails: boolean) {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.compareWithHash === null) return;

		if (expandedCommit.compareWithElem !== null) {
			expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		this.closeContextMenuIfOpen(expandedCommit);
		if (saveAndRequestCommitDetails) {
			if (expandedCommit.commitElem !== null) {
				this.saveExpandedCommitLoading(expandedCommit.index, expandedCommit.commitHash, expandedCommit.commitElem, null, null);
				this.render(false);
				this.requestCommitDetails(expandedCommit.commitHash, false);
			} else {
				this.close(true);
			}
		}
	}

	/**
	 * The changes between two commits arrived: show them (a `compareCommits` response). As with
	 * the details response, the file tree is built here and only when the files changed.
	 */
	public showComparison(commitHash: string, compareWithHash: string, fileChanges: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.compareWithElem === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash) return;

		const filesChanged = haveFilesChanged(expandedCommit.fileChanges, fileChanges);
		this.store.slices.details.applyResponseData(filesChanged ? {
			fileChanges: fileChanges, fileTree: createFileTree(this.store.currentRepo, this.store.repos, fileChanges, codeReview),
			codeReview: codeReview, lastViewedFile: refresh ? undefined : lastViewedFile, loading: false
		} : {
			codeReview: codeReview, lastViewedFile: refresh ? undefined : lastViewedFile, loading: false
		});
		if (filesChanged) {
			this.closeContextMenuIfOpen(expandedCommit);
			this.lineCounts.initialise();
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		this.ctx().persistence.saveState();

		this.render(refresh);
	}


	/* Requests */

	public requestCommitDetails(hash: string, refresh: boolean) {
		const ctx = this.ctx(), store = ctx.store;
		const commit = store.getCommit(hash);
		if (commit === undefined) return; // The commit is no longer loaded (e.g. after a refresh)
		ctx.bridge.send({
			command: 'commitDetails',
			repo: store.currentRepo,
			commitHash: hash,
			hasParents: commit.parents.length > 0,
			stash: commit.stash,
			avatarEmail: store.config.fetchAvatars && hash !== UNCOMMITTED ? commit.email : null,
			refresh: refresh
		});
	}

	public requestCommitComparison(hash: string, compareWithHash: string, refresh: boolean) {
		const ctx = this.ctx(), store = ctx.store;
		const commitOrder = store.getCommitOrder(hash, compareWithHash);
		ctx.bridge.send({
			command: 'compareCommits',
			repo: store.currentRepo,
			commitHash: hash, compareWithHash: compareWithHash,
			fromHash: commitOrder.from, toHash: commitOrder.to,
			refresh: refresh
		});
	}

	/**
	 * Open the changes between two commits in a dedicated Commit Comparison View tab (instead of
	 * expanding the inline comparison in the commit table). When `singleCommit` is set (the "Open
	 * Changes" action), the view presents the changes as belonging to one commit instead of a
	 * comparison between two.
	 */
	public openCompareTab(hash: string, compareWithHash: string, singleCommit: boolean = false) {
		const ctx = this.ctx(), store = ctx.store;
		const commitOrder = store.getCommitOrder(hash, compareWithHash);
		ctx.bridge.send({
			command: 'openCompareTab',
			repo: store.currentRepo,
			fromHash: commitOrder.from,
			toHash: commitOrder.to,
			singleCommit: singleCommit
		});
	}


	/* Rendering */

	/** The element the file list scrolls in: #cdvFiles in the wide layout; in the phone sheet and the tablet side pane the whole #cdvContent scrolls (summary and files together). */
	public getFilesScrollElemId() {
		return this.ctx().layout.isTouchLayout() ? 'cdvContent' : 'cdvFiles';
	}

	/** Render the Commit Details View / Commit Comparison (the loading state, or the loaded summary and files). */
	public render(refresh: boolean) {
		const ctx = this.ctx(), store = ctx.store, layout = ctx.layout, expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null) return;

		const expandedCommitLoaded = store.getCommitId(expandedCommit.commitHash) !== null;
		if (!expandedCommit.loading && !expandedCommitLoaded) return; // The commit is no longer loaded (e.g. after a refresh)

		// This render replaces the panel's content: the previous render's wiring dies here (F3),
		// together with the file list's (rewired below from its own group).
		this.clearSurfaceListeners();
		this.fileViewListeners.removeAll();
		let elem = this.elem;
		const isDocked = layout.isCdvDocked();
		const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		const codeReviewPossible = !expandedCommit.loading && commitOrder.to !== UNCOMMITTED;
		// The phone sheet and the tablet side pane share one structure: a title bar over a single
		// scrolling page (summary card, "Files" header, file list)
		const isMobile = layout.isTouchLayout();
		const mobileActionsPossible = isMobile && !expandedCommit.loading && expandedCommit.compareWithHash === null && expandedCommitLoaded;
		const externalDiffPossible = !expandedCommit.loading && (expandedCommit.compareWithHash !== null || (expandedCommitLoaded && store.getCommit(expandedCommit.commitHash)!.parents.length > 0));

		// The file view controls: in the toolbar, or in the mobile sheet's "Files" section header
		const fileViewBtns = html`<button type="button" id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="${strings.fileListViewTitle}" aria-label="${strings.fileListViewTitle}">${SVG_ICONS.fileList}</button><button type="button" id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="${strings.fileTreeViewTitle}" aria-label="${strings.fileTreeViewTitle}">${SVG_ICONS.fileTree}</button><button type="button" id="cdvCollapse" class="cdvControlBtn cdvFolderBtn" title="${strings.collapseFoldersTitle}" aria-label="${strings.collapseFoldersTitle}">${SVG_ICONS.collapseAll}</button><button type="button" id="cdvExpand" class="cdvControlBtn cdvFolderBtn" title="${strings.expandFoldersTitle}" aria-label="${strings.expandFoldersTitle}">${SVG_ICONS.expandAll}</button>`;

		if (elem === null) {
			elem = document.createElement(isDocked ? 'div' : 'tr');
			elem.id = 'cdv';
			elem.className = isDocked ? 'docked' : 'inline';
			this.elem = elem;
			setHeight(ctx, elem, isDocked);
			if (isDocked) {
				document.body.appendChild(elem);
				if (layout.isCdvSidePane()) {
					// The tablet layout's list-detail split: the list narrows to make room for the pane
					layout.openSidePane();
					ctx.columns.applyGraphColumnAutoLayout();
				}
			} else {
				insertAfter(elem, expandedCommit.commitElem);
			}
		} else if (!isDocked && elem.previousElementSibling !== expandedCommit.commitElem) {
			// The row identity changed under it (e.g. a table rebuild elsewhere) - move the EXISTING
			// element to sit after the (possibly new) commit row instead of destroying and recreating
			// it: a plain refresh of the same open commit (unrelated data elsewhere changing) never hits
			// this branch, so its scroll position, event listeners and DOM identity are left completely
			// untouched - what used to look like the commit "reopening" on every background refresh.
			insertAfter(elem, expandedCommit.commitElem);
		}

		// The fade-in animation (see #cdv.inline / #cdv.docked in the stylesheet) restarts whenever
		// the element is disconnected and reconnected to the document - which happens even when its
		// DOM reference is carefully preserved and reinserted (a table rebuild replaces the WHOLE
		// table element the row used to belong to). Let it play once, on the render that actually
		// opens the commit; every later render of the same open commit explicitly disables it, so no
		// amount of background refreshing can make the panel visibly flash again.
		elem.style.animation = expandedCommit.entered ? 'none' : '';
		this.store.slices.details.markEntered();

		let content: SafeHtml;
		if (expandedCommit.loading) {
			content = html`<div id="cdvLoading">${SVG_ICONS.loading} ${expandedCommit.compareWithHash === null ? expandedCommit.commitHash !== UNCOMMITTED ? strings.loadingCommitDetails : strings.loadingUncommittedChanges : strings.loadingCommitComparison}</div>`;
		} else {
			content = html`<div id="cdvSummary">${renderSummary(ctx, this.getScope, expandedCommit, commitOrder)}</div>${isMobile ? renderMobileFilesHeader(expandedCommit.fileChanges!, expandedCommit.lineCounts.pending, fileViewBtns) : ''}<div id="cdvFiles">${generateFileViewHtml(expandedCommit.fileTree!, expandedCommit.fileChanges!, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, getFileViewType(store), commitOrder.to === UNCOMMITTED, expandedCommit.lineCounts.pending, getFileViewOptions(store))}</div><div id="cdvDivider"></div>`;
		}
		// The mobile sheet's toolbar is a title bar: close, the commit's name, then its actions
		const inner = html`<div id="cdvContent">${content}</div><div id="cdvControls"><button type="button" id="cdvClose" class="cdvControlBtn" title="${strings.dialogClose}" aria-label="${strings.dialogClose}">${SVG_ICONS.close}</button>${isMobile ? html`<span id="cdvMobileTitle">${getMobileCdvTitle(expandedCommit, commitOrder)}</span>` : ''}${codeReviewPossible ? html`<button type="button" id="cdvCodeReview" class="cdvControlBtn">${SVG_ICONS.review}</button>` : ''}${!expandedCommit.loading && !isMobile ? fileViewBtns : ''}${externalDiffPossible ? html`<button type="button" id="cdvExternalDiff" class="cdvControlBtn">${SVG_ICONS.linkExternal}</button>` : ''}${mobileActionsPossible ? html`<button type="button" id="cdvMobileActions" class="cdvControlBtn" title="${strings.mobileMoreActions}" aria-label="${strings.mobileMoreActions}">${SVG_ICONS.ellipsis}</button>` : ''}</div><div class="cdvHeightResize"></div>`;

		setHtml(elem, isDocked ? inner : html`<td><div class="cdvHeightResize"></div></td><td colspan="${ctx.layout.getNumColumns() - 1}">${inner}</td>`);
		if (!expandedCommit.loading) setDivider(ctx, this.getScope);
		if (!isDocked) ctx.table.renderGraph();

		if (!refresh) {
			const viewElem = ctx.dom.view, headerHeight = ctx.viewport.getHeaderHeight();
			if (isDocked) {
				const elemTop = headerHeight + measureOffsetTop(expandedCommit.commitElem);
				if (elemTop - 8 < viewElem.scrollTop) {
					// Commit is above what is visible on screen
					viewElem.scroll(0, elemTop - 8);
				} else if (elemTop - measureClientSize(viewElem).height + 32 > viewElem.scrollTop) {
					// Commit is below what is visible on screen
					viewElem.scroll(0, elemTop - measureClientSize(viewElem).height + 32);
				}
			} else {
				const elemTop = headerHeight + measureOffsetTop(elem), cdvHeight = store.repoState.cdvHeight;
				if (store.config.commitDetailsView.autoCenter) {
					// Center Commit Detail View setting is enabled
					// elemTop - commit height [24px] + (commit details view height + commit height [24px]) / 2 - (view height) / 2
					viewElem.scroll(0, elemTop - 12 + (cdvHeight - measureClientSize(viewElem).height) / 2);
				} else if (elemTop - 32 < viewElem.scrollTop) {
					// Commit Detail View is opening above what is visible on screen
					// elemTop - commit height [24px] - desired gap from top [8px] < view scroll offset
					viewElem.scroll(0, elemTop - 32);
				} else if (elemTop + cdvHeight - measureClientSize(viewElem).height + 8 > viewElem.scrollTop) {
					// Commit Detail View is opening below what is visible on screen
					// elemTop + commit details view height + desired gap from bottom [8px] - view height > view scroll offset
					viewElem.scroll(0, elemTop + cdvHeight - measureClientSize(viewElem).height + 8);
				}
			}
		}

		makeHeightResizable(ctx, this.surface, this.getScope);
		wireMessageBodyControls(ctx, this.surface, this.getScope);
		this.listenOnSurface(this.byId('cdvClose')!, 'click', () => {
			this.close(true);
		});
		const mobileActionsBtn = this.byId('cdvMobileActions');
		if (mobileActionsBtn !== null) {
			this.listenOnSurface(mobileActionsBtn, 'click', (e) => {
				// Open the commit row's own context menu (the table's contextmenu handler builds it), as
				// the bottom action sheet of the mobile stylesheet. The click must not reach the
				// document listener that closes any open context menu.
				e.stopPropagation();
				const commitElem = store.expandedCommit !== null ? store.expandedCommit.commitElem : null;
				if (commitElem === null || !commitElem.isConnected) return;
				const rect = measureBoundingClientRect(mobileActionsBtn);
				commitElem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
			});
		}

		if (!expandedCommit.loading) {
			this.wireFileView();
			renderFileViewTypeBtns(ctx, this.getScope);
			renderExternalDiffBtn(ctx, this.getScope);
			makeDividerDraggable(ctx, this.surface, this.getScope);

			wireSummaryScroll(ctx, this.surface, this.getScope, expandedCommit);
			wireFileViewScroll(ctx, this.surface, this.getScope, expandedCommit);
			wireFileViewControls(ctx, this.surface, this.getScope, this.fileViewListeners);

			if (codeReviewPossible) {
				wireCodeReviewBtn(ctx, this.surface, this.getScope);
			}

			if (externalDiffPossible) {
				wireExternalDiffBtn(ctx, this.surface, this.getScope);
			}
		}
	}

	/* The panes' entry points */

	/** Toggle one folder row of the file tree in the DOM (its icon, and its contents). */
	public toggleFolder(folderElem: HTMLElement) {
		toggleFolder(folderElem);
	}

	/** Reflect the configured external diff tool on the external diff button. */
	public renderExternalDiffBtn() {
		renderExternalDiffBtn(this.ctx(), this.getScope);
	}

	/** Close the open context menu if it belongs to this view. */
	public closeContextMenuIfOpen(expandedCommit: ExpandedCommit) {
		if (expandedCommit.contextMenuOpen.summary || expandedCommit.contextMenuOpen.fileView > -1) {
			expandedCommit.contextMenuOpen.summary = false;
			expandedCommit.contextMenuOpen.fileView = -1;
			this.ctx().contextMenu.close();
		}
	}

	/**
	 * Update the state of a file in the Commit Details View.
	 * @param file The file that was affected.
	 * @param fileElem The element of the file.
	 * @param isReviewed TRUE/FALSE => set the file's reviewed state accordingly, NULL => don't update it.
	 * @param fileWasViewed Was the file viewed - if so, set it to be the last viewed file.
	 */
	public updateFileState(file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean) {
		updateFileState(this.ctx(), this.getScope, file, fileElem, isReviewed, fileWasViewed);
	}

	/** A code review was started (a `startCodeReview` response). */
	public startCodeReview(commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview) {
		startCodeReview(this.ctx(), this.getScope, commitHash, compareWithHash, codeReview);
	}
}

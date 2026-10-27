/**
 * The Commit Details View: the panel that expands a commit (or a comparison of two commits) to
 * show its details and its changed files - inline under the commit's row, docked to the bottom of
 * the view, or as a full-screen sheet in the mobile layout - together with the file tree, the
 * deferred line counts and the code review.
 */

import { formatLongDate } from '../../common/dates';
import { alterClass, CLASS_ACTIVE, CLASS_ENABLED, insertAfter, insertBeforeFirstChildWithClass, ListenerGroup } from '../../common/dom';
import { generateSignatureHtml } from '../../common/gitNames';
import { html, SafeHtml, setHtml } from '../../common/html';
import { formatStr, markup, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import { ensureWidgetStyles } from '../../common/onDemandStyles';
import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { Component } from '../component';
import { GraphContext } from '../context';
import { ExpandedCommit, FileTreeFolder } from '../state/types';
import { hasMarkdown, isMarkdownLoaded, loadMarkdown, renderMarkdown } from '../text/markdown';
import { CLASS_EXTERNAL_URL, CLASS_INTERNAL_URL, TextFormatter } from '../text/textFormatter';
import { makeFileViewInteractive } from './fileActions';
import { alterFileTreeFileReviewed, alterFileTreeFolderOpen, createFileTree, generateFileViewHtml, getFilesInTree, haveFilesChanged, setFileTreeReviewed, updateFileTreeHtml, updateFileTreeHtmlFileReviewed } from './fileTree';
import { LineCounts } from './lineCounts';
import { getCdvMessageBody, getMobileCdvTitle, renderMobileCommitSummary, renderMobileFilesHeader } from './mobileSummary';

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
export class CommitDetails extends Component {
	public readonly lineCounts: LineCounts;

	/** The open view's element (#cdv), or NULL while the view is closed. */
	private elem: HTMLElement | null = null;

	/** The open view's element (#cdv), or NULL when closed (for the commit table's sanctioned cross-component lookup). */
	public get openElem(): HTMLElement | null {
		return this.elem;
	}
	/** The file list's listeners, rewired when only the file view re-renders (a type switch). */
	private readonly fileViewListeners = new ListenerGroup();

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
	 * The details view's styles are on demand (task 5.9's CSS split): opening is the first use,
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

	/** The details of a commit arrived: show them (a `commitDetails` response). */
	public showDetails(commitDetails: GG.GitCommitDetails, fileTree: FileTreeFolder, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.commitHash !== commitDetails.hash || expandedCommit.compareWithHash !== null) return;

		const filesChanged = haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges);
		this.store.slices.details.applyResponseData(filesChanged ? {
			commitDetails: commitDetails, fileChanges: commitDetails.fileChanges, fileTree: fileTree,
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

	/** Build the file tree of a commit's file changes in the current repository. */
	public createFileTree(gitFiles: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null) {
		const store = this.store;
		return createFileTree(store.currentRepo, store.repos, gitFiles, codeReview);
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

	/** The changes between two commits arrived: show them (a `compareCommits` response). */
	public showComparison(commitHash: string, compareWithHash: string, fileChanges: ReadonlyArray<GG.GitFileChange>, fileTree: FileTreeFolder, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.compareWithElem === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash) return;

		const filesChanged = haveFilesChanged(expandedCommit.fileChanges, fileChanges);
		this.store.slices.details.applyResponseData(filesChanged ? {
			fileChanges: fileChanges, fileTree: fileTree,
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

	private getFileViewType() {
		const store = this.store;
		return store.repoState.fileViewType === GG.FileViewType.Default
			? store.config.commitDetailsView.fileViewType
			: store.repoState.fileViewType;
	}

	private getFileViewOptions() {
		const config = this.store.config;
		return { compactFolders: config.commitDetailsView.fileTreeCompactFolders, enhancedAccessibility: config.enhancedAccessibility };
	}

	private createMessageFormatter() {
		const store = this.store;
		return new TextFormatter(store.commits, store.getIssueLinkingConfig(), {
			commits: true,
			emoji: true,
			issueLinking: true,
			markdown: store.config.markdown,
			multiline: true,
			urls: true
		});
	}

	/**
	 * Render a commit message body: as block-level Markdown (with a toggle to switch to the plain
	 * inline-formatted view) when the `git-graph-rs.markdown` setting is on and the message looks
	 * like it contains Markdown, otherwise exactly as before (inline formatting only).
	 */
	private renderCommitMessageBody(expandedCommit: ExpandedCommit, body: string, textFormatter: TextFormatter): SafeHtml {
		const offerToggle = this.store.config.markdown && hasMarkdown(body);
		const showMarkdown = offerToggle && expandedCommit.showMarkdown;
		if (showMarkdown && !isMarkdownLoaded()) {
			// The Markdown renderer's on-demand chunk has not landed yet (task 5.9): paint the
			// plain inline-formatted body now - never blank, never blocked - and swap in the
			// rendered Markdown the moment the module resolves, provided this same commit is
			// still the open one.
			void loadMarkdown().then(() => {
				if (this.store.expandedCommit !== expandedCommit) return;
				const bodyElem = this.byId('cdvMessageBody');
				if (bodyElem !== null) setHtml(bodyElem, renderMarkdown(body));
			}, () => undefined);
			return html`<span id="cdvMessageBody">${textFormatter.format(body)}</span>${offerToggle ? html`<span id="cdvMarkdownToggle" class="cdvMarkdownToggle" role="button" tabindex="0">${strings.plainTextToggleLabel}</span>` : ''}`;
		}
		return html`<span id="cdvMessageBody">${showMarkdown ? renderMarkdown(body) : textFormatter.format(body)}</span>${offerToggle ? html`<span id="cdvMarkdownToggle" class="cdvMarkdownToggle" role="button" tabindex="0">${showMarkdown ? strings.plainTextToggleLabel : strings.markdownToggleLabel}</span>` : ''}`;
	}

	private mobileNote(content: SafeHtml | string): SafeHtml {
		return this.ctx().layout.isTouchLayout() ? html`<div class="cdvmNote">${content}</div>` : html`${content}`;
	}

	private renderSummary(expandedCommit: ExpandedCommit, commitOrder: { from: string, to: string }): SafeHtml {
		// The phone sheet and the tablet side pane share the stacked summary card
		const ctx = this.ctx(), store = ctx.store, isMobile = ctx.layout.isTouchLayout();
		if (expandedCommit.compareWithHash !== null) {
			// Commit comparison should be shown
			return this.mobileNote(formatStr(markup.displayingChangesFromTo, commitOrder.from, commitOrder.to !== UNCOMMITTED ? commitOrder.to : strings.uncommittedChangesLabel));
		}
		if (expandedCommit.commitHash === UNCOMMITTED) {
			return this.mobileNote(strings.displayingUncommitted);
		}

		// Commit details should be shown
		const textFormatter = this.createMessageFormatter();
		const commitDetails = expandedCommit.commitDetails!;
		const dateFormat = store.config.dateFormat;
		if (isMobile) {
			const body = getCdvMessageBody(commitDetails.body, true);
			return renderMobileCommitSummary({
				commitDetails: commitDetails,
				avatar: expandedCommit.avatar,
				textFormatter: textFormatter,
				dateFormat: dateFormat,
				isParentLoaded: (parent) => store.getCommitId(parent) !== null,
				renderMessageBlock: () => body !== '' || (store.config.markdown && hasMarkdown(commitDetails.body))
					? this.renderCommitMessageBody(expandedCommit, body, textFormatter)
					: null
			});
		}

		const parents: Array<SafeHtml | string> = [];
		commitDetails.parents.forEach((parent, i) => {
			if (i > 0) parents.push(', ');
			parents.push(store.getCommitId(parent) !== null
				? html`<span class="${CLASS_INTERNAL_URL}" data-type="commit" data-value="${parent}" tabindex="-1">${parent}</span>`
				: parent);
		});
		const person = (name: string, email: string) => html`${name}${email !== '' ? html` &lt;<a class="${CLASS_EXTERNAL_URL}" href="mailto:${email}" tabindex="-1">${email}</a>&gt;` : ''}`;
		return html`<span class="cdvSummaryTop${expandedCommit.avatar !== null ? ' withAvatar' : ''}"><span class="cdvSummaryTopRow"><span class="cdvSummaryKeyValues">${markup.cdvCommitLabel}${commitDetails.hash}<br>${markup.cdvParentsLabel}${commitDetails.parents.length > 0 ? parents : strings.noneValue}<br>${markup.cdvAuthorLabel}${person(commitDetails.author, commitDetails.authorEmail)}<br>${commitDetails.authorDate !== commitDetails.committerDate ? html`${markup.cdvAuthorDateLabel}${formatLongDate(commitDetails.authorDate, dateFormat)}<br>` : ''}${markup.cdvCommitterLabel}${person(commitDetails.committer, commitDetails.committerEmail)}${commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : ''}<br>${commitDetails.authorDate !== commitDetails.committerDate ? markup.cdvCommitterDateLabel : markup.cdvDateLabel}${formatLongDate(commitDetails.committerDate, dateFormat)}</span>${expandedCommit.avatar !== null ? html`<span class="cdvSummaryAvatar"><img src="${expandedCommit.avatar}"></span>` : ''}</span></span><br><br>${this.renderCommitMessageBody(expandedCommit, commitDetails.body, textFormatter)}`;
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
			this.setHeight(elem, isDocked);
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
			content = html`<div id="cdvSummary">${this.renderSummary(expandedCommit, commitOrder)}</div>${isMobile ? renderMobileFilesHeader(expandedCommit.fileChanges!, expandedCommit.lineCounts.pending, fileViewBtns) : ''}<div id="cdvFiles">${generateFileViewHtml(expandedCommit.fileTree!, expandedCommit.fileChanges!, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, this.getFileViewType(), commitOrder.to === UNCOMMITTED, expandedCommit.lineCounts.pending, this.getFileViewOptions())}</div><div id="cdvDivider"></div>`;
		}
		// The mobile sheet's toolbar is a title bar: close, the commit's name, then its actions
		const inner = html`<div id="cdvContent">${content}</div><div id="cdvControls"><button type="button" id="cdvClose" class="cdvControlBtn" title="${strings.dialogClose}" aria-label="${strings.dialogClose}">${SVG_ICONS.close}</button>${isMobile ? html`<span id="cdvMobileTitle">${getMobileCdvTitle(expandedCommit, commitOrder)}</span>` : ''}${codeReviewPossible ? html`<button type="button" id="cdvCodeReview" class="cdvControlBtn">${SVG_ICONS.review}</button>` : ''}${!expandedCommit.loading && !isMobile ? fileViewBtns : ''}${externalDiffPossible ? html`<button type="button" id="cdvExternalDiff" class="cdvControlBtn">${SVG_ICONS.linkExternal}</button>` : ''}${mobileActionsPossible ? html`<button type="button" id="cdvMobileActions" class="cdvControlBtn" title="${strings.mobileMoreActions}" aria-label="${strings.mobileMoreActions}">${SVG_ICONS.ellipsis}</button>` : ''}</div><div class="cdvHeightResize"></div>`;

		setHtml(elem, isDocked ? inner : html`<td><div class="cdvHeightResize"></div></td><td colspan="${ctx.layout.getNumColumns() - 1}">${inner}</td>`);
		if (!expandedCommit.loading) this.setDivider();
		if (!isDocked) ctx.table.renderGraph();

		if (!refresh) {
			const viewElem = ctx.dom.view, headerHeight = ctx.viewport.getHeaderHeight();
			if (isDocked) {
				const elemTop = headerHeight + expandedCommit.commitElem.offsetTop;
				if (elemTop - 8 < viewElem.scrollTop) {
					// Commit is above what is visible on screen
					viewElem.scroll(0, elemTop - 8);
				} else if (elemTop - viewElem.clientHeight + 32 > viewElem.scrollTop) {
					// Commit is below what is visible on screen
					viewElem.scroll(0, elemTop - viewElem.clientHeight + 32);
				}
			} else {
				const elemTop = headerHeight + elem.offsetTop, cdvHeight = store.repoState.cdvHeight;
				if (store.config.commitDetailsView.autoCenter) {
					// Center Commit Detail View setting is enabled
					// elemTop - commit height [24px] + (commit details view height + commit height [24px]) / 2 - (view height) / 2
					viewElem.scroll(0, elemTop - 12 + (cdvHeight - viewElem.clientHeight) / 2);
				} else if (elemTop - 32 < viewElem.scrollTop) {
					// Commit Detail View is opening above what is visible on screen
					// elemTop - commit height [24px] - desired gap from top [8px] < view scroll offset
					viewElem.scroll(0, elemTop - 32);
				} else if (elemTop + cdvHeight - viewElem.clientHeight + 8 > viewElem.scrollTop) {
					// Commit Detail View is opening below what is visible on screen
					// elemTop + commit details view height + desired gap from bottom [8px] - view height > view scroll offset
					viewElem.scroll(0, elemTop + cdvHeight - viewElem.clientHeight + 8);
				}
			}
		}

		this.makeHeightResizable();
		const markdownToggle = this.byId('cdvMarkdownToggle');
		if (markdownToggle !== null) {
			this.makeSurfaceKeyboardActivatable(markdownToggle);
			this.listenOnSurface(markdownToggle, 'click', () => this.toggleMessageMarkdown());
		}
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
				const rect = mobileActionsBtn.getBoundingClientRect();
				commitElem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
			});
		}

		if (!expandedCommit.loading) {
			this.wireFileView();
			this.renderFileViewTypeBtns();
			this.renderExternalDiffBtn();
			this.makeDividerDraggable();

			this.observeSurfaceElemScroll(this.byId('cdvSummary'), expandedCommit.scrollTop.summary, (scrollTop) => {
				if (store.expandedCommit === null) return;
				store.slices.details.setScroll('summary', scrollTop);
				if (store.expandedCommit.contextMenuOpen.summary) {
					store.slices.details.setContextMenuSummaryOpen(false);
					ctx.contextMenu.close();
				}
			}, () => ctx.persistence.saveState());

			this.observeSurfaceElemScroll(this.byId(this.getFilesScrollElemId()), expandedCommit.scrollTop.fileView, (scrollTop) => {
				if (store.expandedCommit === null) return;
				store.slices.details.setScroll('fileView', scrollTop);
				this.lineCounts.scheduleVisible();
				if (store.expandedCommit.contextMenuOpen.fileView > -1) {
					store.slices.details.setContextMenuFileView(-1);
					ctx.contextMenu.close();
				}
			}, () => ctx.persistence.saveState());

			this.listenOnSurface(this.byId('cdvFileViewTypeTree')!, 'click', () => {
				this.changeFileViewType(GG.FileViewType.Tree);
			});
			this.listenOnSurface(this.byId('cdvFileViewTypeList')!, 'click', () => {
				this.changeFileViewType(GG.FileViewType.List);
			});
			this.listenOnSurface(this.byId('cdvCollapse')!, 'click', () => {
				this.openFolders(false);
			});
			this.listenOnSurface(this.byId('cdvExpand')!, 'click', () => {
				this.openFolders(true);
			});

			if (codeReviewPossible) {
				this.renderCodeReviewBtn();
				this.listenOnSurface(this.byId('cdvCodeReview')!, 'click', (e) => {
					const expandedCommit = store.expandedCommit;
					if (expandedCommit === null || e.target === null) return;
					const sourceElem = <HTMLElement>(<Element>e.target).closest('#cdvCodeReview')!;
					if (sourceElem.classList.contains(CLASS_ACTIVE)) {
						ctx.bridge.send({ command: 'endCodeReview', repo: store.currentRepo, id: expandedCommit.codeReview!.id });
						this.endCodeReview();
					} else {
						const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
						const id = expandedCommit.compareWithHash !== null ? commitOrder.from + '-' + commitOrder.to : expandedCommit.commitHash;
						ctx.bridge.send({
							command: 'startCodeReview',
							repo: store.currentRepo,
							id: id,
							commitHash: expandedCommit.commitHash,
							compareWithHash: expandedCommit.compareWithHash,
							files: getFilesInTree(expandedCommit.fileTree!, expandedCommit.fileChanges!),
							lastViewedFile: expandedCommit.lastViewedFile
						});
					}
				});
			}

			if (externalDiffPossible) {
				this.listenOnSurface(this.byId('cdvExternalDiff')!, 'click', () => {
					const expandedCommit = store.expandedCommit;
					if (expandedCommit === null || store.gitConfig === null || (store.gitConfig.diffTool === null && store.gitConfig.guiDiffTool === null)) return;
					const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
					ctx.actions.run({
						command: 'openExternalDirDiff',
						repo: store.currentRepo,
						fromHash: commitOrder.from,
						toHash: commitOrder.to,
						isGui: store.gitConfig.guiDiffTool !== null
					}, strings.openingExternalDirDiff);
				});
			}
		}
	}

	private setHeight(elem: HTMLElement, isDocked: boolean) {
		const ctx = this.ctx(), repoState = ctx.store.repoState;
		let height = repoState.cdvHeight;
		const windowHeight = window.innerHeight;
		if (height > windowHeight - 40) {
			height = Math.max(windowHeight - 40, 100);
			if (height !== repoState.cdvHeight) {
				ctx.store.slices.repos.updateRepoState(ctx.store.currentRepo, 'cdvHeight', height);
				ctx.persistence.saveRepoState();
			}
		}

		const heightPx = height + 'px';
		elem.style.height = heightPx;
		// The tablet side pane spans the full height beside the list: nothing is reserved below it
		if (isDocked && !ctx.layout.isCdvSidePane()) ctx.dom.view.style.bottom = heightPx;
	}

	private setDivider() {
		const percent = (this.store.repoState.cdvDivider * 100).toFixed(2) + '%';
		const summaryElem = this.byId('cdvSummary'), dividerElem = this.byId('cdvDivider'), filesElem = this.byId('cdvFiles');
		if (summaryElem !== null) summaryElem.style.width = percent;
		if (dividerElem !== null) dividerElem.style.left = percent;
		if (filesElem !== null) filesElem.style.left = percent;
	}

	private makeHeightResizable() {
		const ctx = this.ctx(), repoState = ctx.store.repoState;
		let prevY = -1;

		const processResizingCdvHeight: EventListener = (e) => {
			if (prevY < 0) return;
			const delta = (<MouseEvent>e).pageY - prevY, isDocked = ctx.layout.isCdvDocked(), windowHeight = window.innerHeight;
			prevY = (<MouseEvent>e).pageY;
			let height = repoState.cdvHeight + (isDocked ? -delta : delta);
			if (height < 100) height = 100;
			else if (height > 600) height = 600;
			if (height > windowHeight - 40) height = Math.max(windowHeight - 40, 100);

			if (repoState.cdvHeight !== height) {
				ctx.store.slices.repos.updateRepoState(ctx.store.currentRepo, 'cdvHeight', height);
				const elem = this.byId('cdv');
				if (elem !== null) this.setHeight(elem, isDocked);
				if (!isDocked) ctx.table.renderGraph();
			}
		};
		const stopResizingCdvHeight: EventListener = (e) => {
			if (prevY < 0) return;
			processResizingCdvHeight(e);
			ctx.persistence.saveRepoState();
			prevY = -1;
			ctx.eventOverlay.remove();
		};

		// The handle is this panel's own element; the listener is surface-owned (F3)
		const handles = this.queryAll('.cdvHeightResize');
		for (let i = 0; i < handles.length; i++) {
			this.listenOnSurface(handles[i], 'mousedown', (e) => {
				prevY = (<MouseEvent>e).pageY;
				ctx.eventOverlay.create('rowResize', processResizingCdvHeight, stopResizingCdvHeight);
			});
		}
	}

	private makeDividerDraggable() {
		const ctx = this.ctx(), repoState = ctx.store.repoState;
		let minX = -1, width = -1;

		const processDraggingCdvDivider: EventListener = (e) => {
			if (minX < 0) return;
			let percent = ((<MouseEvent>e).clientX - minX) / width;
			if (percent < 0.2) percent = 0.2;
			else if (percent > 0.8) percent = 0.8;

			if (repoState.cdvDivider !== percent) {
				ctx.store.slices.repos.updateRepoState(ctx.store.currentRepo, 'cdvDivider', percent);
				this.setDivider();
			}
		};
		const stopDraggingCdvDivider: EventListener = (e) => {
			if (minX < 0) return;
			processDraggingCdvDivider(e);
			ctx.persistence.saveRepoState();
			minX = -1;
			ctx.eventOverlay.remove();
		};

		this.listenOnSurface(this.byId('cdvDivider')!, 'mousedown', () => {
			const contentElem = this.byId('cdvContent');
			if (contentElem === null) return;

			const bounds = contentElem.getBoundingClientRect();
			minX = bounds.left;
			width = bounds.width;
			ctx.eventOverlay.create('colResize', processDraggingCdvDivider, stopDraggingCdvDivider);
		});
	}


	/* The message body & the file view */

	/** Flip the Markdown / Plain toggle of the open commit, re-rendering only the message body and its toggle (no full re-render, so nothing scrolls or flashes). */
	private toggleMessageMarkdown() {
		const store = this.store, expandedCommit = store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitDetails === null || expandedCommit.commitHash === UNCOMMITTED) return;
		this.store.slices.details.toggleMarkdown();
		const textFormatter = this.createMessageFormatter();
		const bodyElem = this.byId('cdvMessageBody'), toggleElem = this.byId('cdvMarkdownToggle');
		if (bodyElem === null || toggleElem === null) return;
		const body = getCdvMessageBody(expandedCommit.commitDetails.body, this.ctx().layout.isTouchLayout());
		const renderBody = () => setHtml(bodyElem, expandedCommit.showMarkdown ? renderMarkdown(body) : textFormatter.format(body));
		if (expandedCommit.showMarkdown && !isMarkdownLoaded()) {
			// Flipping to Markdown before the on-demand renderer landed (task 5.9): keep the
			// toggle's label in sync immediately and paint the rendered body once it resolves
			void loadMarkdown().then(renderBody, () => undefined);
		} else {
			renderBody();
		}
		toggleElem.textContent = expandedCommit.showMarkdown ? strings.plainTextToggleLabel : strings.markdownToggleLabel;
	}

	private changeFileViewType(type: GG.FileViewType) {
		const ctx = this.ctx(), store = ctx.store, expandedCommit = store.expandedCommit, filesElem = this.byId('cdvFiles');
		if (expandedCommit === null || expandedCommit.fileTree === null || expandedCommit.fileChanges === null || filesElem === null) return;
		this.closeContextMenuIfOpen(expandedCommit);
		store.slices.repos.updateRepoState(store.currentRepo, 'fileViewType', type);
		ctx.persistence.saveRepoState();
		const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		setHtml(filesElem, generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED, expandedCommit.lineCounts.pending, this.getFileViewOptions()));
		this.wireFileView();
		this.renderFileViewTypeBtns();
		this.lineCounts.scheduleVisible();
	}

	/** Toggle one folder row of the file tree in the DOM (its icon, and its contents). */
	public toggleFolder(folderElem: HTMLElement) {
		const parent = folderElem.parentElement!;
		parent.classList.toggle('closed');
		const isOpen = !parent.classList.contains('closed');
		setHtml(parent.children[0].children[0], isOpen ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder);
		parent.children[1].classList.toggle('hidden');
	}

	private openFolders(open: boolean) {
		const ctx = this.ctx(), expandedCommit = ctx.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileTree === null) return;
		const folders = this.queryAll('.fileTreeFolder');
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
		this.lineCounts.scheduleVisible();
	}

	private renderFileViewTypeBtns() {
		if (this.store.expandedCommit === null) return;
		const treeBtnElem = this.byId('cdvFileViewTypeTree'), listBtnElem = this.byId('cdvFileViewTypeList');
		if (treeBtnElem === null || listBtnElem === null) return;

		const listView = this.getFileViewType() === GG.FileViewType.List;
		alterClass(treeBtnElem, CLASS_ACTIVE, !listView);
		alterClass(listBtnElem, CLASS_ACTIVE, listView);
		const btns = this.queryAll('.cdvFolderBtn');
		for (let i = 0; i < btns.length; i++) {
			if (listView) btns[i].classList.add('hidden');
			else btns[i].classList.remove('hidden');
		}
	}

	/** Reflect the configured external diff tool on the external diff button. */
	public renderExternalDiffBtn() {
		const store = this.store;
		if (store.expandedCommit === null) return;
		const externalDiffBtnElem = this.byId('cdvExternalDiff');
		if (externalDiffBtnElem === null) return;

		alterClass(externalDiffBtnElem, CLASS_ENABLED, store.gitConfig !== null && (store.gitConfig.diffTool !== null || store.gitConfig.guiDiffTool !== null));
		const toolName = store.gitConfig !== null
			? store.gitConfig.guiDiffTool !== null
				? store.gitConfig.guiDiffTool
				: store.gitConfig.diffTool
			: null;
		externalDiffBtnElem.title = strings.externalDiffTitle + (toolName !== null ? formatStr(strings.externalDiffWithTool, toolName) : '');
		externalDiffBtnElem.setAttribute('aria-label', externalDiffBtnElem.title);
	}

	/** Close the open context menu if it belongs to this view. */
	public closeContextMenuIfOpen(expandedCommit: ExpandedCommit) {
		if (expandedCommit.contextMenuOpen.summary || expandedCommit.contextMenuOpen.fileView > -1) {
			expandedCommit.contextMenuOpen.summary = false;
			expandedCommit.contextMenuOpen.fileView = -1;
			this.ctx().contextMenu.close();
		}
	}


	/* Files & code review */

	/**
	 * Update the state of a file in the Commit Details View.
	 * @param file The file that was affected.
	 * @param fileElem The element of the file.
	 * @param isReviewed TRUE/FALSE => set the file's reviewed state accordingly, NULL => don't update it.
	 * @param fileWasViewed Was the file viewed - if so, set it to be the last viewed file.
	 */
	public updateFileState(file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean) {
		const ctx = this.ctx(), store = ctx.store, expandedCommit = store.expandedCommit, filesElem = this.byId('cdvFiles'), filePath = file.newFilePath;
		if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

		if (fileWasViewed) {
			store.slices.details.setLastViewedFile(filePath);
			let lastViewedElem = this.byId('cdvLastFileViewed');
			if (lastViewedElem !== null) lastViewedElem.remove();
			lastViewedElem = document.createElement('span');
			lastViewedElem.id = 'cdvLastFileViewed';
			lastViewedElem.className = 'gg-helpTooltip';
			lastViewedElem.dataset.tooltip = strings.lastFileViewedTitle;
			lastViewedElem.setAttribute('aria-label', strings.lastFileViewedTitle);
			lastViewedElem.tabIndex = 0;
			setHtml(lastViewedElem, SVG_ICONS.eyeOpen);
			insertBeforeFirstChildWithClass(lastViewedElem, fileElem, 'fileTreeFileAction');
		}

		if (expandedCommit.codeReview !== null) {
			if (isReviewed !== null) {
				if (isReviewed) {
					expandedCommit.codeReview.remainingFiles = expandedCommit.codeReview.remainingFiles.filter((path: string) => path !== filePath);
				} else {
					expandedCommit.codeReview.remainingFiles.push(filePath);
				}

				alterFileTreeFileReviewed(expandedCommit.fileTree, filePath, isReviewed);
				updateFileTreeHtmlFileReviewed(filesElem, expandedCommit.fileTree, filePath);
			}

			ctx.bridge.send({
				command: 'updateCodeReview',
				repo: store.currentRepo,
				id: expandedCommit.codeReview.id,
				remainingFiles: expandedCommit.codeReview.remainingFiles,
				lastViewedFile: expandedCommit.lastViewedFile
			});

			if (expandedCommit.codeReview.remainingFiles.length === 0) {
				store.slices.details.setCodeReview(null);
				this.renderCodeReviewBtn();
			}
		}

		ctx.persistence.saveState();
	}

	/** A code review was started (a `startCodeReview` response). */
	public startCodeReview(commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview) {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash) return;
		this.saveAndRenderCodeReview(codeReview);
	}

	private endCodeReview() {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.codeReview === null) return;
		this.saveAndRenderCodeReview(null);
	}

	private saveAndRenderCodeReview(codeReview: GG.CodeReview | null) {
		const ctx = this.ctx(), expandedCommit = ctx.store.expandedCommit, filesElem = this.byId('cdvFiles');
		if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

		ctx.store.slices.details.setCodeReview(codeReview);
		setFileTreeReviewed(expandedCommit.fileTree, codeReview === null);
		ctx.persistence.saveState();
		this.renderCodeReviewBtn();
		updateFileTreeHtml(filesElem, expandedCommit.fileTree);
	}

	private renderCodeReviewBtn() {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null) return;
		const btnElem = this.byId('cdvCodeReview');
		if (btnElem === null) return;

		const active = expandedCommit.codeReview !== null;
		alterClass(btnElem, CLASS_ACTIVE, active);
		btnElem.title = active ? strings.endCodeReviewTitle : strings.startCodeReviewTitle;
		btnElem.setAttribute('aria-label', btnElem.title);
	}
}

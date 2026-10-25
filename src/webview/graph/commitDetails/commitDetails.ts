/**
 * The Commit Details View: the panel that expands a commit (or a comparison of two commits) to
 * show its details and its changed files - inline under the commit's row, docked to the bottom of
 * the view, or as a full-screen sheet in the mobile layout - together with the file tree, the
 * deferred line counts and the code review.
 */

import { formatLongDate } from '../../common/dates';
import { addListenerToClass, alterClass, CLASS_ACTIVE, CLASS_ENABLED, insertAfter, insertBeforeFirstChildWithClass, makeKeyboardActivatable, observeElemScroll } from '../../common/dom';
import { generateSignatureHtml } from '../../common/gitNames';
import { html, SafeHtml, setHtml } from '../../common/html';
import { formatStr, markup, strings } from '../../common/i18n/index';
import { SVG_ICONS } from '../../common/icons';
import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';
import { ExpandedCommit, FileTreeFolder } from '../state/types';
import { hasMarkdown, isMarkdownLoaded, loadMarkdown, renderMarkdown } from '../text/markdown';
import { CLASS_EXTERNAL_URL, CLASS_INTERNAL_URL, TextFormatter } from '../text/textFormatter';
import { makeFileViewInteractive } from './fileActions';
import { alterFileTreeFileReviewed, alterFileTreeFolderOpen, createFileTree, generateFileViewHtml, getFilesInTree, haveFilesChanged, setFileTreeReviewed, updateFileTreeHtml, updateFileTreeHtmlFileReviewed } from './fileTree';
import { LineCounts } from './lineCounts';
import { getCdvMessageBody, getMobileCdvTitle, renderMobileCommitSummary, renderMobileFilesHeader } from './mobileSummary';

const CLASS_COMMIT_DETAILS_OPEN = 'commitDetailsOpen';

export class CommitDetails {
	public readonly lineCounts: LineCounts;

	constructor(private readonly ctx: () => GraphContext) {
		this.lineCounts = new LineCounts(ctx);
	}

	private get store() {
		return this.ctx().store;
	}


	/* Opening & closing */

	/** Open the Commit Details View of the commit whose row is `commitElem`. */
	public load(commitElem: HTMLElement) {
		const commit = this.store.getCommitOfElem(commitElem);
		if (commit === null) return;

		this.close(false);
		this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, null, null);
		commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		this.render(false);
		this.requestCommitDetails(commit.hash, false);
	}

	/** Close the open Commit Details View (or Commit Comparison). */
	public close(saveAndRender: boolean) {
		const ctx = this.ctx(), store = ctx.store, expandedCommit = store.expandedCommit;
		if (expandedCommit === null) return;

		const elem = document.getElementById('cdv'), isDocked = ctx.layout.isCdvDocked();
		if (elem !== null) {
			elem.remove();
		}
		if (isDocked) {
			ctx.dom.view.style.bottom = '0px';
		}
		if (expandedCommit.commitElem !== null) {
			expandedCommit.commitElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		if (expandedCommit.compareWithElem !== null) {
			expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		this.closeContextMenuIfOpen(expandedCommit);
		store.expandedCommit = null;
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
		this.store.expandedCommit = {
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
		};
		this.ctx().persistence.saveState();
	}

	/** The details of a commit arrived: show them (a `commitDetails` response). */
	public showDetails(commitDetails: GG.GitCommitDetails, fileTree: FileTreeFolder, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.commitHash !== commitDetails.hash || expandedCommit.compareWithHash !== null) return;

		expandedCommit.commitDetails = commitDetails;
		if (haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges)) {
			expandedCommit.fileChanges = commitDetails.fileChanges;
			expandedCommit.fileTree = fileTree;
			this.closeContextMenuIfOpen(expandedCommit);
			this.lineCounts.initialise();
		}
		expandedCommit.avatar = avatar;
		expandedCommit.codeReview = codeReview;
		if (!refresh) {
			expandedCommit.lastViewedFile = lastViewedFile;
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.loading = false;
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

		if (haveFilesChanged(expandedCommit.fileChanges, fileChanges)) {
			expandedCommit.fileChanges = fileChanges;
			expandedCommit.fileTree = fileTree;
			this.closeContextMenuIfOpen(expandedCommit);
			this.lineCounts.initialise();
		}
		expandedCommit.codeReview = codeReview;
		if (!refresh) {
			expandedCommit.lastViewedFile = lastViewedFile;
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.loading = false;
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

	/** The element the file list scrolls in: #cdvFiles in the wide layout; in the mobile sheet the whole #cdvContent scrolls (summary and files together). */
	public getFilesScrollElemId() {
		return this.ctx().layout.isMobileLayout() ? 'cdvContent' : 'cdvFiles';
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
				const bodyElem = document.getElementById('cdvMessageBody');
				if (bodyElem !== null) setHtml(bodyElem, renderMarkdown(body));
			}, () => undefined);
			return html`<span id="cdvMessageBody">${textFormatter.format(body)}</span>${offerToggle ? html`<span id="cdvMarkdownToggle" class="cdvMarkdownToggle" role="button" tabindex="0">${strings.plainTextToggleLabel}</span>` : ''}`;
		}
		return html`<span id="cdvMessageBody">${showMarkdown ? renderMarkdown(body) : textFormatter.format(body)}</span>${offerToggle ? html`<span id="cdvMarkdownToggle" class="cdvMarkdownToggle" role="button" tabindex="0">${showMarkdown ? strings.plainTextToggleLabel : strings.markdownToggleLabel}</span>` : ''}`;
	}

	private mobileNote(content: SafeHtml | string): SafeHtml {
		return this.ctx().layout.isMobileLayout() ? html`<div class="cdvmNote">${content}</div>` : html`${content}`;
	}

	private renderSummary(expandedCommit: ExpandedCommit, commitOrder: { from: string, to: string }): SafeHtml {
		const ctx = this.ctx(), store = ctx.store, isMobile = ctx.layout.isMobileLayout();
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
				isParentLoaded: (parent) => typeof store.commitLookup[parent] === 'number',
				renderMessageBlock: () => body !== '' || (store.config.markdown && hasMarkdown(commitDetails.body))
					? this.renderCommitMessageBody(expandedCommit, body, textFormatter)
					: null
			});
		}

		const parents: Array<SafeHtml | string> = [];
		commitDetails.parents.forEach((parent, i) => {
			if (i > 0) parents.push(', ');
			parents.push(typeof store.commitLookup[parent] === 'number'
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

		const expandedCommitLoaded = typeof store.commitLookup[expandedCommit.commitHash] === 'number';
		if (!expandedCommit.loading && !expandedCommitLoaded) return; // The commit is no longer loaded (e.g. after a refresh)

		let elem = document.getElementById('cdv');
		const isDocked = layout.isCdvDocked();
		const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		const codeReviewPossible = !expandedCommit.loading && commitOrder.to !== UNCOMMITTED;
		const isMobile = layout.isMobileLayout();
		const mobileActionsPossible = isMobile && !expandedCommit.loading && expandedCommit.compareWithHash === null && expandedCommitLoaded;
		const externalDiffPossible = !expandedCommit.loading && (expandedCommit.compareWithHash !== null || (expandedCommitLoaded && store.commits[store.commitLookup[expandedCommit.commitHash]].parents.length > 0));

		// The file view controls: in the toolbar, or in the mobile sheet's "Files" section header
		const fileViewBtns = html`<button type="button" id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="${strings.fileListViewTitle}" aria-label="${strings.fileListViewTitle}">${SVG_ICONS.fileList}</button><button type="button" id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="${strings.fileTreeViewTitle}" aria-label="${strings.fileTreeViewTitle}">${SVG_ICONS.fileTree}</button><button type="button" id="cdvCollapse" class="cdvControlBtn cdvFolderBtn" title="${strings.collapseFoldersTitle}" aria-label="${strings.collapseFoldersTitle}">${SVG_ICONS.collapseAll}</button><button type="button" id="cdvExpand" class="cdvControlBtn cdvFolderBtn" title="${strings.expandFoldersTitle}" aria-label="${strings.expandFoldersTitle}">${SVG_ICONS.expandAll}</button>`;

		if (elem === null) {
			elem = document.createElement(isDocked ? 'div' : 'tr');
			elem.id = 'cdv';
			elem.className = isDocked ? 'docked' : 'inline';
			this.setHeight(elem, isDocked);
			if (isDocked) {
				document.body.appendChild(elem);
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
		expandedCommit.entered = true;

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
		const markdownToggle = document.getElementById('cdvMarkdownToggle');
		if (markdownToggle !== null) {
			makeKeyboardActivatable(markdownToggle);
			markdownToggle.addEventListener('click', () => this.toggleMessageMarkdown());
		}
		document.getElementById('cdvClose')!.addEventListener('click', () => {
			this.close(true);
		});
		const mobileActionsBtn = document.getElementById('cdvMobileActions');
		if (mobileActionsBtn !== null) {
			mobileActionsBtn.addEventListener('click', (e) => {
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
			makeFileViewInteractive(ctx);
			this.renderFileViewTypeBtns();
			this.renderExternalDiffBtn();
			this.makeDividerDraggable();

			observeElemScroll(document.getElementById('cdvSummary'), expandedCommit.scrollTop.summary, (scrollTop) => {
				if (store.expandedCommit === null) return;
				store.expandedCommit.scrollTop.summary = scrollTop;
				if (store.expandedCommit.contextMenuOpen.summary) {
					store.expandedCommit.contextMenuOpen.summary = false;
					ctx.contextMenu.close();
				}
			}, () => ctx.persistence.saveState());

			observeElemScroll(document.getElementById(this.getFilesScrollElemId()), expandedCommit.scrollTop.fileView, (scrollTop) => {
				if (store.expandedCommit === null) return;
				store.expandedCommit.scrollTop.fileView = scrollTop;
				this.lineCounts.scheduleVisible();
				if (store.expandedCommit.contextMenuOpen.fileView > -1) {
					store.expandedCommit.contextMenuOpen.fileView = -1;
					ctx.contextMenu.close();
				}
			}, () => ctx.persistence.saveState());

			document.getElementById('cdvFileViewTypeTree')!.addEventListener('click', () => {
				this.changeFileViewType(GG.FileViewType.Tree);
			});
			document.getElementById('cdvFileViewTypeList')!.addEventListener('click', () => {
				this.changeFileViewType(GG.FileViewType.List);
			});
			document.getElementById('cdvCollapse')!.addEventListener('click', () => {
				this.openFolders(false);
			});
			document.getElementById('cdvExpand')!.addEventListener('click', () => {
				this.openFolders(true);
			});

			if (codeReviewPossible) {
				this.renderCodeReviewBtn();
				document.getElementById('cdvCodeReview')!.addEventListener('click', (e) => {
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
				document.getElementById('cdvExternalDiff')!.addEventListener('click', () => {
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
				repoState.cdvHeight = height;
				ctx.persistence.saveRepoState();
			}
		}

		const heightPx = height + 'px';
		elem.style.height = heightPx;
		if (isDocked) ctx.dom.view.style.bottom = heightPx;
	}

	private setDivider() {
		const percent = (this.store.repoState.cdvDivider * 100).toFixed(2) + '%';
		const summaryElem = document.getElementById('cdvSummary'), dividerElem = document.getElementById('cdvDivider'), filesElem = document.getElementById('cdvFiles');
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
				repoState.cdvHeight = height;
				const elem = document.getElementById('cdv');
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

		addListenerToClass(document, 'cdvHeightResize', 'mousedown', (e) => {
			prevY = (<MouseEvent>e).pageY;
			ctx.eventOverlay.create('rowResize', processResizingCdvHeight, stopResizingCdvHeight);
		});
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
				repoState.cdvDivider = percent;
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

		document.getElementById('cdvDivider')!.addEventListener('mousedown', () => {
			const contentElem = document.getElementById('cdvContent');
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
		expandedCommit.showMarkdown = !expandedCommit.showMarkdown;
		const textFormatter = this.createMessageFormatter();
		const bodyElem = document.getElementById('cdvMessageBody'), toggleElem = document.getElementById('cdvMarkdownToggle');
		if (bodyElem === null || toggleElem === null) return;
		const body = getCdvMessageBody(expandedCommit.commitDetails.body, this.ctx().layout.isMobileLayout());
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
		const ctx = this.ctx(), store = ctx.store, expandedCommit = store.expandedCommit, filesElem = document.getElementById('cdvFiles');
		if (expandedCommit === null || expandedCommit.fileTree === null || expandedCommit.fileChanges === null || filesElem === null) return;
		this.closeContextMenuIfOpen(expandedCommit);
		store.repoState.fileViewType = type;
		ctx.persistence.saveRepoState();
		const commitOrder = store.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		setHtml(filesElem, generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED, expandedCommit.lineCounts.pending, this.getFileViewOptions()));
		makeFileViewInteractive(ctx);
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
		const folders = document.getElementsByClassName('fileTreeFolder');
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
		const treeBtnElem = document.getElementById('cdvFileViewTypeTree'), listBtnElem = document.getElementById('cdvFileViewTypeList');
		if (treeBtnElem === null || listBtnElem === null) return;

		const listView = this.getFileViewType() === GG.FileViewType.List;
		alterClass(treeBtnElem, CLASS_ACTIVE, !listView);
		alterClass(listBtnElem, CLASS_ACTIVE, listView);
		const btns = document.getElementsByClassName('cdvFolderBtn');
		for (let i = 0; i < btns.length; i++) {
			if (listView) btns[i].classList.add('hidden');
			else btns[i].classList.remove('hidden');
		}
	}

	/** Reflect the configured external diff tool on the external diff button. */
	public renderExternalDiffBtn() {
		const store = this.store;
		if (store.expandedCommit === null) return;
		const externalDiffBtnElem = document.getElementById('cdvExternalDiff');
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
		const ctx = this.ctx(), store = ctx.store, expandedCommit = store.expandedCommit, filesElem = document.getElementById('cdvFiles'), filePath = file.newFilePath;
		if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

		if (fileWasViewed) {
			expandedCommit.lastViewedFile = filePath;
			let lastViewedElem = document.getElementById('cdvLastFileViewed');
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
				expandedCommit.codeReview = null;
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
		const ctx = this.ctx(), expandedCommit = ctx.store.expandedCommit, filesElem = document.getElementById('cdvFiles');
		if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

		expandedCommit.codeReview = codeReview;
		setFileTreeReviewed(expandedCommit.fileTree, codeReview === null);
		ctx.persistence.saveState();
		this.renderCodeReviewBtn();
		updateFileTreeHtml(filesElem, expandedCommit.fileTree);
	}

	private renderCodeReviewBtn() {
		const expandedCommit = this.store.expandedCommit;
		if (expandedCommit === null) return;
		const btnElem = document.getElementById('cdvCodeReview');
		if (btnElem === null) return;

		const active = expandedCommit.codeReview !== null;
		alterClass(btnElem, CLASS_ACTIVE, active);
		btnElem.title = active ? strings.endCodeReviewTitle : strings.startCodeReviewTitle;
		btnElem.setAttribute('aria-label', btnElem.title);
	}
}

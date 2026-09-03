/* Commit Details View (expanded commit details & comparison views, file tree, code review) */

function loadCommitDetails(view: GitGraphView, commitElem: HTMLElement) {

	const commit = view.getCommitOfElem(commitElem);

	if (commit === null) return;



	closeCommitDetails(view, false);

	view.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, null, null);

	commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);

	renderCommitDetailsView(view, false);

	view.requestCommitDetails(commit.hash, false);

}


function closeCommitDetails(view: GitGraphView, saveAndRender: boolean) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null) return;



	const elem = document.getElementById('cdv'), isDocked = isCdvDocked(view);

	if (elem !== null) {

		elem.remove();

	}

	if (isDocked) {

		view.viewElem.style.bottom = '0px';

	}

	if (expandedCommit.commitElem !== null) {

		expandedCommit.commitElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);

	}

	if (expandedCommit.compareWithElem !== null) {

		expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);

	}

	closeCdvContextMenuIfOpen(expandedCommit);

	view.expandedCommit = null;

	if (saveAndRender) {

		view.saveState();

		if (!isDocked) {

			view.renderGraph();

		}

	}

}


function showCommitDetails(view: GitGraphView, commitDetails: GG.GitCommitDetails, fileTree: FileTreeFolder, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.commitHash !== commitDetails.hash || expandedCommit.compareWithHash !== null) return;



	expandedCommit.commitDetails = commitDetails;

	if (haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges)) {

		expandedCommit.fileChanges = commitDetails.fileChanges;

		expandedCommit.fileTree = fileTree;

		closeCdvContextMenuIfOpen(expandedCommit);

		initialiseLineCounts(view);

	}

	expandedCommit.avatar = avatar;

	expandedCommit.codeReview = codeReview;

	if (!refresh) {

		expandedCommit.lastViewedFile = lastViewedFile;

	}

	expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);

	expandedCommit.loading = false;

	view.saveState();



	renderCommitDetailsView(view, refresh);

}


function createFileTree(view: GitGraphView, gitFiles: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null) {

	let contents: FileTreeFolderContents = {}, i, j, path, absPath, cur: FileTreeFolder;

	let files: FileTreeFolder = { type: 'folder', name: '', folderPath: '', contents: contents, open: true, reviewed: true };



	for (i = 0; i < gitFiles.length; i++) {

		cur = files;

		path = gitFiles[i].newFilePath.split('/');

		absPath = view.currentRepo;

		for (j = 0; j < path.length; j++) {

			absPath += '/' + path[j];

			if (typeof view.gitRepos[absPath] !== 'undefined') {

				if (typeof cur.contents[path[j]] === 'undefined') {

					cur.contents[path[j]] = { type: 'repo', name: path[j], path: absPath };

				}

				break;

			} else if (j < path.length - 1) {

				if (typeof cur.contents[path[j]] === 'undefined') {

					contents = {};

					cur.contents[path[j]] = { type: 'folder', name: path[j], folderPath: absPath.substring(view.currentRepo.length + 1), contents: contents, open: true, reviewed: true };

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


function loadCommitComparison(view: GitGraphView, commitElem: HTMLElement, compareWithElem: HTMLElement) {

	const commit = view.getCommitOfElem(commitElem);

	const compareWithCommit = view.getCommitOfElem(compareWithElem);



	if (commit !== null && compareWithCommit !== null) {

		if (view.expandedCommit !== null) {

			if (view.expandedCommit.commitHash !== commit.hash) {

				closeCommitDetails(view, false);

			} else if (view.expandedCommit.compareWithHash !== compareWithCommit.hash) {

				closeCommitComparison(view, false);

			}

		}



		view.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, compareWithCommit.hash, compareWithElem);

		commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);

		compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);

		renderCommitDetailsView(view, false);

		view.requestCommitComparison(commit.hash, compareWithCommit.hash, false);

	}

}


function closeCommitComparison(view: GitGraphView, saveAndRequestCommitDetails: boolean) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.compareWithHash === null) return;



	if (expandedCommit.compareWithElem !== null) {

		expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);

	}

	closeCdvContextMenuIfOpen(expandedCommit);

	if (saveAndRequestCommitDetails) {

		if (expandedCommit.commitElem !== null) {

			view.saveExpandedCommitLoading(expandedCommit.index, expandedCommit.commitHash, expandedCommit.commitElem, null, null);

			renderCommitDetailsView(view, false);

			view.requestCommitDetails(expandedCommit.commitHash, false);

		} else {

			closeCommitDetails(view, true);

		}

	}

}


function showCommitComparison(view: GitGraphView, commitHash: string, compareWithHash: string, fileChanges: ReadonlyArray<GG.GitFileChange>, fileTree: FileTreeFolder, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.compareWithElem === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash) return;



	if (haveFilesChanged(expandedCommit.fileChanges, fileChanges)) {

		expandedCommit.fileChanges = fileChanges;

		expandedCommit.fileTree = fileTree;

		closeCdvContextMenuIfOpen(expandedCommit);

		initialiseLineCounts(view);

	}

	expandedCommit.codeReview = codeReview;

	if (!refresh) {

		expandedCommit.lastViewedFile = lastViewedFile;

	}

	expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);

	expandedCommit.compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);

	expandedCommit.loading = false;

	view.saveState();



	renderCommitDetailsView(view, refresh);

}


/* ---------- Deferred file line counts ---------- */

/**
 * How far beyond the visible rows counts are still settled eagerly when scrolling, so a fast
 * scroll does not land on empty `( +… | … )` placeholders.
 */
const LINE_COUNTS_VIEWPORT_BUFFER = 400;

/**
 * How many paths one background batch asks for. Bounded so a batch stays quick to compute and to
 * apply, and (for the git CLI backend, where the paths travel on the command line) so the command
 * stays comfortably within the platform's process creation limits.
 */
const LINE_COUNTS_CHUNK_SIZE = 200;

/**
 * The grace period before the background batches start, letting the viewport's own request land
 * first — the rows the user is looking at settle before any of the rest are computed.
 */
const LINE_COUNTS_CHUNK_DELAY = 300;

/**
 * Reset the deferred-counts state for the file list that has just arrived: every path that can
 * carry counts becomes pending, and the viewport's paths are asked for immediately.
 */
function initialiseLineCounts(view: GitGraphView) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.fileChanges === null) return;

	const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);

	const state = expandedCommit.lineCounts;

	state.requested = new Set<string>();

	state.byPath = new Map<string, number>();

	state.chunkInFlight = false;

	if (commitOrder.to === UNCOMMITTED) {

		// A comparison against the working tree reports no counts by design, so there is nothing
		// to settle and no request to make.

		state.pending = new Set<string>();

		state.queue = [];

		return;

	}

	const pending = new Set<string>(), queue: string[] = [];

	for (let i = 0; i < expandedCommit.fileChanges.length; i++) {

		const path = expandedCommit.fileChanges[i].newFilePath;

		// Untracked files never carry counts; the rest are pending until asked for.

		if (expandedCommit.fileChanges[i].type !== GG.GitFileStatus.Untracked && !pending.has(path)) {

			pending.add(path);

			queue.push(path);

			state.byPath.set(path, i);

		}

	}

	state.pending = pending;

	state.queue = queue;

	scheduleVisibleLineCounts(view);

	window.setTimeout(() => pumpLineCountsChunk(view), LINE_COUNTS_CHUNK_DELAY);

}

/** The diff the open view's counts belong to: a comparison's two sides, a stash's base, or a commit's first parent. */
function lineCountsFromTo(view: GitGraphView): { from: string | null, to: string } | null {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null) return null;

	if (expandedCommit.compareWithHash !== null) {

		const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash);

		return { from: commitOrder.from, to: commitOrder.to };

	}

	const commit = view.commits[view.commitLookup[expandedCommit.commitHash]];

	if (commit !== undefined && commit.stash !== null) {

		return { from: commit.stash.baseHash, to: expandedCommit.commitHash };

	}

	return { from: null, to: expandedCommit.commitHash };

}

function requestLineCounts(view: GitGraphView, paths: string[]) {

	const expandedCommit = view.expandedCommit, fromTo = lineCountsFromTo(view);

	if (expandedCommit === null || fromTo === null || paths.length === 0) return;

	for (let i = 0; i < paths.length; i++) expandedCommit.lineCounts.requested.add(paths[i]);

	sendMessage({

		command: 'commitFileCounts',

		repo: view.currentRepo,

		commitHash: expandedCommit.commitHash,

		compareWithHash: expandedCommit.compareWithHash,

		from: fromTo.from,

		to: fromTo.to,

		paths: paths

	});

}

/** Ask for the counts of the rows in (or near) the viewport, debounced so scrolling stays cheap. */
function scheduleVisibleLineCounts(view: GitGraphView) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.lineCounts.pending === null) return;

	window.clearTimeout(expandedCommit.lineCounts.scrollTimer);

	expandedCommit.lineCounts.scrollTimer = window.setTimeout(() => {

		if (view.expandedCommit === null) return; // the view closed while debouncing

		requestLineCounts(view, collectVisiblePendingPaths(view));

	}, 120);

}

function collectVisiblePendingPaths(view: GitGraphView): string[] {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.lineCounts.pending === null || expandedCommit.fileChanges === null) return [];

	const filesElem = document.getElementById('cdvFiles');

	if (filesElem === null) return [];

	const visible = filesElem.getBoundingClientRect();

	const paths: string[] = [];

	const records = filesElem.getElementsByClassName('fileTreeFileRecord');

	for (let i = 0; i < records.length; i++) {

		const record = <HTMLElement>records[i];

		const rect = record.getBoundingClientRect();

		// A zero-height row sits inside a closed folder; a row outside the buffered viewport will
		// be settled by a later batch.

		if (rect.height === 0 || rect.bottom < visible.top - LINE_COUNTS_VIEWPORT_BUFFER || rect.top > visible.bottom + LINE_COUNTS_VIEWPORT_BUFFER) continue;

		const path = expandedCommit.fileChanges[parseInt(record.dataset.index!)].newFilePath;

		if (!expandedCommit.lineCounts.requested.has(path)) paths.push(path);

	}

	return paths;

}

/** Send the next background batch, one batch in flight at a time so the host is never queued up. */
function pumpLineCountsChunk(view: GitGraphView) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.lineCounts.pending === null || expandedCommit.lineCounts.chunkInFlight) return;

	const queue = expandedCommit.lineCounts.queue;

	while (queue.length > 0 && expandedCommit.lineCounts.requested.has(queue[0])) queue.shift();

	if (queue.length === 0) return;

	expandedCommit.lineCounts.chunkInFlight = true;

	requestLineCounts(view, queue.splice(0, LINE_COUNTS_CHUNK_SIZE));

}

/**
 * Settle one batch of counts into the open view: the records, and the rendered rows, are patched
 * in place; the placeholder of a binary file is dropped and its row stops being diffable, exactly
 * as it would have rendered had the counts been known from the start.
 */
function applyLineCounts(view: GitGraphView, msg: GG.ResponseCommitFileCounts) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.fileChanges === null || expandedCommit.lineCounts.pending === null) return;

	if (expandedCommit.commitHash !== msg.commitHash || expandedCommit.compareWithHash !== msg.compareWithHash) return; // a stale reply for a view that is no longer open

	expandedCommit.lineCounts.chunkInFlight = false;

	const filesElem = document.getElementById('cdvFiles');

	for (const path in msg.counts) {

		if (!expandedCommit.lineCounts.pending.has(path)) continue;

		expandedCommit.lineCounts.pending.delete(path);

		const index = expandedCommit.lineCounts.byPath !== null ? expandedCommit.lineCounts.byPath.get(path) : undefined;

		if (index === undefined || index >= expandedCommit.fileChanges.length) continue;

		const file = expandedCommit.fileChanges[index] as { additions: number | null, deletions: number | null };

		file.additions = msg.counts[path].additions;

		file.deletions = msg.counts[path].deletions;

		if (filesElem !== null) {

			const record = filesElem.querySelector('.fileTreeFileRecord[data-index="' + index + '"]');

			if (record !== null) patchFileRowCounts(<HTMLElement>record, expandedCommit.fileChanges[index]);

		}

	}

	pumpLineCountsChunk(view);

}


function renderCommitDetailsView(view: GitGraphView, refresh: boolean) {

	const expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.commitElem === null) return;



	const expandedCommitLoaded = typeof view.commitLookup[expandedCommit.commitHash] === 'number';

	if (!expandedCommit.loading && !expandedCommitLoaded) return; // The commit is no longer loaded (e.g. after a refresh)



	let elem = document.getElementById('cdv'), html = '<div id="cdvContent">', isDocked = isCdvDocked(view);

	const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);

	const codeReviewPossible = !expandedCommit.loading && commitOrder.to !== UNCOMMITTED;

	const externalDiffPossible = !expandedCommit.loading && (expandedCommit.compareWithHash !== null || (expandedCommitLoaded && view.commits[view.commitLookup[expandedCommit.commitHash]].parents.length > 0));



	if (elem === null) {

		elem = document.createElement(isDocked ? 'div' : 'tr');

		elem.id = 'cdv';

		elem.className = isDocked ? 'docked' : 'inline';

		setCdvHeight(view, elem, isDocked);

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



	// The fade-in animation (see #cdv.inline / #cdv.docked in main.css) restarts whenever the
	// element is disconnected and reconnected to the document - which happens even when its DOM
	// reference is carefully preserved and reinserted (a table rebuild replaces the WHOLE table
	// element the row used to belong to). Let it play once, on the render that actually opens the
	// commit; every later render of the same open commit explicitly disables it, so no amount of
	// background refreshing can make the panel visibly flash again.
	elem.style.animation = expandedCommit.entered ? 'none' : '';

	expandedCommit.entered = true;



	if (expandedCommit.loading) {

		html += '<div id="cdvLoading">' + SVG_ICONS.loading + ' ' + (expandedCommit.compareWithHash === null ? expandedCommit.commitHash !== UNCOMMITTED ? strings.loadingCommitDetails : strings.loadingUncommittedChanges : strings.loadingCommitComparison) + '</div>';

	} else {

		html += '<div id="cdvSummary">';

		if (expandedCommit.compareWithHash === null) {

			// Commit details should be shown

			if (expandedCommit.commitHash !== UNCOMMITTED) {

				const textFormatter = new TextFormatter(view.commits, view.gitRepos[view.currentRepo].issueLinkingConfig, {

					commits: true,

					emoji: true,

					issueLinking: true,

					markdown: view.config.markdown,

					multiline: true,

					urls: true

				});

				const commitDetails = expandedCommit.commitDetails!;

				const parents = commitDetails.parents.length > 0

					? commitDetails.parents.map((parent: string) => {

						const escapedParent = escapeHtml(parent);

						return typeof view.commitLookup[parent] === 'number'

							? '<span class="' + CLASS_INTERNAL_URL + '" data-type="commit" data-value="' + escapedParent + '" tabindex="-1">' + escapedParent + '</span>'

							: escapedParent;

					}).join(', ')

					: strings.noneValue;

				html += '<span class="cdvSummaryTop' + (expandedCommit.avatar !== null ? ' withAvatar' : '') + '"><span class="cdvSummaryTopRow"><span class="cdvSummaryKeyValues">'

					+ strings.cdvCommitLabel + escapeHtml(commitDetails.hash) + '<br>'

					+ strings.cdvParentsLabel + parents + '<br>'

					+ strings.cdvAuthorLabel + escapeHtml(commitDetails.author) + (commitDetails.authorEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.authorEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.authorEmail) + '</a>&gt;' : '') + '<br>'

					+ (commitDetails.authorDate !== commitDetails.committerDate ? strings.cdvAuthorDateLabel + formatLongDate(commitDetails.authorDate) + '<br>' : '')

					+ strings.cdvCommitterLabel + escapeHtml(commitDetails.committer) + (commitDetails.committerEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.committerEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.committerEmail) + '</a>&gt;' : '') + (commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : '') + '<br>'

					+ (commitDetails.authorDate !== commitDetails.committerDate ? strings.cdvCommitterDateLabel : strings.cdvDateLabel) + formatLongDate(commitDetails.committerDate)

					+ '</span>'

					+ (expandedCommit.avatar !== null ? '<span class="cdvSummaryAvatar"><img src="' + expandedCommit.avatar + '"></span>' : '')

					+ '</span></span><br><br>' + textFormatter.format(commitDetails.body);

			} else {

				html += strings.displayingUncommitted;

			}

		} else {

			// Commit comparison should be shown

			html += formatStr(strings.displayingChangesFromTo, commitOrder.from, commitOrder.to !== UNCOMMITTED ? commitOrder.to : strings.uncommittedChangesLabel);

		}

		html += '</div><div id="cdvFiles">' + generateFileViewHtml(expandedCommit.fileTree!, expandedCommit.fileChanges!, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, getFileViewType(view), commitOrder.to === UNCOMMITTED, expandedCommit.lineCounts.pending) + '</div><div id="cdvDivider"></div>';

	}

		html += '</div><div id="cdvControls"><div id="cdvClose" class="cdvControlBtn" title="' + strings.dialogClose + '">' + SVG_ICONS.close + '</div>' +

			(codeReviewPossible ? '<div id="cdvCodeReview" class="cdvControlBtn">' + SVG_ICONS.review + '</div>' : '') +

			(!expandedCommit.loading ? '<div id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="' + strings.fileListViewTitle + '">' + SVG_ICONS.fileList + '</div><div id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="' + strings.fileTreeViewTitle + '">' + SVG_ICONS.fileTree + '</div><div id="cdvCollapse" class="cdvControlBtn cdvFolderBtn" title="' + strings.collapseFoldersTitle + '">' + SVG_ICONS.collapseAll + '</div><div id="cdvExpand" class="cdvControlBtn cdvFolderBtn" title="' + strings.expandFoldersTitle + '">' + SVG_ICONS.expandAll + '</div>' : '') +

		(externalDiffPossible ? '<div id="cdvExternalDiff" class="cdvControlBtn">' + SVG_ICONS.linkExternal + '</div>' : '') +

		'</div><div class="cdvHeightResize"></div>';



	elem.innerHTML = isDocked ? html : '<td><div class="cdvHeightResize"></div></td><td colspan="' + (view.getNumColumns() - 1) + '">' + html + '</td>';

	if (!expandedCommit.loading) setCdvDivider(view);

	if (!isDocked) view.renderGraph();



	if (!refresh) {

		if (isDocked) {

			let elemTop = view.getHeaderHeight() + expandedCommit.commitElem.offsetTop;

			if (elemTop - 8 < view.viewElem.scrollTop) {

				// Commit is above what is visible on screen

				view.viewElem.scroll(0, elemTop - 8);

			} else if (elemTop - view.viewElem.clientHeight + 32 > view.viewElem.scrollTop) {

				// Commit is below what is visible on screen

				view.viewElem.scroll(0, elemTop - view.viewElem.clientHeight + 32);

			}

		} else {

			let elemTop = view.getHeaderHeight() + elem.offsetTop, cdvHeight = view.gitRepos[view.currentRepo].cdvHeight;

			if (view.config.commitDetailsView.autoCenter) {

				// Center Commit Detail View setting is enabled

				// elemTop - commit height [24px] + (commit details view height + commit height [24px]) / 2 - (view height) / 2

				view.viewElem.scroll(0, elemTop - 12 + (cdvHeight - view.viewElem.clientHeight) / 2);

			} else if (elemTop - 32 < view.viewElem.scrollTop) {

				// Commit Detail View is opening above what is visible on screen

				// elemTop - commit height [24px] - desired gap from top [8px] < view scroll offset

				view.viewElem.scroll(0, elemTop - 32);

			} else if (elemTop + cdvHeight - view.viewElem.clientHeight + 8 > view.viewElem.scrollTop) {

				// Commit Detail View is opening below what is visible on screen

				// elemTop + commit details view height + desired gap from bottom [8px] - view height > view scroll offset

				view.viewElem.scroll(0, elemTop + cdvHeight - view.viewElem.clientHeight + 8);

			}

		}

	}



	makeCdvResizable(view);

	document.getElementById('cdvClose')!.addEventListener('click', () => {

		closeCommitDetails(view, true);

	});



	if (!expandedCommit.loading) {

		makeCdvFileViewInteractive(view);

		renderCdvFileViewTypeBtns(view);

		renderCdvExternalDiffBtn(view);

		makeCdvDividerDraggable(view);



		observeElemScroll('cdvSummary', expandedCommit.scrollTop.summary, (scrollTop) => {

			if (view.expandedCommit === null) return;

			view.expandedCommit.scrollTop.summary = scrollTop;

			if (view.expandedCommit.contextMenuOpen.summary) {

				view.expandedCommit.contextMenuOpen.summary = false;

				contextMenu.close();

			}

		}, () => view.saveState());



		observeElemScroll('cdvFiles', expandedCommit.scrollTop.fileView, (scrollTop) => {

			if (view.expandedCommit === null) return;

			view.expandedCommit.scrollTop.fileView = scrollTop;

			scheduleVisibleLineCounts(view);

			if (view.expandedCommit.contextMenuOpen.fileView > -1) {

				view.expandedCommit.contextMenuOpen.fileView = -1;

				contextMenu.close();

			}

		}, () => view.saveState());



		document.getElementById('cdvFileViewTypeTree')!.addEventListener('click', () => {

			changeFileViewType(view, GG.FileViewType.Tree);

		});



		document.getElementById('cdvFileViewTypeList')!.addEventListener('click', () => {

			changeFileViewType(view, GG.FileViewType.List);

		});

		document.getElementById('cdvCollapse')!.addEventListener('click', () => {

			openFolders(view, false);

		});

		document.getElementById('cdvExpand')!.addEventListener('click', () => {

			openFolders(view, true);

		});



		if (codeReviewPossible) {

			renderCodeReviewBtn(view);

			document.getElementById('cdvCodeReview')!.addEventListener('click', (e) => {

				const expandedCommit = view.expandedCommit;

				if (expandedCommit === null || e.target === null) return;

				let sourceElem = <HTMLElement>(<Element>e.target).closest('#cdvCodeReview')!;

				if (sourceElem.classList.contains(CLASS_ACTIVE)) {

					sendMessage({ command: 'endCodeReview', repo: view.currentRepo, id: expandedCommit.codeReview!.id });

					endCodeReview(view);

				} else {

					const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);

					const id = expandedCommit.compareWithHash !== null ? commitOrder.from + '-' + commitOrder.to : expandedCommit.commitHash;

					sendMessage({

						command: 'startCodeReview',

						repo: view.currentRepo,

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

				const expandedCommit = view.expandedCommit;

				if (expandedCommit === null || view.gitConfig === null || (view.gitConfig.diffTool === null && view.gitConfig.guiDiffTool === null)) return;

				const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);

				runAction({

					command: 'openExternalDirDiff',

					repo: view.currentRepo,

					fromHash: commitOrder.from,

					toHash: commitOrder.to,

					isGui: view.gitConfig.guiDiffTool !== null

				}, strings.openingExternalDirDiff);

			});

		}

	}

}


function setCdvHeight(view: GitGraphView, elem: HTMLElement, isDocked: boolean) {

	let height = view.gitRepos[view.currentRepo].cdvHeight, windowHeight = window.innerHeight;

	if (height > windowHeight - 40) {

		height = Math.max(windowHeight - 40, 100);

		if (height !== view.gitRepos[view.currentRepo].cdvHeight) {

			view.gitRepos[view.currentRepo].cdvHeight = height;

			view.saveRepoState();

		}

	}



	let heightPx = height + 'px';

	elem.style.height = heightPx;

	if (isDocked) view.viewElem.style.bottom = heightPx;

}


function setCdvDivider(view: GitGraphView) {

	let percent = (view.gitRepos[view.currentRepo].cdvDivider * 100).toFixed(2) + '%';

	let summaryElem = document.getElementById('cdvSummary'), dividerElem = document.getElementById('cdvDivider'), filesElem = document.getElementById('cdvFiles');

	if (summaryElem !== null) summaryElem.style.width = percent;

	if (dividerElem !== null) dividerElem.style.left = percent;

	if (filesElem !== null) filesElem.style.left = percent;

}


function makeCdvResizable(view: GitGraphView) {

	let prevY = -1;



	const processResizingCdvHeight: EventListener = (e) => {

		if (prevY < 0) return;

		let delta = (<MouseEvent>e).pageY - prevY, isDocked = isCdvDocked(view), windowHeight = window.innerHeight;

		prevY = (<MouseEvent>e).pageY;

		let height = view.gitRepos[view.currentRepo].cdvHeight + (isDocked ? -delta : delta);

		if (height < 100) height = 100;

		else if (height > 600) height = 600;

		if (height > windowHeight - 40) height = Math.max(windowHeight - 40, 100);



		if (view.gitRepos[view.currentRepo].cdvHeight !== height) {

			view.gitRepos[view.currentRepo].cdvHeight = height;

			let elem = document.getElementById('cdv');

			if (elem !== null) setCdvHeight(view, elem, isDocked);

			if (!isDocked) view.renderGraph();

		}

	};

	const stopResizingCdvHeight: EventListener = (e) => {

		if (prevY < 0) return;

		processResizingCdvHeight(e);

		view.saveRepoState();

		prevY = -1;

		eventOverlay.remove();

	};



	addListenerToClass('cdvHeightResize', 'mousedown', (e) => {

		prevY = (<MouseEvent>e).pageY;

		eventOverlay.create('rowResize', processResizingCdvHeight, stopResizingCdvHeight);

	});

}


function makeCdvDividerDraggable(view: GitGraphView) {

	let minX = -1, width = -1;



	const processDraggingCdvDivider: EventListener = (e) => {

		if (minX < 0) return;

		let percent = ((<MouseEvent>e).clientX - minX) / width;

		if (percent < 0.2) percent = 0.2;

		else if (percent > 0.8) percent = 0.8;



		if (view.gitRepos[view.currentRepo].cdvDivider !== percent) {

			view.gitRepos[view.currentRepo].cdvDivider = percent;

			setCdvDivider(view);

		}

	};

	const stopDraggingCdvDivider: EventListener = (e) => {

		if (minX < 0) return;

		processDraggingCdvDivider(e);

		view.saveRepoState();

		minX = -1;

		eventOverlay.remove();

	};



	document.getElementById('cdvDivider')!.addEventListener('mousedown', () => {

		const contentElem = document.getElementById('cdvContent');

		if (contentElem === null) return;



		const bounds = contentElem.getBoundingClientRect();

		minX = bounds.left;

		width = bounds.width;

		eventOverlay.create('colResize', processDraggingCdvDivider, stopDraggingCdvDivider);

	});

}


function cdvUpdateFileState(view: GitGraphView, file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean) {

	const expandedCommit = view.expandedCommit, filesElem = document.getElementById('cdvFiles'), filePath = file.newFilePath;

	if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;



	if (fileWasViewed) {

		expandedCommit.lastViewedFile = filePath;

		let lastViewedElem = document.getElementById('cdvLastFileViewed');

		if (lastViewedElem !== null) lastViewedElem.remove();

		lastViewedElem = document.createElement('span');

		lastViewedElem.id = 'cdvLastFileViewed';

		lastViewedElem.title = strings.lastFileViewedTitle;

		lastViewedElem.innerHTML = SVG_ICONS.eyeOpen;

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



		sendMessage({

			command: 'updateCodeReview',

			repo: view.currentRepo,

			id: expandedCommit.codeReview.id,

			remainingFiles: expandedCommit.codeReview.remainingFiles,

			lastViewedFile: expandedCommit.lastViewedFile

		});



		if (expandedCommit.codeReview.remainingFiles.length === 0) {

			expandedCommit.codeReview = null;

			renderCodeReviewBtn(view);

		}

	}



	view.saveState();

}


function isCdvDocked(view: GitGraphView) {

	return view.config.commitDetailsView.location === GG.CommitDetailsViewLocation.DockedToBottom;

}


function isCdvOpen(view: GitGraphView, commitHash: string, compareWithHash: string | null) {

	return view.expandedCommit !== null && view.expandedCommit.commitHash === commitHash && view.expandedCommit.compareWithHash === compareWithHash;

}


function getCommitOrder(view: GitGraphView, hash1: string, hash2: string) {

	if (view.commitLookup[hash1] > view.commitLookup[hash2]) {

		return { from: hash1, to: hash2 };

	} else {

		return { from: hash2, to: hash1 };

	}

}


function getFileViewType(view: GitGraphView) {

	return view.gitRepos[view.currentRepo].fileViewType === GG.FileViewType.Default

		? view.config.commitDetailsView.fileViewType

		: view.gitRepos[view.currentRepo].fileViewType;

}


function setFileViewType(view: GitGraphView, type: GG.FileViewType) {

	view.gitRepos[view.currentRepo].fileViewType = type;

	view.saveRepoState();

}


function changeFileViewType(view: GitGraphView, type: GG.FileViewType) {

	const expandedCommit = view.expandedCommit, filesElem = document.getElementById('cdvFiles');

	if (expandedCommit === null || expandedCommit.fileTree === null || expandedCommit.fileChanges === null || filesElem === null) return;

	closeCdvContextMenuIfOpen(expandedCommit);

	setFileViewType(view, type);

	const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);

	filesElem.innerHTML = generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED, expandedCommit.lineCounts.pending);

	makeCdvFileViewInteractive(view);

	renderCdvFileViewTypeBtns(view);

	scheduleVisibleLineCounts(view);

}


function openFolders(view: GitGraphView, open: boolean) {

	let expandedCommit = view.expandedCommit;

	if (expandedCommit === null || expandedCommit.fileTree === null) return;

	let folders = document.getElementsByClassName('fileTreeFolder');

	for (let i = 0; i < folders.length; i++) {

		let sourceElem = <HTMLElement>(folders[i]);

		let parent = sourceElem.parentElement!;

		if (open) {

			parent.classList.remove('closed');

			sourceElem.children[0].children[0].innerHTML = SVG_ICONS.openFolder;

			parent.children[1].classList.remove('hidden');

			alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath!), true);



		} else {

			parent.classList.add('closed');

			sourceElem.children[0].children[0].innerHTML = SVG_ICONS.closedFolder;

			parent.children[1].classList.add('hidden');

			alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath!), false);

		}

	}

	view.saveState();

	scheduleVisibleLineCounts(view);

}


function makeCdvFileViewInteractive(view: GitGraphView) {

	const getFileElemOfEventTarget = (target: EventTarget) => <HTMLElement>(<Element>target).closest('.fileTreeFileRecord');

	const getFileOfFileElem = (fileChanges: ReadonlyArray<GG.GitFileChange>, fileElem: HTMLElement) => fileChanges[parseInt(fileElem.dataset.index!)];



	const getCommitHashForFile = (file: GG.GitFileChange, expandedCommit: ExpandedCommit) => {

		const commit = view.commits[view.commitLookup[expandedCommit.commitHash]];

		if (expandedCommit.compareWithHash !== null) {

			return getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash).to;

		} else if (commit.stash !== null && file.type === GG.GitFileStatus.Untracked) {

			return commit.stash.untrackedFilesHash!;

		} else {

			return expandedCommit.commitHash;

		}

	};



	const triggerViewFileDiff = (file: GG.GitFileChange, fileElem: HTMLElement) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null) return;



		let commit = view.commits[view.commitLookup[expandedCommit.commitHash]], fromHash: string, toHash: string, fileStatus = file.type;

		if (expandedCommit.compareWithHash !== null) {

			// Commit Comparison

			const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash);

			fromHash = commitOrder.from;

			toHash = commitOrder.to;

		} else if (commit.stash !== null) {

			// Stash Commit

			if (fileStatus === GG.GitFileStatus.Untracked) {

				fromHash = commit.stash.untrackedFilesHash!;

				toHash = commit.stash.untrackedFilesHash!;

				fileStatus = GG.GitFileStatus.Added;

			} else {

				fromHash = commit.stash.baseHash;

				toHash = expandedCommit.commitHash;

			}

		} else {

			// Single Commit

			fromHash = expandedCommit.commitHash;

			toHash = expandedCommit.commitHash;

		}



		cdvUpdateFileState(view, file, fileElem, true, true);

		sendMessage({

			command: 'viewDiff',

			repo: view.currentRepo,

			fromHash: fromHash,

			toHash: toHash,

			oldFilePath: file.oldFilePath,

			newFilePath: file.newFilePath,

			type: fileStatus

		});

	};



	const triggerCopyFilePath = (file: GG.GitFileChange, absolute: boolean) => {

		sendMessage({ command: 'copyFilePath', repo: view.currentRepo, filePath: file.newFilePath, absolute: absolute });

	};



	const triggerResetFileToRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null) return;



		const commitHash = getCommitHashForFile(file, expandedCommit);

		dialog.showConfirmation(formatStr(strings.resetFileConfirm, escapeHtml(file.newFilePath), abbrevCommit(commitHash)), strings.yesResetFile, () => {

			runAction({ command: 'resetFileToRevision', repo: view.currentRepo, commitHash: commitHash, filePath: file.newFilePath }, strings.resettingFile);

		}, {

			type: TargetType.CommitDetailsView,

			hash: commitHash,

			elem: fileElem

		});

	};



	const triggerViewFileAtRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null) return;



		cdvUpdateFileState(view, file, fileElem, true, true);

		sendMessage({ command: 'viewFileAtRevision', repo: view.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });

	};



	const triggerViewFileDiffWithWorkingFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null) return;



		cdvUpdateFileState(view, file, fileElem, null, true);

		sendMessage({ command: 'viewDiffWithWorkingFile', repo: view.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });

	};



	const triggerOpenFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null) return;



		cdvUpdateFileState(view, file, fileElem, true, true);

		sendMessage({ command: 'openFile', repo: view.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });

	};



	addListenerToClass('fileTreeFolder', 'click', (e) => {

		let expandedCommit = view.expandedCommit;

		if (expandedCommit === null || expandedCommit.fileTree === null || e.target === null) return;



		let sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFolder');

		let parent = sourceElem.parentElement!;

		parent.classList.toggle('closed');

		let isOpen = !parent.classList.contains('closed');

		parent.children[0].children[0].innerHTML = isOpen ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder;

		parent.children[1].classList.toggle('hidden');

		alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath!), isOpen);

		view.saveState();

		scheduleVisibleLineCounts(view);

	});



	addListenerToClass('fileTreeRepo', 'click', (e) => {

		if (e.target === null) return;

		view.loadRepos(view.gitRepos, null, {

			repo: decodeURIComponent((<HTMLElement>(<Element>e.target).closest('.fileTreeRepo')).dataset.path!)

		});

	});



	addListenerToClass('fileTreeFile', 'click', (e) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;



		const sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFile'), fileElem = getFileElemOfEventTarget(e.target);

		if (!sourceElem.classList.contains('gitDiffPossible')) return;

		triggerViewFileDiff(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);

	});



	addListenerToClass('copyGitFile', 'click', (e) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;



		const fileElem = getFileElemOfEventTarget(e.target);

		triggerCopyFilePath(getFileOfFileElem(expandedCommit.fileChanges, fileElem), true);

	});



	addListenerToClass('viewGitFileAtRevision', 'click', (e) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;



		const fileElem = getFileElemOfEventTarget(e.target);

		triggerViewFileAtRevision(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);

	});



	addListenerToClass('openGitFile', 'click', (e) => {

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;



		const fileElem = getFileElemOfEventTarget(e.target);

		triggerOpenFile(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);

	});



	addListenerToClass('fileTreeFileRecord', 'contextmenu', (e: Event) => {

		handledEvent(e);

		const expandedCommit = view.expandedCommit;

		if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

		const fileElem = getFileElemOfEventTarget(e.target);

		const file = getFileOfFileElem(expandedCommit.fileChanges, fileElem);

		const commitOrder = getCommitOrder(view, expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);

		const isUncommitted = commitOrder.to === UNCOMMITTED;



		closeCdvContextMenuIfOpen(expandedCommit);

		expandedCommit.contextMenuOpen.fileView = parseInt(fileElem.dataset.index!);



		const target: ContextMenuTarget & CommitTarget = {

			type: TargetType.CommitDetailsView,

			hash: expandedCommit.commitHash,

			index: view.commitLookup[expandedCommit.commitHash],

			elem: fileElem

		};

		const diffPossible = file.type === GG.GitFileStatus.Untracked || (file.additions !== null && file.deletions !== null);

		const fileExistsAtThisRevision = file.type !== GG.GitFileStatus.Deleted && !isUncommitted;

		const fileExistsAtThisRevisionAndDiffPossible = fileExistsAtThisRevision && diffPossible;

		const codeReviewInProgressAndNotReviewed = expandedCommit.codeReview !== null && expandedCommit.codeReview.remainingFiles.includes(file.newFilePath);

		const visibility = view.config.contextMenuActionsVisibility.commitDetailsViewFile;



		contextMenu.show([

			[

				{

					title: strings.cdvMenuViewDiff,

					visible: visibility.viewDiff && diffPossible,

					onClick: () => triggerViewFileDiff(file, fileElem)

				},

				{

					title: strings.cdvMenuViewFileAtRevision,

					visible: visibility.viewFileAtThisRevision && fileExistsAtThisRevisionAndDiffPossible,

					onClick: () => triggerViewFileAtRevision(file, fileElem)

				},

				{

					title: strings.cdvMenuViewDiffWithWorkingFile,

					visible: visibility.viewDiffWithWorkingFile && fileExistsAtThisRevisionAndDiffPossible,

					onClick: () => triggerViewFileDiffWithWorkingFile(file, fileElem)

				},

				{

					title: strings.cdvMenuOpenFile,

					visible: visibility.openFile && file.type !== GG.GitFileStatus.Deleted,

					onClick: () => triggerOpenFile(file, fileElem)

				}

			],

			[

				{

					title: strings.cdvMenuMarkReviewed,

					visible: visibility.markAsReviewed && codeReviewInProgressAndNotReviewed,

					onClick: () => cdvUpdateFileState(view, file, fileElem, true, false)

				},

				{

					title: strings.cdvMenuMarkNotReviewed,

					visible: visibility.markAsNotReviewed && expandedCommit.codeReview !== null && !codeReviewInProgressAndNotReviewed,

					onClick: () => cdvUpdateFileState(view, file, fileElem, false, false)

				}

			],

			[

				{

					title: strings.cdvMenuResetFileToRevision + ELLIPSIS,

					visible: visibility.resetFileToThisRevision && fileExistsAtThisRevision && expandedCommit.compareWithHash === null,

					onClick: () => triggerResetFileToRevision(file, fileElem)

				}

			],

			[

				{

					title: strings.cdvMenuCopyAbsolutePath,

					visible: visibility.copyAbsoluteFilePath,

					onClick: () => triggerCopyFilePath(file, true)

				},

				{

					title: strings.cdvMenuCopyRelativePath,

					visible: visibility.copyRelativeFilePath,

					onClick: () => triggerCopyFilePath(file, false)

				}

			]

		], false, target, <MouseEvent>e, isCdvDocked(view) ? document.body : view.viewElem, () => {

			expandedCommit.contextMenuOpen.fileView = -1;

		});

	});

}


function renderCdvFileViewTypeBtns(view: GitGraphView) {

	if (view.expandedCommit === null) return;

	let treeBtnElem = document.getElementById('cdvFileViewTypeTree'), listBtnElem = document.getElementById('cdvFileViewTypeList');

	if (treeBtnElem === null || listBtnElem === null) return;



	let listView = getFileViewType(view) === GG.FileViewType.List;

	alterClass(treeBtnElem, CLASS_ACTIVE, !listView);

	alterClass(listBtnElem, CLASS_ACTIVE, listView);

	setFolderBtns();

	function setFolderBtns() {

		let btns = document.getElementsByClassName('cdvFolderBtn');

		for (let i = 0; i < btns.length; i++) {

			if (listView)

				btns[i].classList.add('hidden');

			else

				btns[i].classList.remove('hidden');

		}

	}

}


function renderCdvExternalDiffBtn(view: GitGraphView) {

	if (view.expandedCommit === null) return;

	const externalDiffBtnElem = document.getElementById('cdvExternalDiff');

	if (externalDiffBtnElem === null) return;



	alterClass(externalDiffBtnElem, CLASS_ENABLED, view.gitConfig !== null && (view.gitConfig.diffTool !== null || view.gitConfig.guiDiffTool !== null));

	const toolName = view.gitConfig !== null

		? view.gitConfig.guiDiffTool !== null

			? view.gitConfig.guiDiffTool

			: view.gitConfig.diffTool

		: null;

	externalDiffBtnElem.title = strings.externalDiffTitle + (toolName !== null ? formatStr(strings.externalDiffWithTool, toolName) : '');

}


function closeCdvContextMenuIfOpen(expandedCommit: ExpandedCommit) {

	if (expandedCommit.contextMenuOpen.summary || expandedCommit.contextMenuOpen.fileView > -1) {

		expandedCommit.contextMenuOpen.summary = false;

		expandedCommit.contextMenuOpen.fileView = -1;

		contextMenu.close();

	}

}


function startCodeReview(view: GitGraphView, commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview) {

	if (view.expandedCommit === null || view.expandedCommit.commitHash !== commitHash || view.expandedCommit.compareWithHash !== compareWithHash) return;

	saveAndRenderCodeReview(view, codeReview);

}


function endCodeReview(view: GitGraphView) {

	if (view.expandedCommit === null || view.expandedCommit.codeReview === null) return;

	saveAndRenderCodeReview(view, null);

}


function saveAndRenderCodeReview(view: GitGraphView, codeReview: GG.CodeReview | null) {

	let filesElem = document.getElementById('cdvFiles');

	if (view.expandedCommit === null || view.expandedCommit.fileTree === null || filesElem === null) return;



	view.expandedCommit.codeReview = codeReview;

	setFileTreeReviewed(view.expandedCommit.fileTree, codeReview === null);

	view.saveState();

	renderCodeReviewBtn(view);

	updateFileTreeHtml(filesElem, view.expandedCommit.fileTree);

}


function renderCodeReviewBtn(view: GitGraphView) {

	if (view.expandedCommit === null) return;

	let btnElem = document.getElementById('cdvCodeReview');

	if (btnElem === null) return;



	let active = view.expandedCommit.codeReview !== null;

	alterClass(btnElem, CLASS_ACTIVE, active);

	btnElem.title = active ? strings.endCodeReviewTitle : strings.startCodeReviewTitle;

}


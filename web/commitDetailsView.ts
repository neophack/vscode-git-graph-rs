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



	if (!isCdvDocked(view)) {

		const elem = document.getElementById('cdv');

		if (elem !== null) elem.remove();

	}



	expandedCommit.commitDetails = commitDetails;

	if (haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges)) {

		expandedCommit.fileChanges = commitDetails.fileChanges;

		expandedCommit.fileTree = fileTree;

		closeCdvContextMenuIfOpen(expandedCommit);

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

	}



	if (expandedCommit.loading) {

		html += '<div id="cdvLoading">' + SVG_ICONS.loading + ' Loading ' + (expandedCommit.compareWithHash === null ? expandedCommit.commitHash !== UNCOMMITTED ? 'Commit Details' : 'Uncommitted Changes' : 'Commit Comparison') + ' ...</div>';

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

					: 'None';

				html += '<span class="cdvSummaryTop' + (expandedCommit.avatar !== null ? ' withAvatar' : '') + '"><span class="cdvSummaryTopRow"><span class="cdvSummaryKeyValues">'

					+ '<b>Commit: </b>' + escapeHtml(commitDetails.hash) + '<br>'

					+ '<b>Parents: </b>' + parents + '<br>'

					+ '<b>Author: </b>' + escapeHtml(commitDetails.author) + (commitDetails.authorEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.authorEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.authorEmail) + '</a>&gt;' : '') + '<br>'

					+ (commitDetails.authorDate !== commitDetails.committerDate ? '<b>Author Date: </b>' + formatLongDate(commitDetails.authorDate) + '<br>' : '')

					+ '<b>Committer: </b>' + escapeHtml(commitDetails.committer) + (commitDetails.committerEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.committerEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.committerEmail) + '</a>&gt;' : '') + (commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : '') + '<br>'

					+ '<b>' + (commitDetails.authorDate !== commitDetails.committerDate ? 'Committer ' : '') + 'Date: </b>' + formatLongDate(commitDetails.committerDate)

					+ '</span>'

					+ (expandedCommit.avatar !== null ? '<span class="cdvSummaryAvatar"><img src="' + expandedCommit.avatar + '"></span>' : '')

					+ '</span></span><br><br>' + textFormatter.format(commitDetails.body);

			} else {

				html += 'Displaying all uncommitted changes.';

			}

		} else {

			// Commit comparison should be shown

			html += 'Displaying all changes from <b>' + commitOrder.from + '</b> to <b>' + (commitOrder.to !== UNCOMMITTED ? commitOrder.to : 'Uncommitted Changes') + '</b>.';

		}

		html += '</div><div id="cdvFiles">' + generateFileViewHtml(expandedCommit.fileTree!, expandedCommit.fileChanges!, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, getFileViewType(view), commitOrder.to === UNCOMMITTED) + '</div><div id="cdvDivider"></div>';

	}

	html += '</div><div id="cdvControls"><div id="cdvClose" class="cdvControlBtn" title="Close">' + SVG_ICONS.close + '</div>' +

		(codeReviewPossible ? '<div id="cdvCodeReview" class="cdvControlBtn">' + SVG_ICONS.review + '</div>' : '') +

		(!expandedCommit.loading ? '<div id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="File List View">' + SVG_ICONS.fileList + '</div><div id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="File Tree View">' + SVG_ICONS.fileTree + '</div><div id="cdvCollapse" class="cdvControlBtn cdvFolderBtn" title="Collapse/Expand Folders">' + SVG_ICONS.collapseAll + '</div><div id="cdvExpand" class="cdvControlBtn cdvFolderBtn" title="Expand Folders">' + SVG_ICONS.expandAll + '</div>' : '') +

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

				}, 'Opening External Directory Diff');

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

		lastViewedElem.title = 'Last File Viewed';

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

	filesElem.innerHTML = generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED);

	makeCdvFileViewInteractive(view);

	renderCdvFileViewTypeBtns(view);

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

		dialog.showConfirmation('Are you sure you want to reset <b><i>' + escapeHtml(file.newFilePath) + '</i></b> to it\'s state at commit <b><i>' + abbrevCommit(commitHash) + '</i></b>? Any uncommitted changes made to this file will be overwritten.', 'Yes, reset file', () => {

			runAction({ command: 'resetFileToRevision', repo: view.currentRepo, commitHash: commitHash, filePath: file.newFilePath }, 'Resetting file');

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

					title: 'View Diff',

					visible: visibility.viewDiff && diffPossible,

					onClick: () => triggerViewFileDiff(file, fileElem)

				},

				{

					title: 'View File at this Revision',

					visible: visibility.viewFileAtThisRevision && fileExistsAtThisRevisionAndDiffPossible,

					onClick: () => triggerViewFileAtRevision(file, fileElem)

				},

				{

					title: 'View Diff with Working File',

					visible: visibility.viewDiffWithWorkingFile && fileExistsAtThisRevisionAndDiffPossible,

					onClick: () => triggerViewFileDiffWithWorkingFile(file, fileElem)

				},

				{

					title: 'Open File',

					visible: visibility.openFile && file.type !== GG.GitFileStatus.Deleted,

					onClick: () => triggerOpenFile(file, fileElem)

				}

			],

			[

				{

					title: 'Mark as Reviewed',

					visible: visibility.markAsReviewed && codeReviewInProgressAndNotReviewed,

					onClick: () => cdvUpdateFileState(view, file, fileElem, true, false)

				},

				{

					title: 'Mark as Not Reviewed',

					visible: visibility.markAsNotReviewed && expandedCommit.codeReview !== null && !codeReviewInProgressAndNotReviewed,

					onClick: () => cdvUpdateFileState(view, file, fileElem, false, false)

				}

			],

			[

				{

					title: 'Reset File to this Revision' + ELLIPSIS,

					visible: visibility.resetFileToThisRevision && fileExistsAtThisRevision && expandedCommit.compareWithHash === null,

					onClick: () => triggerResetFileToRevision(file, fileElem)

				}

			],

			[

				{

					title: 'Copy Absolute File Path to Clipboard',

					visible: visibility.copyAbsoluteFilePath,

					onClick: () => triggerCopyFilePath(file, true)

				},

				{

					title: 'Copy Relative File Path to Clipboard',

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

	externalDiffBtnElem.title = 'Open External Directory Diff' + (toolName !== null ? ' with "' + toolName + '"' : '');

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

	btnElem.title = (active ? 'End' : 'Start') + ' Code Review';

}


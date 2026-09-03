/* Observers (DOM wiring: resize, scroll, keyboard, urls, table events, resizable table/columns) */

function observeWindowSizeChanges(view: GitGraphView) {

	let windowWidth = window.outerWidth, windowHeight = window.outerHeight, resizeRafId: number | null = null;

	window.addEventListener('resize', () => {

		// Coalesce bursts of resize events into a single render per animation frame: with many

		// loaded commits, each renderGraph call rebuilds the entire SVG graph

		if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);

		resizeRafId = requestAnimationFrame(() => {

			resizeRafId = null;

			// The visible row count of a windowed render derives from the view height, so a resize
			// must recompute the window (otherwise rows below the old window end are missing until
			// the user scrolls)

			view.updateVirtualWindow();

			if (windowWidth === window.outerWidth && windowHeight === window.outerHeight) {

				view.renderGraph();

			} else {

				windowWidth = window.outerWidth;

				windowHeight = window.outerHeight;

				// The view was resized: recompute the automatic graph column layout so that the

				// graph width limit tracks the new view size

				applyGraphColumnAutoLayout(view);

			}

		});

	});

}


// The graph column header element, and the graph content / viewport width, this function last
// actually applied a layout to (see the early-out below): this call runs after EVERY commit list
// update, including a background refresh that only prepends off-screen rows (a file edited, a
// commit landing while the user is scrolled down the history) - resetting and re-measuring the
// column's padding on every one of those, even though the graph's rendered width hasn't changed,
// was visible as the Description column (the very next, flexible column) jittering left/right on
// each such refresh. The element is part of the cache key because a full table re-render replaces
// it with a fresh, unpadded header - that always needs the padding (re-)applied, whatever the width.
let lastAppliedGraphColElem: HTMLElement | null = null;
let lastAppliedGraphColumnWidth: number | null = null;
let lastAppliedGraphColumnViewportWidth: number | null = null;

function applyGraphColumnAutoLayout(view: GitGraphView) {

	if (typeof view.currentRepo === 'undefined' || view.tableElem.className.indexOf('autoLayout') === -1) return; // only the automatic layout depends on the view width



	// Only the Graph column header is needed here: look it up directly by id (its class-based
	// collection is scanned separately - and more expensively, on a large table - by makeTableResizable).
	const graphColElem = document.getElementById('tableHeaderGraphCol');

	if (graphColElem === null) return;



	const graphContentWidth = view.graph.getContentWidth(), viewportWidth = view.viewElem.clientWidth;
	if (graphColElem === lastAppliedGraphColElem && graphContentWidth === lastAppliedGraphColumnWidth && viewportWidth === lastAppliedGraphColumnViewportWidth) return;
	lastAppliedGraphColElem = graphColElem;
	lastAppliedGraphColumnWidth = graphContentWidth;
	lastAppliedGraphColumnViewportWidth = viewportWidth;



	// Reset any padding this function applied on a previous call before measuring: otherwise
	// colWidth reflects that stale, JS-inflated padding instead of the column's base CSS
	// padding, and deriving new padding from it makes the graph column width oscillate between
	// calls while the window is being resized.
	graphColElem.style.padding = '';

	let colWidth = graphColElem.offsetWidth, graphWidth = graphContentWidth;

	let maxWidth = Math.round(view.viewElem.clientWidth * 0.333);

	if (Math.max(graphWidth, colWidth) > maxWidth) {

		view.graph.limitMaxWidth(maxWidth);

		graphWidth = maxWidth;

		view.tableElem.className = 'autoLayout limitGraphWidth';

		view.tableElem.style.setProperty(CSS_PROP_LIMIT_GRAPH_WIDTH, maxWidth + 'px');

	} else {

		view.graph.limitMaxWidth(-1);

		view.tableElem.className = 'autoLayout';

		view.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);

	}



	if (colWidth < Math.max(graphWidth, 64)) {

		graphColElem.style.padding = '6px ' + Math.floor((Math.max(graphWidth, 64) - (colWidth - COLUMN_LEFT_RIGHT_PADDING)) / 2) + 'px';

	} else {

		graphColElem.style.padding = '';

	}

}


function observeWebviewStyleChanges(view: GitGraphView) {

	let fontFamily = getVSCodeStyle(CSS_PROP_FONT_FAMILY),

		editorFontFamily = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),

		findMatchColour = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),

		selectionBackgroundColor = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);



	const setFlashColour = (colour: string) => {

		document.body.style.setProperty('--git-graph-flashPrimary', modifyColourOpacity(colour, 0.7));

		document.body.style.setProperty('--git-graph-flashSecondary', modifyColourOpacity(colour, 0.5));

	};

	const setSelectionBackgroundColorExists = () => {

		alterClass(document.body, 'selection-background-color-exists', selectionBackgroundColor);

	};



	view.findWidget.setColour(findMatchColour);

	setFlashColour(findMatchColour);

	setSelectionBackgroundColorExists();



	(new MutationObserver(() => {

		let ff = getVSCodeStyle(CSS_PROP_FONT_FAMILY),

			eff = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),

			fmc = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),

			sbc = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);



		if (ff !== fontFamily || eff !== editorFontFamily) {

			fontFamily = ff;

			editorFontFamily = eff;

			view.repoDropdown.refresh();

			view.branchDropdown.refresh();

			view.authorDropdown.refresh();



		}

		if (fmc !== findMatchColour) {

			findMatchColour = fmc;

			view.findWidget.setColour(findMatchColour);

			setFlashColour(findMatchColour);

		}

		if (selectionBackgroundColor !== sbc) {

			selectionBackgroundColor = sbc;

			setSelectionBackgroundColorExists();

		}

	})).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

}


function observeViewScroll(view: GitGraphView) {

	let timeout: number | null = null;

	let virtualRafId: number | null = null;

	view.viewElem.addEventListener('scroll', () => {

		const scrollTop = view.viewElem.scrollTop;

		// Windowed rendering: re-render the visible commit rows (and the graph vertices) around the
		// new scroll position, coalesced into one update per animation frame
		if (virtualRafId !== null) cancelAnimationFrame(virtualRafId);
		virtualRafId = requestAnimationFrame(() => {
			virtualRafId = null;
			view.updateVirtualWindow();
		});

		if (view.config.loadMoreCommitsAutomatically && view.moreCommitsAvailable && !view.currentRepoRefreshState.inProgress) {

			const viewHeight = view.viewElem.clientHeight, contentHeight = view.viewElem.scrollHeight;

			if (scrollTop > 0 && viewHeight > 0 && contentHeight > 0 && (scrollTop + viewHeight) >= contentHeight - 25) {

				// If the user has scrolled such that the bottom of the visible view is within 25px of the end of the content, load more commits.

				view.loadMoreCommits();

			}

		}



		if (timeout !== null) clearTimeout(timeout);

		timeout = window.setTimeout(() => {

			view.scrollTop = scrollTop;

			view.saveState();

			timeout = null;

		}, 250);

	});

}


function observeKeyboardEvents(view: GitGraphView) {

	document.addEventListener('keydown', (e) => {

		if (contextMenu.isOpen()) {

			if (e.key === 'Escape') {

				contextMenu.close();

				handledEvent(e);

			}

		} else if (dialog.isOpen()) {

			if (e.key === 'Escape') {

				dialog.close();

				handledEvent(e);

			} else if (e.keyCode ? e.keyCode === 13 : e.key === 'Enter') {

				// Use keyCode === 13 to detect 'Enter' events if available (for compatibility with IME Keyboards used by Chinese / Japanese / Korean users)

				dialog.submit();

				handledEvent(e);

			}

		} else if (view.expandedCommit !== null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {

			const curHashIndex = view.commitLookup[view.expandedCommit.commitHash];

			let newHashIndex = -1;



			if (e.ctrlKey || e.metaKey) {

				// Up / Down navigates according to the order of commits on the branch

				if (e.shiftKey) {

					// Follow commits on alternative branches when possible

					if (e.key === 'ArrowUp') {

						newHashIndex = view.graph.getAlternativeChildIndex(curHashIndex);

					} else if (e.key === 'ArrowDown') {

						newHashIndex = view.graph.getAlternativeParentIndex(curHashIndex);

					}

				} else {

					// Follow commits on the same branch

					if (e.key === 'ArrowUp') {

						newHashIndex = view.graph.getFirstChildIndex(curHashIndex);

					} else if (e.key === 'ArrowDown') {

						newHashIndex = view.graph.getFirstParentIndex(curHashIndex);

					}

				}

			} else {

				// Up / Down navigates according to the order of commits in the table

				if (e.key === 'ArrowUp' && curHashIndex > 0) {

					newHashIndex = curHashIndex - 1;

				} else if (e.key === 'ArrowDown' && curHashIndex < view.commits.length - 1) {

					newHashIndex = curHashIndex + 1;

				}

			}



			if (newHashIndex > -1) {

				handledEvent(e);

				const elem = findCommitElemWithId(newHashIndex);

				if (elem !== null) loadCommitDetails(view, elem);

			}

		} else if (e.key && (e.ctrlKey || e.metaKey)) {

			const key = e.key.toLowerCase(), keybindings = view.config.keybindings;

			if (key === keybindings.scrollToStash) {

				view.scrollToStash(!e.shiftKey);

				handledEvent(e);

			} else if (!e.shiftKey) {

				if (key === keybindings.refresh) {

					view.refresh(true, true);

					handledEvent(e);

				} else if (key === keybindings.find) {

					view.findWidget.show(true);

					handledEvent(e);

				} else if (key === keybindings.scrollToHead && view.commitHead !== null) {

					view.scrollToCommit(view.commitHead, true, true);

					handledEvent(e);

				}

			}

		} else if (e.key === 'Escape') {

			if (view.repoDropdown.isOpen()) {

				view.repoDropdown.close();

				handledEvent(e);

			} else if (view.branchDropdown.isOpen()) {

				view.branchDropdown.close();

				handledEvent(e);

			} else if (view.authorDropdown.isOpen()) {

				view.authorDropdown.close();

				handledEvent(e);

			} else if (view.settingsWidget.isVisible()) {

				view.settingsWidget.close();

				handledEvent(e);

			} else if (view.findWidget.isVisible()) {

				view.findWidget.close();

				handledEvent(e);

			} else if (view.expandedCommit !== null) {

				closeCommitDetails(view, true);

				handledEvent(e);

			}

		}

	});

}


function observeUrls(view: GitGraphView) {

	const followInternalLink = (e: MouseEvent) => {

		if (e.target !== null && isInternalUrlElem(<Element>e.target)) {

			const value = unescapeHtml((<HTMLElement>e.target).dataset.value!);

			switch ((<HTMLElement>e.target).dataset.type!) {
				case 'commit':

					if (typeof view.commitLookup[value] === 'number' && (view.expandedCommit === null || view.expandedCommit.commitHash !== value || view.expandedCommit.compareWithHash !== null)) {

						const elem = findCommitElemWithId(view.commitLookup[value]);

						if (elem !== null) loadCommitDetails(view, elem);

					}

					break;
			}

		}

	};



	document.body.addEventListener('click', followInternalLink);



	document.body.addEventListener('contextmenu', (e: MouseEvent) => {

		if (e.target === null) return;

		const eventTarget = <Element>e.target;



		const isExternalUrl = isExternalUrlElem(eventTarget), isInternalUrl = isInternalUrlElem(eventTarget);

		if (isExternalUrl || isInternalUrl) {

			const viewElem: HTMLElement | null = eventTarget.closest('#view');

			let eventElem: HTMLElement | null;



			let target: (ContextMenuTarget & CommitTarget) | RepoTarget, isInDialog = false;

			if (view.expandedCommit !== null && eventTarget.closest('#cdv') !== null) {

				// URL is in the Commit Details View

				target = {

					type: TargetType.CommitDetailsView,

					hash: view.expandedCommit.commitHash,

					index: view.commitLookup[view.expandedCommit.commitHash],

					elem: <HTMLElement>eventTarget

				};

				closeCdvContextMenuIfOpen(view.expandedCommit);

				view.expandedCommit.contextMenuOpen.summary = true;

			} else if ((eventElem = eventTarget.closest('.commit')) !== null) {

				// URL is in the Commits

				const commit = view.getCommitOfElem(eventElem);

				if (commit === null) return;

				target = {

					type: TargetType.Commit,

					hash: commit.hash,

					index: parseInt(eventElem.dataset.id!),

					elem: <HTMLElement>eventTarget

				};

			} else {

				// URL is in a dialog

				target = {

					type: TargetType.Repo

				};

				isInDialog = true;

			}



			handledEvent(e);

			contextMenu.show([

				[

					{

						title: strings.menuOpenUrl,

						visible: isExternalUrl,

						onClick: () => {

							sendMessage({ command: 'openExternalUrl', url: (<HTMLAnchorElement>eventTarget).href });

						}

					},

					{

						title: strings.menuFollowInternalLink,

						visible: isInternalUrl,

						onClick: () => followInternalLink(e)

					},

					{

						title: strings.menuCopyUrl,

						visible: isExternalUrl,

						onClick: () => {

							sendMessage({ command: 'copyToClipboard', type: strings.copyTypeExternalUrl, data: (<HTMLAnchorElement>eventTarget).href });

						}

					}

				]

			], false, target, e, viewElem || document.body, () => {

				if (target.type === TargetType.CommitDetailsView && view.expandedCommit !== null) {

					view.expandedCommit.contextMenuOpen.summary = false;

				}

			}, isInDialog ? 'dialogContextMenu' : null);

		}

	});

}


function observeTableEvents(view: GitGraphView) {



	// Register Click Event Handler

	view.tableElem.addEventListener('click', (e: MouseEvent) => {

		if (e.target === null) return;

		const eventTarget = <Element>e.target;

		if (isUrlElem(eventTarget)) return;

		let eventElem: HTMLElement | null;



		if ((eventElem = eventTarget.closest('.gitRef')) !== null) {

			// .gitRef was clicked

			e.stopPropagation();

			if (contextMenu.isOpen()) {

				contextMenu.close();

			}

			if (eventElem.classList.contains(CLASS_REF_GERRIT)) {

				// The Gerrit change badge was clicked: show the review information of the change

				showGerritReviewInfo(view, eventElem.dataset.hash!);

				return;

			}

		} else if ((eventElem = eventTarget.closest('.commit')) !== null) {

			// .commit was clicked

			if (view.expandedCommit !== null) {

				const commit = view.getCommitOfElem(eventElem);

				if (commit === null) return;



				if (view.expandedCommit.commitHash === commit.hash) {

					closeCommitDetails(view, true);

				} else if ((<MouseEvent>e).ctrlKey || (<MouseEvent>e).metaKey) {

					if (view.expandedCommit.compareWithHash === commit.hash) {

						closeCommitComparison(view, true);

					} else {

						view.openCompareTab(view.expandedCommit.commitHash, commit.hash);

					}

				} else {

					loadCommitDetails(view, eventElem);

				}

			} else {

				loadCommitDetails(view, eventElem);

			}

		}

	});



	// Register Double Click Event Handler

	view.tableElem.addEventListener('dblclick', (e: MouseEvent) => {

		if (e.target === null) return;

		const eventTarget = <Element>e.target;

		if (isUrlElem(eventTarget)) return;

		let eventElem: HTMLElement | null;



		if ((eventElem = eventTarget.closest('.gitRef')) !== null) {

			// .gitRef was double clicked

			e.stopPropagation();

			closeDialogAndContextMenu();

			const commitElem = <HTMLElement>eventElem.closest('.commit')!;

			const commit = view.getCommitOfElem(commitElem);

			if (commit === null) return;

			if (eventElem.classList.contains(CLASS_REF_GERRIT)) return; // the Gerrit badge has no double click action



			if (eventElem.classList.contains(CLASS_REF_HEAD) || eventElem.classList.contains(CLASS_REF_REMOTE)) {

				let sourceElem = <HTMLElement>eventElem.children[1];

				let refName = unescapeHtml(eventElem.dataset.name!), isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');

				if (isHead && isRemoteCombinedWithHead) {

					refName = unescapeHtml((<HTMLElement>eventTarget).dataset.fullref!);

					sourceElem = <HTMLElement>eventTarget;

					isHead = false;

				}



				const target: ContextMenuTarget & DialogTarget & RefTarget = {

					type: TargetType.Ref,

					hash: commit.hash,

					index: parseInt(commitElem.dataset.id!),

					ref: refName,

					elem: sourceElem

				};



				checkoutBranchAction(view, refName, isHead ? null : unescapeHtml((isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!), null, target);

			}

		}

	});



	// Register ContextMenu Event Handler

	view.tableElem.addEventListener('contextmenu', (e: Event) => {

		if (e.target === null) return;

		const eventTarget = <Element>e.target;

		if (isUrlElem(eventTarget)) return;

		let eventElem: HTMLElement | null;



		if ((eventElem = eventTarget.closest('.gitRef')) !== null) {

			// .gitRef was right clicked

			handledEvent(e);

			const commitElem = <HTMLElement>eventElem.closest('.commit')!;

			const commit = view.getCommitOfElem(commitElem);

			if (commit === null) return;

			if (eventElem.classList.contains(CLASS_REF_GERRIT)) return; // the Gerrit badge has no context menu



			const target: ContextMenuTarget & DialogTarget & RefTarget = {

				type: TargetType.Ref,

				hash: commit.hash,

				index: parseInt(commitElem.dataset.id!),

				ref: unescapeHtml(eventElem.dataset.name!),

				elem: <HTMLElement>eventElem.children[1]

			};



			let actions: ContextMenuActions;

			if (eventElem.classList.contains(CLASS_REF_STASH)) {

				actions = getStashContextMenuActions(view, target);

			} else if (eventElem.classList.contains(CLASS_REF_TAG)) {

				actions = getTagContextMenuActions(view, eventElem.dataset.tagtype === 'annotated', target);

			} else {

				let isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');

				if (isHead && isRemoteCombinedWithHead) {

					target.ref = unescapeHtml((<HTMLElement>eventTarget).dataset.fullref!);

					target.elem = <HTMLElement>eventTarget;

					isHead = false;

				}

				if (isHead) {

					actions = getBranchContextMenuActions(view, target);

				} else {

					const remote = unescapeHtml((isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!);

					actions = getRemoteBranchContextMenuActions(view, remote, target);

				}

			}



			contextMenu.show(actions, false, target, <MouseEvent>e, view.viewElem);



		} else if ((eventElem = eventTarget.closest('.commit')) !== null) {

			// .commit was right clicked

			handledEvent(e);

			const commit = view.getCommitOfElem(eventElem);

			if (commit === null) return;



			const target: ContextMenuTarget & DialogTarget & CommitTarget = {

				type: TargetType.Commit,

				hash: commit.hash,

				index: parseInt(eventElem.dataset.id!),

				elem: eventElem

			};



			let actions: ContextMenuActions;

			if (commit.hash === UNCOMMITTED) {

				actions = getUncommittedChangesContextMenuActions(view, target);

			} else if (commit.stash !== null) {

				target.ref = commit.stash.selector;

				actions = getStashContextMenuActions(view, <RefTarget>target);

			} else {

				actions = getCommitContextMenuActions(view, target);

			}



			contextMenu.show(actions, false, target, <MouseEvent>e, view.viewElem);

		}

	});

}


function makeTableResizable(view: GitGraphView) {

	// Every .tableColHeader element is a direct child of colHeadersElem, so read them from there
	// instead of document.getElementsByClassName: that searches the whole document (every cell of
	// every commit row) for a handful of matches, and - being a live HTMLCollection - would also
	// re-run that document-wide scan on every .length/indexed access below if captured directly.
	let colHeadersElem = document.getElementById('tableColHeaders')!, cols = Array.from(colHeadersElem.children) as HTMLElement[];

	let columnWidths: GG.ColumnWidth[], mouseX = -1, col = -1, colIndex = -1;



	const makeTableFixedLayout = () => {

		cols[0].style.width = columnWidths[0] + 'px';

		cols[0].style.padding = '';

		for (let i = 2; i < cols.length; i++) {

			cols[i].style.width = columnWidths[parseInt(cols[i].dataset.col!)] + 'px';

		}

		view.tableElem.className = 'fixedLayout';

		view.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);

		view.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);

	};



	for (let i = 0; i < cols.length; i++) {

		let col = parseInt(cols[i].dataset.col!);

		cols[i].innerHTML += (i > 0 ? '<span class="resizeCol left" data-col="' + (col - 1) + '"></span>' : '') + (i < cols.length - 1 ? '<span class="resizeCol right" data-col="' + col + '"></span>' : '');

	}



	let cWidths = view.gitRepos[view.currentRepo].columnWidths;

	if (cWidths === null) { // Initialise auto column layout if it is the first time viewing the repo.

		let defaults = view.config.defaultColumnVisibility;

		columnWidths = [COLUMN_AUTO, COLUMN_AUTO, defaults.date ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.author ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.commit ? COLUMN_AUTO : COLUMN_HIDDEN];

		view.saveColumnWidths(columnWidths);

	} else {

		columnWidths = [cWidths[0], COLUMN_AUTO, cWidths[1], cWidths[2], cWidths[3]];

	}



	if (columnWidths[0] !== COLUMN_AUTO) {

		// Table should have fixed layout

		makeTableFixedLayout();

	} else {

		// Table should have automatic layout

		view.tableElem.className = 'autoLayout';

		applyGraphColumnAutoLayout(view);

	}



	const processResizingColumn: EventListener = (e) => {

		if (col > -1) {

			let mouseEvent = <MouseEvent>e;

			let mouseDeltaX = mouseEvent.clientX - mouseX;



			if (col === 0) {

				if (columnWidths[0] + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -columnWidths[0] + COLUMN_MIN_WIDTH;

				if (cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - COLUMN_MIN_WIDTH;

				columnWidths[0] += mouseDeltaX;

				cols[0].style.width = columnWidths[0] + 'px';

				view.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);

			} else {

				let colWidth = col !== 1 ? columnWidths[col] : cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING;

				let nextCol = col + 1;

				while (columnWidths[nextCol] === COLUMN_HIDDEN) nextCol++;



				if (colWidth + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -colWidth + COLUMN_MIN_WIDTH;

				if (columnWidths[nextCol] - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = columnWidths[nextCol] - COLUMN_MIN_WIDTH;

				if (col !== 1) {

					columnWidths[col] += mouseDeltaX;

					cols[colIndex].style.width = columnWidths[col] + 'px';

				}

				columnWidths[nextCol] -= mouseDeltaX;

				cols[colIndex + 1].style.width = columnWidths[nextCol] + 'px';

			}

			mouseX = mouseEvent.clientX;

		}

	};

	const stopResizingColumn: EventListener = () => {

		if (col > -1) {

			col = -1;

			colIndex = -1;

			mouseX = -1;

			eventOverlay.remove();

			view.saveColumnWidths(columnWidths);

		}

	};



	// Every commit row (not just the header) carries its own pair of .resizeCol handles, so the
	// hit area spans the table's full height - with hundreds/thousands of loaded commits that's
	// thousands of elements. A single delegated listener on the <table> just inserted by
	// renderTable() (torn down and recreated together with all of them on the next render, so
	// there's no risk of accumulating stale listeners across renders) replaces what was previously
	// one addEventListener call per handle, and was the dominant cost of a full render.
	const tableRootElem = <HTMLElement>view.tableElem.firstElementChild;
	tableRootElem.addEventListener('mousedown', (e) => {
		const resizeColElem = e.target !== null ? (<HTMLElement>e.target).closest('.resizeCol') : null;
		if (resizeColElem === null) return;

		col = parseInt((<HTMLElement>resizeColElem).dataset.col!);

		while (columnWidths[col] === COLUMN_HIDDEN) col--;

		mouseX = (<MouseEvent>e).clientX;



		let isAuto = columnWidths[0] === COLUMN_AUTO;

		for (let i = 0; i < cols.length; i++) {

			let curCol = parseInt(cols[i].dataset.col!);

			if (isAuto && curCol !== 1) columnWidths[curCol] = cols[i].clientWidth - COLUMN_LEFT_RIGHT_PADDING;

			if (curCol === col) colIndex = i;

		}

		if (isAuto) makeTableFixedLayout();

		eventOverlay.create('colResize', processResizingColumn, stopResizingColumn);

	});



	colHeadersElem.addEventListener('contextmenu', (e: MouseEvent) => {

		handledEvent(e);



		const toggleColumnState = (col: number, defaultWidth: number) => {

			columnWidths[col] = columnWidths[col] !== COLUMN_HIDDEN ? COLUMN_HIDDEN : columnWidths[0] === COLUMN_AUTO ? COLUMN_AUTO : defaultWidth - COLUMN_LEFT_RIGHT_PADDING;

			view.saveColumnWidths(columnWidths);

			view.render();

		};



		const commitOrdering = getCommitOrdering(view.gitRepos[view.currentRepo].commitOrdering);

		const changeCommitOrdering = (repoCommitOrdering: GG.RepoCommitOrdering) => {

			view.saveRepoStateValue(view.currentRepo, 'commitOrdering', repoCommitOrdering);

			view.refresh(true);

		};



		contextMenu.show([

			[

				{

					title: strings.columnDate,

					visible: true,

					checked: columnWidths[2] !== COLUMN_HIDDEN,

					onClick: () => toggleColumnState(2, 128)

				},

				{

					title: strings.columnAuthor,

					visible: true,

					checked: columnWidths[3] !== COLUMN_HIDDEN,

					onClick: () => toggleColumnState(3, 128)

				},

				{

					title: strings.columnCommit,

					visible: true,

					checked: columnWidths[4] !== COLUMN_HIDDEN,

					onClick: () => toggleColumnState(4, 80)

				}

			],

			[

				{

					title: strings.orderCommitTimestamp,

					visible: true,

					checked: commitOrdering === GG.CommitOrdering.Date,

					onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Date)

				},

				{

					title: strings.orderAuthorTimestamp,

					visible: true,

					checked: commitOrdering === GG.CommitOrdering.AuthorDate,

					onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.AuthorDate)

				},

				{

					title: strings.orderTopological,

					visible: true,

					checked: commitOrdering === GG.CommitOrdering.Topological,

					onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Topological)

				}

			]

		], true, null, e, view.viewElem);

	});

}


/* File Tree Helpers (commit details view file tree / file list rendering and state) */

function generateFileViewHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, type: GG.FileViewType, isUncommitted: boolean) {
	return type === GG.FileViewType.List
		? generateFileListHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted)
		: generateFileTreeHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, true);
}

function generateFileTreeHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean, topLevelFolder: boolean): string {
	const curFolderInfo = topLevelFolder || !initialState.config.commitDetailsView.fileTreeCompactFolders
		? { folder: folder, name: folder.name, pathSeg: folder.name }
		: getCurrentFolderInfo(folder, folder.name, folder.name);

	const children = sortFolderKeys(curFolderInfo.folder).map((key) => {
		const cur = curFolderInfo.folder.contents[key];
		return cur.type === 'folder'
			? generateFileTreeHtml(cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, false)
			: generateFileTreeLeafHtml(cur.name, cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
	});

	return (topLevelFolder ? '' : '<li' + (curFolderInfo.folder.open ? '' : ' class="closed"') + ' data-pathseg="' + encodeURIComponent(curFolderInfo.pathSeg) + '"><span class="fileTreeFolder' + (curFolderInfo.folder.reviewed ? '' : ' pendingReview') + '" title="./' + escapeHtml(curFolderInfo.folder.folderPath) + '" data-folderpath="' + encodeURIComponent(curFolderInfo.folder.folderPath) + '"><span class="fileTreeFolderIcon">' + (curFolderInfo.folder.open ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder) + '</span><span class="gitFolderName">' + escapeHtml(curFolderInfo.name) + '</span></span>') +
		'<ul class="fileTreeFolderContents' + (curFolderInfo.folder.open ? '' : ' hidden') + '">' + children.join('') + '</ul>' +
		(topLevelFolder ? '' : '</li>');
}

function getCurrentFolderInfo(folder: FileTreeFolder, name: string, pathSeg: string): { folder: FileTreeFolder, name: string, pathSeg: string } {
	const keys = Object.keys(folder.contents);
	let child: FileTreeNode;
	return keys.length === 1 && (child = folder.contents[keys[0]]).type === 'folder'
		? getCurrentFolderInfo(<FileTreeFolder>child, name + ' / ' + child.name, pathSeg + '/' + child.name)
		: { folder: folder, name: name, pathSeg: pathSeg };
}

function generateFileListHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean) {
	const sortLeaves = (folder: FileTreeFolder, folderPath: string) => {
		let keys = sortFolderKeys(folder);
		let items: { relPath: string, leaf: FileTreeLeaf }[] = [];
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			let relPath = (folderPath !== '' ? folderPath + '/' : '') + cur.name;
			if (cur.type === 'folder') {
				items = items.concat(sortLeaves(cur, relPath));
			} else {
				items.push({ relPath: relPath, leaf: cur });
			}
		}
		return items;
	};
	let sortedLeaves = sortLeaves(folder, '');
	let html = '';
	for (let i = 0; i < sortedLeaves.length; i++) {
		html += generateFileTreeLeafHtml(sortedLeaves[i].relPath, sortedLeaves[i].leaf, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
	}
	return '<ul class="fileTreeFolderContents">' + html + '</ul>';
}

function generateFileTreeLeafHtml(name: string, leaf: FileTreeLeaf, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean) {
	let encodedName = encodeURIComponent(name), escapedName = escapeHtml(name);
	if (leaf.type === 'file') {
		const fileTreeFile: GG.GitFileChange = gitFiles[leaf.index];
		const type = fileTreeFile.type;
		const textFile = fileTreeFile.additions !== null && fileTreeFile.deletions !== null;
		const diffPossible = type === GG.GitFileStatus.Untracked || textFile;
		const changeTypeMessage = GIT_FILE_CHANGE_TYPES[type] + (type === GG.GitFileStatus.Renamed ? ' (' + escapeHtml(fileTreeFile.oldFilePath) + ' → ' + escapeHtml(fileTreeFile.newFilePath) + ')' : '');
		return '<li data-pathseg="' + encodedName + '"><span class="fileTreeFileRecord' + (leaf.index === fileContextMenuOpen ? ' ' + CLASS_CONTEXT_MENU_ACTIVE : '') + '" data-index="' + leaf.index + '"><span class="fileTreeFile' + (diffPossible ? ' gitDiffPossible' : '') + (leaf.reviewed ? '' : ' ' + CLASS_PENDING_REVIEW) + '" title="' + (diffPossible ? 'Click to View Diff' : 'Unable to View Diff' + (type !== GG.GitFileStatus.Deleted ? ' (this is a binary file)' : '')) + ' • ' + changeTypeMessage + '"><span class="fileTreeFileIcon">' + SVG_ICONS.file + '</span><span class="gitFileName ' + type + '">' + escapedName + '</span></span>' +
			(initialState.config.enhancedAccessibility ? '<span class="fileTreeFileType" title="' + changeTypeMessage + '">' + type + '</span>' : '') +
			(type !== GG.GitFileStatus.Added && type !== GG.GitFileStatus.Untracked && type !== GG.GitFileStatus.Deleted && textFile ? '<span class="fileTreeFileAddDel">(<span class="fileTreeFileAdd" title="' + fileTreeFile.additions + ' addition' + (fileTreeFile.additions !== 1 ? 's' : '') + '">+' + fileTreeFile.additions + '</span>|<span class="fileTreeFileDel" title="' + fileTreeFile.deletions + ' deletion' + (fileTreeFile.deletions !== 1 ? 's' : '') + '">-' + fileTreeFile.deletions + '</span>)</span>' : '') +
			(fileTreeFile.newFilePath === lastViewedFile ? '<span id="cdvLastFileViewed" title="Last File Viewed">' + SVG_ICONS.eyeOpen + '</span>' : '') +
			'<span class="copyGitFile fileTreeFileAction" title="Copy Absolute File Path to Clipboard">' + SVG_ICONS.copy + '</span>' +
			(type !== GG.GitFileStatus.Deleted
				? (diffPossible && !isUncommitted ? '<span class="viewGitFileAtRevision fileTreeFileAction" title="View File at this Revision">' + SVG_ICONS.commit + '</span>' : '') +
				'<span class="openGitFile fileTreeFileAction" title="Open File">' + SVG_ICONS.openFile + '</span>'
				: ''
			) + '</span></li>';
	} else {
		return '<li data-pathseg="' + encodedName + '"><span class="fileTreeRepo" data-path="' + encodeURIComponent(leaf.path) + '" title="Click to View Repository"><span class="fileTreeRepoIcon">' + SVG_ICONS.closedFolder + '</span>' + escapedName + '</span></li>';
	}
}

function alterFileTreeFolderOpen(folder: FileTreeFolder, folderPath: string, open: boolean) {
	let path = folderPath.split('/'), i, cur = folder;
	for (i = 0; i < path.length; i++) {
		if (typeof cur.contents[path[i]] !== 'undefined') {
			cur = <FileTreeFolder>cur.contents[path[i]];
			if (i === path.length - 1) cur.open = open;
		} else {
			return;
		}
	}
}

function alterFileTreeFileReviewed(folder: FileTreeFolder, filePath: string, reviewed: boolean) {
	let path = filePath.split('/'), i, cur = folder, folders = [folder];
	for (i = 0; i < path.length; i++) {
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
	for (i = folders.length - 1; i >= 0; i--) {
		let keys = Object.keys(folders[i].contents), entireFolderReviewed = true;
		for (let j = 0; j < keys.length; j++) {
			let cur = folders[i].contents[keys[j]];
			if ((cur.type === 'folder' || cur.type === 'file') && !cur.reviewed) {
				entireFolderReviewed = false;
				break;
			}
		}
		folders[i].reviewed = entireFolderReviewed;
	}
}

function setFileTreeReviewed(folder: FileTreeFolder, reviewed: boolean) {
	folder.reviewed = reviewed;
	let keys = Object.keys(folder.contents);
	for (let i = 0; i < keys.length; i++) {
		let cur = folder.contents[keys[i]];
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
		let keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			if ((cur.type === 'folder' && !calc(cur)) || (cur.type === 'file' && !cur.reviewed)) reviewed = false;
		}
		folder.reviewed = reviewed;
		return reviewed;
	};
	calc(folder);
}

function updateFileTreeHtml(elem: HTMLElement, folder: FileTreeFolder) {
	let ul = getChildUl(elem);
	if (ul === null) return;

	for (let i = 0; i < ul.children.length; i++) {
		let li = <HTMLLIElement>ul.children[i];
		let pathSeg = decodeURIComponent(li.dataset.pathseg!);
		let child = getChildByPathSegment(folder, pathSeg);
		if (child.type === 'folder') {
			alterClass(<HTMLSpanElement>li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
			updateFileTreeHtml(li, child);
		} else if (child.type === 'file') {
			alterClass(<HTMLSpanElement>li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
		}
	}
}

function updateFileTreeHtmlFileReviewed(elem: HTMLElement, folder: FileTreeFolder, filePath: string) {
	let path = filePath;
	const update = (elem: HTMLElement, folder: FileTreeFolder) => {
		let ul = getChildUl(elem);
		if (ul === null) return;

		for (let i = 0; i < ul.children.length; i++) {
			let li = <HTMLLIElement>ul.children[i];
			let pathSeg = decodeURIComponent(li.dataset.pathseg!);
			if (path === pathSeg || path.startsWith(pathSeg + '/')) {
				let child = getChildByPathSegment(folder, pathSeg);
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

function getFilesInTree(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>) {
	let files: string[] = [];
	const scanFolder = (folder: FileTreeFolder) => {
		let keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
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
	let keys = Object.keys(folder.contents);
	keys.sort((a, b) => folder.contents[a].type !== 'file' && folder.contents[b].type === 'file' ? -1 : folder.contents[a].type === 'file' && folder.contents[b].type !== 'file' ? 1 : folder.contents[a].name.localeCompare(folder.contents[b].name));
	return keys;
}

function getChildByPathSegment(folder: FileTreeFolder, pathSeg: string) {
	let cur: FileTreeNode = folder, comps = pathSeg.split('/');
	for (let i = 0; i < comps.length; i++) {
		cur = (<FileTreeFolder>cur).contents[comps[i]];
	}
	return cur;
}

function haveFilesChanged(oldFiles: ReadonlyArray<GG.GitFileChange> | null, newFiles: ReadonlyArray<GG.GitFileChange> | null) {
	if ((oldFiles === null) !== (newFiles === null)) {
		return true;
	} else if (oldFiles === null && newFiles === null) {
		return false;
	} else {
		return !arraysEqual(oldFiles!, newFiles!, (a, b) => a.additions === b.additions && a.deletions === b.deletions && a.newFilePath === b.newFilePath && a.oldFilePath === b.oldFilePath && a.type === b.type);
	}
}

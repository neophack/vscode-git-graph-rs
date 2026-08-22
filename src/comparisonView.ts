import * as vscode from 'vscode';
import { DataSource } from './dataSource';
import { GitFileChange } from './types';
import { UNCOMMITTED, abbrevCommit, encodeJsonForInlineScript, getNonce, viewDiff } from './utils';
import { Disposable, toDisposable } from './utils/disposable';

/**
 * A webview tab that displays the changes between two commits in a GitHub-style layout:
 * a header with the overall statistics, a file tree sidebar of the changed files, and the
 * split diff view of the selected file. The per-file diffs are provided by the extension
 * (via `git diff`) in response to `getFileDiff` messages from the webview.
 */
export class CommitComparisonView extends Disposable {
	private static readonly openViews = new Map<string, CommitComparisonView>();

	private readonly panel: vscode.WebviewPanel;
	private fileChanges: ReadonlyArray<GitFileChange> = [];

	/**
	 * Opens a Commit Comparison View for the given commit range, reusing (and revealing) the
	 * existing tab when the same range is compared again.
	 */
	public static open(dataSource: DataSource, repo: string, fromHash: string, toHash: string) {
		const key = repo + '\n' + fromHash + '\n' + toHash;
		const existing = CommitComparisonView.openViews.get(key);
		if (existing !== undefined) {
			existing.panel.reveal();
			return;
		}
		new CommitComparisonView(dataSource, repo, fromHash, toHash, key);
	}

	private constructor(dataSource: DataSource, private readonly repo: string, private readonly fromHash: string, private readonly toHash: string, key: string) {
		super();

		this.panel = vscode.window.createWebviewPanel('git-graph-rs.compare', 'Compare ' + abbrevCommit(fromHash) + ' ↔ ' + (toHash === '' ? 'Present' : abbrevCommit(toHash)), vscode.ViewColumn.Active, {
			enableScripts: true
		});

		CommitComparisonView.openViews.set(key, this);

		this.registerDisposables(
			this.panel.onDidDispose(() => {
				CommitComparisonView.openViews.delete(key);
				this.dispose();
			}),
			this.panel.webview.onDidReceiveMessage(async (msg: any) => {
				if (this.isDisposed()) return;
				if (msg.command === 'getFileDiff') {
					const file = this.fileChanges[msg.index];
					let diff: string | null, error: string | null = null;
					try {
						diff = await dataSource.getCommitFileDiff(this.repo, this.fromHash, this.toHash, file.oldFilePath, file.newFilePath);
					} catch (errorMessage) {
						diff = null;
						error = errorMessage instanceof Error ? errorMessage.message : String(errorMessage);
					}
					this.panel.webview.postMessage({ command: 'fileDiff', index: msg.index, diff: diff, error: error });
				} else if (msg.command === 'viewDiff') {
					const file = this.fileChanges[msg.index];
					await viewDiff(this.repo, this.fromHash, this.toHash, file.oldFilePath, file.newFilePath, file.type);
				}
			}),
			toDisposable(() => {
				CommitComparisonView.openViews.delete(key);
				this.panel.dispose();
			})
		);

		this.panel.webview.html = this.getHtml(null, {}, true);
		// Load the file changes and the summaries of the two commits in parallel, so the view is
		// ready as soon as possible
		Promise.all([
			dataSource.getCommitComparison(repo, fromHash, toHash),
			dataSource.getCommitSummaries(repo, [fromHash, toHash].filter((hash) => hash !== '' && hash !== UNCOMMITTED))
		]).then((results) => {
			if (this.isDisposed()) return; // the tab was closed while the Git commands were running
			const comparison = results[0], summaries = results[1];
			this.fileChanges = comparison.error !== null ? [] : comparison.fileChanges;
			this.panel.webview.html = this.getHtml(comparison.error, summaries === null ? {} : summaries, false);
		}, (error: unknown) => {
			if (this.isDisposed()) return;
			this.panel.webview.html = this.getHtml(error instanceof Error ? error.message : String(error), {}, false);
		});
	}

	/**
	 * Generates the HTML of one of the two commit description cards shown in the header.
	 */
	private commitCardHtml(hash: string, summaries: { [hash: string]: { hash: string, author: string, email: string, date: number, message: string } }, role: 'base' | 'compare') {
		if (hash === '' || hash === UNCOMMITTED) {
			return '<div class="commitCard" data-role="' + role + '"><div class="firstLine"><span class="chip">Present</span><span class="author">Uncommitted changes</span></div><p class="message">The current working tree</p></div>';
		}
		const summary = summaries[hash];
		if (summary === undefined) {
			return '<div class="commitCard" data-role="' + role + '"><div class="firstLine"><span class="chip" title="' + escapeHtml(hash) + '">' + escapeHtml(abbrevCommit(hash)) + '</span></div></div>';
		}
		return '<div class="commitCard" data-role="' + role + '">' +
			'<div class="firstLine">' +
			'<span class="chip" title="' + escapeHtml(summary.hash) + '">' + escapeHtml(abbrevCommit(summary.hash)) + '</span>' +
			'<span class="author">' + escapeHtml(summary.author) + '</span>' +
			'<span class="date">' + escapeHtml(new Date(summary.date * 1000).toLocaleString()) + '</span>' +
			'</div>' +
			'<p class="message">' + escapeHtml(summary.message) + '</p>' +
			'</div>';
	}

	/**
	 * Generates the HTML of the comparison view. When `error` is non-null, an error message is
	 * shown instead of the file tree and diff view. All of the rendering logic lives in the
	 * embedded script, driven by the `changes` data.
	 */
	private getHtml(error: string | null, summaries: { [hash: string]: { hash: string, author: string, email: string, date: number, message: string } }, loading: boolean) {
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
	#header { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); flex-shrink: 0; }
	#header h1 { font-size: 14px; font-weight: 600; margin: 0 0 8px 0; }
	#commitCards { display: flex; align-items: stretch; gap: 12px; margin-bottom: 8px; }
	.commitCard { flex: 1; min-width: 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 8px 12px; }
	.commitCard .firstLine { display: flex; align-items: center; gap: 8px; }
	.commitCard .chip { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; background: rgba(128,128,128,0.15); border-radius: 4px; padding: 1px 6px; flex-shrink: 0; }
	.commitCard .author { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; }
	.commitCard .date { font-size: 11px; opacity: 0.7; margin-left: auto; flex-shrink: 0; }
	.commitCard .message { margin: 4px 0 0 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; max-height: 90px; overflow: auto; }
	#commitCards .arrowSep { align-self: center; font-size: 16px; opacity: 0.6; flex-shrink: 0; }
	#stats { font-size: 12px; opacity: 0.85; }
	#stats .additions { color: var(--vscode-gitDecoration-addedResourceForeground, #22863a); font-weight: 600; }
	#stats .deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #b31d28); font-weight: 600; }
	#body { display: flex; flex: 1; min-height: 0; }
	#sidebar { width: 280px; flex-shrink: 0; overflow: auto; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); padding: 6px 0; }
	#sidebar h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; opacity: 0.7; margin: 4px 12px; }
	.treeRow { display: flex; align-items: center; padding: 3px 12px 3px 8px; cursor: pointer; white-space: nowrap; user-select: none; }
	.treeRow:hover { background: var(--vscode-list-hoverBackground); }
	.treeRow.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
	.treeRow .arrow { width: 14px; text-align: center; flex-shrink: 0; opacity: 0.8; }
	.treeRow .name { overflow: hidden; text-overflow: ellipsis; flex: 1; }
	.treeRow .counts { font-size: 11px; margin-left: 8px; flex-shrink: 0; }
	.counts .additions { color: var(--vscode-gitDecoration-addedResourceForeground, #22863a); }
	.counts .deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #b31d28); }
	.letter { width: 13px; margin-right: 5px; text-align: center; font-weight: 600; flex-shrink: 0; }
	#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
	#fileHeader { display: flex; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); flex-shrink: 0; gap: 8px; }
	#fileHeader:empty { display: none; }
	#filePath { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
	#fileHeader button { flex-shrink: 0; }
	#diffArea { flex: 1; overflow: auto; }
	.status { padding: 16px; opacity: 0.8; }
		table.diff { border-collapse: collapse; width: 100%; table-layout: fixed; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 19px; }
		table.diff td { padding: 0 8px; vertical-align: top; }
		table.diff td.code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; }
		td.ln { width: 46px; text-align: right; color: var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.7)); user-select: none; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); background: rgba(128,128,128,0.06); }
	tr.ctx td.code { background: var(--vscode-editor-background); }
	tr.add td.code, tr.add td.ln { background: rgba(46,160,67,0.15); }
	tr.add td.code { color: var(--vscode-gitDecoration-addedResourceForeground, #22863a); }
	tr.del td.code, tr.del td.ln { background: rgba(248,81,73,0.15); }
	tr.del td.code { color: var(--vscode-gitDecoration-deletedResourceForeground, #b31d28); }
	tr.hunk td { background: var(--vscode-editorInlayHint-background, rgba(127,127,127,0.15)); color: var(--vscode-editorInlayHint-foreground, inherit); padding: 2px 8px; font-size: 11px; }
</style>
</head>
<body>
<div id="header">
	<h1>Comparing changes</h1>
	<div id="commitCards">${this.commitCardHtml(this.fromHash, summaries, 'base')}<span class="arrowSep">&hellip;</span>${this.commitCardHtml(this.toHash, summaries, 'compare')}</div>
	<div id="stats"></div>
</div>
<div id="body">
	<div id="sidebar"><h2>${error !== null ? 'Error' : 'Files changed'}</h2></div>
	<div id="main"><div id="fileHeader"></div><div id="diffArea"><div class="status">${loading ? 'Loading changes&hellip;' : escapeHtml(error !== null ? error : 'No changes between these commits.')}</div></div></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const changes = ${encodeJsonForInlineScript(JSON.stringify(this.fileChanges))};
	const LETTERS = { A: 'A', C: 'C', D: 'D', M: 'M', R: 'R', T: 'T', U: 'U', '??': 'U' };
	let selectedIndex = -1, requestedIndex = -1;

	/* ---------- Statistics header ---------- */
	let totalAdditions = 0, totalDeletions = 0;
	for (const file of changes) {
		if (file.additions !== null) totalAdditions += file.additions;
		if (file.deletions !== null) totalDeletions += file.deletions;
	}
	if (changes.length > 0) {
		document.getElementById('stats').innerHTML =
			(changes.length === 1 ? '1 file changed' : changes.length + ' files changed') +
			(totalAdditions > 0 ? ' with <span class="additions">+' + totalAdditions + '</span>' : '') +
			(totalDeletions > 0 ? ' <span class="deletions">&minus;' + totalDeletions + '</span>' : '');
	}

	/* ---------- File tree sidebar ---------- */
	// Build a nested tree from the flat list of file paths
	const root = { name: '', folders: {}, files: [] };
	changes.forEach((file, index) => {
		const path = (file.newFilePath !== '' ? file.newFilePath : file.oldFilePath).split('/');
		let cur = root;
		for (let i = 0; i < path.length - 1; i++) {
			if (typeof cur.folders[path[i]] === 'undefined') cur.folders[path[i]] = { name: path[i], folders: {}, files: [] };
			cur = cur.folders[path[i]];
		}
		cur.files.push({ name: path[path.length - 1], file: file, index: index });
	});

	const sidebar = document.getElementById('sidebar');
	function escapeHtml(str) {
		return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	function countsHtml(file) {
		return file.additions !== null && file.deletions !== null
			? '<span class="counts"><span class="additions">+' + file.additions + '</span> <span class="deletions">-' + file.deletions + '</span></span>'
			: '';
	}
	function statusColour(file) {
		return file.type === 'D' ? 'var(--vscode-gitDecoration-deletedResourceForeground, #b31d28)'
			: file.type === 'A' || file.type === 'R' ? 'var(--vscode-gitDecoration-addedResourceForeground, #22863a)'
			: 'var(--vscode-gitDecoration-modifiedResourceForeground, inherit)';
	}
	function renderTree(folder, container, depth) {
		for (const name of Object.keys(folder.folders).sort()) {
			const sub = folder.folders[name];
			const row = document.createElement('div');
			row.className = 'treeRow';
			row.style.paddingLeft = (8 + depth * 14) + 'px';
			row.innerHTML = '<span class="arrow">&#9662;</span><span class="name">' + escapeHtml(name) + '</span>';
			const children = document.createElement('div');
			row.addEventListener('click', () => {
				children.style.display = children.style.display === 'none' ? '' : 'none';
				row.querySelector('.arrow').textContent = children.style.display === 'none' ? '\\u25B8' : '\\u25BE';
			});
			container.appendChild(row);
			renderTree(sub, children, depth + 1);
			container.appendChild(children);
		}
		const sorted = folder.files.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of sorted) {
			const row = document.createElement('div');
			row.className = 'treeRow file';
			row.style.paddingLeft = (22 + depth * 14) + 'px';
			row.dataset.index = entry.index;
			row.innerHTML = '<span class="letter" style="color: ' + statusColour(entry.file) + '">' + (LETTERS[entry.file.type] || '?') + '</span>' +
				'<span class="name" title="' + escapeHtml(entry.file.newFilePath || entry.file.oldFilePath) + '">' + escapeHtml(entry.name) + '</span>' + countsHtml(entry.file);
			row.addEventListener('click', () => selectFile(entry.index));
			container.appendChild(row);
		}
	}
	if (changes.length > 0) renderTree(root, sidebar, 0);

	/* ---------- Diff view ---------- */
	const diffArea = document.getElementById('diffArea');
	const diffCache = {}; // index -> { diff: string|null, error: string|null }: revisiting a file is instant
	function selectFile(index) {
		selectedIndex = index;
		document.querySelectorAll('.treeRow.file').forEach((row) => row.classList.toggle('selected', parseInt(row.dataset.index) === index));
		const file = changes[index];
		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		document.getElementById('fileHeader').innerHTML =
			'<span class="letter" style="color: ' + statusColour(file) + '">' + (LETTERS[file.type] || '?') + '</span>' +
			'<span id="filePath">' + escapeHtml(filePath) + '</span>' + countsHtml(file) +
			'<button id="openDiffBtn">Open Diff in Editor</button>';
		document.getElementById('openDiffBtn').addEventListener('click', () => vscode.postMessage({ command: 'viewDiff', index: index }));
		const cached = diffCache[index];
		if (cached !== undefined) {
			showDiff(cached);
		} else {
			diffArea.innerHTML = '<div class="status">Loading diff&hellip;</div>';
			vscode.postMessage({ command: 'getFileDiff', index: index });
		}
		requestedIndex = index;
	}

	function showDiff(result) {
		if (result.error !== null) {
			diffArea.innerHTML = '<div class="status">' + escapeHtml(result.error) + '</div>';
		} else {
			renderDiff(result.diff);
		}
	}

	// Parse a unified diff into split-view rows (old side / new side), GitHub style
	function renderDiff(diffText) {
			const table = document.createElement('table');
			table.className = 'diff';
			table.innerHTML = '<colgroup><col style="width: 46px"><col style="width: calc(50% - 46px)"><col style="width: 46px"><col style="width: calc(50% - 46px)"></colgroup>';
		let oldLine = 0, newLine = 0, rows = document.createDocumentFragment();
		function row(trClass, o, n, oldContent, newContent) {
			const tr = document.createElement('tr');
			tr.className = trClass;
			tr.innerHTML = '<td class="ln">' + (o === null ? '' : o) + '</td><td class="code">' + (oldContent === null ? '' : escapeHtml(oldContent)) + '</td>' +
				'<td class="ln">' + (n === null ? '' : n) + '</td><td class="code">' + (newContent === null ? '' : escapeHtml(newContent)) + '</td>';
			rows.appendChild(tr);
		}
		const lines = diffText.split('\\n');
		let binary = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) binary = true;
			const hunk = line.match(/^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/);
			if (hunk !== null) {
				const tr = document.createElement('tr');
				tr.className = 'hunk';
				tr.innerHTML = '<td colspan="4">' + escapeHtml(line) + '</td>';
				rows.appendChild(tr);
				oldLine = parseInt(hunk[1]);
				newLine = parseInt(hunk[3]);
				continue;
			}
			if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') ||
				line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('old mode') || line.startsWith('new mode') ||
				line.startsWith('similarity index') || line.startsWith('rename ') || line.startsWith('copy ') || line.startsWith('\\ No newline') || hunk === null && !line.startsWith(' ') && !line.startsWith('+') && !line.startsWith('-')) {
				continue;
			}
			if (line.startsWith('+')) {
				row('add', null, newLine++, null, line.substring(1));
			} else if (line.startsWith('-')) {
				row('del', oldLine++, null, line.substring(1), null);
			} else {
				row('ctx', oldLine++, newLine++, line.substring(1), line.substring(1));
			}
		}
		if (binary) {
			diffArea.innerHTML = '<div class="status">Binary file &mdash; the diff cannot be displayed.</div>';
		} else if (rows.childNodes.length === 0) {
			diffArea.innerHTML = '<div class="status">No textual changes.</div>';
		} else {
			table.appendChild(rows);
			diffArea.innerHTML = '';
			diffArea.appendChild(table);
		}
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.command === 'fileDiff') {
			diffCache[msg.index] = { diff: msg.diff, error: msg.error };
			if (msg.index === requestedIndex) showDiff(diffCache[msg.index]);
		}
	});

	if (changes.length > 0) selectFile(0);
</script>
</body>
</html>`;
	}
}

function escapeHtml(str: string) {
	return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

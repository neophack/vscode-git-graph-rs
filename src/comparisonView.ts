import * as path from 'path';
import * as vscode from 'vscode';
import { BinaryComparePost, binaryCompareCss, binaryCompareScript, createHexSession, respondHexInfo, respondImageData, respondHexRows, wireHexSession } from './binaryCompare';
import { BinaryCompareView } from './binaryCompareView';
import { DataSource } from './dataSource';
import { HexDiffSession } from './hexDiff';
import { t } from './i18n';
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
	/** Hex comparison sessions by file index; only the most recent few are kept (they hold chunk caches). */
	private readonly hexSessions = new Map<number, HexDiffSession>();

	/**
	 * Opens a Commit Comparison View for the given commit range, reusing (and revealing) the
	 * existing tab when the same range is compared again. When `singleCommit` is set, the header
	 * presents the changes as those of `toHash` alone (opened via the "Open Changes" action)
	 * instead of showing both ends of the comparison; the tab is titled "Commit <hash>".
	 */
	public static open(extensionPath: string, dataSource: DataSource, repo: string, fromHash: string, toHash: string, singleCommit: boolean) {
		const key = repo + '\n' + fromHash + '\n' + toHash + '\n' + (singleCommit ? '1' : '0');
		const existing = CommitComparisonView.openViews.get(key);
		if (existing !== undefined) {
			existing.panel.reveal();
			return;
		}
		new CommitComparisonView(extensionPath, dataSource, repo, fromHash, toHash, singleCommit, key);
	}

	private constructor(private readonly extensionPath: string, private readonly dataSource: DataSource, private readonly repo: string, private readonly fromHash: string, private readonly toHash: string, private readonly singleCommit: boolean, key: string) {
		super();

		this.panel = vscode.window.createWebviewPanel('git-graph-rs.compare', this.singleCommit
			? t('commitPanelTitle', abbrevCommit(this.toHash))
			: t('comparePanelTitle', abbrevCommit(fromHash), toHash === '' ? t('comparePresentLabel') : abbrevCommit(toHash)), vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))]
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
				} else if (msg.command === 'viewDiffBinary') {
					// Binary files have no textual diff to open in the native editor: the
					// standalone Binary Compare tab shows the full hex / picture comparison.
					const file = this.fileChanges[msg.index];
					if (file !== undefined) {
						BinaryCompareView.open(this.dataSource, this.repo, this.fromHash, this.toHash, file);
					}
				} else if (msg.command === 'getHexInfo') {
					const session = this.hexSession(msg.index);
					if (session === null) return;
					await respondHexInfo(session, msg.index, msg.bytesPerRow, this.hexPost());
				} else if (msg.command === 'getHexRows') {
					const session = this.hexSessions.get(msg.index);
					if (session === undefined) return;
					await respondHexRows(session, msg.index, msg.start, msg.count, this.hexPost());
				} else if (msg.command === 'requestCounts') {
					// The deferred +N/-M counts of the file list, asked for after the list itself has
					// rendered — computing them means reading two blobs per file, which on a large
					// range is the slow half of the load.
					const result = await this.dataSource.getCommitFileCounts(this.repo, this.fromHash, this.toHash, msg.paths);
					if (!this.isDisposed()) this.panel.webview.postMessage({ command: 'lineCounts', counts: result.counts });
				} else if (msg.command === 'getImageData') {
					const session = this.hexSession(msg.index);
					const file = this.fileChanges[msg.index];
					if (session === null || file === undefined) return;
					await respondImageData(session, msg.index, file, this.hexPost());
				}
			}),
			toDisposable(() => {
				CommitComparisonView.openViews.delete(key);
				for (const session of this.hexSessions.values()) session.dispose();
				this.hexSessions.clear();
				this.panel.dispose();
			})
		);

		this.panel.webview.html = this.getHtml(null, {}, null, true);
		// Load the file changes, the summaries of the commits shown in the header, and the number
		// of commits between them in parallel, so the view is ready as soon as possible.
		Promise.all([
			dataSource.getCommitComparison(repo, fromHash, toHash),
			dataSource.getCommitSummaries(repo, (this.singleCommit ? [toHash] : [fromHash, toHash]).filter((hash) => hash !== '' && hash !== UNCOMMITTED)),
			this.getCommitsBetweenCount()
		]).then((results) => {
			if (this.isDisposed()) return; // the tab was closed while the Git commands were running
			const comparison = results[0], summaries = results[1], commitsBetween = results[2];
			this.fileChanges = comparison.error !== null ? [] : comparison.fileChanges;
			this.panel.webview.html = this.getHtml(comparison.error, summaries === null ? {} : summaries, commitsBetween, false);
		}, (error: unknown) => {
			if (this.isDisposed()) return;
			this.panel.webview.html = this.getHtml(error instanceof Error ? error.message : String(error), {}, null, false);
		});
	}

	/**
	 * The number of commits strictly between `fromHash` and `toHash` (i.e. reachable from `toHash`
	 * but not from `fromHash`), shown in the header between the two commit cards. NULL when it
	 * can't be determined (comparing from the working tree, or the count failed).
	 */
	private getCommitsBetweenCount(): Promise<number | null> {
		if (this.singleCommit || this.fromHash === '' || this.fromHash === UNCOMMITTED) return Promise.resolve(null);
		const tip = this.toHash === '' || this.toHash === UNCOMMITTED ? 'HEAD' : this.toHash;
		return this.dataSource.countCommitsBefore(this.repo, [tip], this.fromHash, false, false);
	}

	/** A poster for the shared binary-compare responders that checks the panel's lifetime. */
	private hexPost(): BinaryComparePost {
		return (message) => {
			if (!this.isDisposed()) void this.panel.webview.postMessage(message);
		};
	}

	/**
	 * The hex comparison session of a file, creating it on first use. Re-selecting a file
	 * reuses its session (the visible chunks stay cached); at most a few sessions are kept
	 * alive, since each one may hold megabytes of blob chunks.
	 */
	private hexSession(index: number): HexDiffSession | null {
		const existing = this.hexSessions.get(index);
		if (existing !== undefined) {
			this.hexSessions.delete(index);
			this.hexSessions.set(index, existing);
			return existing;
		}
		const file = this.fileChanges[index];
		if (file === undefined) return null;
		const session = createHexSession(this.dataSource, this.repo, this.fromHash, this.toHash, file);
		wireHexSession(session, index, this.hexPost());
		this.hexSessions.set(index, session);
		while (this.hexSessions.size > 4) {
			const oldest = this.hexSessions.keys().next();
			if (oldest.done) break;
			const evicted = this.hexSessions.get(oldest.value);
			this.hexSessions.delete(oldest.value);
			if (evicted !== undefined) evicted.dispose();
		}
		return session;
	}

	/**
	 * Generates the HTML of one of the commit description cards shown in the header. The role
	 * 'single' (the "Open Changes" presentation) carries no `data-role`, so the card keeps its
	 * standalone borders instead of the joined halves of a comparison pair, and shows the
	 * commit's subject line between the author and the date (ellipsized to the available width,
	 * so the collapsed card identifies the commit without expanding its full message).
	 */
	private commitCardHtml(hash: string, summaries: { [hash: string]: { hash: string, author: string, email: string, date: number, message: string } }, role: 'base' | 'compare' | 'single') {
		const roleAttr = role === 'single' ? '' : ' data-role="' + role + '"';
		if (hash === '' || hash === UNCOMMITTED) {
			return '<div class="commitCard hasMessage"' + roleAttr + '><div class="firstLine"><span class="chip">' + t('comparePresentLabel') + '</span><span class="author">' + t('compareUncommittedLabel') + '</span><span class="toggle">&#9656;</span></div><p class="message">' + t('compareWorkingTreeLabel') + '</p></div>';
		}
		const summary = summaries[hash];
		if (summary === undefined) {
			return '<div class="commitCard"' + roleAttr + '><div class="firstLine"><span class="chip" title="' + escapeHtml(hash) + '">' + escapeHtml(abbrevCommit(hash)) + '</span></div></div>';
		}
		const subject = summary.message.split(/\r?\n/)[0];
		return '<div class="commitCard hasMessage"' + roleAttr + '>' +
			'<div class="firstLine">' +
			'<span class="chip" title="' + escapeHtml(summary.hash) + '">' + escapeHtml(abbrevCommit(summary.hash)) + '</span>' +
			'<span class="author">' + escapeHtml(summary.author) + '</span>' +
			(role === 'single' ? '<span class="subject" title="' + escapeHtml(subject) + '">' + escapeHtml(subject) + '</span>' : '') +
			'<span class="date">' + escapeHtml(new Date(summary.date * 1000).toLocaleString()) + '</span>' +
			'<span class="toggle">&#9656;</span>' +
			'</div>' +
			'<p class="message">' + escapeHtml(summary.message) + '</p>' +
			'</div>';
	}

	/**
	 * Generates the HTML of the comparison view. When `error` is non-null, an error message is
	 * shown instead of the file tree and diff view. All of the rendering logic lives in the
	 * embedded script, driven by the `changes` data.
	 */
	private getHtml(error: string | null, summaries: { [hash: string]: { hash: string, author: string, email: string, date: number, message: string } }, commitsBetween: number | null, loading: boolean) {
		const nonce = getNonce();
		const hljsUri = this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionPath, 'media', 'vendor', 'highlight.min.js')));
		const commitsBetweenHtml = commitsBetween === null ? '' : escapeHtml(commitsBetween === 1 ? t('compareCommitsBetweenOne') : t('compareCommitsBetween', commitsBetween));
		// In the single-commit presentation only the commit itself is shown; otherwise the header
		// pairs the two ends of the comparison around a divider with the commits-between count.
		const commitCardsHtml = this.singleCommit
			? this.commitCardHtml(this.toHash, summaries, 'single')
			: this.commitCardHtml(this.fromHash, summaries, 'base') + '<div class="compareDivider" id="compareDivider" title="' + t('compareToggleMessagesTitle') + '"><span class="arrow">&#8594;</span><span class="count">' + commitsBetweenHtml + '</span></div>' + this.commitCardHtml(this.toHash, summaries, 'compare');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<style>
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); margin: 0; padding: 0 2px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; box-sizing: border-box; }
	#header { padding: 2px 0px 2px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); flex-shrink: 0; }
	#commitCards { display: flex; align-items: stretch; gap: 0; margin-bottom: 0px; }
	.commitCard { flex: 1; min-width: 0; background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.06)); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35))); border-radius: 4px; padding: 10px 10px; transition: background-color 0.1s ease; }
	.commitCard[data-role="base"] { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none; }
	.commitCard[data-role="compare"] { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left: none; }
	.commitCard .firstLine { display: flex; align-items: center; gap: 7px; }
	.commitCard.hasMessage .firstLine { cursor: pointer; margin: -3px -6px; padding: 3px 6px; border-radius: 3px; }
	.commitCard.hasMessage .firstLine:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1)); }
	.commitCard .chip { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 15px; background: var(--vscode-badge-background, rgba(128,128,128,0.2)); color: var(--vscode-foreground); border-radius: 10px; padding: 1px 7px; flex-shrink: 0; }
	.commitCard .author { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; }
	/* The single-commit card's subject line: takes whatever width the window leaves between the
	   fixed chip/author/date and truncates with an ellipsis, so it always fits. */
	.commitCard .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 0; min-width: 0; opacity: 0.9; }
	.commitCard .date { font-size: 11px; opacity: 0.8; margin-left: auto; flex-shrink: 0; }
	.commitCard .toggle { display: inline-block; font-size: 9px; opacity: 0.55; flex-shrink: 0; transition: transform 0.12s ease; }
	#commitCards.expanded .toggle { transform: rotate(90deg); }
	.commitCard .message { margin: 6px 0 0 0; padding-top: 6px; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); white-space: pre-wrap; word-break: break-word; font-size: 12px; max-height: 120px; overflow: auto; }
	#commitCards:not(.expanded) .commitCard.hasMessage .message { display: none; margin: 0; padding: 0; border: none; }
	.compareDivider { flex-shrink: 0; width: 76px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; cursor: pointer; border-radius: 4px; padding: 4px 2px; }
	.compareDivider:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1)); }
	.compareDivider .arrow { font-size: 13px; opacity: 0.55; line-height: 1; }
	.compareDivider .count { font-size: 10px; line-height: 14px; background: var(--vscode-badge-background, rgba(128,128,128,0.2)); color: var(--vscode-badge-foreground, inherit); border-radius: 8px; padding: 1px 7px; white-space: nowrap; }
	.compareDivider .count:empty { display: none; }
	#body { display: flex; flex: 1; min-height: 0; }
	#sidebar { width: 280px; flex-shrink: 0; overflow: auto; padding: 6px 0; --indent-guide-color: var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,0.3)); }
	#sidebarResizer { flex-shrink: 0; width: 4px; margin-left: -2px; position: relative; z-index: 1; cursor: col-resize; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
	#sidebarResizer:hover, #sidebarResizer.resizing { border-right-color: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
	#sidebar h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; opacity: 0.7; margin: 4px 12px; }
	#sidebar h2 .additions { color: var(--vscode-gitDecoration-addedResourceForeground, #22863a); }
	#sidebar h2 .deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #b31d28); }
	.treeRow { display: flex; align-items: center; padding: 3px 12px 3px 8px; cursor: pointer; white-space: nowrap; user-select: none; }
	.treeRow:hover { background: var(--vscode-list-hoverBackground); }
	.treeRow.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
	.treeRow .arrow { width: 14px; text-align: center; flex-shrink: 0; opacity: 0.8; }
	.treeRow .name { overflow: hidden; text-overflow: ellipsis; flex: 1; }
	.treeRow .counts { font-size: 11px; margin-left: 8px; flex-shrink: 0; }
	.counts .additions { color: var(--vscode-gitDecoration-addedResourceForeground, #22863a); }
	.counts .deletions { color: var(--vscode-gitDecoration-deletedResourceForeground, #b31d28); }
	/* The &hellip; placeholder shown while a file's line counts are still being computed */
	.counts.pending { opacity: 0.6; }
	.letter { width: 13px; margin-right: 5px; text-align: center; font-weight: 600; flex-shrink: 0; }
	#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
	#fileHeader { display: flex; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); flex-shrink: 0; gap: 8px; }
	#fileHeader:empty { display: none; }
	#filePath { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
	#fileHeader button {
		/* VS Code secondary button, using the exact token pair VS Code's own .monaco-button.secondary
		   uses: secondaryForeground rides on secondaryBackground (dark text on the light/white
		   secondary backgrounds of light and high-contrast-light themes, light text elsewhere), so
		   the label stays readable in every theme (a UA-default button renders as a light grey
		   3D block with black text that clashes with every theme). */
		flex-shrink: 0;
		box-sizing: border-box;
		padding: 3px 12px;
		border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-button-border, transparent));
		border-radius: 2px;
		background: var(--vscode-button-secondaryBackground, #3a3d41);
		color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground, #ffffff));
		font-family: inherit;
		font-size: 12px;
		line-height: 17px;
		cursor: pointer;
		user-select: none;
		transition: background-color 100ms ease;
	}
	#fileHeader button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground, #45494e)); }
	#fileHeader button:active { opacity: 0.85; }
	#fileHeader button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	#diffArea { flex: 1; overflow: auto; }
	.status { padding: 16px; opacity: 0.8; }
		table.diff { border-collapse: collapse; width: 100%; table-layout: fixed; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 19px; }
		table.diff td { padding: 0 8px; vertical-align: top; }
		table.diff td.code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; }
		td.ln { width: 46px; text-align: right; color: var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.7)); user-select: none; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); background: rgba(128,128,128,0.06); }
	tr.ctx td.code { background: var(--vscode-editor-background); }
	/* A pure addition/deletion tints the whole line; a modified (paired) row tints its old side
	   like a deletion and its new side like an addition, the same two-tier convention (line tint +
	   a stronger tint on the exact changed text, via the "mark" rule below) VS Code's own diff
	   editor uses for its diffEditor.*Line/TextBackground colours. */
	tr.add td.new.code, tr.add td.new.ln, tr.mod td.new.code, tr.mod td.new.ln { background: var(--vscode-diffEditor-insertedLineBackground, rgba(46,160,67,0.15)); }
	tr.del td.old.code, tr.del td.old.ln, tr.mod td.old.code, tr.mod td.old.ln { background: var(--vscode-diffEditor-removedLineBackground, rgba(248,81,73,0.15)); }
	td.new mark { background: var(--vscode-diffEditor-insertedTextBackground, rgba(46,160,67,0.45)); }
	td.old mark { background: var(--vscode-diffEditor-removedTextBackground, rgba(248,81,73,0.45)); }
	table.diff mark { color: inherit; border-radius: 2px; }
		tr.hunk td { background: var(--vscode-editorInlayHint-background, rgba(127,127,127,0.15)); color: var(--vscode-editorInlayHint-foreground, inherit); padding: 2px 8px; font-size: 11px; }
		/* Syntax highlighting token colours: highlight.js classes, approximating VS Code's default
		   dark/light theme token colours (there is no API to read the user's actual TextMate theme
		   from a plain webview, so this is a fixed, reasonable approximation - the same tradeoff
		   VS Code's own built-in Markdown preview makes for fenced code blocks). */
		.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #569cd6; }
		.hljs-string, .hljs-attr, .hljs-template-tag, .hljs-regexp, .hljs-meta .hljs-string { color: #ce9178; }
		.hljs-title, .hljs-title.function_ { color: #dcdcaa; }
		.hljs-title.class_, .hljs-type, .hljs-built_in { color: #4ec9b0; }
		.hljs-comment, .hljs-quote { color: #6a9955; font-style: italic; }
		.hljs-number { color: #b5cea8; }
		.hljs-variable, .hljs-attribute, .hljs-params { color: #9cdcfe; }
		.hljs-symbol, .hljs-bullet { color: #d7ba7d; }
		body.vscode-light .hljs-keyword, body.vscode-light .hljs-selector-tag, body.vscode-light .hljs-literal, body.vscode-light .hljs-section, body.vscode-light .hljs-link { color: #0000ff; }
		body.vscode-light .hljs-string, body.vscode-light .hljs-attr, body.vscode-light .hljs-template-tag, body.vscode-light .hljs-regexp, body.vscode-light .hljs-meta .hljs-string { color: #a31515; }
		body.vscode-light .hljs-title, body.vscode-light .hljs-title.function_ { color: #795e26; }
		body.vscode-light .hljs-title.class_, body.vscode-light .hljs-type, body.vscode-light .hljs-built_in { color: #267f99; }
		body.vscode-light .hljs-comment, body.vscode-light .hljs-quote { color: #008000; }
		body.vscode-light .hljs-number { color: #098658; }
		body.vscode-light .hljs-variable, body.vscode-light .hljs-attribute, body.vscode-light .hljs-params { color: #001080; }
		body.vscode-light .hljs-symbol, body.vscode-light .hljs-bullet { color: #795e26; }
		${binaryCompareCss()}
</style>
</head>
<body>
<div id="header">
	<div id="commitCards">${commitCardsHtml}</div>
</div>
<div id="body">
	<div id="sidebar"><h2 id="filesChangedLabel">${error !== null ? t('compareErrorLabel') : t('compareFilesChangedLabel')}</h2></div>
	<div id="sidebarResizer"></div>
	<div id="main"><div id="fileHeader"></div><div id="diffArea"><div class="status">${loading ? t('compareLoadingChanges') : escapeHtml(error !== null ? error : t('compareNoChanges'))}</div></div></div>
</div>
<script nonce="${nonce}" src="${hljsUri}"></script>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const changes = ${encodeJsonForInlineScript(JSON.stringify(this.fileChanges))};
	// A comparison against the working tree reports no counts by design, so none are requested.
	const countsPossible = ${this.toHash !== UNCOMMITTED && this.toHash !== ''};
	const LETTERS = { A: 'A', C: 'C', D: 'D', M: 'M', R: 'R', T: 'T', U: 'U', '??': 'U' };
	let selectedIndex = -1, requestedIndex = -1, lastDiffWasBinary = false;

	/* ---------- Sidebar resizing ---------- */
	(() => {
		const MIN_WIDTH = 170, MAX_WIDTH = 700;
		const sidebarEl = document.getElementById('sidebar');
		const resizerEl = document.getElementById('sidebarResizer');
		const savedWidth = (vscode.getState() || {}).sidebarWidth;
		if (typeof savedWidth === 'number') sidebarEl.style.width = savedWidth + 'px';
		resizerEl.addEventListener('mousedown', (e) => {
			e.preventDefault();
			resizerEl.classList.add('resizing');
			document.body.style.cursor = 'col-resize';
			document.body.style.userSelect = 'none';
			const bodyLeft = document.getElementById('body').getBoundingClientRect().left;
			function onMouseMove(moveEvent) {
				const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, moveEvent.clientX - bodyLeft));
				sidebarEl.style.width = width + 'px';
			}
			function onMouseUp() {
				window.removeEventListener('mousemove', onMouseMove);
				window.removeEventListener('mouseup', onMouseUp);
				resizerEl.classList.remove('resizing');
				document.body.style.cursor = '';
				document.body.style.userSelect = '';
				vscode.setState(Object.assign({}, vscode.getState(), { sidebarWidth: sidebarEl.getBoundingClientRect().width }));
			}
			window.addEventListener('mousemove', onMouseMove);
			window.addEventListener('mouseup', onMouseUp);
		});
	})();

	/* ---------- Statistics header ---------- */
	const filesChangedTemplate = '${t('compareFilesChanged', '{0}')}';
	function renderStats() {
		if (changes.length === 0) return;
		let totalAdditions = 0, totalDeletions = 0;
		for (const file of changes) {
			if (file.additions !== null) totalAdditions += file.additions;
			if (file.deletions !== null) totalDeletions += file.deletions;
		}
		document.getElementById('filesChangedLabel').innerHTML =
			(changes.length === 1 ? '${t('compareOneFileChanged')}' : filesChangedTemplate.replace('{0}', String(changes.length))) +
			(totalAdditions > 0 ? '${t('compareStatsAdditions', '{0}')}'.replace('{0}', String(totalAdditions)) : '') +
			(totalDeletions > 0 ? '${t('compareStatsDeletions', '{0}')}'.replace('{0}', String(totalDeletions)) : '');
	}
	renderStats();

	/* ---------- Commit card message collapse/expand ---------- */
	// Both commit messages are collapsed by default so they take no vertical space, and expand
	// together (one "expanded" state on the shared container) - clicking either card's header
	// line, or the divider between them, toggles both at once. (In the single-commit
	// presentation there is no divider, only the one card's header line.)
	const commitCardsEl = document.getElementById('commitCards');
	function toggleCommitMessages() { commitCardsEl.classList.toggle('expanded'); }
	const compareDividerEl = document.getElementById('compareDivider');
	if (compareDividerEl !== null) compareDividerEl.addEventListener('click', toggleCommitMessages);
	document.querySelectorAll('.commitCard.hasMessage .firstLine').forEach((firstLine) => {
		firstLine.addEventListener('click', toggleCommitMessages);
	});

	/* ---------- File tree sidebar ---------- */
	// Build a nested tree from the flat list of file paths
	const root = { name: '', folders: {}, files: [] };
	const indexByPath = new Map();
	changes.forEach((file, index) => {
		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		indexByPath.set(filePath, index);
		const path = filePath.split('/');
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
	/* The files whose counts have been computed: before that a null count means "on its way",
	   after it a null count means "binary". */
	const settledCounts = new Set();
	function countsHtml(file, index) {
		if (file.additions !== null && file.deletions !== null) {
			return '<span class="counts"><span class="additions">+' + file.additions + '</span> <span class="deletions">-' + file.deletions + '</span></span>';
		}
		return !settledCounts.has(index) && (file.type === 'M' || file.type === 'R') ? '<span class="counts pending">&hellip;</span>' : '';
	}
	function statusColour(file) {
		return file.type === 'D' ? 'var(--vscode-gitDecoration-deletedResourceForeground, #b31d28)'
			: file.type === 'A' || file.type === 'R' ? 'var(--vscode-gitDecoration-addedResourceForeground, #22863a)'
			: 'var(--vscode-gitDecoration-modifiedResourceForeground, inherit)';
	}
	const TREE_INDENT = 6, TREE_FOLDER_BASE = 6, TREE_ARROW_WIDTH = 14, TREE_FILE_BASE = TREE_FOLDER_BASE + TREE_ARROW_WIDTH;
	// A guide line is drawn for each ancestor level at the x-position of that ancestor folder's
	// arrow (its centre), so sibling rows line up into one continuous vertical line per level.
	function treeGuidesBackground(depth) {
		const layers = [];
		for (let level = 0; level < depth; level++) {
			const x = TREE_FOLDER_BASE + level * TREE_INDENT + TREE_ARROW_WIDTH / 2;
			layers.push('linear-gradient(var(--indent-guide-color), var(--indent-guide-color)) ' + x + 'px 0/1px 100% no-repeat');
		}
		return layers.join(', ');
	}
	function renderTree(folder, container, depth) {
		for (const name of Object.keys(folder.folders).sort()) {
			const sub = folder.folders[name];
			const row = document.createElement('div');
			row.className = 'treeRow';
			row.style.paddingLeft = (TREE_FOLDER_BASE + depth * TREE_INDENT) + 'px';
			row.style.backgroundImage = treeGuidesBackground(depth);
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
			row.style.paddingLeft = (TREE_FILE_BASE + depth * TREE_INDENT) + 'px';
			row.style.backgroundImage = treeGuidesBackground(depth);
			row.dataset.index = entry.index;
			row.innerHTML = '<span class="letter" style="color: ' + statusColour(entry.file) + '">' + (LETTERS[entry.file.type] || '?') + '</span>' +
				'<span class="name" title="' + escapeHtml(entry.file.newFilePath || entry.file.oldFilePath) + '">' + escapeHtml(entry.name) + '</span>' + countsHtml(entry.file, entry.index);
			row.addEventListener('click', () => selectFile(entry.index));
			container.appendChild(row);
		}
	}
	if (changes.length > 0) renderTree(root, sidebar, 0);

	/* ---------- Diff view ---------- */
	const diffArea = document.getElementById('diffArea');
	const diffCache = {}; // index -> { diff: string|null, error: string|null }: revisiting a file is instant
	let currentFilePath = '';
	function selectFile(index) {
		selectedIndex = index;
		lastDiffWasBinary = false;
		hexActive = false;
		hexEls = null;
		hexSections = null;
		hexRows.clear();
		imgActive = false;
		imgEls = null;
		diffArea.className = '';
		currentRowDescriptors = null;
		document.querySelectorAll('.treeRow.file').forEach((row) => row.classList.toggle('selected', parseInt(row.dataset.index) === index));
		const file = changes[index];
		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		currentFileIsImage = isImagePath(filePath);
		currentFilePath = filePath;
		document.getElementById('fileHeader').innerHTML =
			'<span class="letter" style="color: ' + statusColour(file) + '">' + (LETTERS[file.type] || '?') + '</span>' +
			'<span id="filePath">' + escapeHtml(filePath) + '</span>' + countsHtml(file, index) +
			'<button id="openDiffBtn">${t('compareOpenDiffInEditor')}</button>';
		// A binary file has no textual diff for the native editor: its button opens the
		// standalone Binary Compare tab instead.
		document.getElementById('openDiffBtn').addEventListener('click', () => vscode.postMessage({ command: lastDiffWasBinary ? 'viewDiffBinary' : 'viewDiff', index: index }));
		const cached = diffCache[index];
		if (cached !== undefined) {
			showDiff(cached);
		} else {
			diffArea.innerHTML = '<div class="status">${t('compareLoadingDiff')}</div>';
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

	/* ---------- Language detection & syntax highlighting ---------- */
	const LANG_BY_EXT = {
		js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
		ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
		py: 'python', pyw: 'python', pyi: 'python',
		rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
		c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
		cs: 'csharp', php: 'php', rb: 'ruby',
		sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
		json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml',
		xml: 'xml', html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml',
		css: 'css', scss: 'scss', less: 'less',
		md: 'markdown', markdown: 'markdown', sql: 'sql',
		ini: 'ini', cfg: 'ini', toml: 'ini', conf: 'ini',
		diff: 'diff', patch: 'diff', dart: 'dart', scala: 'scala',
		pl: 'perl', pm: 'perl', lua: 'lua', m: 'objectivec', mm: 'objectivec',
		mk: 'makefile', graphql: 'graphql', gql: 'graphql', proto: 'protobuf'
	};
	function detectLanguage(filePath) {
		const name = (filePath.split('/').pop() || '').toLowerCase();
		if (name === 'dockerfile') return 'dockerfile';
		if (name === 'makefile') return 'makefile';
		const dot = name.lastIndexOf('.');
		return dot > 0 ? (LANG_BY_EXT[name.substring(dot + 1)] || null) : null;
	}
	// Highlights one line of code as HTML (already entity-escaped by highlight.js), falling back to
	// plain escaped text if the highlighter script failed to load, or knows no matching language.
	function highlightCode(text, language) {
		if (typeof hljs === 'undefined') return escapeHtml(text);
		try {
			if (language && hljs.getLanguage(language)) return hljs.highlight(text, { language: language, ignoreIllegals: true }).value;
			return hljs.highlightAuto(text).value;
		} catch (e) {
			return escapeHtml(text);
		}
	}
	// Splices <mark> tags into highlight.js's HTML output at plain-text character offsets, without
	// disturbing its own tags/entities: it walks the HTML counting only characters that are actual
	// text content, skipping over "<...>" tags and treating "&...;" entities as one character each.
	// A range can end up straddling one of highlight.js's <span> boundaries (a word-diff range
	// rarely lines up with a token boundary); the browser's HTML parser silently re-nests
	// overlapping tags like that into valid markup once this is assigned via innerHTML.
	function markRanges(html, ranges) {
		if (ranges.length === 0) return html;
		const events = [];
		for (const r of ranges) {
			events.push({ pos: r.start, text: '<mark>' });
			events.push({ pos: r.end, text: '</mark>' });
		}
		let out = '', pos = 0, ei = 0, i = 0;
		while (i < html.length) {
			while (ei < events.length && events[ei].pos === pos) { out += events[ei].text; ei++; }
			const ch = html[i];
			if (ch === '<') {
				const close = html.indexOf('>', i);
				out += html.slice(i, close + 1);
				i = close + 1;
			} else if (ch === '&') {
				const semi = html.indexOf(';', i);
				if (semi === -1) { out += ch; i++; pos++; } else { out += html.slice(i, semi + 1); i = semi + 1; pos++; }
			} else {
				out += ch;
				i++;
				pos++;
			}
		}
		while (ei < events.length) { out += events[ei].text; ei++; }
		return out;
	}

	/* ---------- Word-level (token) diff between the two sides of one modified line ---------- */
	function tokenize(s) { return s.match(/[A-Za-z0-9_]+|[^\\S\\n]+|./gs) || []; }
	// Bounds the O(n*m) LCS table: beyond it (a pathologically long, e.g. minified, line) the whole
	// line is just treated as changed rather than spending seconds diffing it word by word.
	const WORD_DIFF_MAX_PRODUCT = 40000;
	function tokenChangeRanges(oldText, newText) {
		const oldTokens = tokenize(oldText), newTokens = tokenize(newText);
		const n = oldTokens.length, m = newTokens.length;
		if (n * m > WORD_DIFF_MAX_PRODUCT) {
			return { oldRanges: oldText.length ? [{ start: 0, end: oldText.length }] : [], newRanges: newText.length ? [{ start: 0, end: newText.length }] : [] };
		}
		const dp = new Array(n + 1);
		for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] = oldTokens[i] === newTokens[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		const oldChanged = new Array(n).fill(true), newChanged = new Array(m).fill(true);
		let i = 0, j = 0;
		while (i < n && j < m) {
			if (oldTokens[i] === newTokens[j]) {
				oldChanged[i] = false;
				newChanged[j] = false;
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				i++;
			} else {
				j++;
			}
		}
		return { oldRanges: changedTokenRanges(oldTokens, oldChanged), newRanges: changedTokenRanges(newTokens, newChanged) };
	}
	// Converts a per-token changed[] flag array into merged character ranges within the joined text.
	function changedTokenRanges(tokens, changed) {
		const ranges = [];
		let offset = 0, rangeStart = -1;
		for (let i = 0; i < tokens.length; i++) {
			if (changed[i]) {
				if (rangeStart === -1) rangeStart = offset;
			} else if (rangeStart !== -1) {
				ranges.push({ start: rangeStart, end: offset });
				rangeStart = -1;
			}
			offset += tokens[i].length;
		}
		if (rangeStart !== -1) ranges.push({ start: rangeStart, end: offset });
		return ranges;
	}

	// Parse a unified diff into row descriptors (not DOM yet - see layoutTable). Consecutive
	// removed/added lines within one hunk are paired up as "modified" descriptors (with the exact
	// changed words marked via word-level diffing) instead of being kept as separate one-sided
	// lines - the same line-replacement VS Code's own diff editor (and GitHub) work with. Syntax
	// highlighting and word-diff marking happen here, once, since both are independent of whether
	// the row ends up laid out side-by-side or inline (see layoutTable) - a width-only relayout on
	// resize then costs no re-highlighting or re-diffing, just rearranging these HTML strings.
	function parseDiff(diffText, language) {
		const rowsOut = [];
		let oldLine = 0, newLine = 0;
		let pendingDel = [], pendingAdd = [];
		function flushChangeBlock() {
			const pairCount = Math.min(pendingDel.length, pendingAdd.length);
			for (let k = 0; k < pairCount; k++) {
				const wordDiff = tokenChangeRanges(pendingDel[k], pendingAdd[k]);
				rowsOut.push({
					type: 'mod', o: oldLine++, n: newLine++,
					oldHtml: markRanges(highlightCode(pendingDel[k], language), wordDiff.oldRanges),
					newHtml: markRanges(highlightCode(pendingAdd[k], language), wordDiff.newRanges)
				});
			}
			for (let k = pairCount; k < pendingDel.length; k++) rowsOut.push({ type: 'del', o: oldLine++, html: highlightCode(pendingDel[k], language) });
			for (let k = pairCount; k < pendingAdd.length; k++) rowsOut.push({ type: 'add', n: newLine++, html: highlightCode(pendingAdd[k], language) });
			pendingDel = [];
			pendingAdd = [];
		}
		const lines = diffText.split('\\n');
		let binary = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) binary = true;
			const hunk = line.match(/^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@/);
			if (hunk !== null) {
				flushChangeBlock();
				rowsOut.push({ type: 'hunk', html: escapeHtml(line) });
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
				pendingAdd.push(line.substring(1));
			} else if (line.startsWith('-')) {
				pendingDel.push(line.substring(1));
			} else {
				flushChangeBlock();
				rowsOut.push({ type: 'ctx', o: oldLine++, n: newLine++, html: highlightCode(line.substring(1), language) });
			}
		}
		flushChangeBlock();
		return { rows: rowsOut, binary: binary };
	}

	// Below this width the diff pane switches from a side-by-side (old | new) split to a single
	// inline column - the same threshold and behaviour as VS Code's own diff editor
	// (diffEditor.renderSideBySideInlineBreakpoint / useInlineViewWhenSpaceIsLimited defaults).
	const SIDE_BY_SIDE_BREAKPOINT = 900;
	let currentRowDescriptors = null;
	let lastLayoutWasSideBySide = null;

	function lnCellHtml(side, lineNo) {
		return '<td class="' + (side ? 'ln ' + side : 'ln') + '">' + (lineNo === null ? '' : lineNo) + '</td>';
	}
	function codeCellHtml(side, html) {
		return '<td class="' + (side ? 'code ' + side : 'code') + '">' + (html === null ? '' : html) + '</td>';
	}
	function buildRow(trClass, cellsHtml) {
		const tr = document.createElement('tr');
		tr.className = trClass;
		tr.innerHTML = cellsHtml;
		return tr;
	}

	// Arranges already-highlighted row descriptors (from parseDiff) into a <table>, side-by-side
	// or inline depending on the diff pane's current width. A "mod" descriptor becomes one row
	// (old | new) side-by-side, or two stacked rows (a "del" row then an "add" row, each keeping
	// its own word-diff marks) inline - exactly how VS Code's inline diff view renders a change.
	function layoutTable(rows) {
		const sideBySide = diffArea.clientWidth >= SIDE_BY_SIDE_BREAKPOINT;
		lastLayoutWasSideBySide = sideBySide;
		const table = document.createElement('table');
		table.className = 'diff' + (sideBySide ? '' : ' inline');
		table.innerHTML = sideBySide
			? '<colgroup><col style="width: 46px"><col style="width: calc(50% - 46px)"><col style="width: 46px"><col style="width: calc(50% - 46px)"></colgroup>'
			: '<colgroup><col style="width: 46px"><col style="width: 46px"><col></colgroup>';
		const frag = document.createDocumentFragment();
		for (const r of rows) {
			if (r.type === 'hunk') {
				frag.appendChild(buildRow('hunk', '<td colspan="' + (sideBySide ? 4 : 3) + '">' + r.html + '</td>'));
			} else if (r.type === 'ctx') {
				frag.appendChild(sideBySide
					? buildRow('ctx', lnCellHtml('old', r.o) + codeCellHtml(null, r.html) + lnCellHtml('new', r.n) + codeCellHtml(null, r.html))
					: buildRow('ctx', lnCellHtml(null, r.o) + lnCellHtml(null, r.n) + codeCellHtml(null, r.html)));
			} else if (r.type === 'add') {
				frag.appendChild(sideBySide
					? buildRow('add', lnCellHtml(null, null) + codeCellHtml(null, null) + lnCellHtml('new', r.n) + codeCellHtml('new', r.html))
					: buildRow('add', lnCellHtml(null, null) + lnCellHtml('new', r.n) + codeCellHtml('new', r.html)));
			} else if (r.type === 'del') {
				frag.appendChild(sideBySide
					? buildRow('del', lnCellHtml('old', r.o) + codeCellHtml('old', r.html) + lnCellHtml(null, null) + codeCellHtml(null, null))
					: buildRow('del', lnCellHtml('old', r.o) + lnCellHtml(null, null) + codeCellHtml('old', r.html)));
			} else if (sideBySide) {
				frag.appendChild(buildRow('mod', lnCellHtml('old', r.o) + codeCellHtml('old', r.oldHtml) + lnCellHtml('new', r.n) + codeCellHtml('new', r.newHtml)));
			} else {
				frag.appendChild(buildRow('del', lnCellHtml('old', r.o) + lnCellHtml(null, null) + codeCellHtml('old', r.oldHtml)));
				frag.appendChild(buildRow('add', lnCellHtml(null, null) + lnCellHtml('new', r.n) + codeCellHtml('new', r.newHtml)));
			}
		}
		table.appendChild(frag);
		diffArea.innerHTML = '';
		diffArea.appendChild(table);
	}

	function renderDiff(diffText) {
		const parsed = parseDiff(diffText, detectLanguage(currentFilePath));
		if (parsed.binary) {
			currentRowDescriptors = null;
			lastDiffWasBinary = true;
			if (currentFileIsImage) enterImageView(selectedIndex);
			else enterHexView(selectedIndex);
		} else if (parsed.rows.length === 0) {
			currentRowDescriptors = null;
			diffArea.innerHTML = '<div class="status">${t('compareNoTextualChanges')}</div>';
		} else {
			currentRowDescriptors = parsed.rows;
			layoutTable(parsed.rows);
		}
	}

	// A panel resize (or the sidebar/editor being dragged wider or narrower) can cross the
	// side-by-side/inline breakpoint; when it does, the currently displayed diff - already parsed
	// and highlighted - is just relaid out, not re-fetched or recomputed.
	new ResizeObserver(() => {
		if (currentRowDescriptors === null) return;
		if ((diffArea.clientWidth >= SIDE_BY_SIDE_BREAKPOINT) === lastLayoutWasSideBySide) return;
		layoutTable(currentRowDescriptors);
	}).observe(diffArea);

	/* The hex and picture comparison area, shared with the standalone Binary Compare tab. */
	${binaryCompareScript()}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.command === 'fileDiff') {
			diffCache[msg.index] = { diff: msg.diff, error: msg.error };
			if (msg.index === requestedIndex) showDiff(diffCache[msg.index]);
		} else if (msg.command === 'lineCounts') {
			applyCounts(msg.counts);
		} else {
			handleBinaryCompareMessage(msg);
		}
	});

	/* ---------- Deferred line counts ---------- */
	// The file list renders before any blob is read; the +N/-M counts are asked for afterwards and
	// patched in — on a range touching thousands of files they are the slow half of the load.
	function applyCounts(counts) {
		let totalsChanged = false;
		for (const path in counts) {
			const index = indexByPath.get(path);
			if (index === undefined) continue;
			const file = changes[index];
			file.additions = counts[path].additions;
			file.deletions = counts[path].deletions;
			settledCounts.add(index);
			totalsChanged = true;
			const row = document.querySelector('.treeRow.file[data-index="' + index + '"]');
			if (row !== null) {
				const existing = row.querySelector('.counts');
				if (existing !== null) existing.remove();
				const html = countsHtml(file, index);
				if (html !== '') row.insertAdjacentHTML('beforeend', html);
			}
			if (index === selectedIndex) {
				const header = document.querySelector('#fileHeader .counts');
				if (header !== null) header.remove();
				const headerHtml = countsHtml(file, index);
				if (headerHtml !== '') document.getElementById('filePath').insertAdjacentHTML('afterend', headerHtml);
			}
		}
		if (totalsChanged) renderStats();
	}
	if (countsPossible && changes.length > 0) {
		const pending = [];
		for (const file of changes) {
			if (file.type !== 'U' && file.additions === null) pending.push(file.newFilePath !== '' ? file.newFilePath : file.oldFilePath);
		}
		if (pending.length > 0) vscode.postMessage({ command: 'requestCounts', paths: pending });
	}

	if (changes.length > 0) selectFile(0);
</script>
</body>
</html>`;
	}
}

function escapeHtml(str: string) {
	return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

import * as vscode from 'vscode';
import { BinaryComparePost, binaryCompareCss, binaryCompareScript, createHexSession, isImageChange, respondHexInfo, respondImageData, respondHexRows, wireHexSession } from './binaryCompare';
import { DataSource } from './dataSource';
import { t } from './i18n';
import { GitFileChange } from './types';
import { UNCOMMITTED, abbrevCommit, getNonce } from './utils';
import { Disposable, toDisposable } from './utils/disposable';

/**
 * A standalone tab showing the full binary comparison of one file between two revisions:
 * the hex view with its difference navigation, or the picture view with its pixel difference.
 *
 * The native diff editor cannot show binary files (both panes would be empty), so the Commit
 * Comparison View's "open diff" button sends binary files here instead. The page embeds exactly
 * the same client script and talks the same messages as the embedded comparison area.
 */
export class BinaryCompareView extends Disposable {
	private static readonly openViews = new Map<string, BinaryCompareView>();

	private readonly panel: vscode.WebviewPanel;
	private readonly session;

	/**
	 * Opens a Binary Compare View for one file, reusing (and revealing) the existing tab when
	 * the same file is compared between the same revisions again.
	 */
	public static open(dataSource: DataSource, repo: string, fromHash: string, toHash: string, file: GitFileChange) {
		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		const key = repo + '\n' + fromHash + '\n' + toHash + '\n' + filePath;
		const existing = BinaryCompareView.openViews.get(key);
		if (existing !== undefined) {
			existing.panel.reveal();
			return;
		}
		new BinaryCompareView(dataSource, repo, fromHash, toHash, file, key);
	}

	private constructor(dataSource: DataSource, repo: string, private readonly fromHash: string, private readonly toHash: string, file: GitFileChange, key: string) {
		super();

		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		const toLabel = toHash === UNCOMMITTED || toHash === '' ? t('comparePresentLabel') : abbrevCommit(toHash);
		this.panel = vscode.window.createWebviewPanel('git-graph-rs.binaryCompare', t('binaryCompareTitle', filePath, abbrevCommit(fromHash), toLabel), vscode.ViewColumn.Active, {
			enableScripts: true
		});

		this.session = createHexSession(dataSource, repo, fromHash, toHash, file);
		wireHexSession(this.session, 0, this.post());

		this.registerDisposables(
			this.panel.onDidDispose(() => {
				BinaryCompareView.openViews.delete(key);
				this.dispose();
			}),
			this.panel.webview.onDidReceiveMessage(async (msg: any) => {
				if (this.isDisposed()) return;
				if (msg.command === 'getHexInfo') {
					await respondHexInfo(this.session, 0, msg.bytesPerRow, this.post());
				} else if (msg.command === 'getHexRows') {
					await respondHexRows(this.session, 0, msg.start, msg.count, this.post());
				} else if (msg.command === 'getImageData') {
					await respondImageData(this.session, 0, file, this.post());
				}
			}),
			toDisposable(() => {
				BinaryCompareView.openViews.delete(key);
				this.session.dispose();
				this.panel.dispose();
			})
		);

		this.panel.webview.html = this.getHtml(filePath, file);
	}

	private post(): BinaryComparePost {
		return (message) => {
			if (!this.isDisposed()) void this.panel.webview.postMessage(message);
		};
	}

	/**
	 * The page: a slim header naming the file and the two revisions, and the shared comparison
	 * area filling the rest. The script part is the same module the Commit Comparison View
	 * embeds; this page simply always shows the binary view and routes every message to it.
	 */
	private getHtml(filePath: string, file: GitFileChange) {
		const nonce = getNonce();
		const statusColour = file.type === 'D' ? 'var(--vscode-gitDecoration-deletedResourceForeground, #b31d28)'
			: file.type === 'A' || file.type === 'R' ? 'var(--vscode-gitDecoration-addedResourceForeground, #22863a)'
			: 'var(--vscode-gitDecoration-modifiedResourceForeground, inherit)';
		const letter = file.type === 'D' ? 'D' : file.type === 'A' || file.type === 'R' ? 'A' : file.type === 'U' ? 'U' : 'M';
		const toLabel = this.toHash === UNCOMMITTED || this.toHash === '' ? t('comparePresentLabel') : abbrevCommit(this.toHash);
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<style>
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
	#header { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); flex-shrink: 0; }
	#header .letter { font-weight: 600; color: ${statusColour}; width: 13px; text-align: center; flex-shrink: 0; }
	#header .path { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	#header .refs { font-size: 11px; opacity: 0.75; margin-left: auto; flex-shrink: 0; font-family: var(--vscode-editor-font-family, monospace); }
	#diffArea { flex: 1; min-height: 0; }
	.status { padding: 16px; opacity: 0.8; }
	${binaryCompareCss()}
</style>
</head>
<body>
<div id="header">
	<span class="letter">${letter}</span>
	<span class="path" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
	<span class="refs">${escapeHtml(abbrevCommit(this.fromHash))} &harr; ${escapeHtml(toLabel)}</span>
</div>
<div id="diffArea"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const diffArea = document.getElementById('diffArea');
${binaryCompareScript()}
currentFileIsImage = ${isImageChange(file) ? 'true' : 'false'};
if (currentFileIsImage) enterImageView(0);
else enterHexView(0);
window.addEventListener('message', (event) => { handleBinaryCompareMessage(event.data); });
window.addEventListener('resize', function () { onBinaryCompareResize(); });
</script>
</body>
</html>`;
	}
}

function escapeHtml(str: string) {
	return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

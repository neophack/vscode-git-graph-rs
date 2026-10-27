import * as path from 'path';
import * as vscode from 'vscode';
import { createHexSession, isImageChange, respondCopyToClipboard, respondHexInfo, respondImageData, respondHexRows, wireHexSession } from './binaryCompare';
import type { GitStreamSpawner } from './hexDiff';
import { isZhCn, t } from '../../platform/i18n';
import { BinaryCompareInitResponse, BinaryCompareRequest, BinaryCompareResponse } from '../../../shared/protocol/binaryCompare';
import { GitFileChange } from '../../../shared/model/git';
import { UNCOMMITTED, abbrevCommit } from '../../platform/git';
import { getNonce } from '../../platform/format';
import { Disposable, toDisposable } from '../../../shared/util/disposable';

/**
 * A standalone tab showing the full binary comparison of one file between two revisions: the hex
 * view with its difference navigation, or the picture view with its pixel difference.
 *
 * The native diff editor cannot show binary files (both panes would be empty), so the Commit
 * Comparison View's "open diff" button sends binary files here instead. The host is the controller
 * (REFACTOR-PLAN task 6.1): it owns the panel lifecycle and the typed message handling, serves an
 * external-script HTML shell, and tells the frontend which of its two views to enter through the
 * `ready` / `init` boot pair; the frontend itself lives in src/webview/binaryCompare (bundled into
 * media/binaryCompare.min.js) and is exactly the same code the Commit Comparison View embeds.
 */
export class BinaryCompareView extends Disposable {
	private static readonly openViews = new Map<string, BinaryCompareView>();

	private readonly panel: vscode.WebviewPanel;
	private readonly session;
	/** Whether the frontend has booted and asked for its data (it reloads with the page). */
	private webviewReady = false;

	/**
	 * Opens a Binary Compare View for one file, reusing (and revealing) the existing tab when the
	 * same file is compared between the same revisions again.
	 */
	public static open(extensionPath: string, spawner: GitStreamSpawner, repo: string, fromHash: string, toHash: string, file: GitFileChange) {
		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		const key = repo + '\n' + fromHash + '\n' + toHash + '\n' + filePath;
		const existing = BinaryCompareView.openViews.get(key);
		if (existing !== undefined) {
			existing.panel.reveal();
			return;
		}
		new BinaryCompareView(extensionPath, spawner, repo, fromHash, toHash, file, key);
	}

	private constructor(private readonly extensionPath: string, spawner: GitStreamSpawner, repo: string, private readonly fromHash: string, private readonly toHash: string, file: GitFileChange, key: string) {
		super();

		const filePath = file.newFilePath !== '' ? file.newFilePath : file.oldFilePath;
		const toLabel = toHash === UNCOMMITTED || toHash === '' ? t('comparePresentLabel') : abbrevCommit(toHash);
		this.panel = vscode.window.createWebviewPanel('git-graph-rs.binaryCompare', t('binaryCompareTitle', filePath, abbrevCommit(fromHash), toLabel), vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))]
		});

		this.session = createHexSession(spawner, repo, fromHash, toHash, file);
		wireHexSession(this.session, 0, this.post());

		this.registerDisposables(
			this.panel.onDidDispose(() => {
				BinaryCompareView.openViews.delete(key);
				this.dispose();
			}),
			this.panel.webview.onDidReceiveMessage(async (msg: BinaryCompareRequest) => {
				if (this.isDisposed()) return;
				if (msg.command === 'ready') {
					this.webviewReady = true;
					this.deliverInit(isImageChange(file));
				} else if (msg.command === 'getHexInfo') {
					await respondHexInfo(this.session, 0, msg.bytesPerRow, this.post());
				} else if (msg.command === 'getHexRows') {
					await respondHexRows(this.session, 0, msg.start, msg.count, this.post());
				} else if (msg.command === 'getImageData') {
					await respondImageData(this.session, 0, file, this.post());
				} else if (msg.command === 'copyToClipboard') {
					await respondCopyToClipboard(this.post(), msg.type, msg.data);
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

	private post(): (message: BinaryCompareResponse) => void {
		return (message) => {
			if (!this.isDisposed()) void this.panel.webview.postMessage(message);
		};
	}

	/** The boot data reaches the frontend when its script has booted and asked for it. */
	private deliverInit(isImage: boolean) {
		if (!this.webviewReady || this.isDisposed()) return;
		const init: BinaryCompareInitResponse = { command: 'init', isImage: isImage, language: isZhCn() ? 'zh-cn' : 'en' };
		void this.panel.webview.postMessage(init);
	}

	/**
	 * The page shell: a slim header naming the file and the two revisions, and the comparison area
	 * filling the rest. The stylesheet and the page's bundle are external files under a nonce - the
	 * CSP allows no inline scripts or styles at all (task 6.1).
	 */
	private getHtml(filePath: string, file: GitFileChange) {
		const nonce = getNonce();
		const statusColour = file.type === 'D' ? 'var(--vscode-gitDecoration-deletedResourceForeground, #b31d28)'
			: file.type === 'A' || file.type === 'R' ? 'var(--vscode-gitDecoration-addedResourceForeground, #22863a)'
				: 'var(--vscode-gitDecoration-modifiedResourceForeground, inherit)';
		const letter = file.type === 'D' ? 'D' : file.type === 'A' || file.type === 'R' ? 'A' : file.type === 'U' ? 'U' : 'M';
		const toLabel = this.toHash === UNCOMMITTED || this.toHash === '' ? t('comparePresentLabel') : abbrevCommit(this.toHash);
		const mediaUri = (name: string) => this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionPath, 'media', name)));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" type="text/css" href="${mediaUri('binaryCompare.min.css')}">
</head>
<body class="binaryComparePage">
<div id="header">
	<span class="letter" style="color: ${statusColour}">${letter}</span>
	<span class="path" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
	<span class="refs">${escapeHtml(abbrevCommit(this.fromHash))} &harr; ${escapeHtml(toLabel)}</span>
</div>
<div id="diffArea"></div>
<script nonce="${nonce}" src="${mediaUri('binaryCompare.min.js')}"></script>
</body>
</html>`;
	}
}

function escapeHtml(str: string) {
	return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

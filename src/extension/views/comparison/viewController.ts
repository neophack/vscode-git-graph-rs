import * as path from 'path';
import * as vscode from 'vscode';
import { createHexSession, respondCopyToClipboard, respondHexInfo, respondImageData, respondHexRows, wireHexSession } from '../binaryCompare/binaryCompare';
import { BinaryCompareView } from '../binaryCompare/viewController';
import type { GitBackend } from '../../git/read/gitReader';
import { checkUnsafeGitArgs, isSafeRefName, isValidCommitHash, Localize } from '../../git/write/argSafety';
import type { GitStreamSpawner } from '../binaryCompare/hexDiff';
import { HexDiffSession } from '../binaryCompare/hexDiff';
import { isZhCn, t } from '../../platform/i18n';
import type { ConfigProvider } from '../../platform/config';
import type { TextMessageKey } from '../../../shared/i18n';
import { ComparisonInitResponse, ComparisonRequest, ComparisonResponse } from '../../../shared/protocol/comparison';
import { GitFileChange } from '../../../shared/model/git';
import { UNCOMMITTED, abbrevCommit } from '../../platform/git';
import { getNonce } from '../../platform/format';
import { viewDiff } from '../../platform/actions';
import { Disposable, toDisposable } from '../../../shared/util/disposable';

/**
 * A webview tab that displays the changes between two commits in a GitHub-style layout: a header
 * with the overall statistics, a file tree sidebar of the changed files, and the split diff view of
 * the selected file. The host is the controller: it owns the panel
 * lifecycle and the typed message handling, serves an external-script HTML shell, and delivers the
 * file changes and commit summaries through the `ready` / `init` boot pair; the frontend itself
 * lives in src/webview/comparison (bundled into media/comparison.min.js).
 */
/** The adapter calls' localiser: the i18n table's keys widened to the adapter's plain strings. */
const localize: Localize = (key, ...params) => t(key as TextMessageKey, ...params);

export class CommitComparisonView extends Disposable {
	private static readonly openViews = new Map<string, CommitComparisonView>();

	private readonly panel: vscode.WebviewPanel;
	private readonly read: GitBackend;
	private readonly spawner: GitStreamSpawner;
	private fileChanges: ReadonlyArray<GitFileChange> = [];
	/** Hex comparison sessions by file index; only the most recent few are kept (they hold chunk caches). */
	private readonly hexSessions = new Map<number, HexDiffSession>();
	/** Whether the frontend has booted and asked for its data (it reloads with the page). */
	private webviewReady = false;
	/** The boot data, delivered as soon as both the frontend is ready and the comparison resolved. */
	private initMessage: ComparisonInitResponse | null = null;

	/**
	 * Opens a Commit Comparison View for the given commit range, reusing (and revealing) the
	 * existing tab when the same range is compared again. When `singleCommit` is set, the header
	 * presents the changes as those of `toHash` alone (opened via the "Open Changes" action)
	 * instead of showing both ends of the comparison; the tab is titled "Commit <hash>".
	 */
	public static open(extensionPath: string, read: GitBackend, spawner: GitStreamSpawner, config: ConfigProvider, repo: string, fromHash: string, toHash: string, singleCommit: boolean) {
		const key = repo + '\n' + fromHash + '\n' + toHash + '\n' + (singleCommit ? '1' : '0');
		const existing = CommitComparisonView.openViews.get(key);
		if (existing !== undefined) {
			existing.panel.reveal();
			return;
		}
		new CommitComparisonView(extensionPath, read, spawner, config, repo, fromHash, toHash, singleCommit, key);
	}

	private constructor(private readonly extensionPath: string, read: GitBackend, spawner: GitStreamSpawner, private readonly config: ConfigProvider, private readonly repo: string, private readonly fromHash: string, private readonly toHash: string, private readonly singleCommit: boolean, key: string) {
		super();
		this.read = read;
		this.spawner = spawner;

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
			this.panel.webview.onDidReceiveMessage(async (msg: ComparisonRequest) => {
				if (this.isDisposed()) return;
				if (msg.command === 'ready') {
					this.webviewReady = true;
					this.deliverInit();
				} else if (msg.command === 'getFileDiff') {
					const file = this.fileChanges[msg.index];
					if (file === undefined) {
						// A stale request for an index the current file list no longer has (the
						// range failed to load, or changed since the page asked): answer rather
						// than leave the webview waiting on a diff that never comes.
						this.hexPost()({ command: 'fileDiff', index: msg.index, diff: null, error: 'The file is no longer part of the comparison.' });
						return;
					}
					let diff: string | null, error: string | null = null;
					try {
						diff = await this.getCommitFileDiff(this.fromHash, this.toHash, file.oldFilePath, file.newFilePath);
					} catch (errorMessage) {
						diff = null;
						error = errorMessage instanceof Error ? errorMessage.message : String(errorMessage);
					}
					// Posted through the shared poster: the tab can be closed while the diff is loading
					this.hexPost()({ command: 'fileDiff', index: msg.index, diff: diff, error: error });
				} else if (msg.command === 'viewDiff') {
					const file = this.fileChanges[msg.index];
					if (file !== undefined) {
						await viewDiff(this.repo, this.fromHash, this.toHash, file.oldFilePath, file.newFilePath, file.type);
					}
				} else if (msg.command === 'viewDiffBinary') {
					// Binary files have no textual diff to open in the native editor: the
					// standalone Binary Compare tab shows the full hex / picture comparison.
					const file = this.fileChanges[msg.index];
					if (file !== undefined) {
						BinaryCompareView.open(this.extensionPath, this.spawner, this.repo, this.fromHash, this.toHash, file);
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
					const result = await this.getCommitFileCounts(this.fromHash, this.toHash, msg.paths);
					if (!this.isDisposed()) this.panel.webview.postMessage({ command: 'lineCounts', counts: result.counts });
				} else if (msg.command === 'getImageData') {
					const session = this.hexSession(msg.index);
					const file = this.fileChanges[msg.index];
					if (session === null || file === undefined) return;
					await respondImageData(session, msg.index, file, this.hexPost());
				} else if (msg.command === 'copyToClipboard') {
					await respondCopyToClipboard(this.hexPost(), msg.type, msg.data);
				}
			}),
			toDisposable(() => {
				CommitComparisonView.openViews.delete(key);
				for (const session of this.hexSessions.values()) session.dispose();
				this.hexSessions.clear();
				this.panel.dispose();
			})
		);

		this.panel.webview.html = this.getHtml();
		// Load the file changes, the summaries of the commits shown in the header, and the number
		// of commits between them in parallel, so the view is ready as soon as possible.
		Promise.all([
			this.getCommitComparison(fromHash, toHash),
			this.read.getCommitSummaries(repo, (this.singleCommit ? [toHash] : [fromHash, toHash]).filter((hash) => hash !== '' && hash !== UNCOMMITTED)).then(
				(summaries) => summaries as { [hash: string]: { hash: string, author: string, email: string, date: number, message: string } },
				() => null
			),
			this.getCommitsBetweenCount()
		]).then((results) => {
			if (this.isDisposed()) return; // the tab was closed while the Git commands were running
			const comparison = results[0], summaries = results[1], commitsBetween = results[2];
			this.fileChanges = comparison.error !== null ? [] : comparison.fileChanges;
			this.initMessage = {
				command: 'init',
				changes: this.fileChanges,
				fromHash: this.fromHash,
				toHash: this.toHash,
				countsPossible: this.toHash !== UNCOMMITTED && this.toHash !== '',
				singleCommit: this.singleCommit,
				summaries: summaries === null ? {} : summaries,
				commitsBetween: commitsBetween,
				error: comparison.error !== null ? comparison.error : null,
				language: isZhCn() ? 'zh-cn' : 'en',
				mobileAdaptation: this.config.current.mobileAdaptation
			};
			this.deliverInit();
		}, (error: unknown) => {
			if (this.isDisposed()) return;
			this.initMessage = {
				command: 'init',
				changes: [],
				fromHash: this.fromHash,
				toHash: this.toHash,
				countsPossible: false,
				singleCommit: this.singleCommit,
				summaries: {},
				commitsBetween: null,
				error: error instanceof Error ? error.message : String(error),
				language: isZhCn() ? 'zh-cn' : 'en',
				mobileAdaptation: this.config.current.mobileAdaptation
			};
			this.deliverInit();
		});
	}

	/** The boot data reaches the frontend when both sides are ready: the page's script asks for it
	 *  with `ready`, and the comparison may still be loading when it does. */
	private deliverInit() {
		if (this.webviewReady && this.initMessage !== null && !this.isDisposed()) {
			void this.panel.webview.postMessage(this.initMessage);
		}
	}

	/**
	 * The number of commits strictly between `fromHash` and `toHash` (i.e. reachable from `toHash`
	 * but not from `fromHash`), shown in the header between the two commit cards. NULL when it
	 * can't be determined (comparing from the working tree, or the count failed).
	 */
	private getCommitsBetweenCount(): Promise<number | null> {
		if (this.singleCommit || this.fromHash === '' || this.fromHash === UNCOMMITTED) return Promise.resolve(null);
		const tip = this.toHash === '' || this.toHash === UNCOMMITTED ? 'HEAD' : this.toHash;
		return this.getCommitsBefore([tip], this.fromHash);
	}

	/**
	 * The file list of the comparison: the hashes go
	 * through the argument-injection gate, the backend's commit comparison answers the list, and
	 * a failed read maps to the empty list plus the error the view shows in its place.
	 */
	private getCommitComparison(fromHash: string, toHash: string): Promise<{ fileChanges: GitFileChange[]; error: string | null }> {
		const unsafe = checkUnsafeGitArgs(localize,
			['fromHash', fromHash === UNCOMMITTED ? null : fromHash, 'hash'],
			['toHash', toHash === UNCOMMITTED ? null : toHash, 'hash']);
		if (unsafe !== null) return Promise.resolve({ fileChanges: [], error: unsafe });
		return this.read.compareCommits(this.repo, fromHash, toHash === UNCOMMITTED ? '' : toHash).then(
			(fileChanges) => ({ fileChanges: [...fileChanges] as unknown as GitFileChange[], error: null }),
			(errorMessage: unknown) => ({ fileChanges: [], error: errorMessage instanceof Error ? errorMessage.message : String(errorMessage) })
		);
	}

	/**
	 * The unified diff of one file: the diff of a single
	 * file in a single commit is answered directly by the backend (the engine resolves it without
	 * spawning a diff), everything else runs the two-revision comparison.
	 */
	private getCommitFileDiff(fromHash: string, toHash: string, oldFilePath: string, newFilePath: string): Promise<string> {
		if (toHash === UNCOMMITTED) toHash = '';
		if (oldFilePath === newFilePath && toHash !== '' && isValidCommitHash(toHash) && fromHash === toHash + '^') {
			return this.read.getCommitFileDiff(this.repo, toHash, newFilePath);
		}
		return this.read.compareFileDiff(this.repo, fromHash, toHash, oldFilePath, newFilePath);
	}

	/**
	 * The progressive +/- line counts: the same
	 * argument gate, then the backend's line counts with a failed read mapping to empty counts.
	 */
	private getCommitFileCounts(from: string | null, to: string, paths: ReadonlyArray<string>): Promise<{ counts: { [path: string]: { additions: number, deletions: number } }; error: string | null }> {
		const unsafe = checkUnsafeGitArgs(localize,
			['from', from, 'hash'],
			['to', to === UNCOMMITTED ? null : to, 'hash']);
		if (unsafe !== null) return Promise.resolve({ counts: {}, error: unsafe });
		return this.read.getLineCounts(this.repo, from, to, paths).then(
			(counts) => ({ counts: counts as { [path: string]: { additions: number, deletions: number } }, error: null }),
			(errorMessage: unknown) => ({ counts: {}, error: errorMessage instanceof Error ? errorMessage.message : String(errorMessage) })
		);
	}

	/** The commits-before count: unsafe branch names are dropped, a failed read answers NULL. */
	private getCommitsBefore(branches: ReadonlyArray<string>, hash: string): Promise<number | null> {
		const refs = branches.filter((branch) => isSafeRefName(branch) || isValidCommitHash(branch) || branch.startsWith('--glob='));
		return this.read.countCommitsBefore(this.repo, refs, hash, false, false).catch(() => null);
	}

	/** A poster for the shared binary-compare responders that checks the panel's lifetime.
	 *  Accepts every response of this view's protocol, which includes all the binary-compare
	 *  responses the shared responders post. */
	private hexPost(): (message: ComparisonResponse) => void {
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
		const session = createHexSession(this.spawner, this.repo, this.fromHash, this.toHash, file);
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
	 * The page shell: the static skeleton the frontend renders into, with the stylesheet and the
	 * two scripts (the vendored highlighter and the page's own bundle) loaded as external files
	 * under a nonce - the CSP allows no inline scripts or styles at all. The loading
	 * status stands until the frontend's `ready` handshake and the comparison data produce the
	 * `init` message.
	 *
	 * The phone layout's furniture is in the skeleton too: the "Files" bar that opens the file
	 * tree's full-screen sheet, and the sheet's title bar with its close button (both hidden by
	 * the stylesheet outside the phone layout, so the wide and tablet layouts render exactly as
	 * before).
	 */
	private getHtml() {
		const nonce = getNonce();
		const mediaUri = (file: string) => this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionPath, 'media', file)));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; img-src data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" type="text/css" href="${mediaUri('comparison.min.css')}">
</head>
<body>
<div id="header">
	<div id="commitCards"></div>
</div>
<div id="body">
	<div id="sidebar">
		<div id="sidebarHead">
			<h2 id="filesChangedLabel">${t('compareFilesChangedLabel')}</h2>
			<button type="button" id="closeFilesSheetBtn" title="${t('dialogClose')}" aria-label="${t('dialogClose')}"><svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" d="M3.8,2.4L2.4,3.8L5.7,7L2.4,10.2L3.8,11.6L7,8.3L10.2,11.6L11.6,10.2L8.3,7L11.6,3.8L10.2,2.4L7,5.7L3.8,2.4z"/></svg></button>
		</div>
	</div>
	<div id="sidebarResizer"></div>
	<div id="main">
		<div id="mobileFilesBar"><button type="button" id="mobileFilesBtn"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M2 3.5A.75.75 0 0 1 2.75 2.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.5Zm0 4.5a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Zm.75 3.75a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z"/></svg>${t('compareFilesButton')}</button></div>
		<div id="fileHeader"></div>
		<div id="diffArea"><div class="status">${t('compareLoadingChanges')}</div></div>
	</div>
</div>
<script nonce="${nonce}" src="${mediaUri('vendor/highlight.min.js')}"></script>
<script nonce="${nonce}" src="${mediaUri('comparison.min.js')}"></script>
</body>
</html>`;
	}
}

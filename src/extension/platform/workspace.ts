/**
 * Platform workspace adapter: the single vscode seam behind the workspace surfaces the extension
 * reads — file-system watchers, the workspace folder list and its change event. The events are
 * translated from `vscode.Uri` to the extension's normalised `/`-separated paths, so the
 * consumers (the repository layer above all) stay vscode-free and work in the extension's own
 * path spelling.
 */

import * as vscode from 'vscode';
import { getPathFromUri } from './paths';

/** An event-subscription handle (the shape of every subscription this module returns). */
export interface WatchSubscription {
	dispose(): void;
}

/**
 * A file-event watcher over one glob pattern (the `vscode.FileSystemWatcher` surface with the
 * `vscode.Uri` events translated to normalised paths). Structural, so tests can fake it.
 */
export interface PatternWatcher {
	onDidCreate(listener: (path: string) => void): WatchSubscription;
	onDidChange(listener: (path: string) => void): WatchSubscription;
	onDidDelete(listener: (path: string) => void): WatchSubscription;
	dispose(): void;
}

/**
 * Watch the files matching a glob pattern for events.
 * @param glob The glob pattern to watch.
 * @param base An optional base path the pattern is resolved against (a `RelativePattern` is
 * built for it — the form out-of-workspace absolute roots need on current VS Code).
 * @returns The watcher.
 */
export function watchFiles(glob: string, base?: string): PatternWatcher {
	const watcher = base !== undefined
		? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, glob))
		: vscode.workspace.createFileSystemWatcher(glob);
	const translate = (listener: (path: string) => void) => (uri: vscode.Uri) => listener(getPathFromUri(uri));
	return {
		onDidCreate: (listener) => watcher.onDidCreate(translate(listener)),
		onDidChange: (listener) => watcher.onDidChange(translate(listener)),
		onDidDelete: (listener) => watcher.onDidDelete(translate(listener)),
		dispose: () => watcher.dispose()
	};
}

/** A workspace folder: its normalised path and its index in the workspace's folder list. */
export interface WorkspaceFolderInfo {
	readonly path: string;
	readonly index: number;
}

/**
 * The current workspace folders as normalised paths with their indices.
 * @returns The folders, or UNDEFINED when the workspace has no folders (the same answer
 * `vscode.workspace.workspaceFolders` gives).
 */
export function workspaceFolders(): WorkspaceFolderInfo[] | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (typeof folders === 'undefined') return undefined;
	return folders.map((folder) => ({ path: getPathFromUri(folder.uri), index: folder.index }));
}

/** A workspace-folder change: the added and removed folders, as normalised paths. */
export interface WorkspaceFoldersChangeEvent {
	readonly added: string[];
	readonly removed: string[];
}

/**
 * Subscribe to workspace-folder changes.
 * @param listener Called with the added and removed folders (normalised paths) on every change.
 * @returns A subscription handle.
 */
export function onDidChangeWorkspaceFolders(listener: (event: WorkspaceFoldersChangeEvent) => unknown): WatchSubscription {
	return vscode.workspace.onDidChangeWorkspaceFolders((event) => listener({
		added: event.added.map((folder) => getPathFromUri(folder.uri)),
		removed: event.removed.map((folder) => getPathFromUri(folder.uri))
	}));
}

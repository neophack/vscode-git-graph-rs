import * as vscode from 'vscode';
import type { TerminalsLike } from './terminal';

/**
 * The only sanctioned form of post-1.38 VS Code API access: each wrapper
 * declares the shape of the newer API locally, feature-detects it at runtime and answers with
 * `null` when it is unavailable - and every caller must handle the null branch. `(vscode.x as
 * any)` probes are forbidden; this module is the surface the modules that used to probe -
 * src/extension/automation/hostBridge.ts and src/extension/automation/suiteRunner.ts - go
 * through instead.
 */

/**
 * The shape of `vscode.window.tabGroups` the extension actually uses, as far as reading open
 * tabs goes (VS Code 1.67+). `close` is optional: it exists on the real API, but a test stub
 * may only offer the read side, and callers feature-detect it separately.
 */
export interface TabGroupsLike {
	readonly all: ReadonlyArray<TabGroupLike>;
	close?(tab: unknown, preserveFocus?: boolean): Thenable<boolean>;
	/**
	 * The tab-change subscription (the orphaned-tab watcher's only event source). Optional like
	 * `close`: the read side alone is enough for some consumers, and callers feature-detect it
	 * separately.
	 */
	onDidChangeTabs?(listener: () => void): vscode.Disposable;
}

/** One tab group: its tabs (and, for callers that need it, the column and active tab it holds). */
export interface TabGroupLike {
	readonly viewColumn?: unknown;
	readonly isActive?: boolean;
	readonly activeTab?: unknown;
	readonly tabs: ReadonlyArray<unknown>;
}

function isTabGroupLike(candidate: unknown): candidate is TabGroupLike {
	if (candidate === null || typeof candidate !== 'object') return false;
	return Array.isArray((candidate as { tabs?: unknown }).tabs);
}

function isTabGroupsLike(candidate: unknown): candidate is TabGroupsLike {
	if (candidate === null || typeof candidate !== 'object') return false;
	const all = (candidate as { all?: unknown }).all;
	if (!Array.isArray(all)) return false;
	return all.every((group) => isTabGroupLike(group));
}

/**
 * The Tab Groups API (VS Code 1.67+ only); NULL on older editors and test stubs. Every caller
 * has a fallback for the null branch.
 */
export function tabGroups(): TabGroupsLike | null {
	const candidate = (vscode.window as { readonly tabGroups?: unknown }).tabGroups;
	return isTabGroupsLike(candidate) ? candidate : null;
}

/** The slice of `vscode.workspace`'s Workspace Trust surface the extension reads (VS Code 1.56+). */
export interface WorkspaceTrustLike {
	readonly isTrusted: boolean;
	/** Fires whenever the workspace's trust level changes. */
	onDidChangeWorkspaceTrust(listener: () => void, thisArg?: unknown): { dispose(): void };
}

/**
 * The terminal-creation surface of `vscode.window`, for the callers that drive the integrated
 * terminal through the platform Terminals adapter (so vscode-free modules can build the adapter
 * without importing vscode). Read at call time, so merely importing this module never touches
 * the vscode module surface beyond the import itself.
 */
export function terminalsWindow(): TerminalsLike {
	return vscode.window;
}

/**
 * The shell of the default integrated-terminal profile, as Visual Studio Code reports it
 * (`vscode.env.shell`, VS Code 1.62+); '' when the host does not report one, in which case the
 * caller falls back to its platform default.
 */
export function defaultShellPath(): string {
	// The shape is probed through a structural cast (the field is newer than the oldest supported
	// editor), matching the feature-detection pattern of the rest of this module.
	return String((<{ shell?: string }>(<unknown>vscode.env)).shell ?? '');
}

/**
 * The Workspace Trust API (VS Code 1.56+ only); NULL on older editors and test stubs — the
 * caller then treats the workspace as trusted, which is those editors' own behaviour.
 */
export function workspaceTrust(): WorkspaceTrustLike | null {
	const workspace = vscode.workspace as { readonly isTrusted?: unknown, onDidChangeWorkspaceTrust?: unknown } | undefined;
	if (workspace === null || typeof workspace !== 'object') return null;
	if (typeof workspace.isTrusted !== 'boolean' || typeof workspace.onDidChangeWorkspaceTrust !== 'function') return null;
	return workspace as WorkspaceTrustLike;
}

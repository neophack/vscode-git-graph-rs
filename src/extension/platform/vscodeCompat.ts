import * as vscode from 'vscode';

/**
 * The only sanctioned form of post-1.38 VS Code API access (REFACTOR-PLAN 3.7.3): each wrapper
 * declares the shape of the newer API locally, feature-detects it at runtime and answers with
 * `null` when it is unavailable - and every caller must handle the null branch. `(vscode.x as
 * any)` probes are forbidden; this module replaces the ones that existed in
 * src/automation/hostBridge.ts and src/automation/suiteRunner.ts.
 */

/**
 * The shape of `vscode.window.tabGroups` the extension actually uses, as far as reading open
 * tabs goes (VS Code 1.67+). `close` is optional: it exists on the real API, but a test stub
 * may only offer the read side, and callers feature-detect it separately.
 */
export interface TabGroupsLike {
	readonly all: ReadonlyArray<TabGroupLike>;
	close?(tab: unknown, preserveFocus?: boolean): Thenable<boolean>;
}

/** One tab group: its tabs (and, for callers that need it, the column it lives in). */
export interface TabGroupLike {
	readonly viewColumn?: unknown;
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
 * The Workspace Trust API (VS Code 1.56+ only); NULL on older editors and test stubs — the
 * caller then treats the workspace as trusted, which is those editors' own behaviour.
 */
export function workspaceTrust(): WorkspaceTrustLike | null {
	const workspace = vscode.workspace as { readonly isTrusted?: unknown, onDidChangeWorkspaceTrust?: unknown } | undefined;
	if (workspace === null || typeof workspace !== 'object') return null;
	if (typeof workspace.isTrusted !== 'boolean' || typeof workspace.onDidChangeWorkspaceTrust !== 'function') return null;
	return workspace as WorkspaceTrustLike;
}

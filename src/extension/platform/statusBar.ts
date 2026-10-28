/**
 * Platform status-bar adapter: the single vscode seam behind the extension's status bar item —
 * the consumers (src/extension/statusBar.ts) drive the returned item structurally and stay
 * vscode-free.
 */

import * as vscode from 'vscode';

/**
 * Create the extension's status bar item: left-aligned, priority 1.
 * @returns The status bar item.
 */
export function createStatusBarItem(): vscode.StatusBarItem {
	return vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
}

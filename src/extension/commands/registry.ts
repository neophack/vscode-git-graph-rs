/**
 * The declarative registry of the extension's commands: the single
 * list of command identifiers the extension can register, in registration order, together with
 * the non-palette menu surfaces of `package.json#contributes.menus` each command backs.
 *
 * `CommandId` is derived from this list and `CommandManager.registerCommand` only accepts a
 * `CommandId`, so a command that is not declared here cannot be registered. The registry test
 * compares the list bidirectionally against `package.json#contributes` (every contributed
 * command is registered, every registered command is contributed, and the menu surfaces match
 * exactly), replacing the command half of `tests/contract.test.mjs` and all of
 * `tests/contributedMenus.test.mjs`.
 *
 * The `commandPalette` location is deliberately NOT tracked per command: VS Code offers every
 * `contributes.commands` entry in the palette by default, and a `commandPalette` menu entry is
 * only an override (to hide a command, or gate a language variant) — so it is not a "surface a
 * command backs" the way the context menus are.
 */

/** Every menu location of `package.json#contributes.menus` a command can be offered in. */
export type MenuLocation =
	| 'commandPalette'
	| 'editor/title'
	| 'editor/context'
	| 'editor/title/context'
	| 'explorer/context'
	| 'scm/resourceState/context'
	| 'scm/title'
	| 'git.pullpush';

/** What one registered command declares about itself. */
export interface CommandSpec {
	/** The command identifier, as contributed in `package.json#contributes.commands`. */
	readonly id: string;
	/** The non-palette menu locations offering the command (may be empty: palette-only). */
	readonly menus: readonly MenuLocation[];
	/**
	 * The command exists only in the automation build: the default `package.json` deliberately
	 * does not contribute it — `scripts/package-with-automation.mjs` injects the contribution
	 * (button, palette entry, setting) only when packaging that variant.
	 */
	readonly automationBuildOnly?: true;
}

/**
 * Every command the extension registers, in registration order (the order the CommandManager
 * registers them in). The `.zhCn` entries are the Simplified-Chinese-titled twins of the
 * Source Control commands (a command's title cannot follow an Extension Setting, so each
 * menu-offered command ships under both titles).
 */
export const COMMANDS = [
	{ id: 'git-graph-rs.view', menus: ['scm/title'] },
	{ id: 'git-graph-rs.filterByFile', menus: ['explorer/context', 'editor/context', 'editor/title/context', 'scm/resourceState/context'] },
	{ id: 'git-graph-rs.addGitRepository', menus: [] },
	{ id: 'git-graph-rs.removeGitRepository', menus: [] },
	{ id: 'git-graph-rs.clearAvatarCache', menus: [] },
	{ id: 'git-graph-rs.fetch', menus: [] },
	{ id: 'git-graph-rs.endAllWorkspaceCodeReviews', menus: [] },
	{ id: 'git-graph-rs.endSpecificWorkspaceCodeReview', menus: [] },
	{ id: 'git-graph-rs.resumeWorkspaceCodeReview', menus: [] },
	{ id: 'git-graph-rs.version', menus: [] },
	{ id: 'git-graph-rs.showDiagnostics', menus: [] },
	{ id: 'git-graph-rs.searchCommits', menus: [] },
	{ id: 'git-graph-rs.openFile', menus: ['editor/title'] },
	{ id: 'git-graph-rs.runAutomationTest', menus: [], automationBuildOnly: true },
	{ id: 'git-graph-rs.amendLastCommit', menus: ['scm/title'] },
	{ id: 'git-graph-rs.resetCurrentBranchToRemote', menus: ['scm/title'] },
	{ id: 'git-graph-rs.gerritPushRef', menus: ['git.pullpush'] },
	{ id: 'git-graph-rs.gerritFetchCommitMsgHook', menus: ['scm/title'] },
	{ id: 'git-graph-rs.amendLastCommit.zhCn', menus: ['scm/title'] },
	{ id: 'git-graph-rs.resetCurrentBranchToRemote.zhCn', menus: ['scm/title'] },
	{ id: 'git-graph-rs.gerritPushRef.zhCn', menus: ['git.pullpush'] },
	{ id: 'git-graph-rs.gerritFetchCommitMsgHook.zhCn', menus: ['scm/title'] }
] as const satisfies readonly CommandSpec[];

/** Every command identifier the extension can register. */
export type CommandId = (typeof COMMANDS)[number]['id'];

/** The registry ids as a runtime list, in registration order. */
export const COMMAND_IDS: readonly CommandId[] = COMMANDS.map((command) => command.id);

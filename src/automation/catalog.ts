/**
 * The automation action catalog (task 6.2 assembly): the single source of truth that maps every
 * user-facing Git Graph View control (control-bar buttons, graph row interactions, context menus,
 * dialogs, view widgets) to a machine-runnable form. Each action declares both paths where
 * available:
 *   - `request`: the exact RequestMessage(s) the control sends into the extension host, so a
 *     driver can replay the backend path directly (stable timing, no rendering in the loop);
 *   - `ui`: the DOM steps a user performs, executed by the in-page automation shim (tests the
 *     whole stack, wiring included).
 * Placeholders `{{name}}` in either path are expanded by the server from the run parameters
 * and live repository state (repo, head, branch, commit, ...) before execution.
 *
 * The actions live in tagged domain files under ./catalog/ (one per group, carved verbatim out of
 * the former 3577-line single file); this module assembles them back into the CATALOG in the
 * exact original order, validates the invariants a split could silently break (the count, and
 * that every action carries at least one tag), and re-exports the catalog's public surface. The
 * types are in ./catalog/types.ts and the shared step builders in ./catalog/helpers.ts.
 */

export * from './catalog/types';

import { AutomationAction, UiStep } from './catalog/types';

const PLACEHOLDER_REGEXP = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

/**
 * The skip reason every layer reports for {@link AutomationAction.nativeSaveDialog} actions: the
 * modal they open (utils.archive's showSaveDialog) cannot be driven or dismissed by a run, so no
 * layer may ever execute them — the suite runner filters them before dispatching, and the engine
 * refuses them again as the backstop for a direct run() caller.
 */
export const NATIVE_SAVE_DIALOG_SKIP_REASON = 'opens the editor\'s native save dialog — not run by the automation suite';

/**
 * Expand every `{{name}}` placeholder in a template value from the context. Walks plain objects
 * and arrays; any other value passes through untouched. Throws on an unknown placeholder so a
 * bad catalog entry or missing run parameter fails loudly instead of reaching the host.
 */
export function expandTemplate<T>(template: T, context: Record<string, string>): T {
	if (typeof template === 'string') {
		return template.replace(PLACEHOLDER_REGEXP, (_match, name: string) => {
			if (!(name in context)) throw new Error('Unknown automation placeholder "' + name + '"');
			return context[name];
		}) as unknown as T;
	}
	if (Array.isArray(template)) {
		return template.map((item) => expandTemplate(item, context)) as unknown as T;
	}
	if (typeof template === 'object' && template !== null) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(template)) out[key] = expandTemplate((template as Record<string, unknown>)[key], context);
		return out as unknown as T;
	}
	return template;
}

/**
 * Structural validation of the whole catalog, run once at server start (and exercised by
 * tests/automationCatalog.test.mjs with stricter cross-checks against the message types).
 */
export function validateCatalog(catalog: readonly AutomationAction[]): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	const uiOps = new Set(['click', 'dblclick', 'contextmenu', 'key', 'waitFor', 'waitForGone', 'skipIfAbsent', 'set', 'expectText', 'eval', 'expectSize', 'expectCount', 'expectChecked']);
	const validateSteps = (where: string, steps: readonly UiStep[]) => {
		for (const [i, step] of steps.entries()) {
			if (!uiOps.has(step.op)) problems.push(where + ': unknown ui op "' + step.op + '" (step ' + i + ')');
			if ('selector' in step && typeof step.selector === 'string' && step.selector.trim() === '') {
				problems.push(where + ': empty selector (step ' + i + ')');
			}
			if (step.op === 'contextmenu') {
				const items = Array.isArray(step.item) ? step.item : [step.item];
				if (items.some((text) => text.trim() === '')) problems.push(where + ': empty menu item (step ' + i + ')');
			}
			if (step.op === 'eval' && step.expr.trim() === '') problems.push(where + ': empty eval expression (step ' + i + ')');
			if (step.op === 'expectSize') {
				const { minW, maxW, minH, maxH } = step;
				if (minW !== undefined && maxW !== undefined && minW > maxW) problems.push(where + ': expectSize has minW > maxW (step ' + i + ')');
				if (minH !== undefined && maxH !== undefined && minH > maxH) problems.push(where + ': expectSize has minH > maxH (step ' + i + ')');
			}
			if (step.op === 'expectCount') {
				const { min, max } = step;
				if (min !== undefined && max !== undefined && min > max) problems.push(where + ': expectCount has min > max (step ' + i + ')');
			}
		}
	};
	for (const action of catalog) {
		const where = 'action "' + action.id + '"';
		if (ids.has(action.id)) problems.push(where + ': duplicate id');
		ids.add(action.id);
		if (action.title.trim() === '') problems.push(where + ': empty title');
		if (action.group.trim() === '') problems.push(where + ': empty group');
		if (!Array.isArray(action.tags) || action.tags.length === 0) problems.push(where + ': missing tags (the group at minimum)');
		else {
			if (!action.tags.includes(action.group)) problems.push(where + ': tags must include the action\'s own group "' + action.group + '"');
			for (const tag of action.tags) {
				if (typeof tag !== 'string' || tag.trim() === '') problems.push(where + ': tags must be non-empty strings');
			}
		}
		if (!action.ui && !action.request && !action.vscodeCommand) problems.push(where + ': declares neither ui, request nor vscodeCommand path');
		if (action.ui) validateSteps(where, action.ui);
		if (action.uiAfter !== undefined) {
			if (action.vscodeCommand === undefined) problems.push(where + ': uiAfter steps are only meaningful for vscodeCommand actions');
			else validateSteps(where, action.uiAfter);
		}
		if (action.vscodeCommand !== undefined) {
			if (action.vscodeCommand.command.trim() === '') problems.push(where + ': empty vscode command');
			if (action.ui !== undefined) problems.push(where + ': declares both ui and vscodeCommand paths');
			if (action.request !== undefined) problems.push(where + ': declares both request and vscodeCommand paths');
		}
		if (action.expectTabs === true && action.vscodeCommand === undefined) problems.push(where + ': expectTabs is only meaningful for vscodeCommand actions');
		if (action.expectNotifications !== undefined) {
			if (action.vscodeCommand === undefined) problems.push(where + ': expectNotifications is only meaningful for vscodeCommand actions');
			else if (action.expectNotifications.length === 0) problems.push(where + ': expectNotifications must name at least one substring');
			else for (const needle of action.expectNotifications) {
				if (typeof needle !== 'string' || needle.trim() === '') problems.push(where + ': expectNotifications entries must be non-empty strings');
			}
		}
		if (action.expectAnyNotification === true && action.vscodeCommand === undefined) problems.push(where + ': expectAnyNotification is only meaningful for vscodeCommand actions');
		if (action.expectModal === true && action.vscodeCommand === undefined) problems.push(where + ': expectModal is only meaningful for vscodeCommand actions');
		if (action.request) {
			for (const [i, msg] of action.request.entries()) {
				if (typeof msg.command !== 'string' || msg.command === '') problems.push(where + ': request step ' + i + ' has no command');
			}
		}
		if (action.noHostTraffic === true) {
			if (action.expect.responses.length > 0) problems.push(where + ': noHostTraffic actions must not declare expected responses');
		} else if (action.expect.responses.length === 0) problems.push(where + ': no expected responses');
		for (const response of action.expect.responses) {
			if (response.indexOf('__') === 0) problems.push(where + ': reserved response command "' + response + '"');
		}
		if (action.allowErrorOn !== undefined) {
			for (const command of action.allowErrorOn) {
				if (!action.expect.responses.includes(command)) {
					problems.push(where + ': allowErrorOn lists "' + command + '", which is not an expected response');
				}
			}
		}
		if (action.verify !== undefined) {
			const placeholder = action.verify.placeholder;
			// Either a single {{name}} context reference or a plain literal the action itself names.
			if (placeholder.trim() === '' || (placeholder.indexOf('{{') !== -1
				&& (placeholder.indexOf('{{') !== 0 || placeholder.indexOf('}}') !== placeholder.length - 2 || placeholder.slice(2, -2) === ''))) {
				problems.push(where + ': verify placeholder must be a single {{name}} reference or a plain literal');
			}
		}
	}
	return problems;
}

import { CDV_ACTIONS } from './catalog/cdv';
import { CONTROL_BAR_ACTIONS } from './catalog/controlBar';
import { EXTERNAL_ACTIONS } from './catalog/external';
import { FIND_ACTIONS } from './catalog/find';
import { HOST_ACTIONS } from './catalog/host';
import { KEYBOARD_ACTIONS } from './catalog/keyboard';
import { MENUS_BRANCH_ACTIONS } from './catalog/menusBranch';
import { MENUS_COMMIT_ACTIONS } from './catalog/menusCommit';
import { MENUS_REMOTE_BRANCH_ACTIONS } from './catalog/menusRemoteBranch';
import { MENUS_STASH_ACTIONS } from './catalog/menusStash';
import { MENUS_TAG_ACTIONS } from './catalog/menusTag';
import { MENUS_UNCOMMITTED_ACTIONS } from './catalog/menusUncommitted';
import { MENUS_VSCODE_ACTIONS } from './catalog/menusVscode';
import { REFLOG_ACTIONS } from './catalog/reflog';
import { ROW_ACTIONS } from './catalog/row';
import { SETTINGS_ACTIONS } from './catalog/settings';
import { STATISTICS_ACTIONS } from './catalog/statistics';
import { WORKTREE_ACTIONS } from './catalog/worktree';

/**
 * The catalog. Entries are grouped by the surface they drive; the groups mirror the suites the
 * test driver can select. Fixture-stable facts (src/automation/fixture.ts): the remote is
 * `origin`, local branches are `main` / `local-ahead` (feature-NNN exist only as
 * origin/feature-NNN), tags are `v1.x.x` (spread over the whole history), three stashes are
 * seeded, an untracked file keeps the Uncommitted Changes row alive, (near HEAD, needing
 * at least 25 commits) a real binary file and a real decodable image are each added then modified —
 * and a tiny submodule at `sub/fixture-sub` (gitlink + `.gitmodules` on the final main commit,
 * rebuilt deterministically by every reseed) provides the second known repository the Repos
 * dropdown requires. Everything else is referenced through `{{placeholder}}` context.
 */

/**
 * The assembled catalog, in the original single-file order (the order IS behavior: the write
 * suite runs actions in catalog order, and menu-vscode deliberately precedes menu-commit).
 */
export const CATALOG: readonly AutomationAction[] = [
	...CONTROL_BAR_ACTIONS,
	...MENUS_VSCODE_ACTIONS,
	...ROW_ACTIONS,
	...MENUS_COMMIT_ACTIONS,
	...MENUS_UNCOMMITTED_ACTIONS,
	...MENUS_BRANCH_ACTIONS,
	...MENUS_REMOTE_BRANCH_ACTIONS,
	...MENUS_STASH_ACTIONS,
	...MENUS_TAG_ACTIONS,
	...CDV_ACTIONS,
	...SETTINGS_ACTIONS,
	...FIND_ACTIONS,
	...KEYBOARD_ACTIONS,
	...REFLOG_ACTIONS,
	...WORKTREE_ACTIONS,
	...STATISTICS_ACTIONS,
	...HOST_ACTIONS,
	...EXTERNAL_ACTIONS
];

/**
 * The action count of the pre-split catalog (146 across 18 groups). The load-time assertion
 * below fails the moment a split, merge or edit silently drops or duplicates an action; the
 * snapshot test (catalog.test.ts) pins the exact sequence.
 */
const EXPECTED_ACTION_COUNT = 146;

/**
 * Load-time invariant of the split catalog: every expected action present, and every action
 * carrying at least one tag (the minimum bar for the future affected-tier selection). Throwing
 * at import time is deliberate — a catalog that violates either is broken for every consumer,
 * not just the test that would have caught it.
 */
const untagged = CATALOG.filter((action) => !Array.isArray(action.tags) || action.tags.length === 0);
if (untagged.length > 0) {
	throw new Error('Automation catalog: actions without tags: ' + untagged.map((a) => a.id).join(', '));
}
if (CATALOG.length !== EXPECTED_ACTION_COUNT) {
	throw new Error('Automation catalog: expected ' + EXPECTED_ACTION_COUNT + ' actions, assembled ' + CATALOG.length);
}

/**
 * Tests for the coverage-matrix extractor (scripts/dev/coverage-matrix.mjs, task 0.6).
 *
 * Ported from tests/coverageMatrix.test.mjs (REFACTOR-PLAN task 7.1); assertions are unchanged.
 *
 * Hermetic: every source shape the eight dimensions are extracted from — a package.json
 * contributes fragment, a protocol request map, a write-op file, a UiPort interface, a
 * webview control file, a context-menu/dialog action file, an automation catalog data file
 * and the i18n/nls dictionaries — is recreated as a tiny fixture in a temp directory, and the
 * exported pure extractor functions (plus the whole extractFromRepo assembly) run against
 * THOSE. The real repository is never read here: `node scripts/dev/coverage-matrix.mjs` is
 * the bonus CLI mode for that, and it is not a test dependency.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
	buildMatrix,
	collectStringLiterals,
	crossCheck,
	extractCatalogEntries,
	extractCommands,
	extractFromRepo,
	extractI18nKeys,
	extractI18nValues,
	extractNlsKeys,
	extractProtocolRequests,
	extractSettings,
	extractUiPortMethods,
	extractWebviewControls,
	extractWriteOps,
	findUiPortCallSites,
	renderMarkdown,
	renderSummary,
	uiPortMethodIsCovered,
	webviewControlIsCovered
} from '../../scripts/dev/coverage-matrix.mjs';

/* ------------------------------------------------------------------ */
/* Fixtures — one tiny file per source shape                           */
/* ------------------------------------------------------------------ */

const FIXTURE_PACKAGE_JSON = JSON.stringify({
	contributes: {
		commands: [
			{ command: 'git-graph-rs.view', title: '%command.git-graph-rs.view.title%' },
			{ command: 'git-graph-rs.orphan', title: 'Orphan' }
		],
		menus: {
			commandPalette: [
				{ command: 'git-graph-rs.view', when: 'true' },
				{ command: 'git-graph-rs.orphan', when: 'false' }
			],
			'explorer/context': [
				{ command: 'git-graph-rs.orphan', when: 'resourceScheme == file', group: 'git-graph-rs@1' }
			]
		},
		configuration: {
			properties: {
				'git-graph-rs.dialog.addTag.pushToRemote': { type: 'boolean', default: false },
				'git-graph-rs.orphanSetting': { type: 'boolean', default: false },
				'git-graph-rs.contextMenuActionsVisibility': {
					type: 'object',
					properties: {
						branch: {
							type: 'object',
							properties: {
								'checkout': { type: 'boolean' }
							}
						}
					}
				}
			}
		}
	}
}, null, '\t');

const FIXTURE_PROTOCOL = [
	'import type { RequestAddTag } from \'../../types\';',
	'',
	'/** The host↔webview protocol of the fixture view. */',
	'export interface GraphViewRequests {',
	'\treadonly addTag: { readonly req: RequestAddTag; readonly res: ResponseAddTag };',
	'\treadonly checkoutBranch: { readonly req: RequestCheckoutBranch; readonly res: ResponseCheckoutBranch };',
	'\treadonly loadCommits: { readonly req: RequestLoadCommits; readonly res: ResponseLoadCommits };',
	'\treadonly orphanRequest: { readonly req: RequestOrphan; readonly res: void };',
	'}',
	'',
	'export type RequestCommand = keyof GraphViewRequests;'
].join('\n');

const FIXTURE_OP_FILE = [
	'import { WriteOp, WriteStep, single } from \'./op\';',
	'',
	'export function checkoutBranch(params: CheckoutBranchParams): WriteOp {',
	'\treturn {',
	'\t\tsteps: [{ argv: [\'checkout\', params.branchName] }],',
	'\t\teffects: [\'refs\'],',
	'\t\tchecks: []',
	'\t};',
	'}',
	'',
	'// A helper export that returns argv, NOT a WriteOp: it must not be extracted.',
	'export function pushBranchArgv(branchName: string): ReadonlyArray<string> {',
	'\treturn [\'push\', branchName];',
	'}'
].join('\n');

const FIXTURE_UI_PORT = [
	'export interface NotificationsPort {',
	'\tshowErrorMessage(message: string): Promise<void>;',
	'}',
	'',
	'export interface UiPort extends NotificationsPort {',
	'\tshowInformationMessage(message: string): Promise<string | undefined>;',
	'\tshowInformationMessage(message: string, options: MessageOptionsLike): Promise<string | undefined>;',
	'\tshowInputBox(options?: InputBoxOptionsLike): Promise<string | undefined>;',
	'\tshowSaveDialog(options: SaveDialogOptionsLike): Promise<UriLike | undefined>;',
	'\twithProgress<R>(options: ProgressOptionsLike, task: (progress: ProgressLike) => Thenable<R>): Promise<R>;',
	'}'
].join('\n');

const FIXTURE_CALL_SITE = [
	'import type { UiPort } from \'../platform/uiPort\';',
	'',
	'export function handler(uiPort: UiPort) {',
	'\tconst name = ctx.ui.showInputBox();',
	'\tctx.ui.showInformationMessage(\'done\');',
	'\tctx.ui.showErrorMessage(\'boom\');',
	'\tctx.ui.notAPortMethod();',
	'}'
].join('\n');

const FIXTURE_CONTROL_BAR = [
	'export function renderControlBar() {',
	'\treturn \'<button id="refreshBtn">Refresh</button>\';',
	'}'
].join('\n');

const FIXTURE_DIALOG_WIDGET = [
	'export function renderDialog() {',
	'\tconst closeIcon = document.createElement(\'span\');',
	'\tcloseIcon.id = \'cdvClose\';',
	'\treturn \'<div id="dialogAction">OK</div>\';',
	'}'
].join('\n');

const FIXTURE_SELECT_WIDGET = [
	'export function renderOption(index: number) {',
	'\treturn \'<div id="option\' + index + \'">x</div>\';',
	'}',
	'export function renderTemplated(id: number) {',
	'\treturn `<input id="dialogInput${id}">`;',
	'}'
].join('\n');

const FIXTURE_DIALOG_WIDGET_TEST = [
	'// A test file: its ids must NOT leak into the control extraction.',
	'export function renderTest() {',
	'\treturn \'<div id="testOnlyId">x</div>\';',
	'}'
].join('\n');

const FIXTURE_CONTEXT_MENU_ACTIONS = [
	'export function getCommitContextMenuActions(ctx: GraphContext): ContextMenuActions {',
	'\treturn [[{',
	'\t\ttitle: strings.menuAddTag,',
	'\t\tvisible: true,',
	'\t\tonClick: () => addTagAction(ctx, hash)',
	'\t}, {',
	'\t\ttitle: strings.menuOrphanItem,',
	'\t\tvisible: false,',
	'\t\tonClick: () => {}',
	'\t}]];',
	'}'
].join('\n');

const FIXTURE_DIALOG_ACTIONS = [
	'export function addTagAction(ctx: GraphContext, hash: string) {',
	'\tctx.dialog.showConfirmation(message, strings.dialogApply, () => {}, null);',
	'}',
	'',
	'// A name helper: does not end in "Action", must not be extracted.',
	'export function getMergeActionOnName(actionOn: string): string {',
	'\treturn actionOn;',
	'}'
].join('\n');

const FIXTURE_CATALOG = [
	'import { AutomationAction } from \'./types\';',
	'import { bi } from \'./helpers\';',
	'',
	'export const FIXTURE_ACTIONS: readonly AutomationAction[] = [',
	'\t{',
	'\t\tid: \'control-bar/refresh\',',
	'\t\ttitle: \'Refresh\',',
	'\t\tgroup: \'control-bar\',',
	'\t\ttags: [\'control-bar\'],',
	'\t\tmutable: false,',
	'\t\tui: [',
	'\t\t\t{ op: \'click\', selector: \'#refreshBtn\' }',
	'\t\t],',
	'\t\trequest: [{ command: \'addTag\', repo: \'{{repo}}\' }],',
	'\t\texpect: { responses: [\'addTag\'] },',
	'\t\tverify: { kind: \'tagPresent\', placeholder: \'automation-tag\' }',
	'\t},',
	'\t{',
	'\t\tid: \'menu-vscode/view\',',
	'\t\ttitle: \'Open the View\',',
	'\t\tgroup: \'menu-vscode\',',
	'\t\ttags: [\'menu-vscode\', \'command\'],',
	'\t\tmutable: false,',
	'\t\tvscodeCommand: { command: \'git-graph-rs.view\', arg: { kind: \'rootUri\' } }',
	'\t},',
	'\t{',
	'\t\tid: \'menu-commit/add-tag\',',
	'\t\ttitle: \'Add Tag…\',',
	'\t\tgroup: \'menu-commit\',',
	'\t\ttags: [\'menu-commit\', \'context-menu\'],',
	'\t\tmutable: true,',
	'\t\tnativeSaveDialog: true,',
	'\t\t// opens the same dialog as addTagAction; the visible item is offered per interface language',
	'\t\tui: [',
	'\t\t\t{ op: \'contextmenu\', selector: \'tr.commit[data-hash="{{commit}}"]\', item: bi(\'Add Tag…\', \'添加标签…\') },',
	'\t\t\t{ op: \'click\', selector: \'#option2\' }',
	'\t\t],',
	'\t\trequest: [{ command: \'checkoutBranch\', setting: \'git-graph-rs.dialog.addTag.pushToRemote\' }],',
	'\t\texpect: { responses: [\'checkoutBranch\'] }',
	'\t},',
	'\t{',
	'\t\tid: \'host/passive\',',
	'\t\ttitle: \'Passive\',',
	'\t\tgroup: \'host\',',
	'\t\ttags: [\'host\'],',
	'\t\tmutable: false,',
	'\t\t// no request: driven here — view-state only, so this entry is NOT machine-drivable',
	'\t\texpect: { responses: [\'loadCommits\'] }',
	'\t}',
	'];'
].join('\n');

const FIXTURE_CATALOG_HELPERS = [
	'export const bi = (en: string, zh: string): readonly string[] => [en, zh];'
].join('\n');

const FIXTURE_I18N_EN = [
	'export const STRINGS_EN = {',
	'\tmenuAddTag: \'Add Tag\',',
	'\tdialogCancel: \'Cancel\'',
	'};'
].join('\n');

const FIXTURE_I18N_ZH = [
	'export const STRINGS_ZH_CN = {',
	'\tmenuAddTag: \'添加标签\',',
	'\tzhOnlyKey: \'只有中文\'',
	'};'
].join('\n');

const FIXTURE_NLS_EN = JSON.stringify({
	'command.git-graph-rs.view.title': 'Open the View',
	'config.orphan.title': 'Orphan'
}, null, '\t');

const FIXTURE_NLS_ZH = JSON.stringify({
	'command.git-graph-rs.view.title': '打开视图',
	'config.orphan.title': '孤立项',
	'command.zhOnly.title': '仅中文'
}, null, '\t');

/* ------------------------------------------------------------------ */
/* The fixture repository tree                                         */
/* ------------------------------------------------------------------ */

describe('the coverage-matrix extractor', () => {
	let root: string;
	let catalogFiles: Array<{ path: string, text: string }>;
	let dimensions: any;
	let facts: any;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-coverage-'));
		const write = (relative: string, content: string) => {
			const file = path.join(root, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, content);
		};
		write('package.json', FIXTURE_PACKAGE_JSON);
		write('package.nls.json', FIXTURE_NLS_EN);
		write('package.nls.zh-cn.json', FIXTURE_NLS_ZH);
		write('src/shared/protocol/graphView.ts', FIXTURE_PROTOCOL);
		write('src/shared/i18n/en.ts', FIXTURE_I18N_EN);
		write('src/shared/i18n/zh-cn.ts', FIXTURE_I18N_ZH);
		write('src/extension/platform/uiPort.ts', FIXTURE_UI_PORT);
		write('src/extension/git/write/ops/branches.ts', FIXTURE_OP_FILE);
		write('src/extension/graphView/handlers/misc.ts', FIXTURE_CALL_SITE);
		write('src/webview/graph/controlBar/controlBar.ts', FIXTURE_CONTROL_BAR);
		write('src/webview/graph/widgets/dialog.ts', FIXTURE_DIALOG_WIDGET);
		write('src/webview/graph/widgets/customSelect.ts', FIXTURE_SELECT_WIDGET);
		write('src/webview/graph/widgets/dialog.test.ts', FIXTURE_DIALOG_WIDGET_TEST);
		write('src/webview/graph/actions/contextMenuActions.ts', FIXTURE_CONTEXT_MENU_ACTIONS);
		write('src/webview/graph/actions/dialogActions.ts', FIXTURE_DIALOG_ACTIONS);
		write('src/automation/catalog/controlBar.ts', FIXTURE_CATALOG);
		write('src/automation/catalog/helpers.ts', FIXTURE_CATALOG_HELPERS);

		catalogFiles = [{ path: 'src/automation/catalog/controlBar.ts', text: FIXTURE_CATALOG }];
		({ dimensions, facts } = extractFromRepo(root) as any);
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	/* --- dimension 1: contributed commands + menu locations --- */

	describe('dimension 1: contributed commands', () => {
		it('extracts command ids and (menu location × command × when) pairs', () => {
			const { commands, menuItems } = extractCommands(FIXTURE_PACKAGE_JSON) as any;
			assert.deepEqual(commands.map((command: any) => command.id), ['git-graph-rs.view', 'git-graph-rs.orphan']);
			assert.deepEqual(menuItems, [
				{ id: 'commandPalette::git-graph-rs.view', menu: 'commandPalette', command: 'git-graph-rs.view', when: 'true' },
				{ id: 'commandPalette::git-graph-rs.orphan', menu: 'commandPalette', command: 'git-graph-rs.orphan', when: 'false' },
				{ id: 'explorer/context::git-graph-rs.orphan', menu: 'explorer/context', command: 'git-graph-rs.orphan', when: 'resourceScheme == file' }
			]);
		});
		it('cross-checks against the catalog (command mode covers the driven command only)', () => {
			assert.equal(dimensions['contributed-commands'].total, 2);
			assert.deepEqual(dimensions['contributed-commands'].uncovered, ['git-graph-rs.orphan']);
			assert.equal(dimensions['command-menu-items'].total, 3);
			assert.equal(dimensions['command-menu-items'].covered, 1);
			assert.deepEqual(dimensions['command-menu-items'].uncovered, [
				'commandPalette::git-graph-rs.orphan',
				'explorer/context::git-graph-rs.orphan'
			]);
		});
	});

	/* --- dimension 2: settings --- */

	describe('dimension 2: settings', () => {
		it('extracts nested key paths', () => {
			const settings = extractSettings(FIXTURE_PACKAGE_JSON) as any[];
			assert.deepEqual(settings.map((setting) => setting.id), [
				'git-graph-rs.dialog.addTag.pushToRemote',
				'git-graph-rs.orphanSetting',
				'git-graph-rs.contextMenuActionsVisibility',
				'git-graph-rs.contextMenuActionsVisibility.branch',
				'git-graph-rs.contextMenuActionsVisibility.branch.checkout'
			]);
		});
		it('cross-checks against the catalog', () => {
			assert.equal(dimensions['settings'].total, 5);
			assert.equal(dimensions['settings'].covered, 1);
			assert.deepEqual(dimensions['settings'].uncovered, [
				'git-graph-rs.orphanSetting',
				'git-graph-rs.contextMenuActionsVisibility',
				'git-graph-rs.contextMenuActionsVisibility.branch',
				'git-graph-rs.contextMenuActionsVisibility.branch.checkout'
			]);
		});
	});

	/* --- dimension 3: protocol requests --- */

	describe('dimension 3: protocol requests', () => {
		it('extracts the keys of the GraphViewRequests map', () => {
			const requests = extractProtocolRequests(FIXTURE_PROTOCOL) as any[];
			assert.deepEqual(requests.map((request) => request.id), ['addTag', 'checkoutBranch', 'loadCommits', 'orphanRequest']);
		});
		it('cross-checks against the catalog', () => {
			assert.equal(dimensions['protocol-requests'].total, 4);
			assert.equal(dimensions['protocol-requests'].covered, 3);
			assert.deepEqual(dimensions['protocol-requests'].uncovered, ['orphanRequest']);
		});
	});

	/* --- dimension 4: write operations --- */

	describe('dimension 4: write operations', () => {
		it('extracts only the exports annotated to return a WriteOp', () => {
			const ops = extractWriteOps([{ path: 'ops/branches.ts', text: FIXTURE_OP_FILE }]);
			assert.deepEqual(ops, [{ id: 'checkoutBranch', file: 'ops/branches.ts' }]);
		});
		it('cross-checks against the catalog', () => {
			assert.equal(dimensions['write-operations'].total, 1);
			assert.equal(dimensions['write-operations'].covered, 1);
			assert.deepEqual(dimensions['write-operations'].uncovered, []);
		});
	});

	/* --- dimension 5: UiPort --- */

	describe('dimension 5: UiPort methods and call sites', () => {
		it('extracts interface methods, deduplicating overloads', () => {
			const methods = extractUiPortMethods(FIXTURE_UI_PORT) as any[];
			assert.deepEqual(methods.map((method) => method.id), ['showInformationMessage', 'showInputBox', 'showSaveDialog', 'withProgress']);
		});
		it('lists (file, method) call sites restricted to declared methods, plus importers', () => {
			const methods = extractUiPortMethods(FIXTURE_UI_PORT);
			const { callSites, importers } = findUiPortCallSites([{ path: 'handlers/misc.ts', text: FIXTURE_CALL_SITE }], methods) as any;
			assert.deepEqual(callSites, [
				{ file: 'handlers/misc.ts', method: 'showInputBox' },
				{ file: 'handlers/misc.ts', method: 'showInformationMessage' }
			]);
			assert.deepEqual(importers, ['handlers/misc.ts']);
		});
		it('covers showSaveDialog through the nativeSaveDialog catalog flag', () => {
			const literals = collectStringLiterals(FIXTURE_CATALOG);
			assert.equal(dimensions['ui-port'].total, 4);
			assert.equal(dimensions['ui-port'].covered, 1);
			assert.deepEqual(dimensions['ui-port'].uncovered, ['showInformationMessage', 'showInputBox', 'withProgress']);
			assert.equal(uiPortMethodIsCovered('showSaveDialog', literals, FIXTURE_CATALOG), true);
			assert.equal(uiPortMethodIsCovered('showInputBox', literals, FIXTURE_CATALOG), false);
		});
	});

	/* --- dimension 6: webview controls --- */

	describe('dimension 6: webview controls', () => {
		it('extracts static ids, dynamic prefixes, context-menu items and dialog actions; skips test files', () => {
			const files = [
				{ path: 'src/webview/graph/controlBar/controlBar.ts', text: FIXTURE_CONTROL_BAR },
				{ path: 'src/webview/graph/widgets/dialog.ts', text: FIXTURE_DIALOG_WIDGET },
				{ path: 'src/webview/graph/widgets/customSelect.ts', text: FIXTURE_SELECT_WIDGET },
				{ path: 'src/webview/graph/widgets/dialog.test.ts', text: FIXTURE_DIALOG_WIDGET_TEST },
				{ path: 'src/webview/graph/actions/contextMenuActions.ts', text: FIXTURE_CONTEXT_MENU_ACTIONS },
				{ path: 'src/webview/graph/actions/dialogActions.ts', text: FIXTURE_DIALOG_ACTIONS }
			];
			const controls = extractWebviewControls(files as never) as any;
			assert.deepEqual(controls.elements.map((element: any) => element.id), [
				'element:refreshBtn', 'element:cdvClose', 'element:dialogAction', 'element:option*', 'element:dialogInput*'
			]);
			assert.deepEqual(controls.contextMenuItems, [{ id: 'contextMenu:menuAddTag', key: 'menuAddTag' }, { id: 'contextMenu:menuOrphanItem', key: 'menuOrphanItem' }]);
			assert.deepEqual(controls.dialogActions, [{ id: 'dialogAction:addTagAction' }]);
		});
		it('cross-checks against the catalog (selectors, bi() menu texts, dialog names)', () => {
			assert.equal(dimensions['webview-controls'].total, 8);
			assert.equal(dimensions['webview-controls'].covered, 4);
			assert.deepEqual(dimensions['webview-controls'].uncovered, ['element:cdvClose', 'element:dialogAction', 'element:dialogInput*', 'contextMenu:menuOrphanItem']);
		});
		it('matches a dynamic selector prefix and a bilingual context-menu label', () => {
			const literals = collectStringLiterals(FIXTURE_CATALOG);
			const values = extractI18nValues(FIXTURE_I18N_EN);
			assert.equal(webviewControlIsCovered({ id: 'element:option*' } as never, literals, FIXTURE_CATALOG, values), true);
			assert.equal(webviewControlIsCovered({ id: 'element:dialogAction' } as never, literals, FIXTURE_CATALOG, values), false);
			assert.equal(webviewControlIsCovered({ id: 'contextMenu:menuAddTag', key: 'menuAddTag' } as never, literals, FIXTURE_CATALOG, values), true);
			assert.equal(webviewControlIsCovered({ id: 'contextMenu:menuOrphanItem', key: 'menuOrphanItem' } as never, literals, FIXTURE_CATALOG, values), false);
		});
	});

	/* --- dimension 7: automation catalog --- */

	describe('dimension 7: automation catalog', () => {
		it('extracts id, group, tags, drive modes and the verify flag per entry', () => {
			const entries = extractCatalogEntries(catalogFiles as never) as any[];
			assert.deepEqual(entries.map((entry) => entry.id), ['control-bar/refresh', 'menu-vscode/view', 'menu-commit/add-tag', 'host/passive']);
			assert.deepEqual(entries.map((entry) => entry.modes), [['ui', 'request'], ['command'], ['ui', 'request'], []]);
			assert.deepEqual(entries.map((entry) => entry.hasVerify), [true, false, false, false]);
			assert.deepEqual(entries[0].tags, ['control-bar']);
			assert.equal(entries[2].nativeSaveDialog, true);
		});
		it('does not let comments invent drive modes or fields', () => {
			const passive = (extractCatalogEntries(catalogFiles as never) as any[]).find((entry) => entry.id === 'host/passive');
			assert.deepEqual(passive.modes, []);
			assert.equal(passive.hasVerify, false);
			assert.deepEqual(passive.tags, ['host']);
		});
		it('marks entries without any drive mode as uncovered', () => {
			assert.equal(dimensions['automation-catalog'].total, 4);
			assert.equal(dimensions['automation-catalog'].covered, 3);
			assert.deepEqual(dimensions['automation-catalog'].uncovered, ['host/passive']);
			assert.equal(facts.entriesWithVerify, 1);
			assert.equal(facts.nativeSaveDialogEntries, 1);
		});
	});

	/* --- dimension 8: UI languages --- */

	describe('dimension 8: UI languages', () => {
		it('extracts i18n and nls keys with en/zh-cn presence', () => {
			const i18n = extractI18nKeys(FIXTURE_I18N_EN, FIXTURE_I18N_ZH) as any;
			assert.deepEqual(i18n.onlyInEn, ['dialogCancel']);
			assert.deepEqual(i18n.onlyInZh, ['zhOnlyKey']);
			assert.deepEqual(i18n.items, [
				{ id: 'i18n:menuAddTag', inEn: true, inZh: true },
				{ id: 'i18n:dialogCancel', inEn: true, inZh: false },
				{ id: 'i18n:zhOnlyKey', inEn: false, inZh: true }
			]);
			const nls = extractNlsKeys(FIXTURE_NLS_EN, FIXTURE_NLS_ZH) as any;
			assert.deepEqual(nls.onlyInZh, ['command.zhOnly.title']);
			assert.deepEqual(nls.onlyInEn, []);
		});
		it('extracts the interface-language values used by bi() matching', () => {
			const values = extractI18nValues(FIXTURE_I18N_EN) as any;
			assert.deepEqual(values.get('menuAddTag'), ['Add Tag']);
		});
		it('cross-checks against the catalog', () => {
			assert.equal(dimensions['ui-languages'].total, 6);
			assert.equal(dimensions['ui-languages'].covered, 2);
			assert.deepEqual(dimensions['ui-languages'].uncovered.sort(), [
				'i18n:dialogCancel',
				'i18n:zhOnlyKey',
				'nls:command.zhOnly.title',
				'nls:config.orphan.title'
			]);
		});
	});

	/* --- supplementary facts --- */

	describe('supplementary facts', () => {
		it('reports call sites, importers and per-language key gaps', () => {
			assert.deepEqual(facts.importers, ['src/extension/graphView/handlers/misc.ts']);
			assert.deepEqual(facts.callSites, [
				{ file: 'src/extension/graphView/handlers/misc.ts', method: 'showInputBox' },
				{ file: 'src/extension/graphView/handlers/misc.ts', method: 'showInformationMessage' }
			]);
			assert.deepEqual(facts.i18nOnlyInEn, ['dialogCancel']);
			assert.deepEqual(facts.i18nOnlyInZh, ['zhOnlyKey']);
			assert.deepEqual(facts.nlsOnlyInZh, ['command.zhOnly.title']);
			assert.deepEqual(facts.groups, ['control-bar', 'host', 'menu-commit', 'menu-vscode']);
		});
	});

	/* --- matrix assembly and rendering --- */

	describe('matrix assembly and rendering', () => {
		it('produces the { total, covered, uncovered } cell shape per dimension', () => {
			const cell = crossCheck([{ id: 'a' }, { id: 'b' }], (item: any) => item.id === 'a');
			assert.deepEqual(cell, { total: 2, covered: 1, uncovered: ['b'] });
			const matrix = buildMatrix({ 'protocol-requests': cell });
			assert.deepEqual(matrix, { 'protocol-requests': { total: 2, covered: 1, uncovered: ['b'] } });
		});
		it('renders a markdown table plus per-dimension uncovered samples', () => {
			const markdown = renderMarkdown(dimensions, { generated: '2026-10-25T00:00:00.000Z' });
			assert.match(markdown, /\| protocol-requests \| 4 \| 3 \| 1 \|/);
			assert.match(markdown, /### protocol-requests — 1 uncovered/);
			assert.match(markdown, /`orphanRequest`/);
			assert.match(markdown, /counting only/);
		});
		it('renders the stdout summary lines', () => {
			const summary = renderSummary(dimensions) as string[];
			assert.equal(summary.length, Object.keys(dimensions).length);
			assert.match(summary[0], /contributed-commands\s+1 \/ 2\s+covered \(1 uncovered\)/);
		});
	});
});

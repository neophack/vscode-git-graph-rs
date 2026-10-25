import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../automation/catalog';
import type { AutomationAction } from '../../automation/catalog';
import { COMMANDS, COMMAND_IDS } from './registry';
import type { CommandSpec } from './registry';

/**
 * The registry contract (task 4.6): the declarative command list is compared bidirectionally
 * against package.json#contributes — every contributed command is registered, every registered
 * command is contributed (automation-build commands aside), and the menu surfaces match exactly.
 * A command extra or missing on either side fails. Also carries the menu-structure assertions
 * migrated from tests/contributedMenus.test.mjs (language-variant symmetry, when-clause keys,
 * localized titles, palette gating, automation catalog coverage) and the activation-event
 * assertions migrated from the command half of tests/contract.test.mjs.
 */

/** Root of the repository (vitest runs there). */
const root = process.cwd();

function readJson(...parts: string[]): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root, ...parts), 'utf8')) as Record<string, unknown>;
}

interface ContributedCommand {
	readonly command: string;
	readonly title: string;
}

interface MenuItem {
	readonly command: string;
	readonly when?: string;
	readonly group?: string;
}

interface PackageManifest {
	readonly activationEvents: readonly string[];
	readonly contributes: {
		readonly commands: readonly ContributedCommand[];
		readonly menus: { readonly [location: string]: readonly MenuItem[] };
	};
}

const pkg = readJson('package.json') as unknown as PackageManifest;
const contributed = pkg.contributes.commands.map((command) => command.command);
const menus = pkg.contributes.menus;
const menuLocations = Object.keys(menus);

/** Registry ids, minus the automation-build-only commands (not contributed by the default package). */
const registered: readonly string[] = COMMANDS.filter((spec) => (spec as CommandSpec).automationBuildOnly !== true).map((spec) => spec.id);

/** The non-palette menu locations package.json offers a command in. */
const surfacesOf = (id: string) => menuLocations.filter((location) => location !== 'commandPalette' && menus[location].some((item) => item.command === id)).sort();

/* ---------- registry vs package.json (bidirectional) ---------- */

describe('the command registry vs package.json#contributes', () => {
	it('contributes every command the registry registers, and registers every command it contributes', () => {
		expect(new Set(COMMAND_IDS).size, 'registry ids must be unique').toBe(COMMAND_IDS.length);
		expect(contributed.filter((id) => !registered.includes(id)).sort(), 'contributed but not registered').toEqual([]);
		expect(registered.filter((id) => !contributed.includes(id)).sort(), 'registered but not contributed').toEqual([]);
	});

	it('points every menu item at a registered, declared command', () => {
		for (const location of menuLocations) {
			for (const item of menus[location]) {
				expect(registered.includes(item.command), location + ': "' + item.command + '" is not in the registry (the menu item would silently not render)').toBe(true);
				expect(contributed.includes(item.command), location + ': "' + item.command + '" is not declared in contributes.commands').toBe(true);
			}
		}
	});

	it('offers each command in exactly the menu surfaces its registry entry declares', () => {
		for (const spec of COMMANDS) {
			expect(surfacesOf(spec.id), spec.id).toEqual([...spec.menus].sort());
		}
	});

	it('activates on every contributed command', () => {
		const activationEvents = pkg.activationEvents.filter((event) => event.startsWith('onCommand:'));
		expect(activationEvents.length, 'expected command activation events').toBeGreaterThan(0);
		const activated = activationEvents.map((event) => event.slice('onCommand:'.length));
		expect(activated.filter((command) => !contributed.includes(command)).sort(), 'activation events pointing at commands that do not exist').toEqual([]);
		// Commands that show in the palette unconditionally need an activation event; the ones
		// gated by a `when` clause (openFile inside a diff editor) only ever run once the
		// extension is active already, exactly as in the original extension.
		const unconditioned = menus.commandPalette.filter((entry) => entry.when === undefined).map((entry) => entry.command);
		expect(unconditioned.filter((command) => !activated.includes(command)).sort(), 'always-visible palette commands that would not activate the extension').toEqual([]);
	});
});

/* ---------- the interface-language variants (migrated from contributedMenus.test.mjs) ---------- */

/** Menu commands with a .zhCn twin (a command's title cannot follow a setting). */
const LANGUAGE_PAIRED_COMMANDS = ['amendLastCommit', 'resetCurrentBranchToRemote', 'gerritPushRef', 'gerritFetchCommitMsgHook'];

describe('the interface-language command variants', () => {
	it('stay symmetric across every menu and the palette', () => {
		for (const location of menuLocations) {
			const offered = new Set(menus[location].map((item) => item.command));
			for (const base of LANGUAGE_PAIRED_COMMANDS) {
				expect(offered.has('git-graph-rs.' + base + '.zhCn'), location + ': "' + base + '" and its .zhCn variant must be offered together').toBe(offered.has('git-graph-rs.' + base));
			}
		}
		// Where both variants are offered, their when clauses may differ only by the language context.
		for (const location of menuLocations) {
			for (const base of LANGUAGE_PAIRED_COMMANDS) {
				const en = menus[location].find((item) => item.command === 'git-graph-rs.' + base);
				const zh = menus[location].find((item) => item.command === 'git-graph-rs.' + base + '.zhCn');
				if (en === undefined || zh === undefined) continue;
				expect((en.when ?? '').replace('!git-graph-rs:interfaceZhCn', '\u0001'), location + ': the variants of "' + base + '" differ beyond the interface language context')
					.toBe((zh.when ?? '').replace('git-graph-rs:interfaceZhCn', '\u0001'));
			}
		}
		// The palette gates each variant on exactly the interface language context.
		for (const base of LANGUAGE_PAIRED_COMMANDS) {
			const palette = new Map(menus.commandPalette.filter((item) => item.command === 'git-graph-rs.' + base || item.command === 'git-graph-rs.' + base + '.zhCn').map((item) => [item.command, item.when]));
			expect(palette.get('git-graph-rs.' + base), base + ': the palette entry must hide the English variant under zh-CN').toBe('!git-graph-rs:interfaceZhCn');
			expect(palette.get('git-graph-rs.' + base + '.zhCn'), base + ': the palette entry must show the zh-CN variant only under zh-CN').toBe('git-graph-rs:interfaceZhCn');
		}
	});
});

/* ---------- when clauses and titles (migrated from contributedMenus.test.mjs) ---------- */

/** Context keys the when clauses may use: the ones the extension sets, plus VS Code built-ins. */
const EXTENSION_CONTEXT_KEYS = ['git-graph-rs:interfaceZhCn', 'git-graph-rs:codiconsSupported'];
const BUILTIN_WHEN_KEYS = ['resourceScheme', 'listMultiSelection', 'isInDiffEditor', 'scmProvider'];
/** Bare unquoted literals that appear inside when clauses (scheme names, the false hide). */
const WHEN_LITERALS = ['git', 'file', 'git-graph-rs', 'false', 'true'];

describe('the menus\' when clauses and titles', () => {
	it('use only context keys the extension or VS Code itself provides', () => {
		for (const location of menuLocations) {
			for (const item of menus[location]) {
				// Quoted string literals are comparison VALUES ('More Actions', 'Inline'), not keys.
				const clause = (item.when ?? '').replace(/'[^']*'/g, ' ');
				for (const token of clause.match(/[A-Za-z][A-Za-z0-9_.:\-]*/g) ?? []) {
					if (token.indexOf('config.') === 0 || WHEN_LITERALS.includes(token)) continue;
					expect(EXTENSION_CONTEXT_KEYS.includes(token) || BUILTIN_WHEN_KEYS.includes(token),
						location + '/' + item.command + ': when-clause key "' + token + '" is neither set by the extension (setContext in src/extension/commands/) nor a known VS Code built-in').toBe(true);
				}
			}
		}
		// The extension-set keys must really be set somewhere in the command sources.
		const commandsDir = join(root, 'src', 'extension', 'commands');
		const sources = readdirSync(commandsDir).filter((entry) => entry.endsWith('.ts')).map((entry) => readFileSync(join(commandsDir, entry), 'utf8')).join('\n');
		for (const key of EXTENSION_CONTEXT_KEYS) {
			expect(sources.includes('"' + key + '"'), 'context key "' + key + '" must be set via setContext in src/extension/commands/').toBe(true);
		}
	});

	it('have localized titles in every shipped language', () => {
		const en = readJson('package.nls.json');
		const zh = readJson('package.nls.zh-cn.json');
		for (const command of pkg.contributes.commands) {
			const match = /^%(.+)%$/.exec(command.title);
			if (match === null) continue; // literal (language-variant) titles
			expect(en[match[1]] !== undefined, '"' + command.command + '": English title key ' + match[1] + ' missing from package.nls.json').toBe(true);
			expect(zh[match[1]] !== undefined, '"' + command.command + '": zh-CN title key ' + match[1] + ' missing from package.nls.zh-cn.json').toBe(true);
		}
		expect(en['command.git-graph-rs.filterByFile.title']).toBe('Show File History in Git Graph RS');
	});

	it('hides the file-history command from the palette (it needs a file argument)', () => {
		const paletteEntry = menus.commandPalette.find((item) => item.command === 'git-graph-rs.filterByFile');
		expect(paletteEntry, 'filterByFile must declare a commandPalette entry').toBeDefined();
		expect(paletteEntry?.when, 'filterByFile cannot run from the palette (no file to filter by)').toBe('false');
		// ...and the menus that DO offer it pass one: the four resource surfaces.
		const offering = menuLocations.filter((location) => location !== 'commandPalette' && menus[location].some((item) => item.command === 'git-graph-rs.filterByFile'));
		expect([...offering].sort()).toEqual(['editor/context', 'editor/title/context', 'explorer/context', 'scm/resourceState/context']);
	});
});

/* ---------- the automation catalog cross-check (migrated from contributedMenus.test.mjs) ---------- */

describe('the menu commands vs the automation catalog', () => {
	const commandActions: AutomationAction[] = CATALOG.filter((action) => action.vscodeCommand !== undefined);
	const timesCovered = new Map<string, number>();
	for (const action of commandActions) {
		timesCovered.set(action.vscodeCommand!.command, (timesCovered.get(action.vscodeCommand!.command) ?? 0) + 1);
	}

	it('exercises every menu command, and targets only commands VS Code can reach', () => {
		// Every command any menu offers has a catalog entry (the .zhCn twins run the same handler as
		// their base command, so the base id covers them).
		const menuCommands = new Set<string>();
		for (const location of menuLocations) {
			if (location === 'commandPalette') continue;
			for (const item of menus[location]) menuCommands.add(item.command.replace(/\.zhCn$/, ''));
		}
		for (const command of menuCommands) {
			expect(timesCovered.has(command), 'menu command "' + command + '" has no menu-vscode automation entry').toBe(true);
		}

		// Every catalog command action targets a command VS Code can actually reach — otherwise it
		// simulates a surface that does not exist. Reachable means: offered by any menu, or visible
		// in the command palette. Every command declared in contributes.commands shows in the palette
		// BY DEFAULT (VS Code lists them all unless a commandPalette entry hides it with `when:
		// 'false'`), so the palette side is modelled as "declared and not hidden" rather than the
		// literal commandPalette array (which only carries overrides).
		const paletteHidden = new Set(menus.commandPalette.filter((item) => (item.when ?? '') === 'false').map((item) => item.command.replace(/\.zhCn$/, '')));
		const reachable = new Set<string>(menuCommands);
		for (const command of contributed) {
			const base = command.replace(/\.zhCn$/, '');
			if (!paletteHidden.has(base)) reachable.add(base);
		}
		for (const action of commandActions) {
			expect(reachable.has(action.vscodeCommand!.command), action.id + ' executes "' + action.vscodeCommand!.command + '", which no menu offers and the palette hides').toBe(true);
		}
	});

	it('covers each filterByFile menu surface with the right argument shape, and clears the filter', () => {
		const filterEntries = commandActions.filter((action) => action.vscodeCommand!.command === 'git-graph-rs.filterByFile');
		expect(filterEntries.length, 'expected one filterByFile entry per menu surface').toBeGreaterThanOrEqual(4);
		expect(filterEntries.filter((action) => action.vscodeCommand!.arg?.kind === 'uri' && action.vscodeCommand!.arg.of === 'file').length,
			'the Explorer / Editor / Editor tab context menus need URI-shaped filterByFile entries').toBeGreaterThanOrEqual(3);
		expect(filterEntries.some((action) => action.vscodeCommand!.arg?.kind === 'resourceStates'),
			'the Source Control resource context menu needs a resourceStates-shaped filterByFile entry').toBe(true);
		for (const action of filterEntries) {
			expect(action.uiAfter !== undefined, action.id + ' must clear the file filter it sets (uiAfter)').toBe(true);
		}
	});

	it('passes the Source Control menus\' repository-root argument shape', () => {
		for (const command of ['git-graph-rs.view', 'git-graph-rs.amendLastCommit', 'git-graph-rs.gerritPushRef', 'git-graph-rs.gerritFetchCommitMsgHook', 'git-graph-rs.resetCurrentBranchToRemote']) {
			for (const action of commandActions.filter((entry) => entry.vscodeCommand!.command === command)) {
				expect(action.vscodeCommand!.arg, action.id + ' must pass the Source Control menu argument shape ({rootUri})').toEqual({ kind: 'rootUri' });
			}
		}
	});
});

/**
 * Coverage-matrix extractor (REFACTOR-PLAN §6.8.4, task 0.6): pulls the 8 dimensions of the
 * coverage matrix DIRECTLY from the repository sources — never hand-written — and cross-checks
 * each dimension against the automation catalog (src/extension/automation/catalog/**).
 *
 * Counting only: the script always exits 0 and never gates anything. It prints a summary to
 * stdout and optionally writes the matrix as JSON (`--json <out>`) and/or a markdown report
 * (`--md <out>`).
 *
 * The dimensions:
 *   1. contributed-commands — package.json `contributes.commands` ids plus every
 *      (menu location × command) pair from `contributes.menus`, with its `when` clause.
 *   2. settings — every key path from `contributes.configuration.properties`, recursing into
 *      nested `git-graph-rs.*` objects.
 *   3. protocol-requests — the request keys of the `GraphViewRequests` map in
 *      src/shared/protocol/graphView.ts (the `keyof` interface of `{ req; res }` entries).
 *   4. write-operations — exported op factories from src/extension/git/write/ops/*.ts
 *      (`export function <name>(...): WriteOp`).
 *   5. ui-port — the UiPort interface methods (src/extension/platform/uiPort.ts); the
 *      (file, method) call sites under src/extension are listed as supplementary information.
 *   6. webview-controls — the stable selector anchors of the webview: element ids declared in
 *      src/webview/graph/** (the project has no `data-action` attribute; element ids ARE the
 *      stable selector attribute the automation catalog drives, e.g. `#dialogAction`), plus the
 *      context-menu item definitions (the `title: strings.*` entries of actions/contextMenuActions.ts)
 *      and the dialog action functions of actions/dialogActions.ts.
 *   7. automation-catalog — the action entries under src/extension/automation/catalog/**: id, group, tags,
 *      drive modes (`ui` / `request` / `command` via `vscodeCommand`), whether a `verify` block
 *      exists. An entry counts as "covered" when it is machine-drivable (has at least one mode).
 *   8. ui-languages — the string-table keys of src/shared/i18n (en + zh-cn) and the
 *      package.nls*.json keys, each flagged with its en/zh-cn presence; "covered" means the
 *      key (or one of its interface-language values) is referenced by at least one catalog entry.
 *
 * Cross-check rule (per dimension): an item is `covered` when some catalog entry references it —
 * matched by id, command name, tag or literal string as appropriate. Everything the catalog does
 * not reach lands in `uncovered`. All 8 dimensions share one literal table built from the
 * catalog sources, so a catalog `bi('Add Tag…', '添加标签…')` step covers both interface
 * languages of the matching context-menu item.
 *
 * The extraction logic lives in exported pure functions (fixtures in, lists out) so
 * tests/coverageMatrix.test.mjs can exercise every dimension hermetically; the CLI at the
 * bottom is a thin wrapper over them. The module works both as `node scripts/dev/coverage-matrix.mjs`
 * and as an `import()`ed library.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

/** Escape a literal string for embedding into a RegExp. */
export function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a source text or pass an already-parsed object through. */
function parseIfString(value) {
	return typeof value === 'string' ? JSON.parse(value) : value;
}

/** First capture group of a regex over a text, or a fallback. */
function firstMatch(text, regexp, fallback = '') {
	const match = text.match(regexp);
	return match === null ? fallback : match[1];
}

/** All capture-group-1 matches of a global regex over a text. */
function allMatches(text, regexp) {
	return [...text.matchAll(regexp)].map((match) => match[1]);
}

/** Read a UTF-8 file. */
function readFile(file) {
	return fs.readFileSync(file, 'utf8');
}

/**
 * Collect the quoted string literals of a text into a Set (catalog side of the cross-check).
 * `\'` escapes are normalized to `'` on both sides so i18n values compare equal to catalog
 * literals.
 */
export function collectStringLiterals(text) {
	const literals = new Set();
	for (const match of text.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
		literals.add(match[1].replace(/\\'/g, "'"));
	}
	return literals;
}

/** Word-boundary containment of `needle` in `haystack` (identifier-style fallback match). */
export function containsWord(haystack, needle) {
	return new RegExp('\\b' + escapeRegExp(needle) + '\\b').test(haystack);
}

/* ------------------------------------------------------------------ */
/* Dimension 1: contributed commands and menu locations                */
/* ------------------------------------------------------------------ */

/**
 * Extract the contributed command ids and every (menu location × command) pair with its `when`
 * clause from a parsed (or textual) package.json.
 */
export function extractCommands(pkg) {
	const manifest = parseIfString(pkg);
	const contributes = manifest.contributes || {};
	const commands = (contributes.commands || []).map((entry) => ({ id: entry.command }));
	const menuItems = [];
	for (const [menu, items] of Object.entries(contributes.menus || {})) {
		for (const item of items) {
			menuItems.push({ id: menu + '::' + item.command, menu, command: item.command, when: item.when || '' });
		}
	}
	return { commands, menuItems };
}

/* ------------------------------------------------------------------ */
/* Dimension 2: configuration key paths                                */
/* ------------------------------------------------------------------ */

/**
 * Extract every configuration key path from `contributes.configuration.properties`, recursing
 * into nested `properties` objects (e.g. `git-graph-rs.contextMenuActionsVisibility.branch.checkout`).
 */
export function extractSettings(pkg) {
	const manifest = parseIfString(pkg);
	const properties = ((manifest.contributes || {}).configuration || {}).properties || {};
	const keys = [];
	const walk = (node, prefix) => {
		for (const [key, value] of Object.entries(node)) {
			const keyPath = prefix === '' ? key : prefix + '.' + key;
			keys.push({ id: keyPath });
			if (value !== null && typeof value === 'object' && value.properties) {
				walk(value.properties, keyPath);
			}
		}
	};
	walk(properties, '');
	return keys;
}

/* ------------------------------------------------------------------ */
/* Dimension 3: protocol request commands                              */
/* ------------------------------------------------------------------ */

/**
 * Extract the request keys of the `GraphViewRequests` map (an interface whose members are
 * `{ readonly req; readonly res }` entries, taken as `keyof`).
 */
export function extractProtocolRequests(sourceText) {
	const block = sourceText.match(/export interface GraphViewRequests \{([\s\S]*?)\n\}/);
	if (block === null) return [];
	return allMatches(block[1], /\n\t(?:readonly )?(\w+): \{ readonly req:/g).map((name) => ({ id: name }));
}

/* ------------------------------------------------------------------ */
/* Dimension 4: write-op factories                                     */
/* ------------------------------------------------------------------ */

/**
 * Extract the exported op factory functions (`export function <name>(...): WriteOp`) from the
 * given write/ops source files. Non-op exports (helpers like `single`) have a different return
 * type and are excluded by the annotation.
 */
export function extractWriteOps(files) {
	const ops = [];
	for (const file of files) {
		const pattern = /export function (\w+)\((?:(?!export function)[\s\S])*?\): WriteOp\b/g;
		for (const match of file.text.matchAll(pattern)) {
			ops.push({ id: match[1], file: file.path });
		}
	}
	return ops;
}

/* ------------------------------------------------------------------ */
/* Dimension 5: UiPort methods and call sites                          */
/* ------------------------------------------------------------------ */

/**
 * Extract the method names of the `UiPort` interface (overloads deduplicated, declaration
 * order preserved).
 */
export function extractUiPortMethods(sourceText) {
	const block = sourceText.match(/export interface UiPort(?: extends \w+)? \{([\s\S]*?)\n\}/);
	if (block === null) return [];
	const methods = [];
	for (const match of block[1].matchAll(/^\t(\w+)(?:<|\()/gm)) {
		if (!methods.includes(match[1])) methods.push(match[1]);
	}
	return methods.map((name) => ({ id: name }));
}

/**
 * List the (file, method) UiPort call sites: every `ctx.ui.<method>(`-style call (any
 * `<something>.ui.<method>(` receiver) under the given extension files, restricted to the
 * methods the interface actually declares. Importers of `platform/uiPort` are reported too.
 */
export function findUiPortCallSites(files, methods) {
	const known = new Set(methods.map((method) => method.id));
	const callSites = [];
	const importers = [];
	for (const file of files) {
		if (/from ['"][^'"]*platform\/uiPort['"]/.test(file.text)) importers.push(file.path);
		for (const match of file.text.matchAll(/\.ui\.(\w+)\s*\(/g)) {
			if (!known.has(match[1])) continue;
			const pair = { file: file.path, method: match[1] };
			if (!callSites.some((site) => site.file === pair.file && site.method === pair.method)) {
				callSites.push(pair);
			}
		}
	}
	return { callSites, importers };
}

/** Catalog aliases: a catalog flag/literal that implies a UiPort method is driven. */
const UIPORT_COVERAGE_ALIASES = {
	showSaveDialog: ['nativeSaveDialog'],
	showOpenDialog: []
};

/** A UiPort method is covered when a catalog entry names it (or a declared alias). */
export function uiPortMethodIsCovered(method, literals, catalogText) {
	if (literals.has(method) || containsWord(catalogText, method)) return true;
	for (const alias of UIPORT_COVERAGE_ALIASES[method] || []) {
		if (literals.has(alias) || containsWord(catalogText, alias)) return true;
	}
	return false;
}

/* ------------------------------------------------------------------ */
/* Dimension 6: webview controls                                       */
/* ------------------------------------------------------------------ */

/**
 * Extract the webview's stable control anchors from the given src/webview/graph source files:
 *   - element ids (static `id="x"` / `elem.id = 'x'`, plus dynamic `id="prefix${n}"` collapsed
 *     to `prefix*`),
 *   - context-menu item definitions (`title: strings.<key>` in *contextMenuActions.ts),
 *   - dialog action functions (`export function <name>Action(` under /actions/).
 * Test files are ignored.
 */
export function extractWebviewControls(files) {
	const staticIds = [];
	const dynamicPrefixes = [];
	const contextMenuItems = [];
	const dialogActions = [];
	const seenStatic = new Set();
	const seenDynamic = new Set();
	const seenMenu = new Set();
	const seenAction = new Set();

	for (const file of files) {
		if (/\.test\.[cm]?[jt]s$/.test(file.path)) continue;
		// Dynamic ids first: `id="prefix${n}"`, `id="prefix' + n + '"` and `elem.id = 'prefix' + n`
		// collapse to a `prefix*` anchor. A static-looking match inside a dynamic span (e.g.
		// `elem.id = 'option'` of `elem.id = 'option' + n`) must not also register.
		const dynamicMatches = [...file.text.matchAll(
			/\bid=["']([A-Za-z][\w-]*)\$\{|\bid=["']([A-Za-z][\w-]*)["']?\s*\+|\.id\s*=\s*["']?([A-Za-z][\w-]*)["']?\s*\+/g
		)];
		const dynamicRanges = dynamicMatches.map((match) => [match.index, match.index + match[0].length]);
		const inDynamicRange = (index) => dynamicRanges.some(([start, end]) => index >= start && index < end);
		for (const match of dynamicMatches) {
			const prefix = (match[1] || match[2] || match[3]) + '*';
			if (!seenDynamic.has(prefix)) {
				seenDynamic.add(prefix);
				dynamicPrefixes.push({ id: 'element:' + prefix });
			}
		}
		for (const match of file.text.matchAll(/\bid=(["'])([A-Za-z][\w-]*)\1|\.id\s*=\s*(["'])([A-Za-z][\w-]*)\3/g)) {
			if (inDynamicRange(match.index)) continue;
			const id = match[2] || match[4];
			if (!seenStatic.has(id)) {
				seenStatic.add(id);
				staticIds.push({ id: 'element:' + id });
			}
		}
		if (/contextMenuActions\.ts$/.test(file.path)) {
			for (const match of file.text.matchAll(/\btitle: strings\.(\w+)/g)) {
				if (!seenMenu.has(match[1])) {
					seenMenu.add(match[1]);
					contextMenuItems.push({ id: 'contextMenu:' + match[1], key: match[1] });
				}
			}
		}
		if (file.path.includes('/actions/') || file.path.includes('\\actions\\')) {
			for (const match of file.text.matchAll(/export function (\w*Action)\(/g)) {
				if (!seenAction.has(match[1])) {
					seenAction.add(match[1]);
					dialogActions.push({ id: 'dialogAction:' + match[1] });
				}
			}
		}
	}
	return { elements: [...staticIds, ...dynamicPrefixes], contextMenuItems, dialogActions };
}

/**
 * A webview control is covered when the catalog references it:
 *   - element `foo` → the `#foo` selector (or the bare id) among the catalog literals; a
 *     dynamic prefix `foo*` matches `#foo<digits>`;
 *   - context-menu item `strings.<key>` → the key, or its en/zh-cn value (optionally with the
 *     trailing ellipsis the menu labels carry) among the catalog literals — the catalog's
 *     `bi(en, zh)` menu-item steps match by visible text;
 *   - dialog action `name` → the name as a word in the catalog text.
 */
export function webviewControlIsCovered(control, literals, catalogText, i18nValues) {
	const id = control.id;
	if (id.startsWith('element:')) {
		const elementId = id.slice('element:'.length);
		if (elementId.endsWith('*')) {
			const pattern = new RegExp('#' + escapeRegExp(elementId.slice(0, -1)) + '\\d*\\b');
			if (pattern.test(catalogText)) return true;
		}
		return literals.has('#' + elementId) || literals.has(elementId) || containsWord(catalogText, elementId);
	}
	if (id.startsWith('contextMenu:')) {
		if (literals.has(control.key) || containsWord(catalogText, control.key)) return true;
		const values = (i18nValues || {}).get ? (i18nValues.get(control.key) || []) : [];
		for (const value of values) {
			if (value !== '' && (literals.has(value) || literals.has(value + '…'))) return true;
		}
		return false;
	}
	if (id.startsWith('dialogAction:')) {
		return containsWord(catalogText, id.slice('dialogAction:'.length));
	}
	return false;
}

/* ------------------------------------------------------------------ */
/* Dimension 7: automation catalog entries                             */
/* ------------------------------------------------------------------ */

/** The catalog files that carry no live entries (pure types / shared helpers / the frozen snapshot). */
export const CATALOG_NON_ENTRY_FILES = new Set(['types.ts', 'helpers.ts', 'snapshot.ts']);

/**
 * Extract the automation action entries from the given catalog source files. Each entry starts
 * at a two-tab-indented `id: '<group>/<name>'` line; its body runs to the next such id or to
 * the closing of the enclosing array. Comments are stripped before field matching so prose
 * cannot invent drive modes; the raw text of the files is what the other dimensions'
 * cross-checks match against.
 */
export function extractCatalogEntries(files) {
	const entries = [];
	for (const file of files) {
		const text = file.text;
		const startPattern = /^\t\tid: '([^']+)'/gm;
		const starts = [];
		let match;
		while ((match = startPattern.exec(text)) !== null) {
			starts.push({ id: match[1], index: match.index });
		}
		for (let i = 0; i < starts.length; i++) {
			const bodyStart = starts[i].index;
			const nextStart = i + 1 < starts.length ? starts[i + 1].index : text.length;
			const arrayEnd = text.indexOf('\n\t]', bodyStart);
			const bodyEnd = arrayEnd !== -1 && arrayEnd < nextStart ? arrayEnd : nextStart;
			const body = text.slice(bodyStart, bodyEnd);
			entries.push({ file: file.path, ...parseCatalogEntryBody(starts[i].id, body) });
		}
	}
	return entries;
}

/** Parse one entry body (from its `id:` line to the entry's closing brace). */
function parseCatalogEntryBody(id, body) {
	const withoutComments = body
		.split('\n')
		.map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
		.join('\n');
	const tags = firstMatch(withoutComments, /\btags: \[([^\]]*)\]/, '')
		.split(',')
		.map((tag) => tag.trim().replace(/^['"]|['"]$/g, ''))
		.filter((tag) => tag !== '');
	const requires = firstMatch(withoutComments, /\brequires: \[([^\]]*)\]/, '')
		.split(',')
		.map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
		.filter((entry) => entry !== '');
	const modes = [];
	if (/\bui:/.test(withoutComments)) modes.push('ui');
	if (/\brequest:/.test(withoutComments)) modes.push('request');
	if (/\bvscodeCommand:/.test(withoutComments)) modes.push('command');
	return {
		id,
		title: firstMatch(withoutComments, /\btitle: '([^']*)'/),
		group: firstMatch(withoutComments, /\bgroup: '([^']*)'/),
		tags,
		modes,
		mutable: /\bmutable: true\b/.test(withoutComments),
		requires,
		nativeSaveDialog: /\bnativeSaveDialog: true\b/.test(withoutComments),
		hasVerify: /\bverify:\s*\{/.test(withoutComments),
		hasExpect: /\bexpect:\s*\{/.test(withoutComments)
	};
}

/* ------------------------------------------------------------------ */
/* Dimension 8: UI languages                                           */
/* ------------------------------------------------------------------ */

/**
 * Extract the string-table keys of the i18n dictionaries (`export const STRINGS_* = { ... }`
 * objects, one literal per key) and report the en/zh-cn presence of every key of their union.
 */
export function extractI18nKeys(enText, zhText) {
	const extract = (text) => {
		// The object may be terminated by `};` or by `} satisfies SharedStrings;` (zh-cn.ts).
		const block = text.match(/export const STRINGS_\w+ = \{([\s\S]*?)\n\}(?![\w:])/);
		return block === null ? [] : allMatches(block[1], /\n\t([A-Za-z0-9_]+):/g);
	};
	const enKeys = extract(enText);
	const zhKeys = extract(zhText);
	const enSet = new Set(enKeys);
	const zhSet = new Set(zhKeys);
	const union = [...enKeys];
	for (const key of zhKeys) {
		if (!enSet.has(key)) union.push(key);
	}
	const items = union.map((key) => ({ id: 'i18n:' + key, inEn: enSet.has(key), inZh: zhSet.has(key) }));
	return { items, onlyInEn: enKeys.filter((key) => !zhSet.has(key)), onlyInZh: zhKeys.filter((key) => !enSet.has(key)) };
}

/**
 * Extract the package.nls*.json keys with en/zh-cn presence (same shape as the i18n keys).
 */
export function extractNlsKeys(enNls, zhNls) {
	const enKeys = Object.keys(parseIfString(enNls));
	const zhKeys = Object.keys(parseIfString(zhNls));
	const enSet = new Set(enKeys);
	const zhSet = new Set(zhKeys);
	const union = [...enKeys];
	for (const key of zhKeys) {
		if (!enSet.has(key)) union.push(key);
	}
	const items = union.map((key) => ({ id: 'nls:' + key, inEn: enSet.has(key), inZh: zhSet.has(key) }));
	return { items, onlyInEn: enKeys.filter((key) => !zhSet.has(key)), onlyInZh: zhKeys.filter((key) => !enSet.has(key)) };
}

/**
 * The per-key values of an i18n dictionary, for literal matching against the catalog
 * (`bi(en, zh)` steps carry both interface languages). Multi-template values are kept as
 * written; a value that fails to parse as one literal simply contributes nothing.
 */
export function extractI18nValues(sourceText) {
	const block = sourceText.match(/export const STRINGS_\w+ = \{([\s\S]*?)\n\}(?![\w:])/);
	const values = new Map();
	if (block === null) return values;
	for (const match of block[1].matchAll(/\n\t([A-Za-z0-9_]+): '((?:[^'\\\n]|\\.)*)'/g)) {
		const value = match[2].replace(/\\'/g, "'").replace(/\\n/g, '\n');
		if (!values.has(match[1])) values.set(match[1], []);
		values.get(match[1]).push(value);
	}
	return values;
}

/**
 * A language item is covered when the catalog references it: the key itself (i18n), the
 * key-or-value of a table entry, or — for nls keys — the command/configuration key path the
 * `%...%` placeholder wraps (e.g. `command.git-graph-rs.fetch.title` → `git-graph-rs.fetch`).
 */
export function languageItemIsCovered(item, literals, catalogText, i18nValues) {
	if (item.id.startsWith('i18n:')) {
		const key = item.id.slice('i18n:'.length);
		if (literals.has(key) || containsWord(catalogText, key)) return true;
		const values = i18nValues.get(key) || [];
		return values.some((value) => value !== '' && (literals.has(value) || literals.has(value + '…')));
	}
	const key = item.id.slice('nls:'.length);
	const candidates = [key];
	for (const prefix of ['command.', 'config.']) {
		if (key.startsWith(prefix)) {
			candidates.push(key.slice(prefix.length).replace(/\.(title|description)$/, ''));
		}
	}
	return candidates.some((candidate) => literals.has(candidate) || containsWord(catalogText, candidate));
}

/* ------------------------------------------------------------------ */
/* Cross-check and matrix assembly                                     */
/* ------------------------------------------------------------------ */

/** Partition pre-shaped items into the { total, covered, uncovered } cell of one dimension. */
export function crossCheck(items, isCovered) {
	const uncovered = [];
	let covered = 0;
	for (const item of items) {
		if (isCovered(item)) {
			covered++;
		} else {
			uncovered.push(item.id);
		}
	}
	return { total: items.length, covered, uncovered };
}

/** Assemble the full matrix object from the extracted, already-partitioned dimensions. */
export function buildMatrix(cells) {
	const dimensions = {};
	for (const [name, cell] of Object.entries(cells)) {
		dimensions[name] = { total: cell.total, covered: cell.covered, uncovered: cell.uncovered };
	}
	return dimensions;
}

/** Render the markdown report: the summary table plus per-dimension uncovered samples. */
export function renderMarkdown(dimensions, meta) {
	const lines = [];
	lines.push('# Coverage matrix (auto-extracted)');
	lines.push('');
	lines.push(meta && meta.generated ? 'Generated ' + meta.generated + ' from the repository sources by `scripts/dev/coverage-matrix.mjs` — counting only, never a gate.' : 'Generated by `scripts/dev/coverage-matrix.mjs` — counting only, never a gate.');
	lines.push('');
	lines.push('| Dimension | Total | Covered | Uncovered |');
	lines.push('| --- | ---: | ---: | ---: |');
	for (const [name, cell] of Object.entries(dimensions)) {
		lines.push('| ' + name + ' | ' + cell.total + ' | ' + cell.covered + ' | ' + cell.uncovered.length + ' |');
	}
	lines.push('');
	for (const [name, cell] of Object.entries(dimensions)) {
		if (cell.uncovered.length === 0) continue;
		const sample = cell.uncovered.slice(0, 10);
		const suffix = cell.uncovered.length > sample.length ? ' … and ' + (cell.uncovered.length - sample.length) + ' more' : '';
		lines.push('### ' + name + ' — ' + cell.uncovered.length + ' uncovered');
		lines.push('');
		lines.push('`' + sample.join('`, `') + '`' + suffix);
		lines.push('');
	}
	return lines.join('\n');
}

/** The stdout summary lines for one matrix. */
export function renderSummary(dimensions) {
	const lines = [];
	for (const [name, cell] of Object.entries(dimensions)) {
		lines.push('  ' + name.padEnd(22) + ' ' + String(cell.covered).padStart(5) + ' / ' + String(cell.total).padEnd(5) + ' covered (' + cell.uncovered.length + ' uncovered)');
	}
	return lines;
}

/* ------------------------------------------------------------------ */
/* CLI wrapper over the pure extractors                                */
/* ------------------------------------------------------------------ */

/** Recursively list files under a directory (relative to it), filtered by suffix. */
function listFiles(root, relative, suffixes, exclusions = []) {
	const absolute = path.join(root, relative);
	if (!fs.existsSync(absolute)) return [];
	const base = relative.replaceAll('\\', '/');
	return fs.readdirSync(absolute, { recursive: true })
		.filter((entry) => suffixes.some((suffix) => entry.endsWith(suffix)))
		.filter((entry) => !exclusions.some((exclusion) => entry.replaceAll('\\', '/').includes(exclusion)))
		.filter((entry) => !entry.replaceAll('\\', '/').split('/').pop().startsWith('.'))
		.sort()
		.map((entry) => ({ path: base + '/' + entry.replaceAll('\\', '/'), text: readFile(path.join(absolute, entry)) }));
}

/** Extract everything from a repository root and return { dimensions, facts }. */
export function extractFromRepo(root) {
	const pkg = readFile(path.join(root, 'package.json'));
	const protocolText = readFile(path.join(root, 'src', 'shared', 'protocol', 'graphView.ts'));
	const uiPortText = readFile(path.join(root, 'src', 'extension', 'platform', 'uiPort.ts'));
	const enText = readFile(path.join(root, 'src', 'shared', 'i18n', 'en.ts'));
	const zhText = readFile(path.join(root, 'src', 'shared', 'i18n', 'zh-cn.ts'));
	const enNls = readFile(path.join(root, 'package.nls.json'));
	const zhNls = readFile(path.join(root, 'package.nls.zh-cn.json'));

	const opsFiles = listFiles(root, path.join('src', 'extension', 'git', 'write', 'ops'), ['.ts'], ['.test.'])
		.map((file) => ({ ...file, path: 'src/extension/git/write/ops/' + path.basename(file.path) }));
	const extensionFiles = listFiles(root, path.join('src', 'extension'), ['.ts'], ['.test.']);
	const webviewFiles = listFiles(root, path.join('src', 'webview', 'graph'), ['.ts'], ['.test.']);

	const catalogDir = path.join(root, 'src', 'extension', 'automation', 'catalog');
	const catalogFiles = fs.existsSync(catalogDir)
		? fs.readdirSync(catalogDir)
			.filter((entry) => entry.endsWith('.ts') && !CATALOG_NON_ENTRY_FILES.has(entry))
			.sort()
			.map((entry) => ({ path: 'src/extension/automation/catalog/' + entry, text: readFile(path.join(catalogDir, entry)) }))
		: [];
	const helpersText = fs.existsSync(path.join(catalogDir, 'helpers.ts'))
		? readFile(path.join(catalogDir, 'helpers.ts'))
		: '';
	const catalogText = catalogFiles.map((file) => file.text).join('\n') + '\n' + helpersText;
	const catalogLiterals = collectStringLiterals(catalogText);

	const { commands, menuItems } = extractCommands(pkg);
	const settings = extractSettings(pkg);
	const protocolRequests = extractProtocolRequests(protocolText);
	const writeOps = extractWriteOps(opsFiles);
	const uiPortMethods = extractUiPortMethods(uiPortText);
	const { callSites, importers } = findUiPortCallSites(extensionFiles, uiPortMethods);
	const webview = extractWebviewControls(webviewFiles);
	const catalogEntries = extractCatalogEntries(catalogFiles);
	const i18n = extractI18nKeys(enText, zhText);
	const nls = extractNlsKeys(enNls, zhNls);
	const i18nValues = extractI18nValues(enText);

	const isCatalogCommand = (id) => catalogLiterals.has(id) || containsWord(catalogText, id);
	const commandsCell = crossCheck(commands, (command) => isCatalogCommand(command.id));
	const menuItemsCell = crossCheck(menuItems, (item) => isCatalogCommand(item.command));
	const settingsCell = crossCheck(settings, (setting) => {
		const unprefixed = setting.id.startsWith('git-graph-rs.') ? setting.id.slice('git-graph-rs.'.length) : setting.id;
		return catalogLiterals.has(setting.id) || catalogLiterals.has(unprefixed) || containsWord(catalogText, unprefixed);
	});
	const protocolCell = crossCheck(protocolRequests, (request) => catalogLiterals.has(request.id) || containsWord(catalogText, request.id));
	const opsCell = crossCheck(writeOps, (op) => catalogLiterals.has(op.id) || containsWord(catalogText, op.id));
	const uiPortCell = crossCheck(uiPortMethods, (method) => uiPortMethodIsCovered(method.id, catalogLiterals, catalogText));
	const webviewItems = [...webview.elements, ...webview.contextMenuItems, ...webview.dialogActions];
	const webviewCell = crossCheck(webviewItems, (control) => webviewControlIsCovered(control, catalogLiterals, catalogText, i18nValues));
	const catalogCell = crossCheck(catalogEntries, (entry) => entry.modes.length > 0);
	const languageItems = [...i18n.items, ...nls.items];
	const languageCell = crossCheck(languageItems, (item) => languageItemIsCovered(item, catalogLiterals, catalogText, i18nValues));

	const dimensions = buildMatrix({
		'contributed-commands': commandsCell,
		'command-menu-items': menuItemsCell,
		'settings': settingsCell,
		'protocol-requests': protocolCell,
		'write-operations': opsCell,
		'ui-port': uiPortCell,
		'webview-controls': webviewCell,
		'automation-catalog': catalogCell,
		'ui-languages': languageCell
	});

	const entriesWithVerify = catalogEntries.filter((entry) => entry.hasVerify).length;
	const nativeSaveDialogEntries = catalogEntries.filter((entry) => entry.nativeSaveDialog).length;
	const facts = {
		callSites,
		importers,
		i18nOnlyInEn: i18n.onlyInEn,
		i18nOnlyInZh: i18n.onlyInZh,
		nlsOnlyInEn: nls.onlyInEn,
		nlsOnlyInZh: nls.onlyInZh,
		entriesWithVerify,
		nativeSaveDialogEntries,
		groups: [...new Set(catalogEntries.map((entry) => entry.group))].sort()
	};

	return { dimensions, facts };
}

/** Print the human-readable summary (matrix + supplementary facts) to stdout. */
export function printSummary(dimensions, facts) {
	console.log('Coverage matrix (counting only — never a gate):');
	for (const line of renderSummary(dimensions)) console.log(line);
	if (facts) {
		console.log('');
		console.log('  catalog entries with a verify block : ' + facts.entriesWithVerify);
		console.log('  catalog entries w/ native save dlg  : ' + facts.nativeSaveDialogEntries);
		console.log('  catalog groups                      : ' + facts.groups.join(', '));
		console.log('  UiPort importers                    : ' + (facts.importers.length === 0 ? '(none)' : facts.importers.join(', ')));
		console.log('  UiPort call sites (file × method)   : ' + facts.callSites.length);
		for (const site of facts.callSites) console.log('    ' + site.file + ' :: ' + site.method);
		console.log('  i18n keys only in en                : ' + facts.i18nOnlyInEn.length + (facts.i18nOnlyInEn.length ? ' (' + facts.i18nOnlyInEn.join(', ') + ')' : ''));
		console.log('  i18n keys only in zh-cn             : ' + facts.i18nOnlyInZh.length + (facts.i18nOnlyInZh.length ? ' (' + facts.i18nOnlyInZh.join(', ') + ')' : ''));
		console.log('  nls keys only in en                 : ' + facts.nlsOnlyInEn.length);
		console.log('  nls keys only in zh-cn              : ' + facts.nlsOnlyInZh.length);
	}
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--json' && argv[i + 1]) {
			options.json = argv[++i];
		} else if (argv[i] === '--md' && argv[i + 1]) {
			options.md = argv[++i];
		}
	}
	return options;
}

export function main(argv = process.argv.slice(2)) {
	// Counting only: report problems, but always exit 0.
	try {
		const options = parseArgs(argv);
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
		const { dimensions, facts } = extractFromRepo(root);
		printSummary(dimensions, facts);
		if (options.json) {
			fs.writeFileSync(options.json, JSON.stringify(dimensions, null, '\t') + '\n');
			console.log('');
			console.log('Matrix JSON written to ' + options.json);
		}
		if (options.md) {
			fs.writeFileSync(options.md, renderMarkdown(dimensions, { generated: new Date().toISOString() }) + '\n');
			console.log('Markdown report written to ' + options.md);
		}
	} catch (error) {
		console.error('coverage-matrix: extraction failed:', error && error.message ? error.message : error);
	}
	process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main();
}

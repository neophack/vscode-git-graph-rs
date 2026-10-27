import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The configuration model's contract tests (OPTIMIZATION-PLAN A4):
 *
 * - the schema table is the ONE checked-in mirror of package.json#contributes.configuration, and
 *   the parity tests are anchored to the manifest itself, in BOTH directions: a newly
 *   contributed setting without a schema row (or with a drifted type/default) fails here rather
 *   than silently reading `undefined` at runtime, and a row whose key stops being contributed
 *   fails too;
 * - the snapshot answers the manifest default for every unset setting (with the one declared
 *   host-aware exception), lets explicit values through, and follows changes;
 * - the deprecated-key migrations keep the precedence modern > deprecated > default;
 * - the cooked views (the webview-model shapes derived from a snapshot) preserve the exact
 *   normalisations the former per-key getters applied.
 *
 * The workspace fakes are plain maps - the whole point of the structural injection is that no
 * vscode is needed to test this module. The one real-vscode read (the `git.path` setting behind
 * gitPathsOf) is tested through an injected workspace as well.
 */

const vscodeMock = vi.hoisted(() => ({
	env: { language: 'en', uriScheme: 'vscode' },
	// The real ViewColumn values: cooked.ts's editor-group mapping reads them at module load.
	ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	// The legacy shim scopes the repo-scoped read through Uri.file (like the old reader did).
	Uri: { file: (p: string) => ({ fsPath: p }) },
	// Assigned by the legacy-shim suite (the real module surface the shim reads through).
	workspace: undefined as unknown
}));

vi.mock('vscode', () => vscodeMock);

import {
	CommitDetailsViewLocation, CommitOrdering, DateFormatType, DateType, FileViewType, GraphStyle, RepoDropdownOrder,
	SquashMessageFormat, TabIconColourTheme, TagType
} from '../../../shared/model/webview';
import { GitResetMode } from '../../../shared/model/git';
import {
	CONFIG_MIGRATIONS, CONFIG_SCHEMA, CONFIG_SECTION, ConfigurationChangeEventLike, ConfigurationReader,
	ConfigSnapshot, DisposableLike, ObservableWorkspaceLike, SnapshotField, WorkspaceLike, commitAuthorsOf,
	commitDetailsViewOf, commitOrderingOf, contextMenuActionsVisibilityOf, customBranchGlobPatternsOf,
	customEmojiShortcodeMappingsOf, customPullRequestProvidersOf, dateFormatOf, dateTypeOf, defaultColumnVisibilityOf,
	dialogDefaultsOf, gerritOf, gitPathsOf, graphOf, interfaceLanguageSettingOf, keybindingsOf, muteCommitsOf,
	cookConfig, onConfigChange, onRepoLoadOf, readWithMigrations, referenceLabelsOf, repoDropdownOrderOf,
	resolvedInterfaceLanguage, squashMessageFormatOf, tabIconColourThemeOf, takeSnapshot, viewColumnOfEditorGroup
} from './index';

// --------------------------------------------------------------------------------------
// The manifest anchor and the workspace double
// --------------------------------------------------------------------------------------

interface ManifestSetting {
	readonly type?: string;
	readonly enum?: string[];
	readonly default?: unknown;
	readonly deprecationMessage?: string;
	readonly markdownDeprecationMessage?: string;
}

interface Manifest {
	readonly contributes: {
		readonly configuration: {
			readonly properties: Readonly<Record<string, ManifestSetting>>;
		};
	};
}

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

function readManifest(): Manifest {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Manifest;
}

/** The contributed settings, as `[full key, declaration]` pairs in manifest order. */
function contributedProperties(): ReadonlyArray<[string, ManifestSetting]> {
	return Object.entries(readManifest().contributes.configuration.properties);
}

/** The dotted key of a contributed setting, without the `git-graph-rs.` prefix. */
function withoutSection(fullKey: string): string {
	return fullKey.substring(CONFIG_SECTION.length + 1);
}

/** The snapshot field name of a dotted setting key (camelCase join; mirrors the interface). */
function fieldOf(key: string): string {
	return key.split('.').map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** The manifest's declared type, normalised the way the schema table normalises it. */
function typeOf(setting: ManifestSetting): string {
	return setting.type === 'integer' ? 'number' : setting.type as string;
}

/** View a snapshot as its field map (the interface has no index signature by design). */
function asFieldMap(snapshot: ConfigSnapshot): Record<string, unknown> {
	return snapshot as unknown as Record<string, unknown>;
}

/** A workspace answering every section from one plain map of dotted-key -> value. */
class FakeWorkspace implements WorkspaceLike {
	private readonly listeners: Array<(event: ConfigurationChangeEventLike) => void> = [];
	private readonly values: Map<string, unknown>;

	constructor(values: Record<string, unknown> = {}) {
		this.values = new Map(Object.entries(values));
	}

	public getConfiguration(_section?: string): FakeConfiguration {
		return new FakeConfiguration(this.values);
	}

	public setValue(key: string, value: unknown): void {
		this.values.set(key, value);
	}

	public onDidChangeConfiguration(listener: (event: ConfigurationChangeEventLike) => void): DisposableLike {
		this.listeners.push(listener);
		return {
			dispose: () => {
				const index = this.listeners.indexOf(listener);
				if (index >= 0) this.listeners.splice(index, 1);
			}
		};
	}

	public emit(event: ConfigurationChangeEventLike): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

/** The `vscode.WorkspaceConfiguration` stand-in one FakeWorkspace answers with. */
class FakeConfiguration {
	constructor(private readonly values: Map<string, unknown>) { }

	public get<T>(section: string, defaultValue?: T): T | undefined {
		const value = this.values.get(section);
		return value !== undefined ? value as T : defaultValue;
	}
}

function affecting(relevant: boolean): ConfigurationChangeEventLike {
	return { affectsConfiguration: (section: string) => relevant && section === CONFIG_SECTION };
}

// --------------------------------------------------------------------------------------
// Schema <-> manifest parity (both directions)
// --------------------------------------------------------------------------------------

describe('schema <-> manifest parity (both directions)', () => {
	it('has a row for every contributed setting, with the manifest key, type and default', () => {
		const properties = contributedProperties();
		expect(properties.length).toBeGreaterThan(90);
		const rows = new Set<string>();
		for (const [fullKey, setting] of properties) {
			const field = fieldOf(withoutSection(fullKey));
			const row: unknown = CONFIG_SCHEMA[field as SnapshotField];
			expect(row, 'missing schema row for ' + fullKey).toBeDefined();
			const typed = row as { key: string; type: string; default: unknown };
			expect(typed.key, 'schema row of ' + fullKey + ' carries the wrong dotted key').toBe(withoutSection(fullKey));
			expect(typed.type, 'schema row of ' + fullKey + ' carries the wrong type').toBe(typeOf(setting));
			expect(typed.default, 'schema row of ' + fullKey + ' carries the wrong default').toEqual(setting.default);
			rows.add(field);
		}
		expect(rows.size).toBe(properties.length);
	});

	it('has no row whose setting stopped being contributed', () => {
		const contributedFields = new Set(contributedProperties().map(([fullKey]) => fieldOf(withoutSection(fullKey))));
		for (const field of Object.keys(CONFIG_SCHEMA)) {
			expect(contributedFields.has(field), 'schema row "' + field + '" has no contributed setting').toBe(true);
		}
	});

	it('types every row against the ConfigSnapshot interface (so a row default cannot drift from its field)', () => {
		// Compile-time enforced by CONFIG_SCHEMA's `{ [K in SnapshotField]: SchemaRow<K> }` shape;
		// asserted here as the row-count contract the parity tests above rely on.
		expect(Object.keys(CONFIG_SCHEMA).length).toBe(contributedProperties().length);
	});
});

// --------------------------------------------------------------------------------------
// The snapshot
// --------------------------------------------------------------------------------------

describe('takeSnapshot', () => {
	it('answers the package.json default for every setting of an empty workspace', () => {
		const snapshot = asFieldMap(takeSnapshot(new FakeWorkspace()));
		const expected: Record<string, unknown> = {};
		for (const [fullKey, setting] of contributedProperties()) {
			const field = fieldOf(withoutSection(fullKey));
			if (expected[field] !== undefined) throw new Error('field name collision for key ' + fullKey);
			expected[field] = setting.default;
		}
		expect(Object.keys(snapshot).length).toBe(Object.keys(expected).length);
		// The one declared divergence (the host-aware mobileAdaptation default) agrees with the
		// manifest under the VS Code mock this suite runs under - see the mobileAdaptation test.
		expect(snapshot).toEqual(expected);
	});

	it('lets explicit values through (a sample across sections)', () => {
		const snapshot = takeSnapshot(new FakeWorkspace({
			'enableLog': true,
			'graph.fontSize': 20,
			'interfaceLanguage': 'zh-cn',
			'repository.commits.initialLoad': 500,
			'dialog.resetCurrentBranchToCommit.mode': 'Hard',
			'gerrit.remote': 'upstream',
			'commitDetailsView.fileView.type': 'File List',
			'repository.onLoad.showSpecificBranches': ['main', 'dev']
		}));
		expect(snapshot.enableLog).toBe(true);
		expect(snapshot.graphFontSize).toBe(20);
		expect(snapshot.interfaceLanguage).toBe('zh-cn');
		expect(snapshot.repositoryCommitsInitialLoad).toBe(500);
		expect(snapshot.dialogResetCurrentBranchToCommitMode).toBe('Hard');
		expect(snapshot.gerritRemote).toBe('upstream');
		expect(snapshot.commitDetailsViewFileViewType).toBe('File List');
		expect(snapshot.repositoryOnLoadShowSpecificBranches).toEqual(['main', 'dev']);
		// Everything not overridden stays at its manifest default
		expect(snapshot.markdown).toBe(true);
		expect(snapshot.repositoryDropdownOrder).toBe('Workspace Full Path');
	});

	it('defaults prewarming on, and passes an explicit git-graph-rs.prewarm value through', () => {
		// The switch only changes speed, never functionality (REFACTOR-PLAN 3.8.2 D11)
		expect(takeSnapshot(new FakeWorkspace()).prewarm).toBe(true);
		expect(takeSnapshot(new FakeWorkspace({ 'prewarm': false })).prewarm).toBe(false);
		expect(takeSnapshot(new FakeWorkspace({ 'prewarm': true })).prewarm).toBe(true);
	});

	it('defaults mobileAdaptation per host: ON under Git Graph Studio while unset, OFF under VS Code (OPTIMIZATION-PLAN V1)', () => {
		// The studio default lives in the snapshot reader itself (no settings write at activation),
		// so the manifest-default parity above stays the VS Code answer and only the studio host flips.
		vscodeMock.env.uriScheme = 'ggs';
		expect(takeSnapshot(new FakeWorkspace()).mobileAdaptation, 'the studio host defaults the phone layout on').toBe(true);
		expect(takeSnapshot(new FakeWorkspace({ 'mobileAdaptation': false })).mobileAdaptation, 'an explicit OFF still wins on the studio host').toBe(false);
		vscodeMock.env.uriScheme = 'vscode';
		expect(takeSnapshot(new FakeWorkspace()).mobileAdaptation, 'VS Code keeps the manifest default (off)').toBe(false);
		expect(takeSnapshot(new FakeWorkspace({ 'mobileAdaptation': true })).mobileAdaptation, 'an explicit ON still wins under VS Code').toBe(true);
	});

	it('reads the git.path setting of the git section for gitPathsOf (string, array, or unset)', () => {
		expect(gitPathsOf({
			getConfiguration: (section?: string) => ({
				get: <T>(key: string, defaultValue?: T): T | undefined =>
					section === 'git' && key === 'path' ? 'C:/tools/git/bin/git.exe' as unknown as T : defaultValue
			})
		})).toEqual(['C:/tools/git/bin/git.exe']);

		expect(gitPathsOf({
			getConfiguration: (section?: string) => ({
				get: <T>(key: string, defaultValue?: T): T | undefined =>
					section === 'git' && key === 'path' ? ['a', 7, 'b'] as unknown as T : defaultValue
			})
		})).toEqual(['a', 'b']);

		expect(gitPathsOf({ getConfiguration: () => ({ get: <T>(_key: string, defaultValue?: T) => defaultValue }) })).toEqual([]);
		expect(gitPathsOf({
			getConfiguration: (section?: string) => ({
				get: <T>(key: string, defaultValue?: T): T | undefined =>
					section === 'git' && key === 'path' ? { junk: true } as unknown as T : defaultValue
			})
		})).toEqual([]);
	});
});

describe('onConfigChange', () => {
	it('fires with a fresh snapshot when the event affects the section', () => {
		const workspace = new FakeWorkspace({ 'enableLog': false });
		const snapshots: boolean[] = [];
		const unsubscribe = onConfigChange(workspace as unknown as ObservableWorkspaceLike, (snapshot) => snapshots.push(snapshot.enableLog));

		workspace.setValue('enableLog', true);
		workspace.emit(affecting(true));
		unsubscribe();

		expect(snapshots).toEqual([true]);
	});

	it('ignores events that do not affect the section', () => {
		const workspace = new FakeWorkspace();
		let fired = 0;
		const unsubscribe = onConfigChange(workspace as unknown as ObservableWorkspaceLike, () => fired++);

		workspace.emit(affecting(false));
		unsubscribe();

		expect(fired).toBe(0);
	});

	it('treats an uninspectable event (no affectsConfiguration) as relevant', () => {
		const workspace = new FakeWorkspace();
		let fired = 0;
		const unsubscribe = onConfigChange(workspace as unknown as ObservableWorkspaceLike, () => fired++);

		workspace.emit({} as ConfigurationChangeEventLike);
		unsubscribe();

		expect(fired).toBe(1);
	});

	it('stops delivering after unsubscribing', () => {
		const workspace = new FakeWorkspace();
		let fired = 0;
		const unsubscribe = onConfigChange(workspace as unknown as ObservableWorkspaceLike, () => fired++);

		workspace.emit(affecting(true));
		unsubscribe();
		workspace.emit(affecting(true));

		expect(fired).toBe(1);
	});

	it('reads the snapshot afresh on every event', () => {
		const workspace = new FakeWorkspace({ 'graph.fontSize': 13 });
		const sizes: number[] = [];
		const unsubscribe = onConfigChange(workspace as unknown as ObservableWorkspaceLike, (snapshot) => sizes.push(snapshot.graphFontSize));

		workspace.setValue('graph.fontSize', 18);
		workspace.emit(affecting(true));
		workspace.setValue('graph.fontSize', 24);
		workspace.emit(affecting(true));
		unsubscribe();

		expect(sizes).toEqual([18, 24]);
	});
});

// --------------------------------------------------------------------------------------
// Deprecated-key migrations
// --------------------------------------------------------------------------------------

describe('deprecated-key migrations', () => {
	it('ships every manifest-deprecated key in the migrations table', () => {
		const properties = readManifest().contributes.configuration.properties;
		for (const [fullKey, setting] of Object.entries(properties)) {
			const deprecated = setting.deprecationMessage !== undefined || setting.markdownDeprecationMessage !== undefined;
			if (!deprecated) continue;
			const key = withoutSection(fullKey);
			expect(CONFIG_MIGRATIONS[key], 'git-graph-rs.' + key + ' is marked deprecated but has no migrations row').toBeDefined();
		}
	});

	it('maps every migrations row onto a contributed modern key', () => {
		const keys = new Set(contributedProperties().map(([fullKey]) => withoutSection(fullKey)));
		for (const modern of Object.values(CONFIG_MIGRATIONS)) {
			expect(keys.has(modern), 'migrations target git-graph-rs.' + modern + ' is not contributed').toBe(true);
		}
	});

	it('prefers modern over deprecated over default (per migrated key, via the snapshot)', () => {
		const manifestDefaults = readManifest().contributes.configuration.properties;
		for (const [deprecatedKey, modernKey] of Object.entries(CONFIG_MIGRATIONS)) {
			const expectedDefault = manifestDefaults[CONFIG_SECTION + '.' + modernKey]?.default;

			const onlyDeprecated = asFieldMap(takeSnapshot(new FakeWorkspace({ [deprecatedKey]: 'legacy-value' })));
			expect(onlyDeprecated[fieldOf(modernKey)]).toBe('legacy-value');

			const bothSet = asFieldMap(takeSnapshot(new FakeWorkspace({ [deprecatedKey]: 'legacy-value', [modernKey]: 'modern-value' })));
			expect(bothSet[fieldOf(modernKey)]).toBe('modern-value');

			const neither = asFieldMap(takeSnapshot(new FakeWorkspace()));
			expect(neither[fieldOf(modernKey)]).toEqual(expectedDefault);
		}
	});

	it('readWithMigrations resolves modern > deprecated > default against a synthetic table', () => {
		const migrations = { 'modern.key': 'legacy.key' };
		const configOf = (values: Record<string, unknown>): ConfigurationReader => ({
			get: <T>(section: string, defaultValue?: T): T | undefined => {
				const value = values[section];
				return value !== undefined ? value as T : defaultValue;
			}
		});

		expect(readWithMigrations(configOf({ 'modern.key': 'new' }), 'modern.key', 'fallback', migrations)).toBe('new');
		expect(readWithMigrations(configOf({ 'legacy.key': 'old' }), 'modern.key', 'fallback', migrations)).toBe('old');
		expect(readWithMigrations(configOf({}), 'modern.key', 'fallback', migrations)).toBe('fallback');
		// An explicitly-set falsy modern value still wins over a set deprecated value
		expect(readWithMigrations(configOf({ 'modern.key': false, 'legacy.key': true }), 'modern.key', true, migrations)).toBe(false);
		// An explicitly-set falsy deprecated value still wins over the default
		expect(readWithMigrations(configOf({ 'legacy.key': false }), 'modern.key', true, migrations)).toBe(false);
	});
});

// --------------------------------------------------------------------------------------
// The cooked views (the normalisations the former per-key getters applied)
// --------------------------------------------------------------------------------------

describe('cooked views over a snapshot', () => {
	const defaults = () => takeSnapshot(new FakeWorkspace());

	it('normalises keybindings: UNASSIGNED => NULL, CTRL/CMD + X => x, anything else => default', () => {
		const workspace = new FakeWorkspace({
			'keyboardShortcut.find': 'UNASSIGNED',
			'keyboardShortcut.refresh': 'not a keybinding',
			'keyboardShortcut.scrollToHead': 'CTRL/CMD + H'
		});
		const keybindings = keybindingsOf(takeSnapshot(workspace));
		expect(keybindings.find).toBeNull();
		expect(keybindings.refresh).toBe('r');
		expect(keybindings.scrollToHead).toBe('h');
		expect(keybindings.scrollToStash).toBe('s');
	});

	it('cooks the date format and date type', () => {
		const workspace = new FakeWorkspace({ 'date.format': 'Relative' });
		expect(dateFormatOf(takeSnapshot(workspace))).toEqual({ type: DateFormatType.Relative, iso: false });

		const both = new FakeWorkspace({ 'date.format': 'ISO Date Only', 'date.type': 'Commit Date' });
		const snapshot = takeSnapshot(both);
		expect(dateFormatOf(snapshot)).toEqual({ type: DateFormatType.DateOnly, iso: true });
		expect(dateTypeOf(snapshot)).toBe(DateType.Commit);
		expect(dateTypeOf(defaults())).toBe(DateType.Author);
	});

	it('cooks dialog defaults (reset modes, tag type, reference input substitution)', () => {
		const configured = new FakeWorkspace({
			'dialog.resetCurrentBranchToCommit.mode': 'Soft',
			'dialog.resetUncommittedChanges.mode': 'Hard',
			'dialog.addTag.type': 'Lightweight',
			'dialog.general.referenceInputSpaceSubstitution': 'Underscore'
		});
		const dialogs = dialogDefaultsOf(takeSnapshot(configured));
		expect(dialogs.resetCommit.mode).toBe(GitResetMode.Soft);
		expect(dialogs.resetUncommitted.mode).toBe(GitResetMode.Hard);
		expect(dialogs.addTag.type).toBe(TagType.Lightweight);
		expect(dialogs.general.referenceInputSpaceSubstitution).toBe('_');

		const fallback = dialogDefaultsOf(defaults());
		expect(fallback.resetCommit.mode).toBe(GitResetMode.Mixed);
		expect(fallback.resetUncommitted.mode).toBe(GitResetMode.Mixed);
		expect(fallback.general.referenceInputSpaceSubstitution).toBeNull();
		expect(fallback.merge.noFastForward).toBe(true);
		expect(fallback.rebase.ignoreDate).toBe(true);
		expect(fallback.stashUncommittedChanges.includeUntracked).toBe(true);
	});

	it('cooks the commit details view, mute flags, and reference labels', () => {
		const snapshot = takeSnapshot(new FakeWorkspace({
			'commitDetailsView.fileView.type': 'File List',
			'commitDetailsView.location': 'Docked to Bottom'
		}));
		expect(commitDetailsViewOf(snapshot).fileViewType).toBe(FileViewType.List);
		expect(commitDetailsViewOf(snapshot).location).toBe(CommitDetailsViewLocation.DockedToBottom);
		expect(commitDetailsViewOf(defaults()).fileViewType).toBe(FileViewType.Tree);
		expect(commitDetailsViewOf(defaults()).location).toBe(CommitDetailsViewLocation.Inline);

		expect(muteCommitsOf(defaults())).toEqual({ commitsNotAncestorsOfHead: false, mergeCommits: true });

		const labels = referenceLabelsOf(takeSnapshot(new FakeWorkspace({
			'referenceLabels.alignment': 'Branches (aligned to the graph) & Tags (on the right)'
		})));
		expect(labels.branchLabelsAlignedToGraph).toBe(true);
		expect(labels.tagLabelsOnRight).toBe(true);
		expect(referenceLabelsOf(defaults()).tagLabelsOnRight).toBe(false);
	});

	it('falls back to the default graph palette unless the configured one has a valid colour', () => {
		const oneValid = takeSnapshot(new FakeWorkspace({ 'graph.colours': ['#123456', 'not-a-colour'] }));
		expect(graphOf(oneValid).colours).toEqual(['#123456']);

		const noneValid = takeSnapshot(new FakeWorkspace({ 'graph.colours': ['nope', 'still nope'] }));
		const fallback = graphOf(noneValid).colours;
		expect(fallback).toHaveLength(12);
		expect(fallback[0]).toBe('#0085d9');

		expect(graphOf(defaults()).style).toBe(GraphStyle.Rounded);
		expect(graphOf(takeSnapshot(new FakeWorkspace({ 'graph.style': 'angular' }))).style).toBe(GraphStyle.Angular);
		expect(graphOf(defaults()).grid).toEqual({ x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 });
	});

	it('resolves the interface language: an explicit setting wins, "auto" follows the passed host language', () => {
		expect(interfaceLanguageSettingOf(takeSnapshot(new FakeWorkspace({ 'interfaceLanguage': 'zh-cn' })))).toBe('zh-cn');
		expect(interfaceLanguageSettingOf(takeSnapshot(new FakeWorkspace({ 'interfaceLanguage': 'junk' })))).toBe('auto');
		expect(interfaceLanguageSettingOf(defaults())).toBe('auto');

		expect(resolvedInterfaceLanguage('zh-cn', 'de')).toBe('zh-cn');
		expect(resolvedInterfaceLanguage('auto', 'zh-CN')).toBe('zh-cn');
		expect(resolvedInterfaceLanguage('auto', 'en')).toBe('en');
		expect(resolvedInterfaceLanguage('auto', 'de')).toBe('en');
	});

	it('cooks the commit order and the repository dropdown order', () => {
		expect(commitOrderingOf(takeSnapshot(new FakeWorkspace({ 'repository.commits.order': 'topo' })))).toBe(CommitOrdering.Topological);
		expect(commitOrderingOf(takeSnapshot(new FakeWorkspace({ 'repository.commits.order': 'author-date' })))).toBe(CommitOrdering.AuthorDate);
		expect(commitOrderingOf(defaults())).toBe(CommitOrdering.Date);

		expect(repoDropdownOrderOf(takeSnapshot(new FakeWorkspace({ 'repositoryDropdownOrder': 'Name' })))).toBe(RepoDropdownOrder.Name);
		expect(repoDropdownOrderOf(takeSnapshot(new FakeWorkspace({ 'repositoryDropdownOrder': 'Full Path' })))).toBe(RepoDropdownOrder.FullPath);
		expect(repoDropdownOrderOf(defaults())).toBe(RepoDropdownOrder.WorkspaceFullPath);
	});

	it('clamps the Gerrit fetch limit to the bounds the former reader enforced', () => {
		expect(gerritOf(takeSnapshot(new FakeWorkspace({ 'gerrit.fetchLimit': 50 })))).toEqual({ remote: 'origin', fetchLimit: 50, showReviewProgress: true });
		expect(gerritOf(takeSnapshot(new FakeWorkspace({ 'gerrit.fetchLimit': 50000 }))).fetchLimit).toBe(20);
		expect(gerritOf(takeSnapshot(new FakeWorkspace({ 'gerrit.fetchLimit': 0 }))).fetchLimit).toBe(20);
		expect(gerritOf(takeSnapshot(new FakeWorkspace({ 'gerrit.fetchLimit': 2.9 }))).fetchLimit).toBe(2);
		expect(gerritOf(takeSnapshot(new FakeWorkspace({ 'gerrit.remote': 'upstream' }))).remote).toBe('upstream');
	});

	it('cooks the tab icon theme and the new-tab editor group', () => {
		expect(tabIconColourThemeOf(defaults())).toBe(TabIconColourTheme.Colour);
		expect(tabIconColourThemeOf(takeSnapshot(new FakeWorkspace({ 'tabIconColourTheme': 'grey' })))).toBe(TabIconColourTheme.Grey);

		const columns = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 };
		expect(viewColumnOfEditorGroup('Beside')).toBe(columns.Beside);
		expect(viewColumnOfEditorGroup('Nine')).toBe(columns.Nine);
		expect(viewColumnOfEditorGroup('Active')).toBe(columns.Active);
	});

	it('maps the squash message formats', () => {
		expect(squashMessageFormatOf('Git SQUASH_MSG')).toBe(SquashMessageFormat.GitSquashMsg);
		expect(squashMessageFormatOf('Default')).toBe(SquashMessageFormat.Default);
	});

	it('prefixes custom branch glob patterns with --glob=, and filters the identity/provider/emoji lists', () => {
		const globs = customBranchGlobPatternsOf(takeSnapshot(new FakeWorkspace({
			'customBranchGlobPatterns': [{ name: 'Feature', glob: 'heads/feature/*' }, { name: 'No Glob' }, 'junk']
		})));
		expect(globs).toEqual([{ name: 'Feature', glob: '--glob=heads/feature/*' }]);
		expect(customBranchGlobPatternsOf(defaults())).toEqual([]);

		const authors = commitAuthorsOf(takeSnapshot(new FakeWorkspace({
			'commitAuthors': [
				{ name: 'Alice', email: 'alice@example.com' },
				{ name: 'No Email' },
				{ name: '', email: 'blank-name@example.com' },
				{ name: 'Blank Email', email: '   ' },
				{ name: 7, email: 'number-name@example.com' },
				'not an object',
				null
			]
		})));
		expect(authors).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
		expect(commitAuthorsOf(defaults())).toEqual([]);

		const providers = customPullRequestProvidersOf(takeSnapshot(new FakeWorkspace({
			'customPullRequestProviders': [{ name: 'Gitea', templateUrl: 'https://tea.example/{owner}/{repo}/compare' }, { name: 'No Template' }]
		})));
		expect(providers).toEqual([{ name: 'Gitea', templateUrl: 'https://tea.example/{owner}/{repo}/compare' }]);

		const emojis = customEmojiShortcodeMappingsOf(takeSnapshot(new FakeWorkspace({
			'customEmojiShortcodeMappings': [{ shortcode: 'ship', emoji: '🚀' }, { shortcode: 'no-emoji' }]
		})));
		expect(emojis).toEqual([{ shortcode: 'ship', emoji: '🚀' }]);
	});

	it('merges the context menu visibility over the built-in defaults, and renames the column visibility', () => {
		const merged = contextMenuActionsVisibilityOf(takeSnapshot(new FakeWorkspace({
			'contextMenuActionsVisibility': { branch: { checkout: false }, stash: { pop: false } }
		})));
		expect(merged.branch.checkout).toBe(false);
		expect(merged.branch.merge).toBe(true);
		expect(merged.stash.pop).toBe(false);
		expect(merged.commit.addTag).toBe(true);

		expect(contextMenuActionsVisibilityOf(defaults()).branch.checkout).toBe(true);

		const columns = defaultColumnVisibilityOf(takeSnapshot(new FakeWorkspace({
			'defaultColumnVisibility': { Date: true, Author: false, Commit: true }
		})));
		expect(columns).toEqual({ date: true, author: false, commit: true });
		expect(defaultColumnVisibilityOf(defaults())).toEqual({ date: true, author: true, commit: true });
	});

	it('filters the on-repo-load branch list to strings', () => {
		const onLoad = onRepoLoadOf(takeSnapshot(new FakeWorkspace({
			'repository.onLoad.showSpecificBranches': ['main', 7, null],
			'repository.onLoad.scrollToHead': true
		})));
		expect(onLoad).toEqual({ scrollToHead: true, showCheckedOutBranch: false, showSpecificBranches: ['main'] });
		expect(onRepoLoadOf(defaults()).showSpecificBranches).toEqual([]);
	});

	it('cookConfig assembles every cooked view from one snapshot', () => {
		const cooked = cookConfig(takeSnapshot(new FakeWorkspace({
			'interfaceLanguage': 'zh-cn',
			'repository.commits.order': 'topo'
		})), 'en');
		expect(cooked.interfaceLanguage).toBe('zh-cn');
		expect(cooked.commitOrder).toBe(CommitOrdering.Topological);
		expect(cooked.keybindings.refresh).toBe('r');
		expect(cooked.gerrit.fetchLimit).toBe(20);
		expect(cooked.graph.colours.length).toBe(12);
		expect(cooked.dialogDefaults.addTag.type).toBe(TagType.Annotated);
		expect(cooked.interfaceLanguageSetting).toBe('zh-cn');
	});
});

// --------------------------------------------------------------------------------------
// The ConfigService (the long-lived snapshot holder)
// --------------------------------------------------------------------------------------

describe('ConfigService', () => {
	it('answers the construction snapshot, and follows section-affecting changes', async () => {
		const { ConfigService } = await import('./service');
		const workspace = new FakeWorkspace({ 'enableLog': false, 'showStatusBarItem': true });
		const service = new ConfigService(workspace as unknown as ObservableWorkspaceLike);
		try {
			expect(service.current.enableLog).toBe(false);

			workspace.setValue('enableLog', true);
			workspace.emit(affecting(true));
			expect(service.current.enableLog).toBe(true);
			// The whole snapshot is replaced: the other fields stay consistent with the new reading
			expect(service.current.showStatusBarItem).toBe(true);
		} finally {
			service.dispose();
		}
	});

	it('does not follow changes after disposal', async () => {
		const { ConfigService } = await import('./service');
		const workspace = new FakeWorkspace({ 'enableLog': false });
		const service = new ConfigService(workspace as unknown as ObservableWorkspaceLike);
		service.dispose();

		workspace.setValue('enableLog', true);
		workspace.emit(affecting(true));
		expect(service.current.enableLog).toBe(false);
	});
});

// --------------------------------------------------------------------------------------
// The transitional getConfig shim (repos/repoManager.ts only)
// --------------------------------------------------------------------------------------

describe('getConfig (the transitional repoManager slice)', () => {
	let scopes: unknown[];
	let configurationValues: Record<string, unknown>;

	beforeEach(() => {
		scopes = [];
		vscodeMock.env.language = 'en';
		vscodeMock.env.uriScheme = 'vscode';
		vscodeMock.workspace = {
			getConfiguration: (section?: string, scope?: unknown): unknown => {
				scopes.push(scope);
				return {
					get: <T>(key: string, defaultValue?: T): T | undefined => {
						if (section !== CONFIG_SECTION) return defaultValue;
						const value = configurationValues[key];
						return value !== undefined ? value as T : defaultValue;
					}
				};
			}
		};
	});

	it('answers the two settings repoManager reads, unscoped and repo-scoped alike', async () => {
		const { getConfig } = await import('./legacy');
		configurationValues = { 'maxDepthOfRepoSearch': 3, 'repository.trackRemoteTags': true };

		const unscoped = getConfig();
		expect(unscoped.maxDepthOfRepoSearch).toBe(3);
		expect(unscoped.trackRemoteTags).toBe(true);
		expect(scopes).toEqual([undefined]);

		const scoped = getConfig('E:/some/repo');
		expect(scoped.maxDepthOfRepoSearch).toBe(3);
		expect(scoped.trackRemoteTags).toBe(true);
		expect(scopes[1]).toEqual({ fsPath: 'E:/some/repo' });
	});

	it('answers the manifest defaults when nothing is set', async () => {
		const { getConfig } = await import('./legacy');
		configurationValues = {};
		const slice = getConfig();
		expect(slice.maxDepthOfRepoSearch).toBe(0);
		expect(slice.trackRemoteTags).toBe(false);
	});
});

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The module also carries the live per-repository reader absorbed from the former flat
 * src/config.ts, which reads through `vscode.workspace.getConfiguration` - so a fake 'vscode'
 * module backs it here. The snapshot tests below keep using plain injected workspaces and never
 * touch the fake.
 */
const vscodeMock = vi.hoisted(() => ({
	env: { language: 'en', uriScheme: 'vscode' },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ViewColumn: { Active: 1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: (_section?: string, _scope?: unknown): unknown => {
			throw new Error('unexpected getConfiguration call');
		}
	}
}));

vi.mock('vscode', () => vscodeMock);

import { CommitOrdering, DateFormatType, DateType, GitResetMode, TagType } from '../../types';
import {
	CONFIG_MIGRATIONS,
	CONFIG_SECTION,
	ConfigurationChangeEventLike,
	DisposableLike,
	ObservableWorkspaceLike,
	WorkspaceConfigurationLike,
	WorkspaceLike,
	getConfig,
	onConfigChange,
	readWithMigrations,
	takeSnapshot
} from './config';

/**
 * The snapshot contract is anchored to package.json itself: the key list, the field mapping and
 * the defaults are all derived from the manifest in these tests, so a newly contributed setting
 * without a snapshot field (or a drifted default) fails here rather than silently reading
 * `undefined` at runtime. The workspace fakes are plain maps - the whole point of the structural
 * injection is that no vscode is needed to test this module.
 */

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

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Snapshot fields whose manifest registration is owned by another agent (REFACTOR-PLAN task 4.9
 * coordination): the snapshot reads `git-graph-rs.prewarm` (default TRUE) while its
 * `contributes.configuration` entry is being added to package.json in parallel. The anchored
 * tests below treat each entry as a contributed key with the given default UNTIL the manifest
 * entry exists; once it lands, the manifest's own declaration wins and the entry here becomes a
 * checked no-op (a key both contributed and listed must declare the same default or the
 * 'takeSnapshot defaults' test fails on the mismatch).
 */
const PENDING_MANIFEST_SETTINGS: Readonly<Record<string, unknown>> = {
	'prewarm': true
};

function readManifest(): Manifest {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Manifest;
}

/** The dotted key of a contributed setting, without the `git-graph-rs.` prefix. */
function contributedKeys(): string[] {
	const keys = Object.keys(readManifest().contributes.configuration.properties).map((key) => key.substring(CONFIG_SECTION.length + 1));
	for (const pending of Object.keys(PENDING_MANIFEST_SETTINGS)) {
		if (!keys.includes(pending)) keys.push(pending);
	}
	return keys;
}

/** The snapshot field name of a dotted setting key (camelCase join; mirrors the interface). */
function fieldOf(key: string): string {
	return key.split('.').map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** The manifest's declared default for a contributed key (its absence is itself a manifest bug). */
function defaultOf(key: string): unknown {
	const property = readManifest().contributes.configuration.properties[CONFIG_SECTION + '.' + key];
	return property !== undefined ? property.default : PENDING_MANIFEST_SETTINGS[key];
}

/** A workspace answering every section from one plain map of dotted-key -> value. */
class FakeWorkspace implements WorkspaceLike {
	private readonly listeners: Array<(event: ConfigurationChangeEventLike) => void> = [];
	private readonly values: Map<string, unknown>;

	constructor(values: Record<string, unknown> = {}) {
		this.values = new Map(Object.entries(values));
	}

	public getConfiguration(_section?: string): WorkspaceConfigurationLike {
		return {
			get: <T>(section: string, defaultValue?: T): T | undefined => {
				const value = this.values.get(section);
				return value !== undefined ? value as T : defaultValue;
			}
		};
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

function affecting(relevant: boolean): ConfigurationChangeEventLike {
	return { affectsConfiguration: (section: string) => relevant && section === CONFIG_SECTION };
}

/** View a snapshot as its field map (the interface has no index signature by design). */
function asFieldMap(snapshot: ReturnType<typeof takeSnapshot>): Record<string, unknown> {
	return snapshot as unknown as Record<string, unknown>;
}

describe('takeSnapshot defaults', () => {
	it('answers the package.json default for every setting of an empty workspace', () => {
		const snapshot = asFieldMap(takeSnapshot(new FakeWorkspace()));
		const expected: Record<string, unknown> = {};
		for (const key of contributedKeys()) {
			const field = fieldOf(key);
			if (expected[field] !== undefined) throw new Error('field name collision for key ' + key);
			expected[field] = defaultOf(key);
		}
		expect(Object.keys(snapshot).length).toBe(Object.keys(expected).length);
		expect(snapshot).toEqual(expected);
	});

	it('defaults prewarming on, and passes an explicit git-graph-rs.prewarm value through', () => {
		// The switch only changes speed, never functionality (REFACTOR-PLAN 3.8.2 D11), so the
		// unset default is on
		expect(takeSnapshot(new FakeWorkspace()).prewarm).toBe(true);
		expect(takeSnapshot(new FakeWorkspace({ 'prewarm': false })).prewarm).toBe(false);
		expect(takeSnapshot(new FakeWorkspace({ 'prewarm': true })).prewarm).toBe(true);
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
});

describe('snapshot completeness (anchored to package.json)', () => {
	it('has exactly one field per contributed setting - a new setting without a field fails', () => {
		const snapshot = asFieldMap(takeSnapshot(new FakeWorkspace()));
		const fields = new Set(Object.keys(snapshot));
		const keys = contributedKeys();
		expect(keys.length).toBeGreaterThan(90);
		for (const key of keys) {
			expect(fields.has(fieldOf(key)), 'missing snapshot field for git-graph-rs.' + key).toBe(true);
		}
		// And no orphan fields: every field maps back to a contributed key
		const contributedFields = new Set(keys.map(fieldOf));
		for (const field of fields) {
			expect(contributedFields.has(field), 'snapshot field "' + field + '" has no contributed setting').toBe(true);
		}
		expect(fields.size).toBe(keys.length);
	});
});

describe('deprecated-key migrations', () => {
	it('ships every manifest-deprecated key in the migrations table', () => {
		const properties = readManifest().contributes.configuration.properties;
		for (const [fullKey, setting] of Object.entries(properties)) {
			const deprecated = setting.deprecationMessage !== undefined || setting.markdownDeprecationMessage !== undefined;
			if (!deprecated) continue;
			const key = fullKey.substring(CONFIG_SECTION.length + 1);
			expect(CONFIG_MIGRATIONS[key], 'git-graph-rs.' + key + ' is marked deprecated but has no migrations row').toBeDefined();
		}
	});

	it('maps every migrations row onto a contributed modern key', () => {
		const keys = new Set(contributedKeys());
		for (const modern of Object.values(CONFIG_MIGRATIONS)) {
			expect(keys.has(modern), 'migrations target git-graph-rs.' + modern + ' is not contributed').toBe(true);
		}
	});

	it('prefers modern over deprecated over default (per migrated key, via the snapshot)', () => {
		for (const [deprecatedKey, modernKey] of Object.entries(CONFIG_MIGRATIONS)) {
			const expectedDefault = defaultOf(modernKey);

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
		const configOf = (values: Record<string, unknown>): WorkspaceConfigurationLike => ({
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

describe('onConfigChange', () => {
	it('fires with a fresh snapshot when the event affects the section', () => {
		const workspace = new FakeWorkspace({ 'enableLog': false });
		const snapshots: boolean[] = [];
		const unsubscribe = onConfigChange(workspace as ObservableWorkspaceLike, (snapshot) => snapshots.push(snapshot.enableLog));

		workspace.setValue('enableLog', true);
		workspace.emit(affecting(true));
		unsubscribe();

		expect(snapshots).toEqual([true]);
	});

	it('ignores events that do not affect the section', () => {
		const workspace = new FakeWorkspace();
		let fired = 0;
		const unsubscribe = onConfigChange(workspace as ObservableWorkspaceLike, () => fired++);

		workspace.emit(affecting(false));
		unsubscribe();

		expect(fired).toBe(0);
	});

	it('treats an uninspectable event (no affectsConfiguration) as relevant', () => {
		const workspace = new FakeWorkspace();
		let fired = 0;
		const unsubscribe = onConfigChange(workspace as ObservableWorkspaceLike, () => fired++);

		workspace.emit({} as ConfigurationChangeEventLike);
		unsubscribe();

		expect(fired).toBe(1);
	});

	it('stops delivering after unsubscribing', () => {
		const workspace = new FakeWorkspace();
		let fired = 0;
		const unsubscribe = onConfigChange(workspace as ObservableWorkspaceLike, () => fired++);

		workspace.emit(affecting(true));
		unsubscribe();
		workspace.emit(affecting(true));

		expect(fired).toBe(1);
	});

	it('reads the snapshot afresh on every event', () => {
		const workspace = new FakeWorkspace({ 'graph.fontSize': 13 });
		const sizes: number[] = [];
		const unsubscribe = onConfigChange(workspace as ObservableWorkspaceLike, (snapshot) => sizes.push(snapshot.graphFontSize));

		workspace.setValue('graph.fontSize', 18);
		workspace.emit(affecting(true));
		workspace.setValue('graph.fontSize', 24);
		workspace.emit(affecting(true));
		unsubscribe();

		expect(sizes).toEqual([18, 24]);
	});
});

describe('getConfig (the legacy per-repository reader, absorbed from src/config.ts)', () => {
	let scopes: unknown[];

	beforeEach(() => {
		scopes = [];
		vscodeMock.env.language = 'en';
		vscodeMock.env.uriScheme = 'vscode';
	});

	/** Point vscode.workspace.getConfiguration at a plain dotted-key map for the extension's section. */
	function configure(values: Record<string, unknown>): void {
		vscodeMock.workspace.getConfiguration = (section?: string, scope?: unknown) => {
			scopes.push(scope);
			return {
				get: <T>(key: string, defaultValue?: T): T | undefined => {
					// Any other section (the 'git' section of gitPaths) answers its default
					if (section !== CONFIG_SECTION) return defaultValue;
					const value = values[key];
					return value !== undefined ? value as T : defaultValue;
				}
			};
		};
	}

	it('reads from the git-graph-rs section, scoped to the repository when one is given', () => {
		configure({});
		getConfig();
		expect(scopes).toEqual([undefined]);
		getConfig('E:/some/repo');
		expect(scopes[1]).toEqual({ fsPath: 'E:/some/repo' });
	});

	it('normalises keybindings: UNASSIGNED => NULL, CTRL/CMD + X => x, anything else => default', () => {
		configure({
			'keyboardShortcut.find': 'UNASSIGNED',
			'keyboardShortcut.refresh': 'not a keybinding',
			'keyboardShortcut.scrollToHead': 'CTRL/CMD + H'
		});
		const keybindings = getConfig().keybindings;
		expect(keybindings.find).toBeNull();
		expect(keybindings.refresh).toBe('r');
		expect(keybindings.scrollToHead).toBe('h');
	});

	it('cooks the date format and date type', () => {
		configure({ 'date.format': 'Relative' });
		expect(getConfig().dateFormat).toEqual({ type: DateFormatType.Relative, iso: false });

		configure({ 'date.format': 'ISO Date Only', 'date.type': 'Commit Date' });
		const config = getConfig();
		expect(config.dateFormat).toEqual({ type: DateFormatType.DateOnly, iso: true });
		expect(config.dateType).toBe(DateType.Commit);
	});

	it('cooks dialog defaults (reset modes, tag type, reference input substitution)', () => {
		configure({
			'dialog.resetCurrentBranchToCommit.mode': 'Soft',
			'dialog.resetUncommittedChanges.mode': 'Hard',
			'dialog.addTag.type': 'Lightweight',
			'dialog.general.referenceInputSpaceSubstitution': 'Underscore'
		});
		const dialogs = getConfig().dialogDefaults;
		expect(dialogs.resetCommit.mode).toBe(GitResetMode.Soft);
		expect(dialogs.resetUncommitted.mode).toBe(GitResetMode.Hard);
		expect(dialogs.addTag.type).toBe(TagType.Lightweight);
		expect(dialogs.general.referenceInputSpaceSubstitution).toBe('_');

		configure({});
		const defaults = getConfig().dialogDefaults;
		expect(defaults.resetCommit.mode).toBe(GitResetMode.Mixed);
		expect(defaults.resetUncommitted.mode).toBe(GitResetMode.Mixed);
		expect(defaults.general.referenceInputSpaceSubstitution).toBeNull();
	});

	it('falls back to the default graph palette unless the configured one has a valid colour', () => {
		configure({ 'graph.colours': ['#123456', 'not-a-colour'] });
		expect(getConfig().graph.colours).toEqual(['#123456']);

		configure({ 'graph.colours': ['nope', 'still nope'] });
		const fallback = getConfig().graph.colours;
		expect(fallback).toHaveLength(12);
		expect(fallback[0]).toBe('#0085d9');
	});

	it('resolves the interface language: an explicit setting wins, "auto" follows the editor', () => {
		configure({ 'interfaceLanguage': 'zh-cn' });
		expect(getConfig().interfaceLanguage).toBe('zh-cn');
		expect(getConfig().interfaceLanguageSetting).toBe('zh-cn');

		configure({ 'interfaceLanguage': 'auto' });
		vscodeMock.env.language = 'zh-CN';
		expect(getConfig().interfaceLanguage).toBe('zh-cn');

		vscodeMock.env.language = 'de';
		expect(getConfig().interfaceLanguage).toBe('en');
	});

	it('cooks the commit order', () => {
		configure({ 'repository.commits.order': 'topo' });
		expect(getConfig().commitOrder).toBe(CommitOrdering.Topological);

		configure({ 'repository.commits.order': 'author-date' });
		expect(getConfig().commitOrder).toBe(CommitOrdering.AuthorDate);

		configure({});
		expect(getConfig().commitOrder).toBe(CommitOrdering.Date);
	});

	it('defaults mobileAdaptation per host when no scope sets it', () => {
		// An explicitly set value wins on every host (VS Code's scope precedence)
		vscodeMock.workspace.getConfiguration = () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
			inspect: (key: string) => key === 'mobileAdaptation' ? { workspaceFolderValue: false } : undefined,
			has: (_key: string) => false
		});
		expect(getConfig().mobileAdaptation).toBe(false);

		vscodeMock.workspace.getConfiguration = () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
			inspect: (_key: string) => undefined,
			has: (_key: string) => false
		});
		// Unset: Git Graph Studio ('ggs') turns it on, VS Code keeps it off
		vscodeMock.env.uriScheme = 'ggs';
		expect(getConfig().mobileAdaptation).toBe(true);
		vscodeMock.env.uriScheme = 'vscode';
		expect(getConfig().mobileAdaptation).toBe(false);
	});

	it('reads the git.path setting of the git section for gitPaths', () => {
		vscodeMock.workspace.getConfiguration = (section?: string) => ({
			get: <T>(key: string, defaultValue?: T): T | undefined => section === 'git' && key === 'path'
				? 'C:/tools/git/bin/git.exe' as unknown as T
				: defaultValue
		});
		expect(getConfig().gitPaths).toEqual(['C:/tools/git/bin/git.exe']);
	});

	it('commitAuthors returns the configured author identities', () => {
		configure({
			'commitAuthors': [
				{ name: 'Alice (Work)', email: 'alice@corp.example' },
				{ name: 'alice-oss', email: 'alice@example.com' }
			]
		});
		expect(getConfig().commitAuthors).toEqual([
			{ name: 'Alice (Work)', email: 'alice@corp.example' },
			{ name: 'alice-oss', email: 'alice@example.com' }
		]);
	});

	it('commitAuthors returns an empty array when the setting is not an array', () => {
		configure({ 'commitAuthors': 'Alice <alice@example.com>' });
		expect(getConfig().commitAuthors).toEqual([]);
	});

	it('commitAuthors drops entries whose name or email is missing, not a string, or blank', () => {
		configure({
			'commitAuthors': [
				{ name: 'Alice', email: 'alice@example.com' },
				{ name: 'No Email' },
				{ name: '', email: 'blank-name@example.com' },
				{ name: 'Blank Email', email: '   ' },
				{ name: 7, email: 'number-name@example.com' },
				'not an object',
				null
			]
		});
		expect(getConfig().commitAuthors).toEqual([
			{ name: 'Alice', email: 'alice@example.com' }
		]);
	});
});

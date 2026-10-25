import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
	CONFIG_MIGRATIONS,
	CONFIG_SECTION,
	ConfigurationChangeEventLike,
	DisposableLike,
	ObservableWorkspaceLike,
	WorkspaceConfigurationLike,
	WorkspaceLike,
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

function readManifest(): Manifest {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Manifest;
}

/** The dotted key of a contributed setting, without the `git-graph-rs.` prefix. */
function contributedKeys(): string[] {
	return Object.keys(readManifest().contributes.configuration.properties).map((key) => key.substring(CONFIG_SECTION.length + 1));
}

/** The snapshot field name of a dotted setting key (camelCase join; mirrors the interface). */
function fieldOf(key: string): string {
	return key.split('.').map((part, index) => index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** The manifest's declared default for a contributed key (its absence is itself a manifest bug). */
function defaultOf(key: string): unknown {
	const full = CONFIG_SECTION + '.' + key;
	return readManifest().contributes.configuration.properties[full].default;
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

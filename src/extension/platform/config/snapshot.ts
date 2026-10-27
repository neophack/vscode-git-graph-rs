import * as vscode from 'vscode';
import { ConfigSnapshot, CONFIG_SCHEMA, SnapshotField } from './schema';
import { readWithMigrations } from './migrations';

/**
 * The snapshotting half of the configuration model (REFACTOR-PLAN 3.3 + task 4.5): take one
 * immutable {@link ConfigSnapshot} of every contributed `git-graph-rs.*` setting, and subscribe
 * to the changes of that section. Defaults come from the checked-in schema table
 * ({@link ./schema}), whose parity with `package.json#contributes.configuration` a test asserts
 * in both directions - so an unset setting answers with the manifest default and there is no
 * second definition of any default anywhere in the code.
 *
 * Host-aware policies built on top of the raw values and cooked enums (`FileViewType.List`,
 * `GitResetMode.Soft`, ...) belong to the consumers of the snapshot (see `./cooked`), not to
 * this module.
 */

/** The configuration section every git-graph-rs setting lives under. */
export const CONFIG_SECTION = 'git-graph-rs';

/** The shape of `vscode.WorkspaceConfiguration` this module reads. Structural (no vscode import in the type), so tests inject a plain map - and the real object satisfies it without adaptation. */
export interface WorkspaceConfigurationLike {
	get<T>(section: string, defaultValue?: T): T | undefined;
}

/** The shape of `vscode.workspace` this module reads: one configuration lookup. */
export interface WorkspaceLike {
	getConfiguration(section?: string): WorkspaceConfigurationLike;
}

/** The shape of `vscode.ConfigurationChangeEvent` used to filter relevant changes. */
export interface ConfigurationChangeEventLike {
	affectsConfiguration(section: string, scope?: unknown): boolean;
}

/** The shape of `vscode.Disposable` returned by event subscriptions. */
export interface DisposableLike {
	dispose(): void;
}

/** A workspace that can also report configuration changes (vscode.workspace's event side). */
export interface ObservableWorkspaceLike extends WorkspaceLike {
	onDidChangeConfiguration(listener: (event: ConfigurationChangeEventLike) => void): DisposableLike;
}

/**
 * The unset `mobileAdaptation` default is host-aware: Git Graph Studio (uriScheme 'ggs') turns
 * the narrow-window phone layout on — its remote phone sessions are the layout's audience —
 * while VS Code keeps the manifest default (off). Expressing the studio default in the snapshot
 * reader (instead of a settings write the activation used to seed, OPTIMIZATION-PLAN V1) means
 * no user settings are touched at activation, and an explicitly set value still wins on every
 * host. This is the ONE declared divergence of the snapshot from the manifest defaults.
 */
function mobileAdaptationDefault(): boolean {
	return vscode.env.uriScheme === 'ggs';
}

/**
 * The schema rows whose unset default is computed from the host instead of answered from the
 * manifest (see {@link mobileAdaptationDefault}). Every other setting falls back to its
 * {@link CONFIG_SCHEMA} row default.
 */
const HOST_AWARE_DEFAULTS: { readonly [K in SnapshotField]?: () => ConfigSnapshot[K] } = {
	mobileAdaptation: mobileAdaptationDefault
};

/**
 * Take a snapshot of every contributed `git-graph-rs.*` setting from the injected workspace.
 * Unset (and not migrated) settings answer with their package.json default (the schema table's
 * row default; the host-aware exceptions above).
 * @param workspace A workspace-like object (`vscode.workspace` satisfies this structurally).
 */
export function takeSnapshot(workspace: WorkspaceLike): ConfigSnapshot {
	const config = workspace.getConfiguration(CONFIG_SECTION);
	const snapshot: Record<string, unknown> = {};
	for (const field of Object.keys(CONFIG_SCHEMA) as SnapshotField[]) {
		const row = CONFIG_SCHEMA[field];
		const hostAware = HOST_AWARE_DEFAULTS[field];
		snapshot[field] = readWithMigrations(config, row.key, hostAware !== undefined ? hostAware() : row.default);
	}
	// The loop filled every field of the schema (whose keys are exactly the snapshot's fields).
	return snapshot as unknown as ConfigSnapshot;
}

/**
 * Subscribe to configuration changes affecting the extension's settings: the callback fires with
 * a FRESH snapshot ({@link takeSnapshot} is re-run on every relevant event). Debouncing is
 * deliberately NOT provided - it is a consumer concern (the extension host coalesces editor-level
 * events, and different consumers want different windows).
 * @param workspace A workspace-like object that also reports configuration changes.
 * @param onChange Called with the fresh snapshot for every event affecting {@link CONFIG_SECTION}.
 * Events whose shape cannot be inspected (no `affectsConfiguration`) are treated as affecting.
 * @returns An unsubscribe function.
 */
export function onConfigChange(workspace: ObservableWorkspaceLike, onChange: (snapshot: ConfigSnapshot) => void): () => void {
	const subscription = workspace.onDidChangeConfiguration((event) => {
		if (event !== null && typeof event === 'object' && typeof event.affectsConfiguration === 'function'
			&& !event.affectsConfiguration(CONFIG_SECTION)) {
			return;
		}
		onChange(takeSnapshot(workspace));
	});
	return () => subscription.dispose();
}

/**
 * The Git executable paths configured by the `git.path` Visual Studio Code setting (NOT a
 * `git-graph-rs.*` setting — it is VS Code's own Git integration's): a single string, an array
 * of strings, or unset. Read through the injected workspace so tests can stand it in.
 * @param workspace A workspace-like object (`vscode.workspace` satisfies this structurally).
 */
export function gitPathsOf(workspace: WorkspaceLike): string[] {
	const configValue = workspace.getConfiguration('git').get<string | string[] | null>('path', null);
	if (configValue === null) {
		return [];
	} else if (typeof configValue === 'string') {
		return [configValue];
	} else if (Array.isArray(configValue)) {
		return configValue.filter((value) => typeof value === 'string');
	} else {
		return [];
	}
}

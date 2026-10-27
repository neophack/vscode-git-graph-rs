import * as os from 'os';
import * as vscode from 'vscode';
import { t } from '../platform/i18n';
import { showErrorMessage } from '../platform/actions';
import { getExtensionVersion } from '../platform/format';
import { CONFIG_SCHEMA } from '../platform/config';
import type { ConfigSnapshot, SnapshotField } from '../platform/config';
import { loadAddon, toBackendError } from '../git/read/addonLoader';
import { formatTrace, traces } from '../../shared/perf/trace';
import type { Trace } from '../../shared/perf/trace';
import type { CommandHost } from './context';

/**
 * The `git-graph-rs.showDiagnostics` command: collects the extension's own view of its runtime state into one untitled
 * document, ready to paste into an issue. Everything it reports is state the host already holds
 * — nothing is collected ahead of time and nothing leaves the editor (no telemetry).
 *
 * The document's content is technical English on purpose (issue reports are filed against the
 * English tracker); only the failure notification around it runs through the `t()` seam.
 *
 * The two pure halves — the non-default-settings diff and the document formatting — are unit
 * tested directly; the `vscode`-dependent shell stays thin and untested, like `commands/misc.ts`.
 */

/**
 * One setting whose current value differs from the schema default: the Diagnostics document's
 * diff row, computed against the one checked-in defaults table (`platform/config/schema.ts`).
 */
export interface SettingDifference {
	/** The full dotted setting key, as `package.json#contributes.configuration` declares it. */
	readonly key: string;
	/** The value the current configuration snapshot carries. */
	readonly value: unknown;
	/** The schema table's default for the setting (the manifest's own default). */
	readonly default: unknown;
}

/**
 * Structural (deep) equality for setting values: the snapshot's arrays and records never share
 * identity with the schema defaults, so `===` would report every array- and object-valued
 * setting as non-default. Key order is ignored (JSON-shaped records, not ordered maps).
 */
function structuralEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => structuralEquals(item, b[index]));
	}
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	const aKeys = Object.keys(a).sort();
	const bKeys = Object.keys(b).sort();
	if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false;
	return aKeys.every((key) => structuralEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * The snapshot-vs-defaults diff (§V5's "active non-default settings"): every contributed setting
 * whose value in `snapshot` differs, structurally, from its `CONFIG_SCHEMA` row default — the
 * one place any default is defined in code, so an unset setting never shows up here.
 *
 * The declared divergence (snapshot.ts's HOST_AWARE_DEFAULTS) applies: on a Git Graph Studio
 * host the unset `mobileAdaptation` answers `true` against the schema's `false`, so it is listed
 * there — an accurate report of the effective configuration, which is what an issue needs.
 */
export function nonDefaultSettings(snapshot: ConfigSnapshot): ReadonlyArray<SettingDifference> {
	const differences: SettingDifference[] = [];
	for (const field of Object.keys(CONFIG_SCHEMA) as SnapshotField[]) {
		const row = CONFIG_SCHEMA[field];
		if (!structuralEquals(snapshot[field], row.default)) {
			differences.push({ key: 'git-graph-rs.' + row.key, value: snapshot[field], default: row.default });
		}
	}
	return differences;
}

/**
 * The facts the document renders, gathered by the thin shell so the formatting below stays a
 * pure, directly testable function.
 */
export interface DiagnosticsInput {
	/** The extension's own version ('unknown' when its package.json cannot be read). */
	readonly extensionVersion: string;
	/** `vscode.version`. */
	readonly vscodeVersion: string;
	/** `process.versions.electron`, or null where the runtime cannot say. */
	readonly electronVersion: string | null;
	/** `process.versions.node`, or null where the runtime cannot say. */
	readonly nodeVersion: string | null;
	/** `${process.platform}-${process.arch}` — the key the engine platform table uses. */
	readonly platform: string;
	/** `os.type()` and `os.release()`, the OS line of the `version` command. */
	readonly osDescription: string;
	/** The read backend's diagnostics name ('rust', 'git-cli', 'rust (falling back to git-cli)', 'unavailable'). */
	readonly backendName: string;
	/** The repository the live panel shows, or null when no panel is open. */
	readonly panelRepo: string | null;
	/** Whether the native engine binary loads at all. */
	readonly engineAvailable: boolean;
	/** The engine's own version string when it loads (null when even `engineVersion()` fails). */
	readonly engineVersion: string | null;
	/** The failure class (`GitBackendError.kind`) of the load failure when the engine cannot load. */
	readonly engineFailureClass: string | null;
	/** The load failure's message when the engine cannot load. */
	readonly engineFailureMessage: string | null;
	/** The resolved Git executable's path, or null when none was found. */
	readonly gitPath: string | null;
	/** The resolved Git executable's version, or null when none was found. */
	readonly gitVersion: string | null;
	/** The recorded perf traces (the ring buffer holds the last 20), oldest first. */
	readonly perfTraces: ReadonlyArray<Trace>;
	/** The snapshot-vs-defaults diff (see {@link nonDefaultSettings}). */
	readonly settings: ReadonlyArray<SettingDifference>;
}

/** Render one setting value for the document: JSON for structure, plain text for scalars. */
function renderValue(value: unknown): string {
	if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
	return JSON.stringify(value) ?? String(value);
}

/**
 * Render a diff row's current value. The GitLab token is the one secret among the settings: it
 * is reported as SET (with its length) but never echoed — the document is meant to be pasted
 * into a public issue verbatim.
 */
function renderSettingValue(difference: SettingDifference): string {
	if (difference.key === 'git-graph-rs.avatars.gitlabToken' && typeof difference.value === 'string') {
		return '(redacted: ' + difference.value.length + ' characters)';
	}
	return renderValue(difference.value);
}

/**
 * Render the collected facts as the Diagnostics document (technical English, markdown-shaped so
 * the untitled editor highlights it while it stays plain enough to paste anywhere).
 */
export function formatDiagnostics(input: DiagnosticsInput): string {
	const lines: string[] = [];
	const section = (title: string) => {
		lines.push('', '## ' + title, '');
	};
	const row = (label: string, value: string) => {
		lines.push('- ' + label + ': ' + value);
	};

	lines.push('Git Graph RS Diagnostics', '========================');

	section('Environment');
	row('Git Graph RS', input.extensionVersion);
	row('VS Code', input.vscodeVersion);
	row('Electron', input.electronVersion !== null ? input.electronVersion : '(unknown)');
	row('Node', input.nodeVersion !== null ? input.nodeVersion : '(unknown)');
	row('OS', input.osDescription + ' (' + input.platform + ')');

	section('Backend');
	row('Backend in use', input.backendName);
	row('Open panel repository', input.panelRepo !== null ? input.panelRepo : '(no panel open)');
	if (input.engineAvailable) {
		row('Engine available', 'yes');
		row('Engine version', input.engineVersion !== null ? input.engineVersion : '(unknown)');
	} else {
		row('Engine available', 'no');
		row('Engine failure class', input.engineFailureClass !== null ? input.engineFailureClass : '(unknown)');
		row('Engine failure', input.engineFailureMessage !== null ? input.engineFailureMessage : '(unknown)');
	}

	section('Git');
	if (input.gitPath !== null) {
		row('Path', input.gitPath);
		row('Version', input.gitVersion !== null ? input.gitVersion : '(unknown)');
	} else {
		row('Executable', '(none found)');
	}

	section('Performance traces (last ' + input.perfTraces.length + ')');
	if (input.perfTraces.length === 0) {
		lines.push('(none recorded — tracing and the session log follow the "git-graph-rs.enableLog" setting)');
	} else {
		for (const trace of input.perfTraces) lines.push('- ' + formatTrace(trace));
	}

	section('Non-default settings (' + input.settings.length + ')');
	if (input.settings.length === 0) {
		lines.push('(none — every setting is at its default)');
	} else {
		for (const difference of input.settings) {
			lines.push('- ' + difference.key + ': ' + renderSettingValue(difference) + ' (default: ' + renderValue(difference.default) + ')');
		}
	}

	return lines.join('\n') + '\n';
}

/**
 * The engine's presence, version and — when it cannot load — failure class and message. The
 * addon loader caches its failure, so calling {@link loadAddon} here is free after the first
 * attempt, whatever built the backend at activation decided.
 */
function engineStatusOf(): Pick<DiagnosticsInput, 'engineAvailable' | 'engineVersion' | 'engineFailureClass' | 'engineFailureMessage'> {
	try {
		const addon = loadAddon();
		let version: string | null = null;
		try {
			version = addon.engineVersion();
		} catch (_) {
			// The binary loads but the version call failed: report availability without a version,
			// exactly as the Settings widget's backend section does.
		}
		return { engineAvailable: true, engineVersion: version, engineFailureClass: null, engineFailureMessage: null };
	} catch (error) {
		const failure = toBackendError(error);
		return { engineAvailable: false, engineVersion: null, engineFailureClass: failure.kind, engineFailureMessage: failure.message };
	}
}

/**
 * The method run when the `git-graph-rs.showDiagnostics` command is invoked: gather the facts
 * off the command host and the process, format them, and open the document in an untitled
 * editor. The whole document is prepared before anything is shown, so a failure surfaces as one
 * error notification instead of a half-empty editor.
 * @param host The services the command runs with.
 */
export async function showDiagnostics(host: CommandHost): Promise<void> {
	try {
		const extensionVersion = await getExtensionVersion(host.context).catch(() => 'unknown');
		const document = formatDiagnostics({
			extensionVersion: extensionVersion,
			vscodeVersion: vscode.version,
			electronVersion: process.versions.electron ?? null,
			nodeVersion: process.versions.node ?? null,
			platform: process.platform + '-' + process.arch,
			osDescription: os.type() + ' ' + os.release(),
			// The swappable read backend forwards `name` to whichever backend the current Git
			// situation built, so this is the backend the open panel's repository is served by.
			backendName: host.repo.read.name,
			panelRepo: host.panels.currentRepo(),
			...engineStatusOf(),
			gitPath: host.gitExecutable !== null ? host.gitExecutable.path : null,
			gitVersion: host.gitExecutable !== null ? host.gitExecutable.version : null,
			perfTraces: traces(),
			settings: nonDefaultSettings(host.config.current)
		});
		const textDocument = await vscode.workspace.openTextDocument({ content: document, language: 'markdown' });
		await vscode.window.showTextDocument(textDocument);
	} catch (_) {
		void showErrorMessage(t('diagnosticsError'));
	}
}

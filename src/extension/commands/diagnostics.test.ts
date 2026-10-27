/**
 * The Diagnostics command's pure halves: the snapshot-vs-defaults diff
 * and the document formatting. The vscode-dependent shell (`showDiagnostics`) stays thin and
 * untested, like the `version` command's — only the two functions the document is built from
 * are asserted here.
 */

import { describe, expect, it } from 'vitest';
import { CONFIG_SCHEMA } from '../platform/config';
import type { ConfigSnapshot } from '../platform/config';
import { formatDiagnostics, nonDefaultSettings } from './diagnostics';
import type { DiagnosticsInput } from './diagnostics';

/** A snapshot whose every field answers its schema default (no setting is non-default). */
function defaultSnapshot(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
	const snapshot: Record<string, unknown> = {};
	for (const field of Object.keys(CONFIG_SCHEMA)) {
		snapshot[field] = CONFIG_SCHEMA[field as keyof typeof CONFIG_SCHEMA].default;
	}
	return { ...snapshot, ...overrides } as unknown as ConfigSnapshot;
}

describe('nonDefaultSettings', () => {
	it('reports nothing for a snapshot at the defaults', () => {
		expect(nonDefaultSettings(defaultSnapshot())).toEqual([]);
	});

	it('lists exactly the differing settings, under their full dotted keys, with the schema default', () => {
		const differences = nonDefaultSettings(defaultSnapshot({
			repositoryCommitsInitialLoad: 500,
			graphStyle: 'angular'
		}));
		expect(differences).toEqual([
			{ key: 'git-graph-rs.graph.style', value: 'angular', default: 'rounded' },
			{ key: 'git-graph-rs.repository.commits.initialLoad', value: 500, default: 300 }
		]);
	});

	it('compares arrays and objects structurally, so an equal value under fresh identity is not reported', () => {
		const colours = [...CONFIG_SCHEMA.graphColours.default];
		const columns = { Commit: true, Date: true, Author: true };
		expect(nonDefaultSettings(defaultSnapshot({
			graphColours: colours,
			defaultColumnVisibility: columns
		}))).toEqual([]);
	});

	it('reports a record-valued setting whose contents differ from the empty default', () => {
		// The record type is total over the seven menu groups; only the branch row differs.
		const visibility = {
			branch: { checkout: false },
			commit: {}, commitDetailsViewFile: {}, remoteBranch: {}, stash: {}, tag: {}, uncommittedChanges: {}
		};
		const differences = nonDefaultSettings(defaultSnapshot({
			contextMenuActionsVisibility: visibility
		}));
		expect(differences).toEqual([
			{ key: 'git-graph-rs.contextMenuActionsVisibility', value: visibility, default: {} }
		]);
	});
});

/** A minimal all-set input, so each formatting test overrides only what it asserts. */
function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
	return {
		extensionVersion: '1.1.0',
		vscodeVersion: '1.90.0',
		electronVersion: '29.2.0',
		nodeVersion: '20.11.0',
		platform: 'win32-x64',
		osDescription: 'Windows 10.0.26200',
		backendName: 'rust (falling back to git-cli)',
		panelRepo: 'C:\\dev\\repo',
		engineAvailable: true,
		engineVersion: '0.3.0',
		engineFailureClass: null,
		engineFailureMessage: null,
		gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
		gitVersion: '2.45.0',
		perfTraces: [],
		settings: [],
		...overrides
	};
}

describe('formatDiagnostics', () => {
	it('renders the environment, backend and Git sections', () => {
		const document = formatDiagnostics(input());
		expect(document).toContain('- Git Graph RS: 1.1.0');
		expect(document).toContain('- VS Code: 1.90.0');
		expect(document).toContain('- Electron: 29.2.0');
		expect(document).toContain('- Node: 20.11.0');
		expect(document).toContain('- OS: Windows 10.0.26200 (win32-x64)');
		expect(document).toContain('- Backend in use: rust (falling back to git-cli)');
		expect(document).toContain('- Open panel repository: C:\\dev\\repo');
		expect(document).toContain('- Engine available: yes');
		expect(document).toContain('- Engine version: 0.3.0');
		expect(document).toContain('- Path: C:\\Program Files\\Git\\cmd\\git.exe');
		expect(document).toContain('- Version: 2.45.0');
	});

	it('renders the engine failure class and message when the engine cannot load', () => {
		const document = formatDiagnostics(input({
			engineAvailable: false,
			engineVersion: null,
			engineFailureClass: 'Unsupported',
			engineFailureMessage: 'No native engine was found for linux-arm64-gnu.'
		}));
		expect(document).toContain('- Engine available: no');
		expect(document).toContain('- Engine failure class: Unsupported');
		expect(document).toContain('- Engine failure: No native engine was found for linux-arm64-gnu.');
	});

	it('falls back to placeholder rows for the absent facts (no panel, no Git, unknown versions)', () => {
		const document = formatDiagnostics(input({
			panelRepo: null,
			gitPath: null,
			gitVersion: null,
			engineVersion: null,
			electronVersion: null,
			nodeVersion: null
		}));
		expect(document).toContain('- Open panel repository: (no panel open)');
		expect(document).toContain('- Engine version: (unknown)');
		expect(document).toContain('- Executable: (none found)');
		expect(document).toContain('- Electron: (unknown)');
		expect(document).toContain('- Node: (unknown)');
	});

	it('renders each recorded trace in the one-line shape the log analyser parses', () => {
		const document = formatDiagnostics(input({
			perfTraces: [
				{ name: 'boot', marks: [{ name: 'T0', t: 0, origin: 'host' }, { name: 'T3', t: 12.5, origin: 'host' }] },
				{ name: 'session', marks: [{ name: 'T4', t: 3, origin: 'webview' }] }
			]
		}));
		expect(document).toContain('## Performance traces (last 2)');
		expect(document).toContain('- boot: T0 +0.0ms, T3 +12.5ms');
		expect(document).toContain('- session: T4 +0.0ms (webview)');
	});

	it('explains the trace gate when nothing was recorded', () => {
		const document = formatDiagnostics(input());
		expect(document).toContain('## Performance traces (last 0)');
		expect(document).toContain('(none recorded — tracing and the session log follow the "git-graph-rs.enableLog" setting)');
	});

	it('lists each non-default setting with its default, and none at the defaults', () => {
		const withRows = formatDiagnostics(input({
			settings: [{ key: 'git-graph-rs.repository.commits.initialLoad', value: 500, default: 300 }]
		}));
		expect(withRows).toContain('## Non-default settings (1)');
		expect(withRows).toContain('- git-graph-rs.repository.commits.initialLoad: 500 (default: 300)');
		expect(formatDiagnostics(input())).toContain('(none — every setting is at its default)');
	});

	it('never echoes the GitLab token, reporting only that it is set', () => {
		const document = formatDiagnostics(input({
			settings: [{ key: 'git-graph-rs.avatars.gitlabToken', value: 'secret-token-value', default: '' }]
		}));
		expect(document).not.toContain('secret-token-value');
		expect(document).toContain('- git-graph-rs.avatars.gitlabToken: (redacted: 18 characters) (default: (empty))');
	});
});

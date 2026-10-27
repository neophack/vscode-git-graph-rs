import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The external repository configuration file seam, extracted from the former flat
 * src/repoManager.ts: generation, validation, application and the file-system round trip. The
 * write path localises its messages through the host i18n table, which reads the configuration
 * through the vscode API - a minimal fake 'vscode' module backs that chain here.
 */
const vscodeMock = vi.hoisted(() => ({
	env: { language: 'en', uriScheme: 'vscode' },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ViewColumn: { Active: 1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	workspace: {
		getConfiguration: (_section?: string, _scope?: unknown): unknown => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue
		})
	}
}));

vi.mock('vscode', () => vscodeMock);

import { DEFAULT_REPO_STATE } from '../platform/storage';
import { BooleanOverride, FileViewType, RepoCommitOrdering } from '../../shared/model/webview';
import { GitRepoState, PinnedCommit } from '../../shared/model/repoState';
import { PullRequestProvider } from '../../shared/model/pullRequest';
import {
	ExternalRepoConfig,
	REPO_CONFIG_VERSION,
	applyExternalConfigFile,
	generateExternalConfigFile,
	normalizeExternalConfigFile,
	pinsEqual,
	readExternalConfigFile,
	validateExternalConfigFile,
	writeExternalConfigFile
} from './repoConfigFile';

/** A repository state with every exportable field set away from its default. */
function fullyConfiguredState(): GitRepoState {
	return Object.assign({}, DEFAULT_REPO_STATE, {
		commitOrdering: RepoCommitOrdering.Date,
		fileViewType: FileViewType.List,
		hideRemotes: ['upstream'],
		includeCommitsMentionedByReflogs: BooleanOverride.Enabled,
		issueLinkingConfig: { issue: 'ISSUE-', url: 'https://example.com/issues/' },
		name: 'My Repo',
		onlyFollowFirstParent: BooleanOverride.Disabled,
		onRepoLoadShowCheckedOutBranch: BooleanOverride.Enabled,
		onRepoLoadShowSpecificBranches: ['main', 'dev'],
		pinnedBranches: ['main', 'release'],
		pinnedCommits: [{ hash: 'abc123', summary: 'Pin me', author: 'A', email: 'a@example.com', date: 1234567890 }] as PinnedCommit[],
		pullRequestConfig: {
			provider: PullRequestProvider.GitHub,
			custom: null,
			hostRootUrl: 'https://github.com',
			sourceRemote: 'origin',
			sourceOwner: 'owner',
			sourceRepo: 'repo',
			destRemote: null,
			destOwner: 'owner',
			destRepo: 'repo',
			destProjectId: '',
			destBranch: 'main'
		},
		showRemoteBranchesV2: BooleanOverride.Enabled,
		showStashes: BooleanOverride.Disabled,
		showTags: BooleanOverride.Enabled
	});
}

describe('generateExternalConfigFile', () => {
	it('exports only the pins (and the timestamp) from a default state', () => {
		const file = generateExternalConfigFile(DEFAULT_REPO_STATE);

		expect(Object.keys(file).sort()).toEqual(['exportedAt', 'pinnedBranches', 'pinnedCommits']);
		expect(file.pinnedBranches).toEqual([]);
		expect(file.pinnedCommits).toEqual([]);
		expect(typeof file.exportedAt).toBe('number');
	});

	it('exports every field set away from its default', () => {
		const state = fullyConfiguredState();
		const file = generateExternalConfigFile(state);

		expect(file.commitOrdering).toBe(RepoCommitOrdering.Date);
		expect(file.fileViewType).toBe(ExternalRepoConfig.FileViewType.List);
		expect(file.hideRemotes).toEqual(['upstream']);
		expect(file.includeCommitsMentionedByReflogs).toBe(true);
		expect(file.issueLinkingConfig).toEqual({ issue: 'ISSUE-', url: 'https://example.com/issues/' });
		expect(file.name).toBe('My Repo');
		expect(file.onlyFollowFirstParent).toBe(false);
		expect(file.onRepoLoadShowCheckedOutBranch).toBe(true);
		expect(file.onRepoLoadShowSpecificBranches).toEqual(['main', 'dev']);
		expect(file.pinnedBranches).toEqual(['main', 'release']);
		expect(file.showRemoteBranches).toBe(true);
		expect(file.showStashes).toBe(false);
		expect(file.showTags).toBe(true);
		expect(file.pullRequestConfig !== undefined && file.pullRequestConfig.provider).toBe(ExternalRepoConfig.PullRequestProvider.GitHub);
	});
});

describe('validateExternalConfigFile', () => {
	it('accepts a generated file', () => {
		expect(validateExternalConfigFile(generateExternalConfigFile(fullyConfiguredState()))).toBeNull();
	});

	it('names the first invalid field', () => {
		expect(validateExternalConfigFile({ commitOrdering: 'weird' as unknown as RepoCommitOrdering })).toBe('commitOrdering');
		expect(validateExternalConfigFile({ fileViewType: 'grid' as unknown as ExternalRepoConfig.FileViewType })).toBe('fileViewType');
		expect(validateExternalConfigFile({ hideRemotes: [42 as unknown as string] })).toBe('hideRemotes');
		expect(validateExternalConfigFile({ name: 7 as unknown as string })).toBe('name');
		expect(validateExternalConfigFile({ pinnedBranches: 'main' as unknown as string[] })).toBe('pinnedBranches');
		expect(validateExternalConfigFile({ pinnedCommits: [{ summary: 'no hash' } as unknown as PinnedCommit] })).toBe('pinnedCommits');
		expect(validateExternalConfigFile({ showTags: 'yes' as unknown as boolean })).toBe('showTags');
	});
});

describe('applyExternalConfigFile (round trip: generate -> validate -> apply)', () => {
	it('restores every exported field onto a default state', () => {
		const exported = fullyConfiguredState();
		const file = generateExternalConfigFile(exported);
		expect(validateExternalConfigFile(file)).toBeNull();

		const restored = Object.assign({}, DEFAULT_REPO_STATE);
		applyExternalConfigFile(file, restored);

		expect(restored.commitOrdering).toBe(exported.commitOrdering);
		expect(restored.fileViewType).toBe(exported.fileViewType);
		expect(restored.hideRemotes).toEqual(exported.hideRemotes);
		expect(restored.includeCommitsMentionedByReflogs).toBe(exported.includeCommitsMentionedByReflogs);
		expect(restored.issueLinkingConfig).toEqual(exported.issueLinkingConfig);
		expect(restored.name).toBe(exported.name);
		expect(restored.onlyFollowFirstParent).toBe(exported.onlyFollowFirstParent);
		expect(restored.onRepoLoadShowCheckedOutBranch).toBe(exported.onRepoLoadShowCheckedOutBranch);
		expect(restored.onRepoLoadShowSpecificBranches).toEqual(exported.onRepoLoadShowSpecificBranches);
		// Pins travel through the file, but applyExternalConfigFile deliberately leaves them
		// alone: the RepoManager imports pins through its own comparison flow (pinsEqual), so
		// applying an exported file must not resurrect pins the user removed since.
		expect(file.pinnedBranches).toEqual(exported.pinnedBranches);
		expect(file.pinnedCommits).toEqual(exported.pinnedCommits);
		expect(restored.pinnedBranches).toEqual(DEFAULT_REPO_STATE.pinnedBranches);
		expect(restored.pinnedCommits).toEqual(DEFAULT_REPO_STATE.pinnedCommits);
		expect(restored.pullRequestConfig).toEqual(exported.pullRequestConfig);
		expect(restored.showRemoteBranchesV2).toBe(exported.showRemoteBranchesV2);
		expect(restored.showStashes).toBe(exported.showStashes);
		expect(restored.showTags).toBe(exported.showTags);
	});

	it('leaves unset fields untouched', () => {
		const state = Object.assign({}, DEFAULT_REPO_STATE);
		applyExternalConfigFile({ name: 'Only a name' }, state);
		expect(state.name).toBe('Only a name');
		expect(state.commitOrdering).toBe(DEFAULT_REPO_STATE.commitOrdering);
		expect(state.showTags).toBe(DEFAULT_REPO_STATE.showTags);
	});
});

describe('pinsEqual', () => {
	it('compares pins by value, not by reference', () => {
		const a = { pinnedBranches: ['main'], pinnedCommits: [{ hash: 'a', summary: 's', author: undefined, email: undefined, date: undefined }] };
		const b = { pinnedBranches: ['main'], pinnedCommits: [{ hash: 'a', summary: 's', author: undefined, email: undefined, date: undefined }] };
		expect(pinsEqual(a, b)).toBe(true);
	});

	it('detects differing branches, commits and field values', () => {
		const base = { pinnedBranches: ['main'], pinnedCommits: [] };
		expect(pinsEqual(base, { pinnedBranches: ['dev'], pinnedCommits: [] })).toBe(false);
		expect(pinsEqual(base, { pinnedBranches: ['main', 'dev'], pinnedCommits: [] })).toBe(false);
		expect(pinsEqual(
			{ pinnedBranches: [], pinnedCommits: [{ hash: 'a', summary: 's', author: 'x', email: 'x@y', date: 1 }] },
			{ pinnedBranches: [], pinnedCommits: [{ hash: 'a', summary: 's', author: 'x', email: 'x@y', date: 2 }] }
		)).toBe(false);
	});
});

describe('writeExternalConfigFile / readExternalConfigFile', () => {
	it('round-trips a file through the repository\'s .vscode directory', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-repocfg-'));

		await expect(writeExternalConfigFile(repo, { name: 'Round tripped' })).resolves.toBeTypeOf('string');
		expect(fs.existsSync(path.join(repo, '.vscode', 'git-graph-rs.json'))).toBe(true);

		const read = await readExternalConfigFile(repo);
		expect(read).not.toBeNull();
		expect(read !== null && read.name).toBe('Round tripped');
	});

	it('answers NULL for a missing file and for unparseable contents', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-repocfg-'));

		expect(await readExternalConfigFile(repo)).toBeNull();

		fs.mkdirSync(path.join(repo, '.vscode'));
		fs.writeFileSync(path.join(repo, '.vscode', 'git-graph-rs.json'), 'not json {');
		expect(await readExternalConfigFile(repo)).toBeNull();

		fs.writeFileSync(path.join(repo, '.vscode', 'git-graph-rs.json'), '42');
		expect(await readExternalConfigFile(repo)).toBeNull();
	});
});

describe('versioned config file', () => {
	/** One sample directory per historical version: 1.0.27 (version 0), current (v1), v2-newer-writer. */
	const SAMPLE_DIRS = ['1.0.27', 'current', 'v2-newer-writer'];

	const samplePath = (...segments: string[]) => path.join(process.cwd(), 'test', 'fixtures', 'user-data', ...segments);

	function storedFile(repo: string): Record<string, unknown> {
		return JSON.parse(fs.readFileSync(path.join(repo, '.vscode', 'git-graph-rs.json'), 'utf8')) as Record<string, unknown>;
	}

	it.each(SAMPLE_DIRS)('round-trips the %s repoConfig.json sample through read → migrate → write → read', async (dir) => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-repocfg-'));
		fs.mkdirSync(path.join(repo, '.vscode'));
		fs.copyFileSync(samplePath(dir, 'repoConfig.json'), path.join(repo, '.vscode', 'git-graph-rs.json'));

		const first = await readExternalConfigFile(repo);
		expect(first).not.toBeNull();
		expect(validateExternalConfigFile(first!)).toBeNull();
		expect(first!.commitOrdering).toBe('date');
		expect(first!.name).toBe('Project');

		await writeExternalConfigFile(repo, { ...first! });
		const second = storedFile(repo);

		if (dir === 'v2-newer-writer') {
			// The lenient read preserved the newer writer's version and unknown field; the strict
			// write stamps the current version while the unknown field survives
			expect(first!.version).toBe(REPO_CONFIG_VERSION + 1);
			expect((first as unknown as Record<string, unknown>).gerritDraftPublish).toBe(true);
			expect(second.version).toBe(REPO_CONFIG_VERSION);
			expect(second.gerritDraftPublish).toBe(true);
		} else {
			// 1.0.27 (unversioned) and current (v1) records come out exactly as they went in
			expect(second).toEqual(first);
		}

		// From here the cycle is stable: another write changes nothing
		await writeExternalConfigFile(repo, { ...second } as ExternalRepoConfig.File);
		expect(storedFile(repo)).toEqual(second);
	});

	it('stamps the current version on a legacy field-only write', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-repocfg-'));

		await writeExternalConfigFile(repo, { name: 'Unversioned caller' });

		expect(storedFile(repo).version).toBe(REPO_CONFIG_VERSION);
		expect(storedFile(repo).name).toBe('Unversioned caller');
	});

	it('keeps unknown fields of a newer writer through a write', async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-repocfg-'));

		const newer = { name: 'From the future', gerritDraftPublish: true } as ExternalRepoConfig.File;
		await writeExternalConfigFile(repo, newer);

		const stored = storedFile(repo);
		expect(stored.version).toBe(REPO_CONFIG_VERSION);
		expect(stored.gerritDraftPublish).toBe(true);
	});

	it('validates the version field when present', () => {
		expect(validateExternalConfigFile({ version: REPO_CONFIG_VERSION })).toBeNull();
		expect(validateExternalConfigFile({ version: REPO_CONFIG_VERSION + 5 })).toBeNull();
		expect(validateExternalConfigFile({ version: 'two' as unknown as number })).toBe('version');
	});
});

describe('normalizeExternalConfigFile (lenient read)', () => {
	it('answers NULL for anything that is not a config record', () => {
		expect(normalizeExternalConfigFile(null)).toBeNull();
		expect(normalizeExternalConfigFile(42)).toBeNull();
		expect(normalizeExternalConfigFile('junk')).toBeNull();
		expect(normalizeExternalConfigFile(['not', 'a', 'record'])).toBeNull();
	});

	it('migrates an unversioned (1.0.27) record to the current version, unknown fields kept', () => {
		const normalized = normalizeExternalConfigFile({ 'name': 'From 1.0.27', 'unknownFutureField': 'kept' });
		expect(normalized !== null && normalized.version).toBe(REPO_CONFIG_VERSION);
		expect(normalized !== null && normalized.name).toBe('From 1.0.27');
		expect(normalized !== null && (normalized as Record<string, unknown>).unknownFutureField).toBe('kept');
	});

	it('keeps a newer writer\'s record exactly as-is (downgrade support)', () => {
		const newer = { version: REPO_CONFIG_VERSION + 1, name: 'From the future', gerritDraftPublish: true };
		expect(normalizeExternalConfigFile(newer)).toEqual(newer);
	});

	it('treats a junk version stamp as unversioned', () => {
		expect(normalizeExternalConfigFile({ version: 'two', name: 'X' })).toEqual({ version: REPO_CONFIG_VERSION, name: 'X' });
	});
});

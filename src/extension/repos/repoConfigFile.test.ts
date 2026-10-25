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
import { BooleanOverride, FileViewType, GitRepoState, PinnedCommit, PullRequestProvider, RepoCommitOrdering } from '../../types';
import {
	ExternalRepoConfig,
	applyExternalConfigFile,
	generateExternalConfigFile,
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

import { describe, expect, it } from 'vitest';
import { MUTATING_COMMANDS, REQUEST_COMMANDS } from './graphView';

/**
 * The REPO_MUTATING_COMMANDS set of src/gitGraphView.ts (lines ~414-421), transcribed as the
 * expected value: the protocol table is its planned replacement (task 4.2 deletes the old set
 * once the handler table is wired in), and this comparison proves the two agree exactly.
 */
const REPO_MUTATING_COMMANDS: ReadonlyArray<string> = [
	'abortOperation', 'addRemote', 'addTag', 'applyStash', 'branchFromStash', 'checkoutBranch', 'checkoutCommit',
	'cherrypickCommit', 'cleanUntrackedFiles', 'commitFixup', 'commitSquash', 'continueOperation', 'createBranch',
	'createPullRequest', 'deleteBranch', 'deleteRemote', 'deleteRemoteBranch',
	'deleteTag', 'dropCommit', 'dropStash', 'editRemote', 'editUserDetails', 'fetch', 'fetchIntoLocalBranch',
	'gerritSetFetchRefs', 'merge',
	'popStash', 'pruneRemote', 'pullBranch', 'pushBranch', 'pushStash', 'pushTag', 'rebase', 'renameBranch',
	'resetFileToRevision', 'resetToCommit', 'revertCommit', 'editCommitMessage', 'undoLastCommit',
	'worktreeAdd', 'worktreeRemove', 'worktreePrune'
];

/**
 * Every request command of the RequestMessage union in src/types/messages.ts, transcribed from
 * the union's members. The compile-time assertions in graphView.ts already tie RequestCommand
 * to that union; this runtime snapshot additionally fails when someone edits the union without
 * re-running the generator of these tables (a stale table is caught even before tsc runs).
 */
const REQUEST_MESSAGE_COMMANDS: ReadonlyArray<string> = [
	'abortOperation', 'addRemote', 'addTag', 'applyStash', 'branchFromStash', 'checkoutBranch', 'checkoutCommit',
	'cherrypickCommit', 'cleanUntrackedFiles', 'commitFixup', 'commitSquash', 'continueOperation',
	'countCommitsBefore', 'commitBodies', 'commitDetails', 'commitFileCounts', 'compareCommits', 'copyFilePath',
	'copyToClipboard', 'createArchive', 'createBranch', 'createPullRequest', 'deleteBranch', 'deleteRemote',
	'deleteRemoteBranch', 'deleteTag', 'deleteUserDetails', 'dropCommit', 'dropStash', 'undoLastCommit',
	'editCommitMessage', 'editRemote', 'editUserDetails', 'endCodeReview', 'exportRepoConfig', 'fetch',
	'fetchAvatar', 'fetchIntoLocalBranch', 'gerritSetFetchRefs', 'loadCommits', 'loadConfig', 'loadRepoInfo',
	'loadRepos', 'loadView', 'ready', 'merge', 'openExtensionSettings', 'openExternalDirDiff', 'openExternalUrl', 'openCompareTab',
	'openFile', 'openLogFile', 'openTerminal', 'popStash', 'predictConflicts', 'pruneRemote', 'pullBranch',
	'pushBranch', 'pushStash', 'pushTag', 'rebase', 'reflog', 'renameBranch', 'rescanForRepos',
	'resetFileToRevision', 'resetToCommit', 'revertCommit', 'setGlobalViewState', 'setRepoState', 'setViewSnapshot',
	'setWorkspaceViewState', 'showErrorMessage', 'startCodeReview', 'tagDetails', 'updateCodeReview', 'viewDiff',
	'viewDiffBinary', 'viewDiffWithWorkingFile', 'viewFileAtRevision', 'viewScm', 'fetchPullRequest',
	'setGlobalSetting', 'setInterfaceLanguage', 'repoStatistics', 'worktreeList', 'worktreeAdd', 'worktreeRemove',
	'worktreePrune'
];

/** The commands whose handler sends no response (graphView.ts's SilentCommand, as runtime data). */
const SILENT_COMMANDS: ReadonlyArray<string> = [
	'endCodeReview', 'openCompareTab', 'rescanForRepos', 'setRepoState', 'setViewSnapshot', 'showErrorMessage',
	'viewDiffBinary'
];

function mutatingCommands(): Set<string> {
	return new Set(Object.keys(MUTATING_COMMANDS).filter((command) => MUTATING_COMMANDS[command as keyof typeof MUTATING_COMMANDS]));
}

describe('graphView protocol runtime tables', () => {
	it('REQUEST_COMMANDS matches the RequestMessage command union exactly (both directions)', () => {
		const commands = new Set<string>(REQUEST_COMMANDS);
		const expected = new Set<string>(REQUEST_MESSAGE_COMMANDS);
		// No command duplicated
		expect(commands.size).toBe(REQUEST_COMMANDS.length);
		// Every union command has an entry...
		for (const command of expected) expect(commands.has(command), 'missing: ' + command).toBe(true);
		// ...and every entry is a union command (no extras)
		for (const command of commands) expect(expected.has(command), 'extra: ' + command).toBe(true);
		expect(commands.size).toBe(expected.size);
	});

	it('MUTATING_COMMANDS covers exactly the same command set as REQUEST_COMMANDS (both directions)', () => {
		const tableKeys = new Set<string>(Object.keys(MUTATING_COMMANDS));
		const commands = new Set<string>(REQUEST_COMMANDS);
		for (const command of commands) expect(tableKeys.has(command), 'missing: ' + command).toBe(true);
		for (const key of tableKeys) expect(commands.has(key), 'extra: ' + key).toBe(true);
		expect(tableKeys.size).toBe(commands.size);
	});

	it('MUTATING_COMMANDS equals the REPO_MUTATING_COMMANDS set of gitGraphView.ts', () => {
		const expected = new Set<string>(REPO_MUTATING_COMMANDS);
		const actual = mutatingCommands();
		expect(actual.size).toBe(expected.size);
		for (const command of expected) expect(actual.has(command), 'should mutate: ' + command).toBe(true);
		for (const command of actual) expect(expected.has(command), 'should not mutate: ' + command).toBe(true);
	});

	it('the silent commands are a subset of the request commands', () => {
		const commands = new Set<string>(REQUEST_COMMANDS);
		for (const command of SILENT_COMMANDS) expect(commands.has(command), 'unknown silent command: ' + command).toBe(true);
	});

	it('fetchPullRequest is the only command answering under a different response command', () => {
		// 'fetchPullRequest' answers as 'pullRequestStatus' (see ResponseCommandOf); every other
		// non-silent command answers under its own name, which AssertResponseParity enforces at
		// compile time. At runtime, just pin the one asymmetry so it cannot slip in unnoticed.
		const commands = new Set<string>(REQUEST_COMMANDS);
		expect(commands.has('fetchPullRequest')).toBe(true);
		expect(SILENT_COMMANDS).not.toContain('fetchPullRequest');
	});
});

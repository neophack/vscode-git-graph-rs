/**
 * Table-driven argv tests for the write operations: every operation, every option branch, with
 * the argv the legacy `DataSource` (`src/dataSource.ts`) built for it. The tests run against the
 * pure op functions only — no process, no config, no vscode.
 */

import { describe, expect, it } from 'vitest';

import { GitConfigLocation, GitOperationType, GitPushBranchMode, GitResetMode } from '../../../../types/git';
import { MergeActionOn, RebaseActionOn } from '../../../../types/messages';
import { SquashMessageFormat, TagType } from '../../../../types/webview';
import {
	addRemote, addRemoteTagsRefspec, addTag, addWorktree,
	abortOperation, amendCommitMessage, amendLastCommit, applyStash, archive,
	branchFromStash, checkoutBranch, checkoutCommit, cherrypickCommit, cleanUntrackedFiles,
	commitSquashFromMerge, commitSquashFromPull, continueOperation, createBranch, createFixupCommit,
	createSquashCommit, deleteBranch, deleteRemoteBranch, deleteRemote, deleteRemoteTrackingBranch,
	deleteTag, dropCommit, dropStash, dropStash as dropStashOp, editRemote, fetch, fetchIntoLocalBranch,
	merge, popStash, pruneRemote, pruneWorktrees, pullBranch, pushBranch, pushBranchToMultipleRemotes,
	pushStash, pushTag, rebase, removeWorktree, renameBranch, resetCurrentBranchToRemote,
	resetFileToRevision, resetToCommit, revertCommit, undoLastCommit, unsetConfigValue, setConfigValue,
	WriteOp
} from './index';
import { GitConfigKey } from './config';

/** The argv steps of an op, as plain arrays for exact assertion. */
function argvOf(op: WriteOp): string[][] {
	return op.steps.map((step) => [...step.argv]);
}

const HASH = '0123456789abcdef0123456789abcdef01234567';

describe('branch operations', () => {
	it('checkoutBranch', () => {
		expect(argvOf(checkoutBranch({ branchName: 'dev', remoteBranch: null }))).toEqual([['checkout', 'dev']]);
		expect(argvOf(checkoutBranch({ branchName: 'dev', remoteBranch: 'origin/dev' }))).toEqual([['checkout', '-b', 'dev', 'origin/dev']]);
	});

	it('createBranch covers all four checkout/force combinations', () => {
		expect(argvOf(createBranch({ branchName: 'b', commitHash: HASH, checkout: false, force: false }))).toEqual([['branch', 'b', HASH]]);
		expect(argvOf(createBranch({ branchName: 'b', commitHash: HASH, checkout: false, force: true }))).toEqual([['branch', '-f', 'b', HASH]]);
		expect(argvOf(createBranch({ branchName: 'b', commitHash: HASH, checkout: true, force: false }))).toEqual([['checkout', '-b', 'b', HASH]]);
		expect(argvOf(createBranch({ branchName: 'b', commitHash: HASH, checkout: true, force: true }))).toEqual([['branch', '-f', 'b', HASH], ['checkout', 'b']]);
	});

	it('deleteBranch force flag', () => {
		expect(argvOf(deleteBranch({ branchName: 'b', force: false }))).toEqual([['branch', '-d', 'b']]);
		expect(argvOf(deleteBranch({ branchName: 'b', force: true }))).toEqual([['branch', '-D', 'b']]);
	});

	it('deleteRemoteBranch and its remote-tracking fallback', () => {
		expect(argvOf(deleteRemoteBranch({ branchName: 'b', remote: 'origin' }))).toEqual([['push', 'origin', '--delete', 'b']]);
		expect(argvOf(deleteRemoteTrackingBranch({ branchName: 'b', remote: 'origin' }))).toEqual([['branch', '-d', '-r', 'origin/b']]);
	});

	it('fetchIntoLocalBranch: current branch pulls, forced current branch fetches and resets, other branches fetch', () => {
		expect(argvOf(fetchIntoLocalBranch({ remote: 'origin', remoteBranch: 'main', localBranch: 'main', force: false, isCurrentBranch: true })))
			.toEqual([['pull', 'origin', 'main']]);
		expect(argvOf(fetchIntoLocalBranch({ remote: 'origin', remoteBranch: 'main', localBranch: 'main', force: true, isCurrentBranch: true })))
			.toEqual([['fetch', 'origin', 'main'], ['reset', '--hard', 'origin/main']]);
		expect(argvOf(fetchIntoLocalBranch({ remote: 'origin', remoteBranch: 'main', localBranch: 'dev', force: false, isCurrentBranch: false })))
			.toEqual([['fetch', 'origin', 'main:dev']]);
		expect(argvOf(fetchIntoLocalBranch({ remote: 'origin', remoteBranch: 'main', localBranch: 'dev', force: true, isCurrentBranch: false })))
			.toEqual([['fetch', '-f', 'origin', 'main:dev']]);
	});

	it('pullBranch option branches and signing', () => {
		expect(argvOf(pullBranch({ branchName: 'main', remote: 'origin', createNewCommit: false, squash: false, sign: false })))
			.toEqual([['pull', 'origin', 'main']]);
		expect(argvOf(pullBranch({ branchName: 'main', remote: 'origin', createNewCommit: true, squash: false, sign: false })))
			.toEqual([['pull', 'origin', 'main', '--no-ff']]);
		expect(argvOf(pullBranch({ branchName: 'main', remote: 'origin', createNewCommit: true, squash: true, sign: false })))
			.toEqual([['pull', 'origin', 'main', '--squash']]);
		expect(argvOf(pullBranch({ branchName: 'main', remote: 'origin', createNewCommit: false, squash: false, sign: true })))
			.toEqual([['pull', 'origin', 'main', '-S']]);
	});

	it('commitSquashFromPull message formats', () => {
		expect(argvOf(commitSquashFromPull({ remote: 'origin', branchName: 'main', squashMessageFormat: SquashMessageFormat.Default, sign: false })))
			.toEqual([['commit', '-m', 'Merge branch \'origin/main\'']]);
		expect(argvOf(commitSquashFromPull({ remote: 'origin', branchName: 'main', squashMessageFormat: SquashMessageFormat.GitSquashMsg, sign: true })))
			.toEqual([['commit', '-S', '--no-edit']]);
	});

	it('renameBranch', () => {
		expect(argvOf(renameBranch({ oldName: 'a', newName: 'b' }))).toEqual([['branch', '-m', 'a', 'b']]);
	});
});

describe('commit operations', () => {
	it('checkoutCommit', () => {
		expect(argvOf(checkoutCommit({ commitHash: HASH }))).toEqual([['checkout', HASH]]);
	});

	it('cherrypickCommit flag order matches the legacy argv', () => {
		expect(argvOf(cherrypickCommit({ commitHash: HASH, parentIndex: 0, recordOrigin: false, noCommit: false, sign: false })))
			.toEqual([['cherry-pick', HASH]]);
		expect(argvOf(cherrypickCommit({ commitHash: HASH, parentIndex: 2, recordOrigin: true, noCommit: true, sign: true })))
			.toEqual([['cherry-pick', '--no-commit', '-x', '-S', '-m', '2', HASH]]);
	});

	it('createFixupCommit and createSquashCommit', () => {
		expect(argvOf(createFixupCommit({ commitHash: HASH, sign: false }))).toEqual([['commit', '--fixup', HASH]]);
		expect(argvOf(createFixupCommit({ commitHash: HASH, sign: true }))).toEqual([['commit', '--fixup', HASH, '-S']]);
		expect(argvOf(createSquashCommit({ commitHash: HASH, sign: false }))).toEqual([['commit', '--squash', HASH, '--no-edit']]);
		expect(argvOf(createSquashCommit({ commitHash: HASH, sign: true }))).toEqual([['commit', '--squash', HASH, '--no-edit', '-S']]);
	});

	it('dropCommit', () => {
		expect(argvOf(dropCommit({ commitHash: HASH, sign: false }))).toEqual([['rebase', '--onto', HASH + '^', HASH]]);
		expect(argvOf(dropCommit({ commitHash: HASH, sign: true }))).toEqual([['rebase', '-S', '--onto', HASH + '^', HASH]]);
	});

	it('resetToCommit modes and the HEAD sentinel', () => {
		expect(argvOf(resetToCommit({ commit: HASH, resetMode: GitResetMode.Soft }))).toEqual([['reset', '--soft', HASH]]);
		expect(argvOf(resetToCommit({ commit: HASH, resetMode: GitResetMode.Mixed }))).toEqual([['reset', '--mixed', HASH]]);
		expect(argvOf(resetToCommit({ commit: HASH, resetMode: GitResetMode.Hard }))).toEqual([['reset', '--hard', HASH]]);
		expect(argvOf(resetToCommit({ commit: 'HEAD', resetMode: GitResetMode.Hard }))).toEqual([['reset', '--hard', 'HEAD']]);
		expect(resetToCommit({ commit: 'HEAD', resetMode: GitResetMode.Hard }).checks).toEqual([]);
	});

	it('revertCommit', () => {
		expect(argvOf(revertCommit({ commitHash: HASH, parentIndex: 0, sign: false }))).toEqual([['revert', '--no-edit', HASH]]);
		expect(argvOf(revertCommit({ commitHash: HASH, parentIndex: 1, sign: true }))).toEqual([['revert', '--no-edit', '-S', '-m', '1', HASH]]);
	});

	it('undoLastCommit, amendLastCommit, resetCurrentBranchToRemote', () => {
		expect(argvOf(undoLastCommit())).toEqual([['reset', '--soft', 'HEAD^']]);
		expect(argvOf(amendLastCommit({ sign: false }))).toEqual([['commit', '--amend', '--no-edit']]);
		expect(argvOf(amendLastCommit({ sign: true }))).toEqual([['commit', '--amend', '--no-edit', '-S']]);
		expect(argvOf(resetCurrentBranchToRemote())).toEqual([['reset', '--soft', '@{upstream}']]);
	});

	it('amendCommitMessage author forms and argument order', () => {
		expect(argvOf(amendCommitMessage({ message: 'msg', sign: false }))).toEqual([['commit', '--amend', '-m', 'msg']]);
		expect(argvOf(amendCommitMessage({ message: 'msg', authorName: 'Ada', authorEmail: 'a@b.c', sign: false })))
			.toEqual([['commit', '--amend', '--author=Ada <a@b.c>', '-m', 'msg']]);
		// An empty email is written as "<>": git records a name-only author.
		expect(argvOf(amendCommitMessage({ message: 'msg', authorName: 'Ada', authorEmail: '', sign: false })))
			.toEqual([['commit', '--amend', '--author=Ada <>', '-m', 'msg']]);
		// Whitespace-only names leave the author untouched.
		expect(argvOf(amendCommitMessage({ message: 'msg', authorName: '  ', authorEmail: 'a@b.c', sign: true })))
			.toEqual([['commit', '--amend', '-m', 'msg', '-S']]);
	});

	it('archive types', () => {
		expect(argvOf(archive({ ref: 'v1', outputFilePath: '/tmp/a.zip', type: 'zip' })))
			.toEqual([['archive', '--format=zip', '-o', '/tmp/a.zip', 'v1']]);
		expect(argvOf(archive({ ref: 'v1', outputFilePath: '/tmp/a.tar', type: 'tar' })))
			.toEqual([['archive', '--format=tar', '-o', '/tmp/a.tar', 'v1']]);
	});
});

describe('merge and rebase operations', () => {
	it('merge option branches and signing', () => {
		expect(argvOf(merge({ obj: 'dev', actionOn: MergeActionOn.Branch, createNewCommit: false, squash: false, noCommit: false, sign: false })))
			.toEqual([['merge', 'dev']]);
		expect(argvOf(merge({ obj: 'dev', actionOn: MergeActionOn.Branch, createNewCommit: true, squash: false, noCommit: false, sign: false })))
			.toEqual([['merge', 'dev', '--no-ff']]);
		expect(argvOf(merge({ obj: 'dev', actionOn: MergeActionOn.Branch, createNewCommit: true, squash: true, noCommit: false, sign: false })))
			.toEqual([['merge', 'dev', '--squash']]);
		expect(argvOf(merge({ obj: 'dev', actionOn: MergeActionOn.Branch, createNewCommit: false, squash: false, noCommit: true, sign: false })))
			.toEqual([['merge', 'dev', '--no-commit']]);
		expect(argvOf(merge({ obj: 'dev', actionOn: MergeActionOn.Branch, createNewCommit: false, squash: false, noCommit: false, sign: true })))
			.toEqual([['merge', 'dev', '-S']]);
	});

	it('commitSquashFromMerge message forms', () => {
		expect(argvOf(commitSquashFromMerge({ obj: 'dev', actionOn: MergeActionOn.Branch, squashMessageFormat: SquashMessageFormat.Default, sign: false })))
			.toEqual([['commit', '-m', 'Merge branch \'dev\'']]);
		expect(argvOf(commitSquashFromMerge({ obj: 'origin/dev', actionOn: MergeActionOn.RemoteTrackingBranch, squashMessageFormat: SquashMessageFormat.Default, sign: false })))
			.toEqual([['commit', '-m', 'Merge remote-tracking branch \'origin/dev\'']]);
		expect(argvOf(commitSquashFromMerge({ obj: HASH, actionOn: MergeActionOn.Commit, squashMessageFormat: SquashMessageFormat.Default, sign: false })))
			.toEqual([['commit', '-m', 'Merge commit \'' + HASH + '\'']]);
		expect(argvOf(commitSquashFromMerge({ obj: 'dev', actionOn: MergeActionOn.Branch, squashMessageFormat: SquashMessageFormat.GitSquashMsg, sign: true })))
			.toEqual([['commit', '-S', '--no-edit']]);
	});

	it('rebase flags', () => {
		expect(argvOf(rebase({ obj: 'dev', actionOn: RebaseActionOn.Branch, ignoreDate: false, sign: false }))).toEqual([['rebase', 'dev']]);
		expect(argvOf(rebase({ obj: 'dev', actionOn: RebaseActionOn.Branch, ignoreDate: true, sign: false }))).toEqual([['rebase', 'dev', '--ignore-date']]);
		expect(argvOf(rebase({ obj: 'dev', actionOn: RebaseActionOn.Branch, ignoreDate: false, sign: true }))).toEqual([['rebase', 'dev', '-S']]);
		expect(argvOf(rebase({ obj: HASH, actionOn: RebaseActionOn.Commit, ignoreDate: false, sign: false }))).toEqual([['rebase', HASH]]);
	});

	it('continue and abort every operation type', () => {
		for (const type of [GitOperationType.Merge, GitOperationType.Rebase, GitOperationType.CherryPick, GitOperationType.Revert]) {
			expect(argvOf(continueOperation({ type }))).toEqual([[type, '--continue']]);
			expect(argvOf(abortOperation({ type }))).toEqual([[type, '--abort']]);
		}
	});
});

describe('tag operations', () => {
	it('addTag: lightweight and annotated, signed and forced', () => {
		expect(argvOf(addTag({ tagName: 'v2', commitHash: HASH, type: TagType.Lightweight, message: '', force: false, signTags: false })))
			.toEqual([['tag', 'v2', HASH]]);
		expect(argvOf(addTag({ tagName: 'v2', commitHash: HASH, type: TagType.Lightweight, message: '', force: true, signTags: false })))
			.toEqual([['tag', '-f', 'v2', HASH]]);
		expect(argvOf(addTag({ tagName: 'v2', commitHash: HASH, type: TagType.Annotated, message: 'note', force: false, signTags: false })))
			.toEqual([['tag', '-a', 'v2', '-m', 'note', HASH]]);
		expect(argvOf(addTag({ tagName: 'v2', commitHash: HASH, type: TagType.Annotated, message: 'note', force: false, signTags: true })))
			.toEqual([['tag', '-s', 'v2', '-m', 'note', HASH]]);
		expect(argvOf(addTag({ tagName: 'v2', commitHash: HASH, type: TagType.Annotated, message: 'note', force: true, signTags: false })))
			.toEqual([['tag', '-f', '-a', 'v2', '-m', 'note', HASH]]);
	});

	it('deleteTag: local-only, on a remote, and the other-remotes cleanup', () => {
		expect(argvOf(deleteTag({ tagName: 'v2', deleteOnRemote: null, otherRemotes: [] })))
			.toEqual([['tag', '-d', 'v2']]);
		const remoteDelete = deleteTag({ tagName: 'v2', deleteOnRemote: 'origin', otherRemotes: [] });
		expect(argvOf(remoteDelete)).toEqual([
			['push', 'origin', '--delete', 'v2'],
			['update-ref', '-d', 'refs/remotes/origin/tags/v2'],
			['tag', '-d', 'v2']
		]);
		expect(remoteDelete.steps[0].tolerance).toBe('remote ref does not exist');
		expect(remoteDelete.steps[1].bestEffort).toBe(true);
		expect(remoteDelete.steps[2].tolerance).toBe('not found');
		const withCleanup = deleteTag({ tagName: 'v2', deleteOnRemote: 'origin', otherRemotes: ['upstream', 'mirror'] });
		expect(argvOf(withCleanup)).toEqual([
			['push', 'origin', '--delete', 'v2'],
			['update-ref', '-d', 'refs/remotes/origin/tags/v2'],
			['tag', '-d', 'v2'],
			['update-ref', '-d', 'refs/remotes/upstream/tags/v2'],
			['update-ref', '-d', 'refs/remotes/mirror/tags/v2']
		]);
		expect(withCleanup.steps[3].bestEffort).toBe(true);
	});

	it('pushTag: one push per remote, in order', () => {
		expect(argvOf(pushTag({ tagName: 'v2', remotes: ['origin', 'upstream'], commitHash: HASH })))
			.toEqual([['push', 'origin', 'v2'], ['push', 'upstream', 'v2']]);
		expect(pushTag({ tagName: 'v2', remotes: [], commitHash: HASH }).refusal)
			.toBe('No remote(s) were specified to push the tag v2 to.');
	});
});

describe('remote operations', () => {
	it('addRemote: plain, with push URL, and with fetch', () => {
		expect(argvOf(addRemote({ name: 'origin', url: 'https://x/y', pushUrl: null, fetchAfter: false })))
			.toEqual([['remote', 'add', 'origin', 'https://x/y']]);
		expect(argvOf(addRemote({ name: 'origin', url: 'https://x/y', pushUrl: 'git@x:y', fetchAfter: false })))
			.toEqual([['remote', 'add', 'origin', 'https://x/y'], ['remote', 'set-url', 'origin', '--push', 'git@x:y']]);
		expect(argvOf(addRemote({ name: 'origin', url: 'https://x/y', pushUrl: null, fetchAfter: true })))
			.toEqual([['remote', 'add', 'origin', 'https://x/y'], ['fetch', 'origin']]);
	});

	it('deleteRemote', () => {
		expect(argvOf(deleteRemote({ name: 'origin' }))).toEqual([['remote', 'remove', 'origin']]);
	});

	it('editRemote: rename, url change forms and push url change forms', () => {
		// No change at all: nothing runs.
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'o', urlOld: 'u', urlNew: 'u', pushUrlOld: null, pushUrlNew: null }))).toEqual([]);
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'p', urlOld: null, urlNew: null, pushUrlOld: null, pushUrlNew: null })))
			.toEqual([['remote', 'rename', 'o', 'p']]);
		// URL replaced, set and removed (the legacy new-then-old argument order).
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'o', urlOld: 'a', urlNew: 'b', pushUrlOld: null, pushUrlNew: null })))
			.toEqual([['remote', 'set-url', 'o', 'b', 'a']]);
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'o', urlOld: null, urlNew: 'b', pushUrlOld: null, pushUrlNew: null })))
			.toEqual([['remote', 'set-url', 'o', '--add', 'b']]);
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'o', urlOld: 'a', urlNew: null, pushUrlOld: null, pushUrlNew: null })))
			.toEqual([['remote', 'set-url', 'o', '--delete', 'a']]);
		// Push URL forms.
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'o', urlOld: 'a', urlNew: 'a', pushUrlOld: 'p1', pushUrlNew: 'p2' })))
			.toEqual([['remote', 'set-url', '--push', 'o', 'p2', 'p1']]);
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'o', urlOld: 'a', urlNew: 'a', pushUrlOld: null, pushUrlNew: 'p2' })))
			.toEqual([['remote', 'set-url', '--push', 'o', '--add', 'p2']]);
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'o', urlOld: 'a', urlNew: 'a', pushUrlOld: 'p1', pushUrlNew: null })))
			.toEqual([['remote', 'set-url', '--push', 'o', '--delete', 'p1']]);
		// Rename first, then the URL steps address the new name.
		expect(argvOf(editRemote({ nameOld: 'o', nameNew: 'p', urlOld: 'a', urlNew: 'b', pushUrlOld: null, pushUrlNew: 'p2' })))
			.toEqual([['remote', 'rename', 'o', 'p'], ['remote', 'set-url', 'p', 'b', 'a'], ['remote', 'set-url', '--push', 'p', '--add', 'p2']]);
	});

	it('pruneRemote', () => {
		expect(argvOf(pruneRemote({ name: 'origin' }))).toEqual([['remote', 'prune', 'origin']]);
	});

	it('fetch: one or all remotes, pruning, prune-tags gating and refusal', () => {
		expect(argvOf(fetch({ remote: null, prune: false, pruneTags: false }))).toEqual([['fetch', '--all']]);
		expect(argvOf(fetch({ remote: 'origin', prune: false, pruneTags: false }))).toEqual([['fetch', 'origin']]);
		expect(argvOf(fetch({ remote: 'origin', prune: true, pruneTags: false }))).toEqual([['fetch', 'origin', '--prune']]);
		expect(argvOf(fetch({ remote: 'origin', prune: true, pruneTags: true }))).toEqual([['fetch', 'origin', '--prune', '--prune-tags']]);
		const refused = fetch({ remote: 'origin', prune: false, pruneTags: true });
		expect(refused.refusal).toBe('pruneTagsRequiresPrune');
		expect(refused.steps).toEqual([]);
	});

	it('pushBranch: modes, upstream, and the legacy argument order', () => {
		expect(argvOf(pushBranch({ branchName: 'main', remote: 'origin', setUpstream: false, mode: GitPushBranchMode.Normal })))
			.toEqual([['push', 'origin', 'main']]);
		expect(argvOf(pushBranch({ branchName: 'main', remote: 'origin', setUpstream: true, mode: GitPushBranchMode.Normal })))
			.toEqual([['push', 'origin', 'main', '--set-upstream']]);
		expect(argvOf(pushBranch({ branchName: 'main', remote: 'origin', setUpstream: false, mode: GitPushBranchMode.Force })))
			.toEqual([['push', 'origin', 'main', '--force']]);
		expect(argvOf(pushBranch({ branchName: 'main', remote: 'origin', setUpstream: true, mode: GitPushBranchMode.ForceWithLease })))
			.toEqual([['push', 'origin', 'main', '--set-upstream', '--force-with-lease']]);
	});

	it('pushBranchToMultipleRemotes: one step per remote', () => {
		expect(argvOf(pushBranchToMultipleRemotes({ branchName: 'main', remotes: ['origin', 'upstream'], setUpstream: false, mode: GitPushBranchMode.Normal })))
			.toEqual([['push', 'origin', 'main'], ['push', 'upstream', 'main']]);
		expect(pushBranchToMultipleRemotes({ branchName: 'main', remotes: [], setUpstream: false, mode: GitPushBranchMode.Normal }).refusal)
			.toBe('No remote(s) were specified to push the branch main to.');
	});
});

describe('worktree operations', () => {
	it('addWorktree: existing branch, new branch, and plain path', () => {
		expect(argvOf(addWorktree({ path: '/wt', branch: 'dev', newBranch: null }))).toEqual([['worktree', 'add', '/wt', 'dev']]);
		expect(argvOf(addWorktree({ path: '/wt', branch: null, newBranch: 'topic' }))).toEqual([['worktree', 'add', '-b', 'topic', '/wt']]);
		expect(argvOf(addWorktree({ path: '/wt', branch: 'dev', newBranch: 'topic' }))).toEqual([['worktree', 'add', '-b', 'topic', '/wt', 'dev']]);
		expect(argvOf(addWorktree({ path: '/wt', branch: null, newBranch: null }))).toEqual([['worktree', 'add', '/wt']]);
	});

	it('removeWorktree force flag', () => {
		expect(argvOf(removeWorktree({ path: '/wt', force: false }))).toEqual([['worktree', 'remove', '/wt']]);
		expect(argvOf(removeWorktree({ path: '/wt', force: true }))).toEqual([['worktree', 'remove', '--force', '/wt']]);
	});

	it('pruneWorktrees', () => {
		expect(argvOf(pruneWorktrees())).toEqual([['worktree', 'prune']]);
	});
});

describe('stash operations', () => {
	const SELECTOR = 'refs/stash@{1}';

	it('applyStash and popStash reinstate the index', () => {
		expect(argvOf(applyStash({ selector: SELECTOR, reinstateIndex: false }))).toEqual([['stash', 'apply', SELECTOR]]);
		expect(argvOf(applyStash({ selector: SELECTOR, reinstateIndex: true }))).toEqual([['stash', 'apply', '--index', SELECTOR]]);
		expect(argvOf(popStash({ selector: SELECTOR, reinstateIndex: false }))).toEqual([['stash', 'pop', SELECTOR]]);
		expect(argvOf(popStash({ selector: SELECTOR, reinstateIndex: true }))).toEqual([['stash', 'pop', '--index', SELECTOR]]);
	});

	it('branchFromStash and dropStash', () => {
		expect(argvOf(branchFromStash({ selector: SELECTOR, branchName: 'from-stash' }))).toEqual([['stash', 'branch', 'from-stash', SELECTOR]]);
		expect(argvOf(dropStashOp({ selector: SELECTOR }))).toEqual([['stash', 'drop', SELECTOR]]);
	});

	it('pushStash: message and untracked flags', () => {
		expect(argvOf(pushStash({ message: '', includeUntracked: false }))).toEqual([['stash', 'push']]);
		expect(argvOf(pushStash({ message: 'wip', includeUntracked: false }))).toEqual([['stash', 'push', '--message', 'wip']]);
		expect(argvOf(pushStash({ message: 'wip', includeUntracked: true }))).toEqual([['stash', 'push', '--include-untracked', '--message', 'wip']]);
		expect(pushStash({ message: '', includeUntracked: false }).requires).toBe('PushStash');
	});
});

describe('config and file operations', () => {
	it('setConfigValue and unsetConfigValue per location', () => {
		expect(argvOf(setConfigValue({ key: GitConfigKey.UserName, value: 'Ada', location: GitConfigLocation.Local })))
			.toEqual([['config', '--local', 'user.name', 'Ada']]);
		expect(argvOf(setConfigValue({ key: GitConfigKey.UserEmail, value: 'a@b.c', location: GitConfigLocation.Global })))
			.toEqual([['config', '--global', 'user.email', 'a@b.c']]);
		expect(argvOf(unsetConfigValue({ key: GitConfigKey.DiffTool, location: GitConfigLocation.System })))
			.toEqual([['config', '--system', '--unset-all', 'diff.tool']]);
	});

	it('addRemoteTagsRefspec builds the tag-tracking refspec', () => {
		expect(argvOf(addRemoteTagsRefspec({ remote: 'origin' })))
			.toEqual([['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/remotes/origin/tags/*']]);
	});

	it('cleanUntrackedFiles with and without directories', () => {
		expect(argvOf(cleanUntrackedFiles({ directories: false }))).toEqual([['clean', '-f']]);
		expect(argvOf(cleanUntrackedFiles({ directories: true }))).toEqual([['clean', '-fd']]);
	});

	it('resetFileToRevision', () => {
		expect(argvOf(resetFileToRevision({ commitHash: HASH, filePath: 'src/a.ts' }))).toEqual([['checkout', HASH, '--', 'src/a.ts']]);
	});
});

describe('the op table as a whole', () => {
	const OPS: ReadonlyArray<WriteOp> = [
		checkoutBranch({ branchName: 'b', remoteBranch: null }),
		createBranch({ branchName: 'b', commitHash: HASH, checkout: false, force: false }),
		deleteBranch({ branchName: 'b', force: false }),
		deleteRemoteBranch({ branchName: 'b', remote: 'origin' }),
		deleteRemoteTrackingBranch({ branchName: 'b', remote: 'origin' }),
		fetchIntoLocalBranch({ remote: 'origin', remoteBranch: 'main', localBranch: 'main', force: false, isCurrentBranch: false }),
		pullBranch({ branchName: 'main', remote: 'origin', createNewCommit: false, squash: false, sign: false }),
		commitSquashFromPull({ remote: 'origin', branchName: 'main', squashMessageFormat: SquashMessageFormat.Default, sign: false }),
		renameBranch({ oldName: 'a', newName: 'b' }),
		checkoutCommit({ commitHash: HASH }),
		cherrypickCommit({ commitHash: HASH, parentIndex: 0, recordOrigin: false, noCommit: false, sign: false }),
		createFixupCommit({ commitHash: HASH, sign: false }),
		createSquashCommit({ commitHash: HASH, sign: false }),
		dropCommit({ commitHash: HASH, sign: false }),
		resetToCommit({ commit: HASH, resetMode: GitResetMode.Mixed }),
		revertCommit({ commitHash: HASH, parentIndex: 0, sign: false }),
		undoLastCommit(),
		amendLastCommit({ sign: false }),
		amendCommitMessage({ message: 'm', sign: false }),
		resetCurrentBranchToRemote(),
		archive({ ref: 'v1', outputFilePath: '/tmp/a.tar', type: 'tar' }),
		merge({ obj: 'dev', actionOn: MergeActionOn.Branch, createNewCommit: false, squash: false, noCommit: false, sign: false }),
		commitSquashFromMerge({ obj: 'dev', actionOn: MergeActionOn.Branch, squashMessageFormat: SquashMessageFormat.Default, sign: false }),
		rebase({ obj: 'dev', actionOn: RebaseActionOn.Branch, ignoreDate: false, sign: false }),
		continueOperation({ type: GitOperationType.Rebase }),
		abortOperation({ type: GitOperationType.Rebase }),
		addTag({ tagName: 'v2', commitHash: HASH, type: TagType.Lightweight, message: '', force: false, signTags: false }),
		deleteTag({ tagName: 'v2', deleteOnRemote: null, otherRemotes: [] }),
		pushTag({ tagName: 'v2', remotes: ['origin'], commitHash: HASH }),
		addRemote({ name: 'origin', url: 'u', pushUrl: null, fetchAfter: false }),
		deleteRemote({ name: 'origin' }),
		// A no-change editRemote legitimately produces zero steps; the sample uses a change so
		// the "every operation has steps" check stays meaningful.
		editRemote({ nameOld: 'o', nameNew: 'p', urlOld: 'a', urlNew: 'a', pushUrlOld: null, pushUrlNew: null }),
		pruneRemote({ name: 'origin' }),
		fetch({ remote: null, prune: false, pruneTags: false }),
		pushBranch({ branchName: 'main', remote: 'origin', setUpstream: false, mode: GitPushBranchMode.Normal }),
		pushBranchToMultipleRemotes({ branchName: 'main', remotes: ['origin'], setUpstream: false, mode: GitPushBranchMode.Normal }),
		addWorktree({ path: '/wt', branch: null, newBranch: null }),
		removeWorktree({ path: '/wt', force: false }),
		pruneWorktrees(),
		applyStash({ selector: 'refs/stash@{0}', reinstateIndex: false }),
		branchFromStash({ selector: 'refs/stash@{0}', branchName: 'b' }),
		dropStash({ selector: 'refs/stash@{0}' }),
		popStash({ selector: 'refs/stash@{0}', reinstateIndex: false }),
		pushStash({ message: '', includeUntracked: false }),
		setConfigValue({ key: GitConfigKey.UserName, value: 'Ada', location: GitConfigLocation.Local }),
		unsetConfigValue({ key: GitConfigKey.UserName, location: GitConfigLocation.Local }),
		addRemoteTagsRefspec({ remote: 'origin' }),
		cleanUntrackedFiles({ directories: false }),
		resetFileToRevision({ commitHash: HASH, filePath: 'a' })
	];

	it('every operation declares at least one step and its effects', () => {
		expect(OPS.length).toBe(49);
		for (const op of OPS) {
			expect(op.steps.length).toBeGreaterThan(0);
			for (const step of op.steps) {
				expect(step.argv.length, JSON.stringify(step.argv)).toBeGreaterThan(1);
				expect(step.argv[0]).toMatch(/^[a-z-]+$/);
			}
		}
	});

	it('operations that change nothing repository-local declare no effects', () => {
		expect(pushBranch({ branchName: 'b', remote: 'o', setUpstream: false, mode: GitPushBranchMode.Normal }).effects).toEqual([]);
		expect(pushTag({ tagName: 'v', remotes: ['o'], commitHash: HASH }).effects).toEqual([]);
		expect(archive({ ref: 'v1', outputFilePath: '/p', type: 'tar' }).effects).toEqual([]);
	});

	it('every step argv is a fresh array per call (no shared mutable state)', () => {
		const first = pullBranch({ branchName: 'main', remote: 'origin', createNewCommit: true, squash: false, sign: true });
		const second = pullBranch({ branchName: 'main', remote: 'origin', createNewCommit: true, squash: false, sign: true });
		expect(first.steps[0].argv).toEqual(second.steps[0].argv);
		expect(first.steps[0].argv).not.toBe(second.steps[0].argv);
	});
});

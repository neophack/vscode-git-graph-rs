/**
 * The worktree/file-domain scenarios (task 4.10): the worktrees.ts operations (add, remove,
 * prune) and the files.ts operations (cleanUntrackedFiles, resetFileToRevision), each with a
 * success and a failure scenario. Worktree paths live OUTSIDE the repository
 * (`../ggs-auto-worktree`, the catalog's existing convention — the reseed removes the directory).
 */

import { MENUS_UNCOMMITTED_ACTIONS } from '../catalog/menusUncommitted';
import { WORKTREE_ACTIONS } from '../catalog/worktree';
import { byId, scenario } from '../scenario';

export const WORKTREE_FILE_SCENARIOS = [
	/* ---------------- addWorktree ---------------- */
	scenario(byId(WORKTREE_ACTIONS, 'worktree/add'), {
		ops: ['addWorktree'],
		then: {
			// The worktree's branch exists and is NOT checked out anywhere (the main worktree
			// keeps main); the worktree directory itself is outside the repository.
			git: [{ kind: 'refPresent', ref: 'automation-worktree-branch' }, { kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'worktree/add-invalid-branch',
		title: 'Add Worktree (refused: invalid branch name)',
		group: 'worktree',
		tags: ['worktree', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'worktreeAdd', repo: '{{repo}}', path: '../ggs-auto-worktree-bad', branch: '{{branchHead}}', newBranch: 'bad..name' }],
		expect: { responses: ['worktreeAdd'] },
		allowErrorOn: ['worktreeAdd']
	}, {
		ops: ['addWorktree'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'bad..name' }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- removeWorktree ---------------- */
	scenario(byId(WORKTREE_ACTIONS, 'worktree/remove'), {
		ops: ['addWorktree', 'removeWorktree'],
		// The remove action's request path removes ../ggs-auto-worktree — the worktree the
		// earlier add created. On a scenario-isolated run (§6.8.3's per-scenario reset) the add
		// is part of this scenario's when, so the remove always has its target.
		then: {
			git: [{ kind: 'refPresent', ref: 'automation-worktree-branch' }, { kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'worktree/remove-nonexistent',
		title: 'Remove Worktree (refused: no such worktree)',
		group: 'worktree',
		tags: ['worktree', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'worktreeRemove', repo: '{{repo}}', path: '../no-such-worktree', force: false }],
		expect: { responses: ['worktreeRemove'] },
		allowErrorOn: ['worktreeRemove']
	}, {
		ops: ['removeWorktree'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- pruneWorktrees ---------------- */
	scenario(byId(WORKTREE_ACTIONS, 'worktree/prune'), {
		ops: ['pruneWorktrees'],
		then: {
			// Pruning a clean worktree registry is the designed no-op success: the repository's
			// branches and HEAD keep their shape.
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'refPresent', ref: '{{branch}}' }]
		}
	}),
	scenario({
		id: 'worktree/prune-nothing',
		title: 'Prune Worktrees (nothing to prune: the designed no-op)',
		group: 'worktree',
		tags: ['worktree', 'failure', 'dialog'],
		mutable: true,
		// `git worktree prune` never fails on an empty registry — the failure-adjacent branch is
		// the no-op itself, pinned by the state assertions (the earlier remove already proved the
		// removal path; this pins that prune touches nothing else).
		request: [{ command: 'worktreePrune', repo: '{{repo}}' }],
		expect: { responses: ['worktreePrune'] }
	}, {
		ops: ['pruneWorktrees'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'stashCount', count: 3 }]
		}
	}),

	/* ---------------- cleanUntrackedFiles ---------------- */
	scenario(byId(MENUS_UNCOMMITTED_ACTIONS, 'menu-uncommitted/clean-untracked'), {
		ops: ['cleanUntrackedFiles'],
		then: {
			// git clean -fd: the untracked fixture file is gone; the submodule's tree survives as
			// a registered worktree (git does not clean submodules with -fd alone).
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'stashCount', count: 3 }]
		}
	}),
	scenario({
		id: 'menu-uncommitted/clean-already-clean',
		title: 'Delete Untracked Files (already clean: the designed no-op)',
		group: 'menu-uncommitted',
		tags: ['menu-uncommitted', 'failure', 'context-menu', 'dialog'],
		mutable: true,
		// After the seed's own clean worktree state the clean is a no-op — the failure-adjacent
		// branch where there is nothing to delete (directories: false narrows it further).
		request: [{ command: 'cleanUntrackedFiles', repo: '{{repo}}', directories: false }],
		expect: { responses: ['cleanUntrackedFiles'] }
	}, {
		ops: ['cleanUntrackedFiles'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'stashCount', count: 3 }]
		}
	}),

	/* ---------------- resetFileToRevision ---------------- */
	scenario({
		id: 'cdv/reset-file-to-revision',
		title: 'Reset File to Revision (the working-tree file returns to the commit)',
		group: 'cdv',
		tags: ['cdv', 'context-menu'],
		mutable: true,
		// Reset the context file to a revision older than its newest change: the worktree file's
		// content reverts (a staged change) — the Commit Details context menu's file action.
		given: { branch: 'main' },
		request: [{ command: 'resetFileToRevision', repo: '{{repo}}', commitHash: '{{commitParent}}', filePath: '{{file}}' }],
		expect: { responses: ['resetFileToRevision'] }
	}, {
		ops: ['resetFileToRevision'],
		then: {
			git: [{ kind: 'worktreeStatus', clean: false }, { kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'cdv/reset-file-nonexistent',
		title: 'Reset File to Revision (refused: no such file path)',
		group: 'cdv',
		tags: ['cdv', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'resetFileToRevision', repo: '{{repo}}', commitHash: '{{commitParent}}', filePath: 'no/such/file.txt' }],
		expect: { responses: ['resetFileToRevision'] },
		allowErrorOn: ['resetFileToRevision']
	}, {
		ops: ['resetFileToRevision'],
		then: {
			// The seeded worktree keeps exactly its untracked entry — nothing was staged.
			git: [{ kind: 'worktreeStatus', contains: ['?? untracked-fixture.txt'] }]
		}
	})
];

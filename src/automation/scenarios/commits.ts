/**
 * The commit-domain scenarios (task 4.10): every commit write operation of
 * src/extension/git/write/ops/commits.ts with a success and a failure scenario. The failure
 * forms are the designed refusals — nonexistent revisions (git's "bad revision"), nothing
 * staged to commit, a missing committer identity, a root HEAD with no parent to reset to — each
 * accepted via allowErrorOn and judged by then.git to have left the repository unchanged.
 *
 * The amend pair rides the Source Control title-menu commands (amendLastCommit and
 * resetCurrentBranchToRemote are command-driven, not protocol requests); the archive triple is
 * the flow the former nativeSaveDialog skip existed for — its save dialog is answered by the
 * ScriptedUiPort, including the CANCEL branch.
 */

import { MENUS_COMMIT_ACTIONS } from '../catalog/menusCommit';
import { MENUS_BRANCH_ACTIONS } from '../catalog/menusBranch';
import { MENUS_VSCODE_ACTIONS } from '../catalog/menusVscode';
import { byId, scenario } from '../scenario';

/** A syntactically valid hash git guarantees not to resolve ("bad revision" on every repository). */
const NO_SUCH_HASH = '1234567890123456789012345678901234567890';

export const COMMIT_SCENARIOS = [
	/* ---------------- checkoutCommit ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/checkout'), {
		ops: ['checkoutCommit'],
		then: {
			// The checkout detaches HEAD at {{commit}}: my headIs judgment accepts the hash itself.
			git: [{ kind: 'headIs', name: '{{commit}}' }, { kind: 'refPresent', ref: 'main' }]
		}
	}),
	scenario({
		id: 'menu-commit/checkout-nonexistent',
		title: 'Checkout Commit (refused: no such commit)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'checkoutCommit', repo: '{{repo}}', commitHash: NO_SUCH_HASH }],
		expect: { responses: ['checkoutCommit'] },
		allowErrorOn: ['checkoutCommit']
	}, {
		ops: ['checkoutCommit'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- cherrypickCommit ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/cherry-pick'), {
		ops: ['cherrypickCommit'],
		then: {
			// The cherry-pick lands {{commit}} (a non-merge main commit) on top of HEAD: main is
			// then exactly one commit ahead of its upstream, and that commit's subject is the
			// picked commit's own.
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 1 },
				{ kind: 'commitMessages', range: 'main --not origin/main', messages: ['{{commitSubject}}'] }
			]
		}
	}),
	scenario({
		id: 'menu-commit/cherry-pick-nonexistent',
		title: 'Cherry-pick Commit (refused: no such commit)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'cherrypickCommit', repo: '{{repo}}', commitHash: NO_SUCH_HASH, parentIndex: 0, recordOrigin: false, noCommit: false }],
		expect: { responses: ['cherrypickCommit'] },
		allowErrorOn: ['cherrypickCommit']
	}, {
		ops: ['cherrypickCommit'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- createFixupCommit / createSquashCommit ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/fixup'), {
		ops: ['createFixupCommit'],
		then: {
			// The staged precondition (the runner stages a fresh change) rides along as a commit
			// whose subject is git's own fixup form: "fixup! <subject of the target>".
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 1 },
				{ kind: 'commitMessages', range: 'main --not origin/main', messages: ['fixup! {{commitSubject}}'] }
			]
		}
	}),
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/squash'), {
		ops: ['createSquashCommit'],
		then: {
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 1 },
				{ kind: 'commitMessages', range: 'main --not origin/main', messages: ['squash! {{commitSubject}}'] }
			]
		}
	}),
	scenario({
		id: 'menu-commit/fixup-nothing-staged',
		title: 'Create Fixup Commit (refused: nothing staged)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		// No staged precondition: the seeded worktree has nothing in the index, so git's
		// "nothing to commit" is the designed refusal of the fixup/squash ops.
		request: [{ command: 'commitFixup', repo: '{{repo}}', commitHash: '{{commit}}' }],
		expect: { responses: ['commitFixup'] },
		allowErrorOn: ['commitFixup']
	}, {
		ops: ['createFixupCommit', 'createSquashCommit'],
		then: {
			git: [{ kind: 'commitCount', range: 'main --not origin/main', count: 0 }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- dropCommit ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/drop'), {
		ops: ['dropCommit'],
		then: {
			// Dropping {{commit}} rewrites main to its parent: main sits exactly at origin/main
			// again and the dropped subject is gone from the branch.
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 0 },
				{ kind: 'commitCount', range: '{{commitParent}}..main', count: 0 }
			]
		}
	}),
	scenario({
		id: 'menu-commit/drop-nonexistent',
		title: 'Drop Commit (refused: no such commit)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'dropCommit', repo: '{{repo}}', commitHash: NO_SUCH_HASH }],
		expect: { responses: ['dropCommit'] },
		allowErrorOn: ['dropCommit']
	}, {
		ops: ['dropCommit'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- resetToCommit ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/reset-to-commit'), {
		ops: ['resetToCommit'],
		then: {
			// The mixed reset to {{commit}} moves main back without touching the index — main is
			// at the target and its commits are gone from the branch tip.
			git: [
				{ kind: 'commitMessages', range: 'main -1', messages: ['{{commitSubject}}'] },
				{ kind: 'headIs', name: 'main' }
			]
		}
	}),
	scenario({
		id: 'menu-commit/reset-to-nonexistent',
		title: 'Reset to Commit (refused: no such commit)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'resetToCommit', repo: '{{repo}}', commit: NO_SUCH_HASH, resetMode: 'mixed' }],
		expect: { responses: ['resetToCommit'] },
		allowErrorOn: ['resetToCommit']
	}, {
		ops: ['resetToCommit'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- revertCommit ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/revert'), {
		ops: ['revertCommit'],
		then: {
			// git's revert subject: "Revert \"<subject>\"" — the op runs with --no-edit.
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 1 },
				{ kind: 'commitMessages', range: 'main --not origin/main', messages: ['Revert "{{commitSubject}}"'] }
			]
		}
	}),
	scenario({
		id: 'menu-commit/revert-nonexistent',
		title: 'Revert Commit (refused: no such commit)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'revertCommit', repo: '{{repo}}', commitHash: NO_SUCH_HASH, parentIndex: 0 }],
		expect: { responses: ['revertCommit'] },
		allowErrorOn: ['revertCommit']
	}, {
		ops: ['revertCommit'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- undoLastCommit ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/reset-soft'), {
		ops: ['undoLastCommit'],
		then: {
			// The soft reset moves main back one commit and stages its changes — main is one
			// BEHIND its upstream afterwards, with a dirty (staged) worktree.
			git: [
				{ kind: 'commitCount', range: 'origin/main --not main', count: 1 },
				{ kind: 'worktreeStatus', clean: false }
			]
		}
	}),
	scenario({
		id: 'menu-commit/undo-at-root',
		title: 'Undo Last Commit (refused: root commit has no parent)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		given: { branch: 'automation-root', at: 'root' },
		request: [{ command: 'undoLastCommit', repo: '{{repo}}' }],
		expect: { responses: ['undoLastCommit'] },
		allowErrorOn: ['undoLastCommit']
	}, {
		ops: ['undoLastCommit'],
		then: {
			// `git reset --soft HEAD^` refuses on a parentless HEAD: HEAD stays on the root
			// branch and main keeps its seeded shape.
			git: [
				{ kind: 'headIs', name: 'automation-root' },
				{ kind: 'refPresent', ref: 'main' },
				{ kind: 'commitCount', range: 'main --not origin/main', count: 0 }
			]
		}
	}),

	/* ---------------- amendLastCommit (Source Control command) ---------------- */
	scenario(byId(MENUS_VSCODE_ACTIONS, 'menu-vscode/scm-amend-last-commit'), {
		ops: ['amendLastCommit'],
		then: {
			// The amend rewrites main's tip: same tree, new commit — main is one ahead of its
			// upstream afterwards.
			git: [{ kind: 'commitCount', range: 'main --not origin/main', count: 1 }]
		}
	}),
	scenario({
		id: 'menu-vscode/scm-amend-last-commit-no-identity',
		title: 'Amend Last Commit (refused: no committer identity)',
		group: 'menu-vscode',
		tags: ['menu-vscode', 'failure', 'command'],
		mutable: true,
		// The repo-local identity the fixture seeds is unset first: `git commit --amend` refuses
		// with "Comitter identity unknown" — deterministic under the E2E run's pinned (empty)
		// global config.
		given: { config: { 'user.name': null, 'user.email': null } },
		vscodeCommand: { command: 'git-graph-rs.amendLastCommit', arg: { kind: 'rootUri' } },
		expectAnyNotification: true,
		noHostTraffic: true,
		expect: { responses: [] }
	}, {
		ops: ['amendLastCommit'],
		then: {
			git: [{ kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- amendCommitMessage ---------------- */
	scenario({
		id: 'menu-commit/reword-head',
		title: 'Edit Commit Message (HEAD: the pure amend)',
		group: 'menu-commit',
		tags: ['menu-commit', 'context-menu'],
		mutable: true,
		// The HEAD case is the pure amendCommitMessage op (the earlier-commit case rides an
		// interactive rebase, process-side); {{head}} targets exactly it.
		request: [{ command: 'editCommitMessage', repo: '{{repo}}', commitHash: '{{head}}', message: 'Amended by automation' }],
		expect: { responses: ['editCommitMessage'] }
	}, {
		ops: ['amendCommitMessage'],
		then: {
			git: [
				{ kind: 'commitMessages', range: 'main -1', messages: ['Amended by automation'] },
				{ kind: 'commitCount', range: 'main --not origin/main', count: 1 }
			]
		}
	}),
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/edit-message'), {
		ops: ['amendCommitMessage'],
		tags: ['menu-commit'],
		then: {
			// {{commit}} is not HEAD: the flow drives the interactive-rebase path that rewords
			// the target in place — the branch keeps its commit count and the subject changes.
			git: [
				{ kind: 'headIs', name: 'main' },
				{ kind: 'refPresent', ref: 'main' }
			]
		}
	}),
	scenario({
		id: 'menu-commit/reword-nonexistent',
		title: 'Edit Commit Message (refused: no such commit)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'editCommitMessage', repo: '{{repo}}', commitHash: NO_SUCH_HASH, message: 'Nope' }],
		expect: { responses: ['editCommitMessage'] },
		allowErrorOn: ['editCommitMessage']
	}, {
		ops: ['amendCommitMessage'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- resetCurrentBranchToRemote (Source Control command) ---------------- */
	scenario(byId(MENUS_VSCODE_ACTIONS, 'menu-vscode/scm-reset-current-branch-to-remote'), {
		ops: ['resetCurrentBranchToRemote'],
		answers: [{ dialog: 'message', choose: 'primary' }],
		then: {
			// main == origin/main already: the soft reset is a no-op the modal confirms through.
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 0 },
				{ kind: 'upstreamIs', branch: 'main', upstream: 'origin/main' }
			]
		}
	}),
	scenario({
		id: 'menu-vscode/scm-reset-to-remote-no-upstream',
		title: 'Reset Current Branch to Remote (refused: no upstream configured)',
		group: 'menu-vscode',
		tags: ['menu-vscode', 'failure', 'command'],
		mutable: true,
		// main's upstream config is unset first: `git reset --soft @{upstream}` refuses with
		// "no upstream configured for branch 'main'".
		given: { config: { 'branch.main.remote': null, 'branch.main.merge': null } },
		vscodeCommand: { command: 'git-graph-rs.resetCurrentBranchToRemote', arg: { kind: 'rootUri' } },
		expectModal: true,
		noHostTraffic: true,
		expect: { responses: [] }
	}, {
		ops: ['resetCurrentBranchToRemote'],
		answers: [{ dialog: 'message', choose: 'primary' }],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- archive (the former nativeSaveDialog skip) ---------------- */
	scenario(byId(MENUS_BRANCH_ACTIONS, 'menu-branch/create-archive'), {
		ops: ['archive'],
		answers: [{ dialog: 'save', path: '{{repo}}/automation-archive.zip' }],
		then: {
			// The save dialog the skip existed for, answered by the ScriptedUiPort: the archive
			// lands as an untracked file in the worktree.
			git: [{ kind: 'worktreeStatus', clean: false, contains: ['automation-archive.zip'] }]
		}
	}),
	scenario(byId(MENUS_BRANCH_ACTIONS, 'menu-branch/create-archive'), {
		ops: ['archive'],
		id: 'menu-branch/create-archive-cancelled',
		tags: ['menu-branch', 'failure', 'dialog'],
		answers: [{ dialog: 'save', path: null }],
		allowErrorOn: ['createArchive'],
		then: {
			// The CANCEL branch of the save dialog: the flow reports "no file name" as its error
			// and the repository keeps exactly its seeded shape (no archive anywhere).
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'stashCount', count: 3 }]
		}
	})
];

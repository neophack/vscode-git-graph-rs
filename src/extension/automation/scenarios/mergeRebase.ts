/**
 * The merge/rebase-domain scenarios (task 4.10): the mergeRebase.ts write operations — merge,
 * commitSquashFromMerge, rebase, continueOperation, abortOperation — each with a success and a
 * failure scenario. The in-progress-operation pair (continue/abort) uses the given.state
 * recipes: a conflicted merge (abort) and a resolved one (continue); their failure twins run
 * with NOTHING in progress, where git refuses deterministically ("There is no merge in
 * progress" / "There is no merge to abort").
 */

import { MENUS_COMMIT_ACTIONS } from '../catalog/menusCommit';
import { byId, scenario } from '../scenario';

const NO_SUCH_HASH = '1234567890123456789012345678901234567890';

export const MERGE_REBASE_SCENARIOS = [
	/* ---------------- merge ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/merge'), {
		ops: ['merge'],
		then: {
			// `git merge --no-ff <{{commit}}>` (a main ancestor): the merge commit's subject is
			// git's own form for a raw hash merge.
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 1 },
				{ kind: 'commitMessages', range: 'main --not origin/main', messages: ['Merge commit \'{{commit}}\''] }
			]
		}
	}),
	scenario({
		id: 'menu-commit/merge-nonexistent',
		title: 'Merge into current branch… (refused: no such object)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'merge', repo: '{{repo}}', obj: NO_SUCH_HASH, actionOn: 'Commit', createNewCommit: true, squash: false, noCommit: false }],
		expect: { responses: ['merge'] },
		allowErrorOn: ['merge']
	}, {
		ops: ['merge'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- commitSquashFromMerge ---------------- */
	scenario({
		id: 'menu-commit/merge-squash',
		title: 'Merge into current branch… (squash: the squashed merge is committed)',
		group: 'menu-commit',
		tags: ['menu-commit', 'context-menu', 'dialog'],
		mutable: true,
		// Squashing {{branch}} (local-ahead, one commit ahead of main) into main: the merge
		// --squash stages the work and the flow's commitSquashFromMerge follow-up lands it as
		// ONE commit whose subject the op itself fixes.
		request: [{ command: 'merge', repo: '{{repo}}', obj: '{{branch}}', actionOn: 'Branch', createNewCommit: false, squash: true, noCommit: false }],
		expect: { responses: ['merge'] }
	}, {
		ops: ['merge', 'commitSquashFromMerge'],
		then: {
			git: [
				{ kind: 'commitCount', range: 'main --not origin/main', count: 1 },
				{ kind: 'commitMessages', range: 'main --not origin/main', messages: ['Merge branch \'{{branch}}\''] }
			]
		}
	}),
	scenario({
		id: 'menu-commit/merge-squash-conflict',
		title: 'Merge into current branch… (squash, refused: the merge conflicts)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'dialog'],
		mutable: true,
		given: { state: 'merge-conflict' },
		request: [{ command: 'merge', repo: '{{repo}}', obj: 'automation-conflict-theirs', actionOn: 'Branch', createNewCommit: false, squash: true, noCommit: false }],
		expect: { responses: ['merge'] },
		allowErrorOn: ['merge']
	}, {
		ops: ['merge', 'commitSquashFromMerge'],
		then: {
			// The conflicted squash never reaches the follow-up commit: the conflict markers sit
			// in the worktree and no commit was created.
			git: [
				{ kind: 'headIs', name: 'automation-conflict-ours' },
				{ kind: 'worktreeStatus', clean: false }
			]
		}
	}),

	/* ---------------- rebase ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/rebase'), {
		ops: ['rebase'],
		then: {
			// Rebasing main onto {{commit}} (a main ancestor) resolves "up to date": the op runs,
			// nothing moves.
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),
	scenario({
		id: 'menu-commit/rebase-nonexistent',
		title: 'Rebase current branch on Commit (refused: no such object)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'rebase', repo: '{{repo}}', obj: NO_SUCH_HASH, actionOn: 'Commit', ignoreDate: true, interactive: false, autosquash: false }],
		expect: { responses: ['rebase'] },
		allowErrorOn: ['rebase']
	}, {
		ops: ['rebase'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),

	/* ---------------- continueOperation / abortOperation ---------------- */
	scenario({
		id: 'menu-commit/continue-merge',
		title: 'Continue Operation (a resolved merge commits)',
		group: 'menu-commit',
		tags: ['menu-commit'],
		mutable: true,
		given: { state: 'merge-conflict-resolved' },
		// The run env pins GIT_EDITOR (§6.8.6's isolation): `git merge --continue` commits the
		// resolved merge headlessly with git's own merge subject.
		request: [{ command: 'continueOperation', repo: '{{repo}}', type: 'merge' }],
		expect: { responses: ['continueOperation'] }
	}, {
		ops: ['continueOperation'],
		then: {
			git: [
				{ kind: 'headIs', name: 'automation-conflict-ours' },
				{ kind: 'commitMessages', range: 'automation-conflict-ours -1', messages: ["Merge branch 'automation-conflict-theirs' into automation-conflict-ours"] }
			]
		}
	}),
	scenario({
		id: 'menu-commit/continue-nothing-in-progress',
		title: 'Continue Operation (refused: nothing in progress)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure'],
		mutable: true,
		request: [{ command: 'continueOperation', repo: '{{repo}}', type: 'merge' }],
		expect: { responses: ['continueOperation'] },
		allowErrorOn: ['continueOperation']
	}, {
		ops: ['continueOperation'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	}),
	scenario({
		id: 'menu-commit/abort-merge',
		title: 'Abort Operation (a conflicted merge is rolled back)',
		group: 'menu-commit',
		tags: ['menu-commit'],
		mutable: true,
		given: { state: 'merge-conflict' },
		request: [{ command: 'abortOperation', repo: '{{repo}}', type: 'merge' }],
		expect: { responses: ['abortOperation'] }
	}, {
		ops: ['abortOperation'],
		then: {
			git: [
				{ kind: 'headIs', name: 'automation-conflict-ours' },
				// After the abort only the seeded untracked file keeps the worktree dirty.
				{ kind: 'worktreeStatus', contains: ['?? untracked-fixture.txt'] }
			]
		}
	}),
	scenario({
		id: 'menu-commit/abort-nothing-in-progress',
		title: 'Abort Operation (refused: nothing to abort)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure'],
		mutable: true,
		request: [{ command: 'abortOperation', repo: '{{repo}}', type: 'merge' }],
		expect: { responses: ['abortOperation'] },
		allowErrorOn: ['abortOperation']
	}, {
		ops: ['abortOperation'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'commitCount', range: 'main --not origin/main', count: 0 }]
		}
	})
];

/**
 * The branch-domain scenarios (REFACTOR-PLAN §6.8.3, task 4.10): every branch write operation of
 * src/extension/git/write/ops/branches.ts with a SUCCESS and a FAILURE scenario, each asserting
 * the repository's real state through then.git. Success scenarios wrap the existing catalog
 * actions (their ui/request paths run unchanged); failure scenarios add inline request-only
 * actions whose DESIGNED outcome is git's refusal (nonexistent refs, invalid names) — the
 * refusal is accepted via allowErrorOn and the assertion proves the repository did NOT change.
 *
 * Fixture-stable facts (src/automation/fixture.ts): local branches are `main` (checked out,
 * tracking origin/main) and `local-ahead` (one commit ahead, no upstream); `{{branch}}` resolves
 * to the first local branch that is not HEAD (local-ahead on the seeded clone).
 */

import { MENUS_BRANCH_ACTIONS } from '../catalog/menusBranch';
import { MENUS_REMOTE_BRANCH_ACTIONS } from '../catalog/menusRemoteBranch';
import { byId, scenario } from '../scenario';

export const BRANCH_SCENARIOS = [
	/* ---------------- checkoutBranch ---------------- */
	scenario(byId(MENUS_BRANCH_ACTIONS, 'menu-branch/checkout'), {
		ops: ['checkoutBranch'],
		id: 'smoke/S4',
		tags: ['smoke', 'menu-branch'],
		then: {
			git: [{ kind: 'headIs', name: '{{branch}}' }, { kind: 'refPresent', ref: 'main' }],
			noErrors: true
		}
	}),
	scenario({
		id: 'menu-branch/checkout-nonexistent',
		title: 'Checkout Branch (refused: no such branch)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure'],
		mutable: true,
		request: [{ command: 'checkoutBranch', repo: '{{repo}}', branchName: 'no-such-branch', remoteBranch: null, pullAfterwards: null }],
		expect: { responses: ['checkoutBranch'] },
		allowErrorOn: ['checkoutBranch']
	}, {
		ops: ['checkoutBranch'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'refAbsent', ref: 'no-such-branch' }],
			noErrors: false
		}
	}),

	/* ---------------- createBranch ---------------- */
	scenario(byId(MENUS_BRANCH_ACTIONS, 'menu-branch/create-branch'), {
		ops: ['createBranch'],
		then: {
			git: [{ kind: 'refPresent', ref: 'automation-branch-2' }, { kind: 'headIs', name: 'main' }],
			refreshes: 1
		}
	}),
	scenario({
		id: 'menu-branch/create-branch-invalid-name',
		title: 'Create Branch… (refused: invalid name)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commit}}', branchName: 'bad..name', checkout: false, force: false }],
		expect: { responses: ['createBranch'] },
		allowErrorOn: ['createBranch']
	}, {
		ops: ['createBranch'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'bad..name' }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- deleteBranch ---------------- */
	scenario(byId(MENUS_BRANCH_ACTIONS, 'menu-branch/delete'), {
		ops: ['deleteBranch'],
		then: {
			git: [{ kind: 'refAbsent', ref: '{{branch}}' }, { kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'menu-branch/delete-nonexistent',
		title: 'Delete Branch… (refused: no such branch)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'deleteBranch', repo: '{{repo}}', branchName: 'no-such-branch', forceDelete: true, deleteOnRemotes: [] }],
		expect: { responses: ['deleteBranch'] },
		allowErrorOn: ['deleteBranch']
	}, {
		ops: ['deleteBranch'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'no-such-branch' }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- renameBranch ---------------- */
	scenario(byId(MENUS_BRANCH_ACTIONS, 'menu-branch/rename'), {
		ops: ['renameBranch'],
		then: {
			git: [{ kind: 'refAbsent', ref: '{{branch}}' }, { kind: 'refPresent', ref: '{{branch}}-renamed' }]
		}
	}),
	scenario({
		id: 'menu-branch/rename-invalid-name',
		title: 'Rename Branch… (refused: invalid target name)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'renameBranch', repo: '{{repo}}', oldName: '{{branch}}', newName: 'bad..name' }],
		expect: { responses: ['renameBranch'] },
		allowErrorOn: ['renameBranch']
	}, {
		ops: ['renameBranch'],
		then: {
			git: [{ kind: 'refPresent', ref: '{{branch}}' }, { kind: 'refAbsent', ref: 'bad..name' }]
		}
	}),

	/* ---------------- fetchIntoLocalBranch ---------------- */
	scenario(byId(MENUS_REMOTE_BRANCH_ACTIONS, 'menu-remote-branch/fetch-into'), {
		ops: ['fetchIntoLocalBranch'],
		then: {
			git: [
				{ kind: 'refPresent', ref: '{{remoteBranch}}' },
				{ kind: 'upstreamIs', branch: '{{remoteBranch}}', upstream: '{{remote}}/{{remoteBranch}}' }
			]
		}
	}),
	scenario({
		id: 'menu-branch/fetch-into-nonexistent',
		title: 'Fetch into local branch (refused: no such remote branch)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure'],
		mutable: true,
		request: [{ command: 'fetchIntoLocalBranch', repo: '{{repo}}', remote: '{{remote}}', remoteBranch: 'no-such-remote-branch', localBranch: 'automation-fetch-target', force: false }],
		expect: { responses: ['fetchIntoLocalBranch'] },
		allowErrorOn: ['fetchIntoLocalBranch']
	}, {
		ops: ['fetchIntoLocalBranch'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'automation-fetch-target' }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- pullBranch + commitSquashFromPull ---------------- */
	scenario({
		id: 'menu-branch/pull-up-to-date',
		title: 'Pull Branch (up to date)',
		group: 'menu-branch',
		tags: ['menu-branch'],
		mutable: true,
		request: [{ command: 'pullBranch', repo: '{{repo}}', branchName: 'main', remote: '{{remote}}', createNewCommit: true, squash: false }],
		expect: { responses: ['pullBranch'] }
	}, {
		ops: ['pullBranch'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'upstreamIs', branch: 'main', upstream: 'origin/main' }]
		}
	}),
	scenario({
		id: 'menu-branch/pull-squash',
		title: 'Pull Branch (squash: the squashed merge is committed)',
		group: 'menu-branch',
		tags: ['menu-branch', 'dialog'],
		mutable: true,
		// A branch one commit behind origin/main is created and checked out first (the create is
		// part of the when, not the given: it runs through the same real pipeline), then the
		// squash pull fast-forwards the work and the flow's commitSquashFromPull follow-up lands
		// it as ONE commit whose subject the op itself fixes ("Merge branch '<remote>/main'").
		request: [
			{ command: 'createBranch', repo: '{{repo}}', commitHash: '{{commitParent}}', branchName: 'automation-pull-squash', checkout: true, force: false },
			{ command: 'pullBranch', repo: '{{repo}}', branchName: 'main', remote: '{{remote}}', createNewCommit: false, squash: true }
		],
		expect: { responses: ['createBranch', 'pullBranch'] }
	}, {
		ops: ['pullBranch', 'commitSquashFromPull'],
		then: {
			git: [
				{ kind: 'headIs', name: 'automation-pull-squash' },
				{ kind: 'commitMessages', range: 'automation-pull-squash --not main', messages: ['Merge branch \'origin/main\''] }
			]
		}
	}),
	scenario({
		id: 'menu-branch/pull-nonexistent',
		title: 'Pull Branch (refused: no such branch on the remote)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'pullBranch', repo: '{{repo}}', branchName: 'no-such-branch', remote: '{{remote}}', createNewCommit: true, squash: false }],
		expect: { responses: ['pullBranch'] },
		allowErrorOn: ['pullBranch']
	}, {
		ops: ['pullBranch', 'commitSquashFromPull'],
		then: {
			git: [{ kind: 'headIs', name: 'main' }, { kind: 'refAbsent', ref: 'no-such-branch' }]
		}
	}),

	/* ---------------- pushBranch / pushBranchToMultipleRemotes ---------------- */
	scenario(byId(MENUS_BRANCH_ACTIONS, 'menu-branch/push'), {
		ops: ['pushBranch'],
		then: {
			git: [
				{ kind: 'refPresent', ref: 'origin/{{branch}}' },
				{ kind: 'upstreamIs', branch: '{{branch}}', upstream: 'origin/{{branch}}' }
			]
		}
	}),
	scenario({
		id: 'menu-branch/push-nonexistent',
		title: 'Push Branch… (refused: no such local branch)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'pushBranch', repo: '{{repo}}', branchName: 'no-such-branch', remotes: ['{{remote}}'], setUpstream: false, mode: '', willUpdateBranchConfig: false }],
		expect: { responses: ['pushBranch'] },
		allowErrorOn: ['pushBranch']
	}, {
		ops: ['pushBranch'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'origin/no-such-branch' }, { kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'menu-branch/push-multiple-remotes',
		title: 'Push Branch to multiple remotes',
		group: 'menu-branch',
		tags: ['menu-branch', 'dialog'],
		mutable: true,
		// The second remote is added as part of the when (settings/add-remote's exact request),
		// then one pushBranch answers for both — the request shape the multi-remote push dialog sends.
		request: [
			{ command: 'addRemote', repo: '{{repo}}', name: 'automation-remote', url: '{{repo}}', pushUrl: null, fetch: false },
			{ command: 'pushBranch', repo: '{{repo}}', branchName: 'local-ahead', remotes: ['{{remote}}', 'automation-remote'], setUpstream: false, mode: '', willUpdateBranchConfig: false }
		],
		expect: { responses: ['addRemote', 'pushBranch'] }
	}, {
		ops: ['pushBranchToMultipleRemotes'],
		then: {
			git: [{ kind: 'refPresent', ref: 'origin/local-ahead' }, { kind: 'remotePresent', name: 'automation-remote' }]
		}
	}),
	scenario({
		id: 'menu-branch/push-multiple-remotes-unknown',
		title: 'Push Branch to multiple remotes (refused: remotes do not exist)',
		group: 'menu-branch',
		tags: ['menu-branch', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'pushBranch', repo: '{{repo}}', branchName: 'local-ahead', remotes: ['no-such-a', 'no-such-b'], setUpstream: false, mode: '', willUpdateBranchConfig: false }],
		expect: { responses: ['pushBranch'] },
		allowErrorOn: ['pushBranch']
	}, {
		ops: ['pushBranchToMultipleRemotes'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'origin/local-ahead' }, { kind: 'headIs', name: 'main' }]
		}
	})
];

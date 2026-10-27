/**
 * The stash-domain scenarios: every stash write operation of
 * src/extension/git/write/ops/stash.ts — apply, branch-from, drop, pop, push — with a success
 * and a failure scenario. The seeded clone carries exactly THREE stashes
 * (fixture-stash-1/2/3); the failure twins address stash@{9}, which git refuses with
 * "log for stash@{9} only has N entries", judged by then.git to have changed nothing.
 */

import { MENUS_STASH_ACTIONS } from '../catalog/menusStash';
import { MENUS_UNCOMMITTED_ACTIONS } from '../catalog/menusUncommitted';
import { byId, scenario } from '../scenario';

export const STASH_SCENARIOS = [
	/* ---------------- applyStash ---------------- */
	scenario(byId(MENUS_STASH_ACTIONS, 'menu-stash/apply'), {
		ops: ['applyStash'],
		then: {
			// Applying keeps the stash list intact and re-creates its change in the worktree —
			// as a MODIFICATION of the stashed file, not just any dirt (the stash substrate is a
			// tracked file the apply re-modifies).
			git: [
				{ kind: 'stashCount', count: 3, messageContains: 'fixture-stash' },
				{ kind: 'worktreeStatus', clean: false },
				{ kind: 'worktreeStatus', contains: ['M '] }
			]
		}
	}),
	scenario({
		id: 'menu-stash/apply-nonexistent',
		title: 'Apply Stash (refused: no such stash)',
		group: 'menu-stash',
		tags: ['menu-stash', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'applyStash', repo: '{{repo}}', selector: 'stash@{9}', reinstateIndex: false }],
		expect: { responses: ['applyStash'] },
		allowErrorOn: ['applyStash']
	}, {
		ops: ['applyStash'],
		then: {
			git: [{ kind: 'stashCount', count: 3 }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- branchFromStash ---------------- */
	scenario(byId(MENUS_STASH_ACTIONS, 'menu-stash/branch-from-stash'), {
		ops: ['branchFromStash'],
		then: {
			// `git checkout -b automation-stash-branch <stash>`: the branch is created, checked
			// out, and the stash itself survives (branch-from does not drop it).
			git: [{ kind: 'headIs', name: 'automation-stash-branch' }, { kind: 'stashCount', count: 3 }]
		}
	}),
	scenario({
		id: 'menu-stash/branch-from-invalid-name',
		title: 'Create Branch from Stash (refused: invalid branch name)',
		group: 'menu-stash',
		tags: ['menu-stash', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'branchFromStash', repo: '{{repo}}', selector: '{{stash}}', branchName: 'bad..name' }],
		expect: { responses: ['branchFromStash'] },
		allowErrorOn: ['branchFromStash']
	}, {
		ops: ['branchFromStash'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'bad..name' }, { kind: 'stashCount', count: 3 }]
		}
	}),

	/* ---------------- dropStash ---------------- */
	scenario(byId(MENUS_STASH_ACTIONS, 'menu-stash/drop'), {
		ops: ['dropStash'],
		then: {
			// {{stash}} resolves to stash@{0}, the NEWEST of the three seeded stashes
			// (fixture-stash-3 — git lists stashes newest-first). Dropping it must leave exactly
			// the two older ones behind: BOTH remaining messages present pins that the newest
			// was the dropped one (a wrong drop keeps a different pair).
			git: [
				{ kind: 'stashCount', count: 2, messageContains: 'fixture-stash-1' },
				{ kind: 'stashCount', count: 2, messageContains: 'fixture-stash-2' }
			]
		}
	}),
	scenario({
		id: 'menu-stash/drop-nonexistent',
		title: 'Drop Stash (refused: no such stash)',
		group: 'menu-stash',
		tags: ['menu-stash', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'dropStash', repo: '{{repo}}', selector: 'stash@{9}' }],
		expect: { responses: ['dropStash'] },
		allowErrorOn: ['dropStash']
	}, {
		ops: ['dropStash'],
		then: {
			git: [{ kind: 'stashCount', count: 3 }]
		}
	}),

	/* ---------------- popStash ---------------- */
	scenario(byId(MENUS_STASH_ACTIONS, 'menu-stash/pop'), {
		ops: ['popStash'],
		then: {
			// Popping removes the stash AND re-creates its change in the worktree.
			git: [{ kind: 'stashCount', count: 2 }, { kind: 'worktreeStatus', clean: false }]
		}
	}),
	scenario({
		id: 'menu-stash/pop-nonexistent',
		title: 'Pop Stash (refused: no such stash)',
		group: 'menu-stash',
		tags: ['menu-stash', 'failure', 'context-menu'],
		mutable: true,
		request: [{ command: 'popStash', repo: '{{repo}}', selector: 'stash@{9}', reinstateIndex: false }],
		expect: { responses: ['popStash'] },
		allowErrorOn: ['popStash']
	}, {
		ops: ['popStash'],
		then: {
			// git's refusal left the repository entirely alone: the list keeps its three seeded
			// entries and HEAD never moved (a half-run pop would have checked out first).
			git: [{ kind: 'stashCount', count: 3 }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- pushStash ---------------- */
	scenario(byId(MENUS_UNCOMMITTED_ACTIONS, 'menu-uncommitted/stash'), {
		ops: ['pushStash'],
		then: {
			// The untracked fixture file rides along (includeUntracked): a fourth stash whose
			// message is the flow's own, and the worktree loses the untracked entry — everything
			// the seed dirtied went INTO the stash, so nothing at all remains (clean pins the
			// includeUntracked wiring end to end, not just the stash-list count).
			git: [
				{ kind: 'stashCount', count: 4, messageContains: 'Automation stash' },
				{ kind: 'worktreeStatus', clean: true }
			]
		}
	}),
	scenario({
		id: 'menu-uncommitted/stash-nothing-to-save',
		title: 'Stash Uncommitted Changes (nothing to save: the designed no-op)',
		group: 'menu-uncommitted',
		tags: ['menu-uncommitted', 'failure', 'context-menu', 'dialog'],
		mutable: true,
		// With untracked files excluded and nothing else modified, git answers "No local changes
		// to save" (exit 0): the op runs, the stash list keeps its seeded shape. This pins the
		// no-op branch of the stash push — the failure-adjacent path a user hits on a clean tree.
		request: [{ command: 'pushStash', repo: '{{repo}}', message: 'Automation stash', includeUntracked: false }],
		expect: { responses: ['pushStash'] }
	}, {
		ops: ['pushStash'],
		then: {
			git: [{ kind: 'stashCount', count: 3 }, { kind: 'worktreeStatus', contains: ['?? untracked-fixture.txt'] }]
		}
	})
];

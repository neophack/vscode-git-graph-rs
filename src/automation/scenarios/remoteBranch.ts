/**
 * The remote-branch-domain scenarios (task 4.10): the remote-facing branch write operations —
 * deleteRemoteBranch, deleteRemoteTrackingBranch (both halves of the Delete Remote Branch flow,
 * writeFlows.ts deletes the remote ref and, when the remote no longer has the branch, the stale
 * tracking ref) — plus the remote-branch merge/pull conflict scenarios the failure paths of the
 * merge and pullBranch ops ride on. See branches.ts for the local-branch siblings.
 */

import { MENUS_REMOTE_BRANCH_ACTIONS } from '../catalog/menusRemoteBranch';
import { byId, scenario } from '../scenario';

export const REMOTE_BRANCH_SCENARIOS = [
	/* ---------------- deleteRemoteBranch + deleteRemoteTrackingBranch ---------------- */
	scenario(byId(MENUS_REMOTE_BRANCH_ACTIONS, 'menu-remote-branch/delete-remote-branch'), {
		ops: ['deleteRemoteBranch', 'deleteRemoteTrackingBranch'],
		then: {
			// {{remoteBranch}} is a real origin branch: after the deletion both the remote ref
			// and its local tracking ref are gone (the flow's second op cleans the tracking ref).
			git: [
				{ kind: 'refAbsent', ref: '{{remote}}/{{remoteBranch}}' },
				{ kind: 'headIs', name: 'main' }
			]
		}
	}),
	scenario({
		id: 'menu-remote-branch/delete-nonexistent',
		title: 'Delete Remote Branch… (refused: no such branch on the remote)',
		group: 'menu-remote-branch',
		tags: ['menu-remote-branch', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'deleteRemoteBranch', repo: '{{repo}}', branchName: 'no-such-remote-branch', remote: '{{remote}}' }],
		expect: { responses: ['deleteRemoteBranch'] },
		allowErrorOn: ['deleteRemoteBranch']
	}, {
		ops: ['deleteRemoteBranch', 'deleteRemoteTrackingBranch'],
		then: {
			// git's "remote ref does not exist" tolerance path: nothing changes anywhere.
			git: [
				{ kind: 'refAbsent', ref: '{{remote}}/no-such-remote-branch' },
				{ kind: 'refPresent', ref: '{{remote}}/main' }
			]
		}
	}),

	/* ---------------- merge / pullBranch conflict failure paths ---------------- */
	scenario(byId(MENUS_REMOTE_BRANCH_ACTIONS, 'menu-remote-branch/merge'), {
		ops: ['merge'],
		tags: ['menu-remote-branch', 'failure'],
		then: {
			// The designed conflict: HEAD stays on its (now conflicted) feature checkout and the
			// main line is untouched — the merge commit the flow would have created does not exist.
			git: [
				{ kind: 'refPresent', ref: 'main' },
				{ kind: 'refPresent', ref: '{{remote}}/{{remoteBranch}}' }
			]
		}
	}),
	scenario(byId(MENUS_REMOTE_BRANCH_ACTIONS, 'menu-remote-branch/pull-into'), {
		ops: ['pullBranch'],
		tags: ['menu-remote-branch', 'failure'],
		then: {
			git: [
				{ kind: 'refPresent', ref: 'main' },
				{ kind: 'refPresent', ref: '{{remote}}/{{remoteBranch}}' }
			]
		}
	})
];

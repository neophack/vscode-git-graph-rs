/**
 * The remote/config-domain scenarios: the remotes.ts and config.ts write operations
 * — addRemote, deleteRemote, editRemote, pruneRemote, fetch (remotes.ts) and setConfigValue,
 * unsetConfigValue, addRemoteTagsRefspec (config.ts) — each with a success and a failure
 * scenario. The failure forms: duplicating an existing remote, removing/editing a nonexistent
 * one, fetching/pruning from a remote that does not exist, and unsetting an identity the pinned
 * (empty) global config never held.
 */

import { CONTROL_BAR_ACTIONS } from '../catalog/controlBar';
import { SETTINGS_ACTIONS } from '../catalog/settings';
import { byId, scenario } from '../scenario';

/** The tag-tracking refspec addRemoteTagsRefspec appends (ops/config.ts, verbatim). */
const TAGS_REFSPEC_PREFIX = '+refs/tags/*:refs/remotes/';

export const REMOTES_CONFIG_SCENARIOS = [
	/* ---------------- addRemote ---------------- */
	scenario(byId(SETTINGS_ACTIONS, 'settings/add-remote'), {
		ops: ['addRemote'],
		then: {
			// The remote is listed AND fully wired: `git remote add` writes the default fetch
			// refspec, so a later fetch of the remote works without any further configuration.
			git: [
				{ kind: 'remotePresent', name: 'automation-remote', url: '{{repo}}' },
				{ kind: 'configValue', key: 'remote.automation-remote.fetch', value: '+refs/heads/*:refs/remotes/automation-remote/*' }
			]
		}
	}),
	scenario({
		id: 'settings/add-remote-duplicate',
		title: 'Add Remote (refused: the name already exists)',
		group: 'settings',
		tags: ['settings', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'addRemote', repo: '{{repo}}', name: '{{remote}}', url: '{{repo}}', pushUrl: null, fetch: false }],
		expect: { responses: ['addRemote'] },
		allowErrorOn: ['addRemote']
	}, {
		ops: ['addRemote'],
		then: {
			// origin keeps its ORIGINAL url (the fixture's bare remote) and its ORIGINAL fetch
			// refspec — the refused duplicate wrote no half-added config under the taken name.
			git: [
				{ kind: 'remotePresent', name: 'origin' },
				{ kind: 'configValue', key: 'remote.{{remote}}.fetch', value: '+refs/heads/*:refs/remotes/{{remote}}/*' },
				{ kind: 'headIs', name: 'main' }
			]
		}
	}),

	/* ---------------- deleteRemote ---------------- */
	scenario(byId(SETTINGS_ACTIONS, 'settings/delete-remote'), {
		ops: ['deleteRemote'],
		then: {
			// The remote is gone from the listing AND from the config: `git remote remove` drops
			// the whole remote.<name> section, so no orphaned url key survives the removal.
			git: [
				{ kind: 'remoteAbsent', name: '{{remote}}' },
				{ kind: 'configValue', key: 'remote.{{remote}}.url', value: null }
			]
		}
	}),
	scenario({
		id: 'settings/delete-remote-nonexistent',
		title: 'Remove Remote (refused: no such remote)',
		group: 'settings',
		tags: ['settings', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'deleteRemote', repo: '{{repo}}', name: 'no-such-remote' }],
		expect: { responses: ['deleteRemote'] },
		allowErrorOn: ['deleteRemote']
	}, {
		ops: ['deleteRemote'],
		then: {
			git: [{ kind: 'remotePresent', name: '{{remote}}' }]
		}
	}),

	/* ---------------- editRemote ---------------- */
	scenario(byId(SETTINGS_ACTIONS, 'settings/edit-remote'), {
		ops: ['editRemote'],
		then: {
			// The identity edit (same name, no url change): the remote keeps pointing at the
			// fixture's bare clone, and its fetch refspec survives the rewrite untouched — an
			// edit that lost the refspec would silently break every later fetch of the remote.
			git: [
				{ kind: 'remotePresent', name: '{{remote}}' },
				{ kind: 'configValue', key: 'remote.{{remote}}.fetch', value: '+refs/heads/*:refs/remotes/{{remote}}/*' }
			]
		}
	}),
	scenario({
		id: 'settings/edit-remote-invalid-name',
		title: 'Edit Remote (refused: invalid target name)',
		group: 'settings',
		tags: ['settings', 'failure', 'dialog'],
		mutable: true,
		request: [{ command: 'editRemote', repo: '{{repo}}', nameOld: '{{remote}}', nameNew: 'bad..name', urlOld: null, urlNew: null, pushUrlOld: null, pushUrlNew: null }],
		expect: { responses: ['editRemote'] },
		allowErrorOn: ['editRemote']
	}, {
		ops: ['editRemote'],
		then: {
			git: [{ kind: 'remotePresent', name: '{{remote}}' }, { kind: 'remoteAbsent', name: 'bad..name' }]
		}
	}),

	/* ---------------- fetch ---------------- */
	scenario(byId(CONTROL_BAR_ACTIONS, 'control-bar/fetch-btn'), {
		ops: ['fetch'],
		tags: ['control-bar', 'smoke'],
		then: {
			git: [{ kind: 'remotePresent', name: '{{remote}}' }, { kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'control-bar/fetch-unknown-remote',
		title: 'Fetch from Remote (refused: no such remote)',
		group: 'control-bar',
		tags: ['control-bar', 'failure'],
		mutable: true,
		request: [{ command: 'fetch', repo: '{{repo}}', name: 'no-such-remote', prune: false, pruneTags: false }],
		expect: { responses: ['fetch'] },
		allowErrorOn: ['fetch']
	}, {
		ops: ['fetch'],
		then: {
			git: [{ kind: 'remotePresent', name: '{{remote}}' }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- pruneRemote ---------------- */
	scenario({
		id: 'control-bar/prune-remote',
		title: 'Prune Remote (the up-to-date pass)',
		group: 'control-bar',
		tags: ['control-bar', 'dropdown'],
		mutable: true,
		request: [{ command: 'pruneRemote', repo: '{{repo}}', name: '{{remote}}' }],
		expect: { responses: ['pruneRemote'] }
	}, {
		ops: ['pruneRemote'],
		then: {
			// Nothing stale to prune on the seeded clone: the remote set and the tracking refs
			// keep exactly their shape (main's upstream included).
			git: [
				{ kind: 'remotePresent', name: '{{remote}}' },
				{ kind: 'upstreamIs', branch: 'main', upstream: 'origin/main' }
			]
		}
	}),
	scenario({
		id: 'control-bar/prune-unknown-remote',
		title: 'Prune Remote (refused: no such remote)',
		group: 'control-bar',
		tags: ['control-bar', 'failure', 'dropdown'],
		mutable: true,
		request: [{ command: 'pruneRemote', repo: '{{repo}}', name: 'no-such-remote' }],
		expect: { responses: ['pruneRemote'] },
		allowErrorOn: ['pruneRemote']
	}, {
		ops: ['pruneRemote'],
		then: {
			git: [{ kind: 'remotePresent', name: '{{remote}}' }, { kind: 'remoteAbsent', name: 'no-such-remote' }]
		}
	}),

	/* ---------------- setConfigValue ---------------- */
	scenario({
		id: 'settings/edit-user-details',
		title: 'Edit User Details (the repository-local identity)',
		group: 'settings',
		tags: ['settings', 'dialog'],
		mutable: true,
		request: [{ command: 'editUserDetails', repo: '{{repo}}', name: 'Automation User', email: 'automation@example.com', location: 'local', deleteLocalName: false, deleteLocalEmail: false }],
		expect: { responses: ['editUserDetails'] }
	}, {
		ops: ['setConfigValue'],
		then: {
			git: [
				{ kind: 'configValue', key: 'user.name', value: 'Automation User' },
				{ kind: 'configValue', key: 'user.email', value: 'automation@example.com' }
			]
		}
	}),
	scenario({
		id: 'settings/edit-user-details-empty-name',
		title: 'Edit User Details (invalid input: an EMPTY name the host does not reject)',
		group: 'settings',
		tags: ['settings', 'failure', 'dialog'],
		mutable: true,
		// The settings widget's own validation refuses an empty name; a direct request bypasses
		// it and `git config user.name ""` accepts the empty value. This scenario PINS that
		// boundary: the invalid input lands verbatim in the repository config (and flips the day
		// host-side validation appears — the assertion to update lives here, one place).
		request: [{ command: 'editUserDetails', repo: '{{repo}}', name: '', email: 'automation@example.com', location: 'local', deleteLocalName: false, deleteLocalEmail: false }],
		expect: { responses: ['editUserDetails'] }
	}, {
		ops: ['setConfigValue'],
		then: {
			git: [
				{ kind: 'configValue', key: 'user.name', value: '' },
				{ kind: 'configValue', key: 'user.email', value: 'automation@example.com' }
			]
		}
	}),

	/* ---------------- unsetConfigValue ---------------- */
	scenario({
		id: 'settings/delete-user-details',
		title: 'Delete User Details (the repository-local identity is unset)',
		group: 'settings',
		tags: ['settings', 'dialog'],
		mutable: true,
		request: [{ command: 'deleteUserDetails', repo: '{{repo}}', name: true, email: true, location: 'local' }],
		expect: { responses: ['deleteUserDetails'] }
	}, {
		ops: ['unsetConfigValue'],
		then: {
			git: [
				{ kind: 'configValue', key: 'user.name', value: null },
				{ kind: 'configValue', key: 'user.email', value: null }
			]
		}
	}),
	scenario({
		id: 'settings/delete-user-details-global-empty',
		title: 'Delete User Details (refused: the global identity was never set)',
		group: 'settings',
		tags: ['settings', 'failure', 'dialog'],
		mutable: true,
		// The E2E run pins GIT_CONFIG_GLOBAL at an empty temp file (hermetic isolation): `git config --global
		// --unset user.name` exits 5 ("No such section") — the designed refusal of the unset.
		request: [{ command: 'deleteUserDetails', repo: '{{repo}}', name: true, email: true, location: 'global' }],
		expect: { responses: ['deleteUserDetails'] },
		allowErrorOn: ['deleteUserDetails']
	}, {
		ops: ['unsetConfigValue'],
		then: {
			// The repository-local identity the seed wrote survives untouched.
			git: [{ kind: 'configValue', key: 'user.name', value: 'Fixture' }]
		}
	}),

	/* ---------------- addRemoteTagsRefspec ---------------- */
	scenario({
		id: 'settings/fetch-track-remote-tags',
		title: 'Fetch with Track Remote Tags (the tag-tracking refspec is added)',
		group: 'settings',
		tags: ['settings', 'dropdown'],
		mutable: true,
		// The `git-graph-rs.repository.trackRemoteTags` setting's documented effect on fetch:
		// the remote's fetch refspec gains the tag-tracking entry. Pins the setting's contract
		// (if the fetch flow ever loses the wiring, this scenario is the regression signal).
		given: { settings: { 'git-graph-rs.repository.trackRemoteTags': true } },
		request: [{ command: 'fetch', repo: '{{repo}}', name: '{{remote}}', prune: false, pruneTags: false }],
		expect: { responses: ['fetch'] }
	}, {
		ops: ['fetch', 'addRemoteTagsRefspec'],
		then: {
			git: [{ kind: 'configValue', key: 'remote.{{remote}}.fetch', value: TAGS_REFSPEC_PREFIX + '{{remote}}/tags/*' }]
		}
	}),
	scenario({
		id: 'settings/fetch-track-remote-tags-unknown',
		title: 'Fetch with Track Remote Tags (refused: no such remote)',
		group: 'settings',
		tags: ['settings', 'failure', 'dropdown'],
		mutable: true,
		given: { settings: { 'git-graph-rs.repository.trackRemoteTags': true } },
		request: [{ command: 'fetch', repo: '{{repo}}', name: 'no-such-remote', prune: false, pruneTags: false }],
		expect: { responses: ['fetch'] },
		allowErrorOn: ['fetch']
	}, {
		ops: ['fetch', 'addRemoteTagsRefspec'],
		then: {
			// No config for a remote that does not exist was created as a side effect.
			git: [{ kind: 'remoteAbsent', name: 'no-such-remote' }]
		}
	})
];

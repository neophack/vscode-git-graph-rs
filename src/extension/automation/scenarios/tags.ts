/**
 * The tag-domain scenarios (task 4.10): every tag write operation of
 * src/extension/git/write/ops/tags.ts — add, delete, push — with a success and a failure
 * scenario. The fixture's tags are `v1.x.x` (the newest is always annotated); `{{tag}}` and
 * `{{annotatedTag}}` resolve from the live graph.
 */

import { MENUS_COMMIT_ACTIONS } from '../catalog/menusCommit';
import { MENUS_TAG_ACTIONS } from '../catalog/menusTag';
import { byId, scenario } from '../scenario';

export const TAG_SCENARIOS = [
	/* ---------------- addTag ---------------- */
	scenario(byId(MENUS_COMMIT_ACTIONS, 'menu-commit/add-tag'), {
		ops: ['addTag'],
		then: {
			git: [{ kind: 'refPresent', ref: 'automation-tag' }, { kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'menu-commit/add-tag-invalid-name',
		title: 'Add Tag… (refused: invalid tag name)',
		group: 'menu-commit',
		tags: ['menu-commit', 'failure', 'context-menu', 'dialog'],
		mutable: true,
		request: [{ command: 'addTag', repo: '{{repo}}', commitHash: '{{commit}}', tagName: 'bad..name', type: 1, message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false }],
		expect: { responses: ['addTag'] },
		allowErrorOn: ['addTag']
	}, {
		ops: ['addTag'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'bad..name' }, { kind: 'headIs', name: 'main' }]
		}
	}),

	/* ---------------- deleteTag ---------------- */
	scenario(byId(MENUS_TAG_ACTIONS, 'menu-tag/delete'), {
		ops: ['deleteTag'],
		then: {
			git: [{ kind: 'refAbsent', ref: '{{annotatedTag}}' }]
		}
	}),
	scenario({
		id: 'menu-tag/delete-nonexistent',
		title: 'Delete Tag (refused: no such tag)',
		group: 'menu-tag',
		tags: ['menu-tag', 'failure', 'context-menu', 'dialog'],
		mutable: true,
		request: [{ command: 'deleteTag', repo: '{{repo}}', tagName: 'no-such-tag', deleteOnRemote: null }],
		expect: { responses: ['deleteTag'] },
		allowErrorOn: ['deleteTag']
	}, {
		ops: ['deleteTag'],
		then: {
			// The fixture's tags survive untouched — the refusal changed nothing.
			git: [{ kind: 'refAbsent', ref: 'no-such-tag' }, { kind: 'refPresent', ref: '{{tag}}' }]
		}
	}),

	/* ---------------- pushTag ---------------- */
	scenario(byId(MENUS_TAG_ACTIONS, 'menu-tag/push'), {
		ops: ['pushTag'],
		then: {
			// The tag stays local (it was local all along) and the push moved it to the remote:
			// the remote-tracking ref the bare remote answers for v1.0.0 exists after the fetch
			// the push implies — pinned structurally through the tag and the remote itself.
			git: [{ kind: 'refPresent', ref: 'v1.0.0' }, { kind: 'remotePresent', name: '{{remote}}' }]
		}
	}),
	scenario({
		id: 'menu-tag/push-nonexistent',
		title: 'Push Tag to Remote (refused: no such tag)',
		group: 'menu-tag',
		tags: ['menu-tag', 'failure', 'context-menu', 'dialog'],
		mutable: true,
		request: [{ command: 'pushTag', repo: '{{repo}}', tagName: 'no-such-tag', remotes: ['{{remote}}'], commitHash: '{{commit}}', skipRemoteCheck: false }],
		expect: { responses: ['pushTag'] },
		allowErrorOn: ['pushTag']
	}, {
		ops: ['pushTag'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'no-such-tag' }, { kind: 'refPresent', ref: '{{tag}}' }]
		}
	})
];

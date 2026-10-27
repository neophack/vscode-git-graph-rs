/**
 * The smoke tier's scenarios: the manual smoke checklist S1–S9 as
 * machine-runnable entries with ids `smoke/S1` … `smoke/S9` and the `smoke` tag, plus the
 * `smoke` tag on the most critical scenario of each write domain (those live in the domain
 * files). S7 (restart the extension host) and S9 (delete the engine binaries) are environment
 * manipulations no in-page step can perform: their entries declare the equivalent executable
 * surface and document the environment half the E2E entry performs around them.
 */

import { CONTROL_BAR_ACTIONS } from '../catalog/controlBar';
import { ROW_ACTIONS } from '../catalog/row';
import { byId, scenario } from '../scenario';

export const SMOKE_SCENARIOS = [
	scenario({
		id: 'smoke/S1',
		title: 'Open the Git Graph view (the commit graph loads)',
		group: 'smoke',
		tags: ['smoke', 'command'],
		mutable: false,
		// The exact command the Explorer/SCM menus and the activity bar run; a fresh tab is the
		// observable proof the panel opened (the graph itself lands with the first loadCommits).
		vscodeCommand: { command: 'git-graph-rs.view', arg: { kind: 'rootUri' } },
		expectTabs: true,
		noHostTraffic: true,
		expect: { responses: [] }
	}, {
		then: {
			dom: [{ present: 'tr.commit' }],
			responses: ['loadCommits'],
			noErrors: true
		}
	}),
	scenario(byId(CONTROL_BAR_ACTIONS, 'control-bar/load-more-commits'), {
		id: 'smoke/S2',
		tags: ['smoke', 'control-bar'],
		then: {
			responses: ['loadCommits'],
			noErrors: true
		}
	}),
	scenario(byId(ROW_ACTIONS, 'row/select-commit-row'), {
		id: 'smoke/S3',
		tags: ['smoke', 'row'],
		then: {
			dom: [{ present: '#cdvFiles .fileTreeFileRecord' }],
			responses: ['commitDetails'],
			noErrors: true
		}
	}),
	// S4 is smoke/menu-branch/checkout in scenarios/branches.ts (the checkout is the write
	// domain's critical scenario and carries the smoke tag there).
	scenario({
		id: 'smoke/S5',
		title: 'Create a tag, then delete it',
		group: 'smoke',
		tags: ['smoke'],
		mutable: true,
		// Both halves of the checklist row in one when (the delete targets the tag the create
		// made — the S5 pass condition "both operations succeed").
		request: [
			{ command: 'addTag', repo: '{{repo}}', commitHash: '{{commit}}', tagName: 'smoke-tag', type: 1, message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false },
			{ command: 'deleteTag', repo: '{{repo}}', tagName: 'smoke-tag', deleteOnRemote: null }
		],
		expect: { responses: ['addTag', 'deleteTag'] }
	}, {
		ops: ['addTag', 'deleteTag'],
		then: {
			git: [{ kind: 'refAbsent', ref: 'smoke-tag' }, { kind: 'headIs', name: 'main' }],
			noErrors: true
		}
	}),
	scenario({
		id: 'smoke/S6',
		title: 'Push to an HTTPS remote that needs credentials',
		group: 'smoke',
		tags: ['smoke', 'failure'],
		mutable: true,
		// The environment half: the E2E tier registers a credential-demanding HTTPS remote
		// (the tier's credential variant). The askpass prompt the push raises is answered by the
		// ScriptedUiPort's INPUT answers — the S6 pass condition "the credential prompt appears"
		// is exactly the prompt being answered (then.git refuses to move: the pinned test
		// credential is wrong by design, so the push itself fails with an auth error).
		given: { config: { 'remote.origin.url': 'https://git-graph-automation.invalid/repo.git' } },
		request: [{ command: 'pushBranch', repo: '{{repo}}', branchName: 'main', remotes: ['origin'], setUpstream: false, mode: '', willUpdateBranchConfig: false }],
		expect: { responses: ['pushBranch'] },
		allowErrorOn: ['pushBranch']
	}, {
		ops: ['pushBranch'],
		answers: [{ dialog: 'input', text: 'automation-token' }, { dialog: 'input', text: 'automation-token' }],
		then: {
			git: [{ kind: 'headIs', name: 'main' }]
		}
	}),
	scenario({
		id: 'smoke/S7',
		title: 'Restart the extension host (the panel recovers with its state)',
		group: 'smoke',
		tags: ['smoke', 'command'],
		mutable: false,
		// The environment half: the E2E entry runs this command (the restart), waits for the
		// host to come back, re-opens the view on the same repository and only then judges the
		// then-block — a plain command execution the scenario's when declares.
		vscodeCommand: { command: 'workbench.action.restartExtensionHost' },
		noHostTraffic: true,
		expect: { responses: [] }
	}, {
		then: {
			dom: [{ present: 'tr.commit' }],
			noErrors: true
		}
	}),
	scenario({
		id: 'smoke/S8',
		title: 'Switch the UI language to zh-cn',
		group: 'smoke',
		tags: ['smoke', 'settings'],
		mutable: false,
		// The interface-language switch through the real pipeline; the restore (back to en) is
		// the executor's job after the scenario, like every other state it resets.
		request: [{ command: 'setInterfaceLanguage', language: 'zh-cn' }],
		expect: { responses: ['setInterfaceLanguage'] }
	}, {
		then: {
			dom: [{ text: '#refreshBtn', contains: ['刷新', 'Refresh'] }],
			noErrors: true
		}
	}),
	scenario({
		id: 'smoke/S9',
		title: 'Engine binaries deleted (the CLI fallback keeps S1–S4 working)',
		group: 'smoke',
		tags: ['smoke'],
		mutable: false,
		// The environment half: the tier variant with native/ absent (the nogit/cli
		// environment). The when re-runs S3's core (a commit-details read) — under the
		// fallback the read answers through the CLI path and the view still renders it.
		ui: [
			{ op: 'waitFor', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'click', selector: 'tr.commit[data-hash="{{commit}}"]' },
			{ op: 'waitFor', selector: '#cdvFiles .fileTreeFileRecord' },
			{ op: 'click', selector: '#cdvClose' }
		],
		request: [{ command: 'commitDetails', repo: '{{repo}}', commitHash: '{{commit}}', hasParents: true, stash: null, avatarEmail: null, refresh: false }],
		expect: { responses: ['commitDetails'] }
	}, {
		then: {
			responses: ['commitDetails'],
			noErrors: true
		}
	})
];

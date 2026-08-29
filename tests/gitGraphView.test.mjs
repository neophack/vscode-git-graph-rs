/**
 * `remoteRefsFollowUpChanged` decides whether the complete (remote-refs-included) response of a
 * deferred `loadCommits` load is worth sending to the webview as a follow-up (see
 * `sendRemoteRefsFollowUp` in src/gitGraphView.ts). It must catch every way the complete response
 * can differ from the deferred one already rendered — not just a `remotes` label appearing on a
 * commit already in view, which is the only case the original implementation checked.
 */

import assert from 'node:assert/strict';
import { Module } from 'node:module';
import { describe, it } from 'node:test';

/* The stand-in for the extension host (src/gitGraphView.ts only transitively requires 'vscode'). */
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined
	},
	workspace: {
		getConfiguration: () => ({
			get: (_section, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { remoteRefsFollowUpChanged } = await import('../out/gitGraphView.js');

/** A minimal commit, with only the fields `remoteRefsFollowUpChanged` looks at. */
function commit(hash, remotes = []) {
	return { hash, parents: [], author: '', email: '', date: 0, message: '', remotes, tags: [], stash: null };
}

function commitData(commits, branches) {
	return { commits, head: null, tags: [], branches, moreCommitsAvailable: false, error: null };
}

describe('remoteRefsFollowUpChanged', () => {
	it('is FALSE when the complete response is identical to the deferred one', () => {
		const deferred = commitData([commit('a'), commit('b')], ['main']);
		const complete = commitData([commit('a'), commit('b')], ['main']);
		assert.equal(remoteRefsFollowUpChanged(deferred, complete), false);
	});

	it('is TRUE when a commit already in the window gains a remote label (the classic case)', () => {
		const deferred = commitData([commit('a'), commit('b')], ['main']);
		const complete = commitData([commit('a', [{ name: 'origin/main', remote: 'origin' }]), commit('b')], ['main', 'remotes/origin/main']);
		assert.equal(remoteRefsFollowUpChanged(deferred, complete), true);
	});

	it('is TRUE when the branch list gains a remote branch whose tip commit never entered the window', () => {
		// Same commits, same per-commit remote labels (none) — only `branches` differs, because the
		// new remote branch's tip lies beyond `maxCommits`. The old implementation, which only
		// compared `remotes` labels, missed this and left the dropdown stuck local-only.
		const deferred = commitData([commit('a'), commit('b')], ['main']);
		const complete = commitData([commit('a'), commit('b')], ['main', 'remotes/origin/stale-branch']);
		assert.equal(remoteRefsFollowUpChanged(deferred, complete), true);
	});

	it('is TRUE when a truncated window is filled by different commits with no remotes label change', () => {
		// Same length, same (empty) remotes at every index, but the actual commits differ: the
		// complete (local+remote) walk displaced a local-only commit with a remote-reachable one
		// without either carrying a `remotes` label inside the window. The old implementation only
		// diffed `remotes`, so it missed this and kept rendering the stale, deferred commit list.
		const deferred = commitData([commit('a'), commit('b')], ['main']);
		const complete = commitData([commit('a'), commit('c')], ['main']);
		assert.equal(remoteRefsFollowUpChanged(deferred, complete), true);
	});

	it('is TRUE when the commit count differs', () => {
		const deferred = commitData([commit('a')], ['main']);
		const complete = commitData([commit('a'), commit('b')], ['main']);
		assert.equal(remoteRefsFollowUpChanged(deferred, complete), true);
	});

	it('is FALSE when neither the commits, their remotes, nor the branch list changed', () => {
		const deferred = commitData([commit('a', [{ name: 'origin/main', remote: 'origin' }])], ['main', 'remotes/origin/main']);
		const complete = commitData([commit('a', [{ name: 'origin/main', remote: 'origin' }])], ['main', 'remotes/origin/main']);
		assert.equal(remoteRefsFollowUpChanged(deferred, complete), false);
	});
});

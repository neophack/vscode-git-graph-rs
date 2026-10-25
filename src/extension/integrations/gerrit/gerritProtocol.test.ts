/**
 * The Gerrit integration's pure parsing/filtering logic.
 *
 * The first describes of tests/gerrit.test.mjs (REFACTOR-PLAN task 7.1), ported with unchanged
 * assertions. The repo-backed half (GerritDataSource against a throwaway repository and the
 * engine agreement) lives in test/integration/gerrit/gerrit.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
	parseChangeRef, changeShard, parseLsRemoteChanges, limitChanges, buildFetchRefspecs, buildKeepPatterns,
	chunkFetchRefspecs, parseMetaCommit, parseMetaHistory, filterChangeStates, limitChangeStates,
	selectDisplayedChangeStates,
	nextGerritSampleWindow, GERRIT_FETCH_WINDOW_FACTOR_MAX
} from './gerritProtocol';
import { GerritDataSource } from './gerrit';

describe('change ref parsing', () => {
	it('parses remote change refs and NoteDb meta refs', () => {
		assert.deepEqual(parseChangeRef('refs/changes/24/41466/1'), { change: 41466, patchset: 1, meta: false });
		assert.deepEqual(parseChangeRef('refs/remotes/origin/changes/66/41466/2'), { change: 41466, patchset: 2, meta: false });
		assert.deepEqual(parseChangeRef('refs/remotes/origin/changes/66/41466/meta'), { change: 41466, meta: true });
	});

	it('rejects non-change refs', () => {
		assert.equal(parseChangeRef('refs/heads/main'), null);
		assert.equal(parseChangeRef('refs/tags/v1.0'), null);
		assert.equal(parseChangeRef('refs/remotes/origin/master'), null);
	});

	it('shards change numbers to two digits', () => {
		assert.equal(changeShard(41466), '66');
		assert.equal(changeShard(5), '05');
		assert.equal(changeShard(100), '00');
	});
});

describe('ls-remote output parsing', () => {
	it('collects and sorts the patchsets of each change, skipping meta refs', () => {
		const changes = parseLsRemoteChanges([
			'c1\trefs/changes/34/1234/2',
			'c2\trefs/changes/34/1234/1',
			'c3\trefs/changes/34/1234/meta',
			'c4\trefs/changes/34/1234/1', // duplicate patchset
			'c5\trefs/changes/35/1235/1'
		].join('\n'));
		assert.deepEqual([...changes.entries()], [[1234, [1, 2]], [1235, [1]]]);
	});

	it('keeps only the most recent changes up to the limit', () => {
		const changes = new Map([[1, [1]], [5, [1, 2]], [9, [1]], [3, [1]]]);
		assert.deepEqual([...limitChanges(changes, 2).keys()], [9, 5]);
		assert.equal(limitChanges(changes, 0), changes); // <= 0 => keep all
	});
});

describe('fetch refspecs', () => {
	it('fetch the latest patchset and the meta ref per change', () => {
		assert.deepEqual(buildFetchRefspecs(new Map([[1234, [1, 2]]]), 'origin', 'latest'), [
			'+refs/changes/34/1234/2:refs/remotes/origin/changes/34/1234/2',
			'+refs/changes/34/1234/meta:refs/remotes/origin/changes/34/1234/meta'
		]);
	});

	it('fetch every patchset in the all mode', () => {
		assert.deepEqual(buildFetchRefspecs(new Map([[5, [1, 2]]]), 'origin', 'all'), [
			'+refs/changes/05/5/1:refs/remotes/origin/changes/05/5/1',
			'+refs/changes/05/5/2:refs/remotes/origin/changes/05/5/2',
			'+refs/changes/05/5/meta:refs/remotes/origin/changes/05/5/meta'
		]);
	});

	it('computes the local keep prefixes of a set of changes', () => {
		assert.deepEqual(buildKeepPatterns([41466, 5], 'origin'), [
			'refs/remotes/origin/changes/66/41466/',
			'refs/remotes/origin/changes/05/5/'
		]);
	});
});

describe('fetch command batching', () => {
	/** A GitRunner that records every command and answers `runGitCommand` from the scripted errors. */
	function recordingRunner(errors: Array<string | null> = []) {
		const commands: string[][] = [];
		return {
			commands,
			runner: {
				gitOutput: async () => { throw new Error('unexpected gitOutput call'); },
				runGitCommand: async (args: string[]) => { commands.push(args); return errors[commands.length - 1] ?? null; },
				runGitCommandWithInput: async () => null
			}
		};
	}

	// 300 realistic refspecs (~29k characters): far over one command line's budget on Windows
	const manyRefspecs = Array.from({ length: 300 }, (_, i) => {
		const shard = String(i % 100).padStart(2, '0'), change = 10000 + i, patchset = (i % 7) + 1;
		const ref = `refs/changes/${shard}/${change}/${patchset}`;
		return `+${ref}:refs/remotes/origin/changes/${shard}/${change}/${patchset}`;
	});

	it('batches refspecs by command-line budget, losing none', () => {
		assert.deepEqual(chunkFetchRefspecs(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)], 65).map((batch) => batch.length), [2, 1]);
		// A refspec longer than the budget still gets its own batch rather than being dropped or split
		assert.deepEqual(chunkFetchRefspecs(['x'.repeat(10), 'y'.repeat(40)], 20), [['x'.repeat(10)], ['y'.repeat(40)]]);
		assert.deepEqual(chunkFetchRefspecs(['a', 'b']), [['a', 'b']]);
		assert.deepEqual(chunkFetchRefspecs([]), []);
	});

	it('splits a large fetch into several command-line-sized git fetch commands', async () => {
		const { commands, runner } = recordingRunner();
		const gerrit = new GerritDataSource(runner as never);
		assert.equal(await gerrit.fetchChanges('/repo', 'origin', manyRefspecs), null);
		assert.ok(commands.length > 1, 'the refspecs must be split into several commands');
		for (const args of commands) {
			assert.deepEqual(args.slice(0, 3), ['fetch', '--no-tags', 'origin']);
			assert.ok(args.slice(3).join(' ').length <= 8100, 'a batch must stay well inside the ~32k platform limit');
		}
		// Nothing lost, nothing duplicated, order kept
		assert.deepEqual(commands.flatMap((args) => args.slice(3)), manyRefspecs);
	});

	it('fetches nothing when there is nothing to fetch', async () => {
		const { commands, runner } = recordingRunner();
		assert.equal(await new GerritDataSource(runner as never).fetchChanges('/repo', 'origin', []), null);
		assert.equal(commands.length, 0);
	});

	it('stops at the first failing batch', async () => {
		const { commands, runner } = recordingRunner([null, 'the second batch failed']);
		const gerrit = new GerritDataSource(runner as never);
		assert.equal(await gerrit.fetchChanges('/repo', 'origin', manyRefspecs), 'the second batch failed');
		assert.equal(commands.length, 2, 'the batches after the failure must not run');
	});
});

describe('NoteDb meta commit parsing', () => {
	const record = (message: string, committer = 'Gerrit User 1000018', timestamp = 1700000000) => ({ committer, timestamp, message });

	it('recognises the create change event', () => {
		const parsed = parseMetaCommit(record('Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n'));
		assert.equal(parsed!.event.type, 'created');
		assert.equal(parsed!.patchset, 1);
	});

	it('collects Label footers into votes', () => {
		const parsed = parseMetaCommit(record('Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\n'));
		assert.equal(parsed!.event.type, 'vote');
		assert.deepEqual((parsed!.event as any).labels, [{ name: 'Code-Review', value: 2 }]);
	});

	it('resolves the submitter of a merge from the body', () => {
		const parsed = parseMetaCommit(record('Update patch set 3\n\nChange has been successfully merged by Alice Developer <alice@example.com>\n\nPatch-set: 3\nStatus: merged\n'));
		assert.equal(parsed!.event.type, 'merged');
		assert.equal(parsed!.status, 'merged');
		assert.equal((parsed!.event as any).reviewer, 'Alice Developer');
	});

	it('maps an Abandoned header to the abandoned status', () => {
		const parsed = parseMetaCommit(record('Abandoned\n\nPatch-set: 2\n'));
		assert.equal(parsed!.event.type, 'abandoned');
		assert.equal(parsed!.status, 'abandoned');
	});

	it('recognises work-in-progress transitions', () => {
		assert.equal(parseMetaCommit(record('Start Work In Progress\n\nPatch-set: 1\n'))?.event.type, 'wip');
		// A WIP upload must not be classified by the generic "Uploaded patch set" shape it starts with
		assert.equal(parseMetaCommit(record('Uploaded patch set 2 (WIP)\n\nPatch-set: 2\nWork-in-progress: true\n'))?.event.type, 'wip');
		assert.equal(parseMetaCommit(record('Uploaded patch set 2.\n\nPatch-set: 2\n'))?.event.type, 'patchset');
		assert.equal(parseMetaCommit(record('Remove WIP\n\nPatch-set: 1\nWork-in-progress: false\n'))?.event.type, 'ready');
	});

	it('rejects records without any patchset reference', () => {
		// No "Patch-set:" footer and no recognised header: the event cannot be anchored to a patchset
		assert.equal(parseMetaCommit(record('Status: new\n')), null);
	});
});

describe('NoteDb meta history parsing', () => {
	it('derives the state from the newest-first records: status, votes, head hash', () => {
		// Newest first, as git log outputs them
		const state = parseMetaHistory(41466, [
			{ committer: 'Gerrit User 1', timestamp: 3, message: 'Update patch set 2\n\nChange has been successfully merged by Bob\n\nPatch-set: 2\nStatus: merged\nCommit: ' + 'b'.repeat(40) + '\n' },
			{ committer: 'Gerrit User 2', timestamp: 2, message: 'Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\nLabel: Verified=+1\n' },
			{ committer: 'Gerrit User 3', timestamp: 1, message: 'Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\nStatus: new\nCommit: ' + 'a'.repeat(40) + '\n' }
		]);
		assert.equal(state!.change, 41466);
		assert.equal(state!.patchset, 2);
		assert.equal(state!.status, 'merged'); // the most recent Status footer wins
		assert.equal(state!.wip, false);
		assert.equal(state!.codeReview, 2); // the strongest vote by absolute value
		assert.equal(state!.verified, 1);
		assert.equal(state!.headHash, 'b'.repeat(40)); // the Commit of the newest record of the latest patchset
		assert.equal(state!.events.length, 3);
	});

	it('picks the latest patchset\'s head even when a newer record references an older patchset', () => {
		// Gerrit allows voting on an old patchset after a newer one was uploaded; the vote carries
		// the OLD patchset's Commit footer and is the newest record, but the change's head is still
		// the latest patchset's commit.
		const state = parseMetaHistory(41466, [
			{ committer: 'Voter', timestamp: 4, message: 'Patch Set 2: Code-Review+2\n\nPatch-set: 2\nCommit: ' + 'b'.repeat(40) + '\nLabel: Code-Review=+2\n' },
			{ committer: 'Uploader', timestamp: 3, message: 'Uploaded patch set 3.\n\nPatch-set: 3\nCommit: ' + 'c'.repeat(40) + '\n' },
			{ committer: 'Uploader', timestamp: 2, message: 'Uploaded patch set 2.\n\nPatch-set: 2\nCommit: ' + 'b'.repeat(40) + '\n' },
			{ committer: 'Owner', timestamp: 1, message: 'Create change\n\nPatch-set: 1\nCommit: ' + 'a'.repeat(40) + '\n' }
		]);
		assert.equal(state!.patchset, 3);
		assert.equal(state!.headHash, 'c'.repeat(40));
	});

	it('keeps a new change new and prefers the strongest vote even when recorded earlier', () => {
		const state = parseMetaHistory(2, [
			{ committer: 'U', timestamp: 3, message: 'Patch Set 2: Code-Review+1\n\nPatch-set: 2\nLabel: Code-Review=+1\nCommit: ' + 'd'.repeat(40) + '\n' },
			{ committer: 'U', timestamp: 2, message: 'Patch Set 1: Code-Review-2\n\nPatch-set: 1\nLabel: Code-Review=-2\n' },
			{ committer: 'U', timestamp: 1, message: 'Create change\n\nPatch-set: 1\n' }
		]);
		assert.equal(state!.status, 'new');
		assert.equal(state!.codeReview, -2); // |-2| > |+1|
	});

	it('falls back to any Commit footer when the latest patchset has none', () => {
		const state = parseMetaHistory(3, [
			{ committer: 'U', timestamp: 2, message: 'Patch Set 2: Rebase\n\nPatch-set: 2\n' },
			{ committer: 'U', timestamp: 1, message: 'Create change\n\nPatch-set: 1\nCommit: ' + 'c'.repeat(40) + '\n' }
		]);
		assert.equal(state!.headHash, 'c'.repeat(40));
	});

	it('returns null when no record carries a commit hash', () => {
		assert.equal(parseMetaHistory(4, [{ committer: 'U', timestamp: 1, message: 'Create change\n\nPatch-set: 1\n' }]), null);
	});
});

describe('status filtering', () => {
	const state = (status: string, wip = false) => ({ change: 1, patchset: 1, codeReview: 0, verified: 0, status, wip, headHash: 'h', events: [], url: null }) as never;
	const filter = { new: true, merged: false, abandoned: false, wip: false };

	it('keeps open changes and drops merged, abandoned and WIP ones by default', () => {
		const kept = filterChangeStates([state('new'), state('merged'), state('abandoned'), state('new', true)], filter);
		assert.deepEqual(kept.map((s) => s.status), ['new']);
	});

	it('shows WIP changes only under the WIP flag, whatever their status', () => {
		const wip = state('new', true);
		assert.equal(filterChangeStates([wip], { ...filter, wip: true }).length, 1);
		assert.equal(filterChangeStates([wip], { ...filter, new: true, wip: false }).length, 0);
	});

	it('shows merged and abandoned changes when their flags are on', () => {
		const kept = filterChangeStates([state('merged'), state('abandoned')], { ...filter, merged: true, abandoned: true });
		assert.deepEqual(kept.map((s) => s.status), ['merged', 'abandoned']);
	});
});

describe('display limiting (the fetch limit counts the changes shown)', () => {
	const state = (change: number, status: string, wip = false) => ({ change, patchset: 1, codeReview: 0, verified: 0, status, wip, headHash: 'h' + change, events: [], url: null }) as never;
	const filter = { new: true, merged: false, abandoned: false, wip: false };

	it('keeps the most recent changes PASSING the filter, reaching past newer filtered-out ones', () => {
		// The most recent changes are merged: an open-only filter must still surface the 2 most recent OPEN ones
		const states = [state(9, 'merged'), state(8, 'new'), state(7, 'merged'), state(6, 'abandoned'), state(5, 'new'), state(4, 'new')];
		assert.deepEqual(limitChangeStates(states, filter, 2).map((s) => s.change), [8, 5]);
	});

	it('returns the passing changes most recent first, whatever the input order', () => {
		const states = [state(3, 'new'), state(11, 'new'), state(7, 'new')];
		assert.deepEqual(limitChangeStates(states, filter, 0).map((s) => s.change), [11, 7, 3]);
	});

	it('applies the limit after the WIP rule of the status filter', () => {
		const states = [state(9, 'new', true), state(8, 'new', true), state(7, 'new')];
		assert.deepEqual(limitChangeStates(states, { ...filter, wip: true }, 2).map((s) => s.change), [9, 8]);
		assert.deepEqual(limitChangeStates(states, filter, 5).map((s) => s.change), [7]);
	});
});

describe('badge selection on a loaded page (selectDisplayedChangeStates)', () => {
	const state = (change: number, status: string, wip = false) => ({ change, patchset: 1, codeReview: 0, verified: 0, status, wip, headHash: 'h' + change, events: [], url: null }) as never;
	const all = { new: true, merged: true, abandoned: true, wip: true };
	const onPage = (...changes: number[]) => (hash: string) => changes.some((change) => hash === 'h' + change);

	it('displays the most recent passing changes that have a row on the page, one badge per change', () => {
		// 9's injected ref did not resolve (no row): its slot goes to the next change
		const states = [state(9, 'merged'), state(8, 'new'), state(7, 'new'), state(6, 'merged'), state(5, 'new')];
		assert.deepEqual(selectDisplayedChangeStates(states, all, 2, onPage(8, 6, 5)).map((s) => s.change), [8, 6]);
		assert.deepEqual(selectDisplayedChangeStates(states, all, 0, onPage(8, 6, 5)).map((s) => s.change), [8, 6, 5]);
	});

	it('applies the status filter before the page check', () => {
		const states = [state(9, 'merged'), state(8, 'new')];
		assert.deepEqual(selectDisplayedChangeStates(states, { ...all, merged: false }, 5, onPage(9, 8)).map((s) => s.change), [8]);
	});

	it('reduces to limitChangeStates when every selected change is on the page', () => {
		const states = [state(9, 'merged'), state(8, 'new'), state(7, 'abandoned')];
		assert.deepEqual(selectDisplayedChangeStates(states, all, 2, () => true), limitChangeStates(states, all, 2));
	});
});

describe('the adaptive Gerrit sample window (nextGerritSampleWindow)', () => {
	it('stops once enough sampled changes pass the filter', () => {
		assert.equal(nextGerritSampleWindow(80, 20, 20, 1000), null);
		assert.equal(nextGerritSampleWindow(80, 25, 20, 1000), null);
	});

	it('doubles the window while too few sampled changes pass the filter', () => {
		assert.equal(nextGerritSampleWindow(80, 5, 20, 1000), 160);
		assert.equal(nextGerritSampleWindow(160, 10, 20, 1000), 320);
	});

	it('stops at the remote size instead of overshooting it', () => {
		assert.equal(nextGerritSampleWindow(80, 5, 20, 100), 100);
		assert.equal(nextGerritSampleWindow(100, 5, 20, 100), null); // window already covers the whole remote
	});

	it('caps the deepening at GERRIT_FETCH_WINDOW_FACTOR_MAX times the fetch limit', () => {
		const cap = 20 * GERRIT_FETCH_WINDOW_FACTOR_MAX;
		assert.equal(nextGerritSampleWindow(cap, 5, 20, 10000), null);
		assert.equal(nextGerritSampleWindow(cap / 2, 5, 20, 10000), cap);
	});

	it('never stops solely on the cap or remote size once the target is already reached', () => {
		// passing >= fetchLimit is checked first, so it short-circuits even mid-window
		assert.equal(nextGerritSampleWindow(20, 20, 20, 10000), null);
	});
});

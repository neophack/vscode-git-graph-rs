/**
 * Tests for the data-loss guards: the exact sequences over a scripted text runner —
 * which probes run, in which order, which failures are swallowed, and which warning comes out.
 */

import { describe, expect, it } from 'vitest';

import {
	countDetachedOnlyCommits, countDetachedOnlyCommitsArgv, detachedCommitsLossWarning,
	hardResetLossWarning, GuardRunner, revParseHeadArgv, stashListArgv, statusPorcelainArgv
} from './lossGuard';

const HEAD = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';

/** A runner answering each argv by its full text (exact match), rejecting unknown ones. */
function runnerOf(answers: ReadonlyArray<[ReadonlyArray<string>, string | Error]>): GuardRunner {
	return (argv) => {
		const hit = answers.find(([expected]) => expected.join(' ') === argv.join(' '));
		if (hit === undefined) return Promise.reject(new Error('unexpected argv: ' + argv.join(' ')));
		return typeof hit[1] === 'string' ? Promise.resolve(hit[1]) : Promise.reject(hit[1]);
	};
}

describe('countDetachedOnlyCommits', () => {
	it('counts with the stash roots as anchors', async () => {
		const seen: string[][] = [];
		const run: GuardRunner = (argv) => {
			seen.push([...argv]);
			if (argv[0] === 'stash' && argv[1] === 'list') return Promise.resolve('s1\ns2\n');
			return Promise.resolve('3');
		};
		await expect(countDetachedOnlyCommits(run)).resolves.toBe(3);
		expect(seen[0]).toEqual([...stashListArgv()]);
		expect(seen[1]).toEqual(['rev-list', 'HEAD', '--not', '--branches', '--tags', '--remotes', 's1', 's2', '--count']);
	});

	it('an empty stash list contributes no roots', async () => {
		const run = runnerOf([[stashListArgv(), '']]);
		expect(countDetachedOnlyCommitsArgv([])).toEqual(['rev-list', 'HEAD', '--not', '--branches', '--tags', '--remotes', '--count']);
		await expect(countDetachedOnlyCommits(run)).resolves.toBe(0); // the count probe rejects: unknown argv
	});

	it('a failing count probe resolves to 0 (never rejects)', async () => {
		const run = runnerOf([
			[stashListArgv(), new Error('no git')],
			[countDetachedOnlyCommitsArgv([]), new Error('no git')]
		]);
		await expect(countDetachedOnlyCommits(run)).resolves.toBe(0);
	});
});

describe('detachedCommitsLossWarning', () => {
	it('returns null when nothing would be stranded', async () => {
		const run = runnerOf([
			[stashListArgv(), ''],
			[countDetachedOnlyCommitsArgv([]), '0\n']
		]);
		await expect(detachedCommitsLossWarning(run, (key) => key)).resolves.toBeNull();
	});

	it('warns with the unreachable-commit count', async () => {
		const run = runnerOf([
			[stashListArgv(), ''],
			[countDetachedOnlyCommitsArgv([]), '7\n']
		]);
		await expect(detachedCommitsLossWarning(run, (key, count) => key + ':' + count)).resolves.toEqual({
			message: 'leavingCommitsBehind:7'
		});
	});

	it('an anchor at the current HEAD strands nothing', async () => {
		const run = runnerOf([[revParseHeadArgv(), HEAD + '\n']]);
		await expect(detachedCommitsLossWarning(run, (key) => key, HEAD)).resolves.toBeNull();
	});

	it('an anchor elsewhere does not suppress the warning', async () => {
		const run = runnerOf([
			[revParseHeadArgv(), HEAD + '\n'],
			[stashListArgv(), ''],
			[countDetachedOnlyCommitsArgv([]), '2\n']
		]);
		await expect(detachedCommitsLossWarning(run, (key, count) => key + ':' + count, 'bbbb' + HEAD.slice(4)))
			.resolves.toEqual({ message: 'leavingCommitsBehind:2' });
	});

	it('a failing HEAD probe falls through to the count', async () => {
		const run = runnerOf([
			[revParseHeadArgv(), new Error('boom')],
			[stashListArgv(), ''],
			[countDetachedOnlyCommitsArgv([]), '5\n']
		]);
		await expect(detachedCommitsLossWarning(run, (key) => key, 'someRev')).resolves.toEqual({ message: 'leavingCommitsBehind' });
	});
});

describe('hardResetLossWarning', () => {
	it('returns null on a clean tree', async () => {
		const run = runnerOf([[statusPorcelainArgv(), '\n']]);
		await expect(hardResetLossWarning(run, (key) => key)).resolves.toBeNull();
	});

	it('warns when the tree is dirty', async () => {
		const run = runnerOf([[statusPorcelainArgv(), ' M file.ts\n']]);
		await expect(hardResetLossWarning(run, (key) => key)).resolves.toEqual({ message: 'hardResetLosesChanges' });
	});

	it('a failing probe counts as clean (never rejects)', async () => {
		const run = runnerOf([[statusPorcelainArgv(), new Error('boom')]]);
		await expect(hardResetLossWarning(run, (key) => key)).resolves.toBeNull();
	});
});

/**
 * The CLI read themes added for DataSource read parity (tasks 3.5): table-driven argv and parse
 * tests over a scripted `GitCli` double that records every argv and answers from a per-argv
 * script — no real Git process is spawned here (the process layer has its own tests).
 */

import { describe, expect, it } from 'vitest';

import { compareFileDiff } from './files';
import { predictConflicts } from './conflicts';
import { getGlobalUserDetails } from './config';
import { GitCli, SEPARATOR } from './process';
import { getReflog, parseReflogLines } from './reflog';
import { getRepoChangeSignature, listChangeRefs } from './refs';
import { getWorktrees } from './worktrees';
import { GitBackendError } from '../types';

/** A scripted GitCli double: `run`/`runWithInput` answer from `script`, `runDetailed` from `detailed`; every argv is recorded. */
function cliOf(
	script: { [argv: string]: string } = {},
	detailed: { [argv: string]: { code: number; stdout?: string; stderr?: string } } = {}
): { cli: GitCli; calls: string[][]; inputs: string[] } {
	const calls: string[][] = [];
	const inputs: string[] = [];
	const answerOrThrow = (args: ReadonlyArray<string>): string => {
		const answer = script[args.join(' ')];
		if (typeof answer !== 'string') throw new GitBackendError('Git', 'unexpected argv: ' + args.join(' '));
		return answer;
	};
	const cli = {
		gitPath: 'git',
		numStatCache: null,
		run: async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			return answerOrThrow(args);
		},
		runWithInput: async (args: ReadonlyArray<string>, _cwd: string, input: string) => {
			calls.push([...args]);
			inputs.push(input);
			return answerOrThrow(args);
		},
		runDetailed: async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			const answer = detailed[args.join(' ')];
			if (answer === undefined) throw new GitBackendError('Git', 'unexpected argv: ' + args.join(' '));
			return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
		}
	} as unknown as GitCli;
	return { cli, calls, inputs };
}

describe('getReflog (CLI)', () => {
	const reflogArgv = (ref: string, limit: number) => ['reflog', 'show', ref, '--format=%H\x1f%h\x1f%gd\x1f%gs', '--date=unix', '-n', String(limit + 1)].join(' ');

	it('reads one more line than the page, without flagging more when it was not truncated', async () => {
		const page = [
			'a111\x1fa111\x1fHEAD@{1700000002}\x1fcommit: newest',
			'b222\x1fb222\x1fHEAD@{1700000001}\x1fcommit: middle',
			'c333\x1fc333\x1fHEAD@{1700000000}\x1fcheckout: moving from main to other'
		].join('\n') + '\n';
		const { cli, calls } = cliOf({ [reflogArgv('HEAD', 3)]: page, 'cat-file --batch-check': '' });

		await expect(getReflog(cli, '/repo', 'HEAD', 3)).resolves.toEqual({
			entries: [
				{ hash: 'a111', abbrevHash: 'a111', selector: 'HEAD@{0}', date: 1700000002, message: 'commit: newest', dangling: false },
				{ hash: 'b222', abbrevHash: 'b222', selector: 'HEAD@{1}', date: 1700000001, message: 'commit: middle', dangling: false },
				{ hash: 'c333', abbrevHash: 'c333', selector: 'HEAD@{2}', date: 1700000000, message: 'checkout: moving from main to other', dangling: false }
			],
			moreAvailable: false
		});
		expect(calls[0]).toEqual(reflogArgv('HEAD', 3).split(' '));
	});

	it('flags moreAvailable and the dangling hashes reported missing by the batch object check', async () => {
		const page = [
			'a111\x1fa111\x1fHEAD@{1700000002}\x1fcommit: newest',
			'b222\x1fb222\x1fHEAD@{1700000001}\x1fcommit: middle',
			'c333\x1fc333\x1fHEAD@{1700000000}\x1fcommit: third'
		].join('\n');
		const { cli, calls, inputs } = cliOf({
			[reflogArgv('HEAD', 2)]: page,
			'cat-file --batch-check': 'b222 missing\n'
		});

		const result = await getReflog(cli, '/repo', 'HEAD', 2);
		expect(result.moreAvailable).toBe(true);
		expect(result.entries[0].dangling).toBe(false);
		expect(result.entries[1].dangling).toBe(true);
		expect(inputs).toEqual(['a111\nb222\n']);
		expect(calls[1]).toEqual(['cat-file', '--batch-check']);
	});

	it('keeps every entry non-dangling when the batch check fails (best-effort annotation)', async () => {
		// The double throws on any argv without a script entry, so the batch check fails here.
		const { cli } = cliOf({ [reflogArgv('HEAD', 5)]: 'a111\x1fa111\x1fHEAD@{1700000000}\x1fcommit: only' });

		await expect(getReflog(cli, '/repo', 'HEAD', 5)).resolves.toEqual({
			entries: [{ hash: 'a111', abbrevHash: 'a111', selector: 'HEAD@{0}', date: 1700000000, message: 'commit: only', dangling: false }],
			moreAvailable: false
		});
	});

	it('rejects a ref that could be misread as a git option, before anything spawns', async () => {
		const { cli, calls } = cliOf({});
		await expect(getReflog(cli, '/repo', '-oops', 5)).rejects.toMatchObject({
			name: 'GitBackendError',
			kind: 'InvalidArgument'
		});
		expect(calls).toEqual([]);
	});
});

describe('parseReflogLines', () => {
	it('parses the four-field lines and drops malformed ones', () => {
		expect(parseReflogLines([
			'a111\x1fa111\x1fHEAD@{1700000000}\x1fcommit: one',
			'too few\x1ffields',
			'b222\x1fb222\x1fno-brace-date\x1fcommit: two'
		])).toEqual([{ hash: 'a111', abbrevHash: 'a111', date: 1700000000, message: 'commit: one' }]);
	});
});

describe('getWorktrees (CLI)', () => {
	const porcelain = [
		'worktree /repo',
		'HEAD 0123456789abcdef0123456789abcdef01234567',
		'branch refs/heads/main',
		'',
		'worktree /repo-linked',
		'HEAD fedcba9876543210fedcba9876543210fedcba98',
		'detached',
		'',
		'worktree /repo-prunable',
		'HEAD abababababababababababababababababababab',
		'branch refs/heads/feature',
		'locked reason',
		'prunable reason'
	].join('\n');

	it('parses the porcelain records, marking the first as the main worktree', async () => {
		const { cli, calls } = cliOf({ 'worktree list --porcelain': porcelain });

		await expect(getWorktrees(cli, '/repo')).resolves.toEqual([
			{ path: '/repo', hash: '0123456789abcdef0123456789abcdef01234567', branch: 'main', detached: false, locked: false, prunable: false, isMain: true },
			{ path: '/repo-linked', hash: 'fedcba9876543210fedcba9876543210fedcba98', branch: null, detached: true, locked: false, prunable: false, isMain: false },
			{ path: '/repo-prunable', hash: 'abababababababababababababababababababab', branch: 'feature', detached: false, locked: true, prunable: true, isMain: false }
		]);
		expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
	});

	it('answers empty when the list cannot be read (never rejects)', async () => {
		const { cli } = cliOf({});
		await expect(getWorktrees(cli, '/repo')).resolves.toEqual([]);
	});
});

describe('predictConflicts (CLI)', () => {
	const probe = 'merge-tree --write-tree ours theirs';

	it('answers a clean merge for exit code 0', async () => {
		const { cli } = cliOf({}, { [probe]: { code: 0, stdout: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f\n' } });
		await expect(predictConflicts(cli, '/repo', 'ours', 'theirs')).resolves.toEqual({ conflicted: false, files: [] });
	});

	it('parses the porcelain conflict entries out of both streams, deduplicated', async () => {
		const { cli } = cliOf({}, {
			[probe]: {
				code: 1,
				stdout: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f\n\n100644 aaaa 1\tshared.txt\n100644 bbbb 2\tshared.txt\n',
				stderr: 'Auto-merging shared.txt\nCONFLICT (content): Merge conflict in shared.txt\n'
			}
		});
		await expect(predictConflicts(cli, '/repo', 'ours', 'theirs')).resolves.toEqual({ conflicted: true, files: ['shared.txt'] });
	});

	it('answers "no prediction available" when a failure names no conflicted file (an old Git usage error)', async () => {
		const { cli } = cliOf({}, { [probe]: { code: 129, stderr: "error: unknown option `write-tree'\nusage: git merge-tree [<options>] <branch1> <branch2>\n" } });
		await expect(predictConflicts(cli, '/repo', 'ours', 'theirs')).resolves.toBe(null);
	});

	it('does not spawn at all on a Git known to predate merge-tree --write-tree', async () => {
		const { cli, calls } = cliOf({}, { [probe]: { code: 0 } });
		await expect(predictConflicts(cli, '/repo', 'ours', 'theirs', '2.30.0')).resolves.toBe(null);
		expect(calls).toEqual([]);
	});
});

describe('ref-level composites (CLI)', () => {
	it('getRepoChangeSignature signs HEAD and every ref list with its hashes', async () => {
		const stashFormat = ['%H', '%P', '%gD', '%an', '%ae', '%ct', '%s'].join(SEPARATOR);
		const { cli } = cliOf({
			'show-ref --heads --tags -d --head': 'h1 HEAD\nh2 refs/heads/main\nt1 refs/tags/v1\n',
			'for-each-ref --format=%(objectname) %(refname) refs/remotes/': 'r1 refs/remotes/origin/main\n',
			'for-each-ref --format=%(objectname) %(*objectname) %(refname) refs/remotes/**/tags/*': '',
			'symbolic-ref -q --short HEAD': 'main\n',
			['reflog --format=' + stashFormat + ' refs/stash --']: ''
		});

		const signature = await getRepoChangeSignature(cli, '/repo');
		expect(signature).toBe(JSON.stringify([
			'h1',
			[{ hash: 'h2', name: 'main' }],
			[{ hash: 't1', name: 'v1', annotated: false }],
			[{ hash: 'r1', name: 'origin/main' }],
			[]
		]));
	});

	it('listChangeRefs reads the refname/hash pairs of a remote in one scan', async () => {
		const { cli, calls } = cliOf({
			'for-each-ref refs/remotes/origin/changes/ --format=%(refname)%00%(objectname)':
				'refs/remotes/origin/changes/12/124/meta\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' +
				'refs/remotes/origin/changes/13/135/meta\0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
		});

		await expect(listChangeRefs(cli, '/repo', 'origin')).resolves.toEqual([
			['refs/remotes/origin/changes/12/124/meta', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
			['refs/remotes/origin/changes/13/135/meta', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
		]);
		expect(calls).toEqual([['for-each-ref', 'refs/remotes/origin/changes/', '--format=%(refname)%00%(objectname)']]);
	});
});

describe('config composites (CLI)', () => {
	it('getGlobalUserDetails picks the global identity out of the global config list', async () => {
		const { cli } = cliOf({
			'--no-pager config --list -z --includes --global': 'user.name\nAlice\0user.email\nalice@example.com\0core.editor\nvim\0'
		});
		await expect(getGlobalUserDetails(cli, '/repo')).resolves.toEqual({ name: 'Alice', email: 'alice@example.com' });
	});
});

describe('compareFileDiff (CLI)', () => {
	it('diffs one file between two revisions, keeping both sides of a rename', async () => {
		const { cli, calls } = cliOf({ 'diff --no-color --find-renames a1 a2 -- old.txt new.txt': 'the diff\n' });
		await expect(compareFileDiff(cli, '/repo', 'a1', 'a2', 'old.txt', 'new.txt')).resolves.toBe('the diff\n');
		expect(calls).toEqual([['diff', '--no-color', '--find-renames', 'a1', 'a2', '--', 'old.txt', 'new.txt']]);
	});

	it('omits the right side when it is the working tree', async () => {
		const { cli, calls } = cliOf({ 'diff --no-color --find-renames a1 -- file.txt': 'the diff\n' });
		await expect(compareFileDiff(cli, '/repo', 'a1', '', 'file.txt', 'file.txt')).resolves.toBe('the diff\n');
		expect(calls).toEqual([['diff', '--no-color', '--find-renames', 'a1', '--', 'file.txt']]);
	});
});

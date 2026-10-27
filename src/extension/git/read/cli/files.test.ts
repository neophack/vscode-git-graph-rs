/**
 * The file-contents theme's `git show --textconv` read after the A3 reroute: the raw bytes come
 * from `GitCli.collect` (the process adapter's `collect` verb), so these tests pin the argv and
 * repo the verb receives, the binary detection over the bytes, and the error propagation. The
 * adapter-level spawn behaviour itself is characterized in `process.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { GitBackendError } from '../types';
import { getCommitFile } from './files';
import { GitCli } from './process';

/** A GitCli double answering `collect` from the script. */
function cliOf(collect: (args: ReadonlyArray<string>, repo: string) => Promise<Buffer>): GitCli {
	return { collect: collect } as unknown as GitCli;
}

describe('getCommitFile (after the A3 reroute)', () => {
	it('shows the file at the revision through the collect verb, with the repo as cwd', async () => {
		const calls: Array<{ args: ReadonlyArray<string>; repo: string }> = [];
		const cli = cliOf(async (args, repo) => {
			calls.push({ args: [...args], repo: repo });
			return Buffer.from('plain text');
		});
		const file = await getCommitFile(cli, '/repo', 'a123', 'src/a.txt');
		expect(calls).toEqual([{ args: ['show', '--textconv', 'a123:src/a.txt'], repo: '/repo' }]);
		expect(file).toEqual({ contents: 'plain text', binary: false });
	});

	it('marks a file with a NUL byte in the first 8000 bytes as binary and omits its contents', async () => {
		const head = Buffer.alloc(7999, 0x41);
		const body = Buffer.concat([head, Buffer.from([0x00, 0x42])]);
		const cli = cliOf(async () => body);
		const file = await getCommitFile(cli, '/repo', 'b123', 'blob.bin');
		// The NUL is inside the 8000-byte window, so the file counts as binary.
		expect(file.binary).toBe(true);
		expect(file.contents).toBeNull();
	});

	it('keeps a NUL beyond the 8000-byte window as text', async () => {
		const head = Buffer.alloc(8000, 0x41);
		const body = Buffer.concat([head, Buffer.from([0x00, 0x42])]);
		const cli = cliOf(async () => body);
		const file = await getCommitFile(cli, '/repo', 'b123', 'late.bin');
		expect(file.binary).toBe(false);
	});

	it('propagates the backend error of a failed show', async () => {
		const cli = cliOf(async () => {
			throw new GitBackendError('Git', 'fatal: bad object a123');
		});
		await expect(getCommitFile(cli, '/repo', 'a123', 'gone.txt')).rejects.toMatchObject({
			name: 'GitBackendError',
			kind: 'Git',
			message: 'fatal: bad object a123'
		});
	});
});

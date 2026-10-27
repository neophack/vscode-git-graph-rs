/**
 * The CLI read layer's spawn behaviour after the A3 reroute: every run goes through the one
 * `GitProcess` adapter, driven here over an injected spawn function (no real `git` process).
 *
 * The assertions carry over what the pre-reroute `execFile` characterization pinned — the `-c
 * i18n.logOutputEncoding=UTF-8` preamble, `maxBuffer`, the utf8 decoding, the plain inherited
 * environment (no askpass injection) and the `GitBackendError` texts — plus the two deltas the
 * consolidation deliberately made: the spawn now runs with `windowsHide: true` (the adapter's
 * one place for it), and a missing `git` reports "Git executable not found: <path>" instead of
 * the raw Node ENOENT message.
 */

import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import type { GitSpawnFn, SpawnedGit } from '../../process/gitProcess';
import { GitError } from '../../process/errors';
import { GitCli, toBackendProcessError } from './process';

type SpawnOptions = { cwd: string; env: { [name: string]: string }; windowsHide: boolean };

/** A fake child: emits the scripted stdout/stderr chunks, then 'close'. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
	readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
	killed = false;
	stdinErrorListener: ((error: Error) => void) | null = null;
	stdinData: string | undefined;

	/** The `SpawnedGit` slice the adapter consumes. */
	asSpawned(): SpawnedGit {
		const child = this as unknown as SpawnedGit;
		child.stdin = {
			end: (data?: string) => {
				this.stdinData = data;
			},
			on: (type: 'error', listener: (error: Error) => void) => {
				if (type === 'error') this.stdinErrorListener = listener;
			}
		};
		return child;
	}

	kill(): void {
		this.killed = true;
	}
}

interface SpawnCall {
	command: string;
	args: ReadonlyArray<string>;
	options: SpawnOptions;
}

/** A spawn function recording every call and answering each from the script. */
function fakeSpawn(script: { stdout?: Buffer[]; stderr?: Buffer[]; code?: number; error?: Error } = {}) {
	const calls: SpawnCall[] = [];
	const children: FakeChild[] = [];
	const spawn: GitSpawnFn = (command, args, options) => {
		calls.push({ command: command, args: args, options: options });
		const child = new FakeChild();
		children.push(child);
		Promise.resolve().then(() => {
			for (const chunk of script.stdout || []) (child.stdout as EventEmitter).emit('data', chunk);
			for (const chunk of script.stderr || []) (child.stderr as EventEmitter).emit('data', chunk);
			if (script.error !== undefined) child.emit('error', script.error);
			else child.emit('close', script.code === undefined ? 0 : script.code);
		});
		return child.asSpawned();
	};
	return { spawn: spawn, calls: calls, children: children };
}

const PIN = ['-c', 'i18n.logOutputEncoding=UTF-8'];

describe('GitCli over the process adapter (after the A3 reroute)', () => {
	it('run prepends the log-output-encoding pin and spawns with cwd, maxBuffer, windowsHide and the plain environment', async () => {
		const fake = fakeSpawn({ stdout: [Buffer.from('out')] });
		const cli = new GitCli('/bin/git', fake.spawn);
		await expect(cli.run(['log', '-1'], '/repo')).resolves.toBe('out');
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].command).toBe('/bin/git');
		expect(fake.calls[0].args).toEqual([...PIN, 'log', '-1']);
		expect(fake.calls[0].options.cwd).toBe('/repo');
		expect(fake.calls[0].options.windowsHide).toBe(true);
		// The read path runs with the inherited environment, unchanged by the adapter: no
		// askpass provider is wired for the reads.
		expect(Object.keys(fake.calls[0].options.env)).toEqual(Object.keys(process.env));
	});

	it('run decodes stdout as UTF-8 and rejects with the stderr text when git exits non-zero', async () => {
		const fake = fakeSpawn({ stdout: [Buffer.from('partial')], stderr: [Buffer.from('fatal: bad revision')], code: 128 });
		const cli = new GitCli('/bin/git', fake.spawn);
		const pending = cli.run(['log', '-1'], '/repo');
		await expect(pending).rejects.toMatchObject({ name: 'GitBackendError', kind: 'Git', message: 'fatal: bad revision' });
	});

	it('run falls back to stdout and then the exit code for the failure text', async () => {
		const stdoutFailure = fakeSpawn({ stdout: [Buffer.from('the stdout text')], code: 1 });
		const cli = new GitCli('/bin/git', stdoutFailure.spawn);
		await expect(cli.run(['log'], '/repo')).rejects.toMatchObject({ kind: 'Git', message: 'the stdout text' });

		const emptyFailure = fakeSpawn({ code: 3 });
		const other = new GitCli('/bin/git', emptyFailure.spawn);
		await expect(other.run(['log'], '/repo')).rejects.toMatchObject({ kind: 'Git', message: 'git exited with code 3' });
	});

	it('run reports a missing git executable as Unsupported with the path-named message', async () => {
		const error = Object.assign(new Error('spawn /bin/git ENOENT'), { code: 'ENOENT' });
		const fake = fakeSpawn({ error: error });
		const cli = new GitCli('/bin/git', fake.spawn);
		await expect(cli.run(['log'], '/repo')).rejects.toMatchObject({ kind: 'Unsupported', message: 'Git executable not found: /bin/git' });
	});

	it('run kills the child and maps the cancellation onto the Cancelled kind', async () => {
		const children: FakeChild[] = [];
		const spawn: GitSpawnFn = () => {
			const child = new FakeChild();
			children.push(child);
			setTimeout(() => child.emit('close', null), 30);
			return child.asSpawned();
		};
		const listeners: Array<() => void> = [];
		const signal = {
			aborted: false,
			addEventListener: (_type: 'abort', listener: () => void) => {
				listeners.push(listener);
			},
			removeEventListener: () => undefined
		};
		const cli = new GitCli('/bin/git', spawn);
		const pending = cli.run(['log', '--walk'], '/repo', signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		listeners[0]();
		await expect(pending).rejects.toMatchObject({ kind: 'Cancelled' });
		expect(children[0].killed).toBe(true);
	});

	it('runWithInput feeds the input to stdin and swallows an EPIPE on the write side', async () => {
		const fake = fakeSpawn({ stdout: [Buffer.from('answer')] });
		const cli = new GitCli('/bin/git', fake.spawn);
		const pending = cli.runWithInput(['cat-file', '--batch-check'], '/repo', 'abc123\n');
		await new Promise((resolve) => setTimeout(resolve, 0));
		// The write side's error is ignored: the command already answered through its exit.
		expect(fake.children[0].stdinErrorListener).toBeInstanceOf(Function);
		fake.children[0].stdinErrorListener!(new Error('write EPIPE'));
		expect(fake.children[0].stdinData).toBe('abc123\n');
		await expect(pending).resolves.toBe('answer');
		expect(fake.calls[0].args.slice(0, 2)).toEqual(PIN);
	});

	it('collect resolves the raw stdout bytes through the adapter', async () => {
		const bytes = Buffer.from([0x00, 0x89, 0x50]);
		const fake = fakeSpawn({ stdout: [bytes] });
		const cli = new GitCli('/bin/git', fake.spawn);
		await expect(cli.collect(['show', '--textconv', 'a:f'], '/repo')).resolves.toEqual(bytes);
		expect(fake.calls[0].args).toEqual([...PIN, 'show', '--textconv', 'a:f']);

		const failing = fakeSpawn({ stderr: [Buffer.from('fatal: not found')], code: 128 });
		const other = new GitCli('/bin/git', failing.spawn);
		await expect(other.collect(['show', 'missing:f'], '/repo')).rejects.toMatchObject({ kind: 'Git', message: 'fatal: not found' });
	});

	it('runDetailed resolves the exit code and both streams whatever the code', async () => {
		const fake = fakeSpawn({ stdout: [Buffer.from('conflict report')], stderr: [Buffer.from('a warning')], code: 1 });
		const cli = new GitCli('/bin/git', fake.spawn);
		await expect(cli.runDetailed(['merge-tree', 'a', 'b'], '/repo')).resolves.toEqual({
			code: 1,
			stdout: 'conflict report',
			stderr: 'a warning'
		});
	});

	it('runRaw runs the argv verbatim (no encoding pin) and resolves stdout plus stderr even on failure', async () => {
		const failing = fakeSpawn({ stdout: [Buffer.from('STDOUT')], stderr: [Buffer.from('STDERR')], code: 1 });
		const cli = new GitCli('/bin/git', failing.spawn);
		await expect(cli.runRaw(['verify-tag', '-v', 'tag'], '/repo')).resolves.toBe('STDOUTSTDERR');
		expect(failing.calls[0].args).toEqual(['verify-tag', '-v', 'tag']);
	});

	it('runRaw reports a missing git executable as Unsupported with the path-named message', async () => {
		const error = Object.assign(new Error('spawn /bin/git ENOENT'), { code: 'ENOENT' });
		const fake = fakeSpawn({ error: error });
		const cli = new GitCli('/bin/git', fake.spawn);
		await expect(cli.runRaw(['verify-tag', 'tag'], '/repo')).rejects.toMatchObject({
			kind: 'Unsupported',
			message: 'Git executable not found: /bin/git'
		});
	});

	it('maps a GitError onto the backend error contract by kind', () => {
		expect(toBackendProcessError(new GitError('noGit', 'No Git executable was found'), '/bin/git')).toMatchObject({
			kind: 'Unsupported',
			message: 'Git executable not found: /bin/git'
		});
		expect(toBackendProcessError(new GitError('cancelled', 'The operation was cancelled'), '/bin/git')).toMatchObject({ kind: 'Cancelled' });
		expect(toBackendProcessError(new GitError('git', 'fatal: x'), '/bin/git')).toMatchObject({ kind: 'Git', message: 'fatal: x' });
		expect(toBackendProcessError(new Error('other'), '/bin/git')).toMatchObject({ kind: 'Git', message: 'other' });
	});
});

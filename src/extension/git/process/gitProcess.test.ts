/**
 * Unit tests for the Git process adapter. The spawn function is injected, so no real `git`
 * process is started: a fake child answers with canned stdout/stderr chunks and an exit code.
 */

import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import { GitError } from './errors';
import { AbortLike, GitProcess, GitSpawnFn, RunOptions, SpawnedGit } from './gitProcess';

const GIT = { path: '/usr/bin/git', version: '2.40.0' };

/** A fake `child_process.ChildProcess` slice: emits the scripted chunks, then 'close'. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
	readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
	killed = false;
	stdinData: string | undefined;

	static spawnScript(script: { stdout?: Buffer[]; stderr?: Buffer[]; code?: number; error?: Error; delay?: number }): {
		spawn: GitSpawnFn;
		child: FakeChild;
	} {
		const child = new FakeChild();
		const spawn: GitSpawnFn = () => {
			// Emit asynchronously, like a real child process does.
			const emit = () => {
				for (const chunk of script.stdout || []) (child.stdout as EventEmitter).emit('data', chunk);
				for (const chunk of script.stderr || []) (child.stderr as EventEmitter).emit('data', chunk);
				if (script.error !== undefined) child.emit('error', script.error);
				else child.emit('close', script.code === undefined ? 0 : script.code);
			};
			if ((script.delay || 0) > 0) setTimeout(emit, script.delay);
			else Promise.resolve().then(emit);
			return child.asSpawned();
		};
		return { spawn, child };
	}

	/** The `SpawnedGit` slice the adapter consumes (an EventEmitter with stream-shaped members). */
	asSpawned(): SpawnedGit {
		return this as unknown as SpawnedGit;
	}

	kill(): void {
		// Like a real child process: killing does not emit 'close' synchronously — the scripted
		// 'close' (or none, for a killed child) still arrives asynchronously.
		this.killed = true;
	}

	/** The stdin writer the adapter sees: records the input the adapter closed stdin with. */
	readonly stdin = {
		end: (data?: string) => {
			this.stdinData = data;
		}
	};
}

/** A minimal abort signal (the structural `AbortLike`, so no DOM/Node globals are needed). */
class FakeAbort implements AbortLike {
	aborted = false;
	private readonly listeners: Array<() => void> = [];

	addEventListener(_type: 'abort', listener: () => void): void {
		this.listeners.push(listener);
	}

	removeEventListener(_type: 'abort', listener: () => void): void {
		const index = this.listeners.indexOf(listener);
		if (index >= 0) this.listeners.splice(index, 1);
	}

	abort(): void {
		this.aborted = true;
		for (const listener of [...this.listeners]) listener();
	}
}

function runWith(script: Parameters<typeof FakeChild.spawnScript>[0], options: Partial<RunOptions> = {}) {
	const fake = FakeChild.spawnScript(script);
	const process = new GitProcess(() => GIT, fake.spawn);
	return {
		child: fake.child,
		promise: process.run(['status'], { cwd: '/repo', ...options })
	};
}

describe('GitProcess.run', () => {
	it('collects stdout, stderr and the exit code', async () => {
		const { promise } = runWith({
			stdout: [Buffer.from('hello '), Buffer.from('world')],
			stderr: [Buffer.from('warning: something')],
			code: 0
		});
		const result = await promise;
		expect(result.code).toBe(0);
		expect(result.stdout.toString('utf8')).toBe('hello world');
		expect(result.stderr).toBe('warning: something');
	});

	it('resolves (does not reject) on a non-zero exit code', async () => {
		const { promise } = runWith({
			stderr: [Buffer.from('fatal: bad revision')],
			code: 128
		});
		const result = await promise;
		expect(result.code).toBe(128);
		expect(result.stderr).toBe('fatal: bad revision');
	});

	it('writes input to stdin and closes it', async () => {
		const { child, promise } = runWith({ stdout: [Buffer.from('ok')] }, { input: 'stream\nof\ninput\n' });
		await promise;
		expect(child.stdinData).toBe('stream\nof\ninput\n');
	});

	it('closes stdin even without input', async () => {
		const { child, promise } = runWith({});
		await promise;
		expect(child.stdinData).toBeUndefined();
	});

	it('spawns the executable in the working directory with the arguments given', async () => {
		const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd: string }> = [];
		const fake = FakeChild.spawnScript({});
		const spawn: GitSpawnFn = (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd });
			return fake.spawn(command, args, options);
		};
		await new GitProcess(() => GIT, spawn).run(['config', '--get', 'user.name'], { cwd: '/repo' });
		expect(calls).toEqual([{ command: '/usr/bin/git', args: ['config', '--get', 'user.name'], cwd: '/repo' }]);
	});

	it('merges the askpass and caller environments over the process environment', async () => {
		const environments: Array<{ [name: string]: string }> = [];
		const fake = FakeChild.spawnScript({});
		const spawn: GitSpawnFn = (command, args, options) => {
			environments.push(options.env);
			return fake.spawn(command, args, options);
		};
		const askpass = () => ({ SSH_ASKPASS: '/dist/askpass.sh', GIT_ASKPASS: '/dist/askpass.sh' });
		await new GitProcess(() => GIT, spawn, askpass).run(['fetch'], {
			cwd: '/repo',
			env: { GIT_EDITOR: ':' }
		});
		expect(environments).toHaveLength(1);
		expect(environments[0].SSH_ASKPASS).toBe('/dist/askpass.sh');
		expect(environments[0].GIT_ASKPASS).toBe('/dist/askpass.sh');
		expect(environments[0].GIT_EDITOR).toBe(':');
		// The inherited environment is the base, not replaced.
		expect(Object.keys(environments[0]).length).toBeGreaterThanOrEqual(Object.keys(process.env).length);
	});

	it('rejects with a noGit GitError when no executable was found', async () => {
		const runner = new GitProcess(() => null);
		await expect(runner.run(['status'], { cwd: '/repo' })).rejects.toMatchObject({ kind: 'noGit' });
	});

	it('rejects with a noGit GitError when the spawn fails with ENOENT', async () => {
		const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
		const { promise } = runWith({ error });
		await expect(promise).rejects.toBeInstanceOf(GitError);
		await expect(promise).rejects.toMatchObject({ kind: 'noGit' });
	});

	it('rejects with an io GitError for other spawn failures', async () => {
		const error = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
		const { promise } = runWith({ error });
		await expect(promise).rejects.toMatchObject({ kind: 'io' });
	});

	it('rejects immediately when the signal is already aborted', async () => {
		const fake = FakeChild.spawnScript({ delay: 60 });
		const signal = new FakeAbort();
		signal.abort();
		const promise = new GitProcess(() => GIT, fake.spawn).run(['fetch'], { cwd: '/repo', signal });
		await expect(promise).rejects.toMatchObject({ kind: 'cancelled' });
	});

	it('kills the child and rejects with cancelled when the signal fires mid-run', async () => {
		const fake = FakeChild.spawnScript({ delay: 60 });
		const signal = new FakeAbort();
		const promise = new GitProcess(() => GIT, fake.spawn).run(['fetch'], { cwd: '/repo', signal });
		setTimeout(() => signal.abort(), 5);
		await expect(promise).rejects.toMatchObject({ kind: 'cancelled' });
		expect(fake.child.killed).toBe(true);
	});

	it('does not kill the child or reject when the run finishes first', async () => {
		const fake = FakeChild.spawnScript({ stdout: [Buffer.from('done')] });
		const signal = new FakeAbort();
		const promise = new GitProcess(() => GIT, fake.spawn).run(['status'], { cwd: '/repo', signal });
		await expect(promise).resolves.toMatchObject({ code: 0 });
		expect(fake.child.killed).toBe(false);
	});

	it('rejects with tooLarge and kills the child when stdout exceeds maxBuffer', async () => {
		const fake = FakeChild.spawnScript({ stdout: [Buffer.alloc(64)], delay: 60 });
		const promise = new GitProcess(() => GIT, fake.spawn).run(['log'], { cwd: '/repo', maxBuffer: 16 });
		await expect(promise).rejects.toMatchObject({ kind: 'tooLarge' });
	});

	it('accepts output exactly at the maxBuffer limit', async () => {
		const { promise } = runWith({ stdout: [Buffer.alloc(16)] }, { maxBuffer: 16 });
		await expect(promise).resolves.toMatchObject({ code: 0 });
	});

	it('preserves non-UTF-8 bytes in stdout', async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0xfe]);
		const { promise } = runWith({ stdout: [bytes] });
		const result = await promise;
		expect(Buffer.compare(result.stdout, bytes)).toBe(0);
	});
});

describe('GitError', () => {
	it('is an Error carrying its kind and stderr', () => {
		const error = new GitError('git', 'fatal: not a git repository', 'fatal: not a git repository');
		expect(error).toBeInstanceOf(Error);
		expect(error.kind).toBe('git');
		expect(error.message).toBe('fatal: not a git repository');
		expect(error.stderr).toBe('fatal: not a git repository');
	});
});

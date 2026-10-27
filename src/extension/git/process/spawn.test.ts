/**
 * Unit tests for the generic spawn of the process seam (`spawnOutput`): the buffered,
 * never-rejecting spawn behind the pre-resolution probes (`git --version`, the platform
 * `which` search). The `child_process` module is mocked, so no real process starts.
 */

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const cpMock = vi.hoisted(() => ({
	spawn: vi.fn()
}));

vi.mock('child_process', () => ({ spawn: cpMock.spawn }));

import type { AbortLike } from './gitProcess';
import { spawnOutput } from './spawn';

/** A spawned-child double: stdout/stderr emitters plus the error/close events. */
function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: () => void;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
}

/** A minimal abort signal (the structural `AbortLike`). */
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

describe('spawnOutput', () => {
	it('collects the exit code, stdout bytes and stderr text', async () => {
		const child = fakeChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = spawnOutput('/opt/git/bin/git', ['--version']);
		child.stdout.emit('data', Buffer.from('git version '));
		child.stdout.emit('data', Buffer.from('2.45.0'));
		child.stderr.emit('data', 'warning: x');
		child.emit('close', 0);
		await expect(pending).resolves.toEqual({
			code: 0,
			error: null,
			stdout: Buffer.from('git version 2.45.0'),
			stderr: 'warning: x'
		});
	});

	it('spawns with windowsHide and no environment override unless the caller adds one', async () => {
		const child = fakeChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = spawnOutput('git', ['--version'], { cwd: '/repo' });
		child.emit('close', 0);
		await pending;
		expect(cpMock.spawn).toHaveBeenCalledWith('git', ['--version'], { cwd: '/repo', env: undefined, windowsHide: true });

		const child2 = fakeChild();
		cpMock.spawn.mockImplementationOnce(() => child2);
		const pending2 = spawnOutput('git', ['--version'], { env: { GIT_TERMINAL_PROMPT: '0' } });
		child2.emit('close', 0);
		await pending2;
		const options = cpMock.spawn.mock.calls[cpMock.spawn.mock.calls.length - 1][2];
		expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
		// The inherited environment is the base, with the caller's values on top.
		for (const key of Object.keys(process.env)) expect(options.env[key]).toBe(process.env[key]);
	});

	it('reports a spawn failure with code -1 and never rejects', async () => {
		const child = fakeChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = spawnOutput('/no/such/exe', ['--version']);
		const failure = new Error('spawn ENOENT');
		child.emit('error', failure);
		child.emit('close', 1);
		const output = await pending;
		expect(output.code).toBe(-1);
		expect(output.error).toBe(failure);
	});

	it('kills the child and reports the failure when stdout exceeds maxBuffer', async () => {
		const child = fakeChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const pending = spawnOutput('git', ['log'], { maxBuffer: 16 });
		child.stdout.emit('data', Buffer.alloc(32));
		const output = await pending;
		expect(child.kill).toHaveBeenCalled();
		expect(output.error).toMatchObject({ message: expect.stringContaining('byte limit') });
	});

	it('kills the child and reports the cancellation when the signal fires', async () => {
		const child = fakeChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const signal = new FakeAbort();
		const pending = spawnOutput('git', ['fetch'], { signal: signal });
		setTimeout(() => signal.abort(), 5);
		const output = await pending;
		expect(child.kill).toHaveBeenCalled();
		expect(output.code).toBe(-1);
		expect(output.error).toMatchObject({ message: 'cancelled' });
	});

	it('answers an already-aborted signal immediately', async () => {
		const child = fakeChild();
		cpMock.spawn.mockImplementationOnce(() => child);
		const signal = new FakeAbort();
		signal.abort();
		const output = await spawnOutput('git', ['fetch'], { signal: signal });
		expect(output.error).toMatchObject({ message: 'cancelled' });
		expect(child.kill).toHaveBeenCalled();
	});
});

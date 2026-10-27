/**
 * The hex comparison's blob-stream sites after the A3 reroute: the `GitStreamSpawner` hands out
 * the `SpawnedStream` the `GitProcess` adapter builds (stdout/stderr streams, a never-rejecting
 * exit promise, kill), so the child doubles here mimic that shape. The behaviours carry over the
 * pre-reroute characterization unchanged: the spawn argv, the size probing, the chunk capture
 * with its early finish, the kill-on-dispose and the error messages.
 */

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { CHUNK_SIZE, SideSource, SideSpec } from './hexDiffSources';

/** A spawned-child double with the `SpawnedStream` surface (exit mirrors the adapter's). */
function makeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: () => boolean;
		exit: Promise<{ code: number; error: Error | null; stderr: string }>;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => true);
	child.exit = new Promise((resolve) => {
		let stderr = '';
		child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
		child.on('error', (err: Error) => resolve({ code: -1, error: err, stderr: stderr }));
		child.on('close', (code: number | null) => resolve({ code: code === null ? -1 : code, error: null, stderr: stderr }));
	});
	return child;
}

/** A spawner double handing out scripted children, recording every spawn call. */
function spawnerOf() {
	const children: ReturnType<typeof makeChild>[] = [];
	const calls: Array<{ args: string[]; repo: string }> = [];
	const spawner = {
		spawnGitStream: (args: string[], repo: string) => {
			calls.push({ args: [...args], repo });
			const child = makeChild();
			children.push(child);
			return child;
		}
	};
	return { spawner, children, calls };
}

/** Let the spawned reader attach its stream listeners before the test streams data. */
async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function blobSide(spawner: unknown, rev: string): SideSource {
	return new SideSource(spawner as never, '/repo', { kind: 'blob', rev: rev } as SideSpec);
}

describe('SideSource blob streams (characterization before the A3 reroute)', () => {
	it('measureSize spawns cat-file -s and parses the size from stdout', async () => {
		const { spawner, children, calls } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		const pending = side.resolveSize();
		children[0].stdout.emit('data', Buffer.from('4096\n'));
		children[0].emit('close', 0);
		await expect(pending).resolves.toBe(4096);
		expect(calls).toEqual([{ args: ['cat-file', '-s', 'a123:bin'], repo: '/repo' }]);
	});

	it('measureSize answers null when git reports the object as missing', async () => {
		const { spawner, children } = spawnerOf();
		const side = blobSide(spawner, 'gone:bin');
		const pending = side.resolveSize();
		children[0].stderr.emit('data', Buffer.from("fatal: path 'gone:bin' does not exist in 'HEAD'"));
		children[0].emit('close', 128);
		await expect(pending).resolves.toBeNull();
	});

	it("measureSize rejects with git's stderr on any other non-zero exit", async () => {
		const { spawner, children } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		const pending = side.resolveSize();
		children[0].stderr.emit('data', Buffer.from('fatal: bad object'));
		children[0].emit('close', 1);
		await expect(pending).rejects.toThrow('fatal: bad object');
	});

	it('measureSize rejects with the spawn error when the child fails to start', async () => {
		const { spawner, children } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		const pending = side.resolveSize();
		const failure = new Error('spawn ENOENT');
		children[0].emit('error', failure);
		children[0].emit('close', 1);
		await expect(pending).rejects.toBe(failure);
	});

	it('captures the requested chunks (plus prefetch) in one cat-file blob pass and kills the child', async () => {
		const { spawner, children, calls } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		side.size = CHUNK_SIZE * 2;
		const first = Buffer.alloc(CHUNK_SIZE, 0x11);
		const second = Buffer.alloc(CHUNK_SIZE, 0x22);
		const pending = side.prepareRange(0, CHUNK_SIZE);
		// Wait until the reader has attached before streaming the data.
		await settled();
		children[0].stdout.emit('data', first);
		children[0].stdout.emit('data', second);
		children[0].emit('close', 0);
		await pending;
		expect(calls).toEqual([{ args: ['cat-file', 'blob', 'a123:bin'], repo: '/repo' }]);
		expect(side.hasChunk(0)).toBe(true);
		expect(side.hasChunk(1)).toBe(true);
		expect(side.sliceCached(0, CHUNK_SIZE).equals(first)).toBe(true);
		expect(side.sliceCached(CHUNK_SIZE, CHUNK_SIZE).equals(second)).toBe(true);
		expect(children[0].kill).toHaveBeenCalled();
	});

	it('finishes early (and kills the child) once the capture span is satisfied mid-stream', async () => {
		const { spawner, children } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		side.size = CHUNK_SIZE * 3;
		const pending = side.prepareRange(0, CHUNK_SIZE);
		await settled();
		// Three chunks fill the capture window (the requested chunk plus the prefetch margin);
		// the stream keeps producing after that.
		children[0].stdout.emit('data', Buffer.alloc(CHUNK_SIZE, 0x11));
		children[0].stdout.emit('data', Buffer.alloc(CHUNK_SIZE, 0x22));
		children[0].stdout.emit('data', Buffer.alloc(CHUNK_SIZE, 0x33));
		// The next chunk arrives past the capture window: the reader finishes (and kills the
		// child) WITHOUT waiting for the process to close.
		children[0].stdout.emit('data', Buffer.alloc(CHUNK_SIZE, 0x44));
		await pending;
		expect(side.hasChunk(0)).toBe(true);
		expect(side.hasChunk(1)).toBe(true);
		expect(side.hasChunk(2)).toBe(true);
		expect(children[0].kill).toHaveBeenCalled();
	});

	it("rejects a chunk read whose git pass failed, carrying git's stderr", async () => {
		const { spawner, children } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		side.size = CHUNK_SIZE;
		const pending = side.prepareRange(0, CHUNK_SIZE);
		await new Promise((resolve) => setTimeout(resolve, 0));
		children[0].stderr.emit('data', Buffer.from('fatal: object is corrupt'));
		children[0].emit('close', 128);
		await expect(pending).rejects.toThrow('fatal: object is corrupt');
		expect(children[0].kill).toHaveBeenCalled();
	});

	it("readAll concatenates the whole blob and rejects on a failure with git's stderr", async () => {
		const { spawner, children } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		const first = side.readAll();
		await settled();
		children[0].stdout.emit('data', Buffer.from('hello '));
		children[0].stdout.emit('data', Buffer.from('world'));
		children[0].emit('close', 0);
		await expect(first).resolves.toEqual(Buffer.from('hello world'));

		const second = side.readAll();
		await settled();
		children[1].stderr.emit('data', Buffer.from('fatal: another one'));
		children[1].emit('close', 1);
		await expect(second).rejects.toThrow('fatal: another one');
	});

	it('dispose kills the children still streaming', async () => {
		const { spawner, children } = spawnerOf();
		const side = blobSide(spawner, 'a123:bin');
		side.size = CHUNK_SIZE * 2;
		const pending = side.prepareRange(0, CHUNK_SIZE);
		await settled();
		side.dispose();
		expect(children[0].kill).toHaveBeenCalled();
		void pending.catch(() => undefined);
	});
});

import * as fs from 'fs';

import type { SpawnedStream } from '../../git/process/gitProcess';

/**
 * The chunked byte sources of the hex comparison: one side of a compared pair, read as
 * fixed-size chunks from `git cat-file blob` streams (or, for the working-tree side, seeked file
 * reads), with a bounded LRU cache keeping the most recent chunks resident — never a whole file.
 *
 * Split out of `hexDiff.ts` along the model's natural seam: this module
 * is the byte-access layer; the session that lays out sections and builds rows from it stays in
 * `hexDiff.ts`.
 */

/** The unit of on-demand reads, and the block size of the coarse difference scan. */
export const CHUNK_SIZE = 64 * 1024;
/** Chunks kept resident per side (6 MiB); the oldest chunks are evicted beyond this. */
const CHUNK_CACHE_LIMIT = 96;
/** Extra chunks captured past the requested span on every blob read, so that scrolling
 *  forward is served from the cache instead of a fresh `git cat-file` pass. */
const BLOB_PREFETCH_CHUNKS = 16;

/**
 * Anything that can spawn Git for streaming reads; the composition root builds it over the
 * process adapter's `stream` verb, so the windowsHide policy, the askpass
 * environment and the no-Git error are the adapter's, not this module's.
 */
export interface GitStreamSpawner {
	spawnGitStream(args: string[], repo: string): SpawnedStream;
}

/** One side of the comparison: a blob at a revision, a file in the working tree, or nothing. */
export type SideSpec = { kind: 'blob'; rev: string } | { kind: 'file'; absPath: string } | { kind: 'absent' };

export const EMPTY_BUFFER = Buffer.alloc(0);

/** Promise wrappers over the callback-style `fs` API: the minimum supported @types/node has no `fs.promises`. */
function statSize(absPath: string): Promise<number | null> {
	return new Promise((resolve, reject) => {
		fs.stat(absPath, (err, stats) => {
			if (err !== null && err !== undefined) {
				(err as NodeJS.ErrnoException).code === 'ENOENT' ? resolve(null) : reject(err);
			} else {
				resolve(stats.size);
			}
		});
	});
}

function openFile(absPath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		fs.open(absPath, 'r', (err, fd) => {
			if (err !== null && err !== undefined) reject(err);
			else resolve(fd);
		});
	});
}

function readFileAt(fd: number, position: number, buffer: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		fs.read(fd, buffer, 0, buffer.length, position, (err) => {
			if (err !== null && err !== undefined) reject(err);
			else resolve();
		});
	});
}

export class SideSource {
	public size = -1; // -1: the side does not exist

	private readonly chunks = new Map<number, Buffer>();
	private queue: Promise<void> = Promise.resolve();
	private fd: number | null = null;
	private readonly liveChildren = new Set<SpawnedStream>();

	public constructor(private readonly git: GitStreamSpawner, private readonly repo: string, public readonly spec: SideSpec) {}

	private get lastChunk(): number {
		return this.size <= 0 ? -1 : Math.floor((this.size - 1) / CHUNK_SIZE);
	}

	private chunkLength(chunk: number): number {
		return Math.max(0, Math.min(CHUNK_SIZE, this.size - chunk * CHUNK_SIZE));
	}

	/**
	 * Resolve the side's size: `git cat-file -s` for blobs, `fs.stat` for working tree files.
	 * @returns The size in bytes, or NULL when the side does not exist.
	 */
	/**
	 * Resolve the side's size and record it on the side: `git cat-file -s` for blobs,
	 * `fs.stat` for working tree files.
	 * @returns The size in bytes, or NULL when the side does not exist.
	 */
	public async resolveSize(): Promise<number | null> {
		const size = await this.measureSize();
		this.size = size !== null ? size : -1;
		return size;
	}

	private measureSize(): Promise<number | null> {
		if (this.spec.kind === 'absent') return Promise.resolve(null);
		if (this.spec.kind === 'file') return statSize(this.spec.absPath);
		const rev = this.spec.rev;
		return new Promise<number | null>((resolve, reject) => {
			let child: SpawnedStream;
			try {
				child = this.git.spawnGitStream(['cat-file', '-s', rev], this.repo);
			} catch (err) {
				reject(err);
				return;
			}
			let stdout = '';
			child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
			// The exit never rejects (the adapter guarantees that): a spawn failure surfaces as
			// the error of the outcome, exactly like the child 'error' event did before.
			void child.exit.then((exit) => {
				if (exit.error !== null) {
					reject(exit.error);
					return;
				}
				if (exit.code === 0) {
					const size = parseInt(stdout.trim(), 10);
					Number.isFinite(size) ? resolve(size) : reject(new Error(exit.stderr || stdout));
				} else if (/does not exist|bad revision|Not a valid object|ambiguous argument/.test(exit.stderr)) {
					resolve(null);
				} else {
					reject(new Error(exit.stderr || `git cat-file -s exited with code ${exit.code}`));
				}
			});
		});
	}

	/** Store a chunk in the cache, evicting the oldest entries beyond the limit. */
	public storeChunk(chunk: number, data: Buffer): void {
		if (this.size < 0) return;
		this.chunks.set(chunk, data);
		while (this.chunks.size > CHUNK_CACHE_LIMIT) {
			const oldest = this.chunks.keys().next();
			if (oldest.done) break;
			this.chunks.delete(oldest.value);
		}
	}

	public hasChunk(chunk: number): boolean {
		return this.chunks.has(chunk);
	}

	/**
	 * Make sure the chunks covering the byte range [offset, offset + length) are resident.
	 * Blob reads are serialised per side, and capture a run of chunks past the requested span,
	 * so a scrolling viewport usually costs at most one `git cat-file` pass every few screens.
	 */
	public prepareRange(offset: number, length: number): Promise<void> {
		if (this.spec.kind === 'absent' || this.size <= 0 || length <= 0) return Promise.resolve();
		const first = Math.max(0, Math.floor(offset / CHUNK_SIZE));
		const last = Math.min(this.lastChunk, Math.floor((Math.min(offset + length, this.size) - 1) / CHUNK_SIZE));
		if (first > last) return Promise.resolve();
		const run = () => this.spec.kind === 'file' ? this.readChunksFromFile(first, last) : this.readChunksFromBlob(first, last);
		const queued = this.queue.then(run, run);
		this.queue = queued.then(() => undefined, () => undefined);
		return queued;
	}

	/** Slice a prepared range out of the cache; the caller must have prepared it first. */
	public sliceCached(offset: number, length: number): Buffer {
		if (this.spec.kind === 'absent' || this.size <= 0 || length <= 0 || offset < 0 || offset >= this.size) return EMPTY_BUFFER;
		length = Math.min(length, this.size - offset);
		const first = Math.floor(offset / CHUNK_SIZE), last = Math.floor((offset + length - 1) / CHUNK_SIZE);
		if (first === last) {
			const chunk = this.chunks.get(first);
			if (chunk === undefined) return EMPTY_BUFFER;
			return chunk.subarray(offset - first * CHUNK_SIZE, offset - first * CHUNK_SIZE + length) as Buffer;
		}
		const parts: Buffer[] = [];
		for (let chunk = first; chunk <= last; chunk++) {
			const data = this.chunks.get(chunk);
			if (data === undefined) continue;
			const from = chunk === first ? offset - chunk * CHUNK_SIZE : 0;
			const to = chunk === last ? offset + length - chunk * CHUNK_SIZE : data.length;
			parts.push(data.subarray(from, to) as Buffer);
		}
		return parts.length === 0 ? EMPTY_BUFFER : Buffer.concat(parts);
	}

	private async readChunksFromFile(first: number, last: number): Promise<void> {
		if (this.spec.kind !== 'file') return;
		if (this.fd === null) this.fd = await openFile(this.spec.absPath);
		for (let chunk = first; chunk <= last; chunk++) {
			if (this.chunks.has(chunk)) continue;
			const length = this.chunkLength(chunk);
			if (length <= 0) break;
			const buffer = Buffer.alloc(length);
			await readFileAt(this.fd, chunk * CHUNK_SIZE, buffer);
			this.storeChunk(chunk, buffer);
		}
	}

	private readChunksFromBlob(first: number, last: number): Promise<void> {
		if (this.spec.kind !== 'blob') return Promise.resolve();
		const rev = this.spec.rev;
		let missing = false;
		for (let chunk = first; chunk <= last; chunk++) {
			if (!this.chunks.has(chunk)) { missing = true; break; }
		}
		if (!missing) return Promise.resolve();
		// Capturing starts at the first missing chunk and runs to the end of the requested span
		// plus a prefetch margin, in a single streaming pass over the blob.
		let captureFrom = first;
		while (captureFrom <= last && this.chunks.has(captureFrom)) captureFrom++;
		const captureTo = Math.min(this.lastChunk, last + BLOB_PREFETCH_CHUNKS);
		return new Promise<void>((resolve, reject) => {
			let child: SpawnedStream;
			try {
				child = this.git.spawnGitStream(['cat-file', 'blob', rev], this.repo);
			} catch (err) {
				reject(err);
				return;
			}
			this.liveChildren.add(child);
			let settled = false, captured = false;
			const finish = (err: Error | null) => {
				if (settled) return;
				settled = true;
				this.liveChildren.delete(child);
				try { child.kill(); } catch { /* already gone */ }
				err !== null ? reject(err) : resolve();
			};
			// The exit (child 'close', with the stderr text accumulated by the adapter) decides
			// the outcome unless the capture below finished early; a spawn failure carries the
			// error the child 'error' event used to deliver.
			void child.exit.then((exit) => {
				if (exit.error !== null) {
					finish(exit.error);
					return;
				}
				if (exit.code === 0 || captured) {
					finish(null);
				} else {
					finish(new Error(exit.stderr.trim() || `git cat-file blob exited with code ${exit.code}`));
				}
			});
			const stdout = child.stdout;
			if (stdout === null) {
				finish(null);
				return;
			}
			let skip = captureFrom * CHUNK_SIZE;
			let chunk = captureFrom, fill = 0, current: Buffer | null = null;
			stdout.on('data', (data: Buffer) => {
				if (settled) return;
				let offset = 0;
				if (skip > 0) {
					const discard = Math.min(skip, data.length);
					offset = discard;
					skip -= discard;
				}
				while (offset < data.length) {
					if (chunk > captureTo) { finish(null); return; }
					if (current === null) {
						const length = this.chunkLength(chunk);
						if (length <= 0) { finish(null); return; }
						current = Buffer.alloc(length);
						fill = 0;
					}
					const take = Math.min(current.length - fill, data.length - offset);
					data.copy(current, fill, offset, offset + take);
					fill += take;
					offset += take;
					if (fill === current.length) {
						this.storeChunk(chunk, current);
						captured = true;
						current = null;
						chunk++;
					}
				}
			});
		});
	}

	/**
	 * Read the whole side into one buffer, without touching the chunk cache — used for images,
	 * which must be handed to the webview as a single data URL. The caller is expected to have
	 * checked the size against its own limit first.
	 */
	public readAll(): Promise<Buffer> {
		if (this.spec.kind === 'file') {
			const absPath = this.spec.absPath;
			return new Promise((resolve, reject) => {
				fs.readFile(absPath, (err, data) => {
					if (err !== null && err !== undefined) reject(err);
					else resolve(data);
				});
			});
		}
		const rev = this.spec.kind === 'blob' ? this.spec.rev : '';
		const read = () => new Promise<Buffer>((resolve, reject) => {
			let child: SpawnedStream;
			try {
				child = this.git.spawnGitStream(['cat-file', 'blob', rev], this.repo);
			} catch (err) {
				reject(err);
				return;
			}
			this.liveChildren.add(child);
			const parts: Buffer[] = [];
			void child.exit.then((exit) => {
				this.liveChildren.delete(child);
				if (exit.error !== null) {
					reject(exit.error);
					return;
				}
				if (exit.code === 0) resolve(Buffer.concat(parts));
				else reject(new Error(exit.stderr.trim() || `git cat-file blob exited with code ${exit.code}`));
			});
			child.stdout?.on('data', (d: Buffer) => { parts.push(d); });
		});
		const queued = this.queue.then(read, read);
		this.queue = queued.then(() => undefined, () => undefined);
		return queued;
	}

	public dispose(): void {
		for (const child of this.liveChildren) {
			try { child.kill(); } catch { /* already gone */ }
		}
		this.liveChildren.clear();
		this.chunks.clear();
		if (this.fd !== null) {
			// Synchronous, so a disposed session releases its working-tree file immediately
			// (Windows refuses to delete files that are still open).
			try { fs.closeSync(this.fd); } catch { /* already closed */ }
			this.fd = null;
		}
	}
}

/**
 * Reads a stream of arbitrary chunk sizes as a sequence of `CHUNK_SIZE`-aligned blocks (the
 * final block of the stream may be short), which is what the scan's block comparison needs.
 */
export class BlockSource {
	private carry: Buffer[] = [];
	private carryLength = 0;
	private ended = false;
	private failure: Error | null = null;
	private waiter: (() => void) | null = null;
	public index = 0;

	public constructor(stream: NodeJS.ReadableStream) {
		stream.on('data', (data: Buffer) => {
			this.carry.push(data);
			this.carryLength += data.length;
			this.wake();
		});
		stream.on('end', () => { this.ended = true; this.wake(); });
		stream.on('error', (err: Error) => { this.failure = err; this.ended = true; this.wake(); });
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = null;
		if (waiter !== null) waiter();
	}

	public next(): Promise<Buffer | null> {
		if (this.carryLength >= CHUNK_SIZE) return Promise.resolve(this.takeBlock(CHUNK_SIZE));
		if (this.ended) {
			if (this.failure !== null) { const err = this.failure; this.failure = null; return Promise.reject(err); }
			return Promise.resolve(this.carryLength > 0 ? this.takeBlock(this.carryLength) : null);
		}
		return new Promise<Buffer | null>((resolve) => {
			this.waiter = () => { void this.next().then(resolve, () => resolve(null)); };
		});
	}

	/** The stream's terminal error, once it has failed; NULL while it is still readable. */
	public get error(): Error | null {
		return this.failure;
	}

	private takeBlock(length: number): Buffer {
		const whole = Buffer.concat(this.carry);
		const block = whole.subarray(0, length) as Buffer;
		const rest = whole.subarray(length) as Buffer;
		this.carry = rest.length > 0 ? [rest] : [];
		this.carryLength = rest.length;
		this.index++;
		return block;
	}
}

export function destroyStream(stream: NodeJS.ReadableStream): void {
	const destroy = (stream as { destroy?: () => void }).destroy;
	if (typeof destroy === 'function') destroy.call(stream);
}

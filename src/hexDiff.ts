import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitFileChange, GitFileStatus } from './types';

/**
 * The hex comparison model behind the Commit Comparison View's binary-file mode.
 *
 * Nothing here ever holds a whole file: both sides are read as fixed-size chunks from
 * `git cat-file blob` streams (or, for the working tree side, seeked file reads), only the
 * chunks the webview can currently see are fetched, and a bounded LRU cache keeps the most
 * recent ones resident. A single background scan streams both sides once to derive the coarse
 * section layout used for alignment and difference navigation; its per-block memory is a few
 * bytes per 64 KiB of file.
 */

/** Bytes shown per row of the hex comparison view. */
export const HEX_BYTES_PER_ROW = 16;
/** Height of one row in the webview, in pixels (matches the text diff's line height). */
export const HEX_ROW_HEIGHT = 19;

/** The unit of on-demand reads, and the block size of the coarse difference scan. */
const CHUNK_SIZE = 64 * 1024;
/** Chunks kept resident per side (6 MiB); the oldest chunks are evicted beyond this. */
const CHUNK_CACHE_LIMIT = 96;
/** Extra chunks captured past the requested span on every blob read, so that scrolling
 *  forward is served from the cache instead of a fresh `git cat-file` pass. */
const BLOB_PREFETCH_CHUNKS = 16;
/** Chunks of each side captured from the front during the scan, making the first viewport
 *  of the hex view instant once the scan finishes (it starts at byte 0 too). */
const SCAN_SEED_CHUNKS = 4;
/** Upper bound on the per-side block hashes kept while aligning files of different sizes
 *  (4 Mi blocks = 256 GiB of file); beyond it, alignment falls back to prefix-only. */
const MAX_HASH_BLOCKS = 1 << 22;

/** The most rows the webview may ask for in one message. */
const MAX_ROWS_PER_REQUEST = 512;

/** Anything that can spawn Git for streaming reads; `DataSource` satisfies this. */
export interface GitStreamSpawner {
	spawnGitStream(args: string[], repo: string): cp.ChildProcess;
}

/** One side of the comparison: a blob at a revision, a file in the working tree, or nothing. */
type SideSpec = { kind: 'blob'; rev: string } | { kind: 'file'; absPath: string } | { kind: 'absent' };

/** One aligned stretch of the two sides. `eq` sections have equal lengths on both sides (and
 *  equal offsets), so their rows are byte-compared on demand; every other section is shown as
 *  a replaced block, the way Beyond Compare displays an unaligned region. */
export interface HexSection {
	/** Start offset within the old side. */
	os: number;
	/** Length on the old side. */
	ol: number;
	/** Start offset within the new side. */
	ns: number;
	/** Length on the new side. */
	nl: number;
	eq: boolean;
}

/** One rendered row: the offsets of both sides (-1 when the side has no bytes on this row),
 *  the up-to-16 bytes of each side as base64, and per-byte masks ('0' equal, '1' changed). */
export interface HexRow {
	o: number;
	n: number;
	ob: string;
	nb: string;
	om: string;
	nm: string;
}

const EMPTY_BUFFER = Buffer.alloc(0);

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

/** FNV-1a with a caller-chosen basis, so two independent hashes can be combined. */
function fnv1a(buf: Buffer, basis: number, prime: number): number {
	let hash = basis;
	for (let i = 0; i < buf.length; i++) {
		hash ^= buf[i];
		hash = Math.imul(hash, prime);
	}
	return hash >>> 0;
}

class SideSource {
	public size = -1; // -1: the side does not exist

	private readonly chunks = new Map<number, Buffer>();
	private queue: Promise<void> = Promise.resolve();
	private fd: number | null = null;
	private readonly liveChildren = new Set<cp.ChildProcess>();

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
			let settled = false;
			let child: cp.ChildProcess;
			try {
				child = this.git.spawnGitStream(['cat-file', '-s', rev], this.repo);
			} catch (err) {
				reject(err);
				return;
			}
			let stdout = '', stderr = '';
			child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
			child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('error', (err) => {
				if (!settled) { settled = true; reject(err); }
			});
			child.on('close', (code) => {
				if (settled) return;
				settled = true;
				if (code === 0) {
					const size = parseInt(stdout.trim(), 10);
					Number.isFinite(size) ? resolve(size) : reject(new Error(stderr || stdout));
				} else if (/does not exist|bad revision|Not a valid object|ambiguous argument/.test(stderr)) {
					resolve(null);
				} else {
					reject(new Error(stderr || `git cat-file -s exited with code ${code}`));
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
			let child: cp.ChildProcess;
			try {
				child = this.git.spawnGitStream(['cat-file', 'blob', rev], this.repo);
			} catch (err) {
				reject(err);
				return;
			}
			this.liveChildren.add(child);
			let settled = false, captured = false, stderr = '';
			const finish = (err: Error | null) => {
				if (settled) return;
				settled = true;
				this.liveChildren.delete(child);
				try { child.kill(); } catch { /* already gone */ }
				err !== null ? reject(err) : resolve();
			};
			child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('error', (err) => finish(err));
			child.on('close', (code) => {
				if (code === 0 || captured) {
					finish(null);
				} else {
					finish(new Error(stderr.trim() || `git cat-file blob exited with code ${code}`));
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
			let child: cp.ChildProcess;
			try {
				child = this.git.spawnGitStream(['cat-file', 'blob', rev], this.repo);
			} catch (err) {
				reject(err);
				return;
			}
			this.liveChildren.add(child);
			const parts: Buffer[] = [];
			let stderr = '';
			if (child.stderr !== null) child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('error', (err) => {
				this.liveChildren.delete(child);
				reject(err);
			});
			if (child.stdout !== null) child.stdout.on('data', (d: Buffer) => { parts.push(d); });
			child.on('close', (code) => {
				this.liveChildren.delete(child);
				if (code === 0) resolve(Buffer.concat(parts));
				else reject(new Error(stderr.trim() || `git cat-file blob exited with code ${code}`));
			});
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
class BlockSource {
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

/** One file pair under hex comparison: metadata, the section layout, and the row builder. */
export class HexDiffSession {
	public oldSize = 0;
	public newSize = 0;

	private readonly oldSide: SideSource;
	private readonly newSide: SideSource;
	private sections: HexSection[] | null = null;
	private layoutSections: HexSection[] = [];
	private layoutFirstRow: number[] = [];
	private layoutRowCount = 0;
	/** Bumped on every layout change; lets the webview drop rows built for a stale layout. */
	public layoutVersion = 0;
	/** Bytes per rendered row; the webview lowers this on narrow windows. */
	private rowWidth = HEX_BYTES_PER_ROW;
	private initialised = false;
	private scanStarted = false;
	private disposed = false;
	private readonly scanChildren = new Set<cp.ChildProcess>();

	/** Set by the view; called once the background scan has produced the final section layout. */
	public onSections: ((sections: HexSection[] | null, error: string | null) => void) | null = null;

	public constructor(private readonly git: GitStreamSpawner, private readonly repo: string, fromWorkingTree: boolean, fromPath: string, fromRev: string, toWorkingTree: boolean, toPath: string, toRev: string, file: GitFileChange) {
		const oldAbsent = file.type === GitFileStatus.Added || file.type === GitFileStatus.Untracked || (file.type === GitFileStatus.Renamed && file.oldFilePath === '');
		const newAbsent = file.type === GitFileStatus.Deleted || (file.type === GitFileStatus.Renamed && file.newFilePath === '');
		const oldSpec: SideSpec = oldAbsent
			? { kind: 'absent' }
			: fromWorkingTree
				? { kind: 'file', absPath: path.join(repo, fromPath) }
				: { kind: 'blob', rev: fromRev + ':' + fromPath };
		const newSpec: SideSpec = newAbsent
			? { kind: 'absent' }
			: toWorkingTree
				? { kind: 'file', absPath: path.join(repo, toPath) }
				: { kind: 'blob', rev: toRev + ':' + toPath };
		this.oldSide = new SideSource(git, repo, oldSpec);
		this.newSide = new SideSource(git, repo, newSpec);
	}

	/**
	 * Resolve both sides' sizes and switch to the provisional layout. The coarse scan is
	 * started alongside; its result arrives through `onSections`.
	 */
	public async init(): Promise<void> {
		if (this.initialised) return;
		const sizes = await Promise.all([
			this.oldSide.resolveSize().catch((err) => { throw err instanceof Error ? err : new Error(String(err)); }),
			this.newSide.resolveSize().catch((err) => { throw err instanceof Error ? err : new Error(String(err)); })
		]);
		if (this.disposed) return;
		// Only a successful init is remembered: a failed one may be retried (e.g. the webview
		// re-entering the hex view), and must not answer with the empty default sizes.
		this.initialised = true;
		this.oldSize = sizes[0] !== null ? sizes[0] : -1;
		this.newSize = sizes[1] !== null ? sizes[1] : -1;
		if (this.oldSize < 0 && this.newSize < 0) {
			throw new Error('Neither side of the comparison exists');
		}
		this.rebuildLayout();
		this.startScanIfNeeded();
	}

	public get totalRows(): number {
		return this.layoutRowCount;
	}

	/**
	 * Set how many bytes each rendered row holds (the webview picks 16/12/8/4 to fit the window
	 * width). A change rebuilds the layout and bumps its version, so stale rows are dropped.
	 */
	public setBytesPerRow(value: number): void {
		if (value !== 4 && value !== 6 && value !== 8 && value !== 12 && value !== 16) return; // not a width the webview offers
		if (this.rowWidth === value) return;
		this.rowWidth = value;
		this.rebuildLayout();
	}

	/** The final section layout once the scan has finished, still NULL before that. */
	public get sectionLayout(): HexSection[] | null {
		return this.sections;
	}

	/**
	 * Build up to `count` rows starting at `start`, fetching only the chunks those rows touch.
	 */
	public async getRows(start: number, count: number): Promise<HexRow[]> {
		if (start < 0 || count <= 0) return [];
		count = Math.min(count, MAX_ROWS_PER_REQUEST);
		const rows: HexRow[] = [];
		// Pass 1: work out which byte ranges the rows touch, and prefetch them in bulk.
		const spans: Array<{ row: number, o: number, ol: number, n: number, nl: number, aligned: boolean }> = [];
		let oldMin = Number.MAX_SAFE_INTEGER, oldMax = 0, newMin = Number.MAX_SAFE_INTEGER, newMax = 0;
		for (let row = start; row < Math.min(start + count, this.layoutRowCount); row++) {
			const place = this.locate(row);
			if (place === null) continue;
			const { section, rowIn } = place;
			const oldRows = Math.ceil(section.ol / this.rowWidth);
			const newRows = Math.ceil(section.nl / this.rowWidth);
			let o = -1, ol = 0, n = -1, nl = 0;
			if (rowIn < oldRows) {
				o = section.os + rowIn * this.rowWidth;
				ol = Math.min(this.rowWidth, section.os + section.ol - o);
			}
			if (rowIn < newRows) {
				n = section.ns + rowIn * this.rowWidth;
				nl = Math.min(this.rowWidth, section.ns + section.nl - n);
			}
			// An aligned section (equal offsets and lengths on both sides — every section of an
			// equal-size pair, and the matched prefix/suffix of any pair) is byte-compared; the
			// unaligned middle of a different-size pair is shown as one replaced block instead.
			spans.push({ row, o, ol, n, nl, aligned: section.os === section.ns && section.ol === section.nl });
			if (o >= 0) { oldMin = Math.min(oldMin, o); oldMax = Math.max(oldMax, o + ol); }
			if (n >= 0) { newMin = Math.min(newMin, n); newMax = Math.max(newMax, n + nl); }
		}
		await Promise.all([
			this.oldSide.prepareRange(oldMin === Number.MAX_SAFE_INTEGER ? 0 : oldMin, oldMax - (oldMin === Number.MAX_SAFE_INTEGER ? 0 : oldMin)),
			this.newSide.prepareRange(newMin === Number.MAX_SAFE_INTEGER ? 0 : newMin, newMax - (newMin === Number.MAX_SAFE_INTEGER ? 0 : newMin))
		]);
		if (this.disposed) return [];
		// Pass 2: slice the bytes and derive the masks from the actual data.
		for (const span of spans) {
			const oldBytes = span.o >= 0 ? this.oldSide.sliceCached(span.o, span.ol) : EMPTY_BUFFER;
			const newBytes = span.n >= 0 ? this.newSide.sliceCached(span.n, span.nl) : EMPTY_BUFFER;
			let om = '', nm = '';
			if (span.aligned) {
				const shared = Math.min(oldBytes.length, newBytes.length);
				for (let i = 0; i < shared; i++) om += oldBytes[i] === newBytes[i] ? '0' : '1';
				for (let i = shared; i < oldBytes.length; i++) om += '1';
				for (let i = 0; i < shared; i++) nm += oldBytes[i] === newBytes[i] ? '0' : '1';
				for (let i = shared; i < newBytes.length; i++) nm += '1';
			} else {
				om = '1'.repeat(oldBytes.length);
				nm = '1'.repeat(newBytes.length);
			}
			rows.push({ o: span.o, n: span.n, ob: oldBytes.toString('base64'), nb: newBytes.toString('base64'), om, nm });
		}
		return rows;
	}

	/**
	 * The whole content of one side, for views that need the bytes in one piece (the image
	 * comparison hands them to the webview as a single data URL; its size is capped by the
	 * caller). NULL when the side does not exist.
	 */
	public async readSide(side: 'old' | 'new'): Promise<Buffer | null> {
		const source = side === 'old' ? this.oldSide : this.newSide;
		if (source.size <= 0) return null;
		return source.readAll();
	}

	public dispose(): void {
		this.disposed = true;
		this.killScanChildren();
		this.oldSide.dispose();
		this.newSide.dispose();
	}

	private provisionalSections(): HexSection[] {
		const oldLength = Math.max(0, this.oldSize), newLength = Math.max(0, this.newSize);
		return [{ os: 0, ol: oldLength, ns: 0, nl: newLength, eq: oldLength === newLength }];
	}

	private rebuildLayout(): void {
		const sections = this.sections !== null ? this.sections : this.provisionalSections();
		this.layoutSections = sections;
		this.layoutFirstRow = [];
		let row = 0;
		for (const section of sections) {
			this.layoutFirstRow.push(row);
			row += section.eq
				? Math.ceil(section.ol / this.rowWidth)
				: Math.max(Math.ceil(section.ol / this.rowWidth), Math.ceil(section.nl / this.rowWidth));
		}
		this.layoutRowCount = row;
		this.layoutVersion++;
	}

	private locate(row: number): { section: HexSection, rowIn: number } | null {
		const sections = this.layoutSections;
		let low = 0, high = sections.length - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			const first = this.layoutFirstRow[mid];
			const next = mid + 1 < sections.length ? this.layoutFirstRow[mid + 1] : this.layoutRowCount;
			if (row < first) {
				high = mid - 1;
			} else if (row >= next) {
				low = mid + 1;
			} else {
				return { section: sections[mid], rowIn: row - first };
			}
		}
		return null;
	}

	private startScanIfNeeded(): void {
		if (this.scanStarted || this.disposed) return;
		this.scanStarted = true;
		this.scan()
			.then((sections) => {
				if (this.disposed) return;
				this.sections = sections;
				this.rebuildLayout();
				if (this.onSections !== null) this.onSections(sections, null);
			})
			.catch((err) => {
				if (this.disposed || this.onSections === null) return;
				this.onSections(null, err instanceof Error ? err.message : String(err));
			});
	}

	/**
	 * Stream both sides once, in 64 KiB blocks, and derive the section layout: for equal-size
	 * sides the blocks are compared directly and differing runs become changed sections; for
	 * different sizes a common prefix and suffix are found (the suffix through block hashes,
	 * because the two streams cannot be rewound) and everything between them is one changed
	 * section, exactly how Beyond Compare frames an unmatched region.
	 */
	private async scan(): Promise<HexSection[]> {
		const oldSize = Math.max(0, this.oldSize), newSize = Math.max(0, this.newSize);
		if (oldSize === 0 || newSize === 0) {
			// One side is empty or absent: the whole of the other side is the change.
			return [{ os: 0, ol: oldSize, ns: 0, nl: newSize, eq: false }];
		}

		const oldStream = this.openScanStream(this.oldSide);
		const newStream = this.openScanStream(this.newSide);
		if (oldStream === null || newStream === null) {
			return [{ os: 0, ol: oldSize, ns: 0, nl: newSize, eq: false }];
		}
		const oldBlocks = new BlockSource(oldStream);
		const newBlocks = new BlockSource(newStream);
		const equalSizes = oldSize === newSize;

		// Differing block runs for equal sizes; prefix/suffix hashes for different sizes.
		const runs: Array<[number, number]> = [];
		let runStart = -1;
		const oldHashA: number[] = [], oldHashB: number[] = [], newHashA: number[] = [], newHashB: number[] = [];
		const hashable = !equalSizes && Math.ceil(oldSize / CHUNK_SIZE) <= MAX_HASH_BLOCKS && Math.ceil(newSize / CHUNK_SIZE) <= MAX_HASH_BLOCKS;
		let prefixBlocks = 0;
		let prefixEnded = false;
		let blockIndex = 0;

		const seedCaches = (block: Buffer) => {
			if (blockIndex < SCAN_SEED_CHUNKS) {
				if (!this.oldSide.hasChunk(blockIndex)) this.oldSide.storeChunk(blockIndex, block);
			}
		};

		try {
			for (;;) {
				// With hashing disabled (files beyond MAX_HASH_BLOCKS) and the prefix already
				// found, nothing further can be learned: the rest is one changed region.
				if (!equalSizes && !hashable && prefixEnded) break;
				const oldBlock = await oldBlocks.next();
				const newBlock = await newBlocks.next();
				if (oldBlock === null || newBlock === null) break;
				seedCaches(oldBlock);
				if (blockIndex < SCAN_SEED_CHUNKS && !this.newSide.hasChunk(blockIndex)) this.newSide.storeChunk(blockIndex, newBlock);
				if (equalSizes) {
					if (oldBlock.equals(newBlock)) {
						if (runStart >= 0) { runs.push([runStart, blockIndex]); runStart = -1; }
					} else if (runStart < 0) {
						runStart = blockIndex;
					}
				} else {
					if (hashable) {
						oldHashA.push(fnv1a(oldBlock, 0x811c9dc5, 0x01000193));
						oldHashB.push(fnv1a(oldBlock, 0xdeadbeef, 0x85ebca6b));
						newHashA.push(fnv1a(newBlock, 0x811c9dc5, 0x01000193));
						newHashB.push(fnv1a(newBlock, 0xdeadbeef, 0x85ebca6b));
					}
					if (!prefixEnded) {
						if (oldBlock.equals(newBlock)) {
							prefixBlocks++;
						} else {
							prefixEnded = true;
						}
					}
				}
				blockIndex++;
			}
			if (runStart >= 0) runs.push([runStart, Math.ceil(oldSize / CHUNK_SIZE)]);
			// Drain whichever side is longer, to complete its suffix hashes.
			if (!equalSizes && hashable) {
				for (;;) {
					const oldBlock = await oldBlocks.next();
					if (oldBlock === null) break;
					oldHashA.push(fnv1a(oldBlock, 0x811c9dc5, 0x01000193));
					oldHashB.push(fnv1a(oldBlock, 0xdeadbeef, 0x85ebca6b));
				}
				for (;;) {
					const newBlock = await newBlocks.next();
					if (newBlock === null) break;
					newHashA.push(fnv1a(newBlock, 0x811c9dc5, 0x01000193));
					newHashB.push(fnv1a(newBlock, 0xdeadbeef, 0x85ebca6b));
				}
			}
		} finally {
			this.killScanChildren();
			destroyStream(oldStream);
			destroyStream(newStream);
		}
		if (this.disposed) return [{ os: 0, ol: oldSize, ns: 0, nl: newSize, eq: false }];
		if (oldBlocks.error !== null) throw oldBlocks.error;
		if (newBlocks.error !== null) throw newBlocks.error;

		if (equalSizes) {
			const sections: HexSection[] = [];
			let prev = 0;
			for (const [from, to] of runs) {
				const start = from * CHUNK_SIZE, end = Math.min(to * CHUNK_SIZE, oldSize);
				if (start > prev) sections.push({ os: prev, ol: start - prev, ns: prev, nl: start - prev, eq: true });
				sections.push({ os: start, ol: end - start, ns: start, nl: end - start, eq: false });
				prev = end;
			}
			if (prev < oldSize) sections.push({ os: prev, ol: oldSize - prev, ns: prev, nl: oldSize - prev, eq: true });
			return sections;
		}

		const prefixBytesCoarse = Math.min(prefixBlocks * CHUNK_SIZE, Math.min(oldSize, newSize));
		const oldBlockCount = Math.ceil(oldSize / CHUNK_SIZE), newBlockCount = Math.ceil(newSize / CHUNK_SIZE);
		let suffixBlocks = 0;
		if (hashable) {
			for (;;) {
				const oldIdx = oldBlockCount - 1 - suffixBlocks, newIdx = newBlockCount - 1 - suffixBlocks;
				if (oldIdx < prefixBlocks || newIdx < prefixBlocks) break;
				const oldLen = Math.min(CHUNK_SIZE, oldSize - oldIdx * CHUNK_SIZE);
				const newLen = Math.min(CHUNK_SIZE, newSize - newIdx * CHUNK_SIZE);
				if (oldLen !== newLen || oldHashA[oldIdx] !== newHashA[newIdx] || oldHashB[oldIdx] !== newHashB[newIdx]) break;
				suffixBlocks++;
			}
		}

		// The block scan only localises the boundaries to whole chunks (and a partial trailing
		// block of unequal length on the two sides defeats suffix matching entirely). Refine
		// both ends of the middle to the byte, with one bounded read per side per boundary.
		const prefixBytes = await this.refineForward(prefixBytesCoarse);
		const oldEndCoarse = suffixBlocks > 0 ? (oldBlockCount - suffixBlocks) * CHUNK_SIZE : oldSize;
		const newEndCoarse = suffixBlocks > 0 ? (newBlockCount - suffixBlocks) * CHUNK_SIZE : newSize;
		const refinedEnds = await this.refineBackward(prefixBytes, oldEndCoarse, newEndCoarse);
		const oldSuffix = oldSize - refinedEnds.oldEnd;
		const newSuffix = newSize - refinedEnds.newEnd;

		const sections: HexSection[] = [];
		if (prefixBytes > 0) sections.push({ os: 0, ol: prefixBytes, ns: 0, nl: prefixBytes, eq: true });
		const oldMiddle = refinedEnds.oldEnd - prefixBytes, newMiddle = refinedEnds.newEnd - prefixBytes;
		if (oldMiddle > 0 || newMiddle > 0) {
			sections.push({ os: prefixBytes, ol: oldMiddle, ns: prefixBytes, nl: newMiddle, eq: false });
		}
		if (oldSuffix > 0) sections.push({ os: oldSize - oldSuffix, ol: oldSuffix, ns: newSize - newSuffix, nl: newSuffix, eq: true });
		return sections;
	}

	/** Extend a coarse prefix boundary to the exact byte where the two sides diverge. */
	private async refineForward(from: number): Promise<number> {
		const limit = Math.min(this.oldSize, this.newSize);
		let offset = from;
		while (offset < limit) {
			const length = Math.min(CHUNK_SIZE, limit - offset);
			await Promise.all([this.oldSide.prepareRange(offset, length), this.newSide.prepareRange(offset, length)]);
			const a = this.oldSide.sliceCached(offset, length);
			const b = this.newSide.sliceCached(offset, length);
			let equal = 0;
			while (equal < length && a[equal] === b[equal]) equal++;
			offset += equal;
			if (equal < length) break;
		}
		return offset;
	}

	/** Shrink the middle from its end while the two sides still agree byte for byte. */
	private async refineBackward(prefixEnd: number, oldEnd: number, newEnd: number): Promise<{ oldEnd: number, newEnd: number }> {
		while (oldEnd > prefixEnd && newEnd > prefixEnd) {
			const length = Math.min(CHUNK_SIZE, oldEnd - prefixEnd, newEnd - prefixEnd);
			await Promise.all([
				this.oldSide.prepareRange(oldEnd - length, length),
				this.newSide.prepareRange(newEnd - length, length)
			]);
			const a = this.oldSide.sliceCached(oldEnd - length, length);
			const b = this.newSide.sliceCached(newEnd - length, length);
			let equal = 0;
			while (equal < length && a[length - 1 - equal] === b[length - 1 - equal]) equal++;
			oldEnd -= equal;
			newEnd -= equal;
			if (equal < length) break;
		}
		return { oldEnd: oldEnd, newEnd: newEnd };
	}

	private openScanStream(side: SideSource): NodeJS.ReadableStream | null {
		if (side.spec.kind === 'file') {
			const stream = fs.createReadStream(side.spec.absPath, { highWaterMark: CHUNK_SIZE });
			return stream;
		}
		if (side.spec.kind === 'blob') {
			const child = this.git.spawnGitStream(['cat-file', 'blob', side.spec.rev], this.repo);
			this.scanChildren.add(child);
			if (child.stdout === null) {
				this.scanChildren.delete(child);
				try { child.kill(); } catch { /* already gone */ }
				return null;
			}
			if (child.stderr !== null) child.stderr.resume(); // the scan has no use for stderr; just drain it
			return child.stdout;
		}
		return null;
	}

	private killScanChildren(): void {
		for (const child of this.scanChildren) {
			try { child.kill(); } catch { /* already gone */ }
		}
		this.scanChildren.clear();
	}
}

function destroyStream(stream: NodeJS.ReadableStream): void {
	const destroy = (stream as { destroy?: () => void }).destroy;
	if (typeof destroy === 'function') destroy.call(stream);
}

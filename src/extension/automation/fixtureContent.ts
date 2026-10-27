import * as zlib from 'zlib';

/**
 * The fixture's deterministic content builders: everything that turns generator parameters into
 * the byte stream `git fast-import` consumes, with no filesystem or process access of its own.
 * The same seed always produces the same ref names and commit counts (hashes may differ across
 * git versions and are never asserted):
 *   - {@link buildFastImportStream} — the main history: a main line of N commits, `feature-NNN`
 *     branches cut at deterministic intervals (merged back with probability mergeRate, otherwise
 *     left open), v1.x.x tags, and (near HEAD, so a shallow page always reaches them) dedicated
 *     commits that add and then modify a real binary file and a real, decodable image;
 *   - {@link buildSubmoduleStream} — the small nested repository recorded as a gitlink on main's
 *     last commit (see {@link FIXTURE_SUBMODULE_PATH}).
 */

/**
 * Where the fixture's submodule lives inside the repository: a tiny nested repository (see
 * `buildSubmoduleStream`) recorded as a gitlink on `main`'s last commit, so the repository offers
 * a SECOND known repository (the catalog's `anotherRepo` requirement — the Repos dropdown) without
 * any state outside the repository itself. The nested repository is rebuilt deterministically by
 * `ensureSubmodule` whenever it is missing, so a write action that cleans it away is undone by the
 * next reseed.
 */
export const FIXTURE_SUBMODULE_PATH = 'sub/fixture-sub';

/** The `.gitmodules` content recording the fixture's submodule (the URL is nominal — nothing ever
 * fetches it; the nested repository is materialised locally instead). */
export const SUBMODULE_GITMODULES = '[submodule "fixture-sub"]\n\tpath = ' + FIXTURE_SUBMODULE_PATH + '\n\turl = ../fixture-sub.git\n';

/** The generation parameters; the in-process empty-repository path defaults to full-test's. */
export interface FixtureOptions {
	readonly commits: number;
	readonly branches: number;
	readonly tags: number;
	readonly mergeRate: number;
	readonly authors: number;
	readonly seed: number;
}

/**
 * The fast-import stream of the fixture submodule: a handful of commits with fixed timestamps and
 * identities, so importing it anywhere yields byte-identical objects — the gitlink recorded in the
 * main history and the locally rebuilt nested repository always agree on the submodule's HEAD.
 */
export function buildSubmoduleStream(): Buffer {
	const chunks: string[] = [];
	const identity = 'Fixture Sub <sub@fixture.dev>';
	let mark = 0;
	const data = (content: string) => 'data ' + Buffer.byteLength(content) + '\n' + content + '\n';
	const files = [
		['src/util.ts', '// fixture submodule util\nexport const answer = 42;\n'],
		['src/store.ts', '// fixture submodule store\nexport const store = [];\n'],
		['README.md', '# fixture-sub\n\nThe automation fixture\'s nested submodule repository.\n'],
		['src/util.ts', '// fixture submodule util\nexport const answer = 43; // bumped\n'],
		['src/report.ts', '// fixture submodule report\nexport const report = true;\n']
	];
	// The first commit adds src/util.ts and src/store.ts; each later commit its single entry.
	const filesOf = (i: number) => i === 0 ? [files[0], files[1]] : [files[i]];
	for (let i = 0; i < files.length; i++) {
		const blobs = filesOf(i).map(([filePath, content]) => {
			chunks.push('blob\nmark :' + (++mark) + '\n' + data(content));
			return { m: mark, filePath };
		});
		const t = 1609459200 + i * 600; // fixed: the same stream bytes every import
		chunks.push('commit refs/heads/main\nmark :' + (++mark) + '\n'
			+ 'author ' + identity + ' ' + t + ' +0000\n'
			+ 'committer ' + identity + ' ' + t + ' +0000\n'
			+ data('submodule commit ' + (i + 1) + ' of ' + files.length));
		if (i > 0) chunks.push('from :' + (mark - filesOf(i).length - 1) + '\n'); // the previous commit's mark
		for (const b of blobs) chunks.push('M 100644 :' + b.m + ' ' + b.filePath + '\n');
	}
	return Buffer.from(chunks.join(''), 'utf8');
}

/** mulberry32: a tiny seeded PRNG, so fixture content is reproducible per seed. */
export function createRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pad = (n: number, width: number): string => {
	const s = String(n);
	return s.length >= width ? s : '0'.repeat(width - s.length) + s;
};

/** CRC-32 (IEEE 802.3), the checksum every PNG chunk trailer carries. */
let crc32Table: Uint32Array | undefined;
function crc32(buf: Buffer): number {
	let table = crc32Table;
	if (table === undefined) {
		table = crc32Table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
			table[n] = c >>> 0;
		}
	}
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData), 0);
	return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A tiny, real, decodable solid-colour PNG (8-bit truecolour, no filtering) — no external asset
 * file, so the fixture generator stays self-contained, but the bytes are a genuine image a
 * viewer can decode, not a `.png`-named placeholder.
 */
function makeSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour (RGB)
	const raw = Buffer.alloc(height * (1 + width * 3));
	let p = 0;
	for (let y = 0; y < height; y++) {
		raw[p++] = 0; // filter type: none
		for (let x = 0; x < width; x++) { raw[p++] = rgb[0]; raw[p++] = rgb[1]; raw[p++] = rgb[2]; }
	}
	return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Deterministic pseudo-random binary content. The leading NUL guarantees git's own binary
 * heuristic classifies it as binary regardless of what random bytes follow.
 */
function makeBinaryBlob(rng: () => number, size: number): Buffer {
	const buf = Buffer.alloc(size);
	for (let i = 1; i < size; i++) buf[i] = Math.floor(rng() * 256);
	return buf;
}

interface FileEntry {
	readonly filePath: string;
	readonly content: string | Buffer;
	/** A gitlink (submodule) entry: the nested commit's hash, recorded with mode 160000 instead of a blob. */
	readonly gitlink?: string;
}

interface CommitRef {
	readonly mark: number;
	readonly ts: number;
	readonly authorIndex: number;
}

/**
 * Build the fast-import stream for the whole fixture. Mark numbering is sequential from 1;
 * blob/commit/tag records carry explicit marks; commits use `author`/`committer` lines with
 * timestamps starting 2020-01-01 and advancing 60-120 s per commit; file changes are inline
 * `M 100644 <path>` blocks fed from marked blobs. The final main-line commit records the fixture
 * submodule (see {@see FIXTURE_SUBMODULE_PATH}) as `.gitmodules` + a gitlink to `submoduleSha`.
 */
export function buildFastImportStream(opts: FixtureOptions, submoduleSha: string): Buffer {
	const { commits, branches, tags, mergeRate, authors, seed } = opts;
	const rng = createRng(seed);
	const chunks: (string | Buffer)[] = [];
	let mark = 0;
	let timestamp = 1609459200; // 2020-01-01T00:00:00Z
	let seq = 0; // global commit counter, drives the author round-robin
	const modules = Math.min(100, Math.max(10, Math.round(commits / 200)));
	const filesPerModule = 5;

	const data = (content: string) => 'data ' + Buffer.byteLength(content) + '\n' + content + '\n';

	/** `content` is a UTF-8 string for ordinary source files, or a Buffer for binary/image ones. */
	const emitBlob = (content: string | Buffer) => {
		const m = ++mark;
		if (Buffer.isBuffer(content)) {
			chunks.push(Buffer.concat([Buffer.from('blob\nmark :' + m + '\ndata ' + content.length + '\n'), content, Buffer.from('\n')]));
		} else {
			chunks.push('blob\nmark :' + m + '\n' + data(content));
		}
		return m;
	};

	const identity = (n: number) => 'Fixture Author ' + pad(n, 2) + ' <author-' + pad(n, 2) + '@fixture>';

	const nextTimestamp = () => {
		const t = timestamp;
		timestamp += 60 + Math.floor(rng() * 61); // 60-120 s per commit
		return t;
	};

	const pickFiles = (): FileEntry[] => {
		const count = 1 + Math.floor(rng() * 3); // 1-3 files per commit
		const byPath = new Map<string, string>();
		for (let i = 0; i < count; i++) {
			const mod = Math.floor(rng() * modules);
			const file = Math.floor(rng() * filesPerModule);
			const filePath = 'src/module-' + pad(mod, 3) + '/file-' + pad(file, 2) + '.ts';
			if (byPath.has(filePath)) continue;
			const lines = ['// fixture: module ' + pad(mod, 3) + ' file ' + pad(file, 2)];
			const lineCount = 2 + Math.floor(rng() * 3);
			for (let l = 0; l < lineCount; l++) lines.push('// ' + Math.floor(rng() * 1e9).toString(36));
			lines.push('export const value_' + mod + '_' + file + ' = ' + Math.floor(rng() * 1000) + ';');
			byPath.set(filePath, lines.join('\n'));
		}
		return Array.from(byPath.entries()).map(([filePath, content]) => ({ filePath, content }));
	};

	const emitCommit = (ref: string, message: string, parents: number[], filesOverride?: FileEntry[]): CommitRef => {
		const files = filesOverride ?? pickFiles();
		const blobMarks = files.filter((f) => f.gitlink === undefined).map((f) => emitBlob(f.content));
		const m = ++mark;
		const authorIndex = seq % authors;
		seq++;
		const t = nextTimestamp();
		let rec = 'commit ' + ref + '\nmark :' + m + '\n'
			+ 'author ' + identity(authorIndex) + ' ' + t + ' +0000\n'
			+ 'committer ' + identity(authorIndex) + ' ' + t + ' +0000\n'
			+ data(message);
		// The FIRST parent must be a `from` line: fast-import treats a commit without one as a
		// ROOT when it opens a new ref, which silently detached every feature branch from main —
		// the branches then shared no history with it at all, and git correctly refused the
		// catalog's cross-branch operations ("refusing to merge unrelated histories"). With
		// `from` the branch really branches off; main's linear continuation is unchanged.
		if (parents.length > 0) rec += 'from :' + parents[0] + '\n';
		for (const p of parents.slice(1)) rec += 'merge :' + p + '\n';
		let blobIndex = 0;
		for (const f of files) {
			// A gitlink records the nested repository's commit hash directly (mode 160000): the
			// object need not exist in this repository — fast-import accepts a fully spelled hash.
			rec += f.gitlink !== undefined
				? 'M 160000 ' + f.gitlink + ' ' + f.filePath + '\n'
				: 'M 100644 :' + blobMarks[blobIndex++] + ' ' + f.filePath + '\n';
		}
		chunks.push(rec);
		return { mark: m, ts: t, authorIndex };
	};

	const emitTag = (name: string, target: CommitRef) => {
		if (rng() < 0.3 || tagIndex === tags - 1) { // ~30% annotated; the NEWEST tag always is, so the loaded first page always offers one near HEAD (menu-tag's View Details / Delete)
			chunks.push('tag ' + name + '\nfrom :' + target.mark + '\n'
				+ 'tagger ' + identity(target.authorIndex) + ' ' + target.ts + ' +0000\n'
				+ data('tag ' + name));
		} else { // lightweight, via reset
			chunks.push('reset refs/tags/' + name + '\nfrom :' + target.mark + '\n');
		}
	};

	// Branch cut points spread across the main line (deterministic, deduplicated).
	const cutPoints = new Set<number>();
	if (branches > 0 && commits > 1) {
		for (let b = 0; b < branches; b++) {
			const at = Math.floor(((b + 1) * commits) / (branches + 1));
			if (at > 0 && at < commits) cutPoints.add(at);
		}
	}

	let mainMark = 0;
	let pendingMergeMark = 0;
	let pendingBranchNum = -1;
	let branchCount = 0;
	let tagIndex = 0;
	const tagEvery = tags > 0 ? Math.max(1, Math.floor(commits / tags)) : 0;

	// A handful of dedicated main-line commits, each changing ONLY the named asset, placed near
	// HEAD (not spread across the whole history) so a shallow page of commits always reaches
	// them regardless of the fixture's total size: add the binary file, add the image, modify
	// the binary file, modify the image — in that order, oldest to newest. Skipped for very
	// small fixtures (below the automation catalog's smallest test cases) where there is no room.
	const BINARY_PATH = 'assets/archive.bin';
	const IMAGE_PATH = 'assets/logo.png';
	const specialAt = commits >= 25 ? {
		binaryAdd: commits - 20,
		imageAdd: commits - 15,
		binaryMod: commits - 10,
		imageMod: commits - 5
	} : null;

	for (let i = 0; i < commits; i++) {
		if (cutPoints.has(i) && mainMark !== 0) {
			const num = branchCount++;
			const ref = 'refs/heads/feature-' + pad(num, 3);
			const length = 5 + Math.floor(rng() * 46); // 5-50 commits on the branch
			let parent = mainMark;
			let tip = 0;
			for (let j = 0; j < length; j++) {
				tip = emitCommit(ref, 'commit ' + (j + 1) + ' on ' + ref.slice('refs/heads/'.length), [parent]).mark;
				parent = tip;
			}
			if (rng() < mergeRate) {
				pendingMergeMark = tip;
				pendingBranchNum = num;
			} // otherwise the branch stays open at its tip
		}

		const parents: number[] = [];
		if (mainMark !== 0) parents.push(mainMark);
		if (pendingMergeMark !== 0) parents.push(pendingMergeMark);

		let filesOverride: FileEntry[] | undefined, specialMessage: string | undefined;
		if (specialAt !== null && pendingMergeMark === 0) {
			if (i === specialAt.binaryAdd) { filesOverride = [{ filePath: BINARY_PATH, content: makeBinaryBlob(rng, 512) }]; specialMessage = 'add a binary asset'; }
			else if (i === specialAt.imageAdd) { filesOverride = [{ filePath: IMAGE_PATH, content: makeSolidPng(8, 8, [200, 60, 60]) }]; specialMessage = 'add an image asset'; }
			else if (i === specialAt.binaryMod) { filesOverride = [{ filePath: BINARY_PATH, content: makeBinaryBlob(rng, 640) }]; specialMessage = 'update the binary asset'; }
			else if (i === specialAt.imageMod) { filesOverride = [{ filePath: IMAGE_PATH, content: makeSolidPng(8, 8, [60, 120, 200]) }]; specialMessage = 'update the image asset'; }
		}

		const message = pendingMergeMark !== 0
			? 'Merge branch \'feature-' + pad(pendingBranchNum, 3) + '\''
			: specialMessage ?? ('commit ' + (i + 1) + ' on main');
		// The FINAL main-line commit records the fixture's submodule: `.gitmodules` as a regular
		// file and the nested repository's HEAD as a gitlink (mode 160000), so every checkout of
		// the history carries the submodule registration. Ordinary files ride along too, keeping
		// the stashes seedRepo creates well away from `.gitmodules`.
		const submoduleFiles: FileEntry[] = i === commits - 1
			? [{ filePath: '.gitmodules', content: SUBMODULE_GITMODULES }, { filePath: FIXTURE_SUBMODULE_PATH, content: '', gitlink: submoduleSha }]
			: [];
		const head = emitCommit('refs/heads/main', message, parents, filesOverride !== undefined ? filesOverride.concat(submoduleFiles) : pickFiles().concat(submoduleFiles));
		mainMark = head.mark;
		pendingMergeMark = 0;

		if (tagIndex < tags && tagEvery > 0 && i % tagEvery === 0) {
			emitTag('v1.' + tagIndex + '.0', head);
			tagIndex++;
		}
	}

	return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'))));
}

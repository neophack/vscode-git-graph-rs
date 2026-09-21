import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as zlib from 'zlib';

/**
 * The deterministic large-repository generator behind both automation entry points. Builds a git
 * history in memory as a `git fast-import` stream — a main line of N commits on `main`,
 * `feature-NNN` branches cut at deterministic intervals (merged back with probability mergeRate,
 * otherwise left open), v1.x.x tags, and (near HEAD, so a shallow page always reaches them) a
 * handful of dedicated commits that add and then modify a real binary file (`assets/archive.bin`)
 * and a real, decodable image (`assets/logo.png`, a solid-colour PNG built by hand — no external
 * asset). The same seed always produces the same ref names and commit counts (hashes may differ
 * across git versions and are never asserted).
 *
 * Two ways the history reaches a working repository:
 *   - `generate({ outDir, ... })` — the scripted path (scripts/automation/fixture.mjs, full-test):
 *     fast-import into a scratch repo, clone it bare as `<outDir>/fixture-remote.git`, clone a
 *     working `<outDir>/fixture` from it, and write the `.gg-fixture` marker.
 *   - `seedEmptyRepo(repo, ...)` — the in-process path (the "Run Automation Test" button): the
 *     active repository has NO commits at all, so it cannot hold real work in git terms — the
 *     history is fast-imported into a throwaway bare remote under the OS temp dir, fetched into
 *     the repository, `main` checked out, the `.gg-fixture` marker written, and the volatile seed
 *     state (stashes, untracked file, local-ahead branch) replayed. The marker's remote keeps the
 *     pristine history for the suite runner's between-phases reseed.
 *
 * `seedRepo(repoDir)` seeds a freshly-cloned (or freshly-generated) repository with the volatile
 * state the automation catalog expects: three stashes, one untracked file, and a local-ahead
 * branch one commit ahead of origin. Idempotent.
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120000;
/* One identity/config for every git call: deterministic content, no global-config dependence. */
const GIT_BASE_ARGS = [
	'-c', 'core.autocrlf=false',
	'-c', 'init.defaultBranch=main',
	'-c', 'user.name=Fixture',
	'-c', 'user.email=fixture@fixture.dev'
];

/** The generation parameters; the in-process empty-repository path defaults to full-test's. */
export interface FixtureOptions {
	readonly commits: number;
	readonly branches: number;
	readonly tags: number;
	readonly mergeRate: number;
	readonly authors: number;
	readonly seed: number;
}

/** What the "Run Automation Test" button generates into an empty repository: 2000+ commits in total. */
export const EMPTY_REPO_FIXTURE_OPTIONS: Readonly<FixtureOptions> = {
	commits: 2000, branches: 50, tags: 40, mergeRate: 0.12, authors: 20, seed: 12345
};

/** mulberry32: a tiny seeded PRNG, so fixture content is reproducible per seed. */
function createRng(seed: number): () => number {
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

/** Remove a directory tree across the Node versions this extension builds against (same feature-detect as suiteRunner's). */
function rmRecursive(target: string): void {
	const f = fs as unknown as {
		rmSync?: (p: string, o: { recursive: boolean; force: boolean }) => void;
		rmdirSync: (p: string, o?: { recursive?: boolean }) => void;
	};
	if (f.rmSync !== undefined) {
		f.rmSync(target, { recursive: true, force: true });
	} else {
		f.rmdirSync(target, { recursive: true });
	}
}

/** Remove a file if it exists (single files have a floor-safe API everywhere). */
function rmFile(target: string): void {
	try {
		fs.unlinkSync(target);
	} catch (_) {
		// already gone
	}
}

/** mkdir -p (the recursive option postdates the typings' floor; the runtime has had it for years). */
function mkdirAll(target: string): void {
	const f = fs as unknown as { mkdirSync: (p: string, o?: { recursive?: boolean }) => void };
	f.mkdirSync(target, { recursive: true });
}

function git(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string }> {
	return execFileAsync('git', [...GIT_BASE_ARGS, ...args], {
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		...options
	});
}

/** Feed the whole stream to `git fast-import --quiet` in the given working directory. */
function fastImport(cwd: string, stream: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', [...GIT_BASE_ARGS, 'fast-import', '--quiet'], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
		});
		let stderr = '';
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error('git fast-import exited with code ' + code + ': ' + stderr.trim()));
		});
		child.stdin.once('error', reject);
		child.stdin.write(stream, (err: Error | null | undefined) => {
			if (err !== null && err !== undefined) reject(err);
			else child.stdin.end();
		});
	});
}

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
 * `M 100644 <path>` blocks fed from marked blobs.
 */
function buildFastImportStream(opts: FixtureOptions): Buffer {
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
		const blobMarks = files.map((f) => emitBlob(f.content));
		const m = ++mark;
		const authorIndex = seq % authors;
		seq++;
		const t = nextTimestamp();
		let rec = 'commit ' + ref + '\nmark :' + m + '\n'
			+ 'author ' + identity(authorIndex) + ' ' + t + ' +0000\n'
			+ 'committer ' + identity(authorIndex) + ' ' + t + ' +0000\n'
			+ data(message);
		for (const p of parents.slice(1)) rec += 'merge :' + p + '\n';
		files.forEach((f, i) => {
			rec += 'M 100644 :' + blobMarks[i] + ' ' + f.filePath + '\n';
		});
		chunks.push(rec);
		return { mark: m, ts: t, authorIndex };
	};

	const emitTag = (name: string, target: CommitRef) => {
		if (rng() < 0.3) { // ~30% annotated
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
		const head = emitCommit('refs/heads/main', message, parents, filesOverride);
		mainMark = head.mark;
		pendingMergeMark = 0;

		if (tagIndex < tags && tagEvery > 0 && i % tagEvery === 0) {
			emitTag('v1.' + tagIndex + '.0', head);
			tagIndex++;
		}
	}

	return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'))));
}

function validatedOptions(options: Partial<FixtureOptions>): FixtureOptions {
	const opts: FixtureOptions = { ...EMPTY_REPO_FIXTURE_OPTIONS, ...options };
	if (!Number.isInteger(opts.commits) || opts.commits < 1) throw new Error('commits must be a positive integer, got ' + opts.commits);
	for (const key of ['branches', 'tags', 'authors', 'seed'] as const) {
		if (!Number.isInteger(opts[key]) || opts[key] < 0) {
			throw new Error(key + ' must be a non-negative integer, got ' + opts[key]);
		}
	}
	if (typeof opts.mergeRate !== 'number' || opts.mergeRate < 0 || opts.mergeRate > 1) {
		throw new Error('mergeRate must be between 0 and 1');
	}
	return opts;
}

function writeFixtureMarker(repoDir: string, remote: string, opts: FixtureOptions): void {
	const marker = {
		remote,
		commits: opts.commits,
		branches: opts.branches,
		tags: opts.tags,
		mergeRate: opts.mergeRate,
		seed: opts.seed
	};
	fs.writeFileSync(path.join(repoDir, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');
}

/**
 * Generate the fixture the scripted way: fast-import a fresh history into a scratch repo, clone
 * it bare as `<outDir>/fixture-remote.git`, clone a working `<outDir>/fixture` from the bare, and
 * write the `.gg-fixture` marker. If the fixture already exists and force is not set, prints the
 * existing path and returns without rebuilding.
 */
export async function generate(options: { outDir: string } & Partial<FixtureOptions> & { force?: boolean }): Promise<{ skipped: boolean; fixtureDir: string; remoteDir: string }> {
	if (typeof options.outDir !== 'string' || options.outDir === '') {
		throw new Error('generate requires { outDir: string }');
	}
	const opts = validatedOptions(options);
	const force = options.force === true;

	const outDir = path.resolve(options.outDir);
	const fixtureDir = path.join(outDir, 'fixture');
	const remoteDir = path.join(outDir, 'fixture-remote.git');
	if (fs.existsSync(fixtureDir) && !force) {
		return { skipped: true, fixtureDir, remoteDir };
	}

	mkdirAll(outDir);
	const workDir = fs.mkdtempSync(path.join(outDir, '.work-'));
	try {
		await git(['init', workDir]);
		await fastImport(workDir, buildFastImportStream(opts));

		rmRecursive(remoteDir);
		rmRecursive(fixtureDir);
		await git(['clone', '--bare', workDir, remoteDir]);
		rmRecursive(workDir);
		await git(['clone', remoteDir, fixtureDir]);
	} catch (err) {
		rmRecursive(workDir);
		throw err;
	}

	writeFixtureMarker(fixtureDir, remoteDir, opts);
	return { skipped: false, fixtureDir, remoteDir };
}

/** How many commits exist across every ref of `repo` (-1 when git could not answer). */
export async function countRepoCommits(repo: string): Promise<number> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-list', '--count', '--all'], {
			timeout: GIT_TIMEOUT_MS, windowsHide: true
		});
		const parsed = parseInt(stdout.trim(), 10);
		return Number.isNaN(parsed) ? -1 : parsed;
	} catch (_) {
		return -1;
	}
}

/**
 * Generate the fixture history INTO a repository that has no commits at all (the "Run Automation
 * Test" button's empty-repository path). The history is fast-imported into a throwaway bare
 * remote under the OS temp dir — the path recorded in the `.gg-fixture` marker, so the suite
 * runner's reseed can keep rebuilding the repository from it — then fetched into the repository
 * and `main` checked out, leaving exactly the branch layout the scripted generate() produces
 * (local `main`, `feature-NNN` only as `origin/feature-NNN`, `v1.x.x` tags). Refuses — loudly,
 * without touching anything — a repository that has any commit anywhere.
 */
export async function seedEmptyRepo(repo: string, options: Partial<FixtureOptions> = {}): Promise<{ remote: string }> {
	const commitsPresent = await countRepoCommits(repo);
	if (commitsPresent !== 0) {
		throw new Error(repo + ' is not an empty repository (' + (commitsPresent < 0 ? 'not a git repository' : commitsPresent + ' commits found') + ') — the in-place fixture is only generated into a repository with no commits');
	}
	const opts = validatedOptions(options);

	const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-automation-remote-'));
	await git(['init', '--bare', remoteDir]);
	await fastImport(remoteDir, buildFastImportStream(opts));

	// Wire the repository to the fresh remote (keeping the `origin` name the catalog expects) and
	// materialise the history: fetch creates origin/feature-NNN and the tags, the forced checkout
	// of origin/main gives the working tree and the local main branch.
	let originUrl: string;
	try {
		originUrl = (await git(['-C', repo, 'remote', 'get-url', 'origin'])).stdout.trim();
	} catch (_) {
		originUrl = '';
	}
	if (originUrl === '') await git(['-C', repo, 'remote', 'add', 'origin', remoteDir]);
	else await git(['-C', repo, 'remote', 'set-url', 'origin', remoteDir]);
	await git(['-C', repo, 'fetch', 'origin', '--prune', '--tags']);
	await git(['-C', repo, 'checkout', '-f', '-B', 'main', 'origin/main']);

	writeFixtureMarker(repo, remoteDir, opts);
	await seedRepo(repo);
	return { remote: remoteDir };
}

/**
 * Seed a fixture repository with the volatile state the automation catalog expects: three
 * stashes, one untracked file, and a local-ahead branch one commit ahead of origin. Idempotent —
 * the repository is reset to origin/main, stashes are cleared and the seeded state recreated.
 */
export async function seedRepo(repoDir: string): Promise<void> {
	const rng = createRng(987654321);

	await git(['-C', repoDir, 'stash', 'clear']);
	await git(['-C', repoDir, 'checkout', '-f', 'main']);
	await git(['-C', repoDir, 'reset', '--hard', 'origin/main']);
	const branches = await git(['-C', repoDir, 'branch', '--list', 'local-ahead']);
	if (branches.stdout.trim() !== '') {
		await git(['-C', repoDir, 'branch', '-D', 'local-ahead']);
	}
	rmFile(path.join(repoDir, 'untracked-fixture.txt'));

	const listed = await git(['-C', repoDir, 'ls-files']);
	const files = listed.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '');
	if (files.length === 0) throw new Error(repoDir + ' has no tracked files to stash');
	const picks = [files[0], files[Math.floor(files.length / 3)], files[Math.floor((2 * files.length) / 3)]];

	for (let i = 0; i < 3; i++) {
		const file = picks[i];
		fs.appendFileSync(path.join(repoDir, file),
			'\n// fixture-stash-' + (i + 1) + '\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
		await git(['-C', repoDir, 'stash', 'push', '-m', 'fixture-stash-' + (i + 1), '--', file]);
	}

	fs.writeFileSync(path.join(repoDir, 'untracked-fixture.txt'),
		'fixture untracked file\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');

	await git(['-C', repoDir, 'checkout', '-b', 'local-ahead']);
	fs.writeFileSync(path.join(repoDir, 'local-ahead-note.txt'),
		'local-ahead is one commit ahead of origin/main\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
	await git(['-C', repoDir, 'add', 'local-ahead-note.txt']);
	await git(['-C', repoDir, 'commit', '-m', 'local-ahead fixture commit']);
	await git(['-C', repoDir, 'checkout', 'main']);
}

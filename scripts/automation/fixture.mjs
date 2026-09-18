/**
 * Deterministic large-repository generator and seeder for the automation driver
 * (scripts/automation/client.mjs). Builds a git history in memory as a `git fast-import`
 * stream — a main line of N commits on `main`, `feature-NNN` branches cut at deterministic
 * intervals (merged back with probability mergeRate, otherwise left open), and v1.x.x tags
 * — imports it into a bare remote, and clones a working fixture from it. The same seed
 * always produces the same ref names and commit counts (hashes may differ across git
 * versions and are never asserted).
 *
 * Every fixture clone carries a `.gg-fixture` marker JSON ({remote: <bare-url>, ...}); the
 * driver only runs write actions against a clone bearing that marker, and rebuilds the clone
 * from the marker's remote between write-suite iterations.
 *
 *   node scripts/automation/fixture.mjs --out <dir> [--commits 20000] [--branches 30]
 *       [--tags 150] [--merge-rate 0.12] [--authors 40] [--seed 12345] [--force]
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120000;
/* One identity/config for every git call: deterministic content, no global-config dependence. */
const GIT_BASE_ARGS = [
	'-c', 'core.autocrlf=false',
	'-c', 'init.defaultBranch=main',
	'-c', 'user.name=Fixture',
	'-c', 'user.email=fixture@fixture.dev'
];

/** mulberry32: a tiny seeded PRNG, so fixture content is reproducible per seed. */
export function createRng(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pad = (n, width) => String(n).padStart(width, '0');

function git(args, options = {}) {
	return execFileAsync('git', [...GIT_BASE_ARGS, ...args], {
		timeout: GIT_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		...options
	});
}

/** Feed the whole stream to `git fast-import --quiet` in the given working directory. */
function fastImport(cwd, stream) {
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
		child.stdin.write(stream, (err) => {
			if (err !== null && err !== undefined) reject(err);
			else child.stdin.end();
		});
	});
}

/**
 * Build the fast-import stream for the whole fixture. Mark numbering is sequential from 1;
 * blob/commit/tag records carry explicit marks; commits use `author`/`committer` lines with
 * timestamps starting 2020-01-01 and advancing 60-120 s per commit; file changes are inline
 * `M 100644 <path>` blocks fed from marked blobs.
 */
function buildFastImportStream({ commits, branches, tags, mergeRate, authors, seed }) {
	const rng = createRng(seed);
	const chunks = [];
	let mark = 0;
	let timestamp = 1609459200; // 2020-01-01T00:00:00Z
	let seq = 0; // global commit counter, drives the author round-robin
	const modules = Math.min(100, Math.max(10, Math.round(commits / 200)));
	const filesPerModule = 5;

	const data = (content) => 'data ' + Buffer.byteLength(content) + '\n' + content + '\n';

	const emitBlob = (content) => {
		const m = ++mark;
		chunks.push('blob\nmark :' + m + '\n' + data(content));
		return m;
	};

	const identity = (n) => 'Fixture Author ' + pad(n, 2) + ' <author-' + pad(n, 2) + '@fixture>';

	const nextTimestamp = () => {
		const t = timestamp;
		timestamp += 60 + Math.floor(rng() * 61); // 60-120 s per commit
		return t;
	};

	const pickFiles = () => {
		const count = 1 + Math.floor(rng() * 3); // 1-3 files per commit
		const byPath = new Map();
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
		return [...byPath.entries()].map(([filePath, content]) => ({ filePath, content }));
	};

	const emitCommit = (ref, message, parents) => {
		const files = pickFiles();
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

	const emitTag = (name, target) => {
		if (rng() < 0.3) { // ~30% annotated
			chunks.push('tag ' + name + '\nfrom :' + target.mark + '\n'
				+ 'tagger ' + identity(target.authorIndex) + ' ' + target.ts + ' +0000\n'
				+ data('tag ' + name));
		} else { // lightweight, via reset
			chunks.push('reset refs/tags/' + name + '\nfrom :' + target.mark + '\n');
		}
	};

	// Branch cut points spread across the main line (deterministic, deduplicated).
	const cutPoints = new Set();
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

		const parents = [];
		if (mainMark !== 0) parents.push(mainMark);
		if (pendingMergeMark !== 0) parents.push(pendingMergeMark);
		const message = pendingMergeMark !== 0
			? 'Merge branch \'feature-' + pad(pendingBranchNum, 3) + '\''
			: 'commit ' + (i + 1) + ' on main';
		const head = emitCommit('refs/heads/main', message, parents);
		mainMark = head.mark;
		pendingMergeMark = 0;

		if (tagIndex < tags && tagEvery > 0 && i % tagEvery === 0) {
			emitTag('v1.' + tagIndex + '.0', head);
			tagIndex++;
		}
	}

	return chunks.join('');
}

/**
 * Generate the fixture: fast-import a fresh history into a scratch repo, clone it bare as
 * `<outDir>/fixture-remote.git`, clone a working `<outDir>/fixture` from the bare, and write
 * the `.gg-fixture` marker. If the fixture already exists and force is not set, prints the
 * existing path and returns without rebuilding.
 */
export async function generate(options) {
	if (options === undefined || typeof options.outDir !== 'string' || options.outDir === '') {
		throw new Error('generate requires { outDir: string }');
	}
	const opts = { commits: 20000, branches: 30, tags: 150, mergeRate: 0.12, authors: 40, seed: 12345, force: false, ...options };
	if (!Number.isInteger(opts.commits) || opts.commits < 1) throw new Error('commits must be a positive integer, got ' + opts.commits);
	for (const key of ['branches', 'tags', 'authors', 'seed']) {
		if (!Number.isInteger(opts[key]) || opts[key] < 0) {
			throw new Error(key + ' must be a non-negative integer, got ' + opts[key]);
		}
	}
	if (typeof opts.mergeRate !== 'number' || opts.mergeRate < 0 || opts.mergeRate > 1) {
		throw new Error('mergeRate must be between 0 and 1, got ' + opts.mergeRate);
	}

	const outDir = path.resolve(opts.outDir);
	const fixtureDir = path.join(outDir, 'fixture');
	const remoteDir = path.join(outDir, 'fixture-remote.git');
	if (fs.existsSync(fixtureDir) && !opts.force) {
		console.log(fixtureDir);
		return { skipped: true, fixtureDir, remoteDir };
	}

	const log = (msg) => process.stderr.write('[fixture] ' + msg + '\n');
	fs.mkdirSync(outDir, { recursive: true });
	const t0 = Date.now();
	log('building fast-import stream: ' + opts.commits + ' main commits, ' + opts.branches
		+ ' branches, ' + opts.tags + ' tags (seed ' + opts.seed + ')');
	const stream = buildFastImportStream(opts);

	const workDir = fs.mkdtempSync(path.join(outDir, '.work-'));
	try {
		await git(['init', workDir]);
		const tImport = Date.now();
		await fastImport(workDir, stream);
		log('fast-import: ' + opts.commits + ' main commits in ' + ((Date.now() - tImport) / 1000).toFixed(1) + 's');

		fs.rmSync(remoteDir, { recursive: true, force: true });
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		const tBare = Date.now();
		await git(['clone', '--bare', workDir, remoteDir]);
		log('bare remote in ' + ((Date.now() - tBare) / 1000).toFixed(1) + 's');
		fs.rmSync(workDir, { recursive: true, force: true });
		const tClone = Date.now();
		await git(['clone', remoteDir, fixtureDir]);
		log('fixture clone in ' + ((Date.now() - tClone) / 1000).toFixed(1) + 's');
	} catch (err) {
		fs.rmSync(workDir, { recursive: true, force: true });
		throw err;
	}

	const marker = {
		remote: remoteDir,
		commits: opts.commits,
		branches: opts.branches,
		tags: opts.tags,
		mergeRate: opts.mergeRate,
		seed: opts.seed
	};
	fs.writeFileSync(path.join(fixtureDir, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');
	log('done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
	console.log(fixtureDir);
	return { skipped: false, fixtureDir, remoteDir };
}

/**
 * Seed a fixture clone with the volatile state the automation catalog expects: three stashes,
 * one untracked file, and a local-ahead branch one commit ahead of origin. Idempotent — the
 * clone is reset to origin/main, stashes are cleared and the seeded state recreated.
 */
export async function seedRepo(repoDir) {
	const t0 = Date.now();
	const log = (msg) => process.stderr.write('[fixture] ' + msg + '\n');
	const rng = createRng(987654321);

	await git(['-C', repoDir, 'stash', 'clear']);
	await git(['-C', repoDir, 'checkout', '-f', 'main']);
	await git(['-C', repoDir, 'reset', '--hard', 'origin/main']);
	const branches = await git(['-C', repoDir, 'branch', '--list', 'local-ahead']);
	if (branches.stdout.trim() !== '') {
		await git(['-C', repoDir, 'branch', '-D', 'local-ahead']);
	}
	fs.rmSync(path.join(repoDir, 'untracked-fixture.txt'), { force: true });

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

	log('seedRepo: 3 stashes, untracked file, local-ahead in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

const USAGE = `Usage:
  node scripts/automation/fixture.mjs --out <dir> [--commits N] [--branches N] [--tags N]
      [--merge-rate 0.12] [--authors N] [--seed N] [--force]

Builds a deterministic fixture repository: <dir>/fixture-remote.git (bare remote) and
<dir>/fixture (working clone with a .gg-fixture marker). If <dir>/fixture already exists
and --force is not given, the existing path is printed and nothing is rebuilt.`;

function failUsage(message) {
	console.error('error: ' + message);
	console.error(USAGE);
	process.exit(2);
}

function parseArgs(argv) {
	const opts = { outDir: undefined, commits: undefined, branches: undefined, tags: undefined, mergeRate: undefined, authors: undefined, seed: undefined, force: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) failUsage(arg + ' requires a value');
			return argv[++i];
		};
		switch (arg) {
			case '--help': console.log(USAGE); process.exit(0); break;
			case '--out': opts.outDir = next(); break;
			case '--commits': opts.commits = Number(next()); break;
			case '--branches': opts.branches = Number(next()); break;
			case '--tags': opts.tags = Number(next()); break;
			case '--merge-rate': opts.mergeRate = Number(next()); break;
			case '--authors': opts.authors = Number(next()); break;
			case '--seed': opts.seed = Number(next()); break;
			case '--force': opts.force = true; break;
			default: failUsage('unknown argument ' + arg);
		}
	}
	for (const key of ['commits', 'branches', 'tags', 'authors', 'seed']) {
		if (opts[key] !== undefined && (!Number.isInteger(opts[key]) || opts[key] < 0)) failUsage('--' + key + ' must be a non-negative integer');
	}
	if (opts.mergeRate !== undefined && (Number.isNaN(opts.mergeRate) || opts.mergeRate < 0 || opts.mergeRate > 1)) failUsage('--merge-rate must be between 0 and 1');
	if (opts.outDir === undefined) failUsage('--out is required');
	// Drop unset numeric options so the generate() defaults apply.
	return Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined));
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	await generate(opts);
}

const invokedDirectly = (() => {
	try {
		return import.meta.url === pathToFileURL(process.argv[1]).href;
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}

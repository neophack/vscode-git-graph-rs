/**
 * The shared environment of the performance gates: paths, loading the host pipeline the
 * harnesses drive, results IO under test/perf/results/, and the CLI the runner and the gates
 * share. test/perf is intentionally NOT under vitest.config.ts — the gates run with plain
 * `node` so they can spawn real processes, real engines and a real browser.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

export const perfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const root = path.resolve(perfDir, '..', '..');
export const srcDir = path.join(root, 'src');
export const distDir = path.join(root, 'dist');
export const mediaDir = path.join(root, 'media');
export const resultsDir = path.join(perfDir, 'results');

const require = createRequire(import.meta.url);

/**
 * The gates drive the REAL pipeline — the same TypeScript sources `dist/extension.js` bundles —
 * not a re-implementation. The former compiled out/ tree (`npm run build:ts`) is built here
 * on the fly instead: each source file is transpiled once with esbuild and evaluated CJS in
 * memory over a small resolver, so relative imports keep the single module identity the old
 * per-file tsc output had (one exports object per source, shared across entries).
 */
const moduleCache = new Map();

/** The 'vscode' module for the few flat-root modules that import it at runtime (see loadVscodeModule). */
let vscodeStub = null;

/** Resolve a ts-style relative request ('./x', '../x/y', '../types') from a directory to its source file. */
function resolveSource(fromDir, request) {
	const base = path.resolve(fromDir, request);
	for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function loadModule(absFile) {
	const cached = moduleCache.get(absFile);
	if (cached) return cached.exports;
	if (!fs.existsSync(absFile)) {
		throw new Error('The source tree is missing ' + path.relative(root, absFile));
	}
	const { code } = esbuild.transformSync(fs.readFileSync(absFile, 'utf8'), {
		loader: 'ts',
		format: 'cjs',
		sourcefile: absFile,
		// The same emit shape the former `tsc -p src/tsconfig.json` out/ tree had: ES2018
		// syntax and constructor-assignment class fields (useDefineForClassFields is false at
		// that target), so the driven pipeline behaves like the code VS Code runs.
		target: 'es2018',
		tsconfigRaw: { compilerOptions: { target: 'es2018', useDefineForClassFields: false } }
	});
	const moduleObject = { exports: {} };
	// Registered before evaluation, so a cyclic import sees the partial exports like Node does.
	moduleCache.set(absFile, moduleObject);
	const fromDir = path.dirname(absFile);
	const loader = new Function('exports', 'require', 'module', '__filename', '__dirname',
		code + '\n//# sourceURL=' + absFile);
	loader.call(moduleObject.exports, moduleObject.exports, (request) => {
		if (request === 'vscode') {
			if (vscodeStub === null) {
				throw new Error("The perf harness loaded a module that imports 'vscode' without a stub (loadVscodeModule)");
			}
			return vscodeStub;
		}
		if (request.startsWith('./') || request.startsWith('../')) {
			const resolved = resolveSource(fromDir, request);
			if (resolved !== null) return loadModule(resolved);
		}
		return require(request); // node builtins and real packages
	}, moduleObject, absFile, fromDir);
	return moduleObject.exports;
}

/**
 * Require a module of the host pipeline by its former out/ path ('extension/git/read/backendIndex.js').
 * Only the path shape is kept: the module comes from the src/ tree, built on the fly.
 */
export function loadOut(relative) {
	return loadModule(path.join(srcDir, relative.replace(/\.js$/, '.ts')));
}

/**
 * Require a flat-root src/ module that imports 'vscode' at runtime (src/config.ts's
 * configuration defaults, src/extensionState.ts's persisted-state defaults): the stub answers
 * the 'vscode' specifier while the (cached) module graph loads. The stub is only needed on the
 * first load of a module; later calls return the cache.
 */
export function loadVscodeModule(relativeTsPath, stub) {
	vscodeStub = stub;
	try {
		return loadModule(path.join(srcDir, relativeTsPath));
	} finally {
		vscodeStub = null;
	}
}

/** Run `git` in `cwd` and return its trimmed stdout (throws with stderr on failure). */
export function git(cwd, ...args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr.trim());
	return result.stdout.trim();
}

/**
 * Wait until the repository's git lock files are gone before the next write the harness performs
 * (a tag create, a checkout). The CLI backend's spawned reads (`git status` refreshes the index
 * under .git/index.lock) can overlap the harness's own writes on Windows, where process exit and
 * handle release lag; a lock left by a crashed process is removed once the wait budget lapses,
 * so one stale lock cannot kill a whole run.
 */
export async function awaitGitLockClear(repo, budgetMs = 20000) {
	const lock = path.join(repo, '.git', 'index.lock');
	const deadline = Date.now() + budgetMs;
	while (true) {
		if (!fs.existsSync(lock)) {
			// A short grace period: the read that held it may be mid-exit.
			await sleep(60);
			if (!fs.existsSync(lock)) return;
		}
		if (Date.now() >= deadline) {
			fs.rmSync(lock, { force: true });
			return;
		}
		await sleep(100);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The current commit hash (stamped into every recorded baseline and result set). */
export function commitStamp() {
	return git(root, 'rev-parse', 'HEAD');
}

export function ensureResultsDir() {
	fs.mkdirSync(resultsDir, { recursive: true });
}

export function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');
}

export function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The parsed command line shared by run.mjs and the gates: `--flag`, `--option value` and
 * `--option=value` forms, plus positional arguments.
 */
export function parseArguments(argv) {
	const flags = new Set();
	const options = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			positional.push(arg);
		} else if (arg.includes('=')) {
			const equals = arg.indexOf('=');
			options[arg.slice(2, equals)] = arg.slice(equals + 1);
			flags.add(arg.slice(2, equals));
		} else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
			options[arg.slice(2)] = argv[++i];
			flags.add(arg.slice(2));
		} else {
			flags.add(arg.slice(2));
		}
	}
	return { flags, options, positional };
}

/** The fixture tiers of REFACTOR-PLAN §3.8.1 (S is the default; M is flag-gated and slow). */
export const TIERS = {
	s: { commits: 1000, branches: 20, tags: 20, mergeRate: 0.12, authors: 20, seed: 12345, firstPage: 300 },
	m: { commits: 100000, branches: 2000, tags: 10000, mergeRate: 0.12, authors: 40, seed: 12345, firstPage: 300 }
};

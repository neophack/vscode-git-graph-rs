/**
 * The shared environment of the performance gates: paths, loading the compiled out/ tree the
 * harnesses drive, results IO under test/perf/results/, and the CLI the runner and the gates
 * share. test/perf is intentionally NOT under vitest.config.ts — the gates run with plain
 * `node` so they can spawn real processes, real engines and a real browser.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const perfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const root = path.resolve(perfDir, '..', '..');
export const outDir = path.join(root, 'out');
export const distDir = path.join(root, 'dist');
export const mediaDir = path.join(root, 'media');
export const resultsDir = path.join(perfDir, 'results');

const require = createRequire(import.meta.url);

/**
 * Require a module of the compiled out/ tree (built by `npm run build:ts`). The gates drive
 * the real compiled pipeline — the same code `dist/extension.js` bundles — not a re-implementation.
 */
export function loadOut(relative) {
	const file = path.join(outDir, ...relative.split('/'));
	if (!fs.existsSync(file)) {
		throw new Error('The compiled out/ tree is missing ' + path.relative(root, file) + ' — run `npm run build:ts` first.');
	}
	return require(file);
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

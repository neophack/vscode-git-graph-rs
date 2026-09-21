/**
 * CLI wrapper for the fixture generator. The generator itself lives in
 * src/automation/fixture.ts and runs from the compiled out/automation/fixture.js — the same
 * module the in-process automation suite uses — so there is exactly one implementation. Running
 * this script therefore requires `npm run compile` to have produced out/ first.
 *
 *   node scripts/automation/fixture.mjs --out <dir> [--commits 20000] [--branches 30]
 *       [--tags 150] [--merge-rate 0.12] [--authors 40] [--seed 12345] [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const compiled = path.join(rootDir, 'out', 'automation', 'fixture.js');

let implPromise = null;
async function impl() {
	if (implPromise === null) {
		if (!fs.existsSync(compiled)) {
			throw new Error(compiled + ' is missing. Run `npm run compile` first — the generator lives in src/automation/fixture.ts and runs from out/.');
		}
		implPromise = import(pathToFileURL(compiled).href);
	}
	return implPromise;
}

/** Generate the scripted fixture (<outDir>/fixture-remote.git + <outDir>/fixture + marker). */
export async function generate(options) {
	return (await impl()).generate(options);
}

/** Seed a fixture clone with the volatile state the automation catalog expects. */
export async function seedRepo(repoDir) {
	return (await impl()).seedRepo(repoDir);
}

/** Generate the fixture history into an empty repository in place (the button's empty-repo path). */
export async function seedEmptyRepo(repo, options) {
	return (await impl()).seedEmptyRepo(repo, options);
}

const USAGE = `Usage:
  node scripts/automation/fixture.mjs --out <dir> [--commits N] [--branches N] [--tags N]
      [--merge-rate 0.12] [--authors N] [--seed N] [--force]

Builds a deterministic fixture repository: <dir>/fixture-remote.git (bare remote) and
<dir>/fixture (working clone with a .gg-fixture marker). If <dir>/fixture already exists
and --force is not given, the existing path is printed and nothing is rebuilt.

Requires npm run compile first: the generator is the compiled out/automation/fixture.js.`;

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
	const result = await generate(opts);
	console.log(result.fixtureDir);
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

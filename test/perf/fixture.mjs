/**
 * The S/M/L fixture generator (REFACTOR-PLAN task 0.5, OPTIMIZATION-PLAN §7 P2): builds the
 * tiered reference repositories of §3.8.1 for the performance gates, with a deterministic seed
 * per tier so measurements are reproducible without network access.
 *
 *   node test/perf/fixture.mjs --tier s|m|l [--out <dir>] [--force]
 *   node test/perf/fixture.mjs --tier m --commits 50000     # ad-hoc sizes (all knobs overridable)
 *
 * The generated layout per tier directory is exactly what the gates consume (see
 * lib/host-pipeline.mjs's ensureFixturePair): `fixture/` (working clone with the .gg-fixture
 * marker), `fixture-remote.git` (the bare remote) and `fixture-b` (a second clone for the
 * rapid-switch scenario). There is exactly ONE generator implementation — the automation
 * fixture (src/extension/automation/fixture.ts) — loaded here through the same on-the-fly
 * esbuild loader the gates use (lib/env.mjs), so a pre-generated fixture is byte-identical in
 * shape to what `run.mjs` would generate on the fly.
 *
 * Where fixtures live: `--out` defaults to <repo>/test/perf/fixtures/<tier> (gitignored —
 * fixtures are reproducible from the seed, never committed). The gates generate into the OS
 * temp dir by default; point them at a pre-generated tier with `--work-dir` (or `--fixtures-dir`):
 *
 *   node test/perf/fixture.mjs --tier l
 *   node test/perf/run.mjs --gate p2 --tier l --work-dir test/perf/fixtures/l
 *
 * Expected generation cost (fast-import + bare clone + working clone): S seconds, M minutes,
 * L tens of minutes — which is why L is generated ahead of time, and why every generation is
 * idempotent (an existing tier directory is reused unless --force).
 */

import path from 'node:path';
import { perfDir, root, TIERS, parseArguments } from './lib/env.mjs';
import { ensureFixturePair, loadPipeline } from './lib/host-pipeline.mjs';

const USAGE = `Usage:
  node test/perf/fixture.mjs --tier s|m|l [--out <dir>] [--force]
      [--commits N] [--branches N] [--tags N] [--authors N] [--merge-rate R] [--seed N]

Generate the deterministic performance fixture of one tier (REFACTOR-PLAN task 0.5): the
fast-import history plus the second clone the rapid-switch scenario needs. Defaults to
test/perf/fixtures/<tier>; an existing directory is reused unless --force. The seed is fixed
per tier (12345), so the ref layout and commit count are identical on every machine.`;

function failUsage(message) {
	console.error('error: ' + message);
	console.error(USAGE);
	process.exit(2);
}

async function main(argv) {
	const args = parseArguments(argv);
	if (args.flags.has('help') || args.positional.length > 0) {
		console.log(USAGE);
		return 0;
	}
	const tier = args.options.tier;
	if (tier === undefined) failUsage('--tier is required (s, m or l)');
	const tierOptions = TIERS[tier];
	if (tierOptions === undefined) failUsage('--tier must be one of ' + Object.keys(TIERS).join('|'));

	// Explicit knobs override the tier table (ad-hoc sizes); the seed stays the tier's unless
	// --seed says otherwise, so a plain `--tier m` run is always the same repository.
	const overrides = {
		commits: args.options.commits !== undefined ? Number(args.options.commits) : tierOptions.commits,
		branches: args.options.branches !== undefined ? Number(args.options.branches) : tierOptions.branches,
		tags: args.options.tags !== undefined ? Number(args.options.tags) : tierOptions.tags,
		authors: args.options.authors !== undefined ? Number(args.options.authors) : tierOptions.authors,
		mergeRate: args.options['merge-rate'] !== undefined ? Number(args.options['merge-rate']) : tierOptions.mergeRate,
		seed: args.options.seed !== undefined ? Number(args.options.seed) : tierOptions.seed
	};
	const outDir = args.options.out !== undefined
		? path.resolve(args.options.out)
		: path.join(perfDir, 'fixtures', tier);
	const force = args.flags.has('force');

	const modules = loadPipeline();
	console.log('[fixture] tier=' + tier + ' commits=' + overrides.commits + ' branches=' + overrides.branches
		+ ' tags=' + overrides.tags + ' seed=' + overrides.seed);
	console.log('[fixture] out=' + path.relative(root, outDir) + (force ? ' (force)' : ' (existing fixtures reused)'));
	const started = Date.now();
	const pair = await ensureFixturePair(modules, tier, outDir, force, overrides);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	console.log('[fixture] fixture A: ' + pair.repoA);
	console.log('[fixture] fixture B: ' + pair.repoB);
	console.log('[fixture] remote:    ' + pair.remoteDir);
	console.log('[fixture] done in ' + seconds + 's');
	return 0;
}

if (process.argv[1] && process.argv[1].endsWith(path.join('test', 'perf', 'fixture.mjs'))) {
	main(process.argv.slice(2)).then(
		(exit) => process.exit(exit),
		(error) => {
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
			process.exit(1);
		}
	);
}

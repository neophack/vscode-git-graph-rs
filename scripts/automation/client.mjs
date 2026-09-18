/**
 * The automation test driver: connects to the extension's automation server (see
 * src/automation/server.ts) over TCP and runs catalogued actions against a repository,
 * reporting per-run timings and aggregated statistics.
 *
 * Write actions mutate the repository, so they may only run against a fixture clone: a
 * directory carrying a `.gg-fixture` marker JSON whose `remote` points at the bare origin.
 * Around every write-suite iteration the clone is rebuilt from that remote (rm -rf, clone,
 * seed) so each iteration sees identical starting state. Skipped actions never fail the run;
 * a single failure exits 1.
 *
 *   node scripts/automation/client.mjs --port 4711 --repo <path> [--suite all|read|write|<group>|/<regex>/|id-prefix]
 *       [--mode ui|request|both] [--repeat 1] [--timeout 30000] [--out timings.json]
 *       [--traffic-log file] [--json] [--verbose]
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { connect } from './protocol.mjs';
import { seedRepo } from './fixture.mjs';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120000;

const USAGE = `Usage:
  node scripts/automation/client.mjs --port <n> [--repo <path>]
      [--suite all|read|write|<group>|/<regex>/|id-prefix] [--mode ui|request|both]
      [--repeat <n>] [--timeout <ms>] [--out <file>] [--traffic-log <file>] [--json] [--verbose]

Connects to the Git Graph RS automation server, optionally points the Git Graph view at a
fixture repository, and runs catalogued actions, printing SKIP/FAIL lines, a timings table
from gg.stats, and (with --out) a JSON report. Exit code 0 when nothing failed.`;

function failUsage(message) {
	console.error('error: ' + message);
	console.error(USAGE);
	process.exit(2);
}

function parseArgs(argv) {
	const opts = { port: undefined, repo: null, suite: 'all', mode: null, repeat: 1, timeout: 30000, out: null, trafficLog: null, json: false, verbose: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) failUsage(arg + ' requires a value');
			return argv[++i];
		};
		switch (arg) {
			case '--help': console.log(USAGE); process.exit(0); break;
			case '--port': opts.port = Number(next()); break;
			case '--repo': opts.repo = next(); break;
			case '--suite': opts.suite = next(); break;
			case '--mode': opts.mode = next(); break;
			case '--repeat': opts.repeat = Number(next()); break;
			case '--timeout': opts.timeout = Number(next()); break;
			case '--out': opts.out = next(); break;
			case '--traffic-log': opts.trafficLog = next(); break;
			case '--json': opts.json = true; break;
			case '--verbose': opts.verbose = true; break;
			default: failUsage('unknown argument ' + arg);
		}
	}
	if (opts.port === undefined) failUsage('--port is required');
	if (!Number.isInteger(opts.port) || opts.port <= 0) failUsage('--port must be a positive integer');
	if (opts.mode !== null && opts.mode !== 'ui' && opts.mode !== 'request' && opts.mode !== 'both') failUsage('--mode must be ui|request|both');
	if (!Number.isInteger(opts.repeat) || opts.repeat < 1) failUsage('--repeat must be an integer >= 1');
	if (!Number.isFinite(opts.timeout) || opts.timeout < 1) failUsage('--timeout must be a positive number of milliseconds');
	return opts;
}

/** The `.gg-fixture` marker, or null when the directory is not a fixture clone. */
function readFixtureMarker(repo) {
	try {
		const marker = JSON.parse(fs.readFileSync(path.join(repo, '.gg-fixture'), 'utf8'));
		return typeof marker.remote === 'string' ? marker : null;
	} catch {
		return null;
	}
}

/** Wipe the clone and recreate it from the bare remote, then re-seed the volatile state. */
async function rebuildClone(repo, marker) {
	const t0 = Date.now();
	fs.rmSync(repo, { recursive: true, force: true });
	await execFileAsync('git', ['-c', 'core.autocrlf=false', 'clone', marker.remote, repo], {
		timeout: GIT_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
	});
	await seedRepo(repo);
	// The fresh clone carries no marker of its own; restore it so the directory stays a
	// recognised fixture clone for the next driver run.
	fs.writeFileSync(path.join(repo, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');
	process.stderr.write('[client] rebuilt ' + repo + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');
}

/**
 * Resolve the suite selector against the catalog, keeping catalog order. `all` expands to
 * the read suite (immutable actions) followed by the write suite (mutable actions).
 */
function selectSuites(catalog, suite) {
	const byMutable = (mutable) => catalog.filter((a) => a.mutable === mutable);
	if (suite === 'all') {
		return [
			{ name: 'read', actions: byMutable(false) },
			{ name: 'write', actions: byMutable(true) }
		];
	}
	let actions;
	if (suite === 'read' || suite === 'write') {
		actions = byMutable(suite === 'write');
	} else {
		const regex = /^\/(.+)\/$/.exec(suite);
		if (regex !== null) {
			let re;
			try {
				re = new RegExp(regex[1]);
			} catch (err) {
				failUsage('invalid --suite regex: ' + (err instanceof Error ? err.message : String(err)));
			}
			actions = catalog.filter((a) => re.test(a.id));
		} else {
			actions = catalog.filter((a) => a.group === suite || a.id.startsWith(suite));
		}
	}
	if (actions.length === 0) console.error('warning: suite "' + suite + '" matched no actions');
	return [{ name: suite, actions }];
}

/** Which modes to run an action in; the default prefers ui and falls back to request. */
function modesFor(action, modeOpt) {
	if (modeOpt === 'both') return ['ui', 'request'].filter((m) => action[m] !== undefined);
	if (modeOpt === 'ui') return action.ui !== undefined ? ['ui'] : [];
	if (modeOpt === 'request') return action.request !== undefined ? ['request'] : [];
	return [action.ui !== undefined ? 'ui' : 'request'];
}

async function runOne(client, action, mode, opts, failures, counters) {
	let result;
	try {
		result = await client.call('gg.run', { id: action.id, mode, timeoutMs: opts.timeout });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log('FAIL  ' + action.id + '  ' + message);
		failures.push({ id: action.id, mode, error: message });
		counters.failed++;
		return;
	}
	if (result.ok === true) {
		counters.ok++;
		if (opts.verbose) {
			console.log('OK    ' + action.id + '  ' + mode + '  ' + result.timings.totalMs + ' ms');
		} else {
			process.stdout.write('.');
		}
	} else if (result.skipped === true) {
		counters.skipped++;
		console.log('SKIP  ' + action.id + '  ' + (result.reason ?? 'skipped'));
	} else {
		counters.failed++;
		const message = result.error ?? 'failed';
		console.log('FAIL  ' + action.id + '  ' + message);
		failures.push({ id: action.id, mode, error: message });
	}
}

/**
 * Run one suite repeat times. Suites containing mutable actions are rebuilt from the fixture
 * remote at the start of every iteration; without a marker the suite is skipped with a warning.
 */
async function runSuite(client, suite, opts, ctx, failures) {
	const counters = { ok: 0, skipped: 0, failed: 0 };
	const needsRebuild = suite.actions.some((a) => a.mutable);
	if (needsRebuild && ctx.marker === null) {
		console.log('WARNING: no fixture clone available (--repo missing or unmarked); skipping write suite "' + suite.name + '"');
		return counters;
	}
	for (let iteration = 1; iteration <= opts.repeat; iteration++) {
		if (needsRebuild) await rebuildClone(ctx.repo, ctx.marker);
		for (const action of suite.actions) {
			for (const mode of modesFor(action, opts.mode)) {
				await runOne(client, action, mode, opts, failures, counters);
			}
		}
	}
	if (!opts.verbose) process.stdout.write('\n');
	console.log('suite ' + suite.name + ': ' + counters.ok + ' ok, ' + counters.skipped + ' skipped, ' + counters.failed + ' failed');
	return counters;
}

const round1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

function truncate(text, width) {
	return text.length <= width ? text : text.slice(0, width - 1) + '…';
}

/** The aligned `id | mode | runs | failures | min | p50 | p90 | max | lastError` table. */
function formatTable(rows) {
	if (rows.length === 0) return '  (no runs)';
	const header = ['id', 'mode', 'runs', 'failures', 'min', 'p50', 'p90', 'max', 'lastError'];
	const cells = rows.map((r) => [
		r.id, r.mode, String(r.runs), String(r.failures),
		round1(r.minMs), round1(r.p50Ms), round1(r.p90Ms), round1(r.maxMs),
		truncate(r.lastError ?? '', 48)
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
	const line = (columns) => '  ' + columns.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
	const rule = '  ' + widths.map((w) => '-'.repeat(w)).join('  ');
	return [line(header), rule, ...cells.map(line)].join('\n');
}

/** Print the gg.stats table grouped by suite; rows not belonging to any suite go to [other]. */
function printReport(suites, stats) {
	const assigned = new Set();
	for (const suite of suites) {
		const ids = new Set(suite.actions.map((a) => a.id));
		const rows = stats.filter((s) => ids.has(s.id) && !assigned.has(s.id + '|' + s.mode));
		for (const row of rows) assigned.add(row.id + '|' + row.mode);
		console.log('\n[' + suite.name + ']');
		console.log(formatTable(rows));
	}
	const rest = stats.filter((s) => !assigned.has(s.id + '|' + s.mode));
	if (rest.length > 0) {
		console.log('\n[other]');
		console.log(formatTable(rest));
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	let client;
	try {
		// The connect timeout doubles as the default per-call timeout; runs can take --timeout.
		client = await connect({ host: '127.0.0.1', port: opts.port, timeoutMs: opts.timeout + 10000 });
	} catch (err) {
		if (err !== null && typeof err === 'object' && err.code === 'ECONNREFUSED') {
			console.error('No automation server on 127.0.0.1:' + opts.port + ' — is the extension running with git-graph-rs.automationPort set?');
		} else {
			console.error('Could not connect to the automation server: ' + (err instanceof Error ? err.message : String(err)));
		}
		process.exit(1);
	}

	try {
		const ping = await client.call('gg.ping');
		console.log('Connected: ' + ping.extension + ' ' + ping.version + ' (protocol ' + ping.protocol + ')');
		const status = await client.call('gg.status');
		console.log('View: ' + (status.viewLoaded ? 'loaded' : 'not loaded')
			+ (status.currentRepo !== null ? ' — ' + status.currentRepo : ''));

		// Resolve the target repository and refuse to mutate anything but a fixture clone.
		let repo = opts.repo;
		let marker = null;
		if (repo !== null) {
			repo = path.resolve(repo);
			marker = readFixtureMarker(repo);
			if (marker === null) {
				console.error('Refusing to run against ' + repo + ': it is not a fixture clone '
					+ '(no .gg-fixture marker). Write actions mutate the repository.');
				process.exit(1);
			}
			if (status.currentRepo === null || path.resolve(status.currentRepo) !== repo) {
				const opened = await client.call('gg.openView', { repo });
				console.log('Opened repository: ' + opened.repo);
			}
		} else {
			if (status.currentRepo === null) {
				console.error('No --repo given and the Git Graph view has no current repository; nothing to run against.');
				process.exit(1);
			}
			repo = status.currentRepo;
			console.error('warning: --repo not given; using the view\'s current repository (' + repo
				+ '). Write suites that rebuild the clone are skipped.');
		}

		if (opts.trafficLog !== null) {
			client.onNotify('gg.traffic', (params) => {
				if (params === null || typeof params !== 'object') return;
				try {
					fs.appendFileSync(opts.trafficLog, String(params.command) + '\t' + (params.atMs ?? '') + '\n');
				} catch { /* the traffic log must never break a run */ }
			});
		}

		const catalog = (await client.call('gg.catalog')).actions;
		const suites = selectSuites(catalog, opts.suite);
		const failures = [];
		const ctx = { repo, marker };
		for (const suite of suites) {
			await runSuite(client, suite, opts, ctx, failures);
		}

		const stats = await client.call('gg.stats');
		const report = {
			generatedAt: new Date().toISOString(),
			port: opts.port,
			repo,
			suites: suites.map((s) => s.name),
			stats,
			failures
		};
		if (opts.json) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			printReport(suites, stats);
		}
		if (opts.out !== null) {
			fs.writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
			process.stderr.write('wrote ' + opts.out + '\n');
		}
		process.exit(failures.length === 0 ? 0 : 1);
	} finally {
		client.close();
	}
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

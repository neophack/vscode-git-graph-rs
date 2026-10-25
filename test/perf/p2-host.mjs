/**
 * P2 — the host pipeline gate (REFACTOR-PLAN §6.7, row P2): drives the REAL commit-loading
 * pipeline (the compiled CommitLoader over the real GitRepository facade) against the REAL
 * engine backend and, in the second half of every run, in CLI-fallback mode — the two read
 * paths the extension actually ships — over the deterministic fixture repository.
 *
 * Scenarios (each >= 20 samples, median + P95 reported, per backend):
 *   open-hard             the merged open path (loadView) with the commit cache bypassed —
 *                         the full first-page walk + repo info of a first open
 *   open-cached           the same read on a warm cache — the "hot open" the pushed open path
 *                         serves while the panel is already alive
 *   load-more             a loadCommits widening the window 300 -> 400 (the view's Load More)
 *   commit-details        getCommitDetails of the head commit (the details panel's read)
 *   refs-only-refresh     after a real tag create (untimed): the refs-only refresh read
 *                         (getRefs — what a create/delete tag or branch pays to repaint)
 *   head-change-refresh   after a real checkout (untimed): the first-page reload a
 *                         HEAD-changing operation triggers (the watcher clears the cache)
 *   rapid-switch          repo A's open read is fired and immediately superseded by repo B's
 *                         page load — the cancellation path of a fast repository switcher
 *   background-load       the same page load while a real background read (50 commit bodies,
 *                         the view's own follow-up) is in flight — the interference case
 *
 * Run standalone (`node test/perf/p2-host.mjs`) or through run.mjs, which owns the JSON
 * output, the baseline flow and the regression comparison. Timing uses the initial-response
 * latency of each pipeline request (the moment the webview could start painting), with every
 * request drained to quiescence so no sample's follow-ups bleed into the next.
 */

import os from 'node:os';
import path from 'node:path';
import { awaitGitLockClear, commitStamp, ensureResultsDir, git, parseArguments, writeJson } from './lib/env.mjs';
import { measure, summarize, timeMs } from './lib/stats.mjs';
import { composeRepository, createLoader, ensureFixturePair, loadPipeline, runLoaderRequest, viewRequest } from './lib/host-pipeline.mjs';

/** The backend modes every P2 run measures. */
export function defaultBackends() {
	return ['engine', 'cli'];
}

/**
 * Run the whole P2 gate.
 * @param options `{ tier, samples, backends, workDir? }`
 * @returns The result set (also the shape run.mjs records and compares).
 */
export async function runP2(options) {
	const samples = options.samples ?? 21;
	const backends = options.backends ?? defaultBackends();
	const workDir = options.workDir ?? path.join(os.tmpdir(), 'gg-perf-p2-' + options.tier);
	const modules = loadPipeline();
	console.log('[p2] tier=' + options.tier + ' samples=' + samples + ' backends=' + backends.join(',') + '\n[p2] preparing the fixture (fast-import, deterministic)...');
	const { repoA, repoB } = await ensureFixturePair(modules, options.tier, workDir);

	const head = git(repoA, 'rev-parse', 'HEAD');
	const second = git(repoA, 'rev-list', '-n', '1', 'HEAD~1');
	const page = await firstPageHashes(repoA, modules);
	const items = [];

	for (const backendMode of backends) {
		const backend = backendMode === 'engine'
			? modules.createBackend()
			: modules.createBackend({ prefer: 'git-cli' });
		console.log('[p2] backend=' + backendMode + ' (' + modules.describeBackend(backendMode === 'engine' ? {} : { prefer: 'git-cli' }) + ')');
		await backend.openRepository(repoA);
		await backend.openRepository(repoB);
		const facade = composeRepository(modules, backend);
		const loader = createLoader(modules, facade);

		const record = (id, values, extra = {}) => {
			items.push({ gate: 'p2', id: id, backend: backendMode, ...summarize(values, 'ms'), samples: values.map((v) => Math.round(v * 1000) / 1000), ...extra });
			const item = items[items.length - 1];
			console.log('      ' + pad(id, 22) + ' median ' + item.median.toFixed(1).padStart(8) + ' ms   p95 ' + item.p95.toFixed(1).padStart(8) + ' ms   n=' + item.n);
		};

		/* -- The open path, cold and hot -- */
		record('open-hard', await measure({
			samples,
			run: async () => (await runLoaderRequest(loader, viewRequest(repoA, { hard: true }))).initialMs,
			validate: (ms) => assertFinite(ms, 'open-hard')
		}));
		record('open-cached', await measure({
			samples,
			run: async () => (await runLoaderRequest(loader, viewRequest(repoA))).initialMs,
			validate: (ms) => assertFinite(ms, 'open-cached')
		}));

		/* -- Load More: widen the window; the bigger page is a fresh cache key -- */
		record('load-more', await measure({
			samples,
			warmups: 1,
			run: async () => {
				await runLoaderRequest(loader, viewRequest(repoA, { command: 'loadCommits' }));
				loader.repoChangedOnDisk(true); // the watcher event that accompanies a real load-more trigger cycle
				return (await runLoaderRequest(loader, viewRequest(repoA, { command: 'loadCommits', maxCommits: 400 }))).initialMs;
			},
			validate: (ms) => assertFinite(ms, 'load-more')
		}));

		/* -- Commit details (the details panel's read) -- */
		record('commit-details', await measure({
			samples,
			run: () => timeMs(() => facade.read.getCommitDetails(repoA, head)),
			validate: (ms) => assertFinite(ms, 'commit-details')
		}));

		/* -- Refs-only operation: a real tag lands (untimed), then the refresh read -- */
		record('refs-only-refresh', await measure({
			samples,
			run: async () => {
				await awaitGitLockClear(repoA);
				git(repoA, 'tag', 'perf/sample');
				try {
					return await timeMs(() => backend.getRefs(repoA, { showRemoteBranches: true, showRemoteHeads: true, showStashes: true }));
				} finally {
					await awaitGitLockClear(repoA);
					git(repoA, 'tag', '-d', 'perf/sample');
				}
			},
			validate: (ms) => assertFinite(ms, 'refs-only-refresh')
		}));

		/* -- HEAD-changing operation: a real checkout (untimed), then the reload -- */
		let checkoutTo = 'main';
		record('head-change-refresh', await measure({
			samples,
			run: async () => {
				await awaitGitLockClear(repoA);
				checkoutTo = checkoutTo === 'main' ? second : 'main';
				git(repoA, 'checkout', '-q', checkoutTo);
				loader.repoChangedOnDisk(true); // the watcher invalidates the cached pages
				return (await runLoaderRequest(loader, viewRequest(repoA, { command: 'loadCommits' }))).initialMs;
			},
			validate: (ms) => assertFinite(ms, 'head-change-refresh')
		}));

		/* -- Rapid switch: repo A's open read is fired and superseded by repo B's page -- */
		let switchTicket = null;
		record('rapid-switch', await measure({
			samples,
			run: async () => {
				switchTicket = loader.beginLoadView(viewRequest(repoA, { hard: true }));
				const result = await runLoaderRequest(loader, viewRequest(repoB, { command: 'loadCommits', hard: true }));
				const superseded = await switchTicket.promise; // settles NULL once the newer load superseded it
				if (result.initialMs === null) throw new Error('rapid-switch: repo B produced no initial response');
				if (superseded !== null) throw new Error('rapid-switch: the superseded repo A read resolved with a response');
				return result.initialMs;
			},
			validate: (ms) => assertFinite(ms, 'rapid-switch')
		}));

		/* -- Background interference: a real follow-up read in flight during a page load -- */
		record('background-load', await measure({
			samples,
			run: async () => {
				const background = backend.getCommitBodies(repoA, page.slice(0, 50));
				const result = await runLoaderRequest(loader, viewRequest(repoA, { command: 'loadCommits', hard: true }));
				await background;
				return result.initialMs;
			},
			validate: (ms) => assertFinite(ms, 'background-load')
		}));

		loader.dispose();
		backend.closeAllRepositories();
	}

	return {
		gate: 'p2',
		tier: options.tier,
		commit: commitStamp(),
		fixture: { repoA: repoA, repoB: repoB },
		items: items
	};
}

/** The first page's hashes, resolved once so the background-read scenario targets real commits. */
async function firstPageHashes(repo, modules) {
	const backend = modules.createBackend();
	try {
		await backend.openRepository(repo);
		const page = await backend.getCommits(repo, { branches: null, maxCommits: 60, showTags: true, showRemoteBranches: true, showRemoteHeads: true });
		return page.commits.filter((c) => c.hash !== '*').map((c) => c.hash);
	} finally {
		backend.closeAllRepositories();
	}
}

function assertFinite(value, label) {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		throw new Error('p2 scenario ' + label + ' produced no finite sample (the pipeline stopped answering)');
	}
}

function pad(text, width) {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/* Standalone entry: `node test/perf/p2-host.mjs [--samples N] [--tier s|m] [--backend engine,cli]` */
if (process.argv[1] && process.argv[1].endsWith('p2-host.mjs')) {
	const args = parseArguments(process.argv.slice(2));
	const tier = args.options.tier ?? 's';
	const result = await runP2({
		tier: tier,
		samples: Number(args.options.samples ?? 21),
		backends: (args.options.backend ?? 'engine,cli').split(','),
		workDir: args.options.workDir
	});
	ensureResultsDir();
	const file = path.join(import.meta.dirname, 'results', 'p2-' + tier + '.json');
	writeJson(file, result);
	console.log('\n[p2] wrote ' + file);
}

/**
 * The complete automation test, end to end, against a fixture built from scratch: build (or
 * reuse) a real git repository in `--dir` — by default 2000+ commits across 50 branches
 * (fixture.mjs's fast-import generator, which `git init`s and `git clone`s for real, no mocked
 * git) — boot the real compiled extension and webview, and drive the WHOLE catalog through it
 * (every read action, then the write suite, exactly like the "Run Automation Test" button's
 * runAutomationSuite) — no filter, no subset.
 *
 * `--dir` must be empty or missing: this script builds a disposable fixture there and must
 * NEVER touch a real project, especially not one that already has commits. A non-empty
 * directory — an existing project, a repository with history, anything at all — is refused
 * with a reminder instead of being written into (unless it already looks like a fixture this
 * script built, so re-running against the same `--dir` reuses the existing clone, or `--force`
 * is given to build there regardless — use `--force` deliberately, never as a way past the
 * reminder without checking what's actually in the folder).
 *
 * Requires `npm run compile` to have produced `out/` first (bootRealView loads the compiled
 * extension, not the TypeScript sources).
 *
 *   node scripts/automation/full-test.mjs --dir <empty-dir> [--commits 2000] [--branches 50]
 *       [--tags 40] [--authors 20] [--seed 12345] [--timeout 30000] [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate, seedRepo } from './fixture.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = `Usage:
  node scripts/automation/full-test.mjs --dir <empty-dir> [--commits 2000] [--branches 50]
      [--tags 40] [--authors 20] [--seed 12345] [--timeout 30000] [--force]

Builds a real git fixture (2000+ commits, 50 branches by default) in <empty-dir> (git init +
git clone, via fixture.mjs) and runs the whole automation catalog (read suite, then the write
suite) against it through the real compiled extension and webview. <empty-dir> must be empty or
not yet exist — this script never modifies an existing project, especially not one that already
has commits — unless it already holds a fixture this script built (a re-run reuses it) or
--force is passed.`;

function failUsage(message) {
	console.error('error: ' + message);
	console.error(USAGE);
	process.exit(2);
}

/**
 * Refuse to build a fixture inside a directory that might hold something else. `dir` is
 * considered usable when it does not exist yet, is empty, or contains only the two entries
 * fixture.mjs's generate() itself creates there (so re-running against the same --dir works
 * without deleting it first). Anything else — a real project, unrelated files — is reported
 * back to the caller rather than silently building alongside it.
 */
export function checkTargetDir(dir, { force = false } = {}) {
	if (force) return;
	if (!fs.existsSync(dir)) return;
	const entries = fs.readdirSync(dir);
	// 'report.html' is this script's own output (written into --dir at the end of a run), so a
	// directory holding it is still a reusable fixture directory, not a foreign project.
	const known = new Set(['fixture', 'fixture-remote.git', 'report.html']);
	const unexpected = entries.filter((entry) => !known.has(entry));
	if (unexpected.length > 0) {
		throw new Error(
			dir + ' is not empty (unexpected: ' + unexpected.join(', ') + ').\n'
			+ 'This script builds a disposable git fixture from scratch and must never modify an '
			+ 'existing project — especially not one that already has commits. Point --dir at an '
			+ 'empty or non-existent folder, or pass --force only if you are sure it is safe to build '
			+ 'here anyway.'
		);
	}
}

function parseArgs(argv) {
	const opts = { dir: undefined, commits: 2000, branches: 50, tags: 40, authors: 20, seed: 12345, timeout: 30000, force: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) failUsage(arg + ' requires a value');
			return argv[++i];
		};
		switch (arg) {
			case '--help': console.log(USAGE); process.exit(0); break;
			case '--dir': opts.dir = next(); break;
			case '--commits': opts.commits = Number(next()); break;
			case '--branches': opts.branches = Number(next()); break;
			case '--tags': opts.tags = Number(next()); break;
			case '--authors': opts.authors = Number(next()); break;
			case '--seed': opts.seed = Number(next()); break;
			case '--timeout': opts.timeout = Number(next()); break;
			case '--force': opts.force = true; break;
			default: failUsage('unknown argument ' + arg);
		}
	}
	if (opts.dir === undefined || opts.dir === '') failUsage('--dir is required');
	for (const key of ['commits', 'branches', 'tags', 'authors', 'seed', 'timeout']) {
		if (!Number.isInteger(opts[key]) || opts[key] < 0) failUsage('--' + key + ' must be a non-negative integer');
	}
	return opts;
}

function printSummary(report) {
	for (const suite of report.suites) {
		console.log('\n=== ' + suite.name + ' suite (' + suite.runs.length + ' actions) ===');
		for (const run of suite.runs) {
			const status = run.ok ? 'ok  ' : run.skipped ? 'skip' : 'FAIL';
			const detail = run.ok ? (run.totalMs === null ? '' : run.totalMs.toFixed(1) + ' ms')
				: (run.reason ?? run.error ?? '');
			console.log(status + '  ' + run.id + (detail === '' ? '' : '  ' + detail));
		}
	}
	const t = report.totals;
	console.log('\n' + t.passed + ' passed, ' + t.failed + ' failed, ' + t.skipped + ' skipped'
		+ ' (' + t.actions + ' actions, ' + report.durationMs + ' ms, fixture=' + report.fixture
		+ ', writeSuite=' + report.writeSuiteIncluded + ')');
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const dir = path.resolve(opts.dir);
	const fixtureDir = path.join(dir, 'fixture');

	checkTargetDir(dir, { force: opts.force });

	const outJsPath = path.join(rootDir, 'out', 'automation', 'suiteRunner.js');
	if (!fs.existsSync(outJsPath)) {
		console.error('error: ' + outJsPath + ' is missing. Run `npm run compile` first — this script drives the compiled extension, not the TypeScript sources.');
		process.exit(2);
	}

	fs.mkdirSync(dir, { recursive: true });
	await generate({ outDir: dir, commits: opts.commits, branches: opts.branches, tags: opts.tags, authors: opts.authors, seed: opts.seed, force: opts.force });
	await seedRepo(fixtureDir);

	const { bootRealView } = await import(pathToFileURL(path.join(rootDir, 'tests', 'webviewRealPipelineHarness.mjs')).href);
	const boot = await bootRealView(fixtureDir);
	try {
		for (let i = 0; i < 100; i++) {
			if (boot.GitGraphView.currentPanel.automationState().currentRepo) break;
			await boot.sleep(100);
		}
		// Wait for the page to be fully loaded, not just the repository switched to: the initial
		// load's loadConfig response (the authors dropdown) lands after the first commits render,
		// and the suite's first action (author-dropdown) needs an author to pick.
		for (let i = 0; i < 300; i++) {
			if (boot.window.document.querySelector('tr.commit[data-id="0"]') !== null
				&& boot.window.document.querySelectorAll('#authorDropdown .dropdownOption').length > 1) break;
			await boot.sleep(100);
		}
		const report = await boot.automation.suiteRunner.runAutomationSuite({
			logger: { log: (msg) => console.log(msg), logError: (msg) => console.error(msg) },
			actionTimeoutMs: opts.timeout,
			onProgress: (p) => console.log('[' + p.phase + ' ' + p.index + '/' + p.total + '] ' + p.actionId)
		});
		printSummary(report);
		const reportPath = path.join(dir, 'report.html');
		fs.writeFileSync(reportPath, boot.automation.reportView.renderReportHtml(report));
		console.log('\nreport: ' + reportPath);
		process.exitCode = report.totals.failed === 0 ? 0 : 1;
	} finally {
		boot.dispose();
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

/**
 * The E2E launcher (§6.8.1's test/e2e/launcher.ts, tasks 0.6/1.10): build the automation dist,
 * stage an extensionDevelopmentPath whose `main` is the automation bundle, prepare an isolated
 * fixture workspace and per-run profile, apply §6.8.6's environment isolation (fresh
 * user-data/extensions dirs, redirected HOME and global git config, pinned TZ/locale/git
 * dates), resolve the affected tier's tag selection, then hand everything to
 * @vscode/test-electron (which downloads and caches the requested VS Code version into
 * .vscode-test/). The entry's outcome becomes the process exit code.
 *
 *   node test/e2e/out/launcher.js --tier smoke --vscode stable
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { describeTarget, listChangedFiles, selectAffected, AffectedTarget } from './affected';
import { OptionsError, parseOptions, serializeOptions } from './options';
import { E2E_AFFECTED_ENV, E2E_OPTIONS_ENV, E2E_RESULTS_DIR_ENV, E2E_WORKSPACE_ENV, E2eOptions } from './types';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const e2eDir = path.join(repoRoot, 'test', 'e2e');

/** A fixed commit date AFTER the fixture's newest fast-import commit (2020-01-03T12:00:00Z):
 * deterministic seed/write hashes (§6.8.6) while every seeded commit still sorts after the
 * history it grows from (date-order rendering keeps the local-ahead branch at the top). */
const PINNED_GIT_DATE = '@1609684800 +0000';

function log(message: string): void {
	process.stdout.write('[e2e] ' + message + '\n');
}

function fail(message: string): never {
	process.stderr.write('[e2e] ' + message + '\n');
	process.exit(1);
}

/** rm -rf with the Windows read-only handling the fixture's own removals need. The chmod is
 * Windows-only on purpose: on POSIX a 0o666 directory has lost its traverse bit, and the
 * removal below then fails with EACCES on the very directory it was meant to open up (the
 * first CI run of the smoke tier died exactly there, on the green run's profile cleanup). */
function rmTree(target: string): void {
	if (!fs.existsSync(target)) return;
	if (process.platform === 'win32') {
		try {
			fs.chmodSync(target, 0o666);
		} catch { /* not fatal */ }
	}
	fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** A directory junction/symlink to `target` (junctions need no privileges on Windows). */
function linkDir(target: string, link: string): void {
	if (process.platform === 'win32') {
		fs.symlinkSync(target, link, 'junction');
	} else {
		fs.symlinkSync(target, link, 'dir');
	}
}

/** Run one node script under the repo root, inheriting stdio; exits on failure. */
function runNode(script: string, args: string[]): void {
	const result = spawnSync(process.execPath, [path.join(repoRoot, script), ...args], { cwd: repoRoot, stdio: 'inherit' });
	if (result.status !== 0) {
		fail('build step failed: node ' + script + ' ' + args.join(' ') + ' (exit ' + result.status + ')');
	}
}

/** The automation dist build (scripts/automation-packaging.mjs's buildDist(true), inlined here so the launcher stays one process tree). */
function buildAutomationDist(): void {
	log('building the automation dist (scripts/build/build.mjs --production --automation)');
	runNode('scripts/build/build.mjs', ['--production', '--automation']);
	// The vendored webview assets the packaged view loads (media/vendor) — the same chain
	// package-with-automation runs before vsce.
	runNode('scripts/package-highlight.js', []);
}

/** Stage the extension under test: a package.json pointing at the automation bundle + the runtime trees. */
function stageExtension(options: E2eOptions): string {
	const staged = path.join(e2eDir, '.staged-extension');
	rmTree(staged);
	fs.mkdirSync(staged, { recursive: true });
	const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { main?: string };
	pkg.main = './dist/automation/extension.js';
	fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify(pkg, null, '\t') + '\n');
	for (const file of ['package.nls.json', 'package.nls.zh-cn.json', 'LICENSE']) {
		const source = path.join(repoRoot, file);
		if (fs.existsSync(source)) fs.copyFileSync(source, path.join(staged, file));
	}
	for (const dir of ['dist', 'resources', 'media', 'node_modules']) {
		const source = path.join(repoRoot, dir);
		if (fs.existsSync(source)) linkDir(source, path.join(staged, dir));
	}
	// --backend cli stages WITHOUT the engine binaries: the extension then runs everything over
	// the git CLI — exactly S9's "the binaries are gone" state, from the loader's point of view.
	if (options.backend === 'cli') {
		log('--backend cli: the staged extension ships without native/ engine binaries');
	} else if (fs.existsSync(path.join(repoRoot, 'native'))) {
		linkDir(path.join(repoRoot, 'native'), path.join(staged, 'native'));
	}
	return staged;
}

/**
 * A fresh fixture workspace with the run's workspace settings already in place. It lives in the
 * OS temp dir, NOT under the repository: `git rev-parse` from a nested directory finds the
 * repository's own .git up the tree, and the entry's empty-repository check would then refuse
 * (or worse, adopt the repo) — the workspace must be git-context-free until the entry inits it.
 */
function prepareWorkspace(options: E2eOptions): string {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-e2e-workspace-'));
	fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
	const settings: Record<string, unknown> = {
		'git-graph-rs.interfaceLanguage': options.lang,
		'git-graph-rs.enableLog': true,
		'git-graph-rs.repository.commits.initialLoad': 300,
		// The catalog asserts the desktop control bar; a runner's webview pane can sit under
		// the touch breakpoint (the first CI run rendered tablet mode on a 1280px X server and
		// the author dropdown went 0x0 inside the overflow menu). The touch layouts keep their
		// own coverage: the mobileAdaptation unit tests and the theme audit's narrow pages.
		'git-graph-rs.mobileAdaptation': false
	};
	fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify(settings, null, '\t') + '\n');
	return workspace;
}

/** §6.8.6's isolation: everything the launched VS Code and its git children inherit. */
function isolatedEnv(options: E2eOptions, workspace: string, resultsDir: string): Record<string, string> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-e2e-home-'));
	fs.writeFileSync(path.join(home, '.gitconfig'), '');
	const env: Record<string, string> = {
		[E2E_OPTIONS_ENV]: serializeOptions(options),
		[E2E_RESULTS_DIR_ENV]: resultsDir,
		[E2E_WORKSPACE_ENV]: workspace,
		HOME: home,
		GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		TZ: 'UTC',
		LANG: 'en_US.UTF-8',
		LC_ALL: 'en_US.UTF-8',
		GIT_AUTHOR_DATE: PINNED_GIT_DATE,
		GIT_COMMITTER_DATE: PINNED_GIT_DATE
	};
	if (options.backend === 'nogit') {
		// The one PATH entry is an empty dir: `git` resolves to nothing inside the editor, which
		// is the nogit environment's whole point (read-only engine paths only).
		const emptyBin = path.join(e2eDir, '.nogit-bin');
		fs.mkdirSync(emptyBin, { recursive: true });
		env.PATH = emptyBin;
	}
	return env;
}

/** The affected tier's selection, computed at launch (git lives here, not in the entry). */
function resolveAffected(options: E2eOptions): { target: AffectedTarget; note: string } {
	const changed = listChangedFiles(options.base, repoRoot);
	if (changed === null) {
		return { target: { full: true }, note: 'could not diff against ' + options.base + ' — falling back to the full tier' };
	}
	const target = selectAffected(changed);
	return { target, note: changed.length + ' changed files vs merge-base(' + options.base + ') -> ' + describeTarget(target) };
}

async function main(): Promise<void> {
	let options: E2eOptions;
	try {
		options = parseOptions(process.argv.slice(2));
	} catch (error) {
		if (error instanceof OptionsError) fail(error.message);
		throw error;
	}
	if (process.env.E2E_SKIP_BUILD !== '1') {
		buildAutomationDist();
	} else {
		log('E2E_SKIP_BUILD=1 — reusing the existing dist build');
	}
	const staged = stageExtension(options);
	const workspace = prepareWorkspace(options);

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const resultsDir = path.join(e2eDir, 'results', stamp + '-' + options.tier + (options.backend !== 'engine' ? '-' + options.backend : ''));
	fs.mkdirSync(resultsDir, { recursive: true });

	const env = isolatedEnv(options, workspace, resultsDir);
	if (options.tier === 'affected') {
		const affected = resolveAffected(options);
		log('affected selection: ' + affected.note);
		env[E2E_AFFECTED_ENV] = 'full' in affected.target ? JSON.stringify({ full: true }) : JSON.stringify({ tags: affected.target.tags });
	}

	const profileDir = path.join(e2eDir, '.profile-' + stamp);
	fs.mkdirSync(profileDir, { recursive: true });
	log('tier=' + options.tier + ' vscode=' + options.vscodeVersion + ' backend=' + options.backend
		+ ' lang=' + options.lang + ' -> results ' + path.relative(repoRoot, resultsDir));

	// The perf trace log (P4) rides on `git-graph-rs.enableLog`. The workspace-scope copy alone
	// proved fragile on this launch path: the extension activates while the window is still
	// settling (the view command triggers it), a startup configuration event then re-reads the
	// setting while the workspace's own settings are transiently out of view, and the session's
	// logging is switched off for good — the run's session log then holds only the four
	// activation lines and no Trace lines at all. The USER-scope copy in the isolated profile
	// is visible in every configuration view, so the listener's re-read keeps logging on.
	const userSettingsDir = path.join(profileDir, 'user-data', 'User');
	fs.mkdirSync(userSettingsDir, { recursive: true });
	fs.writeFileSync(path.join(userSettingsDir, 'settings.json'), JSON.stringify({ 'git-graph-rs.enableLog': true }, null, '\t') + '\n');

	let exitCode: number;
	try {
		exitCode = await runTests({
			version: options.vscodeVersion,
			extensionDevelopmentPath: staged,
			extensionTestsPath: path.join(e2eDir, 'out', 'entry.js'),
			launchArgs: [
				workspace,
				'--disable-extensions',
				'--window-size=1500,900',
				'--user-data-dir=' + path.join(profileDir, 'user-data'),
				'--extensions-dir=' + path.join(profileDir, 'extensions')
			],
			extensionTestsEnv: env
		});
	} catch (error) {
		// A failing test run rejects here (the entry threw); the collection and the summary must
		// still run — a red run is exactly the one whose traces and reports matter.
		exitCode = 1;
		process.stderr.write('[e2e] ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)) + '\n');
	}

	collectTraces(resultsDir, profileDir);
	printSummary(resultsDir);
	if (exitCode === 0) {
		rmTree(profileDir); // green: nothing to keep
	} else {
		log('failing run: the isolated profile is kept at ' + profileDir + ' (VS Code logs of this run)');
	}
	if (options.keepOpen && exitCode !== 0) {
		log('--keep-open was set and the run failed; the editor window stays open until closed manually (the exit code below is the close\'s, not the run\'s)');
	}
	process.exitCode = exitCode;
}

/**
 * The P4 collection (OPTIMIZATION-PLAN §7 P2): hand the run's session log to the trace
 * collector, which parses the `Trace` lines the extension logged while enableLog was on,
 * attributes them to the scenario windows the entry recorded (perf-windows.json), and emits
 * per-scenario trace summaries into the results dir and the perf results history. Best effort:
 * the collector's exit code is deliberately ignored — a missing log or a parse hiccup must
 * never fail an E2E run. Runs BEFORE the green-run profile cleanup, while the log still exists.
 */
function collectTraces(resultsDir: string, profileDir: string): void {
	const result = spawnSync(process.execPath, [
		path.join(repoRoot, 'test', 'perf', 'collect-e2e-traces.mjs'),
		'--windows', path.join(resultsDir, 'perf-windows.json'),
		'--out', resultsDir,
		'--perf-out', path.join(repoRoot, 'test', 'perf', 'results'),
		'--profile', profileDir
	], { cwd: repoRoot, stdio: 'inherit' });
	if (result.status !== 0) {
		log('trace collection did not run cleanly (exit ' + result.status + ') — the E2E result is unaffected');
	}
}

/** Print the entry's summary (the ext host's console is not this terminal's stdout). */
function printSummary(resultsDir: string): void {
	const summary = path.join(resultsDir, 'summary.txt');
	if (!fs.existsSync(summary)) return;
	process.stdout.write('\n' + fs.readFileSync(summary, 'utf8'));
	const report = path.join(resultsDir, 'report.json');
	if (fs.existsSync(report)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(report, 'utf8')) as { totals: { failed: number } };
			if (parsed.totals.failed > 0) process.exitCode = 1;
		} catch { /* the summary already told the story */ }
	}
}

void main().catch((error) => {
	fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});

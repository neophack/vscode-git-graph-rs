/**
 * The one cross-platform developer install script — replaces the four former root wrappers
 * (`build-and-install.bat`, `build-and-install.sh`, `build-rust.bat`, `build-vsix-and-install.bat`),
 * reproducing the union of what they did:
 *
 *   - find the VS Code CLI (`code`, then `code-insiders`; on macOS the standard app-bundle
 *     locations as a fallback), warn and build without installing when it is absent
 *   - check prerequisites (cargo / Rust is required whenever the native addon is built)
 *   - `npm install` when `node_modules` is missing
 *   - build the native addon (release) for the host platform — or, with `--full` / `--only`,
 *     build the multi-target engine set like `build-rust.bat` did and exit
 *   - compile the extension and the webview (`npm run compile`)
 *   - run the test suite (`npm test`), unless `--skip-tests`
 *   - clear stale root `*.vsix` files, then package: the universal VSIX (`npm run package`),
 *     the automation-enabled one (`--automation`), or one carrying only this machine's engine
 *     (`--this-platform`, the old `build-vsix-and-install.bat win` mode)
 *   - install the newest VSIX via `code --install-extension <vsix> --force`
 *     (skipped with `--no-install` or when no CLI was found)
 *   - in the default mode, also package the per-platform VSIXs for every engine currently
 *     built (`scripts/package-platforms.mjs`), warning only on failure — unless
 *     `--no-platform-packages`
 *
 * Usage:
 *
 *   node scripts/dev/install.mjs                 full chain: build, test, package, install
 *   node scripts/dev/install.mjs --skip-native   reuse native/, like build-vsix-and-install.bat
 *   node scripts/dev/install.mjs --skip-tests    skip `npm test`
 *   node scripts/dev/install.mjs --no-install    package the VSIX but do not install it
 *   node scripts/dev/install.mjs --automation    package the automation-enabled VSIX
 *   node scripts/dev/install.mjs --this-platform package only this machine's engine
 *   node scripts/dev/install.mjs --full          build ALL six native targets, then exit
 *   node scripts/dev/install.mjs --only <triple> build ONE native target, then exit
 *   node scripts/dev/install.mjs --debug         debug native build instead of release
 *   node scripts/dev/install.mjs --dry-run       print the steps without running anything
 *
 * (An `npm run dev:install` alias for this script is planned; until then invoke it with Node.)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------------ flag parsing ------------------------------ */

const usage = [
	'Usage: node scripts/dev/install.mjs [flags]',
	'  --dry-run               print the steps instead of running them',
	'  --skip-native           skip the native addon build (native/ is already built)',
	'  --skip-tests            skip `npm test`',
	'  --no-install            package the VSIX but do not install it into VS Code',
	'  --no-platform-packages  skip the trailing per-platform VSIX packaging sweep',
	'  --automation            package the automation-enabled VSIX (npm run package:automation)',
	'  --this-platform         package only this machine\'s engine (per-platform VSIX)',
	'  --full                  build ALL six native targets, then exit',
	'  --only <triple>         build ONE native target, then exit',
	'  --debug                 debug native build instead of release'
].join('\n');

const flags = { dryRun: false, skipNative: false, skipTests: false, noInstall: false, noPlatformPackages: false, automation: false, thisPlatform: false, full: false, only: null, debug: false };
{
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dry-run') flags.dryRun = true;
		else if (arg === '--skip-native') flags.skipNative = true;
		else if (arg === '--skip-tests') flags.skipTests = true;
		else if (arg === '--no-install') flags.noInstall = true;
		else if (arg === '--no-platform-packages') flags.noPlatformPackages = true;
		else if (arg === '--automation') flags.automation = true;
		else if (arg === '--this-platform') flags.thisPlatform = true;
		else if (arg === '--full') flags.full = true;
		else if (arg === '--only') {
			flags.only = argv[++i];
			if (!flags.only) {
				console.error(`--only needs a target triple (e.g. --only aarch64-unknown-linux-gnu)\n\n${usage}`);
				process.exit(1);
			}
		}
		else if (arg === '--debug') flags.debug = true;
		else if (arg === '--help' || arg === '-h') {
			console.log(usage);
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${arg}\n\n${usage}`);
			process.exit(1);
		}
	}
}

/* --------------------------- process-running helpers --------------------------- */

// `npm` and the VS Code CLI are `.cmd` shims on Windows: they only spawn through a shell.
const IS_WINDOWS = process.platform === 'win32';

const childEnv = { ...process.env };
// rustup's canonical location, for shells whose PATH does not carry it (from the old .sh).
if (!commandExists('cargo') && fs.existsSync(path.join(os.homedir(), '.cargo', 'bin'))) {
	childEnv.PATH = path.join(os.homedir(), '.cargo', 'bin') + path.delimiter + (childEnv.PATH || '');
}

function commandExists(cmd) {
	const probe = IS_WINDOWS
		? spawnSync('where', [cmd], { stdio: 'ignore', env: childEnv })
		: spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore', env: childEnv });
	return probe.status === 0;
}

function run(cmd, args, opts = {}) {
	// `npm` and the VS Code CLI are `.cmd` shims on Windows, which only spawn through a shell;
	// on POSIX everything is spawned directly (also correct for app-bundle paths with spaces).
	const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd || root, env: childEnv, shell: IS_WINDOWS });
	if (result.error) {
		console.error(`  failed to launch ${cmd}: ${result.error.message}`);
		return false;
	}
	return (result.status ?? 1) === 0;
}

/**
 * One numbered step. In --dry-run mode the description is printed and `true` returned without
 * launching anything; side-effectful filesystem steps (deleting stale VSIXs) are skipped too.
 */
let stepIndex = 0;
function step(label, action) {
	stepIndex++;
	console.log(`\n[${stepIndex}] ${label}`);
	if (flags.dryRun) {
		console.log('  (dry-run: skipped)');
		return true;
	}
	return action();
}

function fail(message) {
	console.error(`\n${message || 'BUILD FAILED'} - see the output above.`);
	process.exit(1);
}

/* ------------------------------ VS Code CLI lookup ------------------------------ */

// The CLI is not on the PATH by default on macOS (it takes the "Shell Command: Install 'code'
// command in PATH" command to put it there), so the standard app-bundle locations are checked
// as a fallback — the same list the old build-and-install.sh used.
function findVsCodeCli() {
	for (const cmd of ['code', 'code-insiders']) {
		if (commandExists(cmd)) return { cmd, viaPath: true };
	}
	if (process.platform === 'darwin') {
		const home = os.homedir();
		for (const candidate of [
			'/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
			`${home}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
			'/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
			`${home}/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders`
		]) {
			if (fs.existsSync(candidate)) return { cmd: candidate, viaPath: false };
		}
	}
	return null;
}

/* ------------------------------ platform helpers ------------------------------ */

// process.platform/process.arch -> the native/<platform> directory this machine's engine lives in
// (the mapping scripts/package-platforms.mjs packages). Null where no engine is shipped.
function hostPlatformDir() {
	if (process.platform === 'win32') return process.arch === 'arm64' ? 'win32-arm64-msvc' : 'win32-x64-msvc';
	if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64-gnu' : 'linux-x64-gnu';
	if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
	return null;
}

// The four common targets every build-rust run produced; --full adds the two niche ones
// (Windows arm64, macOS x64), whose absence costs speed, not function (the git CLI backend).
const COMMON_TARGETS = [
	['x86_64-pc-windows-msvc', false],
	['x86_64-unknown-linux-gnu', true],
	['aarch64-unknown-linux-gnu', true],
	['aarch64-apple-darwin', true]
];
const FULL_TARGETS = [...COMMON_TARGETS, ['aarch64-pc-windows-msvc', true], ['x86_64-apple-darwin', true]];

function newestVsix(pattern = '*.vsix') {
	const glob = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	const re = new RegExp(`^${glob}$`);
	let newest = null;
	for (const entry of fs.existsSync(root) ? fs.readdirSync(root) : []) {
		if (!re.test(entry)) continue;
		const mtime = fs.statSync(path.join(root, entry)).mtimeMs;
		if (!newest || mtime > newest.mtime) newest = { file: entry, mtime };
	}
	return newest ? newest.file : null;
}

function deleteStaleVsixs(pattern = '*.vsix') {
	const glob = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	const re = new RegExp(`^${glob}$`);
	for (const entry of fs.readdirSync(root)) {
		if (re.test(entry)) fs.rmSync(path.join(root, entry));
	}
}

/* --------------------------------- the chain --------------------------------- */

const vsCodeCli = findVsCodeCli();
console.log(`scripts/dev/install.mjs - full-chain developer install${flags.dryRun ? ' (dry run)' : ''}`);
if (flags.dryRun) {
	console.log(`  VS Code CLI: ${vsCodeCli ? vsCodeCli.cmd : 'not found (the VSIX will be built but not installed)'}`);
	console.log(`  host platform directory: ${hostPlatformDir() || 'none (no engine shipped for this platform)'}`);
}

/* ---- build-rust.bat mode: multi-target native build, then stop ---- */
if (flags.full || flags.only) {
	step('Checking prerequisites (node, cargo)...', () => {
		if (!commandExists('cargo')) {
			console.error('  cargo / Rust is required');
			return false;
		}
		return true;
	});
	if (!fs.existsSync(path.join(root, 'node_modules'))) {
		step('Installing npm dependencies (npm install)...', () => run('npm', ['install']));
	}
	step('Checking cross toolchains (zig for the Linux/macOS targets)...', () => {
		const zigViaPip = spawnSync(IS_WINDOWS ? 'python' : 'python3', ['-m', 'ziglang', 'version'], { stdio: 'ignore', env: childEnv }).status === 0;
		if (zigViaPip || commandExists('zig')) {
			console.log(`  zig found ${zigViaPip ? 'via the ziglang package' : 'on PATH'}.`);
		} else {
			console.log('  WARNING: zig not found - the Linux and macOS targets will fail.');
			console.log('  Install it with: pip install ziglang');
		}
		return true;
	});
	// scripts/build-addon.mjs adds --cross-compile itself whenever the target's OS family differs
	// from the host's, so a single --only target needs no cross flag here.
	const targets = flags.only ? [[flags.only, false]] : (flags.full ? FULL_TARGETS : COMMON_TARGETS);
	let built = 0;
	let failed = 0;
	const skipped = FULL_TARGETS.map(([t]) => t).filter((t) => !targets.some(([tt]) => tt === t));
	for (const [triple, cross] of targets) {
		const ok = step(`Building ${triple}${cross ? ' (cross)' : ''} (scripts/build-addon.mjs)...`, () => {
			const args = flags.debug ? [] : ['--release'];
			args.push('--target', triple);
			if (cross) args.push('--cross-compile');
			return run(process.execPath, ['scripts/build-addon.mjs', ...args]);
		});
		if (ok) built++;
		else {
			failed++;
			console.log(`  FAILED: ${triple} (the other targets continue)`);
		}
	}
	if (skipped.length > 0) {
		console.log(`\nSkipped: ${skipped.join(', ')} ${flags.only ? '(not selected by --only)' : '(--full builds them)'}`);
	}
	if (failed > 0) fail(`BUILD FINISHED WITH FAILURES: ${built} built, ${failed} failed.`);
	if (flags.dryRun) console.log(`\nDRY RUN OK: ${built} target(s) would be built into native/.`);
	else {
		console.log(`\nBUILD OK: ${built} target(s) built into native/.`);
		console.log('The binaries are ready to be packaged (node scripts/dev/install.mjs).');
	}
	process.exit(0);
}

/* ---- the full chain: deps -> native -> compile -> test -> package -> install ---- */

step('Checking prerequisites...', () => {
	if (!flags.skipNative && !commandExists('cargo')) {
		console.error('  cargo / Rust is required (or pass --skip-native to reuse the built engine)');
		return false;
	}
	if (!vsCodeCli && !flags.noInstall) {
		console.log("  WARNING: neither 'code' nor 'code-insiders' found on PATH,");
		console.log('  the vsix will be built but not installed.');
	}
	return true;
});

if (!fs.existsSync(path.join(root, 'node_modules'))) {
	step('Installing npm dependencies (npm install)...', () => run('npm', ['install']));
} else {
	console.log('\nnpm dependencies present, skipping. (delete node_modules to force a reinstall)');
}

if (!flags.skipNative) {
	step(`Building the native addon (${flags.debug ? 'debug' : 'release'}, host platform)...`, () =>
		run('npm', ['run', 'build:native', '--', ...(flags.debug ? [] : ['--release'])]));
} else {
	console.log('\nSkipping the native addon build (--skip-native).');
}

step('Compiling the extension and the webview (npm run compile)...', () => run('npm', ['run', 'compile']));

if (!flags.skipTests) {
	step('Running the test suite (npm test)...', () => run('npm', ['test']));
} else {
	console.log('\nSkipping the test suite (--skip-tests).');
}

const platformDir = hostPlatformDir();
if (flags.thisPlatform && !flags.dryRun && platformDir && !fs.existsSync(path.join(root, 'native', platformDir, 'git-graph.node'))) {
	console.error(`\nnative/${platformDir}/git-graph.node is missing.`);
	console.error('Build the engine first (node scripts/dev/install.mjs, or --only <triple> for cross targets).');
	process.exit(1);
}

if (flags.automation) {
	step('Packaging the automation vsix: clearing stale root *.vsix, then npm run package:automation...', () => {
		deleteStaleVsixs();
		return run('npm', ['run', 'package:automation']);
	});
} else if (flags.thisPlatform) {
	step(`Packaging the ${platformDir} vsix (scripts/package-platforms.mjs ${platformDir})...`, () => {
		// Only this platform's stale vsix files are cleared - artifacts of the universal and
		// other-platform packaging runs are left alone.
		deleteStaleVsixs(`git-graph-rs-*-${platformDir}.vsix`);
		return run(process.execPath, ['scripts/package-platforms.mjs', platformDir]);
	});
} else {
	step('Packaging the universal vsix: clearing stale root *.vsix, then npm run package...', () => {
		deleteStaleVsixs();
		return run('npm', ['run', 'package']);
	});
}

let vsix = null;
step('Locating the produced vsix...', () => {
	vsix = flags.thisPlatform && platformDir ? newestVsix(`git-graph-rs-*-${platformDir}.vsix`) : newestVsix();
	if (!vsix) {
		console.error('  no vsix was produced');
		return false;
	}
	console.log(`  packaged: ${vsix}`);
	return true;
});

if (!flags.noInstall && vsCodeCli) {
	step(`Installing into VS Code (${vsCodeCli.cmd} --install-extension)...`, () =>
		run(vsCodeCli.cmd, ['--install-extension', vsix, '--force']));
	console.log('\nDone. Reload the VS Code window to activate the new version.');
} else {
	console.log(`\nDone. Install manually with:\n  code --install-extension ${vsix || '<the packaged vsix>'}`);
}

// The local install above already used the packaged vsix - a per-platform packaging failure here
// (e.g. no native/*/git-graph.node built yet) does not undo it, so this only warns. Skipped for
// the --this-platform mode (which packages exactly the one per-platform vsix) and --automation
// (whose VSIX intentionally carries the automation harness instead).
if (!flags.noPlatformPackages && !flags.thisPlatform && !flags.automation) {
	step('Packaging per-platform vsix files (only the engines currently built)...', () => {
		const ok = run(process.execPath, ['scripts/package-platforms.mjs']);
		if (!ok) console.log('  WARNING: per-platform packaging failed - the installed universal vsix above is unaffected.');
		return true;
	});
}

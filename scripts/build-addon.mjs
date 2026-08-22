/**
 * Build the native addon and put it where the extension looks for it.
 *
 * There is deliberately no node-gyp, no Python, and no download of Node headers. napi-rs resolves
 * the Node-API symbols at load time rather than linking against them, so building the addon needs
 * nothing but a Rust toolchain. The crate is pure Rust (gix has no C dependencies), so every
 * cross-compilation problem reduces to finding a linker for the target.
 *
 *   node scripts/build-addon.mjs                       # debug, for the host platform
 *   node scripts/build-addon.mjs --release             # what ships
 *   node scripts/build-addon.mjs --target <triple>     # cross-compile
 *   node scripts/build-addon.mjs --all [--release]     # every target, all six if possible
 *
 * How each target is built:
 *
 *   - the host target                       → plain cargo
 *   - another target of the host OS family  → plain cargo (needs the OS's own cross linker, e.g.
 *                                              gcc-aarch64-linux-gnu on an x64 Linux host)
 *   - aarch64-pc-windows-msvc from x64 win  → MSVC ARM64 link tools, or rust-lld + a copy-splatted
 *                                              Windows SDK/CRT (xwin CLI), or cargo-xwin
 *   - linux-gnu / darwin targets cross-built → cargo-zigbuild (zig provides the cross linkers,
 *                                              glibc, and the macOS libc stubs)
 *
 * Targets with no available linker are skipped with a warning rather than failing the run; the
 * exit code still reflects them. The same six targets are built by
 * `.github/workflows/native-build.yml` on native runners.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Rust target triple -> the directory the extension loads that binary from. */
const TARGET_DIRECTORIES = {
	'x86_64-pc-windows-msvc': 'win32-x64-msvc',
	'aarch64-pc-windows-msvc': 'win32-arm64-msvc',
	'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
	'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
	'x86_64-apple-darwin': 'darwin-x64',
	'aarch64-apple-darwin': 'darwin-arm64'
};

/** The targets `--all` builds: all six, on any host — whatever cannot be linked is skipped. */
const ALL_TARGETS = Object.keys(TARGET_DIRECTORIES);

const WINDOWS_SDK_SPLAT = path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'cargo-xwin', 'xwin', 'splat-copy');
const XWIN_CACHE = path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'cargo-xwin', 'xwin');
const ZIG_HOME = path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'zig');

function parseArguments(argv) {
	const options = { release: false, target: null, all: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--release') options.release = true;
		else if (argv[i] === '--all') options.all = true;
		else if (argv[i] === '--target') options.target = argv[++i];
		else if (argv[i].startsWith('--target=')) options.target = argv[i].slice('--target='.length);
		else throw new Error(`Unknown argument: ${argv[i]}`);
	}
	if (options.all && options.target !== null) {
		throw new Error('--all and --target are mutually exclusive');
	}
	return options;
}

/** The target triple cargo will build for when none was asked for. */
function hostTarget() {
	const output = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
	if (output.status !== 0) {
		throw new Error('Could not run `rustc`. Is a Rust toolchain installed and on the PATH?');
	}
	const match = /^host:\s*(.+)$/m.exec(output.stdout);
	if (match === null) throw new Error('Could not determine the host target from `rustc -vV`');
	return match[1].trim();
}

/** The OS family of a target triple ('windows' | 'linux' | 'darwin'), or null. */
function osFamilyOf(target) {
	if (target.includes('windows')) return 'windows';
	if (target.includes('linux')) return 'linux';
	if (target.includes('apple')) return 'darwin';
	return null;
}

/** The file name cargo produces for a cdylib on the given target. */
function artifactName(target) {
	if (target.includes('windows')) return 'git_graph_node.dll';
	if (target.includes('apple')) return 'libgit_graph_node.dylib';
	return 'libgit_graph_node.so';
}

/** Does a command exist and run? (Used to detect optional cross-compilation helpers.) */
function commandExists(command, args) {
	return spawnSync(command, args, { encoding: 'utf8', stdio: 'ignore' }).status === 0;
}

/** Is the MSVC linker for ARM64 installed (Visual Studio "C++ ARM64 build tools")? */
function msvcArm64LinkerInstalled() {
	const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
	if (!fs.existsSync(vswhere)) return false;
	const found = spawnSync(vswhere, ['-products', '*', '-find', 'VC/Tools/MSVC/*/bin/Hostx64/arm64/link.exe'], { encoding: 'utf8' });
	return found.status === 0 && found.stdout.trim() !== '';
}

/** Where rust-lld lives in the current toolchain, or null. */
function rustLldDirectory() {
	const output = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
	if (output.status !== 0) return null;
	const dir = path.join(output.stdout.trim(), 'lib', 'rustlib', hostTarget(), 'bin');
	return fs.existsSync(path.join(dir, 'rust-lld.exe')) || fs.existsSync(path.join(dir, 'rust-lld'))
		? dir
		: null;
}

/** Is a copy of the Windows SDK / CRT splatted for rust-lld (see ensureWindowsSdkSplat)? */
function sdkSplatReady() {
	return fs.existsSync(path.join(WINDOWS_SDK_SPLAT, 'crt', 'lib', 'arm64')) &&
		fs.existsSync(path.join(WINDOWS_SDK_SPLAT, 'sdk', 'lib', 'um', 'arm64'));
}

/**
 * Splat the Windows SDK / CRT with the xwin CLI, in copy mode. cargo-xwin splats with symlinks,
 * which needs the Windows symlink privilege (Developer Mode or admin); xwin's copy mode needs
 * nothing. The downloads already fetched by cargo-xwin are reused via the shared cache.
 */
function ensureWindowsSdkSplat() {
	if (sdkSplatReady()) return true;
	if (!commandExists('xwin', ['--help'])) {
		console.warn('! splatting the Windows SDK needs the xwin CLI (`cargo install xwin --locked`)');
		return false;
	}
	const args = ['--accept-license', 'splat', '--arch', 'x86_64,aarch64', '--output', WINDOWS_SDK_SPLAT, '--cache-dir', XWIN_CACHE];
	console.log(`> xwin ${args.join(' ')}`);
	const splat = spawnSync('xwin', args, { cwd: root, stdio: 'inherit' });
	if (splat.status !== 0 || !sdkSplatReady()) {
		console.error('! xwin splat did not produce the expected layout');
		return false;
	}
	return true;
}

/** PATH with the optional helpers (rust-lld, zig) prepended, for build subprocesses. */
function buildPath() {
	const extra = [rustLldDirectory(), fs.existsSync(path.join(ZIG_HOME, 'zig.exe')) ? ZIG_HOME : null];
	return extra.filter((dir) => dir !== null).concat(process.env.PATH || '').join(path.delimiter);
}

/**
 * How to build a target: a cargo subcommand chain ('build' | ['zigbuild', 'build'] |
 * ['xwin', 'build']), the environment it needs, or nothing (skip, with the reason).
 */
function buildCommandFor(target, host) {
	if (osFamilyOf(target) === osFamilyOf(host)) {
		// Same OS family: cargo + the platform's own linker (for cross-arch, the OS cross-linker
		// must be installed, e.g. gcc-aarch64-linux-gnu or the VS ARM64 build tools).
		return { cargoArgs: ['build'], env: null };
	}

	if (target === 'aarch64-pc-windows-msvc') {
		if (msvcArm64LinkerInstalled()) return { cargoArgs: ['build'], env: null };
		const lld = rustLldDirectory();
		if (lld !== null && (sdkSplatReady() || ensureWindowsSdkSplat())) {
			const lib = [
				path.join(WINDOWS_SDK_SPLAT, 'crt', 'lib', 'arm64'),
				path.join(WINDOWS_SDK_SPLAT, 'sdk', 'lib', 'um', 'arm64'),
				path.join(WINDOWS_SDK_SPLAT, 'sdk', 'lib', 'ucrt', 'arm64')
			].join(';');
			return {
				cargoArgs: ['build'],
				env: {
					PATH: buildPath(),
					CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_LINKER: 'rust-lld',
					LIB: lib
				}
			};
		}
		if (commandExists('cargo', ['xwin', '--version'])) return { cargoArgs: ['xwin', 'build'], env: null };
		return {
			cargoArgs: null,
			reason:
				'skipped: aarch64-pc-windows-msvc needs the Visual Studio "C++ ARM64 build tools", ' +
				'or rust-lld + the xwin CLI (`cargo install xwin --locked`), or cargo-xwin.'
		};
	}

	if ((osFamilyOf(target) === 'linux' || osFamilyOf(target) === 'darwin') && commandExists('cargo', ['zigbuild', '--version'])) {
		return { cargoArgs: ['zigbuild', 'build'], env: { PATH: buildPath() } };
	}

	return {
		cargoArgs: null,
		reason: `skipped: cross-compiling ${target} from ${host} needs cargo-zigbuild (\`cargo install cargo-zigbuild\` + zig)`
	};
}

/** Build one target and place the artifact under native/. Returns true on success. */
function buildTarget(target, release, host) {
	const directory = TARGET_DIRECTORIES[target];
	if (directory === undefined) {
		console.error(
			`No extension directory is defined for the target ${target}.\n` +
				`Known targets:\n  ${Object.keys(TARGET_DIRECTORIES).join('\n  ')}`
		);
		return false;
	}

	const plan = buildCommandFor(target, host);
	if (plan.cargoArgs === null) {
		console.warn(`! ${target}: ${plan.reason}`);
		return false;
	}

	// Building for the host without `--target` reuses the shared target/<profile> cache, instead
	// of compiling everything again under target/<triple>/<profile>.
	const isHost = target === host;
	const args = [...plan.cargoArgs, '-p', 'git-graph-node'];
	if (release) args.push('--release');
	if (!isHost) args.push('--target', target);

	console.log(`> cargo ${args.join(' ')}`);
	const build = spawnSync('cargo', args, {
		cwd: root,
		stdio: 'inherit',
		env: plan.env === null ? process.env : { ...process.env, ...plan.env }
	});
	if (build.status !== 0) {
		console.error(`! ${target}: build failed (exit ${build.status ?? 1})`);
		return false;
	}

	// With an explicit --target, cargo nests the output under the triple; without one it does not.
	const built = path.join(root, 'target', ...(isHost ? [] : [target]), release ? 'release' : 'debug', artifactName(target));
	if (!fs.existsSync(built)) {
		console.error(`! ${target}: cargo reported success but produced no artifact at ${built}`);
		return false;
	}

	const destinationDirectory = path.join(root, 'native', directory);
	const destination = path.join(destinationDirectory, 'git-graph.node');
	fs.mkdirSync(destinationDirectory, { recursive: true });
	fs.copyFileSync(built, destination);

	const size = (fs.statSync(destination).size / (1024 * 1024)).toFixed(1);
	console.log(`Built ${target} (${release ? 'release' : 'debug'}) -> native/${directory}/git-graph.node (${size} MB)`);
	return true;
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	const host = hostTarget();

	const targets = options.all ? ALL_TARGETS : [options.target ?? host];
	const failed = targets.filter((target) => !buildTarget(target, options.release, host));
	if (failed.length > 0) {
		console.error(`\n${failed.length} target(s) failed or were skipped: ${failed.join(', ')}`);
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

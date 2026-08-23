/**
 * Build the native addon and put it where the extension loads it from,
 * `native/<platform>/git-graph.node`.
 *
 * The cargo plumbing is delegated to `@napi-rs/cli` (`napi build`), which knows where the
 * artifact lands and what it is called for each target. This script only maps the target triple
 * to the directory and file name the extension expects.
 *
 *   node scripts/build-addon.mjs                       # debug, for the host platform
 *   node scripts/build-addon.mjs --release             # what ships
 *   node scripts/build-addon.mjs --target <triple>     # cross-compile
 *   node scripts/build-addon.mjs --target <triple> --cross-compile
 *                                                      # force the cross toolchain (cargo-zigbuild
 *                                                      # / cargo-xwin) even for the host's own OS
 *                                                      # family — e.g. Windows arm64 on a machine
 *                                                      # without the VS "C++ ARM64 build tools"
 *                                                      # component, where the platform's own cross
 *                                                      # linker does not exist and the linker
 *                                                      # lookup falls through to whatever
 *                                                      # `link.exe` is on the PATH.
 *
 * A target of a foreign OS family is built through `napi build --cross-compile`, which uses
 * cargo-zigbuild (Linux and macOS targets; `zig` must be on the PATH) or cargo-xwin (Windows
 * targets), installing either on first use. A target of the host's own OS family uses the
 * platform's own cross linker (the Visual Studio "C++ ARM64 build tools" component on Windows,
 * gcc-aarch64-linux-gnu on Linux). The binaries that ship come from
 * `.github/workflows/native-build.yml`, which builds all six targets on native runners.
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

function parseArguments(argv) {
	const options = { release: false, target: null, crossCompile: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--release') options.release = true;
		else if (argv[i] === '--target') options.target = argv[++i];
		else if (argv[i].startsWith('--target=')) options.target = argv[i].slice('--target='.length);
		else if (argv[i] === '--cross-compile') options.crossCompile = true;
		else throw new Error(`Unknown argument: ${argv[i]}`);
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

/**
 * The artifact cargo produces for the crate, whose name differs per platform.
 */
function cargoArtifactName(target) {
	const family = osFamilyOf(target);
	if (family === 'windows') return 'git_graph_node.dll';
	if (family === 'darwin') return 'libgit_graph_node.dylib';
	return 'libgit_graph_node.so';
}

/**
 * The environment to build in, with `zig` findable by cargo-zigbuild.
 *
 * cargo-zigbuild looks for a `zig` binary on the PATH and does not discover the pip `ziglang`
 * package (the standard way to install zig on Windows), so that package's directory — which holds
 * `zig.exe` — is appended when `zig` is not otherwise resolvable.
 */
function buildEnvironment() {
	const probe = spawnSync('zig', ['version'], { encoding: 'utf8', shell: true });
	if (probe.status === 0) return process.env;
	const locate = spawnSync('python', ['-c', 'import ziglang, os; print(os.path.dirname(ziglang.__file__))'], { encoding: 'utf8' });
	if (locate.status === 0) {
		const zigDirectory = locate.stdout.trim();
		if (zigDirectory !== '' && fs.existsSync(path.join(zigDirectory, 'zig.exe'))) {
			const separator = process.platform === 'win32' ? ';' : ':';
			return { ...process.env, PATH: `${process.env.PATH}${separator}${zigDirectory}` };
		}
	}
	return process.env;
}

/**
 * Cross-build a Windows ARM64 engine without the VS "ARM64 build tools" component.
 *
 * rustc's default linker for the target is `link.exe`, and without that VS component no ARM64
 * link.exe exists — the lookup falls through to whatever `link.exe` is on the PATH (on a machine
 * with Git Bash, coreutils' `link`, which is not a linker). cargo-xwin would answer this, but its
 * first-run setup needs symlink privileges this kind of machine may not have.
 *
 * So the pieces are assembled directly, none of them needing elevation:
 *
 * - the linker is `rust-lld` from the Rust toolchain itself (`-flavor link`, which is exactly
 *   what it is invoked with for msvc targets);
 * - the import libraries for the OS side (kernel32.lib and friends) come from the Windows SDK's
 *   `arm64` directories, which every SDK install carries;
 * - the VC CRT import libraries come from the ARM64 CRT `.vsix` cargo-xwin has downloaded into
 *   its cache (it is a zip; only its *extraction* needs the symlinks). If it is not cached yet,
 *   one `cargo xwin build` attempt is made to populate the cache — its later failure is expected
 *   and ignored;
 * - the CRT is linked statically (`+crt-static`), because the desktop vsix ships only the static
 *   variants of the VC libraries;
 * - `legacy_stdio_definitions.lib` — which rustc passes on the link line unconditionally but
 *   which nothing in a pure-Rust addon imports — is satisfied by a valid empty archive.
 */
function buildWindowsArm64Locally(options, target, directory) {
	const kits = findWindowsKitsArm64();
	if (kits === null) {
		console.error(
			'! No Windows SDK with ARM64 libraries was found.\n' +
				'  Install the "Windows SDK" (any recent version includes the arm64 libs), or set\n' +
				'  GGR_WINDOWS_KITS to the Windows Kits\\10\\Lib directory.'
		);
		process.exit(1);
	}

	let vsix = findCachedArm64CrtVsix();
	if (vsix === null) {
		// Prime cargo-xwin's download cache; the splat step afterwards may fail for symlink
		// privileges — that failure is fine, the .vsix is what this route needs from it.
		console.log('> cargo xwin build   (downloading the CRT into cargo-xwin\'s cache; a later failure here is expected and harmless)');
		spawnSync('cargo', [
			'xwin', 'build',
			'--manifest-path', 'native/node/Cargo.toml',
			...(options.release ? ['--release'] : []),
			'--target', target
		], { cwd: root, stdio: 'inherit' });
		vsix = findCachedArm64CrtVsix();
	}
	if (vsix === null) {
		console.error(
			'! The ARM64 CRT package could not be obtained (cargo-xwin\'s cache stays empty).\n' +
				'  Retry with network access, or install the VS "C++ ARM64 build tools" component.'
		);
		process.exit(1);
	}

	const crtLib = extractArm64CrtLibraries(vsix);
	const stub = path.join(crtLib, 'legacy_stdio_definitions.lib');
	if (!fs.existsSync(stub)) fs.writeFileSync(stub, '!<arch>\n');

	const lld = path.join(hostSysroot(), 'lib', 'rustlib', hostTarget(), 'bin', 'rust-lld.exe');
	if (!fs.existsSync(lld)) {
		console.error(`! rust-lld was not found where the toolchain keeps it: ${lld}`);
		process.exit(1);
	}

	const env = {
		...process.env,
		[`CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_LINKER`]: lld,
		[`CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_RUSTFLAGS`]: '-Ctarget-feature=+crt-static',
		LIB: [crtLib, kits.ucrt, kits.um].join(';')
	};

	const args = ['build', '--manifest-path', 'native/node/Cargo.toml'];
	if (options.release) args.push('--release');
	args.push('--target', target);
	console.log(`> cargo ${args.join(' ')} (linker rust-lld, static CRT, local SDK+vsix libraries)`);
	const build = spawnSync('cargo', args, { cwd: root, stdio: 'inherit', env });
	if (build.status !== 0) process.exit(build.status ?? 1);

	const profile = options.release ? 'release' : 'debug';
	const artifact = path.join(root, 'target', target, profile, cargoArtifactName(target));
	if (!fs.existsSync(artifact)) {
		console.error(`! cargo reported success but the artifact is not where it is expected: ${artifact}`);
		process.exit(1);
	}
	place(artifact, target, directory, options);
}

/** The Windows SDK's ARM64 import-library directories, from the newest SDK on disk. */
function findWindowsKitsArm64() {
	const root = process.env.GGR_WINDOWS_KITS ?? 'C:\\Program Files (x86)\\Windows Kits\\10\\Lib';
	if (!fs.existsSync(root)) return null;
	const versions = fs
		.readdirSync(root)
		.filter((version) =>
			fs.existsSync(path.join(root, version, 'um', 'arm64', 'kernel32.lib')) &&
			fs.existsSync(path.join(root, version, 'ucrt', 'arm64', 'libucrt.lib'))
		)
		.sort();
	if (versions.length === 0) return null;
	const latest = versions[versions.length - 1];
	return {
		um: path.join(root, latest, 'um', 'arm64'),
		ucrt: path.join(root, latest, 'ucrt', 'arm64')
	};
}

/** The ARM64 desktop CRT `.vsix` in cargo-xwin's download cache, if it has been downloaded. */
function findCachedArm64CrtVsix() {
	const cache = path.join(process.env.LOCALAPPDATA ?? '', 'cargo-xwin', 'xwin', 'dl');
	if (!fs.existsSync(cache)) return null;
	const candidates = fs
		.readdirSync(cache)
		.filter((name) => /^Microsoft\.V.*\.CRT\.arm64\.Desktop\.base\.vsix$/.test(name))
		.sort();
	return candidates.length > 0 ? path.join(cache, candidates[candidates.length - 1]) : null;
}

/**
 * Unzip the CRT vsix (it is a plain zip) and return its `lib/arm64` directory, cached under
 * `target/arm64-crt` so the extraction runs once per CRT version.
 */
function extractArm64CrtLibraries(vsix) {
	const cacheRoot = path.join(root, 'target', 'arm64-crt');
	const extracted = path.join(cacheRoot, 'extracted');
	const marker = path.join(cacheRoot, '.extracted-from');
	if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === path.basename(vsix)) {
		const cached = findCrtLibDir(extracted);
		if (cached !== null) return cached;
	}
	fs.rmSync(extracted, { recursive: true, force: true });
	fs.mkdirSync(extracted, { recursive: true });
	const zip = path.join(cacheRoot, 'crt.zip');
	fs.copyFileSync(vsix, zip);
	const expand = spawnSync(
		'powershell',
		['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${extracted}" -Force`],
		{ stdio: 'inherit' }
	);
	if (expand.status !== 0) {
		console.error('! Could not extract the CRT vsix (Expand-Archive failed).');
		process.exit(1);
	}
	fs.writeFileSync(marker, path.basename(vsix));
	const lib = findCrtLibDir(extracted);
	if (lib === null) {
		console.error(`! The extracted CRT vsix has no lib/arm64 directory below ${extracted}`);
		process.exit(1);
	}
	return lib;
}

/** The `lib/arm64` directory inside an extracted CRT vsix — the one holding libcmt.lib. */
function findCrtLibDir(haystack) {
	if (!fs.existsSync(haystack)) return null;
	const queue = [haystack];
	while (queue.length > 0) {
		const dir = queue.shift();
		if (fs.existsSync(path.join(dir, 'libcmt.lib'))) return dir;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
		}
	}
	return null;
}

/** Where this toolchain keeps its per-host binaries (rust-lld among them). */
function hostSysroot() {
	const output = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
	if (output.status !== 0) throw new Error('Could not ask `rustc` for its sysroot.');
	return output.stdout.trim();
}

/** Move one built artifact into the extension's native/ layout. */
function place(artifact, target, directory, options) {
	const destinationDirectory = path.join(root, 'native', directory);
	fs.mkdirSync(destinationDirectory, { recursive: true });
	const destination = path.join(destinationDirectory, 'git-graph.node');
	fs.copyFileSync(artifact, destination);
	const size = (fs.statSync(destination).size / (1024 * 1024)).toFixed(1);
	console.log(`Built ${target} (${options.release ? 'release' : 'debug'}) -> native/${directory}/git-graph.node (${size} MB)`);
}

function main() {
	const options = parseArguments(process.argv.slice(2));
	const host = hostTarget();
	const target = options.target ?? host;

	const directory = TARGET_DIRECTORIES[target];
	if (directory === undefined) {
		console.error(
			`No extension directory is defined for the target ${target}.\n` +
				`Known targets:\n  ${Object.keys(TARGET_DIRECTORIES).join('\n  ')}`
		);
		process.exit(1);
	}

	const cli = path.join(root, 'node_modules', '@napi-rs', 'cli', 'dist', 'cli.js');
	if (!fs.existsSync(cli)) {
		throw new Error('@napi-rs/cli is not installed. Run `npm install` first.');
	}

	// A forced cross-compile of a target whose OS family matches the host: napi's cross path will
	// not engage (it considers the request redundant), so the pieces are assembled directly.
	const forcedSameFamilyCross =
		options.crossCompile && target !== host && osFamilyOf(target) === osFamilyOf(host);
	if (forcedSameFamilyCross && osFamilyOf(target) === 'windows') {
		buildWindowsArm64Locally(options, target, directory);
		return;
	}

	// napi build copies the artifact (plus a generated .d.ts) into --output-dir under its own
	// platform-suffixed name; it is moved to the extension's layout below.
	const staging = path.join(root, 'target', 'napi-build');
	fs.rmSync(staging, { recursive: true, force: true });

	const args = [
		cli,
		'build',
		'--manifest-path',
		'native/node/Cargo.toml',
		'--platform',
		'--no-js',
		'--output-dir',
		staging
	];
	if (options.release) args.push('--release');
	if (target !== host) {
		args.push('--target', target);
		if (options.crossCompile || osFamilyOf(target) !== osFamilyOf(host)) args.push('--cross-compile');
	} else if (options.crossCompile) {
		console.error('! --cross-compile needs a --target: it only means anything when cross-compiling.');
		process.exit(1);
	}

	console.log(`> napi ${args.slice(1).join(' ')}`);
	const build = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: buildEnvironment() });
	if (build.status !== 0) process.exit(build.status ?? 1);

	const artifacts = fs.existsSync(staging)
		? fs.readdirSync(staging).filter((file) => file.endsWith('.node'))
		: [];
	if (artifacts.length !== 1) {
		console.error(`! expected one .node artifact in ${staging}, found: ${artifacts.join(', ') || 'none'}`);
		process.exit(1);
	}

	place(path.join(staging, artifacts[0]), target, directory, options);
	fs.rmSync(staging, { recursive: true, force: true });
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

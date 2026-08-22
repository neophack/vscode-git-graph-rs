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
	const options = { release: false, target: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--release') options.release = true;
		else if (argv[i] === '--target') options.target = argv[++i];
		else if (argv[i].startsWith('--target=')) options.target = argv[i].slice('--target='.length);
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
		if (osFamilyOf(target) !== osFamilyOf(host)) args.push('--cross-compile');
	}

	console.log(`> napi ${args.slice(1).join(' ')}`);
	const build = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
	if (build.status !== 0) process.exit(build.status ?? 1);

	const artifacts = fs.existsSync(staging)
		? fs.readdirSync(staging).filter((file) => file.endsWith('.node'))
		: [];
	if (artifacts.length !== 1) {
		console.error(`! expected one .node artifact in ${staging}, found: ${artifacts.join(', ') || 'none'}`);
		process.exit(1);
	}

	const destinationDirectory = path.join(root, 'native', directory);
	fs.mkdirSync(destinationDirectory, { recursive: true });
	const destination = path.join(destinationDirectory, 'git-graph.node');
	fs.copyFileSync(path.join(staging, artifacts[0]), destination);
	fs.rmSync(staging, { recursive: true, force: true });

	const size = (fs.statSync(destination).size / (1024 * 1024)).toFixed(1);
	console.log(`Built ${target} (${options.release ? 'release' : 'debug'}) -> native/${directory}/git-graph.node (${size} MB)`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

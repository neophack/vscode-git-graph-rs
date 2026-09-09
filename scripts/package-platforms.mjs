/**
 * Package one VSIX per platform that has a built engine under `native/`, each carrying only that
 * platform's `git-graph.node`. Mirrors the "universal" VSIX `npm run package` produces (every
 * built engine in one package) by producing the smaller, single-engine alternative instead — the
 * shape the VS Code Marketplace's `--target` mechanism (and a manual GitHub Release download)
 * both want, so an install only pulls the one binary it can use instead of all six.
 *
 *   node scripts/package-platforms.mjs
 *
 * Requires `npm run compile` (or `npm run package`'s prerequisites) to have already produced
 * `out/` and `media/`; this script only re-runs `vsce package`, not the TypeScript/webview build.
 * Safe to run with any subset of the six `native/<platform>/git-graph.node` binaries present —
 * cross-compiled locally (see build-rust.bat --full) or downloaded from CI.
 *
 * `vsce package --target` refuses to run when `engines.vscode` is below 1.61, so while the
 * per-platform VSIXs are being built this script temporarily stamps `^1.61.0` into package.json
 * and restores the original file afterwards (the same stash/restore discipline as the binaries).
 * Each package type then declares exactly the clients that can receive it: the per-platform
 * VSIXs — which only VS Code >= 1.61 ever asks the Marketplace for, since older editors query
 * without a target platform and are handed the universal VSIX as the fallback — claim
 * `^1.61.0`, while the universal VSIX keeps package.json's own engines (^1.38.0) and is what
 * every pre-1.61 editor installs, picking its engine at load time by
 * `process.platform`-`process.arch` (src/backend/addon.ts).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'native');
// Resolved directly (rather than shelling out to `npx`/`vsce`) so this runs the same way on every
// OS: no shell, no dependence on a `.cmd`/`.ps1` shim existing on PATH (spawning those without a
// shell fails on Windows with EINVAL).
const vsceEntry = createRequire(import.meta.url).resolve('@vscode/vsce/vsce');

// Directory name under native/ -> the `vsce --target` identifier
// (https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions).
const VSCE_TARGET = {
	'win32-x64-msvc': 'win32-x64',
	'win32-arm64-msvc': 'win32-arm64',
	'linux-x64-gnu': 'linux-x64',
	'linux-arm64-gnu': 'linux-arm64',
	'darwin-x64': 'darwin-x64',
	'darwin-arm64': 'darwin-arm64'
};

const binaryName = 'git-graph.node';

// Matches the `vscode` entry of the `engines` block only, so the rewrite below never touches the
// `@types/vscode` devDependency (whose value also ends in `"vscode": "..."`).
const ENGINES_VSCODE = /("engines"\s*:\s*\{[\s\S]*?"vscode"\s*:\s*")([^"]+)(")/;

function findBuiltPlatforms() {
	if (!fs.existsSync(nativeDir)) return [];
	return fs.readdirSync(nativeDir).filter((entry) => {
		const binPath = path.join(nativeDir, entry, binaryName);
		return fs.existsSync(binPath) && fs.statSync(binPath).isFile();
	});
}

function main() {
	const platforms = findBuiltPlatforms();
	if (platforms.length === 0) {
		console.log('No native/<platform>/git-graph.node found - nothing to package per-platform.');
		console.log('Build at least one engine first (build-rust.bat), then re-run.');
		return;
	}

	const unmapped = platforms.filter((platform) => !VSCE_TARGET[platform]);
	if (unmapped.length > 0) {
		throw new Error(`No vsce --target mapping for platform director${unmapped.length > 1 ? 'ies' : 'y'}: ${unmapped.join(', ')}`);
	}

	const packageJsonPath = path.join(root, 'package.json');
	const packageJsonOriginal = fs.readFileSync(packageJsonPath, 'utf8');
	const version = JSON.parse(packageJsonOriginal).version;
	console.log(`Packaging ${platforms.length} platform VSIX${platforms.length > 1 ? 's' : ''} for version ${version}: ${platforms.join(', ')}`);

	// `vsce package --target` rejects engines.vscode < 1.61 (see the header comment for why the
	// temporary bump is the honest declaration for these packages, not a workaround). Restore the
	// original file in `restore()` below, alongside the engine binaries it puts back.
	const enginesMatch = packageJsonOriginal.match(ENGINES_VSCODE);
	if (enginesMatch === null) {
		throw new Error('Could not find engines.vscode in package.json');
	}
	// vsce's own gate is `semver.satisfies(engineVersion, '>=1.61')`; VS Code versions are 1.x, so
	// comparing the minor of the range's version covers every form package.json realistically
	// uses. An unparseable engine (`latest`) satisfies vsce too, so it defaults to no bump.
	const engineMinor = Number(/\d+\.(\d+)/.exec(enginesMatch[2])?.[1] ?? 61);
	let enginesPatched = false;
	if (engineMinor < 61) {
		fs.writeFileSync(packageJsonPath, packageJsonOriginal.replace(enginesMatch[0], `${enginesMatch[1]}^1.61.0${enginesMatch[3]}`));
		enginesPatched = true;
		console.log(`  temporarily raising engines.vscode ${enginesMatch[2]} -> ^1.61.0 for --target packaging`);
	}

	// Stash every engine aside (copy + delete, never rename: `os.tmpdir()` can live on another
	// volume than the repository — TEMP on C: and the repo on D: is common on Windows — and
	// renaming across volumes fails with EXDEV), then restore one at a time so each package
	// carries exactly one.
	const stash = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-platform-vsix-'));
	for (const platform of platforms) {
		const src = path.join(nativeDir, platform, binaryName);
		fs.copyFileSync(src, path.join(stash, `${platform}.node`));
		fs.unlinkSync(src);
	}

	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		// package.json first: a Ctrl+C or a crash must never leave the bumped engines behind.
		if (enginesPatched) {
			fs.writeFileSync(packageJsonPath, packageJsonOriginal);
			enginesPatched = false;
		}
		// Put every engine back, whether or not packaging succeeded for all of them
		// (copyFileSync overwrites, so a dest left behind by a failed packaging run is fine).
		for (const platform of platforms) {
			const stashedFile = path.join(stash, `${platform}.node`);
			if (fs.existsSync(stashedFile)) {
				fs.copyFileSync(stashedFile, path.join(nativeDir, platform, binaryName));
				fs.unlinkSync(stashedFile);
			}
		}
		fs.rmSync(stash, { recursive: true, force: true });
	};
	// The `finally` below only covers the script's own exceptions; without this handler a Ctrl+C
	// kills the process outright and strands every engine in the temp stash. Registering it keeps
	// the process alive long enough for the cleanup to run (a Ctrl+C during `vsce package` also
	// kills that child, so `execFileSync` throws and unwinds through the `finally`).
	process.on('SIGINT', () => {
		restore();
		process.exit(130);
	});

	const produced = [];
	try {
		for (const platform of platforms) {
			const target = VSCE_TARGET[platform];
			const dest = path.join(nativeDir, platform, binaryName);
			fs.copyFileSync(path.join(stash, `${platform}.node`), dest);
			const outFile = `git-graph-rs-${version}-${platform}.vsix`;
			console.log(`  packaging ${outFile} (--target ${target})...`);
			execFileSync(process.execPath, [
				vsceEntry, 'package', '--target', target,
				'--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid',
				'--out', outFile
			], { cwd: root, stdio: 'inherit' });
			produced.push(outFile);
			fs.unlinkSync(dest);
		}
	} finally {
		restore();
	}

	console.log(`Done: ${produced.join(', ')}`);
}

main();

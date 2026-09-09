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

	const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
	console.log(`Packaging ${platforms.length} platform VSIX${platforms.length > 1 ? 's' : ''} for version ${version}: ${platforms.join(', ')}`);

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

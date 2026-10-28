/**
 * The per-platform VSIX packaging contract (scripts/package-platforms.mjs): every engine the
 * loader ships has a vsce `--target` mapping, no mapping names an engine that does not exist,
 * and every target identifier is one the Marketplace actually accepts. The loader's engine
 * table and the packaging script's target table live in different files on purpose — the
 * loader must know the engines at runtime, the packager must know their Marketplace targets —
 * but the two drift quietly if nothing holds them together: a missing mapping makes the
 * packager skip an engine it just built, a stale one packages a directory no engine occupies,
 * and a mistyped target makes `vsce package --target` (or the Marketplace placement) fail.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { enginePlatformTable } from '../../src/extension/git/read/addonLoader';
import { VSCE_TARGET, findBuiltPlatforms } from '../../scripts/package-platforms.mjs';

/** The platform identifiers `vsce package --target` accepts (code.visualstudio.com publishing docs). */
const VSCE_PLATFORMS = [
	'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64',
	'alpine-x64', 'alpine-arm64', 'linux-armhf', 'darwin-x64', 'darwin-arm64'
];

describe('per-platform VSIX packaging (package-platforms.mjs)', () => {
	it('every engine the loader ships has a vsce target mapping', () => {
		const engineDirectories = enginePlatformTable(path.join(os.tmpdir(), 'gg-nonexistent-root'))
			.map((platform) => platform.directory);
		for (const directory of engineDirectories) {
			assert.ok(directory in VSCE_TARGET, `no vsce --target mapping for engine directory ${directory}`);
		}
	});

	it('the libc-twin and armhf engines map to their Marketplace-specific targets', () => {
		assert.equal(VSCE_TARGET['linux-x64-musl'], 'alpine-x64');
		assert.equal(VSCE_TARGET['linux-arm64-musl'], 'alpine-arm64');
		assert.equal(VSCE_TARGET['linux-armhf'], 'linux-armhf');
	});

	it('no mapping names an engine directory the loader does not ship', () => {
		const engineDirectories = new Set(
			enginePlatformTable(path.join(os.tmpdir(), 'gg-nonexistent-root')).map((platform) => platform.directory)
		);
		for (const directory of Object.keys(VSCE_TARGET)) {
			assert.ok(engineDirectories.has(directory), `vsce target table names ${directory}, which the loader does not ship`);
		}
	});

	it('every target identifier is one vsce accepts, and no two engines share one', () => {
		const targets = Object.values(VSCE_TARGET);
		for (const target of targets) {
			assert.ok(VSCE_PLATFORMS.includes(target), `${target} is not a vsce platform identifier`);
		}
		assert.equal(new Set(targets).size, targets.length, 'two engine directories map to the same vsce target');
	});

	it('findBuiltPlatforms lists only directories carrying a built binary', () => {
		const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-platform-vsix-'));
		try {
			fs.mkdirSync(path.join(sandbox, 'win32-x64-msvc'), { recursive: true });
			fs.mkdirSync(path.join(sandbox, 'linux-armhf'), { recursive: true });
			fs.mkdirSync(path.join(sandbox, 'darwin-x64'), { recursive: true });
			fs.writeFileSync(path.join(sandbox, 'win32-x64-msvc', 'git-graph.node'), 'binary');
			fs.writeFileSync(path.join(sandbox, 'linux-armhf', 'git-graph.node.tmp'), 'not yet');
			// darwin-x64 stays empty: a directory without the binary is not a built platform.
			fs.writeFileSync(path.join(sandbox, 'README.md'), 'not a platform directory');
			assert.deepEqual(findBuiltPlatforms(sandbox), ['win32-x64-msvc']);
		} finally {
			fs.rmSync(sandbox, { recursive: true, force: true });
		}
	});
});

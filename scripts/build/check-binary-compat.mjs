/**
 * Binary compatibility gate for the native engine (REFACTOR-PLAN §3.7.4, task 2.8; the floors
 * are decided in docs/adr/adr-0002 and promised in docs/compatibility.md).
 *
 *   node scripts/build/check-binary-compat.mjs [nativeDir]
 *
 * Scans `native/<platform>/git-graph.node` (default directory: `native/`) and asserts:
 *
 *   - linux *-gnu (x64, arm64, armhf): the highest `GLIBC_<x>.<y>` symbol version referenced is
 *     <= 2.17 — via `objdump -T` (GNU binutils, present on every Linux CI runner).
 *   - linux *-musl: no `GLIBC_` symbol version is referenced at all (a musl-linked binary must
 *     not carry glibc dynamic references).
 *   - darwin x64/arm64: the load-time minimum OS ("minos") is >= 10.13 — via `vtool
 *     -show-build`, falling back to `otool -l` (LC_BUILD_VERSION / LC_VERSION_MIN_MACOSX).
 *   - win32 x64/arm64 msvc: the PE import table does not name `VCRUNTIME140.dll` — via a
 *     pure-Node PE import-directory scan (the same question `dumpbin /dependents` answers, but
 *     portable: it runs on any OS, so a Linux CI job can check the Windows binaries too).
 *
 * SKIP semantics: a platform with no built binary is always a SKIP (the universal VSIX tolerates
 * missing platforms; presence is the packaging workflow's concern). A platform tool that is not
 * installed (objdump/vtool/otool) is also a SKIP locally — but with the environment variable
 *     BINARY_COMPAT_REQUIRED=1
 * set (how CI runs this script) a tool-unavailable SKIP is a FAILURE, and so is a run in which
 * nothing was checked at all. A FAIL always exits 1.
 *
 * The parsing functions (`parsePeImports`, `parseGlibcVersions`, `parseMinOs`) are exported and
 * unit-tested in tests/checkBinaryCompat.test.mjs; no platform tool is needed to test them.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GLIBC_FLOOR = '2.17';
export const MACOS_MIN_OS = '10.13';
/** The DLL a static-CRT build must not import (docs/adr/adr-0002). */
export const FORBIDDEN_WINDOWS_IMPORT = 'vcruntime140.dll';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** platform directory -> which floor applies to its binary. */
const PLATFORM_CHECKS = [
	{ platforms: ['linux-x64-gnu', 'linux-arm64-gnu', 'linux-armhf'], kind: 'glibc-floor' },
	{ platforms: ['linux-x64-musl', 'linux-arm64-musl'], kind: 'musl-purity' },
	{ platforms: ['darwin-x64', 'darwin-arm64'], kind: 'macos-minos' },
	{ platforms: ['win32-x64-msvc', 'win32-arm64-msvc'], kind: 'windows-crt' }
];

// ---------------------------------------------------------------------------------------------
// Pure parsers (unit-tested; no tools involved)
// ---------------------------------------------------------------------------------------------

/**
 * All glibc symbol versions mentioned in `objdump -T` style text, as version strings with their
 * original shape (GLIBC_2.2.5 -> '2.2.5', GLIBC_2.34 -> '2.34'). The shape matters: comparing
 * versions as decimal numbers is wrong (2.2.5 is OLDER than 2.17, yet 2.2 > 2.17 as decimals),
 * so consumers compare with {@link compareVersions}.
 *
 * @returns {string[]}
 */
export function parseGlibcVersions(text) {
	const versions = [];
	const pattern = /GLIBC_(\d+(?:\.\d+)*)/g;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		versions.push(match[1]);
	}
	return versions;
}

/** -1 / 0 / 1 for `a` below / equal / above `b`, component by component (2.2.5 < 2.17 < 2.2.6). */
export function compareVersions(a, b) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const delta = (left[i] ?? 0) - (right[i] ?? 0);
		if (delta !== 0) return delta < 0 ? -1 : 1;
	}
	return 0;
}

/** The highest glibc version in the text (a version string), or null when none is mentioned. */
export function maxGlibcVersion(text) {
	const versions = parseGlibcVersions(text);
	let highest = null;
	for (const version of versions) {
		if (highest === null || compareVersions(version, highest) > 0) highest = version;
	}
	return highest;
}

/**
 * The macOS load-time floor in `vtool -show-build` / `otool -l` output, as a version string
 * ('10.13.0' keeps its shape), or null when the output mentions no version command. Prefers
 * `minos` tokens (vtool and LC_BUILD_VERSION); falls back to the `version` of an
 * LC_VERSION_MIN_MACOSX block (the pre-10.14 command old toolchains emit). When several appear,
 * the highest wins (a fat binary or a mixture of build/sdk lines must never report lower than
 * the strictest load floor). Compare with {@link compareVersions}, never as decimals.
 */
export function parseMinOs(text) {
	const candidates = [];
	const minos = /minos\s+(\d+(?:\.\d+)*)/g;
	let match;
	while ((match = minos.exec(text)) !== null) candidates.push(match[1]);
	if (candidates.length === 0) {
		const versionMin = /LC_VERSION_MIN_MACOSX[\s\S]{0,200}?\bversion\s+(\d+(?:\.\d+)*)/g;
		while ((match = versionMin.exec(text)) !== null) candidates.push(match[1]);
	}
	if (candidates.length === 0) return null;
	let highest = candidates[0];
	for (const candidate of candidates) {
		if (compareVersions(candidate, highest) > 0) highest = candidate;
	}
	return highest;
}

function readU16(buffer, offset) {
	if (offset < 0 || offset + 2 > buffer.length) {
		throw new Error(`truncated PE: cannot read a word at 0x${offset.toString(16)}`);
	}
	return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset) {
	if (offset < 0 || offset + 4 > buffer.length) {
		throw new Error(`truncated PE: cannot read a dword at 0x${offset.toString(16)}`);
	}
	return buffer.readUInt32LE(offset);
}

/**
 * The DLL names in a PE file's import table (its IMAGE_IMPORT_DESCRIPTOR name entries), in
 * order. A pure-Node equivalent of `dumpbin /dependents`, so the Windows CRT question can be
 * asserted on any OS. Throws on anything that is not a well-formed PE32/PE32+ image; an image
 * with no import directory yields an empty array.
 *
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function parsePeImports(buffer) {
	if (!Buffer.isBuffer(buffer)) throw new TypeError('parsePeImports expects a Buffer');
	if (readU16(buffer, 0) !== 0x5a4d) throw new Error('not a PE file: missing the MZ signature');
	const peHeader = readU32(buffer, 0x3c);
	if (readU32(buffer, peHeader) !== 0x00004550) throw new Error('not a PE file: missing the PE signature');
	const sectionCount = readU16(buffer, peHeader + 6);
	const optionalSize = readU16(buffer, peHeader + 20);
	if (optionalSize === 0) throw new Error('not a PE file: no optional header');
	const optional = peHeader + 24;
	const magic = readU16(buffer, optional);
	if (magic !== 0x10b && magic !== 0x20b) {
		throw new Error(`not a supported PE file: optional header magic 0x${magic.toString(16)}`);
	}
	// Data directory index 1 is the import table; its offset within the optional header differs
	// between PE32 (96) and PE32+ (112).
	const dataDirectory = optional + (magic === 0x20b ? 112 : 96);
	const importRva = readU32(buffer, dataDirectory + 8);
	if (importRva === 0) return [];

	const sections = [];
	const sectionTable = optional + optionalSize;
	for (let i = 0; i < sectionCount; i++) {
		const entry = sectionTable + i * 40;
		const virtualSize = readU32(buffer, entry + 8);
		const virtualAddress = readU32(buffer, entry + 12);
		const rawSize = readU32(buffer, entry + 16);
		const rawPointer = readU32(buffer, entry + 20);
		sections.push({ virtualAddress, span: Math.max(virtualSize, rawSize), rawPointer });
	}
	const rvaToOffset = (rva) => {
		for (const section of sections) {
			if (rva >= section.virtualAddress && rva < section.virtualAddress + section.span) {
				return rva - section.virtualAddress + section.rawPointer;
			}
		}
		return -1;
	};
	const readCString = (offset) => {
		const end = buffer.indexOf(0, offset);
		if (end < 0 || end - offset > 0x1000) throw new Error('truncated PE: unreasonable import name');
		return buffer.toString('ascii', offset, end);
	};

	const names = [];
	let descriptor = rvaToOffset(importRva);
	if (descriptor < 0) throw new Error('PE import directory RVA maps to no section');
	// Descriptors are 20 bytes; an all-zero one (name and first thunk both 0) terminates.
	for (;;) {
		const nameRva = readU32(buffer, descriptor + 12);
		const firstThunk = readU32(buffer, descriptor + 16);
		if (nameRva === 0 && firstThunk === 0) break;
		const nameOffset = rvaToOffset(nameRva);
		if (nameOffset < 0) throw new Error('PE import name RVA maps to no section');
		const name = readCString(nameOffset);
		if (name !== '') names.push(name);
		descriptor += 20;
	}
	return names;
}

// ---------------------------------------------------------------------------------------------
// Per-kind checks against a real binary
// ---------------------------------------------------------------------------------------------

function runTool(command, args) {
	const result = spawnSync(command, args, { encoding: 'utf8' });
	if (result.error) return { missing: true, status: null, stdout: '', stderr: String(result.error.message) };
	return {
		missing: false,
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? ''
	};
}

function firstLine(text) {
	return text.split(/\r?\n/, 1)[0] ?? '';
}

function skipForTool(reason) {
	return { status: 'skip', toolUnavailable: true, reason };
}

function checkGlibcFloor(file) {
	const run = runTool('objdump', ['-T', file]);
	if (run.missing) return skipForTool('`objdump` (binutils) is not available on this machine');
	if (run.status !== 0) return { status: 'fail', reason: `objdump exited ${run.status}: ${firstLine(run.stderr)}` };
	const highest = maxGlibcVersion(run.stdout);
	if (highest !== null && compareVersions(highest, GLIBC_FLOOR) > 0) {
		return { status: 'fail', reason: `references GLIBC_${highest} symbols; the floor is ${GLIBC_FLOOR}` };
	}
	return {
		status: 'pass',
		reason: highest === null
			? 'no GLIBC_ symbol versions referenced'
			: `highest GLIBC_ reference ${highest}, floor ${GLIBC_FLOOR}`
	};
}

function checkMuslPurity(file) {
	const run = runTool('objdump', ['-T', file]);
	if (run.missing) return skipForTool('`objdump` (binutils) is not available on this machine');
	if (run.status !== 0) return { status: 'fail', reason: `objdump exited ${run.status}: ${firstLine(run.stderr)}` };
	const highest = maxGlibcVersion(run.stdout);
	if (highest !== null) {
		return { status: 'fail', reason: `musl binary references GLIBC_${highest} symbols` };
	}
	return { status: 'pass', reason: 'no GLIBC_ symbol versions referenced' };
}

function checkMacosMinOs(file) {
	let run = runTool('vtool', ['-show-build', '-output', file]);
	if (run.missing || run.status !== 0) {
		const fallback = runTool('otool', ['-l', file]);
		if (!fallback.missing) run = fallback;
	}
	if (run.missing) return skipForTool('neither `vtool` nor `otool` is available (run this check on macOS)');
	if (run.status !== 0) return { status: 'fail', reason: `vtool/otool exited ${run.status}: ${firstLine(run.stderr)}` };
	const minOs = parseMinOs(run.stdout);
	if (minOs === null) {
		return { status: 'fail', reason: 'no minos / LC_VERSION_MIN_MACOSX version found in the output' };
	}
	if (compareVersions(minOs, MACOS_MIN_OS) < 0) {
		return { status: 'fail', reason: `min OS ${minOs} is below the promised ${MACOS_MIN_OS}` };
	}
	return { status: 'pass', reason: `min OS ${minOs}` };
}

function checkWindowsCrt(file) {
	let imports;
	try {
		imports = parsePeImports(fs.readFileSync(file));
	} catch (error) {
		return { status: 'fail', reason: `could not parse the PE import table: ${error.message}` };
	}
	const forbidden = imports.find((name) => name.toLowerCase() === FORBIDDEN_WINDOWS_IMPORT);
	if (forbidden !== undefined) {
		return {
			status: 'fail',
			reason: `imports ${forbidden} (the dynamic VC++ runtime); build with -C target-feature=+crt-static`
		};
	}
	const summary = imports.length > 0 ? `imports: ${imports.join(', ')}` : 'imports nothing';
	return { status: 'pass', reason: `no ${FORBIDDEN_WINDOWS_IMPORT} among ${imports.length} (${summary})` };
}

const CHECK_RUNNERS = {
	'glibc-floor': checkGlibcFloor,
	'musl-purity': checkMuslPurity,
	'macos-minos': checkMacosMinOs,
	'windows-crt': checkWindowsCrt
};

/**
 * Run every check against the binaries present under `nativeDirectory`.
 *
 * @returns {{ results: Array<{platform: string, kind: string, status: 'pass'|'fail'|'skip',
 *     reason: string, toolUnavailable?: boolean}>, exitCode: number, failed: number,
 *     skippedForTools: number, passed: number}}
 */
export function checkBinaryCompat(nativeDirectory, { required = false } = {}) {
	const results = [];
	for (const group of PLATFORM_CHECKS) {
		for (const platform of group.platforms) {
			const file = path.join(nativeDirectory, platform, 'git-graph.node');
			if (!fs.existsSync(file)) {
				// A missing platform binary is a packaging question, not a compatibility failure:
				// the universal VSIX legitimately ships without every platform.
				results.push({ platform, kind: group.kind, status: 'skip', reason: 'no binary built for this platform' });
				continue;
			}
			results.push({ platform, kind: group.kind, file, ...CHECK_RUNNERS[group.kind](file) });
		}
	}

	const failed = results.filter((result) => result.status === 'fail');
	const skippedForTools = results.filter((result) => result.status === 'skip' && result.toolUnavailable);
	const passed = results.filter((result) => result.status === 'pass');

	let exitCode = 0;
	if (failed.length > 0) exitCode = 1;
	if (required) {
		if (skippedForTools.length > 0) exitCode = 1;
		if (passed.length === 0) {
			// Required mode must have checked something; zero real checks means a broken
			// artifact layout (e.g. pointed at an empty directory), not a compatibility pass.
			exitCode = 1;
		}
	}
	return { results, exitCode, failed: failed.length, skippedForTools: skippedForTools.length, passed: passed.length };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function usage() {
	console.log(
		'Assert the binary compatibility floors of the native engine (docs/adr/adr-0002).\n' +
			'\n' +
			'  node scripts/build/check-binary-compat.mjs [nativeDir]\n' +
			'\n' +
			'  nativeDir   directory holding <platform>/git-graph.node (default: native/)\n' +
			'\n' +
			'Checks: glibc <= 2.17 on linux *-gnu (objdump -T); no GLIBC_ references on *-musl\n' +
			'(objdump -T); minos >= 10.13 on darwin (vtool/otool); no VCRUNTIME140.dll import on\n' +
			'win32 msvc (pure-Node PE scan). Tool-less checks SKIP locally; with\n' +
			'BINARY_COMPAT_REQUIRED=1 (CI) a SKIP is a failure.'
	);
}

function main() {
	const argument = process.argv[2];
	if (argument === '--help' || argument === '-h') {
		usage();
		return;
	}
	const nativeDirectory = path.resolve(argument ?? path.join(root, 'native'));
	if (!fs.existsSync(nativeDirectory)) {
		console.error(`! The native directory does not exist: ${nativeDirectory}`);
		process.exit(1);
	}
	const required = process.env.BINARY_COMPAT_REQUIRED === '1';

	const outcome = checkBinaryCompat(nativeDirectory, { required });
	for (const result of outcome.results) {
		const line = `${result.status.toUpperCase()}  ${result.platform.padEnd(16)} ${result.reason}`;
		console.log(line);
	}
	console.log(
		`\n${outcome.passed} passed, ${outcome.failed} failed, ` +
			`${outcome.results.length - outcome.passed - outcome.failed} skipped` +
			(required ? ' (BINARY_COMPAT_REQUIRED=1: tool skips are failures)' : '')
	);
	if (outcome.exitCode !== 0) {
		console.error('! Binary compatibility floors not satisfied.');
	}
	process.exit(outcome.exitCode);
}

const invokedDirectly = process.argv[1] !== undefined &&
	path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
	main();
}

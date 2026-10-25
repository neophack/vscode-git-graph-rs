/**
 * Unit tests for the binary compatibility gate (scripts/build/check-binary-compat.mjs,
 * REFACTOR-PLAN task 2.8): the pure parsers (glibc symbol versions, macOS minos, the PE import
 * table) run against crafted fixtures so no platform tool is needed, and the orchestration
 * (pass / fail / tool-skip, and BINARY_COMPAT_REQUIRED turning tool-skips into failures) is
 * exercised through temp native/ directories. The only environment-dependent branch — a darwin
 * binary on a machine that actually has vtool/otool — self-skips where those tools exist.
 *
 * When a real native/win32-x64-msvc/git-graph.node has been built, its import table is scanned
 * too (parse-only; whether VCRUNTIME140.dll is absent depends on the flags it was built with, so
 * that assertion belongs to CI, not here).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	checkBinaryCompat,
	compareVersions,
	maxGlibcVersion,
	parseGlibcVersions,
	parseMinOs,
	parsePeImports
} from '../scripts/build/check-binary-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realWindowsBinary = path.join(root, 'native', 'win32-x64-msvc', 'git-graph.node');

/**
 * A minimal PE image whose import directory names exactly `imports`, exercising the parser's
 * header walking (MZ -> PE -> optional header magic -> data directory -> sections -> RVA
 * mapping). `magic` selects PE32+ (0x20b, what the real .node files are) or PE32 (0x10b), whose
 * data directory sits 16 bytes earlier.
 */
function buildPe({ imports = [], machine = 0x8664, magic = 0x20b } = {}) {
	const optionalHeaderSize = magic === 0x20b ? 240 : 224;
	const peHeader = 0x40;
	const sectionTable = peHeader + 24 + optionalHeaderSize;
	const sectionData = sectionTable + 40; // exactly one section header
	const virtualAddress = 0x1000;
	const stringsOffset = sectionData + (imports.length + 1) * 20;
	const totalSize = stringsOffset + imports.reduce((sum, name) => sum + name.length + 1, 0);
	const buffer = Buffer.alloc(totalSize);
	const toRva = (fileOffset) => virtualAddress + (fileOffset - sectionData);

	buffer.write('MZ', 0, 'ascii');
	buffer.writeUInt32LE(peHeader, 0x3c);
	buffer.write('PE\0\0', peHeader, 'ascii');
	buffer.writeUInt16LE(machine, peHeader + 4); // Machine
	buffer.writeUInt16LE(1, peHeader + 6); // NumberOfSections
	buffer.writeUInt16LE(optionalHeaderSize, peHeader + 20); // SizeOfOptionalHeader
	buffer.writeUInt16LE(0x2022, peHeader + 22); // Characteristics (a DLL image)
	buffer.writeUInt16LE(magic, peHeader + 24);

	const dataDirectory = peHeader + 24 + (magic === 0x20b ? 112 : 96);
	buffer.writeUInt32LE(imports.length > 0 ? virtualAddress : 0, dataDirectory + 8); // import RVA
	buffer.writeUInt32LE(imports.length > 0 ? (imports.length + 1) * 20 : 0, dataDirectory + 12);

	buffer.write('.idata', sectionTable, 'ascii');
	buffer.writeUInt32LE(totalSize - sectionData, sectionTable + 8); // VirtualSize
	buffer.writeUInt32LE(virtualAddress, sectionTable + 12); // VirtualAddress
	buffer.writeUInt32LE(totalSize - sectionData, sectionTable + 16); // SizeOfRawData
	buffer.writeUInt32LE(sectionData, sectionTable + 20); // PointerToRawData

	let stringCursor = stringsOffset;
	for (const [index, name] of imports.entries()) {
		const descriptor = sectionData + index * 20;
		buffer.writeUInt32LE(toRva(stringCursor), descriptor + 12); // Name RVA
		buffer.writeUInt32LE(virtualAddress + 0x40, descriptor + 16); // FirstThunk (non-zero)
		buffer.write(name, stringCursor, 'ascii');
		stringCursor += name.length;
		buffer.writeUInt8(0, stringCursor);
		stringCursor += 1;
	}
	// The terminator descriptor (all zeros) is what Buffer.alloc already provides.
	return buffer;
}

/** A temp native/ directory the orchestrator-level tests place binaries into. */
function makeNativeDirectory() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ggr-binary-compat-'));
	return { directory, clean: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function placeBinary(nativeDirectory, platform, contents) {
	const platformDirectory = path.join(nativeDirectory, platform);
	fs.mkdirSync(platformDirectory, { recursive: true });
	fs.writeFileSync(path.join(platformDirectory, 'git-graph.node'), contents);
}

/** True when the tool cannot even be spawned on this machine (ENOENT). */
function toolMissing(command) {
	const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
	return probe.error !== undefined;
}

test('parseGlibcVersions collects every GLIBC_ token, maxGlibcVersion picks the highest', () => {
	const objdumpExcerpt = [
		'DYNAMIC SYMBOL TABLE:',
		'0000000000000000      DF 1    memcpy  GLIBC_2.14 (3)',
		'0000000000000000      DF 1    free    GLIBC_2.2.5',
		'0000000000000000      DF 1    statx   GLIBC_2.28',
		'0000000000000000      DO      __gmon_start__  GLIBC_2.0'
	].join('\n');
	assert.deepEqual(parseGlibcVersions(objdumpExcerpt).sort(), ['2.0', '2.14', '2.2.5', '2.28']);
	assert.equal(maxGlibcVersion(objdumpExcerpt), '2.28');
	assert.equal(maxGlibcVersion('nothing versioned here'), null);
	assert.equal(maxGlibcVersion('GLIBC_2.17 GLIBC_2.17 GLIBC_2.2.5'), '2.17');
});

test('compareVersions orders components, not decimals (2.2.5 predates 2.17)', () => {
	assert.equal(compareVersions('2.2.5', '2.17'), -1);
	assert.equal(compareVersions('2.2', '2.17'), -1);
	assert.equal(compareVersions('2.17', '2.17'), 0);
	assert.equal(compareVersions('2.17.1', '2.17'), 1);
	assert.equal(compareVersions('2.28', '2.17'), 1);
	assert.equal(compareVersions('3', '2.17'), 1);
	assert.equal(compareVersions('10.9', '10.13'), -1);
});

test('parseMinOs reads vtool output, LC_BUILD_VERSION and LC_VERSION_MIN_MACOSX', () => {
	const vtoolOutput = [
		'native/win-x64/git-graph.node:',
		'Load command 1',
		'      cmd LC_BUILD_VERSION',
		'    platform MACOS',
		'       sdk 13.3',
		'     minos 10.13.0',
		'    ntools 2'
	].join('\n');
	assert.equal(parseMinOs(vtoolOutput), '10.13.0');

	const otoolBuildVersion = '   minos 11.0\n   sdk 14.0\n';
	assert.equal(parseMinOs(otoolBuildVersion), '11.0');

	const otoolVersionMin = [
		'Load command 3',
		'          cmd LC_VERSION_MIN_MACOSX',
		'      cmdsize 16',
		'     version 10.9.0',
		'        sdk 10.15'
	].join('\n');
	assert.equal(parseMinOs(otoolVersionMin), '10.9.0');

	// minos wins over a version-min block; the highest mention wins (fat binary).
	assert.equal(parseMinOs(`${otoolVersionMin}\n${vtoolOutput}`), '10.13.0');
	assert.equal(parseMinOs('no version commands at all'), null);
});

test('parsePeImports walks a crafted PE32+ import table', () => {
	const binary = buildPe({ imports: ['VCRUNTIME140.dll', 'KERNEL32.dll', 'WS2_32.dll'] });
	assert.deepEqual(parsePeImports(binary), ['VCRUNTIME140.dll', 'KERNEL32.dll', 'WS2_32.dll']);
});

test('parsePeImports walks a crafted PE32 (32-bit) import table', () => {
	const binary = buildPe({ imports: ['VCRUNTIME140.dll'], machine: 0x14c, magic: 0x10b });
	assert.deepEqual(parsePeImports(binary), ['VCRUNTIME140.dll']);
});

test('parsePeImports returns an empty list for an image with no import directory', () => {
	assert.deepEqual(parsePeImports(buildPe({ imports: [] })), []);
});

test('parsePeImports rejects non-PE and truncated input', () => {
	assert.throws(() => parsePeImports(Buffer.from('not a pe file at all, really')), /not a PE file/);
	assert.throws(() => parsePeImports(Buffer.alloc(64)), /not a PE file/);
	assert.throws(() => parsePeImports(Buffer.from('')), /truncated PE/);
	const truncated = buildPe({ imports: ['KERNEL32.dll'] }).subarray(0, 0x80);
	assert.throws(() => parsePeImports(truncated), /truncated PE|not a PE file/);
	assert.throws(() => parsePeImports('a string'), TypeError);
});

test('checkBinaryCompat passes a static-CRT windows binary and fails a VCRUNTIME140 one', () => {
	const { directory, clean } = makeNativeDirectory();
	try {
		placeBinary(directory, 'win32-x64-msvc', buildPe({ imports: ['KERNEL32.dll', 'ADVAPI32.dll'] }));
		const pass = checkBinaryCompat(directory);
		const windowsResult = pass.results.find((result) => result.platform === 'win32-x64-msvc');
		assert.equal(windowsResult.status, 'pass');
		assert.equal(pass.failed, 0);
		assert.equal(pass.exitCode, 0);

		placeBinary(directory, 'win32-x64-msvc', buildPe({ imports: ['KERNEL32.dll', 'VCRUNTIME140.dll'] }));
		const fail = checkBinaryCompat(directory);
		const failedResult = fail.results.find((result) => result.platform === 'win32-x64-msvc');
		assert.equal(failedResult.status, 'fail');
		assert.match(failedResult.reason, /VCRUNTIME140\.dll/);
		assert.equal(fail.exitCode, 1);
	} finally {
		clean();
	}
});

test('checkBinaryCompat skips absent platforms, and required mode fails a run that checked nothing', () => {
	const { directory, clean } = makeNativeDirectory();
	try {
		const local = checkBinaryCompat(directory);
		assert.equal(local.exitCode, 0);
		assert.ok(local.results.every((result) => result.status === 'skip'));
		assert.equal(local.passed, 0);

		const required = checkBinaryCompat(directory, { required: true });
		assert.equal(required.exitCode, 1);
	} finally {
		clean();
	}
});

test('a darwin binary without vtool/otool skips locally, but is a failure when required', { skip: toolMissing('vtool') && toolMissing('otool') ? false : 'this machine has vtool/otool' }, () => {
	const { directory, clean } = makeNativeDirectory();
	try {
		// The darwin check never parses the file with our own parser, so any bytes stand in.
		placeBinary(directory, 'darwin-x64', Buffer.from('mach-o stand-in'));
		const local = checkBinaryCompat(directory);
		const result = local.results.find((entry) => entry.platform === 'darwin-x64');
		assert.equal(result.status, 'skip');
		assert.equal(result.toolUnavailable, true);
		assert.equal(local.exitCode, 0);

		const required = checkBinaryCompat(directory, { required: true });
		assert.equal(required.skippedForTools, 1);
		assert.equal(required.exitCode, 1);
	} finally {
		clean();
	}
});

test('the real win32-x64 binary, when built, parses into DLL import names', { skip: fs.existsSync(realWindowsBinary) ? false : 'native/win32-x64-msvc/git-graph.node has not been built' }, () => {
	const imports = parsePeImports(fs.readFileSync(realWindowsBinary));
	assert.ok(Array.isArray(imports));
	assert.ok(imports.length > 0, 'a .node with a dynamic CRT imports at least kernel32');
	for (const name of imports) {
		assert.match(name, /\.dll$/i);
	}
});

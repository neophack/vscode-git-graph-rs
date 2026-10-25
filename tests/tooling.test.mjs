/**
 * Tests for the tooling around the extension: the session-log analyser and the benchmark runner.
 *
 * These are the tools a performance investigation actually uses, so they are tested like code:
 * a synthetic session log with known contents must produce the expected summary, and the bench
 * must run to completion against a small real repository in both of its modes.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(script, args) {
	return execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
	});
}

describe('the session-log analyser', () => {
	let logFile;

	before(() => {
		logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-log-')), 'session.log');
		const lines = [
			'[2026-08-23 10:00:00.000] > git log --format=... -z (42 ms)',
			'[2026-08-23 10:00:00.100] > git config -l -z (8 ms)',
			'[2026-08-23 10:00:00.200] > git config -l -z (11 ms)',
			'[2026-08-23 10:00:01.000] The Rust engine could not answer countCommitsBefore (Unsupported: Custom branch glob patterns are not resolved by the engine); falling back to the git CLI.',
			'[2026-08-23 10:00:01.100] > git rev-list --count --glob=refs/heads/** ^abc (25 ms)',
			'[2026-08-23 10:00:02.000] The Rust engine could not answer countCommitsBefore (Unsupported: Commits mentioned by reflogs are not counted by the engine); falling back to the git CLI.',
			'[2026-08-23 10:00:03.000] ERROR: Something went wrong',
			'[2026-08-23 10:00:04.000] ERROR: Something went wrong',
			'[2026-08-23 10:00:05.000] a line that is neither a command nor an error'
		];
		fs.writeFileSync(logFile, lines.join('\n') + '\n');
	});

	after(() => {
		fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
	});

	it('summarises spawns, fallbacks and errors', () => {
		const summary = JSON.parse(runNode('analyze-log.mjs', [logFile, '--json']));

		assert.equal(summary.lines, 9);
		assert.equal(summary.firstTimestamp, '2026-08-23 10:00:00.000');
		assert.equal(summary.lastTimestamp, '2026-08-23 10:00:05.000');

		assert.equal(summary.spawns.count, 4);
		assert.equal(summary.spawns.totalMs, 86);
		assert.equal(summary.spawns.worstMs, 42);
		assert.equal(summary.spawns.worstLine, 'git log');
		assert.equal(summary.spawns.byCommand['git config'].count, 2);
		assert.equal(summary.spawns.byCommand['git config'].totalMs, 19);
		assert.equal(summary.spawns.byCommand['git rev-list'].worstMs, 25);
		assert.equal(summary.spawns.byCommand['git log'].count, 1);

		assert.equal(summary.fallbacks.count, 2);
		assert.deepEqual(summary.fallbacks.byMethod, { countCommitsBefore: 2 });

		assert.equal(summary.errors.count, 2);
		assert.deepEqual(summary.errors.byMessage, { 'Something went wrong': 2 });
	});

	it('prints a human-readable report', () => {
		const report = runNode('analyze-log.mjs', [logFile]);
		assert.match(report, /Git spawns by subcommand/);
		assert.match(report, /git rev-list/);
		assert.match(report, /Engine → CLI fallbacks/);
		assert.match(report, /countCommitsBefore\s+2/);
		assert.match(report, /Errors/);
	});
});

describe('the source packager', () => {
	/**
	 * Build a minimal extension layout (out/ + src/askpass/, everything the packager touches) in a
	 * directory of its own and run scripts/package-src.js there, returning the rewritten files.
	 */
	function runPackager(files) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-rs-pack-'));
		try {
			fs.mkdirSync(path.join(dir, 'out', 'askpass'), { recursive: true });
			fs.mkdirSync(path.join(dir, 'src', 'askpass'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'src', 'askpass', 'askpass.sh'), '#!/bin/sh\n');
			for (const [name, content] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, 'out', name), content);
				fs.writeFileSync(path.join(dir, 'out', name + '.map'), '{"version":3,"mappings":"AAAA"}');
			}
			const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'package-src.js')], { encoding: 'utf8', cwd: dir });
			assert.equal(result.status, 0, result.stdout + result.stderr);
			const packaged = {};
			for (const name of Object.keys(files)) {
				packaged[name] = fs.readFileSync(path.join(dir, 'out', name), 'utf8');
				packaged[name + '.map'] = JSON.parse(fs.readFileSync(path.join(dir, 'out', name + '.map'), 'utf8'));
			}
			return packaged;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	it('rewrites only the code require("fs"), never occurrences inside literals, templates or comments', () => {
		// Compiled-module shape, with the interesting hazard inline: the embedded source of a
		// temporary editor script carries its own require("fs"), which must survive verbatim
		// because the standalone script runs under plain Node, without this bundle's helper.
		const source = [
			'"use strict";',
			'Object.defineProperty(exports, "__esModule", { value: true });',
			'const fs = require("fs");',
			"const seqEditorSource = 'const fs=require(\"fs\");const hash=process.argv[2];';",
			'const name = `gg-${Date.now()}-${\'require("fs")\'}.js`;',
			'// a comment mentioning require("fs") stays as it is',
			'const quoteRegex = /["\']/; // a regex with quotes must not be mistaken for a string',
			'const later = require("fs");',
			'exports.x = seqEditorSource.length + name.length + quoteRegex.source.length + later.constants.F_OK;',
			''
		].join('\n');

		const packaged = runPackager({ 'editorScripts.js': source });
		const rewritten = packaged['editorScripts.js'];

		// The two real imports are rewritten and the helper they now depend on is injected
		assert.match(rewritten, /const fs = requireWithFallback\("original-fs", "fs"\);/);
		assert.match(rewritten, /const later = requireWithFallback\("original-fs", "fs"\);/);
		assert.match(rewritten, /function requireWithFallback\(electronModule, nodeModule\)/);
		// The sourcemap gains a leading unmapped line for the injected helper
		assert.ok(packaged['editorScripts.js.map'].mappings.startsWith(';'));
		// Everything that was not code keeps its require("fs") exactly where it was
		assert.ok(rewritten.includes("const seqEditorSource = 'const fs=require(\"fs\");const hash=process.argv[2];';"));
		assert.ok(rewritten.includes('const name = `gg-${Date.now()}-${\'require("fs")\'}.js`;'));
		assert.ok(rewritten.includes('// a comment mentioning require("fs") stays as it is'));
		assert.ok(rewritten.includes('const quoteRegex = /[\"\']/;'));
		// The result must still be valid JavaScript
		const check = spawnSync(process.execPath, ['--check'], { input: rewritten, encoding: 'utf8' });
		assert.equal(check.status, 0, check.stderr);
	});

	it('leaves a file whose only require("fs") lives inside a string, and its map, untouched', () => {
		const source = '"use strict";\nconst embedded = \'const fs=require("fs");\';\nexports.x = embedded;\n';

		const packaged = runPackager({ 'embeddedOnly.js': source });

		assert.equal(packaged['embeddedOnly.js'], source);
		assert.equal(packaged['embeddedOnly.js.map'].mappings, 'AAAA');
	});
});

// The benchmark runner and the shipped-backend comparison moved out of the legacy tree
// (task 3.6/P2): scripts/bench.mjs is superseded by test/perf/p2-host.mjs, and the
// engine-vs-CLI parity question is owned by the reader contract suite
// (test/integration/reader) plus the Rust git_parity tests.

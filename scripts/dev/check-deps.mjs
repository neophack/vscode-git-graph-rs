/**
 * The dependency-rule gate behind `npm run lint:deps`. It fails in two cases:
 *
 *   - a violation that is not in docs/depcruise-baseline.json (the plain depcruise run, which
 *     neutralizes only the baselined entries through options.knownViolations);
 *   - a baselined violation that no longer occurs. The baseline may only shrink, and a stale
 *     entry would let the same violation come back unnoticed. The check regenerates the
 *     baseline in shrink-only mode into a temp file and compares it with the checked-in one.
 *
 * `--fix` writes the shrunk baseline back instead of failing on stale entries.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const baselinePath = path.join(root, 'docs', 'depcruise-baseline.json');
const fix = process.argv.includes('--fix');

function depcruise(args, stdio) {
	return spawnSync(process.execPath, [cli, 'src', '--config', '.dependency-cruiser.cjs', ...args], { cwd: root, stdio, encoding: 'utf8' });
}

const plain = depcruise([], 'inherit');
if (plain.status !== 0) process.exit(plain.status === null ? 1 : plain.status);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depcruise-'));
const shrunkPath = path.join(tempDir, 'baseline.json');
try {
	fs.copyFileSync(baselinePath, shrunkPath);
	const shrink = depcruise(['--baseline', shrunkPath, '--baseline-mode', 'shrink-only'], 'pipe');
	if (shrink.status !== 0) {
		process.stderr.write(shrink.stdout + shrink.stderr);
		process.exit(1);
	}
	const key = (violation) => JSON.stringify([violation.rule.name, violation.from, violation.to, violation.cycle || null]);
	const shrunk = new Set(JSON.parse(fs.readFileSync(shrunkPath, 'utf8')).map(key));
	const stale = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).filter((violation) => !shrunk.has(key(violation)));
	if (stale.length === 0) {
		console.log('depcruise baseline: no stale entries.');
	} else if (fix) {
		fs.copyFileSync(shrunkPath, baselinePath);
		console.log(`depcruise baseline: removed ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}.`);
	} else {
		console.error(`depcruise baseline: ${stale.length} entr${stale.length === 1 ? 'y no longer occurs' : 'ies no longer occur'}:`);
		for (const violation of stale) console.error(`  ${violation.rule.name}: ${violation.from} -> ${violation.to}`);
		console.error('Remove them with `npm run lint:deps -- --fix` and commit docs/depcruise-baseline.json.');
		process.exit(1);
	}
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}

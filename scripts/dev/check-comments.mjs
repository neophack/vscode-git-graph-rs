/**
 * The comments gate (OPTIMIZATION-PLAN A7): production sources describe the PRESENT, not the
 * plan's task numbers. The history of a change is in git and the decisions are in the ADRs —
 * a comment citing either goes stale the moment the code moves on without it.
 *
 * Rejected in src/** (TypeScript and CSS) and native/** (Rust):
 *   - `task 4.6` style task/phase numbers of the refactoring plans
 *   - `REFACTOR-PLAN` / `OPTIMIZATION-PLAN` citations, however phrased
 *   - `DataSource` (the deleted god module; comments name what the code IS now)
 *   - `§3.8.1` style plan-section markers (also matched without a plan name)
 *
 * Allowed: `ADR-NNNN` references (the sanctioned way to cite a decision), the frozen legacy/
 * directory itself (outside both trees), generated files (their sources are cleaned where they
 * live), and the Rust integration tests under native/core/tests/ (exempt here as in the size
 * gate). Deleting a citation must keep the technical fact it qualified — rewrite, don't strip.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The scanned trees and the file extensions each covers. */
const TREES = [
	{ dir: path.join(root, 'src'), extensions: ['.ts', '.css'] },
	{ dir: path.join(root, 'native'), extensions: ['.rs'] }
];

/** Paths whose bytes are generated (cleaned at their source, not here). */
const GENERATED = ['src/shared/engine', 'src/webview/common/i18n/subset.generated.ts'];

/** The Rust integration tests — exempt here as the size gate exempts them. */
const EXEMPT = ['native/core/tests'];

const PATTERNS = [
	{ re: /\btask\s+\d+\.\d+/i, what: 'plan task number' },
	{ re: /REFACTOR-PLAN/, what: 'REFACTOR-PLAN citation' },
	{ re: /OPTIMIZATION-PLAN/, what: 'OPTIMIZATION-PLAN citation' },
	{ re: /\bDataSource\b/, what: 'DataSource (deleted module)' },
	{ re: /§\s*\d/, what: 'plan section marker' }
];

/** The scopes passed as argv narrow the walk (repo-relative, forward slashes); default: all. */
const scopes = process.argv.slice(2).map((s) => s.replace(/\\/g, '/'));
const inScope = (rel) => scopes.length === 0 || scopes.some((s) => rel === s || rel.startsWith(s + '/'));
const isExempt = (rel) => GENERATED.some((g) => rel === g || rel.startsWith(g + '/'))
	|| EXEMPT.some((e) => rel === e || rel.startsWith(e + '/'));

const files = [];
const walk = (dir, extensions) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) { walk(abs, extensions); continue; }
		if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
		const rel = path.relative(root, abs).replace(/\\/g, '/');
		if (inScope(rel) && !isExempt(rel)) files.push({ abs, rel });
	}
};
for (const { dir, extensions } of TREES) walk(dir, extensions);

let failures = 0;
for (const { abs, rel } of files) {
	const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
	lines.forEach((line, i) => {
		for (const { re, what } of PATTERNS) {
			if (re.test(line)) {
				failures++;
				process.stdout.write(`${rel}:${i + 1}: ${what}: ${line.trim()}\n`);
			}
		}
	});
}

if (failures > 0) {
	process.stderr.write(`\ncheck-comments: ${failures} stale-history reference(s). Rewrite them to describe the present (facts stay, citations go).\n`);
	process.exit(1);
}
process.stdout.write(`check-comments: ${files.length} files describe the present.\n`);

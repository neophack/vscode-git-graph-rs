/**
 * The 600-line limit for the Rust engine's sources (REFACTOR-PLAN §11 DoD #3), the counterpart of
 * ESLint's max-lines rule for TypeScript. Integration tests under native/core/tests/ are exempt.
 *
 * KNOWN lists the files that were over the limit when the gate arrived, at the size they had then.
 * The list may only shrink: a known file may not grow, and an entry fails once its file is back
 * under the limit (delete the entry in the PR that splits the file).
 *
 * The second gate below is the shipped-artifact size budget (OPTIMIZATION-PLAN §4 V4): the total
 * VSIX size and every per-platform engine binary are held at their recorded baselines plus a 2%
 * growth allowance, so a regression like the dead 103 KB vendored markdown-it cannot land quietly.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_LINES = 600;
const KNOWN = {};

// Tracked AND untracked-but-not-ignored files: a brand-new file is exactly when the gate
// must speak (an uncommitted 700-line file slipped through while only ls-files fed the list).
const gitLists = [
	spawnSync('git', ['ls-files', '--', 'native/*.rs'], { cwd: root, encoding: 'utf8' }),
	spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'native/*.rs'], { cwd: root, encoding: 'utf8' })
];
for (const listed of gitLists) {
	if (listed.status !== 0) {
		process.stderr.write(listed.stderr);
		process.exit(1);
	}
}
const files = [...new Set(gitLists.flatMap((listed) => listed.stdout.split('\n')))]
	.filter((file) => file !== '' && !file.startsWith('native/core/tests/'));

const problems = [];
for (const file of files) {
	const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n').length - 1;
	const known = KNOWN[file];
	if (known === undefined) {
		if (lines > MAX_LINES) problems.push(`${file}: ${lines} lines (limit ${MAX_LINES})`);
	} else if (lines <= MAX_LINES) {
		problems.push(`${file}: ${lines} lines, now within the limit - remove it from KNOWN in scripts/dev/check-file-size.mjs`);
	} else if (lines > known) {
		problems.push(`${file}: ${lines} lines, grew past its known ${known} - split it instead`);
	}
}
for (const file of Object.keys(KNOWN)) {
	if (!files.includes(file)) problems.push(`${file}: no longer exists - remove it from KNOWN in scripts/dev/check-file-size.mjs`);
}

/* ------------------------------------------- shipped-artifact size budget (V4) */

/**
 * The recorded baselines of the artifacts the extension ships, in exact bytes. A present artifact
 * may not exceed its baseline by more than 2%: the allowance absorbs build nondeterminism while a
 * real regression (a stray dependency, an unminified bundle, a binary that grew) fails this gate.
 *
 * The rows are recorded measurements, not targets: lower a row in the PR that shrinks an artifact
 * - raising one is a deliberate, reviewed act. The VSIX row is keyed by pattern because vsce names
 * it after package.json#version; the newest match at the repository root is the one measured. A
 * platform's .node binary gets its own row when a build of it is first at hand (CI's matrix
 * produces one per directory under native/); a binary found WITHOUT a row fails so the platform
 * is budgeted, not silently skipped.
 */
const GROWTH_ALLOWANCE = 1.02;
const SIZE_BASELINES = {
	'git-graph-rs-*.vsix': 3043328,
	'native/win32-x64-msvc/git-graph.node': 5948416
};

/**
 * Collect the shipped artifacts this tree actually has: the newest universal VSIX at the root and
 * every native/<platform>/git-graph.node. Both are gitignored build outputs, so their absence is
 * reported as "not measured", never as a pass or a failure.
 */
function shippedArtifacts() {
	const found = [];
	const vsix = fs.readdirSync(root)
		.filter((name) => /^git-graph-rs-.*\.vsix$/.test(name))
		.map((name) => ({ name, mtime: fs.statSync(path.join(root, name)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)[0];
	if (vsix !== undefined) found.push({ key: 'git-graph-rs-*.vsix', file: path.join(root, vsix.name), label: vsix.name });
	const nativeDir = path.join(root, 'native');
	if (fs.existsSync(nativeDir)) {
		for (const entry of fs.readdirSync(nativeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory()) continue;
			const relative = `native/${entry.name}/git-graph.node`;
			const full = path.join(root, relative);
			if (fs.existsSync(full)) found.push({ key: relative, file: full, label: relative });
		}
	}
	return found;
}

const sizeNotes = [];
for (const artifact of shippedArtifacts()) {
	const bytes = fs.statSync(artifact.file).size;
	const baseline = SIZE_BASELINES[artifact.key];
	if (baseline === undefined) {
		problems.push(`${artifact.label}: ${bytes} B with no size baseline - add a SIZE_BASELINES row in scripts/dev/check-file-size.mjs`);
		continue;
	}
	if (bytes > Math.round(baseline * GROWTH_ALLOWANCE)) {
		problems.push(`${artifact.label}: ${bytes} B exceeds its ${baseline} B baseline by more than ${Math.round((GROWTH_ALLOWANCE - 1) * 100)}% - shrink it, or raise the baseline deliberately`);
	}
	sizeNotes.push(`${artifact.label}: ${bytes} B (baseline ${baseline} B)`);
}

if (problems.length > 0) {
	console.error('Rust file size / shipped-artifact size:');
	for (const problem of problems) console.error('  ' + problem);
	process.exit(1);
}
console.log(`Rust file size: ${files.length} files within the limit (${Object.keys(KNOWN).length} known exceptions).`);
console.log(sizeNotes.length > 0
	? `Shipped-artifact size: ${sizeNotes.length} within baseline + 2% (${sizeNotes.join('; ')}).`
	: 'Shipped-artifact size: nothing to measure (no VSIX at the root, no native/*/git-graph.node).');

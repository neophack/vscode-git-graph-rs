/**
 * The 600-line limit for the Rust engine's sources (REFACTOR-PLAN §11 DoD #3), the counterpart of
 * ESLint's max-lines rule for TypeScript. Integration tests under native/core/tests/ are exempt.
 *
 * KNOWN lists the files that were over the limit when the gate arrived, at the size they had then.
 * The list may only shrink: a known file may not grow, and an entry fails once its file is back
 * under the limit (delete the entry in the PR that splits the file).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_LINES = 600;
const KNOWN = {
	'native/core/src/read/gerrit.rs': 746,
	'native/core/src/read/log.rs': 872
};

const listed = spawnSync('git', ['ls-files', '--', 'native/*.rs'], { cwd: root, encoding: 'utf8' });
if (listed.status !== 0) {
	process.stderr.write(listed.stderr);
	process.exit(1);
}
const files = listed.stdout.split('\n').filter((file) => file !== '' && !file.startsWith('native/core/tests/'));

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

if (problems.length > 0) {
	console.error('Rust file size:');
	for (const problem of problems) console.error('  ' + problem);
	process.exit(1);
}
console.log(`Rust file size: ${files.length} files within the limit (${Object.keys(KNOWN).length} known exceptions).`);

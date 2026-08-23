/**
 * Run the Node-side tests through `node --test` with an explicit file list.
 *
 * The list is expanded here rather than in the npm script because `--test` only accepts glob
 * patterns on Node >= 21 (CI runs Node 20, where a quoted pattern is just a path it cannot find),
 * while directory arguments stopped being searched on newer Node (where they must be globs).
 * Plain file paths work on every Node the project supports, so that is what gets passed.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests');

const testFiles = fs.readdirSync(testsDirectory, { recursive: true })
	.filter((entry) => entry.endsWith('.test.mjs'))
	.map((entry) => path.join(testsDirectory, entry))
	.sort();
if (testFiles.length === 0) {
	console.error(`No *.test.mjs files found under ${testsDirectory}`);
	process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);

/**
 * Forwarder to the CommonJS runtime smoke (test/compat/runtime-smoke.cjs), so the documented
 * invocation `node test/compat/runtime-smoke.mjs` also works on modern Node.
 *
 * Node 10.11.0 and 12.4.0 - the two old versions the CI matrix
 * (.github/workflows/native-build.yml) runs the smoke on - cannot parse ES modules, so the
 * matrix runs the .cjs entry directly; keep that file the single place the smoke itself lives.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const smoke = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-smoke.cjs');
const result = spawnSync(process.execPath, [smoke], { stdio: 'inherit' });
process.exit(result.status ?? 1);

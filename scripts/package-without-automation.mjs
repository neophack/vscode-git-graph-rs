/**
 * Package the DEFAULT build of the extension (what CI and the release ship): the
 * automation-testing capability (the in-page shim, the suite runner and the Run Automation
 * Test button) is absent. The dist/ bundle is built FIRST with the compile-time switch off
 * (task 6.2): its __AUTOMATION__ define eliminates the automation requires, so the VSIX's
 * dist/extension.js carries no automation code. Since task 1.4 (main -> ./dist/extension.js,
 * .vscodeignore allowlist) nothing is moved out of the working tree: the variant's files
 * (dist/automation/, resources/automation/, out/automation/) are simply never re-included, so
 * the default VSIX is automation-free statically.
 */

import { buildDist, runVsce } from './automation-packaging.mjs';

buildDist(false);
await runVsce(['package', '--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid']);

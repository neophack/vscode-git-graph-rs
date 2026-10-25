/**
 * Package the DEFAULT build of the extension (what the original bats and CI ship): the
 * automation-testing capability (the in-page shim, the suite runner and the Run Automation
 * Test button) is absent. The dist/ bundle is built FIRST with the compile-time switch off
 * (task 6.2): its __AUTOMATION__ define eliminates the automation requires, so the VSIX's
 * dist/extension.js carries no automation code. The out/ half of the variant is still the
 * v1.0 file substitution (out/extension.js, which `main` points at, loads the modules when
 * present): the automation directories are moved out of the working tree for the vsce run
 * and restored afterwards — see scripts/automation-packaging.mjs for why that half remains.
 */

import { buildDist, runVsce, withAutomationExcluded } from './automation-packaging.mjs';

buildDist(false);
await withAutomationExcluded(() => runVsce(['package', '--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid']));

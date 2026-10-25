/**
 * Package the AUTOMATION build (the build-and-install.bat automation chain): the extension
 * ships WITH the automation-testing capability. The dist/ bundle is built FIRST in the
 * automation mode (task 6.2): __AUTOMATION__ is defined truthy and dist/automation/extension.js
 * bundles the whole subsystem in — the artifact the E2E story (plan tasks 0.6/1.10) runs
 * against. Since task 1.4 the variant packages through the same dist pipeline as the default
 * build: withAutomationContributions flips package.json's `main` to the automation bundle,
 * swaps .vscodeignore's default-bundle entries for the variant's (dist/automation/, the
 * resources/automation/ shim) and patches in the package.json contributions (Run Automation
 * Test command + editor-title button, nls titles) for the vsce run, then restores the
 * originals.
 */

import { buildDist, runVsce, withAutomationContributions } from './automation-packaging.mjs';

buildDist(true);
await withAutomationContributions(() => runVsce(['package', '--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid']));

/**
 * Package the AUTOMATION build (the build-and-install.bat automation chain): the extension
 * ships WITH the automation-testing capability. The dist/ bundle is built FIRST in the
 * automation mode (task 6.2): __AUTOMATION__ is defined truthy and dist/automation/extension.js
 * bundles the whole subsystem in — the artifact the E2E story (plan tasks 0.6/1.10) runs
 * against. The out/ tree keeps its modules in place (out/extension.js loads them when
 * present), and the package.json contributions (Run Automation Test command + editor-title
 * button, nls titles) are patched in for the vsce run, then the originals are restored.
 */

import { buildDist, runVsce, withAutomationContributions } from './automation-packaging.mjs';

buildDist(true);
await withAutomationContributions(() => runVsce(['package', '--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid']));

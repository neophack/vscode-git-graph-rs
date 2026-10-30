/**
 * Package the AUTOMATION build (the build-and-install.bat automation chain): the extension
 * ships WITH the automation-testing capability — the modules stay in place and the package.json
 * contributions (Run Automation Test command + editor-title button, nls titles) are patched in
 * for the vsce run, then the originals are restored.
 */

import { runVsce, withAutomationContributions } from './automation-packaging.mjs';

// --no-dependencies: same reason as package-without-automation.mjs.
await withAutomationContributions(() => runVsce(['package', '--no-dependencies', '--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid']));

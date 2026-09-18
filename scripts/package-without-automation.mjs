/**
 * Package the DEFAULT build of the extension (what the original bats and CI ship): the
 * automation-testing capability (the TCP server, the in-page shim, the suite runner and the
 * Run Automation Test button) is moved out of the working tree for the vsce run and restored
 * afterwards. The extension loads fine without it: extension.ts and commands.ts gate their
 * requires, and the view page tolerates the shim's absence.
 */

import { runVsce, withAutomationExcluded } from './automation-packaging.mjs';

await withAutomationExcluded(() => runVsce(['package', '--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid']));

/**
 * Package the DEFAULT build of the extension (what the original bats and CI ship): the
 * automation-testing capability (the TCP server, the in-page shim, the suite runner and the
 * Run Automation Test button) is moved out of the working tree for the vsce run and restored
 * afterwards. The extension loads fine without it: extension.ts and commands.ts gate their
 * requires, and the view page tolerates the shim's absence.
 */

import { runVsce, withAutomationExcluded } from './automation-packaging.mjs';

// --no-dependencies: node_modules/** is vscodeignored (the package is self-contained), so vsce's
// npm dependency detection is dead weight that fails packaging whenever the local npm tree is
// merely untidy (e.g. extraneous packages make `npm list` exit nonzero).
await withAutomationExcluded(() => runVsce(['package', '--no-dependencies', '--baseContentUrl', 'https://example.invalid', '--baseImagesUrl', 'https://example.invalid']));

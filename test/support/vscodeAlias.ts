/**
 * The `vscode` module for every migrated test that does not install its own `vi.mock`:
 * vitest.config.ts aliases the specifier `vscode` to this file. This is the Vitest form of the
 * legacy runner's process-wide `Module._load` hook (tests/vscodeStub.mjs): one mutable,
 * default-answering singleton per test file (Vitest isolates module registries per file, so the
 * singleton never leaks between files — the same guarantee the old process-per-file runner gave).
 *
 * The members are exported individually so `import * as vscode from 'vscode'` sees them; each is
 * the live member object of the shared stub, so a harness (see realPipeline.ts) can re-point
 * properties in place between boots. Files that need a wholly different fake build their own
 * with createVscodeState() from ./fakeVscode and install it through `vi.mock('vscode', ...)`,
 * which takes precedence over the alias.
 */

import { createVscodeState, vscodeMockOf } from './fakeVscode';

export const vscodeState = createVscodeState();

const stub: any = vscodeMockOf(vscodeState);

export const Uri = stub.Uri;
export const EventEmitter = stub.EventEmitter;
export const RelativePattern = stub.RelativePattern;
export const ViewColumn = stub.ViewColumn;
export const ConfigurationTarget = stub.ConfigurationTarget;
export const StatusBarAlignment = stub.StatusBarAlignment;
export const ProgressLocation = stub.ProgressLocation;
export const env = stub.env;
export const window = stub.window;
export const workspace = stub.workspace;
export const commands = stub.commands;
export const extensions = stub.extensions;
export const version = vscodeState.version;

export default stub;

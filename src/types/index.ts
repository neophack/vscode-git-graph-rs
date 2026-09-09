/**
 * Barrel: every type this extension shares between the extension host and the webview, split by
 * domain into `./git` (the Git object model), `./gerrit` and `./pullRequest` (the integrations),
 * `./repoState` (the persisted repository state), `./webview` (view & Extension Setting types),
 * `./messages` (the request/response message protocol) and `./util` (generic type helpers), and
 * re-exported here so every existing `from './types'` / `from '../types'` import keeps working
 * unchanged (the module id resolves to this directory's index).
 *
 * Cross-module imports inside this directory are `import type` only: these modules contain no
 * runtime code besides const enums, and that constraint is what keeps the module graph (which is
 * circular at the type level, e.g. repoState <-> webview) from ever becoming a runtime cycle.
 */
export * from './git';
export * from './gerrit';
export * from './pullRequest';
export * from './repoState';
export * from './webview';
export * from './messages';
export * from './util';

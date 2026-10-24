/**
 * The webview's single seam to the host↔webview protocol and domain types.
 *
 * The types still live in the v1.0 host tree (src/types), which the extension host compiles
 * against. Every webview module imports them from here, so when REFACTOR-PLAN task 4.1 moves the
 * protocol to src/shared/protocol only this re-export changes (and the dependency rule
 * "webview/** → webview/**, shared/**" holds everywhere else already). The module is type-only
 * apart from the protocol's const enums, which esbuild inlines.
 */

export * from '../../types/index';

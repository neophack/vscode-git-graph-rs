/**
 * The Git backend interface, and the native implementation of it.
 *
 * This is the seam the rewrite is built around. The extension talks to `GitBackend` and nothing
 * else; which implementation is behind it — the Rust engine or the `git` command line — is chosen
 * once, at startup, by `backendIndex.ts`. That makes the migration incremental: a capability the
 * engine does not have yet is answered by the CLI without the calling code knowing.
 *
 * The module is the stable import surface of the read path: the backend contract lives in
 * ./backend.ts (the interface the fallback, CLI and native backends implement), the Rust-engine
 * adapter in ./nativeBackend.ts, and this file re-exports both so importers keep their paths.
 */

export type { GitBackend } from './backend';
export { NativeBackend, issueRequestId, startCancellableRequest } from './nativeBackend';
export type { CancellableRequest } from './nativeBackend';

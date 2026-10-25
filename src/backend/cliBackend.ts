/**
 * The `git` CLI reader, behind the same interface as the Rust engine.
 *
 * The implementation lives in `src/extension/git/read/cli/` (REFACTOR-PLAN task 3.5), split by
 * theme and assembled into the `CliBackend` class there. This module keeps the historical import
 * path — `dataSource.ts` and the tests import the reader from `./backend` — re-exporting the
 * class unchanged.
 */

export { CliBackend } from '../extension/git/read/cli';

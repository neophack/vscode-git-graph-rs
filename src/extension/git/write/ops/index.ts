/**
 * The write-operation registry: every pure op of the legacy `DataSource` write methods, grouped
 * by theme. Each function builds a `WriteOp` from plain parameters — no process, no
 * configuration, no vscode — so the argv of every option branch is unit-testable as data.
 */

export * from './op';

export * from './branches';
export * from './commits';
export * from './mergeRebase';
export * from './remotes';
export * from './stash';
export * from './tags';
export * from './worktrees';
export * from './config';
export * from './files';

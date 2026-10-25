/**
 * Compatibility shim (REFACTOR-PLAN Appendix A): the repository file watcher moved to
 * src/extension/repos/repoFileWatcher.ts. Kept so existing importers keep compiling unchanged;
 * delete after the last caller migrates to the new path.
 */
export { RepoFileWatcher } from './extension/repos/repoFileWatcher';

/**
 * Compatibility shim (REFACTOR-PLAN Appendix A): the repository manager moved to
 * src/extension/repos/ (split into repoManager, repoDiscovery and repoConfigFile). Kept so
 * existing importers keep compiling unchanged; delete after the last caller migrates.
 */
export { RepoManager } from './extension/repos/repoManager';
export type { RepoChangeEvent } from './extension/repos/repoManager';
export { ExternalRepoConfig } from './extension/repos/repoConfigFile';

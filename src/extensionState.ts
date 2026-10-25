/**
 * Compatibility shim (REFACTOR-PLAN Appendix A): the extension state moved to
 * src/extension/platform/storage.ts (unified with the Storage seam). Kept so existing
 * importers keep compiling unchanged; delete after the last caller migrates to the new path.
 */
export { DEFAULT_GIT_GRAPH_VIEW_GLOBAL_STATE, DEFAULT_REPO_STATE, ExtensionState } from './extension/platform/storage';
export type { CodeReviewData, CodeReviews, WrittenGlobalAuthor } from './extension/platform/storage';

/**
 * Compatibility shim (REFACTOR-PLAN Appendix A): the logger moved to
 * src/extension/platform/logger.ts. Kept so existing importers keep compiling unchanged; delete
 * after the last caller migrates to the new path.
 */
export { Logger } from './extension/platform/logger';

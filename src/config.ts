/**
 * Compatibility shim (REFACTOR-PLAN Appendix A): the configuration reader moved to
 * src/extension/platform/config.ts (unified with the config-snapshot module). Kept so existing
 * importers keep compiling unchanged; delete after the last caller migrates to the new path.
 */
export { getConfig } from './extension/platform/config';

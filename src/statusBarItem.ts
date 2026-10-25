/**
 * Compatibility shim (REFACTOR-PLAN §3.3): the status bar item moved to
 * src/extension/statusBar.ts. Kept so existing importers keep compiling unchanged; delete after
 * the last caller migrates to the new path.
 */
export { StatusBarItem } from './extension/statusBar';

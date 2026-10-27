/* Context menu actions: the menus of branches, commits, remote branches, stashes, tags and the
   uncommitted changes. One module per menu; this module is the chunk's single entry point (the
   view loads it on demand), re-exporting each menu's action builder. */

export { getBranchContextMenuActions } from './branchMenu';
export { getCommitContextMenuActions } from './commitMenu';
export { getRemoteBranchContextMenuActions } from './remoteBranchMenu';
export { getStashContextMenuActions } from './stashMenu';
export { getTagContextMenuActions } from './tagMenu';
export { getUncommittedChangesContextMenuActions } from './uncommittedMenu';

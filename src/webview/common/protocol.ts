/**
 * The webview's single seam to the host↔webview protocol and domain types.
 *
 * The types live in src/shared: the Git/model vocabulary under src/shared/model and the
 * request/response message protocol under src/shared/protocol (the split mirrors the host
 * handlers, e.g. loading/branches/commits).
 * Every webview module imports them from here, so only this re-export list changed; the
 * dependency rule "webview/** → webview/**, shared/**" holds everywhere else already. The
 * module is type-only apart from the protocol's const enums, which esbuild inlines.
 */

export * from '../../shared/model/git';
export * from '../../shared/model/gerrit';
export * from '../../shared/model/pullRequest';
export * from '../../shared/model/repoState';
export * from '../../shared/model/webview';
export * from '../../shared/model/util';
export * from '../../shared/protocol/messages';
export * from '../../shared/protocol/branches';
export * from '../../shared/protocol/codeReview';
export * from '../../shared/protocol/commitDetails';
export * from '../../shared/protocol/commits';
export * from '../../shared/protocol/files';
export * from '../../shared/protocol/gerrit';
export * from '../../shared/protocol/loading';
export * from '../../shared/protocol/misc';
export * from '../../shared/protocol/operations';
export * from '../../shared/protocol/remotes';
export * from '../../shared/protocol/settings';
export * from '../../shared/protocol/stash';
export * from '../../shared/protocol/tags';
export * from '../../shared/protocol/worktrees';

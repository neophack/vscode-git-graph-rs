# What is missing, compared to the original extension

An inventory of `vscode-git-graph` (the TypeScript original, 26,500 lines) against
`vscode-git-graph-rs` (this project).

The short version: **this project is now a VS Code extension.** The webview and extension host
layer are ported over (with the Gerrit integration of the original deliberately removed), the
hot read paths go through the Rust engine, and everything else runs over the `git` CLI exactly
as the original did. What remains are the colder reads, the whole write path on the engine, and
a few behavioural deviations.

## 1. The read path

Eighteen methods on `GitBackend`, implemented natively *and* over the `git` CLI, and asserted to
agree with each other in `tests/backends.test.mjs`. `DataSource` delegates to the backend; on a
platform without the native addon every call lands on the CLI implementation instead.

| Capability | Original | Here |
|---|---|---|
| Repository discovery / root | `repoRoot` | ✅ `openRepository` |
| Branches, tags, remotes, stashes, HEAD | `getRepoInfo` | ✅ |
| A page of the graph | `getCommits` | ✅ |
| Refs on their own | `getRefs` (private) | ✅ |
| Commit details + file list | `getCommitDetails` | ✅ |
| Stash details | `getStashDetails` | ✅ |
| Uncommitted details | `getUncommittedDetails` | ✅ |
| Compare two commits | `getCommitComparison` | ✅ |
| Uncommitted change count | `getUncommittedChanges` | ✅ |
| Stash list | `getStashes` (private) | ✅ |
| Repository config (remotes, user, tools) | `getConfig` | ✅ engine for remotes/pushDefault/diff tools; branches/authors still via CLI |
| File contents at a revision | `getCommitFile` | ✅ (binary-safe) |
| Unified diff of one file | `getCommitFileDiff` | ✅ single-commit case via engine; arbitrary from/to still via CLI |

### Reads still engine-side pending

These work (they go through `DataSource`'s CLI implementation), but have no engine equivalent, so
they do not benefit from the resident-handle speedup:

`getCommitBodies`, `getCommitSubject`, `getCommitSummaries`, `searchHistory`, `getTagDetails`,
`getRemoteUrl`, `getNewPathOfRenamedFile`, `getSubmodules`, `getCurrentBranchUpstream`,
`countCommitsBefore`.

## 2. The write path — CLI only

All forty-one write operations work (they are the original's CLI implementations, ported with the
extension layer), but none are on `GitBackend`, so the engine does not serve them yet. Grouped by
the roadmap phase that would add them:

| Phase | Operations |
|---|---|
| 4 — Remote | `addRemote` `deleteRemote` `editRemote` `pruneRemote` `fetch` `pushBranch` `pushBranchToMultipleRemotes` `pushTag` `fetchIntoLocalBranch` `pullBranch` `trackRemoteTags` |
| 6 — Merge / cherry-pick / revert | `merge` `cherrypickCommit` `revertCommit` `dropCommit` |
| 7 — Stash | `applyStash` `popStash` `dropStash` `pushStash` `branchFromStash` |
| 8 — Rebase | `rebase` (interactive rebase does not exist in the original either) |
| Branches / tags | `checkoutBranch` `createBranch` `deleteBranch` `deleteRemoteBranch` `renameBranch` `addTag` `deleteTag` |
| Commit operations | `checkoutCommit` `resetToCommit` `undoLastCommit` `amendLastCommit` `editCommitMessage` `resetCurrentBranchToRemote` |
| Working tree | `cleanUntrackedFiles` `resetFileToRevision` |
| Other | `archive` `setConfigValue` `unsetConfigValue` `openExternalDirDiff` `openGitTerminal` |

## 3. The extension layer — ported, Gerrit removed

`web/` (the whole webview), `gitGraphView.ts`, `repoManager.ts`, `commands.ts`, `config.ts`,
`utils.ts`, `avatarManager.ts`, `extensionState.ts`, `comparisonView.ts`, `types.ts`,
`pullRequests.ts`, `diffDocProvider.ts`, `statusBarItem.ts`, `repoFileWatcher.ts`, `logger.ts`,
`askpass/*` and the `package.json` contributes block (14 commands, 90 settings) are ported and
compile clean, under the `git-graph-rs` prefix.

**Deliberately not ported:** the original's Gerrit integration (`gerrit.ts`,
`reviewStateTransfer.ts`, `web/gerritView.ts`, `web/gerritFormat.ts`, the `gerrit.*` settings,
and the Gerrit commands/menus/messages). The engine's `gerritRefs` / `showChangeRefs` ref-filter
parameters remain in the ABI but are always passed as disabled.

## 4. Behaviour differences in what *is* implemented

Documented in the README's "Known deviations from git":

| Area | Difference |
|---|---|
| Commit signatures | reported as present but unverified (status `E`), never as valid |
| Ordering | exact within a bounded window rather than over the whole history |
| Worktree line counts | a file modified but not staged has no `additions`/`deletions` when comparing an arbitrary revision against the working tree |
| Mailmap | the engine does not apply `.mailmap`; the original honours `useMailmap` |
| Reflog-mentioned commits | `includeCommitsMentionedByReflogs` is accepted but ignored by the engine |
| Custom branch glob patterns | `--glob=` branch entries are not understood by the engine's tip resolution |

## 5. Suggested order

1. ~~Make it an extension at all~~ — done.
2. ~~`getConfig`, `getCommitFile`, `getCommitFileDiff`~~ — done.
3. **The remaining reads** onto the engine, one capability at a time, always both backends so the
   cross-backend test keeps its meaning.
4. **The write path**, phase by phase, the same way.
5. **The deviations above**, which are small but user-visible.

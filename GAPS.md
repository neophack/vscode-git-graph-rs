# What is missing, compared to the original extension

An inventory of `vscode-git-graph` (the TypeScript original, 26,500 lines) against
`vscode-git-graph-rs` (this project).

The short version: **this project is now a VS Code extension.** The webview and extension host
layer are ported over (with the Gerrit integration of the original deliberately removed), every
repository read runs through the `GitBackend` interface with the Rust engine serving it (and the
`git` CLI answering wherever the engine does not reach), and the write operations run over the
`git` CLI exactly as the original did. What remains is the write path on the engine, and a few
behavioural deviations.

## 1. The read path

Thirty methods on `GitBackend`, implemented natively *and* over the `git` CLI, and asserted to
agree with each other in `tests/backends.test.mjs`. `DataSource` delegates to the backend for every
read; on a platform without the native addon every call lands on the CLI implementation instead.

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

None — every read `DataSource` offers is on both backends, including the repository discovery
behind the workspace scan, the settings panel's config and author lists, the remote names and
the checked-out branch. Three reads still spawn `git` directly at action time (never behind
`GitBackend`):

- `getCommitFileDiff`: only the commit↔its-parent case goes to the engine; an arbitrary from→to
  pair still spawns `git diff`.
- `areStagedChanges` (before committing a squash) and `getRemotesContainingCommit` (before
  pushing a tag).

Three argument shapes are *declined* by the engine with `Unsupported`, which the fallback
wrapper routes to the CLI automatically: `countCommitsBefore` with reflog tips, `--glob=`
patterns or an empty branch list, and `getConfigList` for a file carrying `include` directives.

## 2. The write path — CLI only (and the extension now runs without Git installed)

The engine serves every read, so the extension loads and works on a machine with no `git`
executable at all (`createBackend` then returns the engine alone; write operations report that
they need Git). Moving the writes onto the engine has a hard external limit: gix does not
implement `push` (and its fetch needs the network feature set), so a literal 100% is not
reachable today; everything else is a matter of the phased work below.

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
| Tag signatures | the same, and on both backends: moving `getTagDetails` behind `GitBackend` dropped the original's real `verify-tag`/gpg verification on the CLI path too |
| Ordering | exact within a bounded window rather than over the whole history |
| Worktree line counts | a file modified but not staged has no `additions`/`deletions` when comparing an arbitrary revision against the working tree |
| Unstaged renames | `getNewPathOfRenamedFile` follows committed renames exactly; a rename existing only in the working tree is not reassembled by the engine |
| Lightweight tags | the Tag Details dialogue hides the Tagger/Date row instead of showing an empty tagger and an invalid date (a deliberate improvement over the original) |
| Mailmap | the engine does not apply `.mailmap`; the original honours `useMailmap` |
| Reflog-mentioned commits | `includeCommitsMentionedByReflogs` is accepted but ignored by the engine's graph; `countCommitsBefore` declines it and the CLI answers |
| Custom branch glob patterns | `--glob=` branch entries are not understood by the engine's tip resolution (`countCommitsBefore` declines them; the graph skips them) |

## 5. Suggested order

1. ~~Make it an extension at all~~ — done.
2. ~~`getConfig`, `getCommitFile`, `getCommitFileDiff`~~ — done.
3. ~~The remaining reads onto the engine~~ — done, twice over: the on-demand reads, then the
   action-time ones (repository discovery, config/author lists, remote names, branch name).
   Every read is now on both backends, cross-backend tested.
4. **The write path**, phase by phase — the interface needs extending first, then both
   implementations, the same way the reads were done.
5. **The deviations above**, which are small but user-visible.

# Backend Split: What Runs on the Rust Engine (gix), What Runs on the git CLI

Every repository operation in the extension goes through `DataSource` (`src/dataSource.ts`).
It holds a `GitBackend` (created by `createBackend()` in `src/backend/index.ts`):

- **Rust engine** (`NativeBackend` → `native/win32-x64-msvc/git-graph.node` → `git-graph-core`,
  based on [gix]): reads the object database, refs and index directly, keeping the repository
  handle resident in memory — the fast half.
- **git CLI** (`CliBackend`): spawns a `git` subprocess per call — the other half, behaving
  exactly like the original extension.

The selection rule lives in `src/backend/index.ts`: **prefer the Rust engine**; only when the
engine raises an "ask someone else" error — "Not a repository" or "not implemented" — does the
code automatically fall back to the CLI (and log it). Genuine Git failures (bad revision,
corrupt object) do not fall back — rerunning them through the CLI would only fail again, a
little slower. On platforms without a prebuilt engine (or when the setting forces `git-cli`),
the whole extension runs on the CLI, matching the original behaviour.

To find out which backend is currently in use: `describeBackend()`; to compare both backends'
timings on the same repository: `node scripts/bench.mjs <repo-path>`.

## Operations served by the Rust engine (gix)

These `DataSource` methods turn each request into a single JSON call to the engine (the
`GitBackend` interface in `src/backend/api.ts` — 15 methods plus handle management):

| Feature (as the user sees it) | DataSource method | Engine implementation |
|---|---|---|
| Branch/tag/remote/stash/HEAD lists shown when the view opens | `getRepoInfo` | `graph.rs: repo_info` |
| Each page of the commit graph (three sort orders, filter by branch/author/path) | `getCommits` | `log.rs` + `graph.rs` |
| On-demand reads of refs (incl. remote-branch filtering) | (via `getRepoInfo`/`getCommits`) | `refs.rs: read_refs` |
| Commit details (file change list, rename detection, line counts) | `getCommitDetails` | `details.rs` + `diff.rs` |
| Stash entry details | `getStashDetails` | `details.rs: stash_details` |
| File list of the "Uncommitted Changes" row | `getUncommittedDetails` | `details.rs` + `status.rs` |
| Compare any two commits / compare with the working tree | `getCommitComparison` | `diff.rs: diff_commits` |
| Uncommitted count in the status bar | `getUncommittedChanges` | `status.rs: count_changes` |
| Stash list | (via `getRepoInfo`) | `stash.rs: read_stashes` |
| Repository config: remotes, user.name/email, push defaults, diff tool | `getConfig` (partially) | `config.rs: read_config` |
| Open a file's content at a given revision from the details view | `getCommitFile` | `blob.rs: commit_file` (binary-safe) |
| Unified diff of a single file | `getCommitFileDiff` (single-commit case) | `blob.rs: commit_file_diff` |
| Repository handle warm-up (when the view opens) | `openRepository` | `repository.rs: RepoManager` |

The engine's error classification is `GitErrorKind` in `src/backend/types.ts`; cross-backend
consistency is enforced by `tests/backends.test.mjs` — both backends must give identical
answers for the same repository, and any divergence is an engine bug.

## Operations served by the git CLI

The following features spawn a git subprocess on every call (`execFile`, with the Askpass
credential environment), matching the original extension's implementation:

**Read operations (not yet ported to the engine; see the "remaining reads" list in GAPS.md)**

| Feature | DataSource method |
|---|---|
| Search commit messages (Find component) | `searchHistory` |
| Fetch commit bodies on demand (inline body display) | `getCommitBodies` |
| Commit subject / multi-commit summaries (dialog titles, squash messages) | `getCommitSubject`, `getCommitSummaries` |
| Tag details and signatures | `getTagDetails` |
| Remote URL (PR provider links) | `getRemoteUrl` |
| Rename tracking (code review file tracking) | `getNewPathOfRenamedFile` |
| Submodule list | `getSubmodules` |
| Upstream of the current branch (push/pull defaults) | `getCurrentBranchUpstream` |
| Number of commits newer than the pinned commit | `countCommitsBefore` |
| Branch-level config and author list in `getConfig` | `getConfig` (hybrid: this part still goes to the CLI) |
| Single-file diff of an arbitrary from→to pair (comparison view) | `getCommitFileDiff` (hybrid: only the commit↔its-parent case goes to the engine) |

**All write operations (41)**: branches (`checkoutBranch`, `createBranch`, `deleteBranch`,
`renameBranch`, `deleteRemoteBranch`), tags (`addTag`, `deleteTag`), remotes
(`addRemote`, `editRemote`, `deleteRemote`, `pruneRemote`, `fetch`, `pullBranch`,
`pushBranch`, `pushBranchToMultipleRemotes`, `pushTag`, `fetchIntoLocalBranch`,
`trackRemoteTags`), history rewriting (`merge`, `rebase`, `cherrypickCommit`, `revertCommit`,
`dropCommit`, `resetToCommit`, `undoLastCommit`, `amendLastCommit`, `editCommitMessage`,
`resetCurrentBranchToRemote`, `checkoutCommit`), stashes (`pushStash`, `popStash`,
`applyStash`, `dropStash`, `branchFromStash`), working tree (`cleanUntrackedFiles`,
`resetFileToRevision`), misc (`archive`, `setConfigValue`, `unsetConfigValue`,
`openExternalDirDiff`, `openGitTerminal`, `runGitCommand*`).

## Why this split

- **Read hot paths first**: view loading (repoInfo + the first page of commits) is what the
  user actually waits for, and the engine is roughly 3.5× faster there (see the README).
  Rarely-used reads stay on the CLI and never affect the daily experience.
- **All writes stay on the CLI**: git's write paths have the subtlest behaviour (reflog,
  hooks, merge state files, …), so the engine's payoff is small while its risk is large.
  When porting a write path, follow the same rule: implement it on both sides + add a
  cross-backend comparison test.
- **Fallback is a feature, not a crutch**: capabilities the engine hasn't implemented are
  transparently routed to the CLI by `FallbackBackend`, invisible to the extension layer —
  this lets the engine grow one capability at a time.

## Known behaviour differences (engine vs git)

| Area | Difference |
|---|---|
| Commit signatures | The engine only reports "present, unverified" (status E) and performs no GPG verification; the CLI version verifies for real |
| Ordering | The engine is exact within a bounded window; whole-history ordering may differ from git |
| Working-tree line counts | Files with unstaged modifications get no additions/deletions in "any revision vs working tree" comparisons |
| mailmap | The engine does not apply `.mailmap` (the `useMailmap` setting has no effect on the engine path) |
| Commits mentioned by reflogs | The parameter is accepted but ignored by the engine |
| `--glob=` branch items | The engine's starting-point resolution does not recognise this form |

[gix]: https://github.com/GitoxideLabs/gitoxide

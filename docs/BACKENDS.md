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

To find out which backend is currently in use: the Settings widget's **Backend (this platform)**
section shows, per functional area, whether the Rust engine or the `git` CLI serves it on this
platform (and the engine's version, or that it is absent); `describeBackend()` answers the same
question in one string. To compare both backends' timings on the same repository:
`node scripts/bench.mjs <repo-path>` (the view load) or `node scripts/bench.mjs <repo-path> --all`
(every read operation, one table row each). While `git-graph-rs.enableLog` is on, spawned commands
are logged with their durations and fallbacks with their reasons; `node scripts/analyze-log.mjs
<logfile>` turns a session log into a summary of where the time went, which methods fell back to
the CLI, and what failed.

## Operations served by the Rust engine (gix)

These `DataSource` methods turn each request into a single JSON call to the engine (the
`GitBackend` interface in `src/backend/api.ts` — 30 methods plus handle management):

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
| Search commit messages (Find component) | `searchHistory` | `log.rs: search_history` |
| Fetch commit bodies on demand (inline body display) | `getCommitBodies` | `details.rs: commit_bodies` |
| Commit subject / multi-commit summaries (dialog titles, squash messages) | `getCommitSubject`, `getCommitSummaries` | `details.rs` |
| Tag details (tagger, message, signature presence) | `getTagDetails` | `details.rs: tag_details` |
| Remote URL (PR provider links) | `getRemoteUrl` | `config.rs: remote_url` |
| Rename tracking (code review file tracking) | `getNewPathOfRenamedFile` | `diff.rs: new_path_of_renamed_file` |
| Submodule list | `getSubmodules` | `config.rs: submodules` |
| Upstream of the current branch (push/pull defaults) | `getCurrentBranchUpstream` | `config.rs: current_branch_upstream` |
| Number of commits newer than the pinned commit | `countCommitsBefore` | `log.rs: count_commits_before` |
| Repository handle warm-up (when the view opens) | `openRepository` | `repository.rs: RepoManager` |

The engine's error classification is `GitErrorKind` in `src/backend/types.ts`; cross-backend
consistency is enforced by `tests/backends.test.mjs` — both backends must give identical
answers for the same repository, and any divergence is an engine bug.

## Operations served by the git CLI

The following features spawn a git subprocess on every call (`execFile`, with the Askpass
credential environment), matching the original extension's implementation:

**Read operations (everything that still spawns git)**

| Feature | DataSource method |
|---|---|
| Single-file diff of an arbitrary from→to pair (comparison view) | `getCommitFileDiff` (hybrid: only the commit↔its-parent case goes to the engine) |
| "Are changes staged?" (checked before committing a squash) | `areStagedChanges` (private) |
| Which remotes contain a commit (checked before pushing a tag) | `getRemotesContainingCommit` (private) |

The engine also *declines* three argument shapes, which `FallbackBackend` then routes here
automatically: `countCommitsBefore` with reflog tips or `--glob=` patterns or an empty branch
list, and `getConfigList` for a file carrying `include`/`includeIf` directives.

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
| Tag signatures | Both backends report "present, unverified" (status E); the CLI backend no longer shells out to `verify-tag`/gpg, matching what was already true of commit signatures on this port |
| Ordering | The engine is exact within a bounded window; whole-history ordering may differ from git |
| Working-tree line counts | Files with unstaged modifications get no additions/deletions in "any revision vs working tree" comparisons |
| Unstaged renames | `getNewPathOfRenamedFile` follows committed renames exactly; a rename that exists only in the working tree (file moved but never committed) is not reassembled by the engine |
| Lightweight tags | The Tag Details dialogue shows no Tagger/Date row (a lightweight tag has no tagger); the original showed an empty tagger and an invalid date |
| mailmap | The engine does not apply `.mailmap` (the `useMailmap` setting has no effect on the engine path) |
| Commits mentioned by reflogs | The engine declines the graph request and the CLI answers with `git log --reflog`; for `countCommitsBefore` the engine also declines and the CLI answers |
| `--glob=` branch items | The engine's starting-point resolution does not recognise this form (declined for `countCommitsBefore`, skipped in the graph) |

[gix]: https://github.com/GitoxideLabs/gitoxide

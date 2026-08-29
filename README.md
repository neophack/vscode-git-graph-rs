# Git Graph (Rust)

[![Visual Studio Marketplace version](https://vsmarketplacebadges.dev/version/neophack.git-graph-rs.svg)](https://marketplace.visualstudio.com/items?itemName=neophack.git-graph-rs)
[![Installs](https://vsmarketplacebadges.dev/installs/neophack.git-graph-rs.svg)](https://marketplace.visualstudio.com/items?itemName=neophack.git-graph-rs)
[![Build and test](https://github.com/neophack/vscode-git-graph-rs/actions/workflows/native-build.yml/badge.svg)](https://github.com/neophack/vscode-git-graph-rs/actions/workflows/native-build.yml)

A rewrite of the Git Graph VS Code extension with its Git backend in Rust, loaded
into the extension host as a Node-API addon through [napi-rs], reading repositories with [gix].

The original extension answered every question by spawning a `git` process and parsing its output.
This one reads the object database, the refs and the index directly, in-process, from a repository
handle that stays warm for the whole editor session.

**Install** it from the
[Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=neophack.git-graph-rs)
(search for "Git Graph RS"), or download the VSIX from
[GitHub Releases](https://github.com/neophack/vscode-git-graph-rs/releases) and install it with
`code --install-extension git-graph-rs-<version>.vsix`.

The source lives at [github.com/neophack/vscode-git-graph-rs](https://github.com/neophack/vscode-git-graph-rs);
bug reports, feature requests and questions go to
[the issue tracker](https://github.com/neophack/vscode-git-graph-rs/issues).

## What this fork adds

Beyond the Rust engine (below), these features are new relative to the original
[mhutchie/vscode-git-graph](https://github.com/mhutchie/vscode-git-graph):

- **A Gerrit integration, rebuilt.** Per-repository change-ref fetching (bounded by a configurable
  fetch limit, overridable per repository), a change badge on every commit carrying its
  change/patchset number and Code-Review/Verified scores, a structured review dialog with the full
  NoteDb event timeline and an "Open in Gerrit" button, and an open/merged/abandoned/WIP status
  filter that re-renders instantly from cached states. The NoteDb meta histories are parsed
  in-process by the engine — not one `git log` spawn per change. The remote is contacted only when
  the user asks (the Fetch button, enabling the integration, changing its fetch settings); every
  plain view load reads the locally cached refs and works offline.
- **Gerrit commands in the Source Control view**, each offered in English and Simplified Chinese:
  push the current branch for review to `refs/for/<branch>` (amending a Change-Id onto HEAD first,
  with the same construction Gerrit's commit-msg hook uses, and never amending a commit already
  pushed to a remote), and download & install the commit-msg hook from the Gerrit server.
- **Data-loss protection** on the write path's silent-loss corners — see
  [Data-loss protection](#data-loss-protection).
- **A Simplified Chinese interface** (`git-graph-rs.interfaceLanguage`: auto / English / 简体中文),
  covering the webview, the extension host messages and the Source Control menus, with the two
  language dictionaries held to key parity by a build-time check.
- **Instant first paint, progressive completion.** A view load renders the local branch and tag
  pills immediately from a local-only ref scan, merges the remote pills in place when the full scan
  arrives, and chains the "Uncommitted Changes" row and the Gerrit stages onto the same pipeline —
  no stage waits on a slower one. Commit details render their file list first and settle the
  `+N/-M` line counts progressively (rows in view, then background batches).
- **Binary file comparison** in the comparison view: a streaming hex view that byte-compares the
  matched equal suffix, and a picture mode that dyes differing pixels and reports PSNR.
- **Amend Last Commit** and **Reset Current Branch to Remote (soft)** commands in the Source
  Control view.
- **Runs without Git installed** — the whole read path is served in-process by the engine; write
  operations report that they need Git. Conversely, on a platform with no prebuilt engine binary
  the extension runs entirely over the `git` CLI.

## Status

This is a working VS Code extension: the webview and extension host layer are ported from the
original, and **every repository read** — the view load,
commit, stash and uncommitted details, comparisons, config, file contents and single-file diffs,
plus the on-demand reads behind the Find dialogue, the tag details, submodule and upstream
lookups, and the commit counting the view's jump-to-commit uses — is served by the Rust engine,
falling back to the `git` CLI wherever the engine does not reach.
The write path (checkout, merge, rebase and the rest) still goes through the `git` CLI, behind
the same interface, with the destructive corner of it guarded by [data-loss warnings](#data-loss-protection). See [GAPS.md](GAPS.md) and [Roadmap](#roadmap).

## Why it is faster

Measured on a repository with 709 commits, 187 tags and two packs — one **view load**, which is the
repository info plus the first page of 300 commits, the thing the user actually waits for:

| | per view load |
|---|---|
| `git` spawns + parse (what the original does) | ~350 ms |
| Rust engine | ~95 ms |

`node scripts/bench.mjs <repo-path> --tags` reproduces it. Four things account for the gap, each
found by measuring rather than by guessing:

1. **The repository stays open.** A `git` spawn re-reads the pack index files before doing any
   useful work, and a single view load makes several such calls. The engine opens a repository once
   and keeps its pack indexes and object cache resident.
   ([`repository.rs`](native/core/src/repository.rs))

2. **Refs are filtered by name before any object is read.** A ref the view is not showing costs a
   string comparison and nothing more, and remote-tracking refs are never peeled — peeling is an
   object lookup per ref, several times the cost of the scan itself. On a Gerrit remote whose
   `changes/` tree holds tens of thousands of refs, this is the difference between reading all of
   them and reading none. ([`refs.rs`](native/core/src/refs.rs))

3. **Revisions that are already hashes skip the revspec parser.** The tips of a view load come
   straight from the refs that were just read, so they are already full hashes; sending a few
   hundred of them through gix's revision *parser* rather than looking them up directly was, on
   its own, 4× the cost of the whole walk. ([`repository.rs`](native/core/src/repository.rs))

4. **One call crosses the boundary per request, not one per commit.** Results are serialised once
   in Rust and parsed once in JavaScript. Building JS objects property by property over Node-API
   would cost a call per field, and a page of a thousand commits has tens of thousands of them.
   ([`native/node/src/lib.rs`](native/node/src/lib.rs))

## Benchmarks: engine vs `git` CLI, by operation and repository size

Measured with `node scripts/bench.mjs <repo> --all` on three synthetic repositories of
increasing size, plus this repository itself (a real working tree with uncommitted changes).
Each repository is walked by both
backends through the same interface; the numbers are the median of 7 runs after a warm-up
(the engine's caches and the OS page cache are warm, so this measures steady-state
interaction, not the first cold open).

Environment: Windows 11, Intel i7-14650HX (16 cores), Node 24, git 2.50.1.

| Repository | Commits | Tags | Pack size |
|---|---|---|---|
| small | 100 | 10 | loose objects |
| medium | 1 000 | 100 | loose objects |
| large | 10 000 | 1 000 | ~6 MiB |

### This repository (3 commits, a real working tree with uncommitted changes)

| operation | git CLI | engine | speedup |
|---|---:|---:|---:|
| view load (repoInfo + first page) | 282.0 ms | 11.3 ms | **24.9×** |
| getRepoInfo | 124.3 ms | 1.1 ms | **108.7×** |
| getCommits (a page of the graph) | 142.9 ms | 12.0 ms | **11.9×** |
| getRefs | 81.4 ms | 0.9 ms | **90.0×** |
| getCommitDetails | 136.7 ms | 31.4 ms | **4.4×** |
| getCommitBodies (3 commits) | 36.9 ms | 0.6 ms | **60.0×** |
| getCommitSummaries (3 commits) | 45.8 ms | 0.7 ms | **62.6×** |
| getCommitSubject | 35.3 ms | 0.3 ms | **137.5×** |
| searchHistory | 38.2 ms | 1.6 ms | **24.2×** |
| getConfig | 74.1 ms | 0.3 ms | **271.7×** |
| getStashes | 41.5 ms | 0.6 ms | **67.7×** |
| getUncommittedChangeCount | 50.1 ms | 9.3 ms | **5.4×** |
| compareCommits | 100.1 ms | 31.4 ms | **3.2×** |
| countCommitsBefore | 51.7 ms | 1.6 ms | **31.8×** |
| getCommitFile (the 15 000-line webview bundle) | 45.8 ms | 0.9 ms | **52.7×** |
| getCommitFileDiff (same file) | 136.9 ms | 28.1 ms | **4.9×** |
| getCurrentBranchUpstream | 45.4 ms | 0.3 ms | **140.4×** |
| getRemoteUrl | 39.7 ms | 0.3 ms | **127.4×** |

This is the everyday shape: a tiny history, but real files — diffing the 15 000-line webview
bundle is real work for both sides, and the engine still returns it 5× sooner.

### Small (100 commits)

| operation | git CLI | engine | speedup |
|---|---:|---:|---:|
| view load (repoInfo + first page) | 292.8 ms | 29.3 ms | **10.0×** |
| getRepoInfo | 125.2 ms | 4.0 ms | **31.5×** |
| getCommits (a page of the graph) | 167.6 ms | 27.1 ms | **6.2×** |
| getRefs | 97.3 ms | 4.5 ms | **21.4×** |
| getCommitDetails | 123.1 ms | 3.4 ms | **35.9×** |
| getCommitBodies (50 commits) | 60.4 ms | 5.1 ms | **11.7×** |
| getCommitSummaries (50 commits) | 68.7 ms | 5.8 ms | **11.8×** |
| getCommitSubject | 46.3 ms | 0.5 ms | **99.8×** |
| searchHistory ('' matches everything) | 66.3 ms | 19.3 ms | **3.4×** |
| getConfig | 74.2 ms | 0.2 ms | **309×** |
| getStashes | 46.1 ms | 0.8 ms | **59.5×** |
| getUncommittedChangeCount | 51.8 ms | 9.0 ms | **5.8×** |
| compareCommits | 85.2 ms | 11.7 ms | **7.3×** |
| countCommitsBefore | 59.5 ms | 14.4 ms | **4.1×** |
| getCommitFile | 46.3 ms | 0.6 ms | **75.7×** |
| getCommitFileDiff | 92.0 ms | 2.3 ms | **40.9×** |
| getCurrentBranchUpstream | 42.2 ms | 0.3 ms | **146×** |
| getSubmodules | 0.0 ms | 0.2 ms | 0.2× ¹ |
| getRemoteUrl | 41.5 ms | 0.2 ms | **230×** |
| getTagDetails (annotated tag) | 45.3 ms | 0.6 ms | **76.1×** |

### Medium (1 000 commits)

| operation | git CLI | engine | speedup |
|---|---:|---:|---:|
| view load (repoInfo + first page) | 318.0 ms | 118.9 ms | **2.7×** |
| getRepoInfo | 156.2 ms | 33.9 ms | **4.6×** |
| getCommits (a page of the graph) | 230.1 ms | 110.4 ms | **2.1×** |
| getRefs | 107.4 ms | 33.8 ms | **3.2×** |
| getCommitDetails | 119.5 ms | 3.0 ms | **40.3×** |
| getCommitBodies (50 commits) | 59.2 ms | 5.7 ms | **10.3×** |
| getCommitSummaries (50 commits) | 70.7 ms | 5.7 ms | **12.4×** |
| getCommitSubject | 44.7 ms | 0.6 ms | **77.0×** |
| searchHistory | 82.5 ms | 46.2 ms | **1.8×** |
| getConfig | 66.2 ms | 0.3 ms | **255×** |
| getStashes | 43.6 ms | 0.4 ms | **111×** |
| getUncommittedChangeCount | 45.5 ms | 7.0 ms | **6.5×** |
| compareCommits | 78.1 ms | 13.0 ms | **6.0×** |
| countCommitsBefore | 150.6 ms | 159.4 ms | 0.9× ² |
| getCommitFile | 46.7 ms | 0.9 ms | **50.8×** |
| getCommitFileDiff | 92.6 ms | 2.6 ms | **35.5×** |
| getCurrentBranchUpstream | 46.3 ms | 0.6 ms | **74.2×** |
| getSubmodules | 0.1 ms | 0.3 ms | 0.2× ¹ |
| getRemoteUrl | 48.4 ms | 0.2 ms | **288×** |
| getTagDetails (annotated tag) | 55.9 ms | 0.7 ms | **83.5×** |

### Large (10 000 commits, 1 000 tags)

| operation | git CLI | engine | speedup |
|---|---:|---:|---:|
| view load (repoInfo + first page) | 292.7 ms | 120.7 ms | **2.4×** |
| getRepoInfo | 130.4 ms | 40.7 ms | **3.2×** |
| getCommits (a page of the graph) | 192.3 ms | 111.9 ms | **1.7×** |
| getRefs | 98.6 ms | 37.6 ms | **2.6×** |
| getCommitDetails | 121.6 ms | 5.5 ms | **22.2×** |
| getCommitBodies (50 commits) | 76.6 ms | 8.0 ms | **9.6×** |
| getCommitSummaries (50 commits) | 85.4 ms | 6.0 ms | **14.3×** |
| getCommitSubject | 54.5 ms | 0.6 ms | **84.3×** |
| searchHistory | 112.6 ms | 63.6 ms | **1.8×** |
| getConfig | 69.0 ms | 0.3 ms | **211×** |
| getStashes | 46.3 ms | 0.4 ms | **105×** |
| getUncommittedChangeCount | 52.6 ms | 8.8 ms | **6.0×** |
| compareCommits | 86.2 ms | 21.6 ms | **4.0×** |
| countCommitsBefore | 119.6 ms | 93.5 ms | **1.3×** |
| getCommitFile | 51.2 ms | 0.6 ms | **83.6×** |
| getCommitFileDiff | 106.4 ms | 2.9 ms | **37.1×** |
| getCurrentBranchUpstream | 47.5 ms | 0.5 ms | **88.8×** |
| getSubmodules | 0.0 ms | 0.3 ms | 0.2× ¹ |
| getRemoteUrl | 45.6 ms | 0.2 ms | **230×** |
| getTagDetails (annotated tag) | 52.2 ms | 0.5 ms | **107×** |

¹ `getSubmodules` on the CLI backend answers from the working tree (no `.gitmodules` — no
process spawn), so this row compares a no-op against the engine reading the index; it is not
a real defeat. On any repository *with* submodules the CLI spawns `git config -f .gitmodules`
at the ~45 ms floor every other CLI row shows.

² `countCommitsBefore` on the 1 000-commit repository was the one row where the engine lost
(159.4 ms vs 150.6 ms): counting every commit before an early revision walks essentially the
whole history, which is `git rev-list --count`'s best case. On the 10 000-commit repository —
where the pack is built and the walk reads packed objects — the engine is ahead again (1.3×).

### What the numbers say

- **The single-object reads win by two orders of magnitude** (`getConfig`, `getRemoteUrl`,
  `getCommitSubject`, `getStashes`, `getCurrentBranchUpstream`) at every repository size. On the
  CLI side these all cost one `git` spawn (~45 ms floor on Windows), while the engine answers
  from its warm repository handle in well under a millisecond. The gap does not narrow as the
  repository grows, because the spawn is the cost.
- **The graph walk (`view load`, `getCommits`) wins by 10× on the small repository and settles
  around 2× on the larger ones.** Page size is capped at 300 commits, so the engine's cost is
  roughly constant while the CLI's cost is dominated by ref scanning (1 000 tags in the large
  repository) and pack reads. Two× off the number the user waits for on every repository open
  remains the difference between a view that loads instantly and one that visibly pauses.
- **Repository size moves the engine's cost, ref count moves both.** The rows that scan refs
  (`getRepoInfo`, `getRefs`) grow with the tag count for both backends; the rows that read
  individual objects stay flat from 100 to 10 000 commits.
- **The only operations that approach parity are full-history walks** (`searchHistory` with a
  pattern that matches everything, `countCommitsBefore`), where the work is proportional to the
  history and `git`'s walker is highly optimised. The engine still leads, but by 1.3–1.8×
  rather than 10×.

## Architecture

```
  webview  ─────────────────────────────────┐
                                            │  (unchanged from the original)
  extension host (TypeScript)               │
    src/backend/index.ts    backend selection, CLI fallback
    src/backend/api.ts      the GitBackend interface, the native implementation
    src/backend/cliBackend.ts   the same interface over the `git` CLI
    src/backend/addon.ts    binary loading, promises, error mapping
              │
              │  a handful of functions, JSON payloads
              ▼
  git-graph.node            Node-API addon (napi-rs)
              │
              ▼
  Rust engine (native/core)
    repository.rs    discovery, the handle cache
    refs.rs          reference scanning
    log.rs           the commit walk and its ordering
    graph.rs         assembling the graph the view renders
    diff.rs          tree diffing, rename detection, line counts
    status.rs        the working tree
    stash.rs         the stash
    details.rs       the Commit Details view
              │
              ▼
             gix
```

Three rules hold the shape together:

1. **Rust is the Git engine and nothing else.** It knows nothing about VS Code, and it is exercised
   by `cargo test` with no Node in the picture.
2. **TypeScript does the UI and the VS Code API, and never parses Git itself.**
3. **gix is an implementation detail.** Nothing above `native/core` names it, so a capability gix
   does not cover yet can be reimplemented or delegated without the extension noticing.

The *lane* layout — which column a commit's dot sits in — deliberately stays in the webview. It is
a rendering decision that depends on the viewport; the engine's job ends at the commits and their
parent relationships.

## The fallback, and why it is not temporary yet

`createBackend()` returns the Rust engine wrapped so that anything it cannot answer reaches the
`git` CLI instead:

```
GitBackend
├── NativeBackend  ──► gix
└── CliBackend     ──► git
```

Only two kinds of failure are fallen back over: *this is not a repository I can open*, and *I do
not implement this*. A genuine Git failure — a bad revision, a corrupt object — **is** the answer,
and re-running it through `git` would produce the same failure more slowly.

On a platform with no prebuilt binary the CLI backend is used alone, and the extension behaves
exactly as the original did.

## No git process in the shipped path

The engine never shells out. Tests are the deliberate exception:
[`native/core/tests/common/mod.rs`](native/core/tests/common/mod.rs) builds fixture repositories
with the `git` command line, and every reader is checked against what git itself reports for the
same question. Git is the reference implementation; comparing against it is the strongest
correctness signal available.

`tests/backends.test.mjs` goes further and runs **both backends over the same repository through
the same interface**, asserting they agree field by field — because the webview above them cannot
tell which one it is talking to, so any disagreement is a user-visible behaviour change.

## Known deviations from git

- **Commit and tag signatures are reported as present but unverified.** Verifying them needs a full
  OpenPGP and SSH implementation plus access to the user's keyring. The status reported is `E` ("cannot be
  checked"), which is what git itself reports when the key is unavailable — rather than claiming a
  signature is good without having checked it.

- **Ordering reads a bounded window.** All three of git's orderings are topologically constrained,
  and gix's traversal offers no such guarantee, so the ordering is done here: a window of commits
  is collected and re-ordered by a topological sort whose ready set is ranked by the requested
  ordering. The window is a multiple of the requested page rather than the whole history, so
  ordering is exact within the window and commits beyond it are not considered. Every ordering
  guarantees that a commit never appears before one of its children.

- **A file modified in the working tree but not staged has no line counts** when comparing an
  arbitrary revision against the working tree. Getting them means hashing the worktree file, which
  costs more than the counts are worth on the critical path. For the same reason, a comparison
  against the working tree shows no counts at all — a number that is exact for part of the list
  and missing for the rest reads worse than none.

- **Line counts arrive after the file list.** Opening a commit (or a comparison) renders its file
  list first and settles the `+N/-M` counts progressively — the rows in view, then the rest in
  background batches — because every file's counts cost two blob reads, which dominates the load
  of a commit touching thousands of files. Everywhere except a working-tree comparison the counts
  are exact once settled.

## Data-loss protection

Some write operations can lose work that no ref keeps reachable — silently, because the `git`
command that does it exits successfully (its "you are leaving commits behind" warning goes to
stderr, which a successful command discards). Those operations do not run on the first click:
the view shows its standard data-loss dialog — a warning banner, the mascot, and a single
"I understand the risk" button — and only re-sends the action when the user presses it.
The guarded operations:

- **Leaving a detached HEAD that has its own commits** — switching to a branch, checking out
  another commit, or creating a branch somewhere else with checkout. The commits are held by no
  branch, tag, remote or stash; after the switch they are reachable only from the local reflog,
  and only until `git gc` prunes them. Creating the branch *at* HEAD anchors them, so it is never
  asked. A stash anchors its base commit's history the same way — every stash entry counts, not
  just the top one — so leaving a detached position that has a stash on it loses nothing and is
  never asked either; only commits made *after* that stash are still stranded.
- **A hard reset while the working tree has uncommitted changes.** Those contents are recorded
  in no reflog; at most previously staged versions might be found with `git fsck`. The
  "reset uncommitted changes" action is itself an explicit choice to discard, so it is not asked
  again.
- **A force push.** The commits the remote has that the push does not contain become unreachable
  *there*; whether they can be recovered depends on the remote — hosted services usually only
  keep them accessible by hash, for a while. `--force-with-lease` is the guarded variant and is
  not confirmed a second time.

The dialog wording states the actual recoverability of each case, verified against real
repositories: which things the reflog keeps (and for how long), which need `git fsck` (dropping
a stash deletes its reflog with it; so does force-deleting an unmerged branch), and which depend
on the remote.

## Building

Requires Rust 1.85+ and Node 18+. There is deliberately no node-gyp, no Python, and no download of
Node headers: napi-rs resolves the Node-API symbols at load time rather than linking against them.

```sh
npm install
npm run build              # the addon (debug) + the TypeScript
npm run build:native:release
npm test                   # cargo tests + the cross-backend integration tests
npm run bench -- <repo-path> --tags
npm run bench:all -- <repo-path>   # every read operation, engine vs CLI, one table
npm run lint               # clippy + rustfmt
```

On Windows, `build-and-install.bat` runs the whole chain — native addon, TypeScript, webview,
tests — packages the vsix and installs it into VS Code, stopping at the first failure.

Which operations the Rust engine serves and which still spawn `git` is documented in
[docs/BACKENDS.md](docs/BACKENDS.md); what the engine depends on — including why a pure-Rust
addon still needs platform linkers — is documented in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

### Measuring, and reading the measurements

`node scripts/bench.mjs <repo-path>` reports the number that matters — one view load — for both
backends; `--all` times **every** read operation the extension performs, one table row per
operation with the speedup and what each side returned (`--json` emits the same measurements for
trend tracking). While `git-graph-rs.enableLog` is on, every spawned `git` command is logged with
its duration and every engine→CLI fallback with its reason; `node scripts/analyze-log.mjs
<logfile>` summarises a session log into where the time went, which methods fell back, and what
failed.

The icon set (the marketplace PNG, the themed menu icons, and the mobile notification set —
all the same crab-and-graph motif) is regenerated from the SVG masters with
`node scripts/generate-icons.mjs`.

Cross-compiling for another platform:

```sh
node scripts/build-addon.mjs --release --target aarch64-apple-darwin
build-rust.bat                        # the four common targets, one command (Windows host)
build-rust.bat --full                 # all six, adding Windows arm64 and macOS x64
```

The build is delegated to [`@napi-rs/cli`](https://napi.rs) (`napi build`), with three routes
behind it. A target of a foreign OS family goes through `--cross-compile`, which builds with
`cargo-zigbuild` — Linux targets get their cross glibc linker from zig, and so do the macOS
targets (zig bundles the macOS libc, so no Apple SDK is needed); `zig` comes from the PATH or
from the pip `ziglang` package. The Windows arm64 target from a Windows host is linked directly
by `rust-lld` against the Windows SDK's arm64 libraries and the ARM64 CRT vsix from cargo-xwin's
cache — neither the VS "C++ ARM64 build tools" component nor symlink privileges (which
cargo-xwin's own extraction needs) are required. Everything else builds natively. The binaries
that ship are the ones CI builds on native runners for each platform, not local cross-builds.

## Supported platforms

The native engine is built for the six platforms Visual Studio Code itself ships for — every
desktop OS in both x64 and arm64. (32-bit x86 is not listed because VS Code no longer ships 32-bit
builds.) Only the four common ones ship by default: Windows ARM64 and macOS x64 have few users, and
on them the extension runs over the `git` CLI backend instead (see below) — a `full` release run or
`build-rust.bat --full` builds and packages all six.

| Platform | Target | CI | On a Windows host | On a Linux host | On a macOS host |
|---|---|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | ✅ | ✅ local MSVC | — | — |
| Windows arm64 | `aarch64-pc-windows-msvc` | ✅ full only | ✅ `rust-lld` + SDK/CRT (see above) | — | — |
| Linux x64 | `x86_64-unknown-linux-gnu` | ✅ | ✅ `cargo-zigbuild` | ✅ native | — |
| Linux arm64 | `aarch64-unknown-linux-gnu` | ✅ | ✅ `cargo-zigbuild` | ✅ `gcc-aarch64-linux-gnu` | — |
| macOS x64 | `x86_64-apple-darwin` | ✅ full only | ✅ `cargo-zigbuild` | ✅ `cargo-zigbuild` | ✅ Xcode clang |
| macOS arm64 | `aarch64-apple-darwin` | ✅ | ✅ `cargo-zigbuild` | ✅ `cargo-zigbuild` | ✅ Xcode clang |

¹ A cross-built binary has not run on the platform it targets: the cross-builds are for
development and packaging convenience, and the binaries that ship are still the ones CI builds on
native runners. A binary cross-built with zig links only the platform's libc, which is also why
no Apple SDK is needed for the darwin targets.

A platform whose binary is missing from the VSIX is still fully functional: the extension detects
at load time that no engine matches `process.platform` + `process.arch` and serves every query
through the `git` CLI backend instead — the view loads normally, with an informational notice, and
the Settings widget's **Backend** section shows exactly which areas run on which backend. The
engine is a speed optimisation, never a requirement.

The reverse also holds: **a machine without Git installed runs the extension on the engine alone**
— the whole read path (graph, details, comparisons, search, settings panel data) is served
in-process, the view loads normally, and write operations report that they need Git. The write
path (fetch/push, merge, rebase, stash operations, branch and tag maintenance) still runs through
the `git` CLI — including where gix itself has no implementation yet (push above all).

## Shipping

[`.github/workflows/native-build.yml`](.github/workflows/native-build.yml) builds one binary per
platform — the four common ones by default, all six when its `full` input is set — and assembles
them into the layout the extension loads from:

```
native/
├── win32-x64-msvc/git-graph.node
├── win32-arm64-msvc/git-graph.node      # full runs only
├── linux-x64-gnu/git-graph.node
├── linux-arm64-gnu/git-graph.node
├── darwin-x64/git-graph.node            # full runs only
└── darwin-arm64/git-graph.node
```

At load time the extension picks the directory for `process.platform` + `process.arch`. One VSIX
holds every engine that was built; installing it needs no Git, Rust, Cargo, Python or CMake on the
user's machine.

### Publishing a release

[`.github/workflows/release.yml`](.github/workflows/release.yml) is triggered by hand — the
Actions tab ("Release" → "Run workflow") or `gh workflow run release.yml -f version=v0.2.0`. It
runs the whole build-and-test pipeline on native runners, assembles the VSIX from exactly the
binaries that run produced, and publishes a GitHub Release with the VSIX and the per-platform
VSIXs as assets. By default the engines and the per-platform VSIXs are the four common ones;
check `full` (or `gh workflow run release.yml -f full=true`) to ship all six. The tag defaults to
`package.json`'s version; an override updates the VSIX's version to match. Nothing is published
unless every test passed.

## Roadmap

The phases below follow the rewrite plan this project was started from.

| Phase | | Status |
|---|---|---|
| 0 | Abstract the Git backend behind an interface | **done** — `GitBackend`, both implementations |
| 1 | napi-rs foundations, repository lifecycle | **done** — handle cache, error mapping, async off the JS thread |
| 2 | log, status, diff, refs, stashes | **done** |
| 3 | Graph engine — traversal, ordering, ref attachment | **done** (lane layout stays in the webview by design) |
| 15–16 | Cross-platform build, VSIX layout | **done** — CI matrix, six targets |
| 17 | Fallback to the `git` CLI | **done** |
| 18 | Behaviour tests against git | **done** — engine tests and cross-backend tests |
| 4 | Remote / fetch / push | not started |
| 5 | Worktree | not started |
| 6 | Merge / cherry-pick / revert | not started |
| 7–8 | Stash operations, rebase, interactive rebase | not started (the stash is *read* today) |
| 9–10 | Bisect, reflog, Git Undo | not started |
| 11 | Plumbing (objects, refs, index) | partial — the read side exists internally |
| 12 | Gerrit changes and patchsets | **done** — change refs fetched and cached locally, NoteDb metas parsed in-process, badges, review dialog, status filter, SCM push/hook commands |
| 13–14 | Large-repository work, cache invalidation | partial — handles and object caches are warm; no incremental invalidation yet |

The **whole read path** is on `GitBackend`, implemented twice — engine and CLI — and asserted to
agree in the cross-backend test; that is what makes a platform without a prebuilt binary work. The
write path (checkout, merge, rebase, stash operations, remotes, tags) is on neither backend yet:
it still spawns `git` directly in `DataSource`, and those phases need the interface extended
first, then both implementations, as [Roadmap](#roadmap) says. See `GAPS.md` for the full
inventory of what is missing.

## License & credits

The Rust engine (`native/`), the build scripts, the custom-made icons and the
`git-graph-rs-*` assets are original to this project and released under the
[MIT license](LICENSE).

The webview and extension host layers are ported and modified from
[mhutchie/vscode-git-graph](https://github.com/mhutchie/vscode-git-graph),
whose license (`licenses/LICENSE_GIT_GRAPH`) does not permit publishing
derivative works — see `LICENSE` for how that applies to this repository.
Further credits: the Visual Studio Code Git Extension (Askpass, Find Git
Executable — MIT), Octicons, vscode-icons and Icons8 for icons, and the
[gix][gix] and [napi-rs][napi-rs] ecosystems the engine builds on
(MIT OR Apache-2.0). The full inventory lives in
[`licenses/THIRD-PARTY-NOTICES.md`](licenses/THIRD-PARTY-NOTICES.md).

[napi-rs]: https://napi.rs
[gix]: https://github.com/GitoxideLabs/gitoxide

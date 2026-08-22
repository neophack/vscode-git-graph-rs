# Git Graph (Rust)

A rewrite of the Git Graph VS Code extension with its Git backend in Rust, loaded
into the extension host as a Node-API addon through [napi-rs], reading repositories with [gix].

The original extension answered every question by spawning a `git` process and parsing its output.
This one reads the object database, the refs and the index directly, in-process, from a repository
handle that stays warm for the whole editor session.

## Status

This is a working VS Code extension: the webview and extension host layer are ported from the
original (with the Gerrit integration removed), and the hot read paths — the view load, commit,
stash and uncommitted details, comparisons, config, file contents and single-file diffs — are
served by the Rust engine, falling back to the `git` CLI wherever the engine does not reach yet.
The write path (checkout, merge, rebase and the rest) still goes through the `git` CLI, behind
the same interface. See [GAPS.md](GAPS.md) and [Roadmap](#roadmap).

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

- **Commit signatures are reported as present but unverified.** Verifying them needs a full OpenPGP
  and SSH implementation plus access to the user's keyring. The status reported is `E` ("cannot be
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
  costs more than the counts are worth on the critical path. Line counts for committed changes are
  exact.

## Building

Requires Rust 1.85+ and Node 18+. There is deliberately no node-gyp, no Python, and no download of
Node headers: napi-rs resolves the Node-API symbols at load time rather than linking against them.

```sh
npm install
npm run build              # the addon (debug) + the TypeScript
npm run build:native:release
npm test                   # cargo tests + the cross-backend integration tests
npm run bench -- <repo-path> --tags
npm run lint               # clippy + rustfmt
```

On Windows, `build-and-install.bat` runs the whole chain — native addon, TypeScript, webview,
tests — packages the vsix and installs it into VS Code, stopping at the first failure.

Which operations the Rust engine serves and which still spawn `git` is documented in
[docs/BACKENDS.md](docs/BACKENDS.md).

The icon set (the marketplace PNG, the themed menu icons, and the mobile notification set —
all the same crab-and-graph motif) is regenerated from the SVG masters with
`node scripts/generate-icons.mjs`.

Cross-compiling for another platform:

```sh
node scripts/build-addon.mjs --release --target aarch64-apple-darwin
```

The build is delegated to [`@napi-rs/cli`](https://napi.rs) (`napi build`). A target of a foreign
OS family goes through `--cross-compile`, which builds with `cargo-zigbuild` (Linux and macOS
targets; `zig` must be on the PATH) or `cargo-xwin` (Windows targets), installing either
automatically on first use. A target of the host's own OS family uses the platform's own cross
linker instead — the Visual Studio "C++ ARM64 build tools" component on Windows,
`gcc-aarch64-linux-gnu` on Linux. The binaries that ship are the ones CI builds on native runners
for each platform, not local cross-builds.

## Supported platforms

The native engine is built for the six platforms Visual Studio Code itself ships for — every
desktop OS in both x64 and arm64. (32-bit x86 is not listed because VS Code no longer ships 32-bit
builds.)

| Platform | Target | CI | On a Windows host | On a Linux host | On a macOS host |
|---|---|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | ✅ | ✅ local MSVC | — | — |
| Windows arm64 | `aarch64-pc-windows-msvc` | ✅ | ✅ VS ARM64 tools or `cargo-xwin` | — | — |
| Linux x64 | `x86_64-unknown-linux-gnu` | ✅ | via CI only¹ | ✅ native | — |
| Linux arm64 | `aarch64-unknown-linux-gnu` | ✅ | via CI only¹ | ✅ `gcc-aarch64-linux-gnu` | — |
| macOS x64 | `x86_64-apple-darwin` | ✅ | via CI only | via CI only | ✅ Xcode clang |
| macOS arm64 | `aarch64-apple-darwin` | ✅ | via CI only | via CI only | ✅ Xcode clang |

¹ Linux targets can also be cross-compiled from Windows with `cargo-zigbuild` + `zig` (zig
provides the cross glibc linker); the darwin targets require Apple's SDK and in practice a Mac —
for them, [`cargo build --release --target aarch64-apple-darwin` on a Mac] or CI is the path.

A platform whose binary is missing from the VSIX is still fully functional: the extension detects
at load time that no engine matches `process.platform` + `process.arch` and serves every query
through the `git` CLI backend instead. The engine is a speed optimisation, never a requirement.

## Shipping

[`.github/workflows/native-build.yml`](.github/workflows/native-build.yml) builds one binary per
platform and assembles them into the layout the extension loads from:

```
native/
├── win32-x64-msvc/git-graph.node
├── win32-arm64-msvc/git-graph.node
├── linux-x64-gnu/git-graph.node
├── linux-arm64-gnu/git-graph.node
├── darwin-x64/git-graph.node
└── darwin-arm64/git-graph.node
```

At load time the extension picks the directory for `process.platform` + `process.arch`. One VSIX
holds all six; installing it needs no Git, Rust, Cargo, Python or CMake on the user's machine.

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
| 12 | Gerrit changes and patchsets | partial — change refs are filtered and displayed |
| 13–14 | Large-repository work, cache invalidation | partial — handles and object caches are warm; no incremental invalidation yet |

The CLI fallback covers the **read** methods on `GitBackend`, and only those — it is what makes a
platform without a prebuilt binary work, not a substitute for the unstarted phases. The write path
(checkout, merge, rebase, stash operations, remotes, tags) is on neither backend yet: those phases
need the interface extended first, then both implementations, as
[Roadmap](#roadmap) says. See `GAPS.md` for the full inventory of what is missing.

[napi-rs]: https://napi.rs
[gix]: https://github.com/GitoxideLabs/gitoxide

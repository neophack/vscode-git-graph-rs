# Git Graph (Rust)

A rewrite of the Git Graph VS Code extension with its Git backend in Rust, loaded
into the extension host as a Node-API addon through [napi-rs], reading repositories with [gix].

The original extension answered every question by spawning a `git` process and parsing its output.
This one reads the object database, the refs and the index directly, in-process, from a repository
handle that stays warm for the whole editor session.

## Status

This is a working VS Code extension: the webview and extension host layer are ported from the
original (with the Gerrit integration removed), and **every repository read** — the view load,
commit, stash and uncommitted details, comparisons, config, file contents and single-file diffs,
plus the on-demand reads behind the Find dialogue, the tag details, submodule and upstream
lookups, and the commit counting the view's jump-to-commit uses — is served by the Rust engine,
falling back to the `git` CLI wherever the engine does not reach.
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
build-rust.bat                        # all six targets, one command (Windows host)
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
builds.)

| Platform | Target | CI | On a Windows host | On a Linux host | On a macOS host |
|---|---|---|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | ✅ | ✅ local MSVC | — | — |
| Windows arm64 | `aarch64-pc-windows-msvc` | ✅ | ✅ `rust-lld` + SDK/CRT (see above) | — | — |
| Linux x64 | `x86_64-unknown-linux-gnu` | ✅ | ✅ `cargo-zigbuild` | ✅ native | — |
| Linux arm64 | `aarch64-unknown-linux-gnu` | ✅ | ✅ `cargo-zigbuild` | ✅ `gcc-aarch64-linux-gnu` | — |
| macOS x64 | `x86_64-apple-darwin` | ✅ | ✅ `cargo-zigbuild` | ✅ `cargo-zigbuild` | ✅ Xcode clang |
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

### Publishing a release

[`.github/workflows/release.yml`](.github/workflows/release.yml) is triggered by hand — the
Actions tab ("Release" → "Run workflow") or `gh workflow run release.yml -f version=v0.2.0`. It
runs the whole build-and-test pipeline on native runners, assembles the VSIX from exactly the
binaries that run produced, and publishes a GitHub Release with the VSIX and the six engine
binaries as assets. The tag defaults to `package.json`'s version; an override updates the VSIX's
version to match. Nothing is published unless every test passed.

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

The **whole read path** is on `GitBackend`, implemented twice — engine and CLI — and asserted to
agree in the cross-backend test; that is what makes a platform without a prebuilt binary work. The
write path (checkout, merge, rebase, stash operations, remotes, tags) is on neither backend yet:
it still spawns `git` directly in `DataSource`, and those phases need the interface extended
first, then both implementations, as [Roadmap](#roadmap) says. See `GAPS.md` for the full
inventory of what is missing.

[napi-rs]: https://napi.rs
[gix]: https://github.com/GitoxideLabs/gitoxide

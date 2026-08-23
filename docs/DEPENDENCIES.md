# Dependencies: What the Engine Is Built From, and What It Links Against

The short answers, each verifiable with the commands at the bottom:

- **Is it pure Rust?** Yes. No C or C++ is compiled anywhere in the workspace: there is no
  `.c`/`.cpp`/`.h` file, no `cc`/`cmake`/`pkg-config` in the build graph, and none of the
  C-backed optional backends (system zlib, zlib-ng, OpenSSL, `ring`) is enabled.
- **Why is building still fiddly then?** Because the *last step* of producing a native shared
  library is a platform link, and that step needs each platform's linker and its C-runtime /
  system import libraries — which Rust deliberately does not bundle. The Rust source is portable;
  the link environment is per-platform, six times over.

## Why a pure-Rust addon still needs platform toolchains

`rustc` compiles Rust to object files (COFF on Windows, ELF elsewhere) and then hands them to a
**platform linker** to produce the `.node` shared library. Rust does not ship platform linkers
beyond `rust-lld`, and linking requires:

1. a linker,
2. the target platform's **C runtime** import libraries (the CRT on Windows, glibc on Linux,
   libSystem on macOS) — because Rust's own standard library is built on top of them, and
3. the OS **system import libraries** (`kernel32.lib`, `advapi32.lib`, `ws2_32.lib`, … — see the
   link line in any build log).

None of that compiles C code of ours; it is the native ABI every Rust binary is born into. What
each build route supplies:

| Target | Linker | CRT / system libraries | Provided by |
|---|---|---|---|
| `x86_64-pc-windows-msvc` | MSVC `link.exe` | MSVC CRT + Windows SDK | Visual Studio ("C++ build tools") |
| `aarch64-pc-windows-msvc` | `rust-lld` (from the Rust toolchain) | ARM64 CRT vsix + Windows SDK `arm64` | cargo-xwin's cache + any SDK install |
| `x86_64-unknown-linux-gnu` | `zig cc` (cross) | glibc (cross-linked by zig) | `cargo-zigbuild` + zig |
| `aarch64-unknown-linux-gnu` | `zig cc` (cross) | glibc (cross-linked by zig) | `cargo-zigbuild` + zig |
| `x86_64-apple-darwin` | `zig cc` (cross) | macOS libc stubs bundled **inside zig** | `cargo-zigbuild` + zig |
| `aarch64-apple-darwin` | Xcode `clang` (native) | libSystem | Xcode |

This is where every obstacle this project hit on Windows came from — each one a toolchain
*discovery* problem, not a language problem:

| Symptom | Cause |
|---|---|
| `link: missing operand after '\xff\xfe'` | No ARM64 `link.exe` (VS component absent), so the linker lookup fell through to Git Bash's coreutils `link` — not a linker |
| cargo-xwin `os error 1314` (symlink) | xwin's first-run extraction creates symlinks, which Windows reserves for elevated/Developer-Mode processes |
| `Failed to find zig` | cargo-zigbuild scans the PATH only; the pip `ziglang` package (zig's own Windows distribution) is invisible to it |
| `could not open legacy_stdio_definitions.lib` | rustc passes that import library unconditionally; its ARM64 variant ships only in the full VS ARM64 component — nothing in a pure-Rust addon imports from it, so an empty archive satisfies it |

`scripts/build-addon.mjs` routes around all four (see `buildWindowsArm64Locally` and
`buildEnvironment`); `build-rust.bat` drives all six targets in one command.

## The Rust dependencies

Two crates, ~174 unique crates in the workspace graph, everything from crates.io, versions
pinned by `Cargo.lock`. All direct dependencies are MIT OR Apache-2.0.

### `git-graph-core` (the engine — no Node, no VS Code)

| Dependency | What it is used for |
|---|---|
| `gix 0.86` | The Git implementation: object database, refs, index, status, tree diff, revision walking. Features enabled: `revision`, `blob-diff`, `status`, `dirwalk`, `index`, `parallel`, `mailmap` (+ defaults) |
| `regex` | The pattern behind `searchHistory` (`git log -E -i --grep` semantics) |
| `serde` / `serde_json` | The JSON contract crossing the Node-API boundary |
| `thiserror` | The engine's error type (`ErrorKind` drives CLI fallback decisions) |
| `tempfile` *(dev)* | Fixture repositories for `cargo test` |

### `git-graph-node` (the Node-API addon)

| Dependency | What it is used for |
|---|---|
| `napi` / `napi-derive` | The Node-API bindings and the `#[napi]` macro |
| `napi-build` *(build)* | One-line `build.rs` that sets linker metadata |

No Node headers, node-gyp, or Python are involved: napi-rs emits `extern "C"` declarations for
Node-API symbols and resolves them **at load time**, which is why the addon links against nothing
Node-shaped.

### The C-shaped escape hatches, and why none is open

These are the places C code *could* enter through feature flags. None is enabled, so none of
these crates appears in the build graph at all:

| Crate | Enters through | Why it is absent here |
|---|---|---|
| `libz-sys` / `zlib-ng` (system zlib, C) | gix's `max-performance` feature | Not enabled; zlib decompression uses the pure-Rust backend (`miniz_oxide`) |
| `openssl-sys` (C) | gix's network features (`fetch`/`push`) | Not enabled; the engine never touches the network — remotes go through the `git` CLI |
| `ring` (C + asm) | TLS stacks | Not reachable without the above |
| `cc` / `pkg-config` / `cmake` | Any crate with C to compile | Nothing above is enabled, so no C build machinery exists in the graph |

## The extension side (TypeScript / npm)

- Runtime dependency: `iconv-lite` (character-set detection for file contents shown in the
  details view).
- Dev/tooling: `typescript`, `@napi-rs/cli` (drives `cargo` for the addon), `@vscode/vsce`
  (VSIX packaging), `uglify-js` + `sharp` (webview minification and icon generation).
- Runs inside the VS Code extension host (`vscode` API); the webview is dependency-free
  handwritten DOM code.

## Runtime dependencies

- **git** — the fallback backend (and the write path) shell out to it; also used by the test
  fixtures as the reference implementation. Not required to be any particular version for the
  engine itself.
- **Node-API** — resolved from the running editor's Node at load time. No bundled runtime.

## Re-verifying all of this

```sh
cargo tree -p git-graph-core --depth 1        # the engine's direct dependencies
cargo tree --workspace -i cc                  # → "did not match any packages" (no C compiled)
cargo tree --workspace -i libz-sys            # → same, for every C-backed optional
find native -name '*.c' -o -name '*.cpp'      # → nothing
cargo tree --workspace --prefix none | cut -d' ' -f1 | sed 's/@.*//' | sort -u | wc -l   # graph size
```

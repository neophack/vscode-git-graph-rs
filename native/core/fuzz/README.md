# Fuzzing the engine boundary

cargo-fuzz targets for the git-graph engine's two hostile-input boundaries (optimization
plan R7):

- `protocol_request` — `git_graph_core::protocol::decode_request`, the JSON
  `{"method", "params"}` contract every host request crosses.
- `gerrit_meta` — `git_graph_core::parse_gerrit_meta_message`, the pure `NoteDb` meta
  message grammar the view runs over fetched Gerrit meta histories.

Both targets call the same entry functions the always-on property tests in
`native/core/tests/fuzz_boundary.rs` drive, so a reproducer found by either mechanism runs
under the other. The property tests run on every `cargo test --workspace` on every platform;
these targets run nightly in CI (`.github/workflows/fuzz.yml`) and locally when wanted.

## Why

`catch_unwind` at the N-API boundary keeps an engine panic from taking down the VS Code
host — but every caught panic still means a silent fallback to the `git` CLI, with the
engine quietly out of the picture. A panic on hostile input is therefore a bug worth
finding before a user's repository data finds it.

## The policy: commit any crash as a regression test

When either the CI job or a local run finds a crashing input:

1. Minimize it (libFuzzer prints the artifact path under `artifacts/<target>/`; shrink it by
   hand or with `-minimize_crash=1`).
2. Add a fixed regression test with the minimal input to the matching target in
   `native/core/tests/fuzz_boundary.rs` (or, when it deserves its own case, to the parser's
   unit tests), asserting the documented behavior rather than just the absence of a panic.
3. Fix the bug. The regression test pins the fix; the fuzzer keeps hunting.

Never mark a crash "won't fix" without moving the input into a test that documents why the
behavior is correct.

## Running locally

cargo-fuzz needs a nightly toolchain, and libFuzzer has no MSVC runtime, so on Windows use
WSL (or any Linux/macOS machine):

```bash
rustup toolchain install nightly
cargo install cargo-fuzz --locked
cd native/core/fuzz
cargo +nightly fuzz run protocol_request
cargo +nightly fuzz run gerrit_meta
```

Notes:

- This directory is its own cargo workspace. It is deliberately not a member of the
  repository's main workspace, so the nightly-only libFuzzer dependency can never break
  `cargo check --workspace` on stable toolchains or on Windows. Nothing in the main
  workspace references it.
- Crashing inputs land in `artifacts/<target>/`, the corpus in `corpus/` — both are
  gitignored.
- To reproduce a CI crash: `cargo +nightly fuzz run <target> path/to/crash-file`.
- Without nightly, run the always-on property tests instead: they drive the same entry
  functions deterministically and support `VGR_FUZZ_ITERATIONS=<n>` for a deeper sweep:

  ```bash
  cargo test -p git-graph-core --test fuzz_boundary
  VGR_FUZZ_ITERATIONS=50000 cargo test -p git-graph-core --test fuzz_boundary
  ```

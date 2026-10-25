# ADR 0002: The native engine's binary floors (glibc 2.17, minos 10.13, static CRT)

Date: 2026-10-25
Status: Accepted

## Context

The universal VSIX bundles one `git-graph.node` per platform and falls back to the `git` CLI
whenever a binary cannot load, so an engine built against the builder's own libc fails
invisibly: a Remote-SSH server on an older distro simply gets "no engine", with nothing
surfacing the reason. REFACTOR-PLAN §3.7.1 promises macOS 10.13+, Linux glibc 2.17+, and musl
Linux (Alpine); §3.7.4 / task 2.8 require the build to *pin* those floors rather than inherit
whatever the CI runner happens to run, and CI to assert them on the produced artifacts. Before
this decision, Linux binaries were built natively on `ubuntu-latest` (glibc = the runner's), no
musl or armhf targets existed, the macOS deployment target and the Windows CRT linkage were
whatever the toolchain defaulted to.

## Decision

- Linux targets are **always** built through `cargo zigbuild` — host builds included — and the
  `*-gnu` ones (`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, and the new
  `armv7-unknown-linux-gnueabihf`) pass zigbuild the target suffix `.2.17`, pinning the oldest
  glibc whose symbols the binary may reference (CentOS 7 / Ubuntu 14.04+). `scripts/build-addon.mjs`
  routes every Linux target this way and exits with install instructions when `cargo zigbuild`
  or `zig` is missing, instead of silently falling back to a native build that would re-pin the
  floor to the runner.
- Three new targets with their platform directories: `x86_64-unknown-linux-musl`
  (`linux-x64-musl`, the `alpine-x64` VSIX), `aarch64-unknown-linux-musl` (`linux-arm64-musl`,
  `alpine-arm64`), and `armv7-unknown-linux-gnueabihf` (`linux-armhf`).
- Windows msvc targets build with `-C target-feature=+crt-static` (target-specific
  `CARGO_TARGET_*_RUSTFLAGS`), so the `.node` does not import `VCRUNTIME140.dll`. Windows 7/8.1
  stay on the CLI path regardless: Rust ≥1.78's msvc target requires Windows 10 (plan decision
  D9).
- macOS targets build with `MACOSX_DEPLOYMENT_TARGET=10.13`.
- `scripts/build/check-binary-compat.mjs` is the assertion gate: highest `GLIBC_` reference
  ≤ 2.17 on `*-gnu` (objdump -T), zero `GLIBC_` references on musl (objdump -T), minos ≥ 10.13
  on darwin (`vtool -show-build`, falling back to `otool -l`), and no `VCRUNTIME140.dll` in the
  Windows import table — the last via a pure-Node PE import-directory scan, the same question
  `dumpbin /dependents` answers, chosen because it is portable (a Linux CI job can check the
  Windows binaries) and unit-testable against crafted PEs. Tool-less checks SKIP locally; with
  `BINARY_COMPAT_REQUIRED=1` a SKIP is a failure, which is how CI must run the gate.
- The MSRV line stays `rust-version = "1.82"` at the workspace root (both crates inherit it);
  CI holds it with a `cargo +1.82 check --workspace` job.

## Consequences

- The glibc floor is a property of the build script, not of the runner: any machine with
  `cargo-zigbuild` + `zig` produces Linux binaries that load on every supported glibc distro.
- CI must run the gate where the tools exist: the Linux runner asserts glibc/musl (objdump is
  preinstalled) and the Windows CRT question (pure-Node PE scan runs anywhere); a macOS runner
  asserts minos with vtool. Absent platform binaries stay SKIPs even in required mode — which
  platforms ship is the packaging workflow's concern, not this gate's.
- Binaries built before this decision (e.g. a local `native/win32-x64-msvc/git-graph.node`
  linked against the dynamic CRT) go red in the gate until rebuilt — observed immediately on
  this machine's existing binary.
- Not yet covered: the *measured* highest-GLIBC/minos numbers of shipped artifacts land in
  `docs/compatibility.md` once CI first runs the gate ("measured, pending" there); the musl and
  armhf platform VSIXs are a packaging-workflow step, not a build-script one.

Commits: the `build(native)` commit that adds the zigbuild routing, the new targets and
`scripts/build/check-binary-compat.mjs` (this ADR rides along with it).

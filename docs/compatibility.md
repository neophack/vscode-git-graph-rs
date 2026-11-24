# Compatibility

The extension's documented compatibility promise, set by the executed refactor plan's §3.7 and
owned by this page. Entries marked **measured, pending** are numbers CI fills
in once the corresponding gate runs on real artifacts (the Phase 0 / task 2.8 measurement
steps), at which point the marker is replaced by the measured value.

## Support matrix (§3.7.1)

| Dimension | Promised floor | Notes |
|---|---|---|
| VS Code | **1.42.0** | `engines.vscode` is `^1.42.0` (Codicons natively supported across all contributed commands); verified by compatibility test C4. Post-1.42 manifest/API features degrade gracefully: `onStartupFinished` (1.46+), `git.pullpush` submenu (1.48+), Workspace Trust / `untrustedWorkspaces` (1.56–1.57+), `vscode.env.shell` (1.62+), and `vscode.window.tabGroups` (1.67+) |
| VS Code derivatives | VSCodium, Code - OSS, Git Graph Studio (`uriScheme === 'ggs'`), and other VS Code-based editors | Depends only on 1.42-era APIs (typed against `@types/vscode` 1.38.0); newer APIs are feature-detected through `vscodeCompat.ts` |
| Where it runs | Local; Remote-SSH / WSL / Dev Containers / Codespaces | `extensionKind: workspace`; the host runs remotely, so engine binaries must cover the remote platform. The pure-browser vscode.dev environment is not supported (it needs Git) |
| Git CLI | Determined by D7 (proposed: all read features usable from 2.0; write features tiered by the capability table) | Below a threshold, only that feature is disabled with a localized notice; everything else keeps working |
| Operating systems | Windows 7+, macOS 10.13+, Linux with glibc 2.17+, musl Linux (Alpine) | Systems the engine does not cover use the CLI with full functionality (§3.7.4) |
| Rust engine | Optional acceleration layer | Unavailable for any reason → CLI fallback; the reason is shown in the backend section of the settings page |

## Runtime anchors (§3.7.1)

The versions each supported VS Code runs on; the artifact baselines (`node12.8` host,
`chrome78` webview) follow the promised floor row. **measured, pending**: Phase 0 prints
`process.versions` in each version and records the verified values here.

| VS Code | Electron | Node | Chromium | Significance for this project |
|---|---|---|---|---|
| 1.42 | 7.1 | 12.8 | 78 | **Promised floor**: host artifact baseline `node12.8`, webview artifact baseline `chrome78`; Codicons in command contributions; N-API 3/4 |
| 1.46 | 7.2 | 12.8 | 78 | `onStartupFinished` activation event introduced (earlier versions activate via `workspaceContains:.git`, commands, or webview serializer) |
| 1.48 | 7.3 | 12.8 | 78 | `git.pullpush` SCM submenu introduced (earlier versions expose Gerrit push via the Command Palette) |
| 1.56 | 12 | 14.16 | 89 | Desktop webviews migrated to `<iframe>`; Workspace Trust preview (`capabilities.untrustedWorkspaces` stable in 1.57) |
| 1.61 | — | — | — | First version for platform-specific VSIXs (`vsce --target`); earlier versions use the universal VSIX |

## Native engine binary floors (§3.7.4)

Each shipped `git-graph.node` is held to the floor below by construction
(`scripts/build-addon.mjs`, adr-0002) and asserted on the artifacts by
`scripts/build/check-binary-compat.mjs`, which CI runs with `BINARY_COMPAT_REQUIRED=1`. The
last column is the measured value of the latest artifacts: **measured, pending** until CI first
runs the gate.

| Platform directory | Target triple | Promised floor | How the build holds it | Measured |
|---|---|---|---|---|
| `win32-x64-msvc` | `x86_64-pc-windows-msvc` | no `VCRUNTIME140.dll` dependency | `-C target-feature=+crt-static` | **measured, pending** |
| `win32-arm64-msvc` | `aarch64-pc-windows-msvc` | no `VCRUNTIME140.dll` dependency | `-C target-feature=+crt-static` | **measured, pending** |
| `linux-x64-gnu` | `x86_64-unknown-linux-gnu` | glibc 2.17 | `cargo zigbuild`, target suffix `.2.17` | **measured, pending** |
| `linux-arm64-gnu` | `aarch64-unknown-linux-gnu` | glibc 2.17 | `cargo zigbuild`, target suffix `.2.17` | **measured, pending** |
| `linux-armhf` | `armv7-unknown-linux-gnueabihf` | glibc 2.17 | `cargo zigbuild`, target suffix `.2.17` | **measured, pending** |
| `linux-x64-musl` | `x86_64-unknown-linux-musl` | musl (no glibc symbols) | `cargo zigbuild` | **measured, pending** |
| `linux-arm64-musl` | `aarch64-unknown-linux-musl` | musl (no glibc symbols) | `cargo zigbuild` | **measured, pending** |
| `darwin-x64` | `x86_64-apple-darwin` | macOS 10.13 | `MACOSX_DEPLOYMENT_TARGET=10.13` | **measured, pending** |
| `darwin-arm64` | `aarch64-apple-darwin` | macOS 10.13 | `MACOSX_DEPLOYMENT_TARGET=10.13` | **measured, pending** |

Related floor decisions:

- **N-API**: the engine targets Node-API 3 (`AsyncTask`s), so VS Code 1.38's Node 10.11 can
  load it — see [adr-0003](./adr/adr-0003-node-api-3-engine-floor.md). The loader-side
  preflight and failure classification are future work.
- **Windows 7/8.1**: run the CLI fallback; Rust ≥1.78 msvc targets require Windows 10 (plan
  decision D9).
- **MSRV**: `rust-version = "1.88"` at the workspace root, held by a `cargo +1.88 check
  --workspace` CI job.

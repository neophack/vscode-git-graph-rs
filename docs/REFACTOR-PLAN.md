# vscode-git-graph-rs 架构重构实施计划

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 日期 | 2026-10-17 |
| 适用代码基线 | `main` @ `047e7ea`（1.0.26） |
| 方法论 | mattpocock/skills · `improve-codebase-architecture` + `codebase-design`（deep module / seam / adapter） |
| 状态 | 草案，待评审 |
| 关联产物 | 架构评审报告（HTML，本地）；`GLOSSARY.md`（随阶段 0 创建）；`docs/adr/`（按需创建） |

---

## 目录

1. 摘要
2. 背景、目标与非目标
3. 术语
4. 现状基线
5. 问题清单（按 seam 归类）
6. 目标架构
7. 实施原则与约束
8. 阶段总览与依赖图
9. 阶段 0 · 安全网与护栏
10. 阶段 1 · 修复已确认缺陷
11. 阶段 2 · 宿主端协议 handler 表
12. 阶段 3 · Webview 端响应路由表
13. 阶段 4 · GitProcess：统一进程 adapter 与错误契约
14. 阶段 5 · GitWriter：写路径深化
15. 阶段 6 · CommitLoader：从 GitGraphView 抽出加载管线
16. 阶段 7 · 配置快照注入，数据层去 vscode 依赖
17. 阶段 8 · Webview 迁移到 ES modules
18. 阶段 9 · ViewStore：webview 单一状态来源
19. 阶段 10 · SafeHtml：类型化的 HTML 安全
20. 阶段 11 · 对比视图迁入 web/
21. 阶段 12 · Backend 收尾与死代码清理
22. 测试策略
23. 质量门禁与 CI 变更
24. 风险登记表
25. 回滚策略
26. 排期与人力估算
27. PR 拆分清单
28. 验收标准（Definition of Done）
29. 附录 A · 命令分类表
30. 附录 B · DataSource 方法迁移映射
31. 附录 C · 依赖规则（机器可检查）
32. 附录 D · 候选 ADR
33. 附录 E · 每个 PR 的检查清单模板

---

## 1. 摘要

本扩展的功能完整、测试充分（Node 698 个、Rust 141 个，全部通过），问题不在“能不能用”，而在**结构**：

- 宿主端两个 god module，`src/gitGraphView.ts`（2481 行，9 种职责）和 `src/dataSource.ts`（2579 行，约 95 个 public 方法），承担了几乎所有变更（`git log` 热点第 1、3 位）。
- 宿主与 webview 之间唯一的 seam，也就是消息协议，由宿主端 85 分支、webview 端 92 分支、都没有 `default` 的两个 `switch` 维持。它们与类型定义、缓存失效列表 `REPO_MUTATING_COMMANDS` 之间，只靠正则测试 `tests/contract.test.mjs` 对齐。
- webview 是 `module: none` 的全局脚本拼接，**没有任何 seam**。`commitDetailsView` / `observers` / `contextMenuActions` 等文件只是把 `GitGraphView` 的方法搬到了别处，依然直接读写其 65 个字段。
- 结构问题已经导致**可复现的缺陷**：引擎错误以对象形式进入 `error: string` 字段；配置变更后 16 处读取到旧配置；带 `/` 的本地 tag 被渲染为远程 tag；名为 `constructor` 的 tag 会让行渲染崩溃。

本计划分 13 个阶段（0–12），全部采用**行为保持、渐进替换（strangler）**的方式实施：每个 PR 独立可合并，合并后 `npm run compile && npm test && npm run lint` 全绿，扩展可打包发布。阶段 0–6 是核心收益段，约 **19–24 人日**；阶段 7–12 是深化段，约 **20–26 人日**。

**首要建议**：先完成阶段 0（安全网），再做阶段 1（修 bug）和阶段 2（协议 handler 表）。阶段 2 是后续所有抽取的支点，风险最低，编译器兜底。

---

## 2. 背景、目标与非目标

### 2.1 背景

项目是 `vscode-git-graph` 的移植版：TypeScript 扩展宿主，加上基于 gix 的 Rust 引擎（`native/core`、`native/node`）。移植过程中功能不断叠加，例如 Gerrit、Worktree、Reflog、Statistics、二进制对比、自动化测试服务和移动端适配，但模块边界没有随之调整。新功能的代码多以“在大类上加字段和方法”或“在 switch 上加分支”的方式进入。

### 2.2 目标

| 编号 | 目标 | 可度量的判据 |
|---|---|---|
| G1 | 模块清晰：每个 module 只有一个职责，interface 小 | 单文件 ≤ 800 行（生成代码与字符串表除外）；`src/` 内没有循环依赖；附录 C 的依赖规则由 CI 检查 |
| G2 | 消息协议由编译器保证一致 | 删除正则契约测试后，漏写 handler 会成为编译错误；`switch (msg.command)` 在宿主和 webview 端都消失 |
| G3 | 写路径一处校验、一处错误格式 | `checkUnsafeGitArgs` 调用点从 40 处降为 1 处；进程启动点（`cp.spawn` / `execFile`）从 7 处降为 1 处 |
| G4 | 已知缺陷清零并有回归测试 | 第 10 章所列每个缺陷都有一个先失败、后通过的测试 |
| G5 | 难测的部分变得可测 | `CommitLoader`、协议 handler、`GitWriter`、`graph` 布局能脱离 `vscode.WebviewPanel` 和 jsdom 全量启动进行测试 |
| G6 | 不引入行为回归 | 现有 698 个 Node 测试和 141 个 Rust 测试在每个 PR 后保持通过（只允许“替换而非叠加”式删除，见 22.4） |

### 2.3 非目标

- **不改 Rust 引擎的结构。** `native/core` 已有清晰的分文件结构（`log.rs`、`graph.rs`、`diff.rs`……）和独立测试，本计划只在阶段 4 要求它的错误码与 TS 侧对齐。
- **不迁移写路径到引擎**（GAPS.md 第 2 节的 Phase 4–8）。本计划只让写路径**有一个 seam**，将来迁移时只需新增一个 adapter。
- **不改变 UI 外观与交互。** 视觉回归不在范围内，测试以现有 jsdom 用例为准。
- **不升级 `engines.vscode`（^1.38.0）**，也不引入运行时依赖。开发依赖只允许使用现有的 `esbuild`、`typescript`、`jsdom`、`c8`。
- **不重写 i18n 机制。** `web/strings.ts` 的字典结构保持不变，只在阶段 10 为含 HTML 的条目加类型标注。

---

## 3. 术语

架构用词遵循 `codebase-design` 的定义，全文统一，不使用“组件 / 服务 / 层 / 边界”等替代词。

| 术语 | 本文含义 |
|---|---|
| **Module** | 任何“有 interface 和 implementation”的东西：函数、类、文件、目录都算 |
| **Interface** | 调用方正确使用一个 module 所需知道的全部：类型签名、不变量、调用顺序、错误模式、所需配置 |
| **Depth / Deep / Shallow** | 单位 interface 背后的行为量。deep = 小 interface + 大量行为；shallow = interface 和 implementation 一样复杂 |
| **Seam** | 不改动该处代码即可替换行为的位置，也就是 interface 所在之处 |
| **Adapter** | 在 seam 上满足 interface 的具体实现。一个 adapter 只是“假想的 seam”，两个才算真正的 seam |
| **Leverage** | 调用方从 depth 得到的收益：学一次 interface，服务 N 个调用点 |
| **Locality** | 维护者从 depth 得到的收益：变更、缺陷和知识集中在一处 |

领域词汇（写入 `GLOSSARY.md`，见阶段 0）：

| 领域词 | 含义 |
|---|---|
| **Request / Response** | webview → 宿主 / 宿主 → webview 的协议消息，以 `command` 字段区分 |
| **Mutating command** | 处理过程中可能改变仓库（HEAD、refs、stash、index、工作区、git config）的 Request |
| **Follow-up** | 对同一个 `loadCommits` 请求的后续补充响应（远程 refs、Gerrit、未提交变更） |
| **Loss warning** | 动作可能丢失提交时返回给 webview 的确认请求，确认后带 `confirmed: true` 重放 |
| **Engine / CLI backend** | `GitBackend` 的两个读 adapter：Rust（gix）和 `git` 子进程 |
| **Write op** | 一次需要 `git` CLI 的写操作（checkout、merge、push……） |

---

## 4. 现状基线

### 4.1 规模（不含 `out/`、`node_modules/`、`target/`）

| 区域 | 主要文件 | 行数 |
|---|---|---|
| 宿主核心 | `gitGraphView.ts` 2481、`dataSource.ts` 2579、`repoManager.ts` 1179、`commands.ts` 838 | ≈ 7 100 |
| 宿主后端 | `backend/cliBackend.ts` 1474、`index.ts` 341、`api.ts` 401、`addon.ts` 313、`types.ts` 335 | ≈ 2 900 |
| 宿主协议 | `types/messages.ts` 1175、`types/webview.ts` 407 | ≈ 1 900 |
| 宿主附属视图 | `comparisonView.ts` 861、`binaryCompare.ts` 1430、`hexDiff.ts` 867、`gerrit.ts` 904 | ≈ 4 100 |
| 自动化 | `automation/catalog.ts` 3564、`server.ts` 942、`suiteRunner.ts` 792、`fixture.ts` 826 | ≈ 6 300 |
| Webview | `main.ts` 3225、`commitDetailsView.ts` 2008*、`strings.ts` 1851、`settingsWidget.ts` 1463、`contextMenuActions.ts` 1408*、`observers.ts` 1393* | ≈ 17 000 |
| Rust | `native/core/src/*.rs`、`native/node/src/lib.rs` | ≈ 8 000 |

\* 标星文件约一半是空行，是从 `main.ts` 抽取时留下的双换行，实际代码量约为一半。

### 4.2 质量基线（2026-10-17 实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 宿主类型检查 | `npx tsc -p ./src --noEmit` | 通过 |
| Webview 类型检查 | `npx tsc -p ./web --noEmit` | 通过 |
| 编译打包 | `npm run compile` | 通过 |
| Node 测试 | `node scripts/run-tests.mjs` | 698 / 698 通过，217 个文件级 suite，约 67 s |
| Rust 测试 | `cargo test --workspace` | 141 / 141 通过 |

**阶段 0 的第一个动作是把这组数字固化为 CI 门禁**，后续任何 PR 不得低于此基线（测试数只允许在“替换”时下降，并需在 PR 描述中列出被替换的用例）。

### 4.3 变更热点（2026 年以来提交次数，排除构建产物）

```
45 src/gitGraphView.ts      32 src/dataSource.ts      40 web/main.ts
25 web/strings.ts           17 src/backend/cliBackend.ts
16 web/settingsWidget.ts    16 src/i18n.ts            13 web/observers.ts
```

热点与 god module 完全重合，这正是本计划投入的优先区域。

---

## 5. 问题清单（按 seam 归类）

每条问题都标注了证据位置。阶段编号指出由哪个阶段解决。

### 5.1 宿主 ↔ webview 协议 seam

| # | 问题 | 证据 | 解决阶段 |
|---|---|---|---|
| P1 | 85 分支 `switch` 没有 `default`，未知命令被静默丢弃 | `src/gitGraphView.ts:699-1455` | 2 |
| P2 | `REPO_MUTATING_COMMANDS` 是手工维护的字符串集合，与 handler 分离；漏加一个就会让 HEAD 标记停在旧位置 | `src/gitGraphView.ts:362-369` | 2 |
| P3 | 协议一致性只靠正则测试 | `tests/contract.test.mjs:28-60` | 2 |
| P4 | 输入 `msg as RequestMessage` 没有运行时校验 | `src/gitGraphView.ts:652` | 2 |
| P5 | webview 端也有 92 分支 `switch`，约 60 个分支只是同一句 `refreshOrDisplayError(...)` | `web/main.ts:2561-2905` | 3 |
| P6 | 新增一条消息要改 6–8 个文件（shotgun surgery） | 见 §11.1 | 2、3 |
| P7 | `comparisonView` / `binaryCompareView` 使用自有的 `msg: any` 协议，不在 `messages.ts` 中 | `src/comparisonView.ts:61`、`src/binaryCompareView.ts:56` | 11 |

### 5.2 数据访问 seam（DataSource / GitBackend）

| # | 问题 | 证据 | 解决阶段 |
|---|---|---|---|
| P8 | 读方法是对 `GitBackend` 的浅层透传（27 处 `return this.backend.x`）；`getCommits` 有 17 个位置参数 | `src/dataSource.ts:547`、`src/gitGraphView.ts:2382` | 5 |
| P9 | `checkUnsafeGitArgs` + 提前返回的序言重复约 40 次；`signCommits ? '-S'` 重复约 9 次 | `src/dataSource.ts:68` 及各写方法 | 5 |
| P10 | 7 个进程 runner，错误格式不一：DataSource 取 `stderr+stdout` 并去掉末行，CliBackend 取 `stderr‖stdout` 并 trim | `src/dataSource.ts:2323-2463, 2505`；`src/backend/cliBackend.ts:489, 1218, 1240` | 4 |
| P11 | **两个 backend 的错误契约不一致**：CLI 在响应里带 `error: string`，Native 则 reject `GitBackendError`。DataSource 把 reject 值直接放进 `error: string\|null` | `src/backend/addon.ts:256`；`src/dataSource.ts:244, 580, 739, 766, 781, 794, 809, 829, 929` | 1（止血）、4（根治） |
| P12 | `gitOutput` / `runGitCommand` 公开，`commands.ts`（6 处）、`gitGraphView.ts`（4 处）可绕过校验和缓存失效 | — | 5 |
| P13 | 数据层引入 `vscode`：`Uri.file`、`showErrorMessage`、终端 | `src/dataSource.ts:1003, 1024, 2165, 2169` | 7 |
| P14 | `getConfig()` 被深层反复调用（DataSource 15 次，GitGraphView 10 次）。策略值不进缓存键，只能在配置变化时清空整个缓存 | `src/gitGraphView.ts:516` | 6、7 |
| P15 | 循环依赖：`dataSource → utils/actions → diffDocProvider → dataSource`；`utils` 依赖领域代码 | `src/utils/actions.ts:7`、`src/dataSource.ts:28` | 7 |
| P16 | `FallbackBackend` 有约 30 个手写方法，每个都形如 `attempt('x', b => b.x(...))` | `src/backend/index.ts:61-260` | 12 |
| P17 | 死代码：`invalidateRefCache`（no-op，仍被调用）、`generateGitCommandFormats`（空函数）、`spawnGit`（别名）、`engineRequest`、`describeBackend`、`enginePlatformTable` | — | 12 |

### 5.3 GitGraphView 内部

| # | 问题 | 证据 | 解决阶段 |
|---|---|---|---|
| P18 | 9 种职责：面板生命周期、HTML/CSP、分发、LRU 缓存、分阶段加载、Gerrit 缓存、轮询、全局设置白名单、PR 拉取、自动化钩子 | 全文件 | 2、6 |
| P19 | follow-up promise 链没有 catch，并且在 `unmute()` 之后运行，与 watcher 事件竞争 | `src/gitGraphView.ts:1086, 1105, 1132-1135` | 1、6 |
| P20 | 自动化代码把 `GitGraphView.currentPanel` 当作 service locator 使用；静态 tap 属于可变的全局状态 | `src/automation/hostBridge.ts:78-132`；`src/gitGraphView.ts:263-264` | 6 |

### 5.4 Webview 内部

| # | 问题 | 证据 | 解决阶段 |
|---|---|---|---|
| P21 | `module: none` 全局脚本拼接，依赖关系只存在于加载顺序 | `web/tsconfig.json`；`scripts/package-web.js:19-56` | 8 |
| P22 | 抽出去的文件以 `fn(view: GitGraphView, …)` 的形式直接读写 view 字段（`view.currentRepo` 95 次、`view.expandedCommit` 76 次…） | 见探查报告 | 9 |
| P23 | 配置有两个来源：`this.config`（实时）和 `initialState.config`（初始）。后者被 16 处读取 | `web/repoLoadOptions.ts`、`utils.ts:347/404`、`fileTree.ts:10/105`、`dialog.ts:288` 等 | 1（修复）、9（根治） |
| P24 | `strings` 中有 161 条带 HTML，`formatStr` 不转义；是否 escape 全凭各调用点自觉 | `web/strings.ts`；`web/dialog.ts:367` | 10 |
| P25 | 跨模块直接改 DOM：`#predictedConflicts`、`#cdv`、`#tableColHeaders` 在多个文件中被获取 | `web/main.ts:2603-2614`；`web/dialogActions.ts:32` | 9 |
| P26 | 测试靠 `new Function` 切源码，或启动整个 bundle | `tests/reflogClassification.test.mjs:18-23`；`tests/webviewHarness.mjs:274` | 8 |

---

## 6. 目标架构

### 6.1 宿主端目录结构（终态）

```
src/
├── extension.ts                    # 组合根：只负责构造与连线，不含逻辑
├── protocol/                       # 宿主 ↔ webview 的 seam
│   ├── messages.ts                 # Request/Response 类型（原 types/messages.ts）
│   ├── handlerTable.ts             # HandlerTable 映射类型 + dispatch()
│   ├── validate.ts                 # 入站消息最小运行时校验
│   └── handlers/                   # 每个功能域一个文件
│       ├── branches.ts             # checkoutBranch createBranch deleteBranch renameBranch …
│       ├── commits.ts              # checkoutCommit cherrypick revert drop reset undo editMessage …
│       ├── tags.ts
│       ├── remotes.ts
│       ├── stash.ts
│       ├── worktrees.ts
│       ├── operations.ts           # merge rebase continue/abort predictConflicts
│       ├── loading.ts              # loadRepos loadRepoInfo loadCommits loadConfig commitDetails …
│       ├── files.ts                # viewDiff openFile resetFileToRevision …
│       ├── settings.ts             # setGlobalSetting setRepoState user details …
│       ├── codeReview.ts
│       ├── gerrit.ts
│       └── misc.ts                 # openExternalUrl copyToClipboard openTerminal …
├── git/                            # 与 Git 打交道的一切
│   ├── process/
│   │   ├── gitProcess.ts           # 唯一进程 adapter：run / runWithInput / stream
│   │   └── errors.ts               # 统一错误格式化
│   ├── read/                       # 原 backend/：GitBackend 读 seam
│   │   ├── api.ts  addon.ts  cliBackend.ts  fallback.ts  types.ts  signatures.ts
│   │   └── index.ts                # createBackend()
│   ├── write/
│   │   ├── gitWriter.ts            # GitWriter deep module：run(repo, op)
│   │   ├── ops/                    # 每类 WriteOp 的 argv 构建（纯函数）
│   │   ├── safety.ts               # 参数注入校验（原 checkUnsafeGitArgs）
│   │   └── lossGuard.ts            # LossWarning 计算
│   ├── repoState.ts                # 原 getOperationState（rebase/merge 状态探测）
│   └── gitRepository.ts            # 对外的 Git facade：read + write + state（取代 DataSource）
├── view/
│   ├── gitGraphPanel.ts            # 面板生命周期 + HTML/CSP（原 GitGraphView 剩余部分）
│   ├── commitLoader.ts             # 分阶段加载 + 缓存（阶段 6）
│   ├── gerritCache.ts
│   ├── repoPoller.ts
│   └── html.ts                     # getHtmlForWebview
├── views/                          # 附属面板
│   ├── comparisonView.ts  binaryCompareView.ts  diffDocProvider.ts
├── repos/
│   ├── repoManager.ts  repoFileWatcher.ts  repoConfigFile.ts（导入导出 .vscode/git-graph-rs.json）
├── config/
│   ├── config.ts                   # vscode 配置读取（唯一触碰 workspace.getConfiguration 的地方）
│   └── snapshot.ts                 # ConfigSnapshot 纯数据类型
├── platform/                       # 对 vscode API 的薄 adapter（UI 副作用）
│   ├── notifications.ts  terminal.ts  clipboard.ts
├── integrations/
│   ├── gerrit.ts  pullRequests.ts  avatarManager.ts
├── automation/                     # 保持现状，只把对 currentPanel 的依赖改为注入
├── i18n.ts  logger.ts  statusBarItem.ts  extensionState.ts
└── utils/                          # 只含无领域依赖的纯工具（禁止 import git/ view/ protocol/）
```

**迁移期兼容**：测试从 `out/<旧路径>.js` 导入（`out/dataSource.js` 10 处、`out/backend/index.js` 12 处等，见附录 B）。每次移动文件都在旧路径保留一个 re-export 文件，例如 `src/dataSource.ts` → `export * from './git/gitRepository'`。阶段 12 统一修改测试导入，然后删除这些 re-export。

### 6.2 Webview 目录结构（终态）

```
web/
├── main.ts                         # 入口：创建 store、挂载各 module、连接消息
├── host/
│   ├── bridge.ts                   # VSCODE_API 包装：send(request) / onResponse
│   ├── requests.ts                 # 构造 Request 的唯一位置（替代散落的 140+ 字面量）
│   └── responseRouter.ts           # ResponseTable：command → handler（阶段 3）
├── state/
│   ├── store.ts                    # ViewStore：config / repoState / expandedCommit / 选择
│   └── persistence.ts              # saveState / globalState / workspaceState
├── graph/
│   ├── graph.ts  branch.ts  vertex.ts   # 纯布局计算（无 DOM）
│   └── graphSvg.ts                 # 渲染
├── table/
│   ├── commitTable.ts              # 原 GitGraphView 的 renderTable 与虚拟化
│   ├── refLabels.ts                # 分支 / tag 标签（含 tag 解析修复）
│   └── columns.ts                  # 原 observers 中列宽、表头部分
├── commitDetails/
│   ├── commitDetailsView.ts  fileTree.ts  codeReview.ts
├── actions/
│   ├── contextMenuActions.ts  dialogActions.ts  dataLossRisk.ts
├── widgets/
│   ├── dialog.ts  contextMenu.ts  dropdown.ts  findWidget.ts  settingsWidget/  reflogView.ts
│   ├── statisticsView.ts  worktreeDialog.ts  conflictBanner.ts
├── integrations/ gerritView.ts  pullRequestView.ts
├── text/
│   ├── html.ts                     # SafeHtml、html``、escapeHtml（阶段 10）
│   ├── strings.ts  textFormatter.ts  markdownRenderer.ts  dates.ts
├── ui/ icons.ts  dom.ts  classes.ts（原 utils.ts 拆分）
├── comparison/ binaryCompare/      # 阶段 11 迁入的独立入口
└── styles/
```

### 6.3 依赖方向（终态）

```
                  ┌───────────────────┐
                  │   extension.ts    │  组合根
                  └─────────┬─────────┘
          ┌─────────────────┼──────────────────┐
          ▼                 ▼                  ▼
   ┌────────────┐   ┌──────────────┐   ┌──────────────┐
   │   view/    │──▶│  protocol/   │──▶│    git/      │
   │ panel      │   │ handlers     │   │ gitRepository│
   │ commitLoader│  └──────┬───────┘   └──────┬───────┘
   └─────┬──────┘          │                  │
         │                 ▼                  ▼
         │          ┌──────────────┐   ┌──────────────┐
         └─────────▶│  platform/   │   │ git/process  │──▶ child_process
                    │ (vscode UI)  │   │ git/read     │──▶ .node addon
                    └──────────────┘   └──────────────┘
   config/ 只被 extension.ts、view/、protocol/ 读取，再以 ConfigSnapshot 形式向下传递
   utils/ 可被任何层引用，utils/ 自身不引用任何层
```

规则（附录 C 给出可机检的版本）：

1. `git/**` 不得 import `vscode`、`view/**`、`protocol/**`、`platform/**`、`config/config.ts`。
2. `protocol/handlers/**` 不得 import `view/**`。它们只通过 `HandlerContext` 端口访问面板能力。
3. `utils/**` 不得 import 任何非 `utils/**` 的项目模块。
4. `src/` 内不存在循环依赖。

### 6.4 关键 seam 一览

| Seam | Interface | Adapter（≥ 2 个才保留） |
|---|---|---|
| `GitBackend`（读） | 现有 30 个方法 | NativeBackend、CliBackend（已存在） |
| `GitProcess` | `run(args, cwd, opts) → Promise<ProcessResult>` | NodeGitProcess（生产）、ScriptedGitProcess（测试，按 argv 返回预设输出） |
| `GitWriter` | `run(repo, op: WriteOp, opts) → Promise<WriteResult>` | 内部 seam 只有 GitProcess；将来再加 EngineWriter |
| `HandlerContext` | `send`、`repo`、`config`、`ui`、`loader` | PanelContext（生产）、RecordingContext（测试） |
| `CommitLoader.send` | `(msg: ResponseMessage) => void` | `panel.webview.postMessage`、测试用数组收集 |
| Webview `HostBridge` | `send(req)`、`onResponse(fn)` | `acquireVsCodeApi()`、jsdom 测试桩 |

---

## 7. 实施原则与约束

1. **行为保持优先。** 除第 10 章明确列出的缺陷修复外，任何 PR 都不改变可观察行为。重构与修复不在同一个 commit 中混合。
2. **渐进替换（strangler）。** 新 module 先与旧代码并存，调用点逐批迁移；最后一个调用点迁走后，再删除旧代码。
3. **每个 PR 可独立合并、可独立回滚。** 合并后 `main` 必须可打包（`npm run package`），并通过 §23 的门禁。
4. **先测后改。** 动一个 module 之前，先在它的（新）interface 上写 characterization test，锁住当前行为，再重构。
5. **替换，不叠加。** deep module 的 interface 测试就位后，删除对应的浅层测试，并在 PR 描述中列出删除了哪些、由哪些新测试覆盖。
6. **一个 adapter 不建 seam。** 只有生产与测试都需要替换时，才引入端口类型。
7. **不改公共契约。** 不修改 `package.json` 中的 `contributes`、命令 ID、配置键、`package.nls*.json` 的键，以及 `.vscode/git-graph-rs.json` 的格式。
8. **兼容 re-export。** 每次移动文件都在旧路径保留 re-export，直到阶段 12。
9. **PR 规模**：单 PR 的净改动 ≤ 800 行（纯移动文件除外，移动单独成 PR，并用 `git mv` 保留历史）。
10. **提交规范**：沿用仓库的 Conventional Commits 风格（`refactor(core): …`、`fix(webview): …`、`test(protocol): …`）。

---

## 8. 阶段总览与依赖图

| 阶段 | 名称 | 类型 | 依赖 | 估算（人日） | 风险 |
|---|---|---|---|---|---|
| 0 | 安全网与护栏 | 工具 / 测试 | — | 2–3 | 低 |
| 1 | 修复已确认缺陷 | 修复 | 0 | 2–3 | 低 |
| 2 | 宿主端协议 handler 表 | 重构 | 0 | 4–5 | 中 |
| 3 | Webview 端响应路由表 | 重构 | 2 | 2–3 | 低 |
| 4 | GitProcess + 错误契约 | 重构 | 0 | 3–4 | 中 |
| 5 | GitWriter | 重构 | 4 | 4–5 | 中 |
| 6 | CommitLoader 抽取 | 重构 | 2 | 3–4 | 中高 |
| 7 | 配置快照、去 vscode | 重构 | 5、6 | 2–3 | 低 |
| 8 | Webview ES modules | 构建 / 重构 | 3 | 4–5 | 高 |
| 9 | ViewStore | 重构 | 8 | 5–6 | 中高 |
| 10 | SafeHtml | 重构 / 安全 | 8 | 3–4 | 中 |
| 11 | 对比视图迁入 web/ | 重构 | 2、8 | 3–4 | 中 |
| 12 | 收尾与死代码 | 清理 | 全部 | 2–3 | 低 |

```
0 ──┬──▶ 1
    ├──▶ 2 ──┬──▶ 3 ──▶ 8 ──┬──▶ 9
    │        │              ├──▶ 10
    │        ├──▶ 6 ──┐     └──▶ 11 ◀── 2
    │        │        ▼
    └──▶ 4 ──▶ 5 ──▶ 7
                              全部 ──▶ 12
```

可并行的轨道：

- **轨道 A**（宿主协议）：2 → 3 → 6
- **轨道 B**（Git 访问）：4 → 5 → 7
- **轨道 C**（webview）：在 3 完成后执行 8 → 9 / 10 / 11

两人并行时，总工期约 4–5 周（见 §26）。

---

## 9. 阶段 0 · 安全网与护栏

### 9.1 目标

在动任何结构之前：把基线固化进 CI，补上协议分发和缓存失效的 characterization test，并引入依赖规则检查。

### 9.2 任务

**T0.1 CI 门禁对齐本地命令**

- `.github/workflows/native-build.yml` 的 Node job 已运行 `build:ts`、`compile-web`、`test:node:cov`。补充以下两项：
  - `npx tsc -p ./web --noEmit`（目前 `compile-web` 会触发它，但需显式失败可见）；
  - `node scripts/check-deps.mjs`（T0.3 新增）。
- 在 `scripts/run-tests.mjs` 末尾打印测试总数，CI 用它比较基线（≥ 698，除非 PR 标签 `tests-replaced`）。

**T0.2 协议分发的 characterization test**

新增 `tests/protocolDispatch.test.mjs`：

- 用 `tests/vscodeStub.mjs` 构造一个 `GitGraphView`。如有需要，先给 `GitGraphView` 加一个仅测试使用的静态工厂 `GitGraphView.createForTest(panelStub, deps)`，构造参数与现有构造函数一致。
- 用一个记录型 `DataSource` 替身（`Proxy`：记录方法名和参数，返回 `null` 或预设值）。
- 对附录 A 中每个命令发送一条最小合法 Request，断言以下三点：
  1. 恰好回送一条同名 Response，或附录 A 中标注的多条 / 零条；
  2. 调用了预期的 DataSource 方法；
  3. 对 Mutating command，处理结束后 `commitCache` 被清空。通过一个 `__testHooks.commitCacheSize()` 读取，该钩子在阶段 6 被 CommitLoader 的 interface 取代。
- 这份测试就是阶段 2 的回归网：阶段 2 重写分发后，它必须原样通过。

**T0.3 依赖规则检查脚本**

新增 `scripts/check-deps.mjs`，零依赖，约 120 行：

- 用 TypeScript 编译器 API（`typescript` 已是 devDependency）解析 `src/**/*.ts` 的 import，建立依赖图。
- 检查附录 C 的规则；检测环（Tarjan SCC）。
- 支持 `--baseline scripts/deps-baseline.json`：首次运行时把当前违规写入基线，CI 只拒绝**新增**违规。每消除一条违规，就把它从基线中删掉，只减不增。
- 将其加入 `npm run lint`。

**T0.4 建立 GLOSSARY.md**

在仓库根目录创建 `GLOSSARY.md`，写入 §3 的领域词汇表（不含实现细节），供后续评审和 PR 描述统一用词。

**T0.5 测试辅助**

- 新增 `tests/helpers/tempRepo.mjs`：创建临时 git 仓库、提交、建分支、打 tag 的工具函数。目前多个测试各自实现了一份，先抽出来，后续阶段复用。
- 新增 `tests/helpers/recordingDataSource.mjs`（T0.2 使用）。

### 9.3 验收

- [ ] CI 新增的步骤在 `main` 上为绿。
- [ ] `tests/protocolDispatch.test.mjs` 覆盖附录 A 的全部约 86 个 Request 命令。
- [ ] `scripts/deps-baseline.json` 已生成，并记录当前的违规（预计至少包含 P15 的环和 P13 的 vscode 引用）。
- [ ] `GLOSSARY.md` 已合并。

---

## 10. 阶段 1 · 修复已确认缺陷

每个缺陷单独一个 PR，并遵循“先写失败测试 → 修复 → 测试通过”。✔ 表示评审中已读代码核实；◐ 表示探查发现、需在写测试时确认复现。

### 10.1 [✔] B1 引擎错误以对象进入 `error` 字段

**现象**：Rust 引擎在 Native 路径上读失败时（例如坏 revision），webview 收到的 `error` 不是字符串。经 VS Code 的消息序列化后，它是 `{}` 或 `[object Object]`，用户看不到错误原因。

**根因**：`callJson` 抛出 `GitBackendError`（`src/backend/addon.ts:256`）。DataSource 在 `.then(ok, (errorMessage) => ({ …, error: errorMessage }))` 中直接使用 reject 值（`src/dataSource.ts:244, 580, 739, 766, 781, 794, 809, 829, 929`）。

**修复（止血，阶段 4 再根治）**：

```ts
// src/dataSource.ts（新增私有工具，替换 9 处 reject 回调中的 errorMessage）
function toErrorInfo(reason: unknown): string {
	if (reason instanceof Error) return reason.message;
	return typeof reason === 'string' ? reason : String(reason);
}
// 例：getRepoInfo
}, (reason) => <GitRepoInfo>{ branches: [], head: null, remotes: [], stashes: [], tags: [], error: toErrorInfo(reason) });
```

**测试**：在 `tests/backends.test.mjs` 中新增用例。对 Native 与 CLI 两个 backend，分别以不存在的 revision 调用 `DataSource.getCommitDetails` 和 `getCommitComparison`，断言 `typeof result.error === 'string' && result.error.length > 0`。

**额外防线**：在 `GitGraphView.sendMessage` 的开发模式下（`process.env.GG_STRICT_PROTOCOL === '1'`，测试中开启），断言所有 `error` / `errors[i]` 字段都是 `string | null`。

### 10.2 [✔] B2 配置变更后读到旧配置

**现象**：在设置中修改 `dateFormat`、`commitOrdering`、`showRemoteBranches`、`fileTreeCompactFolders`、`enhancedAccessibility`、`referenceInputSpaceSubstitution`、`combineLocalAndRemoteBranchLabels`、`customEmojiShortcodeMappings`、`dialogDefaults.fetchRemote.*`、`customPullRequestProviders` 后，webview 中依赖这些值的地方仍按旧值工作，直到重新打开面板。

**根因**：`applyConfig`（`web/main.ts:1062`）只更新 `this.config`，下列 16 处仍读 `initialState.config`：

```
web/dialog.ts:288, 290            web/main.ts:2536, 3170
web/repoLoadOptions.ts:6,18,24,30,36,42,48,54
web/fileTree.ts:10, 105           web/settingsWidget.ts:750, 751, 1278
web/utils.ts:347, 404
```

**修复（阶段 9 由 ViewStore 根治，这里先做最小修复）**：

1. 在 `web/utils.ts` 顶部新增唯一访问点：

   ```ts
   let currentConfig: GG.GitGraphViewConfig = initialState.config;
   function getConfig(): GG.GitGraphViewConfig { return currentConfig; }
   function setCurrentConfig(config: GG.GitGraphViewConfig) { currentConfig = config; }
   ```

2. `applyConfig` 中调用 `setCurrentConfig(config)`。必须在调用 `getShowRemoteBranches` 等之前调用。
3. 把上面 16 处 `initialState.config` 替换为 `getConfig()`。`main.ts:140` 的构造初值保留。
4. `TextFormatter.registerCustomEmojiMappings` 在 `applyConfig` 中以新值重新注册。需确认其实现会覆盖旧映射；若只会追加，就增加一个 `reset` 参数。
5. 新增 lint 规则：在 `scripts/check-deps.mjs` 中加入文本检查，`web/**` 中 `initialState.config` 只允许出现在 `utils.ts` 的这一处初始化。

**测试**：扩展 `tests/webviewConfigChanged.test.mjs`。发送 `configChanged`，把 `dateFormat` 从 `Date & Time` 改为 `ISO`，断言重新渲染后日期列为 ISO 格式；`commitOrdering` 改变后，下一次 `loadCommits` 请求携带新值。

### 10.3 [✔] B3 带 `/` 的本地 tag 被渲染为远程 tag

**现象**：本地 tag `release/1.0` 显示为远程 `release` 上的 tag `1.0`，并且没有本地标记。

**根因**：`web/main.ts:1620-1626` 按 `/` 拆分所有 tag 名，但本地 tag 名本身可以包含 `/`（`cliBackend.ts:1094-1097` 原样输出 `refs/tags/` 之后的部分）。远程 tag 的编码是 `<remote>/<name>`（`cliBackend.ts:1115-1124`）。

**修复（修协议，不猜测）**：

1. `GitCommitTag`（`src/types/git.ts`）新增 `readonly remote: string | null`。本地 tag 为 `null`，远程 tag 为远程名，`name` 改为不带远程前缀的 tag 名。为保持兼容，同时保留 `fullName`（旧的 `name` 语义），供 webview 中按全名查找的地方使用。
2. CliBackend 的 `refData.tags.push` 两处（本地 / 远程）填充 `remote`。
3. Rust 侧 `native/core/src/refs.rs` 输出同样的字段，并更新 `native/core/src/types.rs` 的序列化结构。`tests/backends.test.mjs` 的跨 backend 一致性测试会自动覆盖。
4. webview 改为使用 `tag.remote`，不再拆分字符串。
5. 排查所有消费 `commit.tags[i].name` 的地方（`grep -n "tags\[" web/*.ts`、右键菜单、tag 详情、删除 tag），确保使用的是正确字段。

**测试**：

- Rust：`native/core/tests/log_and_refs.rs` 新增两个场景，本地 `release/1.0`，以及远程 `origin/tags/release/1.0` 场景下的远程 tag。
- Node：`tests/backends.test.mjs` 新增两个 backend 输出一致的断言。
- Webview：`tests/webviewRealPipeline.test.mjs` 新增用例，断言 `.gitRef.tag[data-name="release/1.0"]` 存在且没有远程标记。

### 10.4 [✔] B4 原型键崩溃（tag 名为 `constructor` / `toString` / `__proto__`）

**修复**：`web/main.ts:1620` 的 `tagMap` 改为 `new Map<string, …>()`。同时排查 webview 中所有以用户数据为键的 `{}` 字面量，统一改为 `Map` 或 `Object.create(null)`：

```
grep -nE ":\s*\{\s*\[[a-zA-Z]+: string\]" web/*.ts
```

对每个结果判断键是否可能来自 Git 数据（ref 名、作者、路径、远程名）。以 hash 为键的可以保留。

**测试**：在 `tests/webviewRealPipeline.test.mjs` 中创建名为 `constructor` 和 `__proto__` 的 tag（git 允许这两个名字），断言整行渲染成功。

### 10.5 [◐] B5 follow-up promise 未处理拒绝

**位置**：`src/gitGraphView.ts:1086, 1105, 1132-1135`。

**修复**：所有 `void promise.then(...)` 改为 `void promise.then(...).catch((e) => this.logger.logError('loadCommits follow-up failed: ' + e))`。阶段 6 会把这段逻辑整体移入 CommitLoader，并让 follow-up 也在 mute 窗口内执行（见 §15.4）。

**测试**：在 T0.2 的分发测试中让替身 DataSource 的 `getCommits` 第二次调用时抛错，断言 `process.on('unhandledRejection')` 没有触发，并且 logger 记录了错误。

### 10.6 [◐] B6 comparisonView 消息处理

**位置**：`src/comparisonView.ts:61-105`。

**修复**：

1. handler 整体加 `try/catch`，捕获后记录日志，并回送 `{ command: 'error', message }`。webview 端显示错误。
2. `viewDiff` / `requestCounts` 中访问 `this.fileChanges[msg.index]` 之前加边界检查：`Number.isInteger(msg.index) && msg.index >= 0 && msg.index < this.fileChanges.length`，越界时忽略。

**测试**：新增 `tests/comparisonView.test.mjs`，在加载完成前发送 `viewDiff {index: 0}`，断言没有异常、没有调用 `vscode.commands.executeCommand`。

### 10.7 [◐] B7 repoManager 置顶写入竞态与浮动 promise

**位置**：`src/repoManager.ts:473-489`（`writeRepoPins`）、`:84`（`this.startupTasks()`）。

**修复**：

1. `writeRepoPins` 改为按文件路径串行化。维护 `Map<string, Promise<void>>`，新写入链接在上一次写入之后：`chain = prev.then(() => doWrite(latestPins))`，并且只写**最新**的状态（合并排队中的写入）。`pinsWriteInFlight` 改为由该链的完成来维护。
2. `startupTasks()` 改为 `.catch(e => this.logger.logError(...))`。

**测试**：新增 `tests/repoManager.test.mjs`（目前没有直接测试）。连续触发 3 次置顶变更，断言最终文件内容等于最后一次状态，且写入次数 ≤ 2。

### 10.8 [◐] B8 静默吞错与 addon 加载失败记忆

- `src/dataSource.ts:218` 的 `trackRemoteTags` 中 `catch (e) {}` 改为记录日志。行为不变，仍不向用户报错，因为这是后台动作。
- `src/backend/addon.ts:185-196`：当候选二进制存在但加载失败时，继续尝试下一个候选（`target/release`、`target/debug`），全部失败才记录 `loadFailure`。另外让 `loadAddon(root)` 的缓存以 `root` 为键，修复“`describeCapabilities({addonRoot})` 报告的是错误二进制”的问题。
- 测试：`tests/backends.test.mjs` 中用临时目录放一个损坏的 `.node` 文件作为第一个候选，断言回退到第二个候选。

### 10.9 阶段 1 验收

- [ ] B1–B4 各有一个修复 PR，每个 PR 包含一个在修复前失败的测试（PR 描述中附 CI 失败链接或本地输出）。
- [ ] B5–B8 已确认复现并修复；无法复现的，需在 PR 中记录调查结论并关闭。
- [ ] `CHANGELOG`（如有）或 release notes 列出用户可见的修复。

---

## 11. 阶段 2 · 宿主端协议 handler 表

### 11.1 现状：新增一条写消息要改的文件

1. `src/types/messages.ts`：Request 和 Response 接口，以及两个联合类型
2. `src/dataSource.ts`：方法
3. `src/gitGraphView.ts`：`case` 分支，以及 `REPO_MUTATING_COMMANDS`
4. `web/main.ts`：响应 `switch` 的分支
5. 发送该消息的 web 模块
6. `web/strings.ts`：错误文案
7. `src/automation/catalog.ts`
8. 测试

阶段 2 和 3 完成后，第 1、3、4 项合并为**一个类型定义 + 一个 handler 条目 + 一个响应条目**，并且漏写任何一项都是编译错误。

### 11.2 设计

```ts
// src/protocol/handlerTable.ts
import type { RequestMessage, ResponseMessage } from './messages';

export type RequestCommand = RequestMessage['command'];
export type RequestOf<C extends RequestCommand> = Extract<RequestMessage, { command: C }>;

/** Everything a handler may touch. The panel supplies the production adapter; tests a recording one. */
export interface HandlerContext {
	readonly git: GitRepositoryPort;          // 阶段 2 时就是 DataSource 实例（结构类型）
	readonly send: (msg: ResponseMessage) => void;
	readonly ui: UiPort;                      // showErrorMessage / openExternal / clipboard / terminal
	readonly view: ViewPort;                  // 面板级能力：loadRepos、setRepoState、commitLoader 等
	readonly logger: Logger;
	/** Forward a data-loss warning; TRUE when one was forwarded and the handler must not respond. */
	readonly forwardLossWarning: (result: unknown, request: RequestMessage) => boolean;
}

export interface Handler<C extends RequestCommand> {
	/** Can this command change HEAD, refs, stash, index, working tree or git config? */
	readonly mutates: boolean;
	run(msg: RequestOf<C>, ctx: HandlerContext): Promise<void>;
}

/** One entry per command: a missing or misspelt key is a compile error (mapped type + excess property check). */
export type HandlerTable = { readonly [C in RequestCommand]: Handler<C> };

export async function dispatch(table: HandlerTable, msg: RequestMessage, ctx: HandlerContext): Promise<{ mutated: boolean }> {
	const handler = table[msg.command] as Handler<RequestCommand> | undefined;
	if (handler === undefined) {
		ctx.logger.logError(`Unknown webview command "${String((msg as { command?: unknown }).command)}"`);
		return { mutated: false };
	}
	await handler.run(msg as never, ctx);
	return { mutated: handler.mutates };
}
```

按域拆分的 handler 文件只导出部分表，最后合并：

```ts
// src/protocol/handlers/branches.ts
import type { HandlerTable } from '../handlerTable';

export const branchHandlers = {
	createBranch: {
		mutates: true,
		async run(msg, ctx) {
			const errors = await ctx.git.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force, msg.confirmed);
			if (ctx.forwardLossWarning(errors, msg)) return;
			ctx.send({ command: 'createBranch', errors: errors as ErrorInfo[] });
		}
	},
	// …
} satisfies Partial<HandlerTable>;

// src/protocol/handlers/index.ts
export const handlerTable: HandlerTable = {
	...branchHandlers, ...commitHandlers, ...tagHandlers, ...remoteHandlers, ...stashHandlers,
	...worktreeHandlers, ...operationHandlers, ...loadingHandlers, ...fileHandlers,
	...settingsHandlers, ...codeReviewHandlers, ...gerritHandlers, ...miscHandlers
};
```

> **类型细节**：`satisfies Partial<HandlerTable>` 保证每个分表的键合法、`msg` 被正确收窄。最终的 `handlerTable: HandlerTable` 赋值保证完整性。展开合并时，如果两个分表定义了同一个键，TypeScript 不会报错，所以 `tests/protocolDispatch.test.mjs` 需加一条断言：各分表的键集合两两不相交。该测试从 `out/protocol/handlers/*.js` 读取分表。
>
> `satisfies` 需要 TypeScript ≥ 4.9，仓库是 `^5.4.0`，满足。

### 11.3 运行时最小校验（P4）

```ts
// src/protocol/validate.ts
export function isRequestEnvelope(msg: unknown): msg is { command: string; repo?: unknown } {
	return typeof msg === 'object' && msg !== null && typeof (msg as { command?: unknown }).command === 'string';
}
```

只校验信封（`command` 是字符串，`repo` 若存在则是字符串）。字段级校验仍由 handler 内已有的 `checkUnsafeGitArgs` 负责，阶段 5 之后由 `GitWriter` 负责。不引入 schema 库。

### 11.4 GitGraphView 中的改动

```ts
private async respondToMessage(msg: unknown) {
	if (!isRequestEnvelope(msg)) { this.logger.logError('Malformed webview message'); return; }
	this.repoFileWatcher.mute();
	let mutated = false;
	try {
		({ mutated } = await dispatch(handlerTable, msg as RequestMessage, this.handlerContext));
	} catch (error) {
		this.logger.logError('Failed to handle "' + (msg as RequestMessage).command + '" message: ' + error);
		showErrorMessage(t('actionHandlingError'));
		mutated = handlerTable[(msg as RequestMessage).command]?.mutates ?? false;
	} finally {
		this.repoFileWatcher.unmute();
		if (mutated) this.commitCache.clear();   // 阶段 6 改为 this.commitLoader.invalidate()
	}
}
```

- `REPO_MUTATING_COMMANDS` 删除。它的 42 个成员逐一映射为对应 handler 的 `mutates: true`，见附录 A。**迁移 PR 必须附上一个一次性脚本的输出，证明映射结果与旧集合完全相等。** 也可以在 T0.2 测试中断言 `Object.entries(handlerTable).filter(([,h]) => h.mutates).map(([k]) => k).sort()` 等于旧集合。
- `this.handlerContext` 在构造函数中创建一次，捕获 `this` 的必要能力。`ViewPort` 只暴露 handler 实际用到的方法（从 85 个 case 中统计得出，预计 15–20 个），不暴露整个 GitGraphView。

### 11.5 实施步骤（PR 粒度）

| PR | 内容 | 规模 |
|---|---|---|
| 2.1 | 新增 `protocol/handlerTable.ts`、`validate.ts`、`HandlerContext` 及其生产实现（委托给 GitGraphView 的现有私有方法）；`dispatch` 先不接入 | ~250 行 |
| 2.2 | 迁移 `misc` + `files` + `settings` 域（约 25 个命令）。`handleMessage` 中这些 case 改为 `return dispatch(...)`，其余 case 不动；临时用 `Partial<HandlerTable>` | ~600 行 |
| 2.3 | 迁移 `branches` + `tags` + `remotes` + `stash`（约 25 个） | ~700 行 |
| 2.4 | 迁移 `commits` + `operations` + `worktrees` + `codeReview` + `gerrit`（约 25 个） | ~700 行 |
| 2.5 | 迁移 `loading` 域（`loadCommits` 暂时整体委托给 `view.loadCommits(msg)`，阶段 6 再拆）。删除 `switch`、`REPO_MUTATING_COMMANDS`；表类型改为完整的 `HandlerTable` | ~400 行 |
| 2.6 | 将 `types/messages.ts` `git mv` 到 `protocol/messages.ts`，旧路径保留 re-export；`web/global.d.ts` 的导入路径同步修改 | 移动 |
| 2.7 | 用编译期保证替换 `tests/contract.test.mjs` 中的两个正则用例：改为断言 `handlerTable` 的键集合等于 `messages.ts` 中 Request 的命令集合（从 `out/protocol/handlers/index.js` 读取），保留其余契约测试（命令注册、图标） | ~80 行 |

### 11.6 验收

- [ ] `src/gitGraphView.ts` 中不再有 `switch (msg.command)`，行数减少 ≥ 700。
- [ ] 在 `messages.ts` 中新增一个 Request 而不写 handler，`tsc -p ./src` 会失败（在 PR 描述中贴出验证截图或输出）。
- [ ] `tests/protocolDispatch.test.mjs` 不经修改即全部通过。
- [ ] mutating 集合与旧 `REPO_MUTATING_COMMANDS` 完全相等。
- [ ] `src/automation/catalog.ts` 的命令清单测试 `automationCatalog.test.mjs` 仍然通过。

---

## 12. 阶段 3 · Webview 端响应路由表

### 12.1 设计

阶段 8 之前 webview 仍是全局脚本，所以本阶段只用类型和数据结构，不依赖模块系统。

```ts
// web/responseRouter.ts（阶段 8 后移入 web/host/）
type ResponseCommand = GG.ResponseMessage['command'];
type ResponseOf<C extends ResponseCommand> = Extract<GG.ResponseMessage, { command: C }>;

/** 约 60 个响应只是“成功则刷新、失败则报错”：用数据描述，不写代码。 */
type Outcome =
	| { kind: 'refresh'; error: keyof WebviewStrings; configChanges?: boolean }        // refreshOrDisplayError
	| { kind: 'refreshMulti'; error: keyof WebviewStrings; configChanges?: boolean }   // refreshAndDisplayErrors
	| { kind: 'checkout'; error: keyof WebviewStrings }                                // refreshAfterCheckout
	| { kind: 'finish'; error: keyof WebviewStrings }                                  // finishOrDisplayError
	| { kind: 'custom'; handle: (msg: any) => void };

type ResponseTable = { readonly [C in ResponseCommand]: Outcome | ((msg: ResponseOf<C>) => void) };
```

- `Outcome` 中的 `error` 存的是**字符串键**，而不是 `strings.errX` 的值。原因是 `strings` 在切换语言后会被替换，这里必须在调用时读取。这样也修复了一个潜在问题：语言切换后，若在表构造时就取值，错误文案会停留在旧语言。
- 有分支逻辑的响应（`addTag`、`checkoutBranch`、`deleteBranch`、`predictConflicts`、`loadCommits` 等约 30 个）使用函数形式，函数体从原 `case` 原样搬入。
- `checkoutBranch` 的错误键依赖 `msg.pullAfterwards`，用函数形式表达。

### 12.2 实施步骤

| PR | 内容 |
|---|---|
| 3.1 | 新增 `web/responseRouter.ts`（类型 + `routeResponse(msg)`），把 4 个 `refresh*/finish*` 辅助函数移入；`handleResponseMessage` 中先迁移所有“一行式”分支 |
| 3.2 | 迁移其余分支；删除 `switch`；`window.addEventListener('message')` 改为调用 `routeResponse` |
| 3.3 | 合并 `refreshAfterCheckout` 与 `refreshAndDisplayErrors`（前者 = 后者 `configChanges=false`，区别只在注释）。保留注释说明“软刷新”的原因 |

### 12.3 测试

- 新增 `tests/webviewResponseRouter.test.mjs`：用 `webviewHarness` 启动一次，遍历一个“命令 → 期望行为（刷新 / 报错 / 无操作）”的表，覆盖全部 `Outcome` 类型的命令，每个命令各发一条成功响应和一条失败响应。
- 现有 `webview*.test.mjs` 不修改，全部通过。

### 12.4 验收

- [ ] `web/main.ts` 中不再有响应 `switch`，减少 ≥ 300 行。
- [ ] 在 `messages.ts` 中新增一个 Response 而不在表中登记，`tsc -p ./web` 会失败。

---

## 13. 阶段 4 · GitProcess：统一进程 adapter 与错误契约

### 13.1 现状

| 位置 | 函数 | 特点 |
|---|---|---|
| `dataSource.ts` | `_spawnGit` | `cp.spawn`，收集 stdout Buffer，失败时 reject `getErrorMessage(...)` |
| `dataSource.ts` | `runGitCommand` | `_spawnGit` + `catch → string` |
| `dataSource.ts` | `runGitCommandWithInput` | 自建 spawn + stdin |
| `dataSource.ts` | `gitOutputWithInput` | 同上，返回 stdout |
| `dataSource.ts` | `spawnGitStream` | 返回流（hexDiff 使用） |
| `cliBackend.ts` | `run`、`runRaw`、内联 `execFile` | `execFile`，trim 之后取 `stderr‖stdout` |

### 13.2 设计

```ts
// src/git/process/gitProcess.ts
export interface ProcessResult { readonly stdout: Buffer; readonly stderr: string; readonly code: number | null; }

export interface GitProcessOptions {
	readonly cwd: string;
	readonly input?: string | Buffer;          // 写入 stdin
	readonly env?: Readonly<Record<string, string>>;  // 叠加在 process.env + askpass env 之上
	readonly signal?: AbortSignal;
	readonly maxBuffer?: number;
}

export interface GitProcess {
	/** Resolves for any exit code; rejects only when the process could not be started. */
	exec(args: ReadonlyArray<string>, opts: GitProcessOptions): Promise<ProcessResult>;
	stream(args: ReadonlyArray<string>, opts: GitProcessOptions): ChildProcessWithoutNullStreams;
	readonly executable: GitExecutable | null;
}

// src/git/process/errors.ts —— 唯一的错误格式化
export function formatGitError(result: ProcessResult | Error): string { /* 规则见 13.3 */ }

// 便捷函数（替换旧的 runGitCommand / gitOutput 语义）
export async function runGit(p: GitProcess, args, opts): Promise<ErrorInfo>        // 0 → null，否则 → formatGitError
export async function gitOutput(p: GitProcess, args, opts): Promise<string>         // 0 → stdout，否则 → throw GitCommandError
```

- `NodeGitProcess`：生产 adapter，集中处理 `gitExecutable === null`（返回 `unableToFindGitMsg()`）、askpass 环境变量、`windowsHide` 和日志（命令 + 耗时，目前散落在各 runner 中）。
- `ScriptedGitProcess`：测试 adapter。按 argv 前缀匹配预设的 `ProcessResult`，记录所有调用。阶段 5 的 GitWriter 测试主要使用它；需要真实语义的测试使用 `tempRepo` + `NodeGitProcess`。

### 13.3 统一错误格式（需决策，见 ADR-0002）

两种现有格式会产生不同的用户文案：

- DataSource：`(stderr + stdout)` 按行拆分，**去掉最后一个元素**（通常是末尾换行产生的空串），再用 `\n` 连接。
- CliBackend：`(stderr || stdout).trim()`。

**建议**：统一采用 DataSource 的规则。它是原版 vscode-git-graph 的行为，所有写操作的错误文案都基于它，webview 中有依赖错误内容的判断（例如 `deleteBranch` 检查 `includes('git branch -D')`，见 `web/main.ts`）。CliBackend 的读错误改为同一规则后，只影响读失败时的文案，不影响逻辑。实施时 `grep -rn "includes('" web/ src/` 列出所有依赖错误文本的判断，逐一确认不受影响。

**错误契约（根治 B1）**：

- `GitBackend` 的所有读方法**一律以 reject `GitBackendError` 表示失败**。CliBackend 不再在响应里带 `error: string`：其内部 `run` 失败时抛出 `new GitBackendError('Git', formatGitError(r))`。
- DataSource（阶段 5 之后为 GitRepository）是唯一把 reject 转换为 `ErrorInfo` 的地方，使用 `toErrorInfo`（B1 引入）。
- `FallbackBackend` 的回退判断（`isFallbackWorthy`）不变。

### 13.4 实施步骤

| PR | 内容 |
|---|---|
| 4.1 | 新增 `git/process/*` 和 `ScriptedGitProcess`（放在 `src/git/process/testing.ts`，打包时由 `.vscodeignore` 排除，或者放入 `tests/helpers/`）；补单元测试 |
| 4.2 | DataSource 的 5 个 runner 改为委托 GitProcess，对外签名不变 |
| 4.3 | CliBackend 的 3 个 runner 改为委托 GitProcess；错误改为 reject `GitBackendError` |
| 4.4 | DataSource 读方法中的 `.then(ok, reject)` 统一使用 `toErrorInfo`；删除 CliBackend 响应中的 `error` 字段（需同步修改 `backend/types.ts` 的 DTO 和 `tests/backends.test.mjs` 的断言） |
| 4.5 | `hexDiff.ts` 的 `GitStreamSpawner` 改为由 `GitProcess.stream` 提供（它已经是一个良好的 seam，只替换 adapter） |

### 13.5 验收

- [ ] `grep -rnE "cp\.spawn|execFile\(" src/ | grep -v git/process/` 无结果（`askpass` 与 `findGit` 除外，列入白名单）。
- [ ] `tests/backends.test.mjs` 新增“两个 backend 的失败都以 reject `GitBackendError` 表示，且 `message` 相同”的一致性用例。
- [ ] 日志格式不变，`scripts/analyze-log.mjs` 能解析新旧两种日志。

---

## 14. 阶段 5 · GitWriter：写路径深化

### 14.1 设计目标

把“参数校验 → 丢失保护 → argv 构建 → 执行 → 引擎句柄失效 → 结果归一”这条在 41 个写方法中各自重复的流水线，收进**一个 deep module**。interface 只有一个方法，行为全在内部。

```ts
// src/git/write/ops/types.ts —— WriteOp 是可判别联合，字段与原方法参数一一对应
export type WriteOp =
	| { kind: 'createBranch'; branchName: string; commitHash: string; checkout: boolean; force: boolean }
	| { kind: 'deleteBranch'; branchName: string; force: boolean }
	| { kind: 'checkoutCommit'; commitHash: string }
	| { kind: 'merge'; obj: string; actionOn: MergeActionOn; createNewCommit: boolean; squash: boolean; noCommit: boolean }
	| { kind: 'addRemote'; name: string; url: string; pushUrl: string | null; fetch: boolean }
	// … 41 种，见附录 B
	;

// src/git/write/gitWriter.ts
export interface WriteOptions { readonly confirmed?: boolean; }
export type WriteResult = ErrorInfo[] | LossWarning;

export class GitWriter {
	constructor(private readonly process: GitProcess,
	            private readonly reads: GitBackend,               // 丢失保护需要读
	            private readonly policy: () => WritePolicy,       // signCommits 等：阶段 7 由 ConfigSnapshot 提供
	            private readonly onRepoConfigChanged: (repo: string) => void) {}  // 关闭引擎句柄

	async run(repo: string, op: WriteOp, opts: WriteOptions = {}): Promise<WriteResult> {
		const unsafe = checkOp(op);                            // safety.ts：按 op 声明的字段类型校验
		if (unsafe !== null) return [unsafe];
		if (!opts.confirmed) {
			const warning = await lossGuard(op, repo, this.reads);
			if (warning !== null) return warning;
		}
		const steps = buildSteps(op, this.policy());           // ops/*.ts：纯函数，op → string[][]（可多步）
		const results: ErrorInfo[] = [];
		for (const step of steps) {
			const r = await runGit(this.process, step.args, { cwd: repo, input: step.input });
			results.push(r);
			if (r !== null && step.stopOnError) break;
		}
		if (touchesConfig(op)) this.onRepoConfigChanged(repo);
		return results;
	}
}
```

**为什么用判别联合而不是 41 个方法**：

- 校验规则可以声明在 op 的字段上（`safety.ts` 中维护 `const FIELD_KINDS: { [K in WriteOp['kind']]: Partial<Record<keyof Extract<WriteOp,{kind:K}>, 'hash'|'ref'|'stash'|'url'>> }`），由编译器确保每个 op 都声明了校验规则。这会把约 40 处重复的序言收成一张表。
- argv 构建是纯函数 `buildSteps(op, policy)`，不用 git 就能做穷尽的快照测试。
- 将来接 Rust 写路径（GAPS.md Phase 4–8）时，只需新增一个按 `op.kind` 选择 adapter 的分支。

**丢失保护（LossWarning）**：现有逻辑（如 `createBranch` 中的 `detachedCommitsLossWarning`）有精细的时序要求（见 `src/dataSource.ts:1441-1450` 的注释：必须在**任何**命令之前运行，否则 warning 会落在 `statuses[1]`）。`lossGuard` 集中实现这一时序，并把这段注释原样迁移过去。

### 14.2 返回值形状

现有方法有的返回 `ErrorInfo`，有的返回 `ErrorInfo[]`，有的返回 `(ErrorInfo | LossWarning)[]`。在 GitWriter 内部统一为 `ErrorInfo[] | LossWarning`。

为不改变协议，`GitRepository`（DataSource 的继任者）保留**与原方法同名同签名的薄包装**，转换回原有形状。这样 handler 和测试都不需要改。这些包装是有意保留的 adapter：协议形状是 webview 的契约，阶段 12 时再评估是否把协议也统一为 `errors: ErrorInfo[]`。

### 14.3 迁移顺序与 PR

每个 PR 迁移一组 op。DataSource 中对应方法的方法体替换为 `return adaptSingle(await this.writer.run(repo, { kind: 'x', ... }, { confirmed }))`。

| PR | Op 组 | 数量 | 说明 |
|---|---|---|---|
| 5.1 | 框架：`gitWriter.ts`、`safety.ts`、`lossGuard.ts`、`ops/types.ts`；迁移 `tags`（addTag、deleteTag） | 2 | 打通流水线 |
| 5.2 | Branches：checkoutBranch、createBranch、deleteBranch、deleteRemoteBranch、renameBranch | 5 | 含丢失保护 |
| 5.3 | Commit 操作：checkoutCommit、resetToCommit、undoLastCommit、amendLastCommit、editCommitMessage、resetCurrentBranchToRemote、dropCommit、createFixupCommit、createSquashCommit | 9 | 签名策略、`areStagedChanges` 前置读 |
| 5.4 | Merge / cherry-pick / revert / rebase / continue / abort | 6 | 多步流程 |
| 5.5 | Remote：addRemote、deleteRemote、editRemote、pruneRemote、fetch、fetchIntoLocalBranch、pullBranch、pushBranch、pushBranchToMultipleRemotes、pushTag、trackRemoteTags | 11 | `touchesConfig` → 关闭引擎句柄（替换 3 处“see addRemote”式的特殊处理） |
| 5.6 | Stash、Worktree、working tree：applyStash、popStash、dropStash、pushStash、branchFromStash、addWorktree、removeWorktree、pruneWorktrees、cleanUntrackedFiles、resetFileToRevision | 10 | |
| 5.7 | Config / 其它：setConfigValue、unsetConfigValue、archive | 3 | `openExternalDirDiff`、`openGitTerminal` 不属于写 op，移入 `platform/terminal.ts`（阶段 7） |
| 5.8 | 收口：`runGitCommand` / `gitOutput` 改为 `private`；`commands.ts`、`gitGraphView.ts` 的 10 处直接调用改为 GitWriter op，或 GitRepository 上新增的具名读方法（如 `gerritPushRef` 相关读取）；`gerrit.ts` 继续使用其 `GitRunner` 结构接口，由 GitRepository 提供 | — | P12 |

### 14.4 测试

- **argv 快照测试**（新增 `tests/gitWriterArgs.test.mjs`）：每种 op × 关键参数组合（force / signCommits / squash……），断言 `buildSteps` 的输出。先基于**旧实现**用 `ScriptedGitProcess` 捕获 argv 生成快照，再在新实现上比对，这是本阶段最重要的回归网。
- **安全测试**：对每个带 `ref`、`hash` 字段的 op，以 `--upload-pack=evil` 等值调用，断言返回错误且 `ScriptedGitProcess` 没有记录任何调用。现有的 `fuzz.test.mjs` 若已覆盖，就改为对 GitWriter interface 运行。
- **语义测试**：现有 `checkoutProtection`、`fixupSquash`、`editCommitMessage`、`worktree`、`conflictPrediction` 等使用真实仓库的测试保持不变，它们经由 DataSource → GitWriter 自然覆盖。
- **替换**：DataSource 上纯 argv 层面的旧测试（若有）在快照测试就位后删除。

### 14.5 验收

- [ ] `checkUnsafeGitArgs` 的调用点只剩 `safety.ts` 中的 1 处。
- [ ] `getConfig().signCommits` 在 `src/git/**` 中出现 0 次（改由 `WritePolicy` 提供）。
- [ ] `runGitCommand` / `gitOutput` 不再出现在 `git/` 以外的调用中。
- [ ] `dataSource.ts` 降到 ≤ 900 行，或者已经重命名为 `git/gitRepository.ts`、旧路径只剩 re-export。

---

## 15. 阶段 6 · CommitLoader：从 GitGraphView 抽出加载管线

### 15.1 范围

从 `src/gitGraphView.ts` 抽出以下内容：

- `loadCommits` 分支的编排（`:1062-1141`）：首屏 → 远程 refs follow-up → Gerrit follow-up → 未提交变更 follow-up。
- 提交缓存（`commitCache`、`COMMIT_CACHE_LIMIT`、`getCommitsCached`、`commitsCacheKey`，`:82, 2369-2400`）。
- `loadCommitsRefreshId`，以及“webview 是否正在渲染”的状态（`:281-290`）。
- Gerrit 变更缓存、自适应 fetch 窗口、代数计数器（`:341-353, 1983-2337`），独立为 `view/gerritCache.ts`，由 CommitLoader 持有。
- `remoteRefsFollowUpChanged`（目前导出给测试使用）。

### 15.2 Interface

```ts
// src/view/commitLoader.ts
export interface CommitLoaderDeps {
	readonly git: CommitReads;                 // getCommits / getRepoInfo / listChangeRefHashes / parseGerritMetas …（结构类型子集）
	readonly send: (msg: ResponseLoadCommits) => void;
	readonly config: () => LoaderConfig;       // 纳入缓存键的策略值（showRemoteHeads 等），解决 P14
	readonly logger: Logger;
	readonly mutedWhile: <T>(work: () => Promise<T>) => Promise<T>;   // 让 follow-up 在 watcher mute 窗口内执行
}

export class CommitLoader {
	constructor(deps: CommitLoaderDeps);
	/** Answer one loadCommits request: the first response now, follow-ups as they become ready. Never rejects. */
	load(msg: RequestLoadCommits): Promise<void>;
	/** Drop every cached answer (a mutating command ran, or the repository changed on disk). */
	invalidate(): void;
	dispose(): void;
}
```

interface 只有 3 个方法，背后是约 900 行的分阶段编排、缓存和 Gerrit 逻辑。这是本计划中 depth 最大的抽取。

### 15.3 关键设计决定

1. **缓存键包含策略值**：`commitsCacheKey` 增加 `config()` 中影响结果的字段（`showRemoteHeads`、`useMailmap`、`showUncommittedChanges`、`showUntrackedFiles`、`showCommitsOnlyReferencedByTags`）。这样 `gitGraphView.ts:516` 在配置变化时清空缓存的逻辑可以删除，失效变得精确。
2. **`getCommits` 改用选项对象**：`dataSource.getCommits` 的 17 个位置参数改为一个 `CommitQuery` 对象（阶段 5 已完成 GitRepository 的改名时一并进行）。`RequestLoadCommits` 到 `CommitQuery` 的映射只在 CommitLoader 中出现一次。
3. **follow-up 在 mute 窗口内执行（P19）**：目前 follow-up 在 `unmute()` 之后运行，它们的读与 watcher 事件竞争。改为 `deps.mutedWhile(() => followUps())`。`mutedWhile` 使用引用计数式 mute：`RepoFileWatcher.mute()` 需改为计数器，若当前是布尔值，则在本阶段一并修改并补测试，这样 follow-up 与下一条用户命令可以安全地重叠 mute。
4. **过期响应丢弃**：保留 `refreshId` 机制。CommitLoader 在发送每个 follow-up 前检查 `msg.refreshId === this.latestRefreshId`，过期的不发送（现有行为，需在测试中锁定）。
5. **永不 reject**：`load` 内部 catch 所有错误，转换为带 `error` 的 `ResponseLoadCommits`。这同时修复了“rejected promise 留在缓存中”的问题（P19 关联）：缓存的 promise 在 `.catch` 中也执行逐出。

```ts
const promise = this.deps.git.getCommits(query)
	.then((data) => { if (data.error !== null) this.evictIfSame(key, promise); return data; })
	.catch((e) => { this.evictIfSame(key, promise); return emptyCommitData(toErrorInfo(e)); });
```

### 15.4 自动化的 service locator（P20）

`automation/hostBridge.ts` 通过 `GitGraphView.currentPanel` 访问面板。改为在 `extension.ts` 中构造 `AutomationHost` 接口的实现（只暴露 hostBridge 实际用到的约 6 个能力），并注入到 automation 模块。静态 tap（`:263-264`）改为由该接口持有。`currentPanel` 的静态字段保留，供 `createOrShow` 使用。

### 15.5 PR

| PR | 内容 |
|---|---|
| 6.1 | 新增 `tests/commitLoader.test.mjs`：**先基于现有 GitGraphView**，用 T0.2 的测试工厂 + 记录型 send，写出时序 characterization test，覆盖首屏 / 3 种 follow-up / 过期 refreshId / 缓存命中 / 错误不缓存 / 突变后失效 |
| 6.2 | 抽出 `gerritCache.ts`（纯移动 + 注入），测试通过 |
| 6.3 | 抽出 `commitLoader.ts`；`loading` handler 中的 `loadCommits` 改为 `ctx.view.commitLoader.load(msg)`；6.1 的测试改为直接构造 CommitLoader（替换，不叠加） |
| 6.4 | 缓存键纳入策略值，删除配置变化时的全清；mute 改为计数器 + follow-up 在窗口内执行 |
| 6.5 | 抽出 `repoPoller.ts`（`:1500`）和 `html.ts`（`getHtmlForWebview`、`getMediaCacheVersion`）；`GitGraphView` 重命名为 `GitGraphPanel` 并移入 `view/`，旧路径保留 re-export（`tests/gitGraphView.test.mjs` 使用 `out/gitGraphView.js`） |
| 6.6 | AutomationHost 注入 |

### 15.6 验收

- [ ] `view/gitGraphPanel.ts` ≤ 800 行。
- [ ] `tests/commitLoader.test.mjs` 不依赖 `vscode` 桩即可运行。
- [ ] 手工验证：快速连续 checkout 两个分支，HEAD 标记始终正确；Gerrit 仓库首屏 → follow-up 正常。
- [ ] `webviewSeamlessUpdate.test.mjs`、`uncommittedStabiliser.test.mjs` 通过。

---

## 16. 阶段 7 · 配置快照注入，数据层去 vscode 依赖

### 16.1 目标

`src/git/**` 不 import `vscode`，也不调用 `getConfig()`。配置以纯数据 `ConfigSnapshot` 的形式从组合根向下传递。

### 16.2 任务

1. **`config/snapshot.ts`**：定义 `GitPolicy`（`signCommits`、`signTags`、`useMailmap`、`showRemoteHeads`、`dialogDefaults` 中影响 argv 的部分……）。它是 `Config` 的一个纯数据子集。
2. **`config/config.ts`**：新增 `readGitPolicy(): GitPolicy`。`extension.ts` 监听 `onDidChangeConfiguration`，向 GitRepository 推送新的 policy。GitRepository 内部持有 `() => GitPolicy`。
3. **`vscode.Uri.file` 路径归一**（`dataSource.ts:1003, 1024`）：替换为 `utils/paths.ts` 中的纯函数。同时 `utils/paths.ts` 自身要去掉 `vscode` 依赖，若无法完全去除，就把依赖 vscode 的部分拆到 `platform/`。用表驱动测试覆盖 Windows 盘符大小写、UNC 路径和 POSIX 路径，并与旧实现做差分测试（仅在测试中引用 vscode 桩的 `Uri.file`）。
4. **UI 副作用移出**：`showErrorMessage`（`:2165`）、`openGitTerminal`（`:2169`）、`openExternalDirDiff`（`:2183`）移入 `platform/notifications.ts`、`platform/terminal.ts`，由 handler 通过 `ctx.ui` 调用。
5. **打破循环依赖（P15）**：
   - `utils/actions.ts` 中依赖 `DataSource` 和 `diffDocProvider` 的函数（打开 diff、打开文件等）移入 `protocol/handlers/files.ts` 或 `views/`；`utils/actions.ts` 只保留纯工具，必要时删除整个文件。
   - `dataSource.ts:28` 不再 import `utils/actions`。
6. **Gerrit 所有权**：`new GerritDataSource(this)`（`dataSource.ts:59`）改为在 `extension.ts` 中构造 `new GerritDataSource(gitRepository)`，注入到需要它的地方。GerritDataSource 继续通过 `GitRunner` 结构接口访问 Git。

### 16.3 验收

- [ ] `scripts/check-deps.mjs` 中“`git/**` 禁止 import vscode”的基线违规数为 0。
- [ ] `src/` 内没有循环依赖（基线清零）。
- [ ] `getConfig()` 只出现在 `config/`、`extension.ts`、`view/`、`protocol/` 中。

---

## 17. 阶段 8 · Webview 迁移到 ES modules

### 17.1 现状与核心难点

- `web/tsconfig.json` 设 `"module": "none"`，`scripts/package-web.js` 先 tsc 逐文件输出到 `media/*.js`，再拼接成 IIFE，然后由 esbuild 压缩。
- `GG.*` 枚举是 `const enum`，定义在 `src/types/*.ts`。webview 通过 `web/global.d.ts` 中 `import ... from '../out/types/index'`（**`.d.ts` 声明文件**）引用，由 tsc 在编译时内联。

> **关键风险**：如果改为由 esbuild 直接打包 `web/*.ts`，esbuild 是逐文件转译（相当于 `isolatedModules`），**无法内联来自 `.d.ts` 的 `const enum`**，运行时会出现 `GG is not defined`。

### 17.2 方案（推荐 A）

**方案 A：tsc 输出 ES modules → esbuild 打包**

1. `web/tsconfig.json`：`"module": "ES2015"`，`"moduleResolution": "node"`，`outDir` 改为 `media/.esm/`（中间产物）。tsc 继续负责类型检查**和 const enum 内联**，与现在一致。
2. `scripts/package-web.js`：去掉拼接逻辑，改为 `esbuild.buildSync({ entryPoints: ['media/.esm/main.js'], bundle: true, format: 'iife', minify: !DEBUG, sourcemap: !DEBUG, sourcesContent: true, outfile: 'media/out.min.js', target: 'es2017' })`。输出文件名不变，宿主端 `getHtmlForWebview` 无需修改。构建完成后删除 `media/.esm/`。
3. 各文件补上 `import` / `export`。顺序：先给 `utils.ts` 等叶子模块加 `export`，再给使用方加 `import`。tsc 会报出所有未解析的标识符，这正好就是完整的依赖清单。
4. 全局注入的 `initialState`、`globalState`、`workspaceState` 保留为 `declare global`，在 `host/bridge.ts` 中读取一次后导出。
5. `.gitignore` 加入 `media/.esm/`；`scripts/clean.js` 清理它。

**方案 B（不推荐）**：把 `src/types` 的 `const enum` 改为普通 `enum`，或改为 `as const` 对象，并让 webview 直接 import 源 `.ts`。这会改变宿主端的代码形状，影响面更大。

### 17.3 迁移顺序（每步都能构建、测试通过）

| PR | 内容 |
|---|---|
| 8.1 | 构建脚本支持两种模式：检测到任意 `web/*.ts` 含 `import`/`export` 时走方案 A，否则走旧拼接。加入 CI；行为不变 |
| 8.2 | 一次性切换（无法逐文件切换：tsc 中 `module` 是全局选项，且一旦某文件有 import，它就不再是全局脚本）。为降低风险，本 PR **只做机械改动**：为每个顶层声明加 `export`，为每个文件加 `import`，不改逻辑、不移动文件。用脚本辅助（基于 TS 编译器 API 找出未解析标识符并生成 import 语句），人工复核 |
| 8.3 | 删除旧拼接分支；删除 `web/*.ts` 中因抽取产生的双空行（纯格式 PR，`git diff -w` 为空） |
| 8.4 | 按 §6.2 的目录结构 `git mv`，每次移动一个目录，并更新 import |
| 8.5 | 测试改造：`reflogClassification.test.mjs`、`markdownRenderer.test.mjs` 不再用 `new Function` 切源码，改为 esbuild 打包测试入口（`stdin` 中 `export { classifyReflogAction } from './web/widgets/reflogView'`），再从 data URL 动态 `import()`。新增 `tests/helpers/loadWebModule.mjs` 封装此逻辑，并处理 `acquireVsCodeApi` 桩 |

### 17.4 风险控制

- **加载顺序语义变化**：拼接模式下，所有顶层代码按 `utils → 其它（目录序）→ main` 执行；ES modules 按依赖拓扑执行。若某文件在顶层就有副作用（例如 `utils.ts:6` 的 `const VSCODE_API = acquireVsCodeApi()`，或任何顶层的 `document.getElementById`），顺序可能改变。PR 8.2 之前先列出全部顶层副作用（`grep -nE "^(const|let|var) .*= .*\(" web/*.ts`，以及顶层语句），逐一确认，必要时改为懒初始化。
- **循环 import**：拼接模式下的函数互相调用在 ES modules 中可能形成环（例如 `main.ts` ↔ `commitDetailsView.ts`）。函数声明的环在 ES modules 中是安全的（会被提升），**顶层 `const` / `class` 的环不安全**。用 esbuild 的 metafile 或 `check-deps` 检测 web 的环，PR 8.2 中允许存在，并记入基线，阶段 9 消除。
- **包体积 / 性能**：对比切换前后 `media/out.min.js` 的大小（允许 ±5%），以及 `webviewRealPipeline` 测试中的首屏耗时。

### 17.5 验收

- [ ] `web/tsconfig.json` 中不再有 `"module": "none"`。
- [ ] 全部 `webview*.test.mjs` 通过；`tests/browserRepro` 下的手工复现脚本可用。
- [ ] 手工在 VS Code 中验证：打开视图、切仓库、右键菜单、对话框、设置面板、查找、提交详情、移动端窄窗口适配。

---

## 18. 阶段 9 · ViewStore：webview 单一状态来源

### 18.1 目标

- 消除 P22、P23、P25：子模块不再通过 `view: GitGraphView` 访问全部 65 个字段，改为依赖小 interface。
- `GitGraphView`（webview 端）降为编排者：持有 store，挂载 module，连接消息。

### 18.2 Store 设计

```ts
// web/state/store.ts
export interface ViewState {
	readonly config: GG.GitGraphViewConfig;
	readonly repos: Readonly<GG.GitRepoSet>;
	readonly currentRepo: string;
	readonly expandedCommit: ExpandedCommit | null;
	readonly compareSourceHash: string | null;
	// … 只放跨 module 共享的状态；module 私有状态留在 module 内
}

export class ViewStore {
	get(): ViewState;
	/** 唯一写入口：浅合并 + 通知订阅者 + 按需持久化（取代散落的 saveState() 调用） */
	update(patch: Partial<ViewState> | ((s: ViewState) => Partial<ViewState>)): void;
	updateRepoState<K extends keyof GG.GitRepoState>(key: K, value: GG.GitRepoState[K]): void;   // 取代直接写 gitRepos[repo].cdvHeight
	subscribe(selector, listener): () => void;
}
```

- **不引入框架**，也不追求响应式渲染。subscribe 只用于少数跨 module 的联动（例如 config 变化 → 日期重新格式化）。渲染仍由各 module 显式调用。
- `expandedCommit` 目前被 29 处字段级写入修改。迁移策略：`ExpandedCommit` 改为由 `commitDetails` module **独占**，其它 module 通过 `commitDetails.isExpanded(hash)`、`commitDetails.close()` 等方法访问，store 中只保存其 `hash`。这比把 29 处写入都改为 `store.update` 更符合 locality。

### 18.3 子模块的窄 interface

| Module | 依赖（替代 `view: GitGraphView`） |
|---|---|
| `commitDetails/` | `store`、`host`、`table.rowElem(hash)`、`table.scrollTo(hash)` |
| `table/` | `store`、`graph`、`refLabels`、`commitDetails.anchorFor(hash)`（替代 `#cdv` 的跨模块 DOM 操作） |
| `actions/contextMenuActions` | `store`、`host.requests`、`dialog`、`commitDetails` |
| `actions/dialogActions` | `host.requests`、`dialog`；`predictConflicts` 的请求和响应都放到该 module 内（解决 P25 中 `#predictedConflicts` 的跨文件问题） |
| `widgets/findWidget` | `store`、`table.highlight(hashes)`（替代直接遍历 DOM，见 `findWidget.ts:245-270`） |
| `widgets/settingsWidget` | `store`、`host.requests` |

### 18.4 PR（按 module 逐个迁移，旧的 `view.x` 访问逐步消失）

| PR | 内容 |
|---|---|
| 9.1 | `store.ts` + `persistence.ts`；`config`、`currentRepo`、`repos` 迁入 store；`initialState.config` 的最后一处读取移除（B2 的根治） |
| 9.2 | `settingsWidget` 改为依赖 store + host |
| 9.3 | `commitDetails` 独占 `ExpandedCommit`；`#cdv` 的跨 module 访问移除 |
| 9.4 | `table/` 抽出（`renderTable`、虚拟化、`rowSignatures`），`observers.ts` 中的列宽 / 表头部分并入 `table/columns.ts`；`tableElem.className` 的整体覆盖改为 `classList` 增删 |
| 9.5 | `actions/` 改为依赖窄 interface；合并 `contextMenuActions` 和 `reflogView` 中重复的“checkout commit / reset to commit”流程（P 见探查报告 §4） |
| 9.6 | `findWidget` 改用 `table.highlight` |
| 9.7 | `graph/` 去掉对全局 `getBranchLabels` 和 `strings` 的依赖（tooltip 文案作为参数传入），使布局计算成为纯 module，并新增 `tests/graphLayout.test.mjs`（直接 import） |

### 18.5 验收

- [ ] `grep -c "view\." web/**/*.ts`（排除 `main.ts`）降为 0。
- [ ] web 的依赖图无环。
- [ ] `textFormatter`、`fileTree`、`graph`、`dataLossRisk` 都有直接导入的单元测试。

---

## 19. 阶段 10 · SafeHtml：类型化的 HTML 安全

### 19.1 设计

```ts
// web/text/html.ts
declare const SafeHtmlBrand: unique symbol;
export type SafeHtml = string & { readonly [SafeHtmlBrand]: true };

/** Tagged template: every interpolation is escaped unless it is already SafeHtml (or an array of SafeHtml). */
export function html(strings: TemplateStringsArray, ...values: ReadonlyArray<string | number | SafeHtml | ReadonlyArray<SafeHtml>>): SafeHtml;
export function trusted(markup: string): SafeHtml;          // 仅用于常量（SVG 图标、本地化字典中标注为 HTML 的条目）
export function text(s: string): SafeHtml;                  // = escapeHtml
export function setHtml(elem: Element, content: SafeHtml): void;   // 唯一允许的 innerHTML 写入点
```

### 19.2 迁移

1. `strings.ts`：161 条含 HTML 的条目移到 `STRINGS_HTML_EN` / `STRINGS_HTML_ZH_CN` 子字典，类型为 `SafeHtml`（经 `trusted()`）。这样“哪些是 HTML”就体现在类型上。新增测试：普通字典中的条目不含 `<`，HTML 字典中的条目都能被 DOMParser 解析，且只包含白名单标签（`b`、`i`、`code`、`br`、`span`）。
2. `formatStr` 拆为 `formatText(template: string, ...args: string[]): string` 和 `formatHtml(template: SafeHtml, ...args: (string | SafeHtml)[]): SafeHtml`。后者转义 `string` 参数。
3. `Dialog.showError`、`showMessage`、`showConfirmation`、`showForm` 的消息参数类型改为 `SafeHtml`。传入纯文本时由编译器提示使用 `text()`。
4. lint：`scripts/check-deps.mjs` 增加文本规则，`web/**` 中 `.innerHTML =` 和 `insertAdjacentHTML` 只允许出现在 `text/html.ts`。现有的约 N 处（PR 10.1 统计）记入基线，逐步消除。

### 19.3 PR

| PR | 内容 |
|---|---|
| 10.1 | `html.ts` + 测试；统计 innerHTML 写入点，生成基线 |
| 10.2 | `strings.ts` 拆分 HTML 子字典；`formatText` / `formatHtml` |
| 10.3 | Dialog 系列 API 改为 SafeHtml，修正所有调用点 |
| 10.4 | 逐 module 把 innerHTML 拼接改为 `html```（按 §6.2 的目录分批，每批一个 PR），直到基线清零 |

### 19.4 测试

- `tests/safeHtml.test.mjs`：`html` 对 `<img onerror>`、`"`、`'`、`&` 的转义；数组插值；嵌套 SafeHtml 不被二次转义。
- 回归：在 `webviewRealPipeline` 中用作者名 `<img src=x onerror=alert(1)>`、分支名 `a"b`、tag 名 `<b>` 构造仓库，断言 DOM 中没有出现对应元素，并且文本按原样显示。

---

## 20. 阶段 11 · 对比视图迁入 web/

### 20.1 范围

- `src/comparisonView.ts:211-850`：约 640 行内联 HTML / CSS / JS。
- `src/binaryCompare.ts:127-1400`：`binaryCompareCss`、`binaryCompareScript` 字符串。
- 两者的 `msg: any` 协议。

### 20.2 方案

1. 新增 `web/comparison/main.ts`、`web/binaryCompare/main.ts` 两个独立入口，`scripts/package-web.js` 多打两个 bundle（`media/comparison.min.js`、`media/binaryCompare.min.js`），CSS 移入 `web/styles/`。
2. 协议类型移入 `src/protocol/comparisonMessages.ts`、`binaryCompareMessages.ts`，复用阶段 2 的 `HandlerTable` 泛型（将其参数化为 `HandlerTable<Req, Ctx>`）。
3. 宿主端的 `comparisonView.ts` 只保留面板生命周期、HTML 外壳（含 CSP nonce）和 handler 表。
4. 删除 `comparisonView.ts:429` 和 `:859` 两份重复的 `escapeHtml`，改用 `web/text/html.ts`。
5. `binaryCompare.ts` 中的纯计算部分（若有，例如差异计算）保留在宿主或移入 `web/binaryCompare/`。`tests/binaryCompare.test.mjs` 目前从 `out/binaryCompare.js` 导入，需确认它测的是哪一部分，再决定位置。

### 20.3 验收

- [ ] `src/comparisonView.ts` ≤ 250 行，`src/binaryCompare.ts` ≤ 300 行。
- [ ] 新增 `tests/comparisonWebview.test.mjs`（jsdom 启动 comparison bundle，验证文件列表渲染、点击发送 `viewDiff`）。
- [ ] `binaryCompare.test.mjs`、`hexDiff.test.mjs`、`imageDiff.test.mjs` 通过。

---

## 21. 阶段 12 · Backend 收尾与死代码清理

1. **FallbackBackend 泛化（P16）**：用 `Proxy` 或一个按方法名生成的工厂取代 30 个手写方法：

   ```ts
   const READ_METHODS = ['getRepoInfo', 'getCommits', /* … */] as const satisfies ReadonlyArray<keyof GitBackend>;
   ```

   用 `satisfies` 和一个类型级断言（`Exclude<keyof GitBackend, typeof READ_METHODS[number] | 'dispose' | …>` 必须为 `never`）保证不遗漏。`describeBackend` 等元信息方法保留手写。

   > 这里只有一个生产 adapter，可读性的收益需要权衡。若评审认为手写方法更易于逐个打断点调试，保留现状并记录 ADR（见附录 D 的 ADR-0005）。
2. **死代码删除**：`invalidateRefCache`（连同其调用点）、`generateGitCommandFormats`（连同配置监听中的调用）、`spawnGit` 别名、未被引用的导出（`engineRequest`、`describeBackend`、`enginePlatformTable`，删前用 `grep -rn` 确认 `scripts/` 和 `tests/` 也未使用；`resetAddonCache` 若仅供测试使用，就移到测试辅助中）。
3. **测试导入路径**：把 `tests/**` 中对旧路径的导入统一改为新路径（附录 B 列出映射），然后删除全部兼容 re-export 文件。
4. **文档**：更新 `docs/BACKENDS.md`（反映 GitProcess / GitWriter）、`GAPS.md`（写路径的 seam 已就位）、`README` 中的架构图（`docs/architecture.svg`）。
5. **ADR**：把实施过程中做出的、符合“难以逆转 + 无上下文时令人意外 + 真实权衡”三个条件的决定写入 `docs/adr/`（候选见附录 D）。

---

## 22. 测试策略

### 22.1 测试金字塔（目标形态）

| 层 | 对象 | 运行方式 | 变化 |
|---|---|---|---|
| 纯函数 / module interface | `buildSteps`、`safety`、`formatGitError`、`graph` 布局、`html`、`refLabels`、`dataLossRisk`、`responseRouter` 表 | `node --test`，直接 import，毫秒级 | **大幅新增** |
| Deep module + 本地替身 | `GitWriter` + `ScriptedGitProcess`；`CommitLoader` + 记录型 send；`dispatch` + `RecordingContext` | `node --test` | **新增** |
| 真实 Git 仓库 | 两个 backend 的一致性、写操作语义（checkoutProtection、fixupSquash……） | `node --test` + `tests/helpers/tempRepo.mjs` | 保持，逐步改为通过新 interface 调用 |
| Webview 集成 | `webviewHarness` / `webviewRealPipelineHarness`（jsdom + 完整 bundle） | `node --test` | 保持；部分单元断言下沉到上两层后可精简 |
| Rust | `native/core/tests/*` | `cargo test` | B3 新增 tag 场景 |
| 端到端 / 自动化 | `automation` 套件、`tests/browserRepro` | 手动 / `npm run test:automation:full` | 每个里程碑执行一次 |

### 22.2 Characterization 先行

阶段 2、5、6 动手前，分别先合并 T0.2、§14.4 的 argv 快照、§15.5 的 PR 6.1。这三组测试**基于旧实现编写**，在新实现上必须不经修改即通过，然后再按 22.4 替换。

### 22.3 差分测试

对行为必须严格一致的替换（路径归一、错误格式化、argv 构建），在迁移 PR 中保留一个临时的差分测试：同一组输入同时喂给旧函数和新函数，断言输出相等。旧代码删除时，差分测试一并删除，并由快照测试接替。

### 22.4 “替换而非叠加”的执行规则

- 删除测试的 PR 必须在描述中给出一个表：被删用例 → 覆盖它的新用例。
- CI 的测试数基线允许下降，但 PR 需带 `tests-replaced` 标签，并由评审人确认这张表。
- 覆盖率（`npm run test:node:cov`，c8）的行覆盖率不得低于 PR 合并前的值（允许 0.5 个百分点的误差）。

### 22.5 手工回归清单（每个里程碑执行）

1. 打开视图：单仓库、多仓库工作区、子模块、worktree
2. 加载大仓库（≥ 10 万提交），观察首屏时间是否明显退化
3. 分支：创建 / checkout / 重命名 / 删除（含未合并时的强制删除确认）
4. tag：轻量 / 附注 / 推送（含“提交不在远端”的提示）/ 本地 `release/1.0`
5. 提交：cherry-pick、revert、reset（soft / mixed / hard）、drop、编辑消息、fixup / squash
6. merge / rebase 冲突 → conflictBanner → continue / abort
7. stash：push / apply / pop / drop / branch
8. 远程：add / edit / delete / prune / fetch / pull / push
9. 提交详情：文件树、diff、对比、二进制 / 图片 / hex 对比
10. 设置面板中修改日期格式、排序、显示远程分支，**不重开面板**，确认立即生效（B2）
11. 查找组件、右键菜单、键盘导航、窄窗口移动端布局
12. 中英文切换
13. 无 git 可执行文件的环境（engine-only）下的只读功能
14. Gerrit 仓库（如有测试实例）

---

## 23. 质量门禁与 CI 变更

| 门禁 | 命令 | 引入阶段 |
|---|---|---|
| 宿主类型检查 | `npx tsc -p ./src --noEmit` | 现有 |
| Webview 类型检查 | `npx tsc -p ./web --noEmit` | 0（显式化） |
| Node 测试 + 覆盖率 | `npm run test:node:cov` | 现有；0 增加测试数基线 |
| Rust 测试 | `cargo test --workspace` | 现有 |
| Rust lint | `cargo clippy … -D warnings && cargo fmt --check` | 现有 |
| 依赖规则 | `node scripts/check-deps.mjs --baseline scripts/deps-baseline.json` | 0 |
| i18n 一致性 | `node scripts/check-i18n-parity.cjs` | 现有，确认已在 CI 中 |
| 打包冒烟 | `npm run package`，并检查 vsix 中存在 `out/extension.js`、`media/out.min.js` | 0 |
| 包体积 | `media/out.min.js` 大小变化 ≤ ±5%（超过时 CI 警告） | 8 |

`package.json` 的 `lint` 脚本在阶段 0 改为：

```json
"lint": "cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check && node scripts/check-deps.mjs --baseline scripts/deps-baseline.json"
```

---

## 24. 风险登记表

| # | 风险 | 可能性 | 影响 | 缓解 | 触发时的应对 |
|---|---|---|---|---|---|
| R1 | 阶段 8 的 const enum 无法内联，导致运行时报 `GG is not defined` | 高（若采用方案 B） | 高 | 采用方案 A（tsc 输出 ESM → esbuild 打包）；PR 8.1 先在 CI 双模式验证 | 回退 8.2，保持拼接模式 |
| R2 | ES modules 改变顶层副作用的执行顺序 | 中 | 高 | §17.4 先列出全部顶层副作用并懒初始化；jsdom 全量测试 | 定位到具体 module，改为懒初始化 |
| R3 | 统一错误格式改变了用户可见文案，或打破依赖错误文本的判断 | 中 | 中 | §13.3 先 grep 所有 `includes(` 判断；差分测试 | 对特定命令保留旧格式，记录在 ADR-0002 |
| R4 | `mutates` 映射遗漏，导致 checkout 后 HEAD 标记停在旧位置 | 低 | 中 | §11.4 断言新旧集合完全相等 | 补标记 + 加用例 |
| R5 | CommitLoader 抽取改变 follow-up 时序，出现闪烁或数据过期 | 中 | 中 | PR 6.1 的时序 characterization test；`webviewSeamlessUpdate` 测试 | 回滚 6.3/6.4；6.4 的 mute 计数器改动可单独回滚 |
| R6 | B3 修改 `GitCommitTag` 协议后，Rust 与 CLI 不一致 | 中 | 中 | `backends.test.mjs` 的一致性测试自动覆盖；Rust 侧同 PR 修改 | CI 阻断合并 |
| R7 | 测试从 `out/` 旧路径导入，文件移动后测试失效 | 高 | 低 | 兼容 re-export（§6.1），阶段 12 统一修改 | 补 re-export |
| R8 | 重构周期长，与功能开发冲突，频繁 rebase | 高 | 中 | PR 小而频繁；文件移动单独成 PR 并尽快合并；在阶段 8 等大改期间冻结 web 功能开发 1–2 天 | 协调合并窗口 |
| R9 | 阶段 5 的 argv 快照在不同平台（Windows 路径）不同 | 低 | 低 | 快照中路径使用占位符；在 CI 的 Windows job 上也运行 | 平台条件快照 |
| R10 | 引入的抽象过度（单 adapter 的 seam） | 中 | 低 | 遵守“一个 adapter 不建 seam”；评审清单检查（附录 E） | 内联回去 |
| R11 | `engines.vscode ^1.38` 的旧版 webview 不支持新语法 | 低 | 中 | esbuild `target: 'es2017'` 与现有产物一致；不改 target | 降低 target |
| R12 | 自动化套件（`src/automation`，6 000 行）依赖内部结构，重构后失效 | 中 | 中 | 阶段 6.6 先建立 AutomationHost 接口；`automation*.test.mjs` 覆盖 | 适配 AutomationHost |

---

## 25. 回滚策略

1. **PR 级**：每个 PR 都可以 `git revert` 回滚。由于新旧并存（strangler），回滚一个迁移 PR 只会让对应调用点退回旧实现。
2. **阶段级**：每个阶段结束时打一个 tag `refactor/phase-N-done`，出现严重问题时可以整体回到该点。
3. **发布级**：阶段 2、6、8 完成后各发布一个预发布版本（`1.0.27-rc.N`），由维护者在日常使用中验证 3–5 天，再进入下一个高风险阶段。
4. **特性开关**：阶段 6 的 follow-up mute 窗口变更（§15.3 第 3 点）和阶段 4 的错误格式统一，提供临时的隐藏配置 `git-graph-rs.internal.legacyLoader` / `legacyErrorFormat`（不写入 `package.json` 的 contributes，只供调试），保留一个版本后删除。

---

## 26. 排期与人力估算

### 26.1 估算（人日，单人；含编写测试与评审修改）

| 阶段 | 乐观 | 可能 | 保守 |
|---|---|---|---|
| 0 安全网 | 2 | 2.5 | 3 |
| 1 缺陷修复 | 2 | 2.5 | 4 |
| 2 协议表 | 4 | 4.5 | 6 |
| 3 响应路由 | 2 | 2.5 | 3 |
| 4 GitProcess | 3 | 3.5 | 5 |
| 5 GitWriter | 4 | 5 | 7 |
| 6 CommitLoader | 3 | 4 | 6 |
| 7 配置 / 去 vscode | 2 | 2.5 | 3 |
| 8 ES modules | 4 | 5 | 7 |
| 9 ViewStore | 5 | 6 | 8 |
| 10 SafeHtml | 3 | 3.5 | 5 |
| 11 对比视图 | 3 | 3.5 | 5 |
| 12 收尾 | 2 | 2.5 | 3 |
| **合计** | **39** | **47** | **65** |

### 26.2 里程碑（两人并行：A 负责宿主，B 负责 Git 访问和 webview）

| 周 | A | B | 里程碑 |
|---|---|---|---|
| W1 | 0（主导）→ 1（B1、B5、B6） | 1（B2、B3、B4、B7、B8） | **M1：安全网就位，已知缺陷清零**，发布 1.0.27 |
| W2 | 2 | 4 | |
| W3 | 3 → 6 | 5 | **M2：协议表与 GitWriter 完成**，发布 1.0.28-rc |
| W4 | 6 → 7 | 8 | **M3：宿主端结构到位**（gitGraphPanel ≤ 800 行，`git/` 无 vscode） |
| W5 | 11 | 9 | |
| W6 | 12 | 10 | **M4：全部完成**，发布 1.1.0 |

单人串行时约 9–10 周。若只做核心段（阶段 0–7），单人约 4–5 周。

---

## 27. PR 拆分清单

下列 PR 编号与各章一致。“依赖”指必须先合并的 PR。

| PR | 标题（Conventional Commit） | 依赖 | 规模 |
|---|---|---|---|
| 0.1 | `ci: gate on web type-check, test count and dependency rules` | — | S |
| 0.2 | `test(protocol): characterize dispatch of every webview command` | — | M |
| 0.3 | `build: add scripts/check-deps.mjs with a violation baseline` | — | M |
| 0.4 | `docs: add GLOSSARY.md` | — | S |
| 0.5 | `test: share temp-repo and recording-datasource helpers` | — | S |
| 1.1 | `fix(core): engine read failures reach the view as text, not objects` | 0.1 | S |
| 1.2 | `fix(webview): live configuration replaces the initial snapshot everywhere` | 0.1 | M |
| 1.3 | `fix(core,webview): tags carry their remote explicitly; local tags may contain "/"` | 0.1 | M |
| 1.4 | `fix(webview): tag names like "constructor" no longer break row rendering` | 0.1 | S |
| 1.5 | `fix(view): loadCommits follow-ups never reject unhandled` | 0.2 | S |
| 1.6 | `fix(comparison): guard message handling and file indices` | 0.1 | S |
| 1.7 | `fix(repos): serialise pin writes; catch startup task failures` | 0.5 | S |
| 1.8 | `fix(backend): try every addon candidate; log trackRemoteTags failures` | 0.1 | S |
| 2.1 | `refactor(protocol): introduce HandlerTable, dispatch and HandlerContext` | 0.2 | M |
| 2.2–2.4 | `refactor(protocol): move <domains> handlers into the table` | 2.1 | L ×3 |
| 2.5 | `refactor(protocol): table is exhaustive; drop the switch and REPO_MUTATING_COMMANDS` | 2.4 | M |
| 2.6 | `refactor(protocol): move types/messages.ts to protocol/` | 2.5 | 移动 |
| 2.7 | `test(contract): compiler owns request coverage; drop regex cases` | 2.5 | S |
| 3.1–3.3 | `refactor(webview): response routing table` | 2.6 | M ×3 |
| 4.1 | `refactor(git): GitProcess adapter and unified error formatting` | 0.1 | M |
| 4.2–4.5 | `refactor(git): route <runners> through GitProcess` | 4.1 | M ×4 |
| 5.1–5.8 | `refactor(git): GitWriter <op group>` | 4.4 | M–L ×8 |
| 6.1 | `test(view): characterize the staged loadCommits pipeline` | 2.5 | M |
| 6.2–6.6 | `refactor(view): extract GerritCache / CommitLoader / poller / html / AutomationHost` | 6.1 | M–L ×5 |
| 7.x | `refactor(git): ConfigSnapshot; no vscode below git/` | 5.8, 6.5 | M ×3 |
| 8.1–8.5 | `build(webview): ES modules via tsc + esbuild` | 3.3 | M–L ×5 |
| 9.1–9.7 | `refactor(webview): ViewStore and narrow module interfaces` | 8.5 | M–L ×7 |
| 10.1–10.4 | `refactor(webview): SafeHtml` | 8.5 | M ×4+ |
| 11.x | `refactor(comparison): own web entries and typed protocols` | 8.5, 2.5 | L ×2 |
| 12.x | `chore: retire compatibility re-exports, dead code; update docs and ADRs` | 全部 | M ×3 |

规模：S < 150 行，M 150–500 行，L 500–800 行（移动文件不计）。

---

## 28. 验收标准（Definition of Done）

### 28.1 全局

- [ ] §2.2 的 G1–G6 全部达成，并在最终 PR 中附上度量结果（行数、调用点计数、依赖检查输出、测试数、覆盖率）。
- [ ] `scripts/deps-baseline.json` 为空。
- [ ] 不存在 `switch (msg.command)`（`grep -rn "switch (msg.command)" src web` 为空）。
- [ ] 进程启动点只在 `src/git/process/`（白名单除外）。
- [ ] `web/**` 中 `innerHTML` 只出现在 `text/html.ts`。
- [ ] §22.5 的手工回归清单在 Windows、macOS、Linux 各执行一次，结果记录在发布 PR 中。
- [ ] `docs/BACKENDS.md`、`GAPS.md`、架构图已更新；`docs/adr/` 记录了关键决定。

### 28.2 单个 PR

见附录 E。

---

## 29. 附录 A · 命令分类表

**Mutating**（42 个，与现有 `REPO_MUTATING_COMMANDS` 完全一致；阶段 2 中每个对应 handler 的 `mutates: true`）：

```
abortOperation addRemote addTag applyStash branchFromStash checkoutBranch checkoutCommit
cherrypickCommit cleanUntrackedFiles commitFixup commitSquash continueOperation createBranch
createPullRequest deleteBranch deleteRemote deleteRemoteBranch deleteTag dropCommit dropStash
editRemote editUserDetails fetch fetchIntoLocalBranch gerritSetFetchRefs merge popStash
pruneRemote pullBranch pushBranch pushStash pushTag rebase renameBranch resetFileToRevision
resetToCommit revertCommit editCommitMessage undoLastCommit worktreeAdd worktreeRemove worktreePrune
```

> 评审提示：`deleteUserDetails` 写的是 git config（`user.name` / `user.email`），而 `editUserDetails` 在集合中、它却不在。阶段 2 应确认这是遗漏还是有意为之。若 `deleteUserDetails` 只影响作者显示、不影响提交图，可保持不变；否则补为 `mutates: true`，并在 1.x 中作为独立修复。同理检查 `setGlobalSetting`（可能写 git 全局配置中的作者身份，见 `messages.ts` 中的 `authorConfigTouched`）和 `exportRepoConfig`。

**Non-mutating · 读 / 加载**：

```
loadRepos loadRepoInfo loadCommits loadConfig commitDetails commitBodies commitFileCounts
compareCommits countCommitsBefore tagDetails reflog repoStatistics worktreeList predictConflicts
fetchAvatar fetchPullRequest
```

**Non-mutating · 宿主 / UI 动作**：

```
copyFilePath copyToClipboard createArchive openExtensionSettings openLogFile openExternalDirDiff
openCompareTab openExternalUrl openFile openTerminal viewDiff viewDiffBinary viewDiffWithWorkingFile
viewFileAtRevision viewScm showErrorMessage rescanForRepos
```

**Non-mutating · 状态 / 设置**：

```
setGlobalViewState setRepoState setWorkspaceViewState setInterfaceLanguage setGlobalSetting
deleteUserDetails exportRepoConfig startCodeReview updateCodeReview endCodeReview
```

**响应数量特例**（T0.2 中按此断言）：

| 命令 | 响应 |
|---|---|
| `loadCommits` | 1 条首屏 + 0–3 条 follow-up（同名 `loadCommits`） |
| 所有可能产生 LossWarning 的写命令 | 0 条同名响应 + 1 条 `lossWarning`（未确认时） |
| `addTag`（带 `pushToRemote`） | 1 条，`errors` 长度为 2 |
| `checkoutBranch`（带 `pullAfterwards`） | 1 条，`errors` 长度为 2 |
| `copyToClipboard` / `openExternalUrl` 等 | 以 `case` 现有实现为准，T0.2 编写时逐一记录 |

---

## 30. 附录 B · DataSource 方法迁移映射

| 现有方法（`src/dataSource.ts`） | 目标位置 | 阶段 |
|---|---|---|
| `isGitExecutableUnknown`、`openRepository`、`closeRepository`、`repoRoot` | `git/gitRepository.ts`（生命周期） | 5 |
| `searchHistory`、`getRepoInfo`、`getRepoChangeSignature`、`getCommits`、`getCommitDetails`、`getStashDetails`、`getUncommittedDetails`、`getCommitComparison`、`getCommitFileCounts`、`getCommitFile`、`getCommitFileDiff`、`getCommitSummaries`、`getCommitSubject`、`getRemoteUrl`、`getNewPathOfRenamedFile`、`getTagDetails`、`getSubmodules`、`getCommitBodies`、`countCommitsBefore`、`getUncommittedChanges`、`getCurrentBranchUpstream`、`getConfig`、`getGlobalUserDetails`、`getReflog`、`getWorktrees`、`getAuthorStatistics`、`getActivityHeatmap`、`parseGerritMetas`、`listChangeRefHashes` | `git/gitRepository.ts` 读部分（薄委托给 `GitBackend`，统一 `toErrorInfo`） | 4、5 |
| `getOperationState`、`predictConflicts` | `git/repoState.ts` | 5 |
| `addRemote`、`deleteRemote`、`editRemote`、`pruneRemote`、`fetch`、`fetchIntoLocalBranch`、`pullBranch`、`pushBranch`、`pushBranchToMultipleRemotes`、`pushTag`、`trackRemoteTags` | `GitWriter` op（remote 组） | 5.5 |
| `addTag`、`deleteTag` | `GitWriter` op（tags） | 5.1 |
| `checkoutBranch`、`createBranch`、`deleteBranch`、`deleteRemoteBranch`、`renameBranch` | `GitWriter` op（branches） | 5.2 |
| `checkoutCommit`、`resetToCommit`、`undoLastCommit`、`amendLastCommit`、`editCommitMessage`、`resetCurrentBranchToRemote`、`dropCommit`、`createFixupCommit`、`createSquashCommit` | `GitWriter` op（commits） | 5.3 |
| `merge`、`rebase`、`cherrypickCommit`、`revertCommit`、`continueOperation`、`abortOperation` | `GitWriter` op（operations） | 5.4 |
| `applyStash`、`popStash`、`dropStash`、`pushStash`、`branchFromStash`、`addWorktree`、`removeWorktree`、`pruneWorktrees`、`cleanUntrackedFiles`、`resetFileToRevision` | `GitWriter` op | 5.6 |
| `setConfigValue`、`unsetConfigValue`、`archive` | `GitWriter` op | 5.7 |
| `openExternalDirDiff`、`openGitTerminal` | `platform/terminal.ts` | 7 |
| `runGitCommand`、`runGitCommandWithInput`、`spawnGitStream`、`gitOutput`、`spawnGit` | `git/process/`（private），`spawnGit` 删除 | 4、5.8、12 |
| `invalidateRefCache` | 删除 | 12 |
| `invalidateConfigCache` | `gitRepository.ts`（保留，由配置监听调用） | 5 |

**测试导入路径映射**（阶段 12 执行；此前由 re-export 兼容）：

| 旧路径 | 新路径 | 引用次数 |
|---|---|---|
| `out/backend/index.js` | `out/git/read/index.js` | 12 |
| `out/dataSource.js` | `out/git/gitRepository.js` | 10 |
| `out/config.js` | `out/config/config.js` | 4 |
| `out/binaryCompare.js` | `out/views/binaryCompare.js` | 4 |
| `out/hexDiff.js` | `out/views/hexDiff.js` | 3 |
| `out/gitGraphView.js` | `out/view/gitGraphPanel.js` | 3 |
| `out/diffDocProvider.js` | `out/views/diffDocProvider.js` | 3 |
| `out/backend/addon.js`、`out/backend/signatures.js` | `out/git/read/*.js` | 2 |
| `out/gerrit.js`、`out/pullRequests.js` | `out/integrations/*.js` | 2 |
| `out/repoFileWatcher.js` | `out/repos/repoFileWatcher.js` | 1 |
| 其余（`utils/*`、`logger`、`statusBarItem`、`extensionState`、`commands`、`extension`、`askpass/*`） | 不移动 | — |

---

## 31. 附录 C · 依赖规则（机器可检查）

`scripts/check-deps.mjs` 读取以下配置（`scripts/deps-rules.json`）：

```json
{
  "rules": [
    { "name": "git-is-vscode-free",       "from": "src/git/**",       "forbid": ["vscode", "src/view/**", "src/protocol/**", "src/platform/**", "src/config/config.ts"] },
    { "name": "handlers-dont-know-panel", "from": "src/protocol/handlers/**", "forbid": ["src/view/**"] },
    { "name": "utils-are-leaves",         "from": "src/utils/**",     "allowOnly": ["src/utils/**", "node:*", "vscode"] },
    { "name": "platform-is-thin",         "from": "src/platform/**",  "forbid": ["src/git/**", "src/protocol/**", "src/view/**"] },
    { "name": "no-cycles",                "scope": "src/**",          "cycles": "forbid" },
    { "name": "web-no-cycles",            "scope": "web/**",          "cycles": "forbid", "since": "phase-8" }
  ],
  "textRules": [
    { "name": "single-config-source",     "glob": "web/**/*.ts", "pattern": "initialState\\.config", "allowIn": ["web/state/store.ts", "web/utils.ts"] },
    { "name": "single-html-sink",         "glob": "web/**/*.ts", "pattern": "\\.innerHTML\\s*=|insertAdjacentHTML", "allowIn": ["web/text/html.ts"], "since": "phase-10" },
    { "name": "single-process-spawn",     "glob": "src/**/*.ts", "pattern": "cp\\.spawn\\(|execFile\\(|child_process", "allowIn": ["src/git/process/**", "src/askpass/**", "src/utils/findGit.ts", "src/utils/childProcess.ts"], "since": "phase-4" }
  ]
}
```

> `utils-are-leaves` 暂时允许 `vscode`，因为 `utils/paths.ts`、`format.ts` 当前依赖它。阶段 7 把依赖 vscode 的部分移入 `platform/` 之后，从 `allowOnly` 中移除 `vscode`。

---

## 32. 附录 D · 候选 ADR

只有同时满足“难以逆转 + 无上下文时令人意外 + 真实权衡”的决定才写 ADR。以下是本计划中预计会产生的候选，实际是否成文由实施时的讨论决定。

| 编号 | 标题 | 背景要点 |
|---|---|---|
| ADR-0001 | 消息协议以映射类型的 handler 表实现，不使用 schema 校验库 | 不引入运行时依赖；类型来自 `messages.ts`；入站只校验信封 |
| ADR-0002 | git 错误文本统一采用原版 vscode-git-graph 的 `stderr+stdout` 规则 | webview 有基于错误文本的判断（如 `git branch -D`）；CLI 读错误文案因此改变 |
| ADR-0003 | 写路径以 `WriteOp` 判别联合 + 单入口 `GitWriter.run` 表达 | 为将来引擎写路径预留 adapter；校验规则表由编译器保证完整 |
| ADR-0004 | Webview 构建采用 “tsc 输出 ESM → esbuild 打包”，而不是 esbuild 直接转译 TS | 必须在编译期内联来自 `.d.ts` 的 `const enum` |
| ADR-0005 | FallbackBackend 是否泛化为 Proxy | 单 adapter，可调试性与样板量之间的权衡（阶段 12 时决定） |
| ADR-0006 | Tag 协议携带显式 `remote` 字段 | 本地 tag 名可以包含 `/`，字符串编码有二义性 |

---

## 33. 附录 E · 每个 PR 的检查清单模板

复制到 PR 描述中：

```markdown
### 类型
- [ ] 纯移动（git mv，无逻辑改动）  - [ ] 重构（行为保持）  - [ ] 缺陷修复  - [ ] 测试 / 工具

### 行为
- [ ] 无可观察行为变化；若有，列出并说明：
- [ ] 协议（messages.ts）有变化？若有，Rust / CLI / webview 三端是否同步

### 结构
- [ ] 新增的 seam 有 ≥ 2 个 adapter（生产 + 测试），否则说明理由
- [ ] 没有新增 `scripts/check-deps.mjs` 违规；消除的违规已从基线删除
- [ ] 单文件 ≤ 800 行（生成文件 / 字符串表除外）
- [ ] 旧路径的兼容 re-export 已添加（如移动了被 tests 导入的文件）

### 测试
- [ ] 动手前的 characterization test 已在前置 PR 中合并（阶段 2/5/6）
- [ ] 新代码在其 interface 上有测试
- [ ] 删除的测试：被删用例 → 覆盖它的新用例（表格）
- [ ] `npm run compile && npm test && npm run lint` 本地通过
- [ ] 覆盖率未下降（附 c8 摘要）

### 用词
- [ ] PR 描述和注释使用 GLOSSARY.md 的领域词与 module / interface / seam / adapter 等架构词
```

---

*本计划基于 2026-10-17 对 `main@047e7ea` 的静态阅读与测试运行。行号会随代码演进漂移，实施时以符号名为准，行号仅用于初次定位。*

# Native-UI Migration Inventory

Feeds REFACTOR-PLAN task 4.10 ("Native UI scripting"): every direct native-UI call outside
`src/extension/platform/**` that must be absorbed by the platform layer (and, for the modal
flows, by the `UiPort` of `uiPort.ts`) before the 4.10 ESLint rule — *zero `vscode.window.show*`
(QuickPick / InputBox / \*Message / SaveDialog / OpenDialog) calls outside `platform/`* — can be
switched on.

Surveyed at commit `8d73014` (line numbers drift with the concurrent refactor waves; the file
list is exhaustive per the grep pattern `vscode.window.show*` / `vscode.window.createTerminal` /
`vscode.env.clipboard` / `vscode.window.withProgress` / `vscode.window.createOutputChannel`).
Counts: **29 direct call sites in 14 files** (the plan's ~12 host estimate counted the pre-split
`commands.ts` / `gitGraphView.ts` trees; the commands split surfaced more), plus the automation
monkey-patch surface and the indirect consumers listed at the end.

## Messages (`showInformationMessage` / `showWarningMessage` / `showErrorMessage`)

| # | Site | Absorbed by | Note / decision |
|---|------|-------------|-----------------|
| 1 | `src/extension/commands/gerrit.ts:62` | `platform/notifications.ts` | Information + "Open Change" item → `openExternalUrl`; plain choice flow. |
| 2 | `src/extension/commands/gerrit.ts:132` | `platform/notifications.ts` (UiPort modal overload) | Amend confirm with two items; cancellation aborts the push — branch behaviour must stay testable. |
| 3 | `src/extension/commands/misc.ts:22` | UiPort (modal overload) | `{ modal: true }` + copy button — **decision**: modal flow, must run through UiPort's options overload for ScriptedUiPort coverage. |
| 4 | `src/extension/commands/commits.ts:44` | `platform/notifications.ts` | Fire-and-forget "no commits found". |
| 5 | `src/extension/commands/sourceControl.ts:59` | UiPort (modal overload) | Modal destructive-confirm ("reset to remote") — **decision**: cancel branch must abort; needs UiPort. |
| 6 | `src/gitGraphView.ts:2012` | UiPort (modal overload) | Global author takeover confirm (`{ modal: true }`). |
| 7 | `src/gitGraphView.ts:2057` | UiPort (modal overload) | Global author removal confirm (`{ modal: true }`). |
| 8 | `src/repoManager.ts:736` | `platform/notifications.ts` | Yes/No choice on an externally-changed repo config; answer drives state adoption. |
| 9 | `src/utils/actions.ts:279` | `platform/notifications.ts` | The `showInformationMessage` wrapper every other module imports. |
| 10 | `src/utils/actions.ts:287` | `platform/notifications.ts` | The `showErrorMessage` wrapper (also re-exported into `dataSource.ts`, `extension.ts`). |
| 11 | `src/automation/reportView.ts:179` | `platform/notifications.ts` | Automation report save failure. |
| 12 | `src/automation/reportView.ts:181` | `platform/notifications.ts` | Automation report save success. |

## Input (`showQuickPick` / `showInputBox`)

| # | Site | Absorbed by | Note / decision |
|---|------|-------------|-----------------|
| 13 | `src/extension/commands/codeReviews.ts:36` | UiPort `showQuickPick` | End-review pick; cancel = no-op. |
| 14 | `src/extension/commands/codeReviews.ts:65` | UiPort `showQuickPick` | Resume-review pick. |
| 15 | `src/extension/commands/commits.ts:30` | UiPort `showQuickPick` | Repo pick (plain string items). |
| 16 | `src/extension/commands/commits.ts:35` | UiPort `showInputBox` | Search query; empty string cancels. |
| 17 | `src/extension/commands/commits.ts:53` | UiPort `showQuickPick` | Commit pick with `matchOnDescription` / `matchOnDetail`. |
| 18 | `src/extension/commands/context.ts:82` | UiPort `showQuickPick` | Repo selection shared by commands. |
| 19 | `src/extension/commands/repositories.ts:59` | UiPort `showQuickPick` | Remove-repo pick. |
| 20 | `src/extension/commands/view.ts:114` | UiPort `showQuickPick` | Fetch-repo pick; selection opens the view. |
| 21 | `src/askpass/askpassManager.ts:85` | UiPort `showInputBox` | Password prompts driven from an HTTP responder — **decision**: the answer feeds `res.end`, so the port call must keep the promise plumbing (and the failure → HTTP 500 branch). |

## File dialogs (`showSaveDialog` / `showOpenDialog`)

| # | Site | Absorbed by | Note / decision |
|---|------|-------------|-----------------|
| 22 | `src/utils/actions.ts:22` | UiPort `showSaveDialog` | The archive flow's save dialog — the exact site 4.10's acceptance criteria name (`nativeSaveDialog` skip). |
| 23 | `src/automation/reportView.ts:167` | UiPort `showSaveDialog` | Automation report export (webview-driven). |
| 24 | `src/extension/commands/repositories.ts:25` | UiPort `showOpenDialog` | Add external repository (folder picker). |

## Terminal, clipboard, progress, output channel

| # | Site | Absorbed by | Note / decision |
|---|------|-------------|-----------------|
| 25 | `src/utils/childProcess.ts:30` | `platform/terminal.ts` | `openGitTerminal`'s create + sendText + show — the `Terminals.run` flow already mirrors it. |
| 26 | `src/utils/actions.ts:60` | `platform/clipboard.ts` | `copyToClipboard`; the adapter's `write → false` maps onto the localized failure message. |
| 27 | `src/extension/commands/automation.ts:45` | UiPort `withProgress` | Automation-suite run under a notification progress. |
| 28 | `src/logger.ts:37` | `platform/logger.ts` | `createOutputChannel` (not a 4.10 dialog rule site; listed because platform owns the seam). |
| 29 | `src/gitGraphView.ts:2633` | stays outside UiPort | `showTextDocument` is editor reveal, not a modal UI API — it is NOT covered by the 4.10 rule and remains in views/panel wiring. |

## Automation monkey-patch surface (being replaced by ScriptedUiPort, not by the adapters)

`src/automation/hostBridge.ts` wraps `vscode.window.showWarningMessage`,
`showInformationMessage`, `showErrorMessage` and `showQuickPick` at runtime to auto-answer them
during command-mode suite runs. Since task 4.10's ScriptedUiPort wave, the suite runner installs
a scripted port through the production seam (`utils/actions.ts`'s `setScriptedUiPort`) for the
whole run: every dialog routed through the host's UiPort is answered and recorded there, the
former `nativeSaveDialog` catalog skips are gone (the archive flows run, their save dialog
answered by the script), and the monkey-patch remains only for the carrier sites above that
still call `vscode.window` directly. It disappears with them.

## Indirect consumers (no direct vscode call; migrate when their wrapper does)

- `src/extension.ts` (via `src/utils/actions.ts`'s `showInformationMessage` / `showErrorMessage`).
- `src/dataSource.ts:2191` (via `showErrorMessage`).
- `src/gitGraphView.ts` and `src/extension/commands/**` callers of `copyToClipboard` /
  `copyFilePathToClipboard` (via `src/utils/actions.ts:60`).
- `src/extension/graphView/handlers/misc.ts:34` already routes through the wave-1 `ctx.ui`
  port — no direct call; its `ctx.ui.showErrorMessage` member is the one `platform/uiPort.ts`
  keeps compatible (see uiPort.test.ts).

## Rule to enforce (task 4.10)

When the last direct site above is absorbed, add the ESLint rule forbidding
`vscode.window.show*` / `createTerminal` / `env.clipboard` / `withProgress` /
`createOutputChannel` outside `src/extension/platform/**` (views/ and panel.ts included — the
point of the port), and delete this inventory.

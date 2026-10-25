/**
 * The automation action catalog: the single source of truth that maps every user-facing Git
 * Graph View control (control-bar buttons, graph row interactions, context menus, dialogs,
 * view widgets) to a machine-runnable form. Each action declares both paths where available:
 *   - `request`: the exact RequestMessage(s) the control sends into the extension host, so a
 *     driver can replay the backend path directly (stable timing, no rendering in the loop);
 *   - `ui`: the DOM steps a user performs, executed by the in-page automation shim (tests the
 *     whole stack, wiring included).
 * Placeholders `{{name}}` in either path are expanded by the server from the run parameters
 * and live repository state (repo, head, branch, commit, ...) before execution.
 */

/**
 * How a run is driven. `ui` clicks the real controls through the in-page shim; `request` injects
 * the equivalent request(s) into the extension host; `command` executes the VS Code command a
 * contributed menu item runs (package.json `contributes.menus`), with the argument shape that
 * menu passes.
 */
export type AutomationMode = 'ui' | 'request' | 'command';

/** One step of a UI-mode run, executed sequentially by the in-page shim (resources/automation/shim.js). */
export type UiStep =
	| { readonly op: 'click' | 'dblclick'; readonly selector: string }
	| { readonly op: 'contextmenu'; readonly selector: string; readonly item: string | readonly string[] } // right-click the element, then click the menu item whose visible text matches exactly (several texts => any of them, one per interface language)
	| { readonly op: 'key'; readonly key: string; readonly ctrlOrCmd?: boolean; readonly shift?: boolean } // keydown on the document (what the view's keybinding observer listens to)
	| { readonly op: 'waitFor' | 'waitForGone'; readonly selector: string; readonly timeoutMs?: number }
	| { readonly op: 'skipIfAbsent'; readonly selector: string; readonly timeoutMs?: number } // wait for the element; when it never appears the whole action is SKIPPED (the repository/view does not offer this control) instead of failed
	| { readonly op: 'set'; readonly selector: string; readonly value: string; readonly event: 'change' | 'input' }
	| { readonly op: 'expectText'; readonly selector: string; readonly contains: string | readonly string[] }
	| { readonly op: 'eval'; readonly expr: string } // a JS expression evaluated in the page (gg.eval / debugging); result must be JSON-cloneable
	/* Assertion steps (verification only — they never touch the page state). Sizes come from
	   getBoundingClientRect (CSS pixels, invariant under editor zoom) with generous tolerances:
	   the stylesheet's canonical value sits mid-range, so a small style tweak shifts a bound
	   instead of flaking the suite, while a broken layout (collapsed, zero-sized, exploded)
	   still falls far outside. WIDTH BOUNDS FOLLOW THE STYLESHEET'S OWN CURRENCY: absolutely
	   sized elements (24x24 buttons, the 460px-capped dialog) get absolute minW/maxW, while
	   elements the stylesheet sizes in vw units (the dropdowns' 12vw cap, widgets shrunk by
	   max-width:calc(100vw - 56px)) get minWVw/maxWVw — percent of the webview's layout width —
	   because absolute px bounds on those break as the user resizes the window. */
	| { readonly op: 'expectSize'; readonly selector: string; readonly minW?: number; readonly maxW?: number; readonly minWVw?: number; readonly maxWVw?: number; readonly minH?: number; readonly maxH?: number } // the element's rendered box: width/height must lie within the bounds inclusive (a bound left out is not checked); fails with the measured box
	| { readonly op: 'expectCount'; readonly selector: string; readonly min?: number; readonly max?: number } // how many elements the selector matches (defaults: min 1, no max)
	| { readonly op: 'expectChecked'; readonly selector: string; readonly checked: boolean }; // a checkbox's checked state — the rendered effect of a toggle step

/**
 * The argument one menu contribution passes to its command when its item is clicked — the shapes
 * `getUrisFromCommandArg` / `getRepoFromCommandArg` accept (src/commands.ts), so a command-mode
 * run exercises exactly the path the editor's menu takes:
 *   - `uri` — a bare `file` URI of the context file (or the repository root, `of: 'repo'`): what
 *     the Explorer, Editor and Editor Tab context menus pass;
 *   - `rootUri` — `{ rootUri }` of the context repository: what the Source Control view's title
 *     and Pull/Push menus pass;
 *   - `resourceStates` — `[{ resourceUri }]`: what the Source Control resource context menu
 *     passes;
 *   - `diffUri` — a git-graph-rs diff-document URI of the context commit/file: what the diff
 *     editor title's Open File button passes.
 */
export type CommandArgSpec =
	| { readonly kind: 'uri'; readonly of: 'file' | 'repo' }
	| { readonly kind: 'rootUri' }
	| { readonly kind: 'resourceStates' }
	| { readonly kind: 'diffUri' };

/** One VS Code command execution (command mode): what clicking a contributed menu item runs. */
export interface CommandStep {
	readonly command: string;
	readonly arg?: CommandArgSpec;
}

/** A catalog entry: one user-facing control. */
export interface AutomationAction {
	/**
	 * Domain tags for suite selection and the (future) affected-tier directory-to-domain mapping:
	 * the action's group at minimum, plus obvious cross-cutting domains (e.g. 'dialog' for
	 * dialog-opening flows, 'command' for VS Code contributed commands). A load-time check in
	 * catalog.ts rejects an action with no tags.
	 */
	readonly tags: readonly string[];
	/** Dotted id: `<group>/<name>`, e.g. `control-bar/refresh`, `menu-commit/checkout`. */
	readonly id: string;
	/** Human-readable control label (the button tooltip or menu item title). */
	readonly title: string;
	/** Grouping for suite selection, e.g. `control-bar`, `row`, `menu-commit`, `menu-branch`, `cdv`, `settings`, `find`, `reflog`, `worktree`, `statistics`, `host`, `menu-vscode` (the extension's contributed VS Code menus), `external` (changes made outside the view that the watcher must pick up). */
	readonly group: string;
	/** TRUE => the action mutates the repository (belongs to the `write` suite; the driver re-creates the fixture clone around it). */
	readonly mutable: boolean;
	/** Environment the action needs; the server skips the action when unavailable (`remote` => a configured remote; `stash` => at least one stash; `tag`/`annotatedTag` => tags in the loaded graph; `file` => a commit with (non-binary) file changes; `binaryFile`/`imageFile` => a commit that only changes a binary/image file (the fixture's dedicated `assets/` commits); `anotherBranch` => at least two branches; `anotherRepo` => at least two known repositories). */
	readonly requires?: readonly ('remote' | 'stash' | 'tag' | 'annotatedTag' | 'file' | 'binaryFile' | 'imageFile' | 'anotherBranch' | 'anotherRepo')[];
	/**
	 * TRUE => confirming the action opens the editor's NATIVE save dialog (utils.archive's
	 * showSaveDialog). A modal an automated run can neither drive nor dismiss — in the real
	 * editor it stalls the whole suite until someone clicks it away — so the suite runner
	 * reports the action as SKIPPED in every mode instead of running it.
	 */
	readonly nativeSaveDialog?: boolean;
	/**
	 * TRUE declares the action awaits no host response (a pure view-state change, or traffic the
	 * host answers silently such as `setRepoState` / `openCompareTab`). Such actions MUST declare
	 * `expect: { responses: [] }` — the run is complete once the page steps finish (or, in request
	 * mode, once the requests are injected).
	 */
	readonly noHostTraffic?: boolean;
	readonly ui?: readonly UiStep[];
	/** The VS Code command a contributed menu item runs (command mode), with the argument shape that menu passes. */
	readonly vscodeCommand?: CommandStep;
	/**
	 * Page steps run AFTER the command completed (command mode only): verification barriers and
	 * state restoration (e.g. clearing the file filter a `filterByFile` command set).
	 */
	readonly uiAfter?: readonly UiStep[];
	/** TRUE (command mode only) => the run asserts at least one new editor tab appeared while the command ran. */
	readonly expectTabs?: boolean;
	/**
	 * Substrings (command mode only) that must appear in the native notifications the command
	 * raises, as captured by the dialog auto-answer. A command whose whole observable outcome is a
	 * notification (e.g. a designed Gerrit refusal) is otherwise unverifiable — `expect: { responses: [] }`
	 * alone would pass even if the command silently did nothing. Each substring must occur in at
	 * least one captured message; use fragments that hold in every interface language (e.g.
	 * "Change-Id", "commit-msg"), since the captured text is the localized message.
	 */
	readonly expectNotifications?: readonly string[];
	/**
	 * TRUE (command mode only) => the command must raise at least one native notification
	 * (information / warning / error) while it runs. For commands whose whole observable outcome
	 * IS a notification whose text is fully localized (no language-invariant fragment exists to
	 * pin with expectNotifications) — presence is still a stronger check than nothing.
	 */
	readonly expectAnyNotification?: boolean;
	/**
	 * TRUE (command mode only) => the command must raise a native MODAL that the auto-answer
	 * answers (a confirmation the command cannot proceed without) — verifying the command really
	 * reached its confirmation point.
	 */
	readonly expectModal?: boolean;
	/** RequestMessage template(s) for request mode, in send order. */
	readonly request?: readonly Record<string, unknown>[];
	/** Responses (by `command`) that must arrive from the extension host while the action runs. */
	readonly expect: { readonly responses: readonly string[] };
	/**
	 * Expected responses whose ERROR payload the run accepts (by `command`). The host answers a
	 * failed operation with the same response command and the git error in its `error`/`errors`
	 * field — the run fails on any other error-bearing expected response, so an action whose
	 * designed outcome on the fixture IS the refusal (pulling a local-only branch from a remote
	 * without it, pushing a tag the remote already has, ...) lists that command here, with the
	 * reason documented on the entry. Anything NOT listed failing means the action did not
	 * achieve what its title says.
	 */
	readonly allowErrorOn?: readonly string[];
	/**
	 * Optional post-run repository state check, evaluated by the server against live repository
	 * state. `placeholder` is a single `{{name}}` context reference OR a plain literal (the
	 * exact branch/tag/remote name a write action of this catalog creates — literals keep the
	 * check independent of repository data).
	 */
	readonly verify?: {
		readonly kind: 'headIs' | 'headIsNot' | 'headSubjectStartsWith' | 'branchAbsent' | 'branchPresent' | 'tagAbsent' | 'tagPresent' | 'remoteAbsent' | 'remotePresent';
		readonly placeholder: string;
	};
}

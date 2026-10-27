import { performance } from 'perf_hooks';
import { Logger } from '../platform/logger';
import { RequestMessage } from '../../shared/protocol/messages';
import { AutomationMode, CATALOG, UiStep, expandTemplate, validateCatalog } from './catalog';
import { HostBridge, ShimResult } from './hostBridge';
import { activeScriptedUiPort } from './scriptedUiPort';
import { verifyAction } from './actionVerify';
import { buildContext, ContextProbes } from './runContext';
import { ActiveRun, RunTracker } from './runTracker';
import { ActionSample, ActionStats, RunOutcome, RunStats } from './runStats';

/* The engine's value types moved to runStats.ts; re-exported so the server's import surface
 * (and the suite runner's) stays what it was before the decomposition. */
export type { ActionSample, ActionStats, RunOutcome };

/**
 * The automation engine: the in-process half of the automation interface, driven directly by
 * the suite runner (the "Run Automation Test" button) — no sockets, no external ports. Each
 * catalogued action runs against the real view: UI mode posts step batches to the in-page shim,
 * request mode injects the equivalent request into the extension host's message pipeline, and
 * every run is timed from injection to the last expected host response. Host→webview traffic
 * is tapped at the single exit point of GitGraphView, so a run measures exactly what a user's
 * click would measure.
 *
 * The server is the orchestration half of the engine: it routes the runner's calls (run /
 * invoke / eval / query / stats) and walks one catalogued action from precondition checks
 * through injection to the post-run verify. The mechanics live in their own modules —
 * runTracker (the active-run state machine and the view tap), runContext (placeholder
 * resolution), actionVerify (the post-run state checks) and runStats (the measurement
 * bookkeeping). The timing-sensitive methods (run / invoke / eval) are serialised so the
 * timing windows of concurrent runs can never overlap.
 */

export interface AutomationEngineDeps {
	readonly logger: Logger;
	readonly bridge: HostBridge;
	/** Extension version, reported for diagnostics. */
	readonly version: string;
}

const DEFAULT_RUN_TIMEOUT_MS = 30000;
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

/**
 * The notifications one command-mode run captured: everything the window-level auto-answer
 * intercepted plus everything the INSTALLED ScriptedUiPort recorded since the run's baseline
 * (a dialog goes through exactly one of the two paths, so the merge double-counts nothing).
 */
function capturedNotifications(dialogs: { readonly messages: readonly string[] }, scriptedBaseline: number): readonly string[] {
	const scripted = activeScriptedUiPort();
	const fromScript = scripted !== null ? scripted.notificationRecords(scriptedBaseline).map((record) => record.title) : [];
	return [...dialogs.messages, ...fromScript];
}

export class AutomationServer {
	private readonly logger: Logger;
	private readonly bridge: HostBridge;
	readonly version: string;
	private readonly tracker: RunTracker;
	private readonly runStats: RunStats;
	/** Serialises the timing-sensitive methods so their windows never overlap. */
	private chain: Promise<unknown> = Promise.resolve();
	private started = false;
	private offHostMessage: (() => void) | null = null;
	private offShimResult: (() => void) | null = null;

	constructor(deps: AutomationEngineDeps) {
		this.logger = deps.logger;
		this.bridge = deps.bridge;
		this.version = deps.version;
		this.tracker = new RunTracker(deps.bridge, deps.logger);
		this.runStats = new RunStats(deps.logger);
		const problems = validateCatalog(CATALOG);
		for (const problem of problems) this.logger.logError('Automation catalog: ' + problem);
		if (problems.length > 0) throw new Error('Invalid automation catalog (' + problems.length + ' problems)');
	}

	/** Register the view traffic taps. Idempotent; call stop() to unregister. */
	public start(): void {
		if (this.started) return;
		this.started = true;
		this.offHostMessage = this.bridge.onHostMessage((msg) => this.tracker.onHostMessage(msg));
		this.offShimResult = this.bridge.onShimResult((result) => this.tracker.onShimResult(result));
	}

	public stop(): void {
		if (!this.started) return;
		this.started = false;
		if (this.tracker.active !== null) this.tracker.forceFinish(new Error('Automation engine stopped'));
		if (this.offHostMessage !== null) { this.offHostMessage(); this.offHostMessage = null; }
		if (this.offShimResult !== null) { this.offShimResult(); this.offShimResult = null; }
	}

	/* ---------------- Public API (the suite runner's surface) ---------------- */

	/** Snapshot of the view and repository state. */
	public status(): { viewLoaded: boolean; currentRepo: string | null; repos: string[] } {
		return this.bridge.viewState();
	}

	/** Open (or reveal) the Git Graph view on the given repository and wait for its first page. */
	public async openView(params: { repo: string }): Promise<{ opened: boolean; repo: string }> {
		if (typeof params.repo !== 'string' || params.repo === '') throw new Error('openView requires {repo: string}');
		await this.bridge.openView(params.repo);
		// Wait until the view has loaded a repository's first page of commits. The registered
		// root may be normalised (symlinks, case), so any loaded currentRepo satisfies us.
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			const state = this.bridge.viewState();
			if (state.viewLoaded && state.currentRepo !== null) {
				return { opened: true, repo: state.currentRepo };
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error('Timed out waiting for the Git Graph view to load ' + params.repo);
	}

	/** Run a catalogued action (`gg.run`'s engine): {@see runCatalogAction} on the serialising chain. */
	public run(params: Record<string, unknown>): Promise<RunOutcome> {
		return this.enqueue(() => this.runCatalogAction(params));
	}

	/** Inject one raw request and capture its response (`gg.invoke`'s engine). */
	public invoke(params: Record<string, unknown>): Promise<RunOutcome> {
		return this.enqueue(() => this.invokeRaw(params));
	}

	/** Evaluate an expression in the page (`gg.eval`'s engine). */
	public eval(params: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }> {
		return this.enqueue(() => this.evalInPage(params));
	}

	/** Read state through the real pipeline (`gg.query`'s engine). */
	public async query(params: Record<string, unknown>): Promise<unknown> {
		const kind = params.kind;
		if (kind === 'repos') return this.bridge.viewState().repos;
		this.requireView();
		const repo = typeof params.repo === 'string' ? params.repo : this.bridge.viewState().currentRepo;
		if (typeof repo !== 'string' || repo === '') throw new Error('query requires an active repository');
		if (kind === 'repoInfo') return this.queryRepoInfo(repo);
		if (kind === 'commits') return this.queryCommits(repo, typeof params.maxCommits === 'number' ? params.maxCommits : 100);
		throw new Error('Unknown query kind "' + String(kind) + '" (use repos | repoInfo | commits)');
	}

	/** Aggregated per-action timings and failure counts across this engine's runs. */
	public stats(): ActionStats[] {
		return this.runStats.report();
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.chain.then(task, task);
		this.chain = result.then(() => undefined, () => undefined);
		return result;
	}

	/* ---------------- Run execution ---------------- */

	private requireView(): void {
		if (!this.bridge.hasView()) throw new Error('No Git Graph view is open');
	}

	private async runCatalogAction(params: Record<string, unknown>): Promise<RunOutcome> {
		const id = params.id, mode = (params.mode ?? 'ui') as AutomationMode;
		if (typeof id !== 'string') throw new Error('run requires {id: string}');
		if (mode !== 'ui' && mode !== 'request' && mode !== 'command') throw new Error('mode must be "ui", "request" or "command"');
		const action = CATALOG.find((a) => a.id === id);
		if (action === undefined) throw new Error('Unknown action "' + id + '"');
		const path = mode === 'ui' ? action.ui : mode === 'request' ? action.request : action.vscodeCommand;
		if (path === undefined) return { ok: false, skipped: true, reason: 'Action "' + id + '" has no ' + mode + ' path' };
		this.requireView();

		const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
		const context = await buildContext(this.probes(), action, params, mode);

		if (action.requires !== undefined && action.requires.includes('remote') && context.remote === '') {
			return { ok: false, skipped: true, reason: 'requires a configured remote' };
		}
		if (action.requires !== undefined && action.requires.includes('stash') && context.stash === '') {
			// In UI mode the placeholder resolves from the loaded graph (see buildContext), so an
			// empty value also covers the stash that sits outside the loaded page.
			return { ok: false, skipped: true, reason: mode === 'ui' ? 'requires a stash in the loaded graph' : 'requires at least one stash' };
		}
		if (action.requires !== undefined && action.requires.includes('tag') && context.tag === '') {
			return { ok: false, skipped: true, reason: 'requires at least one tag' };
		}
		if (action.requires !== undefined && action.requires.includes('annotatedTag') && context.annotatedTag === '') {
			return { ok: false, skipped: true, reason: 'requires an annotated tag in the loaded graph' };
		}
		if (action.requires !== undefined && action.requires.includes('file') && context.file === '') {
			return { ok: false, skipped: true, reason: 'requires a commit with file changes in the loaded page' };
		}
		if (action.requires !== undefined && action.requires.includes('binaryFile') && context.binaryFile === '') {
			return { ok: false, skipped: true, reason: 'requires a commit that changes a binary file' };
		}
		if (action.requires !== undefined && action.requires.includes('imageFile') && context.imageFile === '') {
			return { ok: false, skipped: true, reason: 'requires a commit that changes an image file' };
		}
		if (action.requires !== undefined && action.requires.includes('anotherBranch') && Number(context.branchCount ?? '0') < 2) {
			return { ok: false, skipped: true, reason: 'requires at least two branches' };
		}
		if (action.requires !== undefined && action.requires.includes('anotherRepo') && Number(context.reposCount ?? '0') < 2) {
			return { ok: false, skipped: true, reason: 'requires at least two known repositories' };
		}
		if (action.vscodeCommand !== undefined && action.vscodeCommand.arg?.kind === 'diffUri' && !this.bridge.workingTreeFileExists(context)) {
			// The `openFile` command opens the working-tree file; on repositories whose context
			// file no longer exists at HEAD there is nothing to open — skip instead of failing on
			// repository data the catalog cannot promise.
			return { ok: false, skipped: true, reason: 'requires the context file to exist in the working tree' };
		}

		const run = this.tracker.beginRun({
			mode,
			pending: action.expect.responses,
			baseline: this.tracker.baselineSnapshot(),
			shimComplete: mode !== 'ui'
		});
		this.logger.log('Automation run ' + run.runId + ': ' + id + ' (' + mode + ')');

		// Command mode: native dialogs and notifications the command raises are intercepted
		// (dialogs answered with their primary action, error toasts captured and suppressed)
		// for the whole run window below — through the handler itself and the post-run steps.
		// Notifications that route through the host's UiPort land in the INSTALLED SCRIPTED PORT
		// instead (the suite runner installs one for the whole run, task 4.10): its records are
		// sliced from this baseline and merged with the window-level capture, so every raised
		// notification is seen exactly once regardless of which path took it.
		const scriptedBaseline = activeScriptedUiPort()?.recordedCalls().length ?? 0;
		let dialogs: ReturnType<HostBridge['installDialogAutoAnswer']> | null = null;
		let tabsBefore: string[] | null = null;
		try {
			if (mode === 'ui') {
				const steps = expandTemplate(action.ui as readonly UiStep[], context);
				this.bridge.postToWebview({ __automation: { runId: run.runId, steps } });
			} else if (mode === 'command') {
				dialogs = this.bridge.installDialogAutoAnswer();
				tabsBefore = action.expectTabs === true ? this.bridge.tabKeys() : null;
				// The handler's promise is forwarded (commands.ts's registerCommand returns it,
				// already caught), so this await spans the WHOLE command: the auto-answer installed
				// above stays in force through every notification and modal the command raises —
				// restoring it at the old dispatch-moment let a late modal confirmation surface as
				// a real, run-blocking dialog. A command that never completes must not stall the
				// serialized chain either, so race the run timeout and fail the action instead.
				const command = this.bridge.executeVscodeCommand(action.vscodeCommand!, context);
				const incomplete = await Promise.race([
					command.then(() => false),
					new Promise<boolean>((resolve) => { setTimeout(() => resolve(true), timeoutMs); })
				]);
				if (incomplete) {
					return this.runStats.record(action, mode, { ok: false, error: 'The command did not complete within ' + timeoutMs + ' ms' });
				}
			} else {
				for (const template of action.request ?? []) {
					const message = expandTemplate(template, context) as unknown as RequestMessage;
					const messageRefreshId = (message as { refreshId?: unknown }).refreshId;
					if (typeof messageRefreshId === 'number') {
						run.injectedRefreshIds.set(message.command, messageRefreshId);
					}
					this.bridge.inject(message);
				}
			}

			const outcome = await this.tracker.waitForRun(run, timeoutMs);
			if (run.timer !== null) { clearTimeout(run.timer); run.timer = null; }

			if (outcome === 'timeout') {
				return this.runStats.record(action, mode, {
					ok: false,
					error: 'Timed out after ' + timeoutMs + ' ms waiting for ' + [...run.pending].join(', ')
						+ (mode === 'ui' && run.shimResult === null ? ' (page steps never completed)' : '')
				});
			}
			const shim = run.shimResult;
			if (shim !== null && !shim.ok) {
				return this.runStats.record(action, mode, {
					ok: false,
					error: 'Page step ' + (shim.failedStep ?? '?') + ' failed: ' + (shim.error ?? 'unknown')
				});
			}
			if (shim !== null && shim.skipped === true) {
				return this.runStats.record(action, mode, {
					ok: false, skipped: true,
					reason: shim.skipReason ?? 'a precondition of the action is absent in the view'
				});
			}

			const timings: ActionSample = { totalMs: this.tracker.relative(run.t0), responses: run.seen };
			if (mode === 'command') {
				// Page steps the command's completion gates on (verification barriers like the
				// first rendered row, and state restoration like clearing the file filter a
				// filterByFile command set). The batch gets its own run id, so a failure reports
				// its own step index.
				if (action.uiAfter !== undefined) {
					const after = await this.runShimBatch(expandTemplate(action.uiAfter, context), timeoutMs);
					if (!after.ok) {
						return this.runStats.record(action, mode, { ok: false, timings, error: 'Post step ' + (after.failedStep ?? '?') + ' failed: ' + (after.error ?? 'unknown') });
					}
					if (after.skipped === true) {
						return this.runStats.record(action, mode, { ok: false, skipped: true, reason: after.skipReason ?? 'a post-run precondition of the action is absent in the view' });
					}
				}
				if (tabsBefore !== null) {
					// executeCommand resolved once the handler completed (its promise is forwarded),
					// but the editor's tab registration in tabGroups.all can still lag the handler's
					// showTextDocument. A single snapshot here races that registration and fails a
					// command that did open its tab; poll for the new key instead, and only a tab
					// that never appears fails the action.
					const before = tabsBefore;
					const deadline = performance.now() + 5000;
					for (;;) {
						const after = this.bridge.tabKeys();
						if (after !== null && after.some((key) => before.indexOf(key) === -1)) break;
						if (performance.now() > deadline) {
							return this.runStats.record(action, mode, { ok: false, timings, error: 'expected the command to open a new editor tab' });
						}
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
				}
			}
			// The error-payload gate: an expected response that arrived carrying an error means the
			// operation FAILED even though every step and barrier completed (the webview shows the
			// error dialog the flows dismiss). Checked after the post steps so a failed command's
			// state restoration (e.g. clearing a file filter) still runs before the failure lands,
			// and before the state verify so the root cause — not its downstream symptom — reports.
			// allowErrorOn is the designed-refusal escape (documented per action): everything else
			// must have actually worked for the action to pass.
			const allowed = action.allowErrorOn ?? [];
			const failedResponse = run.seen.find((s) => s.error !== null && !allowed.includes(s.command));
			if (failedResponse !== undefined) {
				return this.runStats.record(action, mode, {
					ok: false, timings,
					error: 'the host reported an error for "' + failedResponse.command + '": ' + failedResponse.error
				});
			}
			if (action.verify !== undefined) {
				const verifyError = await verifyAction(this.probes(), action, context);
				if (verifyError !== null) {
					return this.runStats.record(action, mode, { ok: false, timings, error: verifyError });
				}
			}
			if (action.expectNotifications !== undefined && dialogs !== null) {
				// The await above spanned the whole handler, so every notification the command raised
				// is captured by now; a command whose outcome IS a notification is otherwise
				// unverifiable (an empty expected-responses list passes even if it did nothing).
				const captured = capturedNotifications(dialogs, scriptedBaseline);
				for (const needle of action.expectNotifications) {
					if (!captured.some((message) => message.indexOf(needle) !== -1)) {
						return this.runStats.record(action, mode, {
							ok: false, timings,
							error: 'expected a native notification containing "' + needle + '"; the command raised: '
								+ (captured.length === 0 ? '(no notification)' : '"' + captured.join('" | "') + '"')
						});
					}
				}
			}
			if (action.expectAnyNotification === true && dialogs !== null && capturedNotifications(dialogs, scriptedBaseline).length === 0) {
				// The command's whole observable outcome is a (fully localized) notification: pin its
				// presence when no language-invariant fragment exists to pin its text.
				return this.runStats.record(action, mode, { ok: false, timings, error: 'the command raised no native notification' });
			}
			if (action.expectModal === true && dialogs !== null
				&& dialogs.autoAnswered.length === 0 && (activeScriptedUiPort()?.answeredDialogCount(scriptedBaseline) ?? 0) === 0) {
				// The command must have reached its confirmation point: a native modal the
				// auto-answer (or the scripted port) answered (a silent no-op never got that far).
				return this.runStats.record(action, mode, { ok: false, timings, error: 'the command raised no confirmation modal' });
			}
			return this.runStats.record(action, mode, {
				ok: true, timings,
				notifications: dialogs !== null && capturedNotifications(dialogs, scriptedBaseline).length > 0
					? capturedNotifications(dialogs, scriptedBaseline)
					: undefined
			});
		} finally {
			this.tracker.endRun();
			if (dialogs !== null) {
				for (const line of dialogs.autoAnswered) this.logger.log('Automation auto-answered a native dialog: ' + line);
				dialogs.restore();
			}
		}
	}

	private async invokeRaw(params: Record<string, unknown>): Promise<RunOutcome> {
		const message = params.message as Record<string, unknown>;
		if (typeof message !== 'object' || message === null || typeof message.command !== 'string') {
			throw new Error('invoke requires {message: RequestMessage}');
		}
		this.requireView();
		const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
		const command = message.command;
		const injectedRefreshIds = new Map<string, number>();
		const messageRefreshId = (message as { refreshId?: unknown }).refreshId;
		if (typeof messageRefreshId === 'number') injectedRefreshIds.set(command, messageRefreshId);
		const run = this.tracker.beginRun({
			mode: 'request',
			pending: [command],
			baseline: this.tracker.baselineSnapshot(),
			injectedRefreshIds,
			invokeCommand: command,
			shimComplete: true
		});
		try {
			this.bridge.inject(message as unknown as RequestMessage);
			const outcome = await this.tracker.waitForRun(run, timeoutMs);
			if (outcome === 'timeout') return { ok: false, error: 'Timed out after ' + timeoutMs + ' ms waiting for "' + command + '"' };
			return {
				ok: true,
				timings: { totalMs: this.tracker.relative(run.t0), responses: run.seen },
				response: run.payload
			};
		} finally {
			this.tracker.endRun();
		}
	}

	/**
	 * Post one step batch to the page shim and await its result — the engine behind `gg.eval` and
	 * the command-mode post steps. The batch gets its own run id and its own ActiveRun slot (the
	 * owning catalog run has settled by the time post steps run), so failures report their own
	 * step index.
	 */
	private runShimBatch(steps: readonly UiStep[], timeoutMs: number): Promise<ShimResult> {
		const run: ActiveRun = this.tracker.beginRun({
			mode: 'ui', pending: [], baseline: new Map(), shimComplete: false
		});
		const settle = () => {
			if (run.timer !== null) { clearTimeout(run.timer); run.timer = null; }
			if (this.tracker.active === run) this.tracker.endRun();
		};
		return new Promise<ShimResult>((resolve, reject) => {
			run.waiter = () => {
				settle();
				if (run.shimResult === null) reject(new Error('page steps timed out'));
				else resolve(run.shimResult);
			};
			run.timer = setTimeout(() => {
				run.waiter = null;
				settle();
				reject(new Error('page steps timed out'));
			}, timeoutMs);
			this.bridge.postToWebview({ __automation: { runId: run.runId, steps } });
		});
	}

	private async evalInPage(params: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }> {
		if (typeof params.expr !== 'string' || params.expr === '') throw new Error('eval requires {expr: string}');
		this.requireView();
		const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
		try {
			const result = await this.runShimBatch([{ op: 'eval', expr: params.expr }], timeoutMs);
			if (!result.ok) return { ok: false, error: result.error ?? 'eval failed' };
			return { ok: true, value: result.results[0] };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : 'eval timed out' };
		}
	}

	/* ---------------- State queries (host reads through the real pipeline) ---------------- */

	private async queryRepoInfo(repo: string): Promise<any> {
		const result = await this.invokeRaw({
			message: { command: 'loadRepoInfo', repo, refreshId: 0, showRemoteBranches: true, showStashes: true, hideRemotes: [] },
			timeoutMs: DEFAULT_QUERY_TIMEOUT_MS
		});
		if (!result.ok) throw new Error('loadRepoInfo failed: ' + (result.error ?? 'unknown'));
		return result.response;
	}

	/**
	 * The engine's live commit page for `repo`, bypassing the view's cache. Public for the suite
	 * runner, which re-syncs the rendered page with the repository after a reseed: the seeded
	 * volatile state (stashes, the local-ahead commit) gets fresh hashes on every reseed, so the
	 * page's pre-reseed list and the engine's live state disagree until a refresh lands.
	 */
	public async queryCommits(repo: string, maxCommits: number): Promise<any[]> {
		const result = await this.invokeRaw({
			message: {
				// `hard: true` bypasses the view's commit cache: the probe must observe live
				// repository state, not a page cached before the repository changed (a stash
				// created after the view loaded would otherwise stay invisible forever — the
				// cache key has no notion of repository mutations).
				command: 'loadCommits', repo, refreshId: 0, hard: true,
				branches: null, authors: null, maxCommits, showTags: true, showRemoteBranches: true,
				includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false, commitOrdering: 'date',
				remotes: [], hideRemotes: [], stashes: [], gerritFetchRefs: false, gerritFetchLimit: null,
				gerritStatusFilter: { new: false, merged: false, abandoned: false, wip: false }
			},
			timeoutMs: DEFAULT_QUERY_TIMEOUT_MS
		});
		if (!result.ok) throw new Error('loadCommits failed: ' + (result.error ?? 'unknown'));
		return ((result.response as any)?.commits ?? []) as any[];
	}

	private async queryCommitDetails(repo: string, commitHash: string): Promise<any> {
		const result = await this.invokeRaw({
			message: { command: 'commitDetails', repo, commitHash, hasParents: true, stash: null, avatarEmail: null, refresh: false },
			timeoutMs: DEFAULT_QUERY_TIMEOUT_MS
		});
		if (!result.ok) throw new Error('commitDetails failed: ' + (result.error ?? 'unknown'));
		// The commitDetails response nests the payload (fileChanges included) one level down;
		// callers want that payload directly, not the response envelope.
		return (result.response as any)?.commitDetails ?? null;
	}

	/**
	 * The live-state seam the run context and the post-run verify resolve through: the same hard
	 * pipeline probes the engine itself reads with, handed to runContext/actionVerify as plain
	 * functions.
	 */
	private probes(): ContextProbes {
		return {
			viewState: () => this.bridge.viewState(),
			workingTreeFileExists: (context) => this.bridge.workingTreeFileExists(context),
			queryRepoInfo: (repo) => this.queryRepoInfo(repo),
			queryCommits: (repo, maxCommits) => this.queryCommits(repo, maxCommits),
			queryCommitDetails: (repo, commitHash) => this.queryCommitDetails(repo, commitHash)
		};
	}
}

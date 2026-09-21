import { performance } from 'perf_hooks';
import { Logger } from '../logger';
import { RequestMessage, ResponseMessage } from '../types';
import { AutomationAction, AutomationMode, CATALOG, NATIVE_SAVE_DIALOG_SKIP_REASON, UiStep, expandTemplate, validateCatalog } from './catalog';
import { HostBridge, ShimResult } from './hostBridge';

/**
 * The automation engine: the in-process half of the automation interface, driven directly by
 * the suite runner (the "Run Automation Test" button) — no sockets, no external ports. Each
 * catalogued action runs against the real view: UI mode posts step batches to the in-page shim,
 * request mode injects the equivalent request into the extension host's message pipeline, and
 * every run is timed from injection to the last expected host response. Host→webview traffic
 * is tapped at the single exit point of GitGraphView, so a run measures exactly what a user's
 * click would measure.
 *
 * The timing-sensitive methods (run / invoke / eval) are serialised so the timing windows of
 * concurrent runs can never overlap. Exactly one tap is registered on the view for the engine's
 * lifetime; every observation (traffic, run expectations, loss-warning confirmations, query
 * payloads) flows through it.
 */

export interface AutomationEngineDeps {
	readonly logger: Logger;
	readonly bridge: HostBridge;
	/** Extension version, reported for diagnostics. */
	readonly version: string;
}

export interface ActionSample {
	readonly totalMs: number;
	readonly responses: readonly { readonly command: string; readonly atMs: number }[];
}

export interface ActionStats {
	readonly id: string;
	readonly mode: AutomationMode;
	readonly runs: number;
	readonly failures: number;
	readonly minMs: number;
	readonly p50Ms: number;
	readonly p90Ms: number;
	readonly maxMs: number;
	readonly lastError: string | null;
}

const DEFAULT_RUN_TIMEOUT_MS = 30000;
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

interface ActiveRun {
	readonly runId: number;
	readonly mode: AutomationMode;
	readonly t0: number;
	/** Expected response commands still awaited. */
	readonly pending: Set<string>;
	/** Highest refresh id per command observed BEFORE this run started (stale-response guard). */
	readonly baseline: ReadonlyMap<string, number>;
	/** Refresh ids this run injected itself (request mode and invoke echo them back unchanged). */
	readonly injectedRefreshIds: Map<string, number>;
	/** Responses observed so far, with their arrival time relative to t0. */
	readonly seen: { command: string; atMs: number }[];
	/** TRUE once the page-side steps have completed (UI mode only). */
	shimComplete: boolean;
	shimResult: ShimResult | null;
	/** For invoke / query: the command whose payload is captured, and the payload. */
	invokeCommand: string | null;
	payload: unknown;
	waiter: (() => void) | null;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface RunOutcome {
	readonly ok: boolean;
	readonly skipped?: boolean;
	readonly reason?: string;
	readonly timings?: ActionSample;
	readonly response?: unknown;
	readonly error?: string;
}

export class AutomationServer {
	private readonly logger: Logger;
	private readonly bridge: HostBridge;
	readonly version: string;
	private readonly samples = new Map<string, number[]>();
	private readonly failureCounts = new Map<string, number>();
	private readonly lastErrors = new Map<string, string>();
	private activeRun: ActiveRun | null = null;
	private runIdSeq = 1;
	/** Serialises the timing-sensitive methods so their windows never overlap. */
	private chain: Promise<unknown> = Promise.resolve();
	private started = false;
	/**
	 * Highest refresh id observed per command across the engine's lifetime. The webview increments
	 * the id of every NEW loadRepoInfo/loadCommits request, while the load pipeline's follow-up
	 * responses (remote refs, "Uncommitted Changes") reuse the id of the request they complete —
	 * and can arrive seconds later, during a LATER run. A response belongs to the current run only
	 * when its id exceeds the baseline snapshot taken at the run's start (or it echoes an id the
	 * run itself injected, which request mode and invoke pin to 0).
	 */
	private readonly maxRefreshIds = new Map<string, number>();
	private offHostMessage: (() => void) | null = null;
	private offShimResult: (() => void) | null = null;

	constructor(deps: AutomationEngineDeps) {
		this.logger = deps.logger;
		this.bridge = deps.bridge;
		this.version = deps.version;
		const problems = validateCatalog(CATALOG);
		for (const problem of problems) this.logger.logError('Automation catalog: ' + problem);
		if (problems.length > 0) throw new Error('Invalid automation catalog (' + problems.length + ' problems)');
	}

	/** Register the view traffic taps. Idempotent; call stop() to unregister. */
	public start(): void {
		if (this.started) return;
		this.started = true;
		this.offHostMessage = this.bridge.onHostMessage((msg) => this.onHostMessage(msg));
		this.offShimResult = this.bridge.onShimResult((result) => this.onShimResult(result));
	}

	public stop(): void {
		if (!this.started) return;
		this.started = false;
		if (this.activeRun !== null) this.finishRun(new Error('Automation engine stopped'));
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
		const stats: ActionStats[] = [];
		for (const [key, samples] of this.samples) {
			const sorted = [...samples].sort((a, b) => a - b);
			const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
			const [id, mode] = key.split('|') as [string, AutomationMode];
			stats.push({
				id, mode,
				runs: sorted.length,
				failures: this.failureCounts.get(key) ?? 0,
				minMs: sorted[0], p50Ms: percentile(0.5), p90Ms: percentile(0.9), maxMs: sorted[sorted.length - 1],
				lastError: this.lastErrors.get(key) ?? null
			});
		}
		return stats.sort((a, b) => a.id.localeCompare(b.id));
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.chain.then(task, task);
		this.chain = result.then(() => undefined, () => undefined);
		return result;
	}

	/* ---------------- Traffic observation (the single view tap) ---------------- */

	private onHostMessage(msg: ResponseMessage): void {
		const run = this.activeRun;
		const refreshId = (msg as { refreshId?: unknown }).refreshId;
		if (typeof refreshId === 'number') {
			const known = this.maxRefreshIds.get(msg.command);
			if (known === undefined || refreshId > known) this.maxRefreshIds.set(msg.command, refreshId);
		}

		if (run !== null && msg.command === run.invokeCommand) {
			run.payload = msg;
		}

		// Request-mode loss-warning flow: the webview would show a dialog and re-send with
		// `confirmed`; the runner is not interactive, so confirm on its behalf.
		if (msg.command === 'lossWarning' && run !== null && run.mode === 'request') {
			const retry = (msg as unknown as { retry?: RequestMessage }).retry;
			if (retry !== undefined) {
				this.logger.log('Automation confirmed a data-loss warning for "' + retry.command + '"');
				this.bridge.inject(retry);
			}
		}

		if (run === null || !run.pending.has(msg.command)) return;
		// The final "Uncommitted Changes" follow-up of a previous load cycle is identifiable by its
		// `uncommittedCount` payload (the main response never carries it) and can arrive seconds
		// later — never let it satisfy a run's expectation.
		if (msg.command === 'loadCommits' && typeof (msg as { uncommittedCount?: unknown }).uncommittedCount === 'number') return;
		// Stale-response guard: a follow-up of a PREVIOUS load cycle reuses that cycle's refresh id,
		// which never exceeds the ids already observed when this run started. Matching by command
		// alone let such a follow-up satisfy the run's expectation before its own responses arrived,
		// flipping the recorded order and completing the run before the view had re-rendered.
		if (typeof refreshId === 'number'
			&& refreshId <= (run.baseline.get(msg.command) ?? -1)
			&& run.injectedRefreshIds.get(msg.command) !== refreshId) return;
		run.pending.delete(msg.command);
		run.seen.push({ command: msg.command, atMs: this.relative(run.t0) });
		if (run.pending.size === 0 && run.shimComplete) this.completeRun();
	}

	private onShimResult(result: ShimResult): void {
		const run = this.activeRun;
		if (run === null || run.runId !== result.runId) return;
		run.shimComplete = true;
		run.shimResult = result;
		// A failed step batch is final: the responses it never triggered cannot arrive anymore,
		// so end the run immediately with the step error instead of burning the whole timeout.
		// A skipped batch is final too: the control this action drives is not offered in this
		// view state, so its expected responses will not arrive either.
		if (!result.ok || result.skipped === true || run.pending.size === 0) this.completeRun();
	}

	private relative(t0: number): number {
		return Math.round((performance.now() - t0) * 100) / 100;
	}

	/** Resolve the active run's waiter, if any is waiting. */
	private completeRun(): void {
		const run = this.activeRun;
		if (run !== null && run.waiter !== null) {
			const waiter = run.waiter;
			run.waiter = null;
			waiter();
		}
	}

	/** Force-fail the active run (engine stop). */
	private finishRun(error: Error): void {
		const run = this.activeRun;
		if (run === null) return;
		if (run.timer !== null) clearTimeout(run.timer);
		run.timer = null;
		run.shimComplete = true;
		run.shimResult = { runId: run.runId, ok: false, results: [], error: error.message };
		this.completeRun();
	}

	/** Wait until the run's expectations are met, or the timeout elapses. */
	private waitForRun(run: ActiveRun, timeoutMs: number): Promise<'completed' | 'timeout'> {
		if (run.pending.size === 0 && run.shimComplete) return Promise.resolve('completed');
		return new Promise<'completed' | 'timeout'>((resolve) => {
			run.waiter = () => {
				if (run.timer !== null) clearTimeout(run.timer);
				run.timer = null;
				resolve('completed');
			};
			run.timer = setTimeout(() => {
				run.waiter = null;
				resolve('timeout');
			}, timeoutMs);
		});
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
		if (action.nativeSaveDialog === true) {
			// The engine-side backstop for the suite runner's skip: confirming this action opens
			// the editor's native save dialog (utils.archive's showSaveDialog), a modal no
			// automated run can drive or dismiss — in the real editor it stalls the whole run
			// until someone clicks it away. No caller, in any mode, may ever execute it.
			return { ok: false, skipped: true, reason: NATIVE_SAVE_DIALOG_SKIP_REASON };
		}
		const path = mode === 'ui' ? action.ui : mode === 'request' ? action.request : action.vscodeCommand;
		if (path === undefined) return { ok: false, skipped: true, reason: 'Action "' + id + '" has no ' + mode + ' path' };
		this.requireView();

		const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
		const context = await this.buildContext(action, params, mode);

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

		const run: ActiveRun = {
			runId: this.runIdSeq++, mode, t0: performance.now(),
			pending: new Set(action.expect.responses),
			baseline: new Map(this.maxRefreshIds), injectedRefreshIds: new Map(),
			seen: [],
			shimComplete: mode !== 'ui', shimResult: null,
			invokeCommand: null, payload: null, waiter: null, timer: null
		};
		this.activeRun = run;
		this.logger.log('Automation run ' + run.runId + ': ' + id + ' (' + mode + ')');

		// Command mode: native dialogs the command raises are answered with their primary action
		// for the whole run window (the command's continuation outlives executeCommand, which
		// resolves on dispatch — commands.ts's wrapper does not forward the handler's promise).
		let dialogs: ReturnType<HostBridge['installDialogAutoAnswer']> | null = null;
		let tabsBefore: string[] | null = null;
		try {
			if (mode === 'ui') {
				const steps = expandTemplate(action.ui as readonly UiStep[], context);
				this.bridge.postToWebview({ __automation: { runId: run.runId, steps } });
			} else if (mode === 'command') {
				dialogs = this.bridge.installDialogAutoAnswer();
				tabsBefore = action.expectTabs === true ? this.bridge.tabKeys() : null;
				await this.bridge.executeVscodeCommand(action.vscodeCommand!, context);
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

			const outcome = await this.waitForRun(run, timeoutMs);
			if (run.timer !== null) { clearTimeout(run.timer); run.timer = null; }

			if (outcome === 'timeout') {
				return this.record(action, mode, {
					ok: false,
					error: 'Timed out after ' + timeoutMs + ' ms waiting for ' + [...run.pending].join(', ')
						+ (mode === 'ui' && run.shimResult === null ? ' (page steps never completed)' : '')
				});
			}
			const shim = run.shimResult;
			if (shim !== null && !shim.ok) {
				return this.record(action, mode, {
					ok: false,
					error: 'Page step ' + (shim.failedStep ?? '?') + ' failed: ' + (shim.error ?? 'unknown')
				});
			}
			if (shim !== null && shim.skipped === true) {
				return this.record(action, mode, {
					ok: false, skipped: true,
					reason: shim.skipReason ?? 'a precondition of the action is absent in the view'
				});
			}

			const timings: ActionSample = { totalMs: this.relative(run.t0), responses: run.seen };
			if (mode === 'command') {
				// Page steps the command's completion gates on (verification barriers like the
				// first rendered row, and state restoration like clearing the file filter a
				// filterByFile command set). The batch gets its own run id, so a failure reports
				// its own step index.
				if (action.uiAfter !== undefined) {
					const after = await this.runShimBatch(expandTemplate(action.uiAfter, context), timeoutMs);
					if (!after.ok) {
						return this.record(action, mode, { ok: false, timings, error: 'Post step ' + (after.failedStep ?? '?') + ' failed: ' + (after.error ?? 'unknown') });
					}
					if (after.skipped === true) {
						return this.record(action, mode, { ok: false, skipped: true, reason: after.skipReason ?? 'a post-run precondition of the action is absent in the view' });
					}
				}
				if (tabsBefore !== null) {
					// The command's tab registers asynchronously: commands.ts's registerCommand
					// wrapper does not forward the handler's promise, so executeCommand resolves
					// on dispatch — often before the editor `vscode.open` is creating has entered
					// tabGroups.all. A single snapshot here races that registration and fails a
					// command that did open its tab; poll for the new key instead, and only a tab
					// that never appears fails the action.
					const before = tabsBefore;
					const deadline = performance.now() + 5000;
					for (;;) {
						const after = this.bridge.tabKeys();
						if (after !== null && after.some((key) => before.indexOf(key) === -1)) break;
						if (performance.now() > deadline) {
							return this.record(action, mode, { ok: false, timings, error: 'expected the command to open a new editor tab' });
						}
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
				}
			}
			if (action.verify !== undefined) {
				const verifyError = await this.verifyAction(action, context);
				if (verifyError !== null) {
					return this.record(action, mode, { ok: false, timings, error: verifyError });
				}
			}
			return this.record(action, mode, { ok: true, timings });
		} finally {
			this.activeRun = null;
			if (dialogs !== null) {
				for (const line of dialogs.autoAnswered) this.logger.log('Automation auto-answered a native dialog: ' + line);
				dialogs.restore();
			}
		}
	}

	/** Does any path of the action reference the placeholder? */
	private references(action: AutomationAction, name: string): boolean {
		const needle = '{{' + name + '}}';
		if (JSON.stringify(action.ui ?? []).indexOf(needle) !== -1
			|| JSON.stringify(action.uiAfter ?? []).indexOf(needle) !== -1
			|| JSON.stringify(action.request ?? []).indexOf(needle) !== -1) return true;
		// Command-mode argument shapes build their values from the context without a template:
		// every shape but the repository-root one carries a file, and the diff-document URI also
		// carries a commit.
		if (action.vscodeCommand !== undefined) {
			const arg = action.vscodeCommand.arg;
			if (name === 'file' && arg !== undefined && arg.kind !== 'rootUri') return true;
			if (name === 'commit' && arg !== undefined && arg.kind === 'diffUri') return true;
		}
		return false;
	}

	/** Build the placeholder context for an action from live repository state. */
	private async buildContext(action: AutomationAction, params: Record<string, unknown>, mode: AutomationMode): Promise<Record<string, string>> {
		const state = this.bridge.viewState();
		const repo = typeof params.repo === 'string' ? params.repo : state.currentRepo;
		if (typeof repo !== 'string' || repo === '') throw new Error('No repository is active in the Git Graph view');
		const context: Record<string, string> = { repo, ...stringifyParams(params) };
		context.reposCount = String(state.repos.length);

		const repoInfo = await this.queryRepoInfo(repo);
		context.head = repoInfo.head ?? '';
		const branches: string[] = repoInfo.branches ?? [];
		const localBranches: string[] = branches.filter((b) => b.indexOf('remotes/') !== 0);
		context.branch = localBranches.find((b) => b !== repoInfo.head) ?? localBranches[0] ?? '';
		// On a detached HEAD there is no checked-out branch name; any local branch still labels
		// a row the flows can reveal, so fall back to the first one.
		context.branchHead = repoInfo.head ?? localBranches[0] ?? '';
		context.branchCount = String(branches.length);
		// ResponseLoadRepoInfo carries remote NAMES only; remote-tracking branches appear in
		// `branches` as `remotes/<remote>/<branch>`.
		const remotes: string[] = repoInfo.remotes ?? [];
		context.remote = remotes[0] ?? '';
		const remotePrefix = context.remote === '' ? '' : 'remotes/' + context.remote + '/';
		const remoteBranchFull = remotePrefix === '' ? '' : branches.find((b) => b.indexOf(remotePrefix) === 0) ?? '';
		context.remoteBranch = remoteBranchFull === '' ? '' : remoteBranchFull.slice(remotePrefix.length);
		if (this.references(action, 'stash')) {
			// UI mode right-clicks the rendered stash label, which only exists for a stash inside
			// the loaded graph — the reflog can hold stashes far older than the loaded page (real
			// repositories), so resolve the placeholder from the same probed page the view renders
			// and let requires:['stash'] skip cleanly. Request mode addresses the host directly,
			// where every recorded stash is reachable regardless of what the view loaded.
			if (mode === 'request') {
				context.stash = (repoInfo.stashes ?? [])[0]?.selector ?? '';
			} else {
				const probed = await this.queryCommits(repo, 300);
				context.stash = probed.find((commit) => commit.stash !== null)?.stash?.selector ?? '';
			}
		}

		if (this.references(action, 'commit') || this.references(action, 'commitParent') || this.references(action, 'file')
			|| this.references(action, 'author') || this.references(action, 'findQuery')
			|| this.references(action, 'tag') || this.references(action, 'annotatedTag')
			|| this.references(action, 'binaryFile') || this.references(action, 'binaryCommit') || this.references(action, 'binaryCommitParent')
			|| this.references(action, 'imageFile') || this.references(action, 'imageCommit') || this.references(action, 'imageCommitParent')) {
			// A deeper page when tags are in play: they often sit further down the history than
			// the commits the other placeholders need (the fixture's first tag is ~100 deep).
			const wantsTags = this.references(action, 'tag') || this.references(action, 'annotatedTag');
			const commits = await this.queryCommits(repo, wantsTags ? 300 : 100);
			const pick = commits.find((c) => c.hash !== repoInfo.head) ?? commits[0];
			context.commit = pick?.hash ?? '';
			context.commitParent = pick?.parents?.[0] ?? '';
			if (this.references(action, 'author')) context.author = pick?.author ?? '';

			// A find query guaranteed to match: the first branch label of the loaded page (the
			// newest commits render first); fall back to the checked-out branch, any branch, and
			// finally the context commit's abbreviated hash.
			let findQuery = '';
			for (const commit of commits) {
				if ((commit.heads ?? []).length > 0) { findQuery = commit.heads[0]; break; }
			}
			if (findQuery === '') findQuery = context.branchHead;
			if (findQuery === '') findQuery = context.branch;
			if (findQuery === '') findQuery = (context.commit ?? '').slice(0, 8);
			context.findQuery = findQuery;

			// Tags of the loaded graph, newest first; annotated ones are marked (GitCommitTag).
			context.tag = '';
			context.annotatedTag = '';
			for (const commit of commits) {
				for (const tag of commit.tags ?? []) {
					if (context.tag === '') context.tag = tag.name;
					if (context.annotatedTag === '' && tag.annotated === true) context.annotatedTag = tag.name;
				}
			}

			if (this.references(action, 'file') && context.commit !== '') {
				// Prefer a commit whose file change satisfies every Commit Details menu condition
				// (a Modified, non-binary file: deletions hide "Open File", binaries hide the
				// working-file diff); probe past empty commits before settling for any file.
				const usable = (file: { type: string; additions: number | null; deletions: number | null; newFilePath: string }) =>
					file.type === 'M' && (file.additions !== null || file.deletions !== null);
				const candidates = commits.filter((c) => c.hash !== repoInfo.head).slice(0, 5);
				if (candidates.length === 0 && commits.length > 0) candidates.push(commits[0]);
				let fallback: { hash: string; parent: string; file: string } | null = null;
				for (const candidate of candidates) {
					const changes = (await this.queryCommitDetails(repo, candidate.hash))?.fileChanges ?? [];
					if (changes.length === 0) continue;
					const good = changes.find(usable);
					if (good !== undefined) {
						context.commit = candidate.hash;
						context.commitParent = candidate.parents?.[0] ?? '';
						context.file = good.newFilePath;
						break;
					}
					if (fallback === null) {
						const anyExisting = changes.find((file: { type: string; newFilePath: string }) => file.type !== 'D') ?? changes[0];
						fallback = { hash: candidate.hash, parent: candidate.parents?.[0] ?? '', file: anyExisting.newFilePath };
					}
				}
				if (context.file === undefined && fallback !== null) {
					context.commit = fallback.hash;
					context.commitParent = fallback.parent;
					context.file = fallback.file;
				}
				context.file = context.file ?? '';
			}

			if (action.vscodeCommand !== undefined && action.vscodeCommand.arg?.kind === 'diffUri') {
				// The `openFile` command opens the WORKING-TREE file, but the generic picker above
				// prefers a commit ≠ HEAD whose file need not exist at HEAD (the fixture resolves
				// to local-ahead's added-only note). Re-target to a Modified file of the loaded
				// page that exists on disk, so the command has something real to open.
				const candidates10 = commits.slice(0, 10);
				if (!this.bridge.workingTreeFileExists(context)) {
					for (const candidate of candidates10) {
						const changes = (await this.queryCommitDetails(repo, candidate.hash))?.fileChanges ?? [];
						const existing = changes.find((file: { type: string; newFilePath: string }) =>
							file.type === 'M' && this.bridge.workingTreeFileExists({ repo, file: file.newFilePath }));
						if (existing === undefined) continue;
						context.commit = candidate.hash;
						context.commitParent = candidate.parents?.[0] ?? '';
						context.file = existing.newFilePath;
						break;
					}
				}
			}

			if (this.references(action, 'binaryFile') || this.references(action, 'binaryCommit') || this.references(action, 'binaryCommitParent')
				|| this.references(action, 'imageFile') || this.references(action, 'imageCommit') || this.references(action, 'imageCommitParent')) {
				// Two independent binary scenarios the fixture seeds near HEAD (fixture.mjs's
				// specialAt commits): a plain binary file and a real decodable image, each added
				// then modified. Separate from `file`/`commit` above (which always prefers a
				// non-binary change) so an action can ask for either kind explicitly, to drive the
				// binary/image compare view (binaryCompareView.ts / comparisonView.ts) instead of
				// the text diff.
				const isImagePath = (filePath: string) => /\.(png|jpe?g|gif|bmp|webp|ico|avif|svg)$/i.test(filePath);
				context.binaryFile = ''; context.binaryCommit = ''; context.binaryCommitParent = '';
				context.imageFile = ''; context.imageCommit = ''; context.imageCommitParent = '';
				for (const candidate of commits) {
					if (candidate.hash === repoInfo.head) continue;
					if (context.binaryFile !== '' && context.imageFile !== '') break;
					const changes = (await this.queryCommitDetails(repo, candidate.hash))?.fileChanges ?? [];
					const binary = changes.find((file: { type: string; additions: number | null; deletions: number | null; newFilePath: string }) =>
						file.type === 'M' && file.additions === null && file.deletions === null);
					if (binary === undefined) continue;
					if (isImagePath(binary.newFilePath)) {
						if (context.imageFile === '') {
							context.imageFile = binary.newFilePath;
							context.imageCommit = candidate.hash;
							context.imageCommitParent = candidate.parents?.[0] ?? '';
						}
					} else if (context.binaryFile === '') {
						context.binaryFile = binary.newFilePath;
						context.binaryCommit = candidate.hash;
						context.binaryCommitParent = candidate.parents?.[0] ?? '';
					}
				}
			}
		}
		return context;
	}

	/** Check the post-run repository state against the action's verify declaration. */
	private async verifyAction(action: AutomationAction, context: Record<string, string>): Promise<string | null> {
		const verify = action.verify!;
		const name = verify.placeholder.slice(2, -2);
		if (!(name in context)) return 'verify placeholder "' + name + '" was not resolved';
		const expected = context[name];
		const repoInfo = await this.queryRepoInfo(context.repo);
		switch (verify.kind) {
			case 'headIs':
				return repoInfo.head === expected ? null : 'expected HEAD to be "' + expected + '", got "' + repoInfo.head + '"';
			case 'headIsNot':
				return repoInfo.head !== expected ? null : 'expected HEAD to differ from "' + expected + '"';
			case 'branchPresent':
				return (repoInfo.branches ?? []).includes(expected) ? null : 'expected branch "' + expected + '" to exist';
			case 'branchAbsent':
				return !(repoInfo.branches ?? []).includes(expected) ? null : 'expected branch "' + expected + '" to be gone';
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
		const run: ActiveRun = {
			runId: this.runIdSeq++, mode: 'request', t0: performance.now(),
			pending: new Set([command]),
			baseline: new Map(this.maxRefreshIds), injectedRefreshIds,
			seen: [],
			shimComplete: true, shimResult: null,
			invokeCommand: command, payload: null, waiter: null, timer: null
		};
		this.activeRun = run;
		try {
			this.bridge.inject(message as unknown as RequestMessage);
			const outcome = await this.waitForRun(run, timeoutMs);
			if (outcome === 'timeout') return { ok: false, error: 'Timed out after ' + timeoutMs + ' ms waiting for "' + command + '"' };
			return {
				ok: true,
				timings: { totalMs: this.relative(run.t0), responses: run.seen },
				response: run.payload
			};
		} finally {
			this.activeRun = null;
		}
	}

	/**
	 * Post one step batch to the page shim and await its result — the engine behind `gg.eval` and
	 * the command-mode post steps. The batch gets its own run id and its own ActiveRun slot (the
	 * owning catalog run has settled by the time post steps run), so failures report their own
	 * step index.
	 */
	private runShimBatch(steps: readonly UiStep[], timeoutMs: number): Promise<ShimResult> {
		const run: ActiveRun = {
			runId: this.runIdSeq++, mode: 'ui', t0: performance.now(),
			pending: new Set(), baseline: new Map(), injectedRefreshIds: new Map(),
			seen: [],
			shimComplete: false, shimResult: null,
			invokeCommand: null, payload: null, waiter: null, timer: null
		};
		this.activeRun = run;
		const settle = () => {
			if (run.timer !== null) { clearTimeout(run.timer); run.timer = null; }
			if (this.activeRun === run) this.activeRun = null;
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

	/* ---------------- Statistics ---------------- */

	private record(action: AutomationAction, mode: AutomationMode, outcome: RunOutcome): RunOutcome {
		const key = action.id + '|' + mode;
		if (outcome.timings !== undefined) {
			const list = this.samples.get(key) ?? [];
			list.push(outcome.timings.totalMs);
			this.samples.set(key, list);
		}
		if (!outcome.ok && !outcome.skipped) {
			this.failureCounts.set(key, (this.failureCounts.get(key) ?? 0) + 1);
			this.lastErrors.set(key, outcome.error ?? 'failed');
		} else if (outcome.ok) {
			this.lastErrors.delete(key);
		}
		this.logger.log('Automation ' + (outcome.ok ? 'ran' : outcome.skipped ? 'skipped' : 'FAILED') + ' ' + action.id + ' (' + mode + ')'
			+ (outcome.timings !== undefined ? ' in ' + outcome.timings.totalMs + ' ms' : '')
			+ (outcome.reason !== undefined ? ': ' + outcome.reason : '')
			+ (outcome.error !== undefined ? ': ' + outcome.error : ''));
		return outcome;
	}
}

/** Flatten run params into string placeholders (non-string values serialise as JSON). */
function stringifyParams(params: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(params)) {
		if (key === 'timeoutMs' || key === 'mode' || key === 'id') continue;
		out[key] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	return out;
}

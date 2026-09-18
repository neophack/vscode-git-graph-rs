import { performance } from 'perf_hooks';
import { Logger } from '../logger';
import { RequestMessage, ResponseMessage } from '../types';
import { AutomationAction, AutomationMode, CATALOG, UiStep, expandTemplate, validateCatalog } from './catalog';
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
		if (mode !== 'ui' && mode !== 'request') throw new Error('mode must be "ui" or "request"');
		const action = CATALOG.find((a) => a.id === id);
		if (action === undefined) throw new Error('Unknown action "' + id + '"');
		const path = mode === 'ui' ? action.ui : action.request;
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
		if (action.requires !== undefined && action.requires.includes('anotherBranch') && Number(context.branchCount ?? '0') < 2) {
			return { ok: false, skipped: true, reason: 'requires at least two branches' };
		}
		if (action.requires !== undefined && action.requires.includes('anotherRepo') && Number(context.reposCount ?? '0') < 2) {
			return { ok: false, skipped: true, reason: 'requires at least two known repositories' };
		}

		const run: ActiveRun = {
			runId: this.runIdSeq++, mode, t0: performance.now(),
			pending: new Set(action.expect.responses), seen: [],
			shimComplete: mode !== 'ui', shimResult: null,
			invokeCommand: null, payload: null, waiter: null, timer: null
		};
		this.activeRun = run;
		this.logger.log('Automation run ' + run.runId + ': ' + id + ' (' + mode + ')');

		try {
			if (mode === 'ui') {
				const steps = expandTemplate(action.ui as readonly UiStep[], context);
				this.bridge.postToWebview({ __automation: { runId: run.runId, steps } });
			} else {
				for (const template of action.request ?? []) {
					this.bridge.inject(expandTemplate(template, context) as unknown as RequestMessage);
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
			if (action.verify !== undefined) {
				const verifyError = await this.verifyAction(action, context);
				if (verifyError !== null) {
					return this.record(action, mode, { ok: false, timings, error: verifyError });
				}
			}
			return this.record(action, mode, { ok: true, timings });
		} finally {
			this.activeRun = null;
		}
	}

	/** Does any path of the action reference the placeholder? */
	private references(action: AutomationAction, name: string): boolean {
		const needle = '{{' + name + '}}';
		return JSON.stringify(action.ui ?? []).indexOf(needle) !== -1
			|| JSON.stringify(action.request ?? []).indexOf(needle) !== -1;
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
			|| this.references(action, 'tag') || this.references(action, 'annotatedTag')) {
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
		const run: ActiveRun = {
			runId: this.runIdSeq++, mode: 'request', t0: performance.now(),
			pending: new Set([command]), seen: [],
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

	private async evalInPage(params: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }> {
		if (typeof params.expr !== 'string' || params.expr === '') throw new Error('eval requires {expr: string}');
		this.requireView();
		const run: ActiveRun = {
			runId: this.runIdSeq++, mode: 'ui', t0: performance.now(),
			pending: new Set(), seen: [],
			shimComplete: false, shimResult: null,
			invokeCommand: null, payload: null, waiter: null, timer: null
		};
		this.activeRun = run;
		try {
			this.bridge.postToWebview({ __automation: { runId: run.runId, steps: [{ op: 'eval', expr: params.expr }] } });
			const outcome = await this.waitForRun(run, typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_RUN_TIMEOUT_MS);
			if (outcome === 'timeout' || run.shimResult === null) return { ok: false, error: 'eval timed out' };
			if (!run.shimResult.ok) return { ok: false, error: run.shimResult.error ?? 'eval failed' };
			return { ok: true, value: run.shimResult.results[0] };
		} finally {
			this.activeRun = null;
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

	private async queryCommits(repo: string, maxCommits: number): Promise<any[]> {
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
		return result.response;
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

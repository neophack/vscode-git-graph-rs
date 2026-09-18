import * as net from 'net';
import { performance } from 'perf_hooks';
import { Logger } from '../logger';
import { RequestMessage, ResponseMessage } from '../types';
import { AutomationAction, AutomationMode, CATALOG, UiStep, expandTemplate, validateCatalog } from './catalog';
import { HostBridge, ShimResult } from './hostBridge';
import {
	AutomationNotification, AutomationResponse, AutomationWireMessage,
	ERR_CLIENT_REJECTED, ERR_NO_VIEW,
	JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS, JSONRPC_METHOD_NOT_FOUND, JSONRPC_PARSE_ERROR,
	PROTOCOL_VERSION, decodeWireMessages, encodeWireMessage, isRequest, AutomationRequest
} from './protocol';

/**
 * The automation server: a localhost-only TCP listener inside the extension host speaking
 * JSON-RPC 2.0 (newline-delimited). A test driver connects, asks for the catalog, and runs
 * actions — each run is timed from injection to the last expected host response (plus, in UI
 * mode, completion of the in-page steps). Host→webview traffic is tapped at the single exit
 * point of GitGraphView, so a run measures exactly what a user's click would measure.
 *
 * One driver connection at a time (a second is rejected); gg.run/gg.invoke/gg.eval/gg.query
 * are serialised so the timing windows of concurrent runs can never overlap. Exactly one tap
 * is registered on the view for the server's lifetime; every observation (traffic, run
 * expectations, loss-warning confirmations, query payloads) flows through it.
 */

export interface AutomationServerDeps {
	readonly logger: Logger;
	readonly bridge: HostBridge;
	/** Extension version, reported by gg.ping. */
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
	/** For gg.invoke / gg.query: the command whose payload is captured, and the payload. */
	invokeCommand: string | null;
	payload: unknown;
	waiter: (() => void) | null;
	timer: ReturnType<typeof setTimeout> | null;
}

interface RunOutcome {
	readonly ok: boolean;
	readonly skipped?: boolean;
	readonly reason?: string;
	readonly timings?: ActionSample;
	readonly response?: unknown;
	readonly error?: string;
}

/** Error carrying a JSON-RPC error code, thrown by the helpers above. */
export class CodedError extends Error {
	public readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export class AutomationServer {
	private readonly logger: Logger;
	private readonly bridge: HostBridge;
	private readonly version: string;
	private server: net.Server | null = null;
	private client: net.Socket | null = null;
	private clientName = '';
	private lineBuffer = '';
	private runIdSeq = 1;
	private readonly samples = new Map<string, number[]>();
	private readonly failureCounts = new Map<string, number>();
	private readonly lastErrors = new Map<string, string>();
	private activeRun: ActiveRun | null = null;
	/** Serialises the timing-sensitive methods so their windows never overlap. */
	private chain: Promise<unknown> = Promise.resolve();
	private offHostMessage: (() => void) | null = null;
	private offShimResult: (() => void) | null = null;

	constructor(deps: AutomationServerDeps) {
		this.logger = deps.logger;
		this.bridge = deps.bridge;
		this.version = deps.version;
		const problems = validateCatalog(CATALOG);
		for (const problem of problems) this.logger.logError('Automation catalog: ' + problem);
		if (problems.length > 0) throw new Error('Invalid automation catalog (' + problems.length + ' problems)');
	}

	public get port(): number {
		if (this.server === null) return -1;
		const address = this.server.address();
		return typeof address === 'object' && address !== null ? address.port : -1;
	}

	public start(port: number): Promise<void> {
		if (this.server !== null) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const server = net.createServer((socket) => this.onConnection(socket));
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				server.removeListener('error', reject);
				this.server = server;
				this.offHostMessage = this.bridge.onHostMessage((msg) => this.onHostMessage(msg));
				this.offShimResult = this.bridge.onShimResult((result) => this.onShimResult(result));
				resolve();
			});
		});
	}

	public stop(): void {
		if (this.server === null) return;
		this.server.close();
		this.server = null;
		if (this.client !== null) {
			this.client.destroy();
			this.client = null;
		}
		if (this.activeRun !== null) this.finishRun(new Error('Automation server stopped'));
		if (this.offHostMessage !== null) { this.offHostMessage(); this.offHostMessage = null; }
		if (this.offShimResult !== null) { this.offShimResult(); this.offShimResult = null; }
	}

	/* ---------------- Socket handling ---------------- */

	private onConnection(socket: net.Socket): void {
		if (this.client !== null) {
			this.write(socket, {
				jsonrpc: '2.0', id: null,
				error: { code: ERR_CLIENT_REJECTED, message: 'An automation driver is already connected (' + this.clientName + ')' }
			});
			socket.destroy();
			this.logger.log('Rejected a second automation driver connection');
			return;
		}
		this.client = socket;
		this.clientName = socket.remoteAddress + ':' + String(socket.remotePort);
		this.lineBuffer = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => this.onData(String(chunk)));
		socket.on('close', () => {
			if (this.client === socket) {
				this.client = null;
				this.clientName = '';
				this.logger.log('Automation driver disconnected');
			}
		});
		socket.on('error', () => { /* close follows */ });
		this.logger.log('Automation driver connected from ' + this.clientName);
	}

	private onData(chunk: string): void {
		if (this.client === null) return;
		const decoded = decodeWireMessages(this.lineBuffer + chunk);
		this.lineBuffer = decoded.rest;
		for (const parseError of decoded.errors) {
			this.logger.logError('Automation driver sent an unparseable line: ' + parseError.error);
			this.write(this.client, { jsonrpc: '2.0', id: null, error: { code: JSONRPC_PARSE_ERROR, message: parseError.error } });
		}
		for (const message of decoded.messages) {
			if (isRequest(message)) {
				this.handleRequest(message).catch((error) => {
					const code = error instanceof CodedError ? error.code : JSONRPC_INTERNAL_ERROR;
					this.respond(message.id, undefined, { code, message: error instanceof Error ? error.message : String(error) });
				});
			}
			// Responses and notifications from the driver are not part of the contract: ignore.
		}
	}

	private write(socket: net.Socket, message: AutomationWireMessage): void {
		try { socket.write(encodeWireMessage(message)); } catch (_) { /* the socket is gone */ }
	}

	private respond(id: number | string | null, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
		if (this.client === null) return;
		const response: AutomationResponse = error !== undefined
			? { jsonrpc: '2.0', id: id ?? null, error }
			: { jsonrpc: '2.0', id: id ?? null, result };
		this.write(this.client, response);
	}

	private notify(method: string, params: unknown): void {
		if (this.client === null) return;
		const notification: AutomationNotification = { jsonrpc: '2.0', method, params };
		this.write(this.client, notification);
	}

	/* ---------------- Request dispatch ---------------- */

	private async handleRequest(request: AutomationRequest): Promise<void> {
		switch (request.method) {
			case 'gg.ping':
				this.respond(request.id, { pong: true, extension: 'git-graph-rs', protocol: PROTOCOL_VERSION, version: this.version });
				return;
			case 'gg.status':
				this.respond(request.id, this.bridge.viewState());
				return;
			case 'gg.catalog':
				this.respond(request.id, { protocol: PROTOCOL_VERSION, actions: CATALOG });
				return;
			case 'gg.stats':
				this.respond(request.id, this.computeStats());
				return;
			case 'gg.resetStats':
				this.samples.clear();
				this.failureCounts.clear();
				this.lastErrors.clear();
				this.respond(request.id, { reset: true });
				return;
			case 'gg.openView':
				this.respond(request.id, await this.openView(request.params));
				return;
			// Timing-sensitive methods run on the serialising chain.
			case 'gg.run':
			case 'gg.invoke':
			case 'gg.eval':
			case 'gg.query':
				this.respond(request.id, await this.enqueue(() => this.handleTimedMethod(request.method, request.params)));
				return;
			default:
				this.respond(request.id, undefined, { code: JSONRPC_METHOD_NOT_FOUND, message: 'Unknown method "' + request.method + '"' });
		}
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.chain.then(task, task);
		this.chain = result.then(() => undefined, () => undefined);
		return result;
	}

	private handleTimedMethod(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case 'gg.run': return this.runCatalogAction(params);
			case 'gg.invoke': return this.invokeRaw(params);
			case 'gg.eval': return this.evalInPage(params);
			case 'gg.query': return this.queryState(params);
			default: return Promise.reject(new CodedError(JSONRPC_METHOD_NOT_FOUND, 'Unknown method "' + method + '"'));
		}
	}

	/* ---------------- Traffic observation (the single view tap) ---------------- */

	private onHostMessage(msg: ResponseMessage): void {
		const run = this.activeRun;
		this.notify('gg.traffic', {
			command: msg.command,
			runId: run === null ? null : run.runId,
			atMs: run === null ? null : this.relative(run.t0)
		});

		if (run !== null && msg.command === run.invokeCommand) {
			run.payload = msg;
		}

		// Request-mode loss-warning flow: the webview would show a dialog and re-send with
		// `confirmed`; the driver is not interactive, so confirm on its behalf.
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
		if (run.pending.size === 0) this.completeRun();
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

	/** Force-fail the active run (server stop). */
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
		if (!this.bridge.hasView()) throw new CodedError(ERR_NO_VIEW, 'No Git Graph view is open (call gg.openView first)');
	}

	private parseParams(params: unknown): Record<string, unknown> {
		if (params === undefined || params === null) return {};
		if (typeof params !== 'object' || Array.isArray(params)) throw new CodedError(JSONRPC_INVALID_PARAMS, 'Params must be an object');
		return params as Record<string, unknown>;
	}

	private async openView(params: unknown): Promise<unknown> {
		const repo = this.parseParams(params).repo;
		if (typeof repo !== 'string' || repo === '') throw new CodedError(JSONRPC_INVALID_PARAMS, 'gg.openView requires {repo: string}');
		await this.bridge.openView(repo);
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
		throw new Error('Timed out waiting for the Git Graph view to load ' + repo);
	}

	/** Does any path of the action reference the placeholder? */
	private references(action: AutomationAction, name: string): boolean {
		const needle = '{{' + name + '}}';
		return JSON.stringify(action.ui ?? []).indexOf(needle) !== -1
			|| JSON.stringify(action.request ?? []).indexOf(needle) !== -1;
	}

	/** Build the placeholder context for an action from live repository state. */
	private async buildContext(action: AutomationAction, params: Record<string, unknown>): Promise<Record<string, string>> {
		const state = this.bridge.viewState();
		const repo = typeof params.repo === 'string' ? params.repo : state.currentRepo;
		if (typeof repo !== 'string' || repo === '') throw new Error('No repository is active in the Git Graph view');
		const context: Record<string, string> = { repo, ...stringifyParams(params) };

		const repoInfo = await this.queryRepoInfo(repo);
		context.head = repoInfo.head ?? '';
		const branches: string[] = repoInfo.branches ?? [];
		const localBranches: string[] = branches.filter((b) => b.indexOf('remotes/') !== 0);
		context.branch = localBranches.find((b) => b !== repoInfo.head) ?? localBranches[0] ?? '';
		context.branchHead = repoInfo.head ?? '';
		// ResponseLoadRepoInfo carries remote NAMES only; remote-tracking branches appear in
		// `branches` as `remotes/<remote>/<branch>`.
		const remotes: string[] = repoInfo.remotes ?? [];
		context.remote = remotes[0] ?? '';
		const remotePrefix = context.remote === '' ? '' : 'remotes/' + context.remote + '/';
		const remoteBranchFull = remotePrefix === '' ? '' : branches.find((b) => b.indexOf(remotePrefix) === 0) ?? '';
		context.remoteBranch = remoteBranchFull === '' ? '' : remoteBranchFull.slice(remotePrefix.length);
		if (this.references(action, 'stash')) context.stash = (repoInfo.stashes ?? [])[0]?.selector ?? '';

		if (this.references(action, 'commit') || this.references(action, 'commitParent') || this.references(action, 'file') || this.references(action, 'author')) {
			const commits = await this.queryCommits(repo, 100);
			const pick = commits.find((c) => c.hash !== repoInfo.head) ?? commits[0];
			context.commit = pick?.hash ?? '';
			context.commitParent = pick?.parents?.[0] ?? '';
			if (this.references(action, 'author')) context.author = pick?.author ?? '';
			if (this.references(action, 'file')) {
				const details = await this.queryCommitDetails(repo, context.commit);
				context.file = details?.fileChanges?.[0]?.newFilePath ?? '';
			}
		}
		return context;
	}

	private async runCatalogAction(params: unknown): Promise<RunOutcome> {
		const p = this.parseParams(params);
		const id = p.id, mode = (p.mode ?? 'ui') as AutomationMode;
		if (typeof id !== 'string') throw new CodedError(JSONRPC_INVALID_PARAMS, 'gg.run requires {id: string}');
		if (mode !== 'ui' && mode !== 'request') throw new CodedError(JSONRPC_INVALID_PARAMS, 'mode must be "ui" or "request"');
		const action = CATALOG.find((a) => a.id === id);
		if (action === undefined) throw new CodedError(JSONRPC_INVALID_PARAMS, 'Unknown action "' + id + '"');
		const path = mode === 'ui' ? action.ui : action.request;
		if (path === undefined) return { ok: false, skipped: true, reason: 'Action "' + id + '" has no ' + mode + ' path' };
		this.requireView();

		const timeoutMs = typeof p.timeoutMs === 'number' ? p.timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
		const context = await this.buildContext(action, p);

		if (action.requires !== undefined && action.requires.includes('remote') && context.remote === '') {
			return { ok: false, skipped: true, reason: 'requires a configured remote' };
		}
		if (action.requires !== undefined && action.requires.includes('stash') && context.stash === '') {
			return { ok: false, skipped: true, reason: 'requires at least one stash' };
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

	private async invokeRaw(params: unknown): Promise<RunOutcome> {
		const p = this.parseParams(params);
		const message = p.message as Record<string, unknown>;
		if (typeof message !== 'object' || message === null || typeof message.command !== 'string') {
			throw new CodedError(JSONRPC_INVALID_PARAMS, 'gg.invoke requires {message: RequestMessage}');
		}
		this.requireView();
		const timeoutMs = typeof p.timeoutMs === 'number' ? p.timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
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

	private async evalInPage(params: unknown): Promise<unknown> {
		const p = this.parseParams(params);
		if (typeof p.expr !== 'string' || p.expr === '') throw new CodedError(JSONRPC_INVALID_PARAMS, 'gg.eval requires {expr: string}');
		this.requireView();
		const run: ActiveRun = {
			runId: this.runIdSeq++, mode: 'ui', t0: performance.now(),
			pending: new Set(), seen: [],
			shimComplete: false, shimResult: null,
			invokeCommand: null, payload: null, waiter: null, timer: null
		};
		this.activeRun = run;
		try {
			this.bridge.postToWebview({ __automation: { runId: run.runId, steps: [{ op: 'eval', expr: p.expr }] } });
			const outcome = await this.waitForRun(run, typeof p.timeoutMs === 'number' ? p.timeoutMs : DEFAULT_RUN_TIMEOUT_MS);
			if (outcome === 'timeout' || run.shimResult === null) return { ok: false, error: 'eval timed out' };
			if (!run.shimResult.ok) return { ok: false, error: run.shimResult.error ?? 'eval failed' };
			return { ok: true, value: run.shimResult.results[0] };
		} finally {
			this.activeRun = null;
		}
	}

	private async queryState(params: unknown): Promise<unknown> {
		const p = this.parseParams(params);
		const kind = p.kind;
		if (kind === 'repos') return this.bridge.viewState().repos;
		this.requireView();
		const repo = typeof p.repo === 'string' ? p.repo : this.bridge.viewState().currentRepo;
		if (typeof repo !== 'string' || repo === '') throw new CodedError(JSONRPC_INVALID_PARAMS, 'gg.query requires an active repository');
		if (kind === 'repoInfo') return this.queryRepoInfo(repo);
		if (kind === 'commits') return this.queryCommits(repo, typeof p.maxCommits === 'number' ? p.maxCommits : 100);
		throw new CodedError(JSONRPC_INVALID_PARAMS, 'Unknown query kind "' + String(kind) + '" (use repos | repoInfo | commits)');
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
				command: 'loadCommits', repo, refreshId: 0, hard: false,
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

	private computeStats(): ActionStats[] {
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

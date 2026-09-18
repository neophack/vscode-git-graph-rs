import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from '../logger';
import { AutomationAction, AutomationMode, CATALOG } from './catalog';
import { HostBridge } from './hostBridge';
import { AutomationServer } from './server';

/**
 * The in-process automation suite runner — the "Run Automation Test" button's engine. It starts
 * the automation server on an ephemeral localhost port, connects a loopback client to it, and
 * runs the catalog's read suite (safe on any repository) and, when the active repository is a
 * fixture clone (`.gg-fixture` marker), the write suite — reseeding the clone from its bare
 * remote first, so the button never needs an external driver and never touches a real repo.
 */

const execFileAsync = promisify(execFile);

export interface SuiteProgress {
	readonly phase: 'read' | 'write';
	/** 1-based position within the phase. */
	readonly index: number;
	readonly total: number;
	readonly actionId: string;
	readonly mode: AutomationMode;
}

export interface ActionRunRecord {
	readonly id: string;
	readonly title: string;
	readonly group: string;
	readonly mode: AutomationMode;
	readonly ok: boolean;
	readonly skipped: boolean;
	readonly reason: string | null;
	readonly error: string | null;
	readonly totalMs: number | null;
	readonly responses: readonly { readonly command: string; readonly atMs: number }[];
}

export interface SuiteReport {
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly repo: string;
	/** TRUE when the active repository is a fixture clone (the write suite ran against it). */
	readonly fixture: boolean;
	readonly writeSuiteIncluded: boolean;
	readonly suites: readonly { readonly name: 'read' | 'write'; readonly runs: readonly ActionRunRecord[] }[];
	readonly totals: { readonly actions: number; readonly passed: number; readonly failed: number; readonly skipped: number };
}

export interface SuiteRunOptions {
	readonly logger: Logger;
	/** Repository to run against (defaults to the view's current repository). */
	readonly repo?: string;
	/** Progress callback invoked after each action completes. */
	readonly onProgress?: (progress: SuiteProgress) => void;
	readonly actionTimeoutMs?: number;
	/** Restrict the run to a subset of actions (the report and progress still cover the subset). */
	readonly filter?: (action: AutomationAction) => boolean;
	/** Force the write suite off (used by tests; the runner also skips it for non-fixture repos). */
	readonly skipWriteSuite?: boolean;
}

/** Is `repo` a fixture clone carrying the `.gg-fixture` marker? */
export function isAutomationFixtureClone(repo: string): boolean {
	try {
		return fs.existsSync(path.join(repo, '.gg-fixture'));
	} catch (_) {
		return false;
	}
}

/** Remove a directory tree across the Node versions this extension builds against. */
function rmRecursive(target: string): void {
	const f = fs as unknown as {
		rmSync?: (p: string, o: { recursive: boolean; force: boolean }) => void;
		rmdirSync: (p: string, o?: { recursive?: boolean }) => void;
	};
	if (f.rmSync !== undefined) {
		f.rmSync(target, { recursive: true, force: true });
	} else {
		f.rmdirSync(target, { recursive: true });
	}
}

/** Read the fixture marker (NULL when the repository is not a fixture clone). */
export function readFixtureMarker(repo: string): { remote: string } | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(repo, '.gg-fixture'), 'utf8')) as { remote?: unknown };
		return typeof parsed.remote === 'string' ? { remote: parsed.remote } : null;
	} catch (_) {
		return null;
	}
}

/**
 * Reset a fixture clone to a pristine, seeded state: delete it, re-clone from the bare remote
 * recorded in the marker, restore the marker (a fresh clone does not carry it), and replay the
 * seed routine (3 stashes, an untracked file, the local-ahead branch) so write actions have the
 * same starting state on every run. Mirrors scripts/automation/fixture.mjs's seedRepo.
 */
export async function reseedFixtureClone(repo: string): Promise<void> {
	const marker = readFixtureMarker(repo);
	if (marker === null) throw new Error(repo + ' is not a fixture clone (no .gg-fixture marker)');
	const git = async (args: string[]) => {
		await execFileAsync('git', args, { timeout: 120000, windowsHide: true });
	};
	rmRecursive(repo);
	await git(['clone', marker.remote, repo]);
	fs.writeFileSync(path.join(repo, '.gg-fixture'), JSON.stringify(marker, null, 2) + '\n');

	const rng = (() => { let s = 987654321 >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
	await git(['-C', repo, 'stash', 'clear']);
	await git(['-C', repo, 'checkout', '-f', 'main']);
	await git(['-C', repo, 'reset', '--hard', 'origin/main']);
	const files = fs.readdirSync(path.join(repo, 'src', 'module-000')).filter((f) => f.endsWith('.ts'));
	if (files.length === 0) throw new Error(repo + ' has no seeded files to stash');
	const tracked = ['src/module-000/' + files[0]];
	for (let i = 0; i < 3; i++) {
		const file = tracked[0];
		fs.appendFileSync(path.join(repo, file),
			'\n// fixture-stash-' + (i + 1) + '\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
		await git(['-C', repo, 'stash', 'push', '-m', 'fixture-stash-' + (i + 1), '--', file]);
	}
	fs.writeFileSync(path.join(repo, 'untracked-fixture.txt'), 'fixture untracked file\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
	await git(['-C', repo, 'checkout', '-b', 'local-ahead']);
	fs.writeFileSync(path.join(repo, 'local-ahead-note.txt'), 'local-ahead is one commit ahead of origin/main\n// ' + Math.floor(rng() * 1e9).toString(36) + '\n');
	await git(['-C', repo, 'add', 'local-ahead-note.txt']);
	await git(['-C', repo, 'commit', '-m', 'local-ahead fixture commit']);
	await git(['-C', repo, 'checkout', 'main']);
}

/* ---------------- The loopback wire client ---------------- */

class LoopbackClient {
	private socket: net.Socket | null = null;
	private buffer = '';
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	async connect(port: number): Promise<void> {
		this.socket = net.createConnection({ host: '127.0.0.1', port });
		this.socket.setEncoding('utf8');
		this.socket.on('data', (chunk) => this.onData(String(chunk)));
		await new Promise<void>((resolve, reject) => {
			this.socket!.once('connect', resolve);
			this.socket!.once('error', reject);
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim() === '') continue;
			const message = JSON.parse(line) as { id?: number; error?: { code: number; message: string } };
			if (message.id !== undefined && this.pending.has(message.id)) {
				const entry = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				if (message.error !== undefined) {
					const error = new Error(message.error.message);
					(error as Error & { code: number }).code = message.error.code;
					entry.reject(error);
				} else {
					entry.resolve(message);
				}
			}
		}
	}

	call(method: string, params?: unknown): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.pending.set(id, { resolve: (msg) => resolve((msg as { result: unknown }).result), reject });
			this.socket!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
		});
	}

	close(): void {
		this.socket?.destroy();
		this.socket = null;
	}
}

/* ---------------- The suite run ---------------- */

export async function runAutomationSuite(options: SuiteRunOptions): Promise<SuiteReport> {
	const startedMs = Date.now();
	const server = new AutomationServer({ logger: options.logger, bridge: new HostBridge(), version: 'in-process' });
	await server.start(0);
	const client = new LoopbackClient();
	try {
		await client.connect(server.port);
		await client.call('gg.ping');

		const timeoutMs = options.actionTimeoutMs ?? 30000;
		const sameRepo = (a: string | null, b: string) =>
			a !== null && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
		let status = await client.call('gg.status') as { currentRepo: string | null };
		let repo = options.repo ?? status.currentRepo;
		if (repo === null || repo === '') {
			throw new Error('No repository is active in the Git Graph view');
		}
		if (!sameRepo(status.currentRepo, repo)) {
			await client.call('gg.openView', { repo });
			for (let i = 0; i < 600; i++) {
				status = await client.call('gg.status') as { currentRepo: string | null };
				if (sameRepo(status.currentRepo, repo)) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

		const fixture = isAutomationFixtureClone(repo);
		const includeWrite = !options.skipWriteSuite && fixture;
		const filter = options.filter ?? (() => true);
		const readActions = CATALOG.filter((a) => !a.mutable && filter(a));
		const writeActions = includeWrite ? CATALOG.filter((a) => a.mutable && filter(a)) : [];
		const grandTotal = readActions.length + writeActions.length;

		const runPhase = async (phase: 'read' | 'write', actions: readonly AutomationAction[], offset: number): Promise<ActionRunRecord[]> => {
			const runs: ActionRunRecord[] = [];
			for (let i = 0; i < actions.length; i++) {
				const action = actions[i];
				const mode: AutomationMode = action.ui !== undefined ? 'ui' : 'request';
				let record: ActionRunRecord;
				try {
					const outcome = await client.call('gg.run', { id: action.id, mode, timeoutMs }) as {
						ok: boolean; skipped?: boolean; reason?: string; error?: string;
						timings?: { totalMs: number; responses: { command: string; atMs: number }[] };
					};
					record = {
						id: action.id, title: action.title, group: action.group, mode,
						ok: outcome.ok, skipped: outcome.skipped === true,
						reason: outcome.reason ?? null, error: outcome.error ?? null,
						totalMs: outcome.timings?.totalMs ?? null,
						responses: outcome.timings?.responses ?? []
					};
				} catch (error) {
					record = {
						id: action.id, title: action.title, group: action.group, mode,
						ok: false, skipped: false, reason: null,
						error: error instanceof Error ? error.message : String(error),
						totalMs: null, responses: []
					};
				}
				runs.push(record);
				options.onProgress?.({ phase, index: i + 1, total: actions.length, actionId: action.id, mode });
				void offset; // phases report their own index; grand total is derivable from the report
			}
			return runs;
		};

		const readRuns = await runPhase('read', readActions, 0);
		let writeRuns: ActionRunRecord[] = [];
		if (includeWrite) {
			await reseedFixtureClone(repo);
			writeRuns = await runPhase('write', writeActions, readActions.length);
		}

		const all = [...readRuns, ...writeRuns];
		const totals = {
			actions: all.length,
			passed: all.filter((r) => r.ok).length,
			failed: all.filter((r) => !r.ok && !r.skipped).length,
			skipped: all.filter((r) => r.skipped).length
		};
		const finishedMs = Date.now();
		void grandTotal;
		return {
			startedAt: new Date(startedMs).toISOString(),
			finishedAt: new Date(finishedMs).toISOString(),
			durationMs: finishedMs - startedMs,
			repo, fixture, writeSuiteIncluded: includeWrite,
			suites: [{ name: 'read', runs: readRuns }, { name: 'write', runs: writeRuns }],
			totals
		};
	} finally {
		client.close();
		server.stop();
	}
}

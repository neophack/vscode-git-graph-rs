/**
 * The inbound webview->host message router (handlers/index.ts's dispatchRequest) under fuzzed
 * and adversarial input (OPTIMIZATION-PLAN V3, REFACTOR-PLAN 3.2's minimal runtime guard):
 *
 *  - a randomized batch of JSON messages (seeded, so a failure reproduces exactly) never
 *    crashes the router, and every message whose `command` is not a known handler-table key
 *    answers 'unknown' with ZERO context ports touched - nothing was dispatched;
 *  - inherited/polluting names (`toString`, `__proto__`, ...) are unknown commands, and a
 *    polluting payload never enters the handler table;
 *  - every protocol command is dispatched (never 'unknown') when it arrives well-formed;
 *  - a well-formed mutating command naming a repository path OUTSIDE the repository registry
 *    cannot mutate anything: its op is refused or fails, an error response reaches the webview,
 *    and no git process is spawned for the refused case.
 *
 * Scope note (the half of plan 3.2 that does NOT hold yet): the router itself guards the
 * `command` only - the `repo` must name a known repository" check is the panel caller's
 * responsibility per dispatchRequest's contract, and panel.ts does not implement it (it is a
 * sibling-owned file of this wave). What this suite pins instead is the next-best guarantee
 * proved end to end: an unknown repo path can reach a genuine handler, but the write chain
 * behind it refuses or fails without any mutation, and the error is surfaced. A pre-dispatch
 * repo allowlist in the panel would tighten this to rejection without dispatch.
 */

import * as cp from 'child_process';
import { describe, expect, it } from 'vitest';

import { REQUEST_COMMANDS } from '../../../src/shared/protocol/graphView';
import type { ResponseMessage } from '../../../src/types';
import { GitProcess } from '../../../src/extension/git/process/gitProcess';
import { GitWriter } from '../../../src/extension/git/write/gitWriter';
import type { HandlerContext } from '../../../src/extension/graphView/handlers/context';
import type { ProductionGitRepository } from '../../../src/extension/git/gitRepository';
import type { GitRunnerPort } from '../../../src/extension/graphView/gitRunner';
import { dispatchRequest, isMutatingCommand } from '../../../src/extension/graphView/handlers/index';
import { SquashMessageFormat, TagType } from '../../../src/types';

/** Deterministic 32-bit LCG, so a fuzz failure reproduces from the seed in the test name. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

/**
 * A context that records every property READ and CALL as a dispatch side effect: a handler
 * cannot reach any port, config, or send without leaving a trace, so "touched nothing" is the
 * strict form of "was not dispatched". Every property is an arbitrary-depth chain node that is
 * itself callable and resolves to null, so genuine handlers run to completion through it.
 */
function touchedContext(): { ctx: HandlerContext; touched(): string[] } {
	const keys: string[] = [];
	const makeNode: () => unknown = () => {
		const callable = () => {
			keys.push('()');
			return Promise.resolve(null);
		};
		return new Proxy(callable, {
			apply(_target, _thisArg, _args) {
				keys.push('()');
				return Promise.resolve(null);
			},
			get(_target, prop) {
				// Never expose a thenable or an exotic symbol: awaiting the chain must resolve
				// from a CALL, and Vitest's serialisers must not recurse into the proxy.
				if (typeof prop !== 'string' || prop === 'then') return undefined;
				keys.push(prop);
				return makeNode();
			}
		});
	};
	const ctx = new Proxy({}, {
		get(_target, prop) {
			if (typeof prop !== 'string' || prop === 'then') return undefined;
			keys.push(prop);
			return makeNode();
		}
	});
	return { ctx: ctx as unknown as HandlerContext, touched: () => keys.slice() };
}

/** The fields beyond `command`/`repo` the three real-writer handlers dereference. */
const WRITE_FIXTURES: { [command: string]: { [field: string]: unknown } } = {
	createBranch: { branchName: 'topic', commitHash: 'a'.repeat(40), checkout: false, force: false },
	deleteBranch: { branchName: 'topic', forceDelete: false, deleteOnRemotes: [] },
	addTag: { tagName: 'v1', commitHash: 'a'.repeat(40), type: TagType.Lightweight, message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false }
};

/**
 * A full context over a REAL write chain (GitWriter over an injectable GitProcess, wrapped in
 * the GitRepository facade exactly as the composition root wires it) with canned reads and
 * recording ports for everything else.
 */
function realWriterContext(process: GitProcess): {
	ctx: HandlerContext; sent(): ResponseMessage[]; writes(): Array<{ repo: string; op: { steps: ReadonlyArray<{ argv: ReadonlyArray<string> }> } }>;
} {
	const sentMessages: ResponseMessage[] = [];
	const writeRuns: Array<{ repo: string; op: { steps: ReadonlyArray<{ argv: ReadonlyArray<string> }> } }> = [];
	const calls: string[] = [];
	const recording = <T>(result: T) => (...args: unknown[]) => {
		calls.push(String(args[0]));
		return Promise.resolve(result);
	};

	const read: { [method: string]: unknown } = {
		getRemotes: recording([]),
		currentBranchName: recording(null),
		repoRoot: recording('/repo')
	};
	const writer = new GitWriter(process, () => ({ signCommits: false, signTags: false }), (key) => key);
	const repo = {
		read: read,
		write: {
			run: (repoPath: string, op: { steps: ReadonlyArray<{ argv: ReadonlyArray<string> }> }) => {
				writeRuns.push({ repo: repoPath, op: op });
				return writer.run(repoPath, op as Parameters<typeof writer.run>[1]);
			},
			policies: { signCommits: false, signTags: false }
		},
		getOperationState: () => Promise.resolve({ type: null, conflictedFiles: [], progress: null })
	} as unknown as ProductionGitRepository;

	const git: { [method: string]: unknown } = {
		gitOutput: (_args: unknown, _repo: unknown, resolveValue: (stdout: string) => unknown) => Promise.resolve(resolveValue('')),
		runGitCommand: () => Promise.resolve(null),
		runGitCommandWithInput: () => Promise.resolve(null),
		collect: () => Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: '' }),
		hasGit: () => true,
		gitPath: () => null,
		parseGerritMetas: null,
		listChangeRefs: null
	};

	const ctx = {
		repo: repo,
		git: git as unknown as GitRunnerPort,
		repoConfig: { load: () => Promise.resolve({ config: null, error: null }), invalidate: () => undefined },
		gerrit: { clearLocalChanges: () => Promise.resolve({ error: null, cleared: 0 }) },
		t: (key: string, ...params: Array<string | number>): string => JSON.stringify([key, ...params]),
		config: {
			gerrit: { remote: 'gerrit' },
			showRemoteHeads: false,
			squashPullMessageFormat: SquashMessageFormat.Default,
			squashMergeMessageFormat: SquashMessageFormat.Default
		},
		ui: new Proxy({}, { get: () => () => Promise.resolve(null) }),
		loader: {
			loadCommits: () => Promise.resolve(),
			loadView: () => Promise.resolve(),
			markGerritStale: () => undefined,
			unmarkGerritStale: () => undefined,
			clearGerritCache: () => undefined,
			invalidateCommitCache: () => undefined,
			viewHasCommits: false,
			viewRepoChanged: () => undefined
		},
		avatars: { fetchAvatarImage: () => undefined, getAvatarImage: () => Promise.resolve(null) },
		storage: { getCodeReview: () => null, getLastActiveRepo: () => null },
		repos: {
			getRepos: () => ({}),
			checkReposExist: () => Promise.resolve(false),
			setRepoState: () => undefined,
			exportRepoConfig: () => Promise.resolve(null),
			rescanForRepos: () => Promise.resolve()
		},
		userConfig: new Proxy({}, { get: () => () => Promise.resolve(null) }),
		settings: { setGlobalSetting: () => Promise.resolve(null) },
		pullRequests: { fetchPullRequests: () => Promise.resolve(null), fetchPullRequestHeadRefs: () => Promise.resolve() },
		view: { viewHasCommits: false, noteRefreshId: () => undefined, repoSwitched: () => undefined, viewReady: () => undefined },
		send: (msg: ResponseMessage) => {
			sentMessages.push(msg);
		}
	} as unknown as HandlerContext;
	return { ctx: ctx, sent: () => sentMessages, writes: () => writeRuns };
}

describe('the inbound message router under fuzz (V3)', () => {
	it('answers 4000 random JSON messages without crashing, dispatching unknown commands, or touching a port', async () => {
		const rand = lcg(0x6d2b79f5);
		const knownCommands = [...REQUEST_COMMANDS];
		const junkWords = ['', 'loadCommit', 'LoadCommits', 'loadCommits ', ' loadCommits', 'loadCommits\n', '__proto__', 'toString', 'command', 'undefined', '0', '-1'];
		const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(rand() * items.length)]!;

		const randomValue = (depth: number): unknown => {
			const roll = rand();
			if (depth <= 0 || roll < 0.45) {
				const leaf = rand();
				if (leaf < 0.3) return Math.floor(rand() * 1000) - 500;
				if (leaf < 0.5) return pick(junkWords);
				if (leaf < 0.7) return pick([null, undefined, true, false]);
				if (leaf < 0.9) return pick(knownCommands);
				return pick([NaN, Infinity, { nested: 'object' }, Symbol.for('gg-fuzz')]);
			}
			if (roll < 0.7) {
				return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(depth - 1));
			}
			const obj: { [key: string]: unknown } = {};
			const keys = ['command', 'repo', 'refreshId', '__proto__', 'constructor', 'branchName', 'commitHash', pick(junkWords)];
			for (let i = 0; i < 1 + Math.floor(rand() * 4); i++) {
				obj[pick(keys)] = randomValue(depth - 1);
			}
			return obj;
		};

		// Half the batch is MESSAGE-SHAPED (a command field of every shape of wrongness plus
		// random extra fields), half is arbitrary JSON - the router sees both.
		const randomMessage = (): unknown => {
			if (rand() < 0.5) return randomValue(3);
			const commandRoll = rand();
			const command = commandRoll < 0.6 ? pick(knownCommands)
				: commandRoll < 0.9 ? pick(junkWords)
					: randomValue(1);
			const message: { [key: string]: unknown } = { command: command, repo: pick([undefined, null, '/repo', '', randomValue(1)]) };
			for (let i = 0; i < Math.floor(rand() * 4); i++) {
				message[pick(['refreshId', '__proto__', 'branchName', 'commitHash', 'confirmed', pick(junkWords)])] = randomValue(2);
			}
			return message;
		};

		let dispatched = 0;
		let refused = 0;
		for (let i = 0; i < 4000; i++) {
			const message = randomMessage();
			const { ctx, touched } = touchedContext();
			const outcome = await dispatchRequest(message, ctx).then(
				(result) => result,
				() => 'rejected' as const
			);
			expect(outcome === 'unknown' || outcome === 'handled' || outcome === 'rejected', 'the router answers or the handler rejects, never hangs').toBe(true);
			if (outcome === 'unknown') {
				// The strict form of "rejected without dispatch": no port, config or send was read.
				expect(touched(), 'unknown message dispatched nothing: ' + JSON.stringify(message, jsonReplacer)).toEqual([]);
				refused++;
			} else {
				dispatched++;
			}
		}
		// The fuzz must genuinely exercise both sides, not degenerate into one outcome.
		expect(dispatched).toBeGreaterThan(200);
		expect(refused).toBeGreaterThan(200);
	}, 60000);

	it('treats inherited and polluting names as unknown commands', async () => {
		for (const command of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__proto__']) {
			const { ctx, touched } = touchedContext();
			await expect(dispatchRequest({ command: command, repo: '/repo' }, ctx)).resolves.toBe('unknown');
			expect(touched(), command).toEqual([]);
		}
	});

	it('never lets a polluting payload enter the handler table', async () => {
		const polluted = JSON.parse('{"__proto__":{"isAdmin":true},"command":"ready"}');
		const { ctx, touched } = touchedContext();
		await expect(dispatchRequest(polluted, ctx)).resolves.toBe('handled');
		expect(touched()).toContain('view'); // the genuine `ready` handler ran
		// A polluted Object.prototype would hand every fresh object an `isAdmin`.
		expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
	});

	it('dispatches every well-formed mutating command (never misclassified as unknown)', async () => {
		for (const command of Object.keys(WRITE_FIXTURES)) {
			const { ctx, touched } = touchedContext();
			const message = { command: command, repo: '/repo', ...WRITE_FIXTURES[command] };
			await expect(dispatchRequest(message, ctx)).resolves.toBe('handled');
			expect(touched().length, command).toBeGreaterThan(0);
			expect(isMutatingCommand(command)).toBe(true);
		}
	});
});

describe('a forged mutating command against an unknown repository path', () => {
	const unknownRepo = '/definitely/not/a/git-graph-rs/repository';

	it('is refused before any git process exists (no Git resolution, zero spawns)', async () => {
		let spawns = 0;
		const neverSpawn = (): never => {
			spawns++;
			throw new Error('no spawn may be attempted for a refused write');
		};
		const process = new GitProcess(() => null, neverSpawn);
		for (const command of Object.keys(WRITE_FIXTURES)) {
			const { ctx, sent, writes } = realWriterContext(process);
			const message = { command: command, repo: unknownRepo, ...WRITE_FIXTURES[command] };
			await expect(dispatchRequest(message, ctx), command).resolves.toBe('handled');
			expect(writes().map((run) => run.repo), command).toEqual([unknownRepo]);
			expect(spawns, command).toBe(0);
			// The refusal reached the webview as an error response on the command's channel.
			const response = sent().find((msg) => msg.command === command) as { errors?: Array<string | null>; error?: string | null } | undefined;
			expect(response, command).toBeDefined();
			const reported = response!.errors !== undefined ? response!.errors : [response!.error ?? null];
			expect(reported.length, command).toBeGreaterThan(0);
			expect(reported.every((error) => error !== null), command).toBe(true);
		}
	});

	it('fails the op without mutating anything when git exists but the path is not a repository', async () => {
		const process = new GitProcess(() => ({ path: 'git', version: '2.30.0' }), (command, args, options) => cp.spawn(command, args, options) as never);
		for (const command of Object.keys(WRITE_FIXTURES)) {
			const { ctx, sent } = realWriterContext(process);
			const message = { command: command, repo: unknownRepo, ...WRITE_FIXTURES[command] };
			await expect(dispatchRequest(message, ctx), command).resolves.toBe('handled');
			const response = sent().find((msg) => msg.command === command) as { errors?: Array<string | null>; error?: string | null } | undefined;
			expect(response, command).toBeDefined();
			const reported = response!.errors !== undefined ? response!.errors : [response!.error ?? null];
			// Every write reported a failure - the unknown path was never silently "succeeding".
			expect(reported.every((error) => error !== null && error.length > 0), command + ': ' + JSON.stringify(reported)).toBe(true);
		}
		expect(cp.spawnSync('git', ['-C', unknownRepo, 'rev-parse', '--git-dir']).status).not.toBe(0);
	});
});

/** JSON.stringify replacer that keeps the fuzz message printable (Symbols, cycles, BigInts). */
function jsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'symbol') return value.toString();
	if (typeof value === 'bigint') return String(value);
	return value;
}

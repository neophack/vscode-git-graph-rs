import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

/**
 * The fixture's process and filesystem plumbing: how git is run (one identity/config for every
 * call, lock-contention retry against the editor's concurrent git probes), how a fast-import
 * stream is fed to the child, and how directory trees are removed across Windows file locks and
 * the Node versions this extension builds against. Everything the generation and seeding paths
 * (fixture.ts) build on — no repository knowledge of its own.
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120000;
/* One identity/config for every git call: deterministic content, no global-config dependence. */
const GIT_BASE_ARGS = [
	'-c', 'core.autocrlf=false',
	'-c', 'init.defaultBranch=main',
	'-c', 'user.name=Fixture',
	'-c', 'user.email=fixture@fixture.dev'
];

/**
 * Clear the read-only attribute git puts on its object and pack files before a removal: on Windows
 * that attribute makes unlink/rmdir fail with EPERM (Node's rm does not clear it), so a plain
 * recursive delete of any freshly imported repository can abort the run. Files only — git never
 * marks directories read-only, and chmod'ing a directory to 0o666 would strip its x bit on POSIX.
 */
function clearReadOnlyFiles(target: string): void {
	if (process.platform !== 'win32') return;
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(target);
	} catch (_) {
		return; // nothing there to clear
	}
	if (stat.isDirectory()) {
		let names: string[] = [];
		try {
			names = fs.readdirSync(target);
		} catch (_) {
			return; // the removal below will surface any real problem
		}
		for (const name of names) clearReadOnlyFiles(path.join(target, name));
	} else {
		try {
			fs.chmodSync(target, 0o666);
		} catch (_) {
			// not fatal — deletion reports the real obstacle
		}
	}
}

/** Remove a directory tree across the Node versions this extension builds against (same feature-detect as fixtureLifecycle's). */
function rmRecursive(target: string): void {
	clearReadOnlyFiles(target);
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

/** Pause between removal attempts, sized to outlast a short-lived scanner or git child's handle. */
const RM_ATTEMPT_INTERVAL_MS = 200;
/** Total budget for one directory-tree removal across every attempt (mirrors fixtureLifecycle's). */
export const RM_TREE_DEADLINE_MS = 120000;

/**
 * Remove a directory tree, waiting out transient Windows file locks within a bounded budget — the
 * same loop as fixtureLifecycle's rmTreeAwaitingLocks, whose comment records why awaited
 * fs.promises.rm is avoided instead: on Node 20 its Windows retry path can stall far beyond the
 * nominal budget and, when it races a held file, never settle at all. Freshly imported trees hit
 * exactly these locks (an antivirus scanning the just-written pack files holds them for a
 * moment), and a single unmuted attempt turned into "Unable to run the automation test suite:
 * EPERM" on the `%TEMP%\gg-automation-sub-*` scratch. Each attempt is a complete synchronous
 * removal; past the deadline the last error propagates, so a stubborn lock fails loudly instead
 * of hanging the run.
 */
export async function rmTree(target: string, budgetMs: number): Promise<void> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		try {
			rmRecursive(target);
			return;
		} catch (error) {
			if ((error as { code?: string }).code === 'ENOENT') return; // the legacy rmdirSync path has no force
			if (Date.now() >= deadline) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, RM_ATTEMPT_INTERVAL_MS));
	}
}

/**
 * Best-effort removal for throwaway scratch trees (the temp-dir submodule scratch, a failed
 * generate's work dir): a leftover must never fail — or, on a failure path, mask the original
 * error of — the run that created it. mkdtemp scratch names are unique, so a survivor cannot
 * disturb the next run; the OS owns temp-dir hygiene.
 */
export async function rmScratch(target: string): Promise<void> {
	try {
		await rmTree(target, 15000);
	} catch (_) {
		// left behind — harmless
	}
}

/** Remove a file if it exists (single files have a floor-safe API everywhere). */
export function rmFile(target: string): void {
	try {
		fs.unlinkSync(target);
	} catch (_) {
		// already gone
	}
}

/** mkdir -p (the recursive option postdates the typings' floor; the runtime has had it for years). */
export function mkdirAll(target: string): void {
	const f = fs as unknown as { mkdirSync: (p: string, o?: { recursive?: boolean }) => void };
	f.mkdirSync(target, { recursive: true });
}

/**
 * Transient lock contention, as git words it: the editor's background git probes (the view's
 * status refresh, VS Code's own git extension) hold `.git/index.lock` for milliseconds while a
 * fixture git child runs, and git does not wait — it fails. fast-import's collisions read
 * differently (pack and ref locks), so the signature covers git's whole lock-failure family.
 */
const GIT_LOCK_SIGNATURE = /index\.lock|could not write index|Another git process|cannot lock ref|Unable to create '[^']+\.lock'/i;
/** Retry schedule: ~6.8 s total, many multiples of a background probe's hold time. */
const GIT_LOCK_BACKOFF_MS = [200, 400, 600, 800, 1200, 1600, 2000];
/** A lock older than this outlived any live writer on a fixture repository — it is a leftover. */
const STALE_INDEX_LOCK_AGE_MS = 60000;

/** One git invocation exactly as spawned: the fixture's base args plus the caller's. */
function gitRaw(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string }> {
	return execFileAsync('git', [...GIT_BASE_ARGS, ...args], {
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		...options
	});
}

/** The error's full text: git's fatal lines land in stderr, and exec repeats them in message. */
function gitErrorText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const stderr = (error as { stderr?: unknown }).stderr;
	return error.message + (typeof stderr === 'string' ? '\n' + stderr : '');
}

/**
 * The `index.lock` path git refused to create, when the file is old enough that no live writer
 * holds it. A fixture git call that hits its timeout is killed mid-index-write and leaves the
 * lock behind — every later call in the run then fails on it, which is why git's own error tells
 * a human to remove the file by hand. A background probe's write holds the lock for
 * milliseconds, so a lock a minute old is a dead writer's, not a live one's.
 */
function staleIndexLockPath(error: unknown): string | null {
	const match = gitErrorText(error).match(/Unable to create '([^']+\.lock)'/i);
	if (match === null || !match[1].endsWith('index.lock')) return null;
	try {
		if (Date.now() - fs.statSync(match[1]).mtimeMs < STALE_INDEX_LOCK_AGE_MS) return null;
	} catch (_) {
		return null; // already gone — the retry loop's next attempt re-reads the real state
	}
	return match[1];
}

/**
 * Run one git step, retrying lock-contention failures with backoff; past the retries, a lock
 * that outlived the whole schedule is either a still-running writer (yield the real error) or a
 * timed-out child's leftover (remove it and take exactly one more swing). Every other failure
 * fails straight through — the retry must never paper over a real fixture bug.
 */
async function withLockRetry<T>(step: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await step();
		} catch (error) {
			if (!GIT_LOCK_SIGNATURE.test(gitErrorText(error))) throw error;
			if (attempt >= GIT_LOCK_BACKOFF_MS.length) {
				const stale = staleIndexLockPath(error);
				if (stale === null) throw error;
				rmFile(stale);
				return await step();
			}
			await new Promise((resolve) => setTimeout(resolve, GIT_LOCK_BACKOFF_MS[attempt]));
		}
	}
}

/**
 * One git call with the fixture's base config, resilient to the editor's concurrent git probes.
 * Exported for the whole automation layer: the reseed's and pre/post-action git calls
 * run inside the live editor session too, and each of them used to be a separate unprotected
 * exec that one background index write could abort the run with.
 */
export async function git(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string }> {
	return withLockRetry(() => gitRaw(args, options));
}

/** Feed the whole stream to `git fast-import --quiet` in the given working directory. */
export async function fastImport(cwd: string, stream: Buffer): Promise<void> {
	return withLockRetry(() => fastImportOnce(cwd, stream));
}

/** One fast-import attempt: the stream is deterministic, so a retried run is idempotent. */
function fastImportOnce(cwd: string, stream: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', [...GIT_BASE_ARGS, 'fast-import', '--quiet'], {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
		});
		let stderr = '';
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error('git fast-import exited with code ' + code + ': ' + stderr.trim()));
		});
		child.stdin.once('error', reject);
		child.stdin.write(stream, (err: Error | null | undefined) => {
			if (err !== null && err !== undefined) reject(err);
			else child.stdin.end();
		});
	});
}

/** How many commits exist across every ref of `repo` (-1 when git could not answer). */
export async function countRepoCommits(repo: string): Promise<number> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-list', '--count', '--all'], {
			timeout: GIT_TIMEOUT_MS, windowsHide: true
		});
		const parsed = parseInt(stdout.trim(), 10);
		return Number.isNaN(parsed) ? -1 : parsed;
	} catch (_) {
		return -1;
	}
}

import { execFile } from 'child_process';
import { promisify } from 'util';

/**
 * GitStateProbe: the scenario runner's `then.git` assertion
 * engine. It judges a repository's REAL state — refs, HEAD, commits, worktree, stashes, config,
 * remotes — through the git CLI, so a passing scenario proves the write operation changed the
 * repository, not merely "a response arrived".
 *
 * Test-support code: the git CLI is allowed here by design. Unlike fixture.ts's `git` helper it
 * deliberately carries NO per-call `-c` identity overrides — a `configValue` assertion on
 * `user.name` must observe the repository's own configuration, not a command-line override
 * masking it.
 *
 * The probe takes LITERAL values: `{{placeholder}}` expansion against the live run context is
 * the scenario runner's job (scenario.ts), so the probe itself stays a pure judge that the L3
 * tests exercise against real repositories.
 */

/** Every assertion kind, one per state dimension a write operation can change. */
export type GitAssertion =
	| { readonly kind: 'refPresent'; readonly ref: string }
	| { readonly kind: 'refAbsent'; readonly ref: string }
	| { readonly kind: 'upstreamIs'; readonly branch: string; readonly upstream: string | null }
	| { readonly kind: 'headIs'; readonly name: string }
	| { readonly kind: 'commitCount'; readonly range: string; readonly count: number }
	| { readonly kind: 'commitMessages'; readonly range: string; readonly messages: readonly string[] }
	| { readonly kind: 'worktreeStatus'; readonly clean?: boolean; readonly contains?: readonly string[] }
	| { readonly kind: 'stashCount'; readonly count: number; readonly messageContains?: string }
	| { readonly kind: 'configValue'; readonly key: string; readonly value: string | null }
	| { readonly kind: 'remotePresent'; readonly name: string; readonly url?: string }
	| { readonly kind: 'remoteAbsent'; readonly name: string };

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60000;

/** One git read: exit code and stdout (a read the assertion turns into a judgment). */
interface GitRead {
	readonly ok: boolean;
	readonly stdout: string;
}

/** Run one git read in the probe's repository. Never throws — a failed read is a judgment input. */
async function gitRead(repo: string, args: readonly string[]): Promise<GitRead> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
		});
		return { ok: true, stdout };
	} catch (error) {
		return { ok: false, stdout: typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '' };
	}
}

/** The lines of a git output, trimmed and non-empty. */
function lines(out: string): string[] {
	return out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * The judge of one repository's state. Construct one per scenario run; every read is live, so
 * assertions observe the repository as the write operation left it.
 */
export class GitStateProbe {
	private readonly repo: string;

	public constructor(repo: string) {
		this.repo = repo;
	}

	/**
	 * Assert one aspect of the repository's state. Resolves NULL when the assertion holds, or a
	 * human-readable failure naming both expectation and reality.
	 */
	public async assert(assertion: GitAssertion): Promise<string | null> {
		switch (assertion.kind) {
			case 'refPresent': {
				const read = await gitRead(this.repo, ['rev-parse', '--verify', '--quiet', assertion.ref]);
				return read.ok && read.stdout.trim() !== ''
					? null
					: 'expected ref "' + assertion.ref + '" to exist in ' + this.repo;
			}
			case 'refAbsent': {
				const read = await gitRead(this.repo, ['rev-parse', '--verify', '--quiet', assertion.ref]);
				return !read.ok || read.stdout.trim() === ''
					? null
					: 'expected ref "' + assertion.ref + '" to be gone from ' + this.repo;
			}
			case 'upstreamIs': {
				const read = await gitRead(this.repo, ['rev-parse', '--abbrev-ref', assertion.branch + '@{upstream}']);
				const actual = read.ok ? read.stdout.trim() : null;
				return actual === assertion.upstream
					? null
					: 'expected branch "' + assertion.branch + '" to track "' + assertion.upstream + '", got "' + actual + '"';
			}
			case 'headIs': {
				const symbolic = await gitRead(this.repo, ['symbolic-ref', '-q', '--short', 'HEAD']);
				if (symbolic.ok && symbolic.stdout.trim() !== '') {
					return symbolic.stdout.trim() === assertion.name
						? null
						: 'expected HEAD to be "' + assertion.name + '", got branch "' + symbolic.stdout.trim() + '"';
				}
				// Detached: the assertion may name the commit hash (a prefix is enough).
				const hash = await gitRead(this.repo, ['rev-parse', 'HEAD']);
				const actual = hash.stdout.trim();
				return actual.indexOf(assertion.name) === 0 || assertion.name.indexOf(actual) === 0
					? null
					: 'expected HEAD to be "' + assertion.name + '", got detached HEAD at "' + actual + '"';
			}
			case 'commitCount': {
				const read = await gitRead(this.repo, ['rev-list', '--count', assertion.range]);
				const actual = read.ok ? parseInt(read.stdout.trim(), 10) : NaN;
				return actual === assertion.count
					? null
					: 'expected ' + assertion.count + ' commits in "' + assertion.range + '", got ' + (Number.isNaN(actual) ? 'an unreadable range' : actual);
			}
			case 'commitMessages': {
				const read = await gitRead(this.repo, ['log', '--format=%s', assertion.range]);
				const actual = read.ok ? lines(read.stdout) : [];
				const same = actual.length === assertion.messages.length && actual.every((subject, i) => subject === assertion.messages[i]);
				return same
					? null
					: 'expected the subjects of "' + assertion.range + '" to be ' + JSON.stringify(assertion.messages) + ', got ' + JSON.stringify(actual);
			}
			case 'worktreeStatus': {
				const read = await gitRead(this.repo, ['status', '--porcelain']);
				const entries = read.ok ? lines(read.stdout) : [];
				if (assertion.clean === true && entries.length > 0) {
					return 'expected a clean worktree, got ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + ': ' + entries.join(' | ');
				}
				if (assertion.clean === false && entries.length === 0) {
					return 'expected a dirty worktree, got none';
				}
				for (const needle of assertion.contains ?? []) {
					if (!entries.some((entry) => entry.indexOf(needle) !== -1)) {
						return 'expected the worktree status to contain "' + needle + '", got ' + JSON.stringify(entries);
					}
				}
				return null;
			}
			case 'stashCount': {
				const read = await gitRead(this.repo, ['stash', 'list']);
				const actual = read.ok ? lines(read.stdout) : [];
				if (actual.length !== assertion.count) {
					return 'expected ' + assertion.count + ' stashes, got ' + actual.length + ': ' + actual.join(' | ');
				}
				if (assertion.messageContains !== undefined) {
					const needle = assertion.messageContains;
					if (!actual.some((entry) => entry.indexOf(needle) !== -1)) {
						return 'expected a stash message containing "' + needle + '", got ' + JSON.stringify(actual);
					}
				}
				return null;
			}
			case 'configValue': {
				// --get-all, so a multi-valued key (a remote's several fetch refspecs) passes when
				// the expected value is ANY one of them; NULL stays "the key does not exist".
				const read = await gitRead(this.repo, ['config', '--get-all', assertion.key]);
				const actual = read.ok ? lines(read.stdout) : null;
				const holds = assertion.value === null
					? actual === null || actual.length === 0
					: actual !== null && actual.includes(assertion.value);
				return holds
					? null
					: 'expected config "' + assertion.key + '" to be ' + (assertion.value === null ? 'unset' : 'one of ' + JSON.stringify([assertion.value])) + ', got ' + (actual === null ? 'unset' : JSON.stringify(actual));
			}
			case 'remotePresent': {
				const list = await gitRead(this.repo, ['remote']);
				const names = list.ok ? lines(list.stdout) : [];
				if (!names.includes(assertion.name)) {
					return 'expected remote "' + assertion.name + '" to exist, got ' + JSON.stringify(names);
				}
				if (assertion.url !== undefined) {
					const url = await gitRead(this.repo, ['remote', 'get-url', assertion.name]);
					const actualUrl = url.ok ? url.stdout.trim() : '';
					if (actualUrl !== assertion.url) {
						return 'expected remote "' + assertion.name + '" to point at "' + assertion.url + '", got "' + actualUrl + '"';
					}
				}
				return null;
			}
			case 'remoteAbsent': {
				const list = await gitRead(this.repo, ['remote']);
				const names = list.ok ? lines(list.stdout) : [];
				return names.includes(assertion.name)
					? 'expected remote "' + assertion.name + '" to be gone, got ' + JSON.stringify(names)
					: null;
			}
		}
	}

	/**
	 * Assert every assertion in order; resolves NULL when all hold, or the FIRST failure
	 * (prefixed with the failing assertion's index — the scenario reports one clear cause).
	 */
	public async assertAll(assertions: readonly GitAssertion[]): Promise<string | null> {
		for (const [index, assertion] of assertions.entries()) {
			const failure = await this.assert(assertion);
			if (failure !== null) return 'git[' + index + '] ' + failure;
		}
		return null;
	}
}

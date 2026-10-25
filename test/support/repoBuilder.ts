import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Deterministic fixture repositories for the integration suites (REFACTOR-PLAN §6.2 rule 3).
 *
 * Every repository is built by chaining single git commands with fixed identities and fixed
 * GIT_AUTHOR_DATE/GIT_COMMITTER_DATE instants on a seeded clock: the same builder calls always
 * produce the same history (hashes included), independent of machine configuration and of how
 * fast the machine is. Git itself is the only tool run; nothing here touches the network.
 *
 * This is the TypeScript counterpart of `native/core/tests/common/mod.rs`; the shapes it can
 * build cover what the Reader contract suite needs — a branch and a merge, lightweight and
 * annotated tags, a remote wired by writing its tracking refs directly (no network), stashes,
 * an uncommitted working tree, a detached HEAD, a linked worktree and an optional submodule.
 */

/** One git invocation's extra options. An absent date means "git's default" (non-commit calls). */
export interface GitRunOptions {
	readonly authorDate?: string;
	readonly committerDate?: string;
	readonly input?: string | Buffer;
}

/** An alternate commit identity, passed per commit the way `git -c user.name=…` would. */
export interface CommitIdentity {
	readonly name: string;
	readonly email: string;
}

/** One {@link RepoBuilder.commit} call's options. */
export interface CommitOptions {
	readonly allowEmpty?: boolean;
	readonly author?: CommitIdentity;
	readonly authorDate?: string;
	readonly committerDate?: string;
}

/** The clock's first instant (2020-09-13T12:26:40Z) and the step between commits. */
const FIRST_TICK = 1_600_000_000;
const TICK_STEP = 60;

/** The fixed text file the standard fixture's first commit carries. */
export function textLines(count: number, prefix: string): string {
	return Array.from({ length: count }, (_, n) => `${prefix} ${n}\n`).join('');
}

/**
 * A fixture repository under construction. All git calls run in the repository with the machine's
 * configuration isolated away (GIT_CONFIG_NOSYSTEM, HOME pointed into the repository), so the
 * built history depends on nothing outside this file.
 */
export class RepoBuilder {
	private readonly repoPath: string;
	private tick: number;

	private constructor(repoPath: string, seed: number) {
		this.repoPath = repoPath;
		this.tick = seed;
	}

	/** Create an empty repository with a deterministic identity and no gc surprises. */
	public static create(prefix: string, seed: number = FIRST_TICK): RepoBuilder {
		const repo = RepoBuilder.createRaw(prefix, ['init', '--quiet', '--initial-branch=main'], seed);
		return repo;
	}

	/**
	 * Create an empty repository whose refs live in a non-default ref backend
	 * (`git init --ref-format=`, git 2.45+; probe with {@link supportsRefFormat} first).
	 */
	public static createWithRefFormat(prefix: string, refFormat: string, seed: number = FIRST_TICK): RepoBuilder {
		return RepoBuilder.createRaw(prefix, ['init', '--quiet', '--initial-branch=main', '--ref-format', refFormat], seed);
	}

	/** Whether this git understands `--ref-format=` (probed in a throwaway directory). */
	public static supportsRefFormat(): boolean {
		const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-probe-refformat-'));
		try {
			execFileSync('git', ['init', '--quiet', '--ref-format=reftable', '.'], { cwd: probe, stdio: 'ignore' });
			return true;
		} catch {
			return false;
		} finally {
			clearReadOnly(probe);
			fs.rmSync(probe, { recursive: true, force: true });
		}
	}

	private static createRaw(prefix: string, initArgs: ReadonlyArray<string>, seed: number): RepoBuilder {
		const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
		const repo = new RepoBuilder(repoPath, seed);
		repo.git(initArgs);
		repo.config('user.name', 'Test User');
		repo.config('user.email', 'test@example.com');
		repo.config('commit.gpgsign', 'false');
		repo.config('core.autocrlf', 'false');
		repo.config('gc.auto', '0');
		return repo;
	}

	/** The repository's working-tree root. */
	public get path(): string {
		return this.repoPath;
	}

	/** Run one git command in the repository, failing the build when it fails. */
	public git(args: ReadonlyArray<string>, options: GitRunOptions = {}): string {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_TERMINAL_PROMPT: '0',
			HOME: this.repoPath
		};
		if (options.authorDate !== undefined) env.GIT_AUTHOR_DATE = options.authorDate;
		if (options.committerDate !== undefined) env.GIT_COMMITTER_DATE = options.committerDate;
		return execFileSync('git', [...args], {
			cwd: this.repoPath,
			encoding: 'utf8',
			input: options.input,
			env
		});
	}

	/** The next instant of the seeded clock, as a git date (`<seconds> +0000`). */
	public nextDate(): string {
		this.tick += TICK_STEP;
		return `${this.tick} +0000`;
	}

	/** Write a file into the working tree, creating parent directories. */
	public write(file: string, contents: string): void {
		const full = path.join(this.repoPath, file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}

	/** Delete a file from the working tree, tolerating its absence. */
	public remove(file: string): void {
		fs.rmSync(path.join(this.repoPath, file), { force: true });
	}

	/** Append raw text to `.git/config` — for shapes `git config` itself refuses to write. */
	public appendGitConfig(text: string): void {
		fs.appendFileSync(path.join(this.repoPath, '.git', 'config'), text);
	}

	/** Set one local configuration value. */
	public config(key: string, value: string): void {
		this.git(['config', key, value]);
	}

	/** Stage everything and commit; returns the new HEAD's hash. */
	public commit(message: string, options: CommitOptions = {}): string {
		this.git(['add', '-A']);
		const identityPrefix: string[] = options.author === undefined
			? []
			: ['-c', `user.name=${options.author.name}`, '-c', `user.email=${options.author.email}`];
		const args = [...identityPrefix, 'commit', '--quiet'];
		if (options.allowEmpty === true) args.push('--allow-empty');
		args.push('-m', message);
		const date = options.committerDate ?? this.nextDate();
		this.git(args, { authorDate: options.authorDate ?? date, committerDate: date });
		return this.revParse('HEAD');
	}

	/** The hash a ref points at. */
	public revParse(ref: string): string {
		return this.git(['rev-parse', ref]).trim();
	}

	/** Check a branch or raw hash out. */
	public checkout(ref: string): void {
		this.git(['checkout', '--quiet', ref]);
	}

	/** Detach HEAD (the odd state the branch dropdown must survive). */
	public detach(at: string = 'HEAD'): void {
		this.git(['checkout', '--quiet', '--detach', at]);
	}

	/** Create a branch, optionally at a commit other than HEAD. */
	public branch(name: string, at?: string): void {
		this.git(at === undefined ? ['branch', name] : ['branch', name, at]);
	}

	/** Create a lightweight tag (a ref that names the commit directly). */
	public tag(name: string, at?: string): void {
		this.git(at === undefined ? ['tag', name] : ['tag', name, at]);
	}

	/** Create an annotated tag with a tagger and a message. */
	public annotatedTag(name: string, message: string, at?: string): void {
		this.git(at === undefined ? ['tag', '-a', name, '-m', message] : ['tag', '-a', name, '-m', message, at]);
	}

	/** Merge a ref into the current branch with a merge commit (--no-ff, dated by the clock). */
	public merge(message: string, ref: string): void {
		const date = this.nextDate();
		this.git(['merge', '--quiet', '--no-ff', '-m', message, ref], { authorDate: date, committerDate: date });
	}

	/** Stash the working tree with a message (the stash's commits carry git's own dates). */
	public stashPush(message: string): void {
		this.git(['stash', 'push', '--quiet', '-m', message]);
	}

	/** Write a ref directly — how the fixture wires remote-tracking and Gerrit refs with no network. */
	public updateRef(ref: string, hash: string): void {
		this.git(['update-ref', ref, hash]);
	}

	/**
	 * Add a detached linked worktree at `name` for `ref`; returns the worktree's root. Detached
	 * on purpose: git refuses to check a branch out in a second worktree, and a fixture
	 * worktree only needs to be a readable tree.
	 */
	public addWorktree(name: string, ref: string): string {
		this.git(['worktree', 'add', '--quiet', '--detach', name, ref]);
		return path.join(this.repoPath, name);
	}

	/**
	 * Initialise a nested repository at `relativePath`, commit inside it and register it in
	 * `.gitmodules` as a gitlink (the way `git submodule add` leaves a submodule without a network).
	 */
	public initSubmodule(relativePath: string, url: string): void {
		this.git(['init', '--quiet', relativePath]);
		this.git(['-C', relativePath, 'config', 'user.name', 'Test User']);
		this.git(['-C', relativePath, 'config', 'user.email', 'test@example.com']);
		this.git(['-C', relativePath, 'commit', '--quiet', '--allow-empty', '-m', 'inside the submodule']);
		const name = path.basename(relativePath);
		this.write('.gitmodules', `[submodule "${name}"]\n\tpath = ${relativePath}\n\turl = ${url}\n`);
		this.git(['add', '.gitmodules', relativePath]);
	}

	/**
	 * Delete the repository. Git marks its object files read-only, which makes unlink fail with
	 * EPERM on Windows, so the read-only attribute is cleared on the way down (the same sweep
	 * `src/automation/fixture.ts` performs).
	 */
	public dispose(): void {
		clearReadOnly(this.repoPath);
		fs.rmSync(this.repoPath, { recursive: true, force: true });
	}
}

function clearReadOnly(target: string): void {
	if (process.platform !== 'win32') return;
	let stats: fs.Stats;
	try {
		stats = fs.lstatSync(target);
	} catch {
		return; // nothing there to clear
	}
	if (stats.isDirectory()) {
		for (const name of fs.readdirSync(target)) clearReadOnly(path.join(target, name));
	} else {
		try {
			fs.chmodSync(target, 0o666);
		} catch {
			// not fatal — the removal reports the real obstacle
		}
	}
}

/**
 * The standard contract fixture: the shapes every read method is answered against.
 *
 * A main line of five commits on `main` with a `feature` branch merged in, a rename, a binary
 * file, a second author, one lightweight and two annotated tags (one hierarchical), an `origin`
 * remote whose tracking and Gerrit change refs are written directly, upstream configuration,
 * hand-edited case-mixed config lines, TWO stashes (so ordering is observable without mutating
 * state mid-suite) and an uncommitted working tree. The fixture is immutable once returned —
 * suites that need an odd state (detached HEAD, a conflicted merge) build their own repository.
 */
export interface StandardFixture {
	readonly repo: RepoBuilder;
	/** The first commit (a.txt, 40 lines, tagged v1.0). */
	readonly first: string;
	/** The feature branch's commit (feature.txt). */
	readonly feature: string;
	/** The main-line commit after the branch point (main.txt). */
	readonly main: string;
	/** The merge of `feature` into `main`. */
	readonly merge: string;
	/** The rename commit a.txt → renamed.txt (carries tags v2.0 and release/v2.1). */
	readonly renamed: string;
	/** The commit that adds blob.bin. */
	readonly binary: string;
	/** The empty commit by the second author — HEAD when the fixture is returned. */
	readonly head: string;
}

export function buildStandardFixture(prefix: string): StandardFixture {
	const repo = RepoBuilder.create(prefix);

	repo.write('a.txt', textLines(40, 'line'));
	const first = repo.commit('the first commit');
	repo.tag('v1.0', first);

	repo.branch('feature', first);
	repo.checkout('feature');
	repo.write('feature.txt', 'feature work\n');
	const feature = repo.commit('the feature commit');

	repo.checkout('main');
	repo.write('main.txt', 'main work\n');
	const main = repo.commit('the main commit');
	repo.merge('merge the feature', 'feature');
	const merge = repo.revParse('HEAD');

	repo.git(['mv', 'a.txt', 'renamed.txt']);
	const renamed = repo.commit('rename a file');
	repo.annotatedTag('v2.0', 'an annotated tag', renamed);
	// A hierarchical tag name — legal git, and a shape ref validation has to survive.
	repo.tag('release/v2.1', renamed);

	repo.write('blob.bin', '\u0000\u0001\u0002not text\u0000\u0003');
	const binary = repo.commit('add a binary file');

	const head = repo.commit('a commit by the second author', {
		author: { name: 'Second Author', email: 'second@example.com' },
		allowEmpty: true
	});

	repo.config('remote.pushdefault', 'origin');
	repo.config('diff.tool', 'gitgraph-test-tool');
	repo.config('diff.guitool', 'gitgraph-test-gui');
	repo.git(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
	repo.updateRef('refs/remotes/origin/main', renamed);
	repo.updateRef('refs/remotes/origin/HEAD', renamed);
	repo.updateRef('refs/remotes/origin/changes/45/12345/1', first);
	repo.updateRef('refs/remotes/origin/changes/45/12345/meta', first);
	// An annotated tag as a remote would carry it (written directly under refs/remotes): reading
	// it back has to dereference the tag object to the feature commit, not report the object.
	repo.annotatedTag('v-remote', 'a remote tag', feature);
	repo.updateRef('refs/remotes/origin/tags/v-remote', repo.revParse('refs/tags/v-remote'));
	repo.config('branch.main.remote', 'origin');
	repo.config('branch.main.merge', 'refs/heads/main');
	// Case-mixed section/key/subsection spellings, which `git config --list` normalises: section
	// and key lower-cased, the subsection's case kept. Both adapters must read them alike.
	repo.appendGitConfig('[advice]\n\tamWorkDir = false\n[SomeSection "CamelCase"]\n\tSomeKey = mixed case\n');

	repo.write('renamed.txt', 'the stashed work\n');
	repo.stashPush('the stashed work');
	repo.write('renamed.txt', 'a second stashed change\n');
	repo.stashPush('a second stashed change');

	// The uncommitted working tree: the modified renamed.txt keeps most of a.txt's original
	// lines, so the rename a.txt → renamed.txt stays detected against the working tree.
	repo.write('renamed.txt', textLines(39, 'line') + 'line 39 (uncommitted)\n');
	repo.write('untracked.txt', 'not added yet\n');

	return { repo, first, feature, main, merge, renamed, binary, head };
}

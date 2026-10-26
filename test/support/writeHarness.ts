import { GitProcess } from '../../src/extension/git/process/gitProcess';
import { GitRepository } from '../../src/extension/git/gitRepository';
import { GitWriter } from '../../src/extension/git/write/gitWriter';
import { createBackend } from '../../src/extension/git/read/backendIndex';
import { createGitRunner } from '../../src/extension/graphView/gitRunner';
import type { GitRunnerPort } from '../../src/extension/graphView/gitRunner';
import { SquashMessageFormat } from '../../src/types/webview';
import type { WriteFlowContext } from '../../src/extension/graphView/writeFlows';

/**
 * The write-path harness of the integration suites (REFACTOR-PLAN §6.1 L3): the production git
 * layer — one `GitProcess`, the `GitWriter` over it, the CLI read backend, the raw runner and the
 * `GitRepository` facade — composed exactly the way `src/extension.ts` composes it, so the write
 * suites drive the flows users get. The suites that migrated off the legacy `DataSource` tests
 * (`tests/checkoutProtection.test.mjs`, `tests/editCommitMessage.test.mjs`,
 * `tests/fixupSquash.test.mjs`, `tests/operationState.test.mjs`, `tests/worktree.test.mjs`,
 * `tests/commitAuthors.test.mjs`) run their scenarios through this context.
 */

/** A localizer rendering `<key>:<params>` so assertions can match keys and interpolated values. */
export function recordingLocalize(key: string, ...params: Array<string | number>): string {
	return params.length > 0 ? key + ':' + params.join(',') : key;
}

export interface WriteHarness {
	/** The write-flow context the flows run against (the production composition). */
	readonly ctx: WriteFlowContext;
	/** The raw runner, for the few suites that probe Git directly through it. */
	readonly runner: GitRunnerPort;
	/** Dispose the read backend's state (the harness holds nothing else open). */
	dispose(): void;
}

/**
 * Compose the write harness for a real Git executable. The reader is the CLI backend alone (the
 * engine changes nothing on the write path), and the writer never signs (signing is a policy the
 * ops receive per flow, unit-tested in `src/extension/git/write/ops/ops.test.ts`).
 */
export function writeHarness(): WriteHarness {
	const process = new GitProcess(() => ({ path: 'git', version: '2.45.0' }));
	const writer = new GitWriter(process, () => ({ signCommits: false, signTags: false }), recordingLocalize);
	const backend = createBackend({ prefer: 'git-cli', gitPath: 'git' });
	const runner = createGitRunner(process, null, recordingLocalize);
	// The facade's text runner, the same shape src/extension.ts composes: one Git read resolving
	// its stdout, rejecting with the legacy stderr+stdout message when it fails.
	const runText = (argv: ReadonlyArray<string>, repo: string) => process.run(argv, { cwd: repo }).then((result) => {
		if (result.code !== 0) {
			const lines = (result.stderr + result.stdout.toString('utf8')).split(/\r\n|\r|\n/);
			lines.pop();
			throw lines.join('\n');
		}
		return result.stdout.toString('utf8');
	});
	const repo = new GitRepository(backend, writer, runText);
	const ctx: WriteFlowContext = {
		repo: repo,
		git: runner,
		t: recordingLocalize,
		config: { squashPullMessageFormat: SquashMessageFormat.Default, squashMergeMessageFormat: SquashMessageFormat.Default },
		ui: {
			quoteForTerminal: () => null,
			openGitTerminal: () => Promise.resolve(null)
		},
		repoConfig: { invalidate: () => undefined }
	};
	return {
		ctx: ctx,
		runner: runner,
		dispose: () => backend.closeAllRepositories()
	};
}

/** TRUE when a flow's result is a data-loss warning (an object with a message) rather than an ErrorInfo. */
export function isWarning(value: unknown): value is { message: string } {
	return value !== null && typeof value === 'object' && typeof (value as { message: unknown }).message === 'string';
}

/** The message of a flow's data-loss warning; throws when the result is not one. */
export function warningMessage(value: unknown): string {
	if (!isWarning(value)) throw new Error('expected a data-loss warning, got ' + JSON.stringify(value));
	return value.message;
}

/**
 * The P2 harness wiring: everything the host-pipeline gate drives the REAL pipeline with —
 * the deterministic fixture repositories (the same generator the automation suite uses), the
 * backend pair the gate measures (the engine + CLI fallback, and the CLI fallback alone), the
 * `GitRepository` facade composed exactly like src/extension.ts composes it (minus the vscode
 * shell), and the `CommitLoader` over that facade with the production wiring of
 * panelContext.ts's createCommitLoader (its two vscode-dependent inputs — the live
 * configuration and the localizer — are replaced by fixed defaults and a pass-through, which
 * is what those settings are on a clean fixture).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadOut, git, TIERS } from './env.mjs';

/** Load the compiled modules the harness drives (build:ts output). */
export function loadPipeline() {
	return {
		createBackend: loadOut('extension/git/read/backendIndex.js').createBackend,
		describeBackend: loadOut('extension/git/read/backendIndex.js').describeBackend,
		GitProcess: loadOut('extension/git/process/gitProcess.js').GitProcess,
		GitWriter: loadOut('extension/git/write/gitWriter.js').GitWriter,
		GitRepository: loadOut('extension/git/gitRepository.js').GitRepository,
		CommitLoader: loadOut('extension/graphView/commitLoader.js').CommitLoader,
		UncommittedCountStabiliser: loadOut('extension/graphView/uncommittedStabiliser.js').UncommittedCountStabiliser,
		fixture: loadOut('automation/fixture.js')
	};
}

/**
 * Ensure the fixture pair exists: the generated history (fast-import, deterministic per seed)
 * plus a second clone of its bare remote, so the rapid-switch scenario has a real second
 * repository to switch to. Idempotent — `generate` skips an existing fixture, and the second
 * clone is only made when its directory is absent.
 */
export async function ensureFixturePair(modules, tier, outDir, force = false) {
	const tierOptions = TIERS[tier];
	const generated = await modules.fixture.generate({ outDir, ...tierOptions, force });
	const repoB = path.join(outDir, 'fixture-b');
	if (!existsSync(repoB)) git(outDir, 'clone', '-q', generated.remoteDir, repoB);
	return { repoA: generated.fixtureDir, repoB, remoteDir: generated.remoteDir, tierOptions };
}

/**
 * Compose the production-shaped repository facade over a chosen backend: the GitWriter over a
 * GitProcess on the PATH git (no askpass — the fixture remotes are local paths), and the
 * operation-state detection over the same process adapter, exactly as src/extension.ts's
 * composition root builds them (the vscode shell around them is the only thing absent).
 */
export function composeRepository(modules, backend) {
	const gitProcess = new modules.GitProcess(
		() => ({ path: 'git', version: '2.x' }),
		undefined,
		() => ({})
	);
	const writer = new modules.GitWriter(gitProcess, () => ({ signCommits: false, signTags: false }), (key) => key);
	const runText = (argv, cwd) => gitProcess.run(argv, { cwd }).then((result) => {
		if (result.code !== 0) {
			const lines = (result.stderr + result.stdout.toString('utf8')).split(/\r\n|\r|\n/);
			lines.pop();
			throw lines.join('\n');
		}
		return result.stdout.toString('utf8');
	});
	return new modules.GitRepository(backend, writer, runText);
}

/**
 * The fixed configuration the harness loads under (the defaults of every setting the loader
 * and the log options read — what a clean installation runs with; a clean fixture working tree
 * keeps the uncommitted stabiliser on its fast path, so every load settles deterministically).
 */
const HARNESS_CONFIG = {
	showUncommittedChanges: true,
	showUntrackedFiles: true,
	showRemoteHeads: true,
	showCommitsOnlyReferencedByTags: true,
	useMailmap: false,
	gerrit: { remote: 'origin', fetchLimit: 20 }
};

/**
 * Build the CommitLoader over the facade — the harness twin of panelContext.ts's
 * createCommitLoader. The Gerrit port is a disabled stub (the integration is off for the
 * fixture remotes; `gerritFetchRefs: false` keeps the pipeline from ever calling it), and the
 * uncommitted-row message is a fixed string, the one thing the localizer would provide.
 */
export function createLoader(modules, repoFacade) {
	return new modules.CommitLoader({
		reads: {
			getCommits: (repo, query, signal) => repoFacade.read.getCommits(repo, logOptionsOf(query), signal),
			getUncommittedChanges: (repo) => repoFacade.read.getUncommittedChangeCount(repo, HARNESS_CONFIG.showUntrackedFiles),
			getRepoInfo: (repo, options) => loadRepoInfoHalf(repoFacade, repo, options),
			getOperationState: (repo) => repoFacade.getOperationState(repo)
		},
		gerrit: {
			listRemoteChanges: async () => new Map(),
			fetchChanges: async () => null,
			listLocalChangeRefs: async () => [],
			pruneLocalChanges: async () => null,
			parseMetas: async () => new Map(),
			getChangeUrlBase: async () => null
		},
		getConfig: () => HARNESS_CONFIG,
		logger: { log: () => {}, logError: (message) => process.stderr.write('loader: ' + message + '\n') },
		formatUncommittedRow: (count) => 'Uncommitted Changes (' + count + ')',
		stabiliser: new modules.UncommittedCountStabiliser(5000, 1000),
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	});
}

/** The harness twin of panelContext.ts's loadRepoInfoHalf: the repo-info half + operation state. */
async function loadRepoInfoHalf(repoFacade, repo, options) {
	const [info, operationState] = await Promise.all([
		repoFacade.read.getRepoInfo(repo, options).then(
			(i) => ({ branches: i.branches, head: i.head, remotes: i.remotes, stashes: i.stashes, tags: i.tags, error: i.error }),
			(error) => ({
				branches: [], head: null, remotes: [], stashes: [], tags: [],
				error: error instanceof Error ? error.message : String(error)
			})
		),
		repoFacade.getOperationState(repo)
	]);
	let isRepo = true;
	if (info.error !== null) {
		isRepo = await repoFacade.read.repoRoot(repo).then(() => true, () => false);
		if (!isRepo) info.error = null;
	}
	return { ...info, isRepo, operationState };
}

/** The harness twin of panelContext.ts's logOptionsOf, over the fixed configuration above. */
function logOptionsOf(query) {
	return {
		branches: query.branches === null ? null : [...query.branches],
		authors: query.authors,
		maxCommits: query.maxCommits,
		showTags: query.showTags,
		showRemoteBranches: query.showRemoteBranches,
		showRemoteHeads: HARNESS_CONFIG.showRemoteHeads,
		includeCommitsMentionedByReflogs: query.includeCommitsMentionedByReflogs,
		onlyFollowFirstParent: query.onlyFollowFirstParent,
		commitOrdering: query.commitOrdering,
		remotes: query.remotes,
		hideRemotes: query.hideRemotes,
		gerritRefs: query.gerritRefs,
		gerritShowChangeRefs: false,
		filterPaths: query.filterPath !== null && query.filterPath !== undefined ? query.filterPath.split(',').filter((p) => p !== '') : undefined,
		deferUncommittedChanges: query.deferUncommittedChanges,
		deferRemoteRefs: query.deferRemoteRefs,
		showUncommittedChanges: HARNESS_CONFIG.showUncommittedChanges,
		showUntrackedFiles: HARNESS_CONFIG.showUntrackedFiles,
		showCommitsOnlyReferencedByTags: HARNESS_CONFIG.showCommitsOnlyReferencedByTags,
		useMailmap: HARNESS_CONFIG.useMailmap
	};
}

/**
 * A `RequestLoadView` / `RequestLoadCommits` with the shape the panel sends: every branch
 * shown, the default 300-commit first page, remote branches on, date ordering.
 */
export function viewRequest(repo, overrides = {}) {
	return {
		command: 'loadView',
		repo,
		refreshId: 1,
		hard: false,
		branches: null,
		authors: null,
		maxCommits: 300,
		showTags: true,
		showRemoteBranches: true,
		includeCommitsMentionedByReflogs: false,
		onlyFollowFirstParent: false,
		commitOrdering: 'date',
		remotes: [],
		hideRemotes: [],
		stashes: [],
		filterPath: null,
		...overrides
	};
}

/**
 * Run one loader request to quiescence: resolves when the INITIAL response arrived and the
 * staged follow-ups have delivered their final response (the one carrying `uncommittedCount`).
 * Every sample ends settled, so background work of one sample never bleeds into the next.
 *
 * @returns The captured responses (initial first, follow-ups after) and the milliseconds until
 *          the initial response — the number P2 gates on.
 */
export function runLoaderRequest(loader, message) {
	return new Promise((resolve, reject) => {
		const responses = [];
		let initialMs = null;
		const started = process.hrtime.bigint();
		const send = (response) => {
			responses.push(response);
			if (initialMs === null && (response.command === 'loadView' || response.command === 'loadCommits')) {
				initialMs = Number(process.hrtime.bigint() - started) / 1e6;
			}
			if (response.uncommittedCount !== undefined) {
				resolve({ responses, initialMs });
			}
		};
		// The message arrives as a viewRequest; the loader method matches its command.
		const request = { ...message, command: message.command === 'loadView' ? 'loadView' : 'loadCommits' };
		const settled = loader[request.command === 'loadView' ? 'loadView' : 'loadCommits'](request, send);
		settled.then(() => {
			// The initial response was sent; the follow-up chain resolves this promise. A load that
			// legitimately sends no uncommitted response (an error, HEAD outside the page) must not
			// hang the gate: settle shortly after the pipeline itself went quiet.
			setTimeout(() => resolve({ responses, initialMs }), 250).unref?.();
		}, reject);
		// Hard cap: a stuck pipeline is a defect, not a measurement.
		setTimeout(() => resolve({ responses, initialMs }), 30000).unref?.();
	});
}

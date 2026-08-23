/**
 * Measure the two backends against each other on a real repository.
 *
 *   node scripts/bench.mjs <repo-path> [--commits 300] [--runs 10] [--tags]
 *   node scripts/bench.mjs <repo-path> --all [--runs 5] [--json]
 *
 * The number that matters is a *view load*: the repository info and the first page of commits,
 * which is what the user waits for when they open the graph. `--all` goes further and times every
 * read operation the extension performs, one table row per operation, so a regression in any
 * corner of the read path is visible rather than hidden inside the headline number. `--json`
 * emits the same measurements machine-readably (for trend tracking or CI thresholds).
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// An absolute Windows path is not a valid ESM specifier, so it goes through a file:// URL.
const { CliBackend, NativeBackend } = await import(
	pathToFileURL(path.join(root, 'out', 'backend', 'index.js')).href
);

function parseArguments(argv) {
	const options = { repo: null, commits: 300, runs: 10, tags: false, all: false, json: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--commits') options.commits = Number(argv[++i]);
		else if (argv[i] === '--runs') options.runs = Number(argv[++i]);
		// Walk from the tags as well, which on a repository whose history is only reachable
		// through them is the difference between walking ten commits and walking all of them.
		else if (argv[i] === '--tags') options.tags = true;
		else if (argv[i] === '--all') options.all = true;
		else if (argv[i] === '--json') options.json = true;
		else options.repo = argv[i];
	}
	if (options.repo === null) {
		throw new Error('Usage: node scripts/bench.mjs <repo-path> [--commits N] [--runs N] [--tags] [--all] [--json]');
	}
	return options;
}

const options = parseArguments(process.argv.slice(2));

const logOptions = {
	maxCommits: options.commits,
	showTags: true,
	showRemoteBranches: true,
	showUncommittedChanges: true,
	showUntrackedFiles: true,
	showCommitsOnlyReferencedByTags: options.tags,
	commitOrdering: 'date'
};

const rust = new NativeBackend();
const cli = new CliBackend();
const repo = await rust.openRepository(options.repo);
await cli.openRepository(options.repo);

/** One view load: what the user waits for when the graph opens. */
async function viewLoad(backend) {
	const [, commits] = await Promise.all([
		backend.getRepoInfo(repo, { showRemoteBranches: true, showStashes: true }),
		backend.getCommits(repo, logOptions)
	]);
	return commits.commits.length;
}

/**
 * Every read operation the extension performs, as `{ label, run(backend) }`.
 *
 * Which repository objects each operation targets is resolved once, up front, so the two
 * backends are measured against exactly the same question.
 */
async function buildOperations() {
	const page = await rust.getCommits(repo, logOptions);
	const hashes = page.commits
		.filter((commit) => commit.hash !== '*')
		.slice(0, 50)
		.map((commit) => commit.hash);
	const head = page.head ?? hashes[0];
	const first = hashes[hashes.length - 1] ?? head;
	// The file the per-object reads target: one the commit tree actually holds, when the page
	// offers one, with a conventional name as the fallback.
	const file = 'README.md';
	const [info, refData] = await Promise.all([
		rust.getRepoInfo(repo, { showRemoteBranches: true }),
		rust.getRefs(repo, { showRemoteBranches: false })
	]);
	const remote = info.remotes[0] ?? 'origin';
	const annotated = refData.tags.find((tag) => tag.annotated);

	const operations = [
		{ label: 'view load (repoInfo + first page)', run: (b) => viewLoad(b) },
		{ label: 'getRepoInfo (branches/tags/remotes/stashes)', run: (b) => b.getRepoInfo(repo, { showRemoteBranches: true, showStashes: true }).then((r) => r.branches.length + r.tags.length) },
		{ label: 'getCommits (a page of the graph)', run: (b) => b.getCommits(repo, logOptions).then((r) => r.commits.length) },
		{ label: 'getRefs', run: (b) => b.getRefs(repo, { showRemoteBranches: true }).then((r) => r.heads.length + r.tags.length + r.remotes.length) },
		{ label: 'getCommitDetails', run: (b) => b.getCommitDetails(repo, head).then((r) => r.fileChanges.length) },
		{ label: 'getCommitBodies (50 commits)', run: (b) => b.getCommitBodies(repo, hashes).then((r) => Object.keys(r).length) },
		{ label: 'getCommitSummaries (50 commits)', run: (b) => b.getCommitSummaries(repo, hashes).then((r) => Object.keys(r).length) },
		{ label: 'getCommitSubject', run: (b) => b.getCommitSubject(repo, head).then((r) => r.length) },
		{ label: "searchHistory ('' matches everything)", run: (b) => b.searchHistory(repo, '').then((r) => r.length) },
		{ label: 'getConfig', run: (b) => b.getConfig(repo).then((r) => r.remotes.length) },
		{ label: 'getStashes', run: (b) => b.getStashes(repo).then((r) => r.length) },
		{ label: 'getUncommittedChangeCount', run: (b) => b.getUncommittedChangeCount(repo, true) },
		{ label: 'compareCommits', run: (b) => b.compareCommits(repo, first, head).then((r) => r.length) },
		{ label: 'countCommitsBefore', run: (b) => b.countCommitsBefore(repo, null, first, true, false) },
		{ label: 'getCommitFile', run: (b) => b.getCommitFile(repo, head, file).then((r) => (r.binary ? 'binary' : (r.contents ?? '').length), () => 'missing') },
		{ label: 'getCommitFileDiff', run: (b) => b.getCommitFileDiff(repo, head, file).then((r) => r.length, () => 'missing') },
		{ label: 'getCurrentBranchUpstream', run: (b) => b.getCurrentBranchUpstream(repo).then((r) => r ?? 'none') },
		{ label: 'getSubmodules', run: (b) => b.getSubmodules(repo).then((r) => r.length) },
		{ label: 'getRemoteUrl', run: (b) => b.getRemoteUrl(repo, remote).then((r) => r ?? 'none') }
	];
	if (annotated !== undefined) {
		operations.push({ label: 'getTagDetails (annotated tag)', run: (b) => b.getTagDetails(repo, annotated.name).then((r) => r.message.length) });
	}
	return operations;
}

/**
 * Time one operation on one backend: an untimed warm-up run first (the engine's caches and the OS
 * page cache both warm up, and timing the cold run would measure the disk), then timed samples.
 */
async function measure(run) {
	let result;
	try {
		result = await run();
	} catch (error) {
		return { error: String(error instanceof Error ? error.message : error) };
	}
	const samples = [];
	for (let i = 0; i < options.runs; i++) {
		const started = process.hrtime.bigint();
		result = await run();
		samples.push(Number(process.hrtime.bigint() - started) / 1e6);
	}
	samples.sort((a, b) => a - b);
	return {
		median: samples[Math.floor(samples.length / 2)],
		best: samples[0],
		worst: samples[samples.length - 1],
		// What the operation returned, so a "fast" backend that answers a different question
		// stands out in the table rather than silently winning it.
		result: typeof result === 'number' ? `${result}` : `${result}`.slice(0, 24)
	};
}

if (options.all) {
	const operations = await buildOperations();
	const rows = [];
	for (const operation of operations) {
		const row = { operation: operation.label };
		for (const backend of [cli, rust]) {
			row[backend.name] = await measure(() => operation.run(backend));
		}
		rows.push(row);
	}

	if (options.json) {
		console.log(JSON.stringify({ repository: repo, runs: options.runs, commits: options.commits, results: rows }, null, 2));
	} else {
		console.log(`Repository: ${repo}`);
		console.log(`${options.runs} runs per operation, median reported\n`);
		console.log(`${'operation'.padEnd(42)} ${'git-cli'.padStart(10)} ${'engine'.padStart(10)} ${'speedup'.padStart(8)}   returns`);
		for (const row of rows) {
			const a = row['git-cli'], b = row['rust'];
			if (a.error !== undefined || b.error !== undefined) {
				const reason = (a.error ?? b.error).slice(0, 60);
				console.log(`${row.operation.padEnd(42)} ${(a.error !== undefined ? 'failed' : a.median.toFixed(1) + ' ms').padStart(10)} ${(b.error !== undefined ? 'failed' : b.median.toFixed(1) + ' ms').padStart(10)} ${'—'.padStart(8)}   ${reason}`);
				continue;
			}
			console.log(
				`${row.operation.padEnd(42)} ${a.median.toFixed(1).padStart(9)} ms ${b.median.toFixed(1).padStart(9)} ms ${(a.median / b.median).toFixed(1).padStart(7)}x   ${b.result}`
			);
		}
	}
} else {
	// The headline comparison: one number per backend for what opening the graph costs.
	const results = [];
	for (const backend of [cli, rust]) {
		const commits = await viewLoad(backend).then((count) => count, () => 0);
		const samples = [];
		for (let i = 0; i < options.runs; i++) {
			const started = process.hrtime.bigint();
			await viewLoad(backend);
			samples.push(Number(process.hrtime.bigint() - started) / 1e6);
		}
		samples.sort((a, b) => a - b);
		results.push({
			name: backend.name,
			commits,
			median: samples[Math.floor(samples.length / 2)],
			best: samples[0],
			worst: samples[samples.length - 1]
		});
	}

	console.log(`Repository: ${repo}`);
	console.log(`Walking ${options.commits} commits, ${options.runs} runs each\n`);
	for (const result of results) {
		console.log(
			`${result.name.padEnd(8)}  median ${result.median.toFixed(1).padStart(7)} ms` +
				`   best ${result.best.toFixed(1).padStart(7)} ms` +
				`   worst ${result.worst.toFixed(1).padStart(7)} ms` +
				`   (${result.commits} commits)`
		);
	}

	const [before, after] = results;
	if (before.commits !== after.commits) {
		console.log(
			`\nWarning: the backends returned different numbers of commits ` +
				`(${before.commits} vs ${after.commits}) — the comparison is not like for like.`
		);
	}
	console.log(`\nSpeedup: ${(before.median / after.median).toFixed(1)}x`);
}

rust.closeAllRepositories();

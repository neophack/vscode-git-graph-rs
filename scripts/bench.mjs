/**
 * Measure the two backends against each other on a real repository.
 *
 *   node scripts/bench.mjs <repo-path> [--commits 300] [--runs 10]
 *
 * The number that matters is a *view load*: the repository info and the first page of commits,
 * which is what the user waits for when they open the graph.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// An absolute Windows path is not a valid ESM specifier, so it goes through a file:// URL.
const { CliBackend, NativeBackend } = await import(
	pathToFileURL(path.join(root, 'out', 'backend', 'index.js')).href
);

function parseArguments(argv) {
	const options = { repo: null, commits: 300, runs: 10, tags: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--commits') options.commits = Number(argv[++i]);
		else if (argv[i] === '--runs') options.runs = Number(argv[++i]);
		// Walk from the tags as well, which on a repository whose history is only reachable
		// through them is the difference between walking ten commits and walking all of them.
		else if (argv[i] === '--tags') options.tags = true;
		else options.repo = argv[i];
	}
	if (options.repo === null) {
		throw new Error('Usage: node scripts/bench.mjs <repo-path> [--commits N] [--runs N]');
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

/** One view load: what the user waits for when the graph opens. */
async function viewLoad(backend, repo) {
	const [, commits] = await Promise.all([
		backend.getRepoInfo(repo, { showRemoteBranches: true, showStashes: true }),
		backend.getCommits(repo, logOptions)
	]);
	return commits.commits.length;
}

async function measure(backend, repo) {
	// One untimed run first: the engine's caches and the OS page cache both warm up, and timing
	// the cold run would measure the disk rather than the backend.
	const commits = await viewLoad(backend, repo);

	const samples = [];
	for (let i = 0; i < options.runs; i++) {
		const started = process.hrtime.bigint();
		await viewLoad(backend, repo);
		samples.push(Number(process.hrtime.bigint() - started) / 1e6);
	}
	samples.sort((a, b) => a - b);
	return {
		commits,
		median: samples[Math.floor(samples.length / 2)],
		best: samples[0],
		worst: samples[samples.length - 1]
	};
}

const rust = new NativeBackend();
const cli = new CliBackend();
const repo = await rust.openRepository(options.repo);

console.log(`Repository: ${repo}`);
console.log(`Walking ${options.commits} commits, ${options.runs} runs each\n`);

const results = [];
for (const backend of [cli, rust]) {
	const result = await measure(backend, repo);
	results.push({ name: backend.name, ...result });
	console.log(
		`${backend.name.padEnd(8)}  median ${result.median.toFixed(1).padStart(7)} ms` +
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

rust.closeAllRepositories();

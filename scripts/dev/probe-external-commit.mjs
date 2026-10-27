/**
 * A one-off repro probe for the `external/commit-appears` E2E failure: replays the scenario's
 * exact shape against the real engine addon, outside VS Code. Run:
 *
 *   node scripts/dev/probe-external-commit.mjs <repo>
 *
 * Sequence: one warm-up `loadCommits` (populates the incremental store, like the view's first
 * open), an out-of-band `git commit --allow-empty` (the runner's PRE_ACTION_SETUP command),
 * then two more `loadCommits` on the SAME warm handle — printing whether the new commit is in
 * the response, and where. The E2E log's "Loaded N commits" line comes from these responses.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repo = process.argv[2];
if (!repo) {
	console.error('usage: node scripts/dev/probe-external-commit.mjs <repo>');
	process.exit(1);
}

const addon = require('../../native/win32-x64-msvc/git-graph.node');
const git = (args) => execFileAsync('git', ['-c', 'user.name=Automation', '-c', 'user.email=automation@example.com', '-C', repo, ...args], { encoding: 'utf8' });

const LOG_PARAMS = {
	branches: null, authors: null, maxCommits: 300,
	showTags: true, showRemoteBranches: true, showRemoteHeads: true,
	deferRemoteRefs: true, includeCommitsMentionedByReflogs: false, onlyFollowFirstParent: false,
	commitOrdering: 'date', remotes: [], hideRemotes: [], gerritRefs: null, gerritShowChangeRefs: false,
	filterPaths: [], skipUncommittedScan: true
};

async function load(label) {
	const raw = await addon.request(repo, JSON.stringify({ method: 'loadCommits', params: LOG_PARAMS }));
	const envelope = JSON.parse(raw);
	if (!envelope.ok) {
		console.log(label + ': ERROR ' + JSON.stringify(envelope.error).slice(0, 200));
		return null;
	}
	const data = envelope.ok;
	const subjects = data.commits.map((c) => c.hash.slice(0, 8) + ' ' + (c.subject || '').slice(0, 40));
	console.log(label + ': ' + data.commits.length + ' commits, head=' + (data.head || 'null').slice(0, 8));
	console.log('  first 3: ' + subjects.slice(0, 3).join(' | '));
	const probeIndex = data.commits.findIndex((c) => (c.subject || '').indexOf('External automation commit') !== -1 || (c.subject || '').indexOf('PROBE external') !== -1);
	console.log('  probe commit index: ' + probeIndex + (probeIndex >= 0 ? ' (hash ' + data.commits[probeIndex].hash.slice(0, 8) + ')' : ''));
	const inList = data.commits.some((c) => c.hash === data.head);
	console.log('  head in own list: ' + inList);
	return data;
}

await addon.open(repo);
await load('warm-up load');
await git(['commit', '--allow-empty', '-m', 'PROBE external commit']);
const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
console.log('committed out-of-band: ' + head.slice(0, 8));
await load('load after commit #1');
await load('load after commit #2');
process.exit(0);

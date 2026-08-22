/**
 * Reproduce the "stuck loading" report against a real repository, outside VS Code: run the same
 * backend calls the view's loadRepoInfo / loadCommits cycle makes, each with a timeout so a hang
 * is reported instead of freezing the script.
 *
 *   node scripts/repro-dk033a.mjs [repo-path]
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { NativeBackend } = require(path.join(root, 'out', 'backend', 'index.js'));

const repo = process.argv[2] || 'D:/DK033-A';
const backend = new NativeBackend();

function timed(label, promise, ms) {
	const start = Date.now();
	let timer;
	return Promise.race([
		promise.then(
			(v) => { clearTimeout(timer); console.log(`${label}: OK (${Date.now() - start} ms)`); return v; },
			(e) => { clearTimeout(timer); console.log(`${label}: ERROR (${Date.now() - start} ms): ${String(e && e.message).slice(0, 300)}`); }
		),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`HUNG (> ${ms} ms)`)), ms);
		})
	]).catch((e) => console.log(`${label}: ${e && e.message}`));
}

console.log(`repo: ${repo}`);
await timed('openRepository', backend.openRepository(repo), 15000);
await timed(
	'getRepoInfo',
	backend.getRepoInfo(repo, { showRemoteBranches: true, showRemoteHeads: true, hideRemotes: [], showChangeRefs: false, showStashes: true }),
	30000
);
await timed(
	'getCommits(page 1, 300)',
	backend.getCommits(repo, { branches: null, authors: null, maxCommits: 300, showTags: true, showRemoteBranches: true, showRemoteHeads: true }),
	30000
);
await timed('getStashes', backend.getStashes(repo), 15000);
await timed('getConfig', backend.getConfig(repo), 15000);
console.log('sequence finished');
process.exit(0);

import { ErrorInfo, GerritChangeEvent, GerritChangeState, GerritChangeStatus, GerritPatchsetsMode } from './types';
import { evalPromises } from './utils';

/**
 * A minimal structural interface for running Git commands (implemented by `DataSource`).
 */
export interface GitRunner {
	gitOutput: <T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) => Promise<T>;
	runGitCommand: (args: string[], repo: string) => Promise<ErrorInfo>;
	runGitCommandWithInput: (args: string[], repo: string, input: string) => Promise<ErrorInfo>;
}

export interface ParsedChangeRef {
	change: number;
	patchset?: number; // undefined => meta ref
	meta: boolean;
}

const CHANGE_REF_REGEX = /(?:^|\/)changes\/\d+\/(\d+)\/(meta|\d+)$/;
const LABEL_FOOTER_REGEX = /^Label: ([A-Za-z0-9-]+)\s*=\s*([+-]?\d+)\s*$/gm;

/** The maximum number of NoteDb meta histories parsed by concurrent Git commands. */
const META_PARSE_CONCURRENCY = 8;
/** The maximum number of parsed NoteDb states retained in the in-memory cache (LRU). */
const META_CACHE_LIMIT = 500;
/**
 * The refspec budget of one `git fetch` command line. Windows caps a process command line at
 * ~32k characters, which a few hundred change refspecs exceed (the `gerrit.fetchLimit` setting
 * allows up to 10000 changes = 20000 refspecs), so large fetches are split into batches that stay
 * well inside every platform's limit.
 */
const FETCH_REFSPEC_BUDGET = 8000;

/** The default timeout of remote Gerrit operations (ls-remote / fetch), in milliseconds (<= 0 => disabled). */
const DEFAULT_REMOTE_TIMEOUT_MS = 60000;
// "Change has been successfully merged by <name>" / "cherry-picked as <hash> by <name>" - the
// submitter's name follows "by" (optionally after a "as <hash>" re-submit hash), with or without
// a trailing "<email>"
const MERGED_BY_REGEX = /^Change has been successfully (?:merged|cherry-picked|pushed)(?:\s+as\s+[0-9a-f]{4,40})?\s+by\s+(.+?)(?:\s*<[^>]*>)?\s*$/;

/**
 * Parse a Gerrit change reference (either a remote change ref such as
 * `refs/changes/24/41466/1` or `refs/remotes/origin/changes/24/41466/1`,
 * or a NoteDb meta ref such as `refs/changes/24/41466/meta`).
 * @param ref The reference to parse.
 * @returns The parsed change ref, or NULL if the reference isn't a change ref.
 */
export function parseChangeRef(ref: string): ParsedChangeRef | null {
	const match = CHANGE_REF_REGEX.exec(ref);
	if (match === null) return null;
	const change = parseInt(match[1], 10);
	if (!isFinite(change) || change <= 0) return null;
	return match[2] === 'meta'
		? { change: change, meta: true }
		: { change: change, patchset: parseInt(match[2], 10), meta: false };
}

/**
 * Get the two digit shard of a change number (e.g. 41466 -> "66", 5 -> "05").
 */
export function changeShard(change: number) {
	return ('0' + (change % 100)).slice(-2);
}

/**
 * Parse the output of `git ls-remote <remote> 'refs/changes/*'` into a map of change number -> patchset numbers.
 * @param output The ls-remote output.
 * @returns The map of changes to their patchsets.
 */
export function parseLsRemoteChanges(output: string) {
	const changes = new Map<number, number[]>();
	for (const line of output.split(/\r?\n/)) {
		const parts = line.split(/[ \t]/);
		if (parts.length < 2) continue;
		const parsed = parseChangeRef(parts[1]);
		if (parsed === null || parsed.meta || parsed.patchset === undefined) continue;
		const patchsets = changes.get(parsed.change);
		if (patchsets === undefined) {
			changes.set(parsed.change, [parsed.patchset]);
		} else if (!patchsets.includes(parsed.patchset)) {
			patchsets.push(parsed.patchset);
		}
	}
	for (const patchsets of changes.values()) patchsets.sort((a, b) => a - b);
	return changes;
}

/**
 * Select the changes to fetch, keeping only the latest `limit` changes (by change number).
 * @param changes The map of changes to their patchsets.
 * @param limit The maximum number of changes to keep (<= 0 => keep all).
 */
export function limitChanges(changes: Map<number, number[]>, limit: number) {
	if (limit <= 0 || changes.size <= limit) return changes;
	const numbers = Array.from(changes.keys()).sort((a, b) => b - a).slice(0, limit);
	const limited = new Map<number, number[]>();
	for (const change of numbers) limited.set(change, changes.get(change)!);
	return limited;
}

/**
 * Build the fetch refspecs for a set of changes (including their NoteDb meta refs).
 * @param changes The map of changes to their patchsets.
 * @param remote The remote to fetch from.
 * @param patchsetMode Should all patchsets be fetched, or only the latest per change.
 * @returns The array of refspecs.
 */
export function buildFetchRefspecs(changes: Map<number, number[]>, remote: string, patchsetMode: GerritPatchsetsMode) {
	const refspecs: string[] = [];
	for (const [change, patchsets] of changes) {
		const shard = changeShard(change);
		const keep = patchsetMode === 'all' ? patchsets : [patchsets[patchsets.length - 1]];
		for (const patchset of keep) {
			refspecs.push('+refs/changes/' + shard + '/' + change + '/' + patchset + ':refs/remotes/' + remote + '/changes/' + shard + '/' + change + '/' + patchset);
		}
		refspecs.push('+refs/changes/' + shard + '/' + change + '/meta:refs/remotes/' + remote + '/changes/' + shard + '/' + change + '/meta');
	}
	return refspecs;
}

/**
 * Compute the local ref prefixes (under `refs/remotes/<remote>/changes/`) that should be kept for a set of changes.
 */
export function buildKeepPatterns(changes: ReadonlyArray<number>, remote: string) {
	return changes.map((change) => 'refs/remotes/' + remote + '/changes/' + changeShard(change) + '/' + change + '/');
}

/**
 * Split fetch refspecs into batches whose command line stays well inside the platform limits.
 * @param refspecs The refspecs to batch.
 * @param budget The maximum total refspec length (plus separators) of one batch.
 * @returns The batches, in order; a single refspec longer than the budget still gets its own batch.
 */
export function chunkFetchRefspecs(refspecs: ReadonlyArray<string>, budget: number = FETCH_REFSPEC_BUDGET): string[][] {
	const max = Math.max(1, budget);
	const batches: string[][] = [];
	let current: string[] = [], length = 0;
	for (const refspec of refspecs) {
		if (current.length > 0 && length + refspec.length + 1 > max) {
			batches.push(current);
			current = [];
			length = 0;
		}
		current.push(refspec);
		length += refspec.length + 1;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/* NoteDb Meta Parsing */

export interface MetaCommitRecord {
	/** the Gerrit user that performed the action (e.g. "Gerrit User 1000018") */
	committer: string;
	/** the commit timestamp (unix seconds) */
	timestamp: number;
	/** the full commit message */
	message: string;
}

interface ParsedMetaCommit {
	event: GerritChangeEvent;
	patchset: number;
	status: GerritChangeStatus | null;
	wip: boolean | null;
	commitHash: string | null;
}

/**
 * Parse a single NoteDb meta commit message into an event + state fields.
 * @param record The meta commit record.
 * @returns The parsed commit, or NULL if the message isn't a recognised review event.
 */
export function parseMetaCommit(record: MetaCommitRecord): ParsedMetaCommit | null {
	const message = record.message;
	const header = (message.split(/\r?\n/, 1)[0] || '').trim();
	const lines = message.split(/\r?\n/);

	const result: ParsedMetaCommit = {
		event: { type: 'comment', patchset: 0, timestamp: record.timestamp, raw: header, rawFull: message },
		patchset: 0,
		status: null,
		wip: null,
		commitHash: null
	};
	const event = result.event;
	event.reviewer = record.committer;

	// Footer fields (NoteDb metas use "Key: value" lines, often in a trailer block)
	for (const line of lines) {
		let match = /^Patch-set:\s*(\d+)\s*$/.exec(line.trim());
		if (match !== null) result.patchset = parseInt(match[1], 10);
		match = /^Status:\s*(new|merged|abandoned)\s*$/.exec(line.trim());
		if (match !== null) result.status = <GerritChangeStatus>match[1];
		match = /^Commit:\s*([0-9a-f]{4,40})\s*$/.exec(line.trim());
		if (match !== null) result.commitHash = match[1];
		match = /^Work-in-progress:\s*(true|false)\s*$/.exec(line.trim());
		if (match !== null) result.wip = match[1] === 'true';
	}

	let headerPatchset: number | null = null;
	let hm = /^Uploaded patch set (\d+)\./.exec(header);
	if (hm !== null) headerPatchset = parseInt(hm[1], 10);
	hm = /^Patch Set (\d+):/.exec(header);
	if (hm !== null) headerPatchset = parseInt(hm[1], 10);
	if (headerPatchset !== null) result.patchset = headerPatchset;

	// Submit events: Gerrit writes "Change has been successfully merged by <name>" into the BODY of
	// the meta commit (its subject is usually just "Update patch set N"), so scan every line for it
	let mergedBy: string | null = null;
	for (const line of lines) {
		const match = MERGED_BY_REGEX.exec(line.trim());
		if (match !== null) {
			mergedBy = match[1].trim();
			break;
		}
	}

	// Labels (votes): "Label: Code-Review=+2" footers, and/or "Patch Set N: Code-Review+2" headers
	const labels: { name: string; value: number }[] = [];
	let m: RegExpExecArray | null;
	const labelFooter = new RegExp(LABEL_FOOTER_REGEX.source, 'gm');
	while ((m = labelFooter.exec(message)) !== null) {
		labels.push({ name: m[1], value: parseInt(m[2], 10) });
	}
	const headerVote = /^Patch Set \d+:.*?\b([A-Za-z][A-Za-z0-9-]*)\s*([+-]\d)\b/.exec(header);
	if (headerVote !== null) {
		if (!labels.some((label) => label.name === headerVote![1])) {
			labels.push({ name: headerVote[1], value: parseInt(headerVote[2], 10) });
		}
	}

	if (labels.length > 0) {
		event.type = 'vote';
		event.labels = labels;
	} else if (/^Create change/.test(header)) {
		event.type = 'created';
		event.patchset = result.patchset = 1;
	} else if (/Start Work In Progress|^Uploaded patch set \d+ \(WIP\)/.test(header)) {
		// The WIP shapes of an upload must be classified before the generic "Uploaded patch set"
		// one, which would otherwise swallow them (the WIP flag itself comes from the footer).
		event.type = 'wip';
		result.wip = true;
	} else if (/^Uploaded patch set \d+/.test(header)) {
		event.type = 'patchset';
	} else if (/^Change has been successfully (merged|cherry-picked|pushed)/.test(header) || result.status === 'merged') {
		event.type = 'merged';
		result.status = 'merged';
	} else if (/^Abandoned$/.test(header) || result.status === 'abandoned') {
		event.type = 'abandoned';
		result.status = 'abandoned';
	} else if (/Restore(d| Ready for Review)?$/.test(header) || /^Restored$/.test(header) || (result.status === 'new' && /^Unabor/.test(header))) {
		event.type = 'restored';
		result.status = 'new';
	} else if (result.wip === true) {
		// A WIP transition carried only by the footer of an otherwise generic record
		event.type = 'wip';
	} else if (/Restore Ready for Review|^Remove WIP|^Ready for review change/.test(header)) {
		event.type = 'ready';
		result.wip = false;
	} else if (/^Rebase/.test(header) || /^Patch Set \d+: Rebase/.test(header) || /^Uploaded patch set/.test(header)) {
		event.type = 'patchset';
	} else if (header === '' && lines.every((line) => /^[A-Za-z-]+:/.test(line.trim()))) {
		return null; // not a recognised review event
	}

	// Resolve the submitter of a merge: prefer the name from the "Change has been successfully ...
	// by <name>" line (usually in the body rather than the subject), then the "Submitted-by: Name <email>"
	// footer, and only then the (often anonymous) meta commit committer. Applies to vote commits that
	// Gerrit batched with the submit into a single meta commit as well, so they show the submitter.
	if (mergedBy !== null) {
		event.reviewer = mergedBy;
	} else if (event.type === 'merged') {
		const submittedBy = /^Submitted-by:\s*([^<]+?)(?:\s*<[^>]*>)?\s*$/m.exec(message);
		if (submittedBy !== null) event.reviewer = submittedBy[1].trim();
	}

	event.patchset = result.patchset;
	if (result.patchset === 0) return null;
	return result;
}

/**
 * Parse the full NoteDb meta history of a change into its state.
 * @param change The change number.
 * @param records The meta commit records, newest first (as outputted by `git log`).
 * @returns The change state, or NULL if no records exist.
 */
export function parseMetaHistory(change: number, records: MetaCommitRecord[]): GerritChangeState | null {
	if (records.length === 0) return null;

	const events: GerritChangeEvent[] = [];
	let status: GerritChangeStatus = 'new';
	let wip = false;
	let latestPatchset = 0;
	let statusDetermined = false, wipDetermined = false;
	const crVotes: GerritChangeEvent[] = [];
	const vVotes: GerritChangeEvent[] = [];
	// The first-seen (i.e. newest) `Commit:` hash of each patchset. The head hash cannot be picked
	// in passing: a record referencing an OLDER patchset (a late vote on it) can be newer than the
	// latest patchset's upload, and must not win over the latest patchset's own hash.
	const commitByPatchset = new Map<number, string>();

	for (const record of records) {
		const parsed = parseMetaCommit(record);
		if (parsed === null) continue;

		events.push(parsed.event);
		if (parsed.patchset > latestPatchset) latestPatchset = parsed.patchset;
		// Records are iterated newest first: the first (i.e. most recent) status/wip transition wins
		if (parsed.status !== null && !statusDetermined) {
			status = parsed.status;
			statusDetermined = true;
		}
		if (parsed.wip !== null && !wipDetermined) {
			wip = parsed.wip;
			wipDetermined = true;
		}
		if (parsed.commitHash !== null && !commitByPatchset.has(parsed.patchset)) {
			commitByPatchset.set(parsed.patchset, parsed.commitHash);
		}
		if (parsed.event.type === 'vote' && parsed.event.labels !== undefined) {
			for (const label of parsed.event.labels) {
				if (label.name === 'Code-Review') crVotes.push(parsed.event);
				else if (label.name === 'Verified') vVotes.push(parsed.event);
			}
		}
	}

	// The head hash of the change is the newest `Commit:` referencing the latest patchset.
	let headHash: string | null = commitByPatchset.get(latestPatchset) ?? null;
	if (headHash === null) {
		// Fall back to any commit hash found in the history
		for (const record of records) {
			const match = /^Commit:\s*([0-9a-f]{4,40})\s*$/m.exec(record.message);
			if (match !== null) { headHash = match[1]; break; }
		}
		if (headHash === null) return null;
	}

	return {
		change: change,
		patchset: latestPatchset,
		codeReview: strongestVote(crVotes, 'Code-Review'),
		verified: strongestVote(vVotes, 'Verified'),
		status: status,
		wip: wip,
		headHash: headHash,
		events: events,
		url: null
	};
}

/**
 * Get the strongest vote for a label: the value with the greatest absolute value (ties broken by recency).
 */
function strongestVote(events: GerritChangeEvent[], label: string) {
	let best = 0;
	for (const event of events) { // events are newest first
		const vote = event.labels!.find((l) => l.name === label);
		if (vote === undefined) continue;
		if (Math.abs(vote.value) > Math.abs(best)) best = vote.value;
	}
	return best;
}

/* Status Filtering */

/**
 * Filter change states by the status filter.
 * @param states The change states.
 * @param filter The status filter.
 * @returns The states that pass the filter.
 */
export function filterChangeStates(states: GerritChangeState[], filter: { new: boolean; merged: boolean; abandoned: boolean; wip: boolean }) {
	return states.filter((state) => {
		if (state.wip) return filter.wip;
		return filter[state.status];
	});
}


/**
 * Provides Gerrit integration data (change refs + NoteDb meta refs), all obtained via the Git protocol.
 */
export class GerritDataSource {
	private readonly git: GitRunner;
	private readonly remoteTimeoutMs: number;
	private readonly metaCache = new Map<string, GerritChangeState>(); // key = <repo>|<metaRef>|<hash>

	constructor(git: GitRunner, remoteTimeoutMs: number = DEFAULT_REMOTE_TIMEOUT_MS) {
		this.git = git;
		this.remoteTimeoutMs = remoteTimeoutMs;
	}

	/**
	 * Race a remote Git operation against a timeout, so that a stalled SSH/HTTP connection to the
	 * Gerrit remote cannot block the Git Graph View in a loading state indefinitely.
	 * Note: the underlying Git child process isn't killed, it is left to exit on its own.
	 * @param promise The promise of the remote operation.
	 * @param fallback The value to resolve with if the operation times out or fails.
	 * @returns The promise of the operation, or the fallback after the timeout.
	 */
	private withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
		if (this.remoteTimeoutMs <= 0) return promise;
		return new Promise<T>((resolve) => {
			const timer = setTimeout(() => resolve(fallback), this.remoteTimeoutMs);
			promise.then((value) => {
				clearTimeout(timer);
				resolve(value);
			}, () => {
				clearTimeout(timer);
				resolve(fallback);
			});
		});
	}

	/**
	 * Get a cached NoteDb meta state, refreshing the recency of the entry (the Map preserves
	 * insertion order, so recently used entries are evicted last).
	 */
	private getCachedMeta(cacheKey: string) {
		const cached = this.metaCache.get(cacheKey);
		if (cached !== undefined) {
			this.metaCache.delete(cacheKey);
			this.metaCache.set(cacheKey, cached);
		}
		return cached;
	}

	/**
	 * Cache a NoteDb meta state, evicting the least recently used entries when the cache is full.
	 */
	private setCachedMeta(cacheKey: string, state: GerritChangeState) {
		if (this.metaCache.size >= META_CACHE_LIMIT) {
			let toEvict = this.metaCache.size - META_CACHE_LIMIT + 1;
			for (const key of this.metaCache.keys()) {
				if (toEvict <= 0) break;
				this.metaCache.delete(key);
				toEvict--;
			}
		}
		this.metaCache.set(cacheKey, state);
	}

	/**
	 * List the open change refs on a remote (without fetching any objects).
	 */
	public listRemoteChanges(repo: string, remote: string) {
		return this.withTimeout(
			this.git.gitOutput(['ls-remote', remote, 'refs/changes/*'], repo, (stdout) => parseLsRemoteChanges(stdout)),
			new Map<number, number[]>()
		);
	}

	/**
	 * Fetch the specified change refspecs from a remote into `refs/remotes/<remote>/changes/`.
	 * The refspecs are fetched in command-line-sized batches (see [`chunkFetchRefspecs`]), stopping
	 * at the first batch that fails.
	 */
	public async fetchChanges(repo: string, remote: string, refspecs: string[]): Promise<ErrorInfo> {
		if (refspecs.length === 0) return null;
		for (const batch of chunkFetchRefspecs(refspecs)) {
			const error = await this.withTimeout(
				this.git.runGitCommand(['fetch', '--no-tags', remote].concat(batch), repo),
				<ErrorInfo>'Fetching the Gerrit changes from the remote timed out.'
			);
			if (error !== null) return error;
		}
		return null;
	}

	/**
	 * List the local change refs (under `refs/remotes/<remote>/changes/`) of a repository.
	 */
	public listLocalChangeRefs(repo: string, remote: string) {
		return this.git.gitOutput(['for-each-ref', 'refs/remotes/' + remote + '/changes/', '--format=%(refname)'], repo, (stdout) =>
			stdout.split(/\r?\n/).map((ref) => ref.trim()).filter((ref) => ref !== '')
		).catch(() => <string[]>[]);
	}

	/**
	 * Resolve the current hash of every local change ref of a repository in a SINGLE Git command
	 * (used to look up NoteDb meta hashes in bulk, instead of one `rev-parse` process per ref).
	 */
	public listLocalChangeRefHashes(repo: string, remote: string) {
		return this.git.gitOutput(['for-each-ref', 'refs/remotes/' + remote + '/changes/', '--format=%(refname)%00%(objectname)'], repo, (stdout) => {
			const hashes = new Map<string, string>();
			for (const line of stdout.split(/\r?\n/)) {
				const separator = line.indexOf('\0');
				if (separator === -1) continue;
				const ref = line.substring(0, separator);
				if (ref !== '') hashes.set(ref, line.substring(separator + 1));
			}
			return hashes;
		}).catch(() => new Map<string, string>());
	}

	/**
	 * Delete local change refs of changes that aren't in the keep list (keeps the repository at a
	 * constant size). All of the stale refs are deleted by a single batched `git update-ref --stdin`
	 * command (one process instead of one process per ref).
	 * @returns The ErrorInfo of the pruning (NULL => all refs were pruned successfully).
	 */
	public async pruneLocalChanges(repo: string, remote: string, keepChanges: ReadonlyArray<number>): Promise<ErrorInfo> {
		const prefixes = buildKeepPatterns(keepChanges, remote);
		const refs = await this.listLocalChangeRefs(repo, remote);
		const staleRefs = refs.filter((ref) => !prefixes.some((prefix) => ref.startsWith(prefix)));
		if (staleRefs.length === 0) return null;
		return this.git.runGitCommandWithInput(['update-ref', '--stdin'], repo, staleRefs.map((ref) => 'delete ' + ref).join('\n') + '\n');
	}

	/**
	 * Delete ALL local change refs (under `refs/remotes/<remote>/changes/`) of a repository with a
	 * single batched `git update-ref --stdin` command (the batch is applied atomically by Git).
	 * @returns The number of refs deleted, and the ErrorInfo of the failure (NULL => all succeeded).
	 */
	public async clearLocalChanges(repo: string, remote: string): Promise<{ error: ErrorInfo; cleared: number }> {
		const refs = await this.listLocalChangeRefs(repo, remote);
		if (refs.length === 0) return { error: null, cleared: 0 };
		const error = await this.git.runGitCommandWithInput(['update-ref', '--stdin'], repo, refs.map((ref) => 'delete ' + ref).join('\n') + '\n');
		return { error: error, cleared: error === null ? refs.length : 0 };
	}

	/**
	 * Parse the NoteDb meta refs of many changes into their states, concurrently.
	 *
	 * A single Git command resolves the hash of every local change ref (so already-parsed metas
	 * are served from the cache without any further Git command), and the meta histories of the
	 * remaining changes are each parsed by their own Git command, run by a pool of concurrent
	 * workers (each parse is an independent read-only Git operation). This avoids the cost of
	 * running 2 sequential Git processes per change, which dominated the Git Graph View load time
	 * on large Gerrit repositories.
	 * @param repo The repository.
	 * @param remote The remote the changes were fetched from.
	 * @param changes The change numbers to parse.
	 * @param urlBase The base URL of the Gerrit instance (or NULL).
	 * @returns A map of change number to its state (NULL => the meta ref isn't available locally),
	 *          in the order of the `changes` input.
	 */
	public async parseMetas(repo: string, remote: string, changes: ReadonlyArray<number>, urlBase: string | null): Promise<Map<number, GerritChangeState | null>> {
		const hashes = await this.listLocalChangeRefHashes(repo, remote);
		const results = new Map<number, GerritChangeState | null>();
		const pending: { change: number, metaRef: string, hash: string }[] = [];

		for (const change of changes) {
			const metaRef = 'refs/remotes/' + remote + '/changes/' + changeShard(change) + '/' + change + '/meta';
			const hash = hashes.get(metaRef);
			if (hash === undefined) {
				results.set(change, null); // meta ref not available locally
				continue;
			}
			const cached = this.getCachedMeta(repo + '|' + metaRef + '|' + hash);
			if (cached !== undefined) {
				results.set(change, cached);
			} else {
				pending.push({ change: change, metaRef: metaRef, hash: hash });
			}
		}

		const parsed = await evalPromises(pending, META_PARSE_CONCURRENCY, (item) => this.parseMetaLog(repo, item.change, item.metaRef, item.hash, urlBase));
		pending.forEach((item, i) => results.set(item.change, parsed[i]));

		// Preserve the input order (the workers complete in a nondeterministic order)
		const ordered = new Map<number, GerritChangeState | null>();
		for (const change of changes) ordered.set(change, <GerritChangeState | null>results.get(change));
		return ordered;
	}

	/**
	 * Parse the NoteDb meta history of a change into its state (cached by the meta ref's hash).
	 * @param repo The repository.
	 * @param change The change number.
	 * @param metaRef The full name of the NoteDb meta ref.
	 * @param hash The current hash of the meta ref (the cache key component).
	 * @param urlBase The base URL of the Gerrit instance (or NULL).
	 */
	private async parseMetaLog(repo: string, change: number, metaRef: string, hash: string, urlBase: string | null) {
		const cacheKey = repo + '|' + metaRef + '|' + hash;
		const cached = this.getCachedMeta(cacheKey);
		if (cached !== undefined) return cached;

		const state = await this.git.gitOutput(
			['log', metaRef, '--format=' + ['%cN', '%ct', '%B'].join('%x1f') + '%x1e'],
			repo,
			(stdout) => {
				const records: MetaCommitRecord[] = [];
				for (const record of stdout.split('\x1e')) {
					const parts = record.split('\x1f');
					if (parts.length < 3) continue;
					records.push({ committer: parts[0].trim(), timestamp: parseInt(parts[1], 10), message: parts.slice(2).join('\x1f') });
				}
				return parseMetaHistory(change, records);
			}
		).catch(() => null);

		if (state === null) return null;
		state.url = urlBase !== null ? urlBase + change : null;
		this.setCachedMeta(cacheKey, state);
		return state;
	}

	/**
	 * Derive the web URL of a Gerrit change from the remote's URL.
	 * @returns The base URL (ending with "/c/<project>/+/"), or NULL if the remote URL isn't an HTTP(S) URL.
	 */
	public getChangeUrlBase(repo: string, remote: string) {
		return this.git.gitOutput(['remote', 'get-url', remote], repo, (stdout) => {
			let url = stdout.trim();
			const sshMatch = /^(?:ssh:\/\/)?([^\/:]+)(?::29418)?\/(.+?)(?:\.git)?$/i.exec(url);
			if (sshMatch !== null) url = 'http://' + sshMatch[1] + '/' + sshMatch[2].replace(/^\//, '');
			if (!/^https?:\/\//i.test(url)) return null;
			const match = /^(https?:\/\/[^\/]+)\/?(.+?)(?:\.git)?\/?$/i.exec(url);
			if (match === null) return null;
			// Strip Gerrit's authenticated prefix ("a/") from the project path; it is not part of the web UI URL
			const project = match[2].replace(/^a\//, '');
			return match[1] + '/c/' + project + '/+/';
		}).catch(() => null);
	}
}

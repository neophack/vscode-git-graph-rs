import { createHash } from 'crypto';
import { GerritChangeEvent, GerritChangeState, GerritChangeStatus } from '../../../shared/model/gerrit';

/**
 * The pure Gerrit data model: change-ref parsing, NoteDb meta parsing, status filtering and the
 * adaptive sampling schedule, Change-Id helpers, and remote-URL parsing — all plain functions
 * over data, with no I/O.
 *
 * Split along the integration's natural seam: this
 * module answers "what does this data mean"; the `GerritDataSource` in `gerrit.ts` answers "how
 * is the data fetched and cached".
 */

export interface ParsedChangeRef {
	change: number;
	patchset?: number; // undefined => meta ref
	meta: boolean;
}

const CHANGE_REF_REGEX = /(?:^|\/)changes\/\d+\/(\d+)\/(meta|\d+)$/;
const CHANGE_ID_REGEX = /^Change-Id: (I[0-9a-f]{40})\s*$/m;
const LABEL_FOOTER_REGEX = /^Label: ([A-Za-z0-9-]+)\s*=\s*([+-]?\d+)\s*$/gm;

/**
 * The refspec budget of one `git fetch` command line. Windows caps a process command line at
 * ~32k characters, which a few hundred change refspecs exceed (the `gerrit.fetchLimit` setting
 * allows up to 10000 changes = 20000 refspecs), so large fetches are split into batches that stay
 * well inside every platform's limit.
 */
const FETCH_REFSPEC_BUDGET = 8000;

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
	} else if (/Restore Ready for Review|^Remove WIP|^Ready for review change/.test(header)) {
		// "Restore Ready for Review" readies the change in the same record that restores it, so
		// it must be classified BEFORE the plain "Restore" fallback — that branch's regex also
		// matches this header and would leave `wip` stuck at true, hiding the ready change.
		event.type = 'ready';
		result.wip = false;
		if (/^Restore/.test(header)) result.status = 'new';
	} else if (/Restore(d)?$/.test(header) || /^Restored$/.test(header) || (result.status === 'new' && /^Unabor/.test(header))) {
		event.type = 'restored';
		result.status = 'new';
	} else if (result.wip === true) {
		// A WIP transition carried only by the footer of an otherwise generic record
		event.type = 'wip';
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



/* Change-Id Helpers */

/**
 * Extract the Gerrit Change-Id footer of a commit message.
 * @param message The commit message.
 * @returns The Change-Id (e.g. "I0123456789abcdef..."), or NULL if the message has no valid footer.
 */
export function extractChangeId(message: string) {
	const match = CHANGE_ID_REGEX.exec(message);
	return match === null ? null : match[1];
}

/**
 * Generate a Gerrit Change-Id for a commit (same construction as the Gerrit commit-msg hook).
 * @param tree The tree hash of the commit.
 * @param parent The parent hash of the commit.
 * @param author The author string ("Name <email> timestamp").
 * @param committer The committer string ("Name <email> timestamp").
 * @param message The commit message (without Change-Id).
 * @param nonce An optional nonce (defaults to the current time in milliseconds).
 */
export function generateChangeId(tree: string, parent: string, author: string, committer: string, message: string, nonce: string = String(Date.now())) {
	const data = ['tree ' + tree, 'parent ' + parent, 'author ' + author, 'committer ' + committer, '', message, '', nonce, ''].join('\n');
	return 'I' + createHash('sha1').update(data).digest('hex');
}


/* Remote Server Parsing */

/**
 * The Gerrit server a remote's URL names: the scheme its web interface is served over (NULL when
 * the remote itself doesn't say), the host (with its web port, if the remote gave one), and the
 * project path.
 *
 * Both of Git's ssh forms are understood — `ssh://[user@]host[:port]/project` on ANY port (29418
 * is only Gerrit's default; a deployment is free to move it) and the scp-style `[user@]host:project`
 * — and neither says anything about the web interface's scheme, so the caller picks it. Any
 * credentials in the URL are dropped: they belong to the Git transport, not to a web link or a
 * download. A local path (`/srv/git/repo`, `C:/repos/repo`) names no server.
 * @returns The parts of the server, or NULL if the remote is not an http(s) or ssh URL.
 */
export function gerritRemoteServer(remoteUrl: string): { scheme: string | null; host: string; project: string } | null {
	const url = remoteUrl.trim();
	const http = /^(https?):\/\/(?:[^\/@]*@)?([^\/]+)(?:\/(.*))?$/i.exec(url);
	if (http !== null) return { scheme: http[1].toLowerCase(), host: http[2], project: gerritProjectPath(http[3]) };

	const ssh = /^ssh:\/\/(?:[^\/@]*@)?([^\/:@]+)(?::\d+)?(?:\/(.*))?$/i.exec(url);
	if (ssh !== null) return { scheme: null, host: ssh[1], project: gerritProjectPath(ssh[2]) };

	// The scp-style form has no port, and a single-letter host is a Windows drive, not a host
	const scp = /^(?:[^\/@]*@)?([A-Za-z0-9_][A-Za-z0-9._-]*):(?!\/)(.*)$/.exec(url);
	if (scp !== null && scp[1].length > 1) return { scheme: null, host: scp[1], project: gerritProjectPath(scp[2]) };

	return null;
}

/** The project a remote URL's path names, without the surrounding slashes or the `.git` suffix. */
function gerritProjectPath(path: string | undefined): string {
	return (path === undefined ? '' : path).replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

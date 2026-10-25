/**
 * The full commit message bodies, fetched on demand: the commit list only carries subjects, so
 * the bodies are only requested for the rows that are actually rendered with "Show Commit Body
 * Inline" enabled, and for the Edit Commit Message dialog.
 */

import * as GG from '../../common/protocol';
import { UNCOMMITTED } from '../../common/util';
import { GraphContext } from '../context';

const COMMIT_BODIES_BATCH_LIMIT = 200;

export class CommitBodies {
	/** The bodies received so far, keyed by commit hash. */
	public bodies: { [hash: string]: string } = {};
	private readonly requested = new Set<string>(); // hashes already requested (avoids re-requesting)
	/** Callbacks waiting for a commit's body to arrive, keyed by commit hash (see getCommitBody). */
	private waiters: { [hash: string]: ((body: string | null) => void)[] } = {};
	/** The hashes each outstanding commitBodies request asked for, keyed by the request id assigned to it. */
	private requests: { [id: number]: string[] } = {};
	private nextRequestId = 1;

	constructor(private readonly ctx: () => GraphContext) { }

	/** Forget everything fetched (the commits are being cleared). */
	public clear() {
		this.bodies = {};
		this.requested.clear();
		this.waiters = {};
		this.requests = {};
	}

	/**
	 * Send a commitBodies request, remembering which hashes it asked for so its response resolves
	 * only the waiters of those hashes (the channel is single-ordered, so responses arrive in
	 * request order and the echoed request id always identifies the request they answer).
	 */
	private request(commitHashes: string[]) {
		const ctx = this.ctx();
		const requestId = this.nextRequestId++;
		this.requests[requestId] = commitHashes;
		ctx.bridge.send({ command: 'commitBodies', repo: ctx.store.currentRepo, commitHashes: commitHashes, requestId: requestId });
	}

	/**
	 * Request the full message bodies of the commits in the given (rendered) row range, on demand:
	 * the commit list only carries subjects, and bodies are only displayed when "Show Commit Body
	 * Inline" is enabled (no-op otherwise).
	 */
	public requestForRows(from: number, to: number) {
		const store = this.ctx().store;
		if (!store.config.showBodyInline) return;
		const missing: string[] = [];
		for (let i = from; i < to && missing.length < COMMIT_BODIES_BATCH_LIMIT; i++) {
			const commit = store.commits[i];
			if (commit.hash === UNCOMMITTED || commit.stash !== null) continue;
			if (typeof this.bodies[commit.hash] !== 'string' && !this.requested.has(commit.hash)) {
				this.requested.add(commit.hash);
				missing.push(commit.hash);
			}
		}
		if (missing.length > 0) this.request(missing);
	}

	/**
	 * Get the full message body of one commit, fetching it on demand (the commit list only carries
	 * subjects). The callback is invoked with the body once it is available - immediately when it
	 * is already cached, otherwise after it has been fetched - or with null when the fetch fails,
	 * in which case the caller can fall back to the commit's subject.
	 * @param hash The hash of the commit.
	 * @param received Invoked with the commit's full message body, or null when it is unavailable.
	 */
	public getCommitBody(hash: string, received: (body: string | null) => void) {
		const cached = this.bodies[hash];
		if (typeof cached === 'string') {
			received(cached);
			return;
		}
		(this.waiters[hash] || (this.waiters[hash] = [])).push(received);
		if (!this.requested.has(hash)) {
			this.requested.add(hash);
			this.request([hash]);
		}
	}

	/**
	 * Store a batch of commit message bodies fetched on demand, and re-render the rows so the
	 * inline bodies ("Show Commit Body Inline") become visible.
	 */
	public process(msg: GG.ResponseCommitBodies) {
		let received = false;
		for (const hash in msg.bodies) {
			this.bodies[hash] = msg.bodies[hash];
			received = true;
		}
		// The response answers exactly one request: only the waiters of the hashes that request
		// asked for are settled, so a failed batch (the native backend fails the whole call when
		// one hash is unresolvable) cannot null-resolve a dialog's in-flight waiter for a
		// different hash. A response with an unknown request id (a late answer to a request a
		// hard refresh discarded) only ever resolves the waiters of the hashes it actually
		// carries. Requested hashes a successful response does not carry failed individually:
		// their waiters fall back to the subject instead of waiting forever.
		const requested = this.requests[msg.requestId];
		if (requested !== undefined) delete this.requests[msg.requestId];
		const settled = received
			? requested !== undefined ? requested : Object.keys(msg.bodies)
			: requested !== undefined ? requested : [];
		this.resolveWaiters(settled);
		if (!received) return;
		// Coalesced (task 5.10): the bodies becoming visible a frame later is imperceptible, and a
		// burst of body responses merges into one render
		this.ctx().renderScheduler.request();
	}

	/**
	 * Resolve the callbacks waiting for commit bodies: every waiter registered for one of the given
	 * hashes is invoked with its body and removed. A hash whose body could not be fetched resolves
	 * its waiters with null (the caller falls back to the subject) and is dropped from the
	 * requested set, so a later getCommitBody for the same commit sends a fresh request instead of
	 * waiting on a response that already failed.
	 */
	private resolveWaiters(hashes: string[]) {
		const resolved: Array<[string, string | null]> = [];
		for (const hash of hashes) {
			const body = this.bodies[hash];
			resolved.push([hash, typeof body === 'string' ? body : null]);
		}
		for (const [hash, body] of resolved) {
			if (body === null) this.requested.delete(hash);
			const waiters = this.waiters[hash];
			if (waiters === undefined) continue;
			delete this.waiters[hash];
			for (const waiter of waiters) waiter(body);
		}
	}
}

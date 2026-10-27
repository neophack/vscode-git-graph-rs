/**
 * The background change poll of the graph view. Everything it touches arrives injected, so
 * the tick logic is unit-testable without Git and without 'vscode'.
 */

/** The collaborators the poll needs, injected. */
export interface BackgroundPollerDeps {
	/** The repository the view currently shows (NULL => nothing to poll yet). */
	currentRepo(): string | null;
	/**
	 * Read the repository's signature: the resolved hash of HEAD, and the names and hashes of
	 * every branch, tag, remote-tracking ref and stash. NULL when it is momentarily unreadable.
	 */
	getSignature(repo: string): Promise<string | null>;
	/** The repository changed without the file watcher reporting it: drop the caches, refresh the view. */
	onRepoChanged(): void;
	readonly logger: { log(message: string): void };
}

/**
 * The background change poll: every tick, the repository's signature is compared against the
 * last observation, so a change the file watcher missed (watcher events can be dropped by the
 * platform, e.g. on network or synced filesystems) still refreshes the view promptly. The
 * interval is a few seconds: a commit made outside this extension must appear on the graph
 * without a noticeable wait, and the signature read is a cheap in-process ref scan. The
 * signature carries the ref HASHES (not just the names `getRepoInfo` returns): a new commit on
 * an existing branch changes no name, so a name-only signature would never notice it.
 */
export class BackgroundChangePoller {
	private timer: NodeJS.Timeout | null = null;
	/** The last repository signature the poll observed (NULL => record a baseline first). */
	private lastRepoSignature: string | null = null;

	constructor(private readonly deps: BackgroundPollerDeps, private readonly intervalMs: number) {}

	/** Arm the poll (idempotent). */
	public start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => void this.check(), this.intervalMs);
	}

	/** Stop the poll and drop the timer (a tick already in flight finishes harmlessly). */
	public stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Forget the last signature: the next tick records a baseline without refreshing. The Panel
	 * calls this whenever a change is handled elsewhere (the repo file watcher fired, or the
	 * view switched repository), so the poll must not detect the same change again.
	 */
	public resetBaseline(): void {
		this.lastRepoSignature = null;
	}

	/**
	 * One tick: read the repository's signature and compare it with the previous tick. Public
	 * so the Panel can forward a direct tick (the pipeline test and the automation suite drive
	 * a tick immediately instead of waiting out the multi-second interval). The tick runs
	 * whether the view is visible or not - an inactive tab must not blind the poll, the
	 * change still has to invalidate the cache. A difference means the repository changed
	 * without the file watcher reporting it (dropped events, unusual filesystems), so the
	 * callback drops the cached commit data and asks the view to refresh - exactly what the
	 * watcher callback does. A NULL baseline (start, repository switch, or a watcher-handled
	 * change) is recorded without refreshing, and an unreadable repository keeps the previous
	 * baseline (its change, if any, is still detected by the next successful read).
	 */
	public async check(): Promise<void> {
		const repo = this.deps.currentRepo();
		// Runs hidden or visible: detection must never stop at a visibility gate, because the
		// change a commit makes while the view is a hidden tab still has to invalidate the commit
		// cache before the next show's soft refresh serves from it (a message sent to a destroyed
		// page is simply dropped - the invalidation, not the delivery, is what matters here).
		if (repo === null) return;
		try {
			const signature = await this.deps.getSignature(repo);
			if (repo !== this.deps.currentRepo()) return; // the view moved on while reading
			if (signature === null) return; // momentarily unreadable (e.g. mid-rebase file churn): try again next tick
			if (this.lastRepoSignature !== null && signature !== this.lastRepoSignature) {
				this.deps.logger.log('Background poll detected a repository change in ' + repo);
				this.deps.onRepoChanged();
			}
			this.lastRepoSignature = signature;
		} catch (_) {
			// The repository is momentarily unreadable: try again next tick
		}
	}
}

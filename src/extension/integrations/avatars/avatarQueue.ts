/**
 * The avatar request queue: the ordered, de-duplicating backlog of avatar fetches the
 * `AvatarManager` drains on its interval. Split out of `avatarManager.ts` along the manager's
 * natural seam (REFACTOR-PLAN task 6.2): this module is the scheduling data structure; the
 * manager in `avatarManager.ts` owns the cache, storage and fetchers.
 */

export interface AvatarRequestItem {
	email: string;
	repo: string;
	remote: string | null;
	commits: string[];
	checkAfter: number;
	attempts: number;
}

/**
 * Represents a queue of avatar requests, ordered by their `checkAfter` value.
 */
export class AvatarRequestQueue {
	private queue: AvatarRequestItem[] = [];
	private itemsAvailableCallback: () => void;

	/**
	 * Create an Avatar Request Queue.
	 * @param itemsAvailableCallback A callback that is invoked when the queue transitions from having no items, to having at least one item.
	 */
	constructor(itemsAvailableCallback: () => void) {
		this.itemsAvailableCallback = itemsAvailableCallback;
	}

	/**
	 * Create and add a new avatar request to the queue.
	 * @param email The email address identifying the avatar.
	 * @param repo The repository that the avatar is used in.
	 * @param remote The remote that the avatar can be fetched from.
	 * @param commits The commits that reference the avatar.
	 * @param immediate Whether the avatar should be fetched immediately.
	 */
	public add(email: string, repo: string, remote: string | null, commits: string[], immediate: boolean) {
		const existingRequest = this.queue.find((request) => request.email === email && request.repo === repo);
		if (existingRequest) {
			commits.forEach((commit) => {
				if (!existingRequest.commits.includes(commit)) {
					existingRequest.commits.push(commit);
				}
			});
		} else {
			this.insertItem({
				email: email,
				repo: repo,
				remote: remote,
				commits: commits,
				checkAfter: immediate || this.queue.length === 0
					? 0
					: this.queue[this.queue.length - 1].checkAfter + 1,
				attempts: 0
			});
		}
	}

	/**
	 * Add an existing avatar request item back onto the queue.
	 * @param item The avatar request item.
	 * @param checkAfter The earliest time the avatar should be requested.
	 * @param failedAttempt Did the fetch attempt fail.
	 */
	public addItem(item: AvatarRequestItem, checkAfter: number, failedAttempt: boolean) {
		item.checkAfter = checkAfter;
		if (failedAttempt) item.attempts++;
		this.insertItem(item);
	}

	/**
	 * Check if there are items in the queue.
	 * @returns TRUE => Items in queue, FALSE => Queue is empty.
	 */
	public hasItems() {
		return this.queue.length > 0;
	}

	/**
	 * Take the next item from the queue if an item is available.
	 * @returns An avatar request item, or NULL if no item is available.
	 */
	public takeItem() {
		if (this.queue.length > 0 && this.queue[0].checkAfter < (new Date()).getTime()) return this.queue.shift()!;
		return null;
	}

	/**
	 * Insert an avatar request item into the queue.
	 * @param item The avatar request item.
	 */
	private insertItem(item: AvatarRequestItem) {
		const prevLength = this.queue.length;
		let l = 0, r = this.queue.length - 1, c;
		while (l <= r) {
			c = l + r >> 1;
			if (this.queue[c].checkAfter <= item.checkAfter) {
				l = c + 1;
			} else {
				r = c - 1;
			}
		}
		this.queue.splice(l, 0, item);
		if (prevLength === 0) this.itemsAvailableCallback();
	}
}

/**
 * Platform storage adapter (REFACTOR-PLAN 3.3): global- and workspace-state persistence behind
 * one Storage interface - the destination of the raw memento access in src/extensionState.ts
 * (formerly the plan's `storage.ts (formerly extensionState)` row).
 *
 * The dependency is injected structurally (production wiring passes a context's `globalState` /
 * `workspaceState`, both `vscode.Memento`-shaped). Reads are LENIENT: with no memento available
 * (or a failing one) `get` answers the caller's default and `undefined`, never throws. Writes
 * report success as a boolean instead of rejecting, so state bookkeeping can never take down a
 * request path.
 */

/** The `vscode.Memento` surface this adapter uses. */
export interface MementoLike {
	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

export class Storage {
	private readonly memento: MementoLike | null;

	/**
	 * @param memento A memento-like object (`vscode.Memento` satisfies this structurally); NULL
	 * or undefined when no backing store is available.
	 */
	constructor(memento: MementoLike | null | undefined) {
		this.memento = memento ?? null;
	}

	/**
	 * Read a value (lenient read): the stored value when present, otherwise the given default
	 * (or undefined). An unavailable or throwing store answers like an empty one.
	 */
	public get<T>(key: string, defaultValue?: T): T | undefined {
		const memento = this.memento;
		if (memento === null) return defaultValue;
		const read = memento.get as unknown;
		if (typeof read !== 'function') return defaultValue;
		try {
			const get = (read as <V>(readKey: string, readDefault?: V) => V | undefined).bind(memento) as (key: string, defaultValue?: T) => T | undefined;
			return defaultValue === undefined ? get(key) : get(key, defaultValue);
		} catch {
			return defaultValue;
		}
	}

	/**
	 * Store a value.
	 * @returns TRUE when the value was persisted; FALSE when no store is available or the
	 * update rejected (never rejects).
	 */
	public set(key: string, value: unknown): Promise<boolean> {
		return this.update(key, value);
	}

	/**
	 * Remove a key from the store (the memento's undefined-value convention).
	 * @returns TRUE when the key was removed; FALSE when no store is available or the update
	 * rejected.
	 */
	public remove(key: string): Promise<boolean> {
		return this.update(key, undefined);
	}

	private update(key: string, value: unknown): Promise<boolean> {
		const update = this.memento?.update;
		if (typeof update !== 'function') return Promise.resolve(false);
		return Promise.resolve(update.call(this.memento, key, value) as Thenable<void>)
			.then(() => true, () => false);
	}
}

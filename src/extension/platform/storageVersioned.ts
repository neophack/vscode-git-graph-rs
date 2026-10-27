/**
 * Versioned records for the globalState / workspaceState surface: every value the
 * `ExtensionState` persists is wrapped in a versioned
 * envelope so schema evolution goes through a migrations table instead of losing or
 * corrupting the user's settings on an upgrade or downgrade.
 *
 * The rules:
 * - **Lenient read** - every older version is readable. A value stored before versioning
 *   existed (the 1.0.27 extension wrote raw values) is treated as version 0 data and
 *   migrated; data written by a NEWER version is preserved as-is, unknown fields included,
 *   so a downgrade keeps working.
 * - **Strict write** - every write stamps the current version.
 * - **Migrations** - ordered steps that upgrade one version to the next. Every step must
 *   spread unknown fields through, so forward-compatibility survives each migration.
 *
 * This module is also the ONE versioned KV every store of the `ExtensionState` sits on
 * (`VersionedStateKv`): the per-store modules (avatars, code reviews, view state, and the
 * keys the facade keeps) read and write through it, so the lenient-read / strict-write
 * semantics and the two memento failure messages exist exactly once.
 */

import type { ErrorInfo } from '../../shared/protocol/messages';

/** The memento surface the versioned read helper needs (`vscode.Memento` satisfies it). */
interface MementoReader {
	get<T>(key: string): T | undefined;
}

/** The memento surface the versioned KV writes through (`vscode.Memento` satisfies it). */
interface MementoWriter {
	update(key: string, value: unknown): Thenable<void>;
}

/** The memento surface the versioned KV reads and writes (`vscode.Memento` satisfies it). */
interface VersionedMemento extends MementoReader, MementoWriter { }

/** A value of the globalState / workspaceState surface together with its schema version. */
export interface VersionedStateRecord {
	readonly version: number;
	readonly data: unknown;
}

/** The schema version every `ExtensionState` write stamps. */
export const STORAGE_STATE_VERSION = 1;

/**
 * Up-migrations of the globalState / workspaceState surface, ordered by source version: the
 * step at index i upgrades version-i data to version i+1. Index 0 covers the pre-versioning
 * 1.0.27 values, which were stored raw under the same keys with the same field layouts - the
 * step is therefore a pass-through normalization (enveloping happens in the encoder). Add one
 * step per released schema change, and keep unknown fields flowing through every step.
 */
export const STORAGE_MIGRATIONS: ReadonlyArray<(data: unknown) => unknown> = [
	(data) => data
];

/**
 * Decode one stored value into a versioned record (lenient read).
 * @param raw The raw stored value (undefined when the key was never written).
 * @returns The record at its current schema version, or NULL when the key has no value. Data
 * written by a newer version is returned untouched (its version and unknown fields kept), so
 * an older extension never destroys what a newer one wrote.
 */
export function decodeVersionedState(raw: unknown): VersionedStateRecord | null {
	if (raw === undefined) return null;
	let version = 0;
	let data: unknown = raw;
	if (raw !== null && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'number') {
		version = (raw as { version: number }).version;
		data = (raw as { data?: unknown }).data;
	}
	if (version > STORAGE_STATE_VERSION) {
		return { version: version, data: data };
	}
	for (let v = version; v < STORAGE_STATE_VERSION; v++) {
		const migrate = STORAGE_MIGRATIONS[v];
		if (typeof migrate !== 'function') return null;
		data = migrate(data);
	}
	return { version: STORAGE_STATE_VERSION, data: data };
}

/**
 * Encode a value for storing (strict write): the versioned envelope stamped with the current
 * schema version. Passing undefined removes the key and must not be enveloped.
 */
export function encodeVersionedState<T>(data: T): { version: number; data: T } | undefined {
	return data === undefined ? undefined : { version: STORAGE_STATE_VERSION, data: data };
}

/**
 * Read one key from a memento through the versioned record lens (lenient): an unavailable or
 * throwing store, a missing key, a value no migration can reach, or data of the wrong shape
 * all answer the caller's fallback - never throw.
 */
export function readVersionedState<T>(memento: MementoReader | null | undefined, key: string, fallback: T): T {
	const get = memento === null || memento === undefined ? undefined : memento.get;
	if (typeof get !== 'function') return fallback;
	try {
		const raw = (get as (readKey: string) => unknown).call(memento, key);
		const record = decodeVersionedState(raw);
		return record === null ? fallback : record.data as T;
	} catch {
		return fallback;
	}
}

/** Whether a decoded value is a non-null, non-array object (the shape record keys expect). */
export function isStateRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The one versioned KV over the extension's globalState / workspaceState memento pair. The
 * `ExtensionState` facade and its per-store modules (avatars, code reviews, view state) read
 * and write through this object only - never through a memento directly - so every key of the
 * Git Graph state carries the same versioned envelope.
 */
export class VersionedStateKv {
	private readonly globalState: VersionedMemento;
	private readonly workspaceState: VersionedMemento;

	/**
	 * @param globalState The global-state memento (`vscode.Memento` satisfies the shape).
	 * @param workspaceState The workspace-state memento.
	 */
	constructor(globalState: VersionedMemento, workspaceState: VersionedMemento) {
		this.globalState = globalState;
		this.workspaceState = workspaceState;
	}

	/**
	 * Read a versioned value from the Git Graph Global State (lenient): the stored value
	 * migrated to the current schema, or the fallback when absent, corrupt or unreadable.
	 * @param key The key.
	 * @param fallback The value to answer when the key holds nothing readable.
	 * @returns The decoded value.
	 */
	public readGlobal<T>(key: string, fallback: T): T {
		return readVersionedState<T>(this.globalState, key, fallback);
	}

	/**
	 * Read a versioned value from the Git Graph Workspace State (lenient, as readGlobal).
	 * @param key The key.
	 * @param fallback The value to answer when the key holds nothing readable.
	 * @returns The decoded value.
	 */
	public readWorkspace<T>(key: string, fallback: T): T {
		return readVersionedState<T>(this.workspaceState, key, fallback);
	}

	/**
	 * Update the Git Graph Global State with a new <key, value> pair. Values are stored in the
	 * versioned envelope (strict write); undefined removes the key.
	 * @param key The key.
	 * @param value The value.
	 * @returns A Thenable resolving to the ErrorInfo that resulted from updating the Global State.
	 */
	public writeGlobal(key: string, value: unknown): Thenable<ErrorInfo> {
		return this.globalState.update(key, encodeVersionedState(value)).then(
			() => null,
			() => 'Visual Studio Code was unable to save the Git Graph Global State Memento.'
		);
	}

	/**
	 * Update the Git Graph Workspace State with a new <key, value> pair, versioned as the
	 * Global State writes are.
	 * @param key The key.
	 * @param value The value.
	 * @returns A Thenable resolving to the ErrorInfo that resulted from updating the Workspace State.
	 */
	public writeWorkspace(key: string, value: unknown): Thenable<ErrorInfo> {
		return this.workspaceState.update(key, encodeVersionedState(value)).then(
			() => null,
			() => 'Visual Studio Code was unable to save the Git Graph Workspace State Memento.'
		);
	}
}

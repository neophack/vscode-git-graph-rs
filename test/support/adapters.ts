import * as fs from 'node:fs';

import { isAddonAvailable } from '../../src/extension/git/read/addonLoader';
import { createBackend, GitBackend } from '../../src/extension/git/read/backendIndex';
import { GitFileChange } from '../../src/extension/git/read/types';

/**
 * The two contract legs of the Reader contract suite, and the small normalisations the shared
 * assertions need (REFACTOR-PLAN §6.1 L3).
 *
 * Each leg is built through the same factory the extension uses, so the suite exercises the
 * composition users get: `prefer: 'rust'` is the engine with its per-call CLI fallback, and
 * `prefer: 'git-cli'` is the CLI alone. When the engine's addon is not built on this machine the
 * rust leg's describes skip cleanly (`describe.skipIf`); the CLI leg always runs.
 */

/** Whether the compiled engine addon loaded. Probed once per process. */
export const addonAvailable: boolean = isAddonAvailable();

export interface AdapterLeg {
	/** Which backend the leg pretends to be, for the describe titles. */
	readonly name: 'rust' | 'git-cli';
	/** The backend every case of the leg runs against. */
	readonly backend: GitBackend;
	/** Whether the leg requires the native addon (and so skips without one). */
	readonly needsAddon: boolean;
}

/** Both legs, in run order: the engine composition first, then the CLI. */
export function adapterLegs(): ReadonlyArray<AdapterLeg> {
	return [
		{ name: 'rust', backend: createBackend({ prefer: 'rust', gitPath: 'git' }), needsAddon: true },
		{ name: 'git-cli', backend: createBackend({ prefer: 'git-cli', gitPath: 'git' }), needsAddon: false }
	];
}

/** One file change reduced to the three fields both adapters must spell identically. */
export interface NormalisedChange {
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: string;
}

/**
 * File changes sorted by their new path — git guarantees no order for a diff's file list, so the
 * contract compares them as a sorted list.
 */
export function changesByPath(changes: ReadonlyArray<GitFileChange>): NormalisedChange[] {
	return changes
		.map((change) => ({
			oldFilePath: change.oldFilePath,
			newFilePath: change.newFilePath,
			type: String(change.type)
		}))
		.sort((a, b) => a.newFilePath.localeCompare(b.newFilePath));
}

/**
 * The paths of a change list, sorted — for cases that care which files changed, not how.
 */
export function changePaths(changes: ReadonlyArray<GitFileChange>): string[] {
	return changes.map((change) => change.newFilePath).sort();
}

/**
 * Resolve a path the way the extension must before comparing roots the two backends print:
 * git spells forward slashes, and on Windows one of the reporters may use the 8.3 short form.
 */
export function normalisePath(value: string): string {
	return fs.realpathSync.native(value).replace(/\\/g, '/').toLowerCase();
}

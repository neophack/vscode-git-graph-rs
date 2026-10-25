/**
 * Choosing a backend, and falling back when one cannot answer.
 *
 * The extension asks for a `GitBackend` and gets one. Which implementation it is — and whether a
 * particular call was served by the Rust engine or by the `git` command line — is not the calling
 * code's concern, which is what lets the engine grow one capability at a time. This module is the
 * successor of the historical `src/backend/index.ts` (kept as a compatibility re-export).
 */

import { GitBackend, NativeBackend } from './gitReader';
import { isAddonAvailable, loadAddon, platformKey } from './addonLoader';
import { CliBackend } from './cli';
import { BackendCapability, BackendReport } from '../../../types';
import { GitBackendError } from './types';
import { createFallbackReader } from './fallbackReader';

export * from './types';
export { GitBackend } from './gitReader';
export { NativeBackend } from './gitReader';
export { CliBackend } from './cli';

export interface BackendOptions {
	/** Force a particular backend, rather than preferring the engine. */
	readonly prefer?: 'rust' | 'git-cli';
	/**
	 * The `git` executable the fallback should use: a path when one was found, `null` when none
	 * exists (the engine then runs alone), or undefined when the caller has not looked — the
	 * fallback then uses whatever `git` is on the PATH.
	 */
	readonly gitPath?: string | null;
	/** Called whenever a call falls back, so the extension can log it. */
	readonly onFallback?: (method: string, error: GitBackendError) => void;
}

/**
 * Build the backend the extension should use.
 *
 * With both an engine binary and a `git` executable available, this is the engine wrapped so that
 * anything it cannot answer reaches the `git` CLI. With an engine but no `git`, it is the engine
 * alone: every read still works (the read path is fully engine-served), and operations that would
 * need the CLI report so instead of silently spawning nothing. With no engine it is the CLI
 * alone, matching the original extension — and if there is no `git` either, that is reported by
 * the view, which has nothing to run on.
 */
export function createBackend(options: BackendOptions = {}): GitBackend {
	// `null` means no Git was found anywhere; `undefined` means the caller has not looked, and
	// whatever `git` is on the PATH stands in.
	const hasGit = options.gitPath !== null;

	if (options.prefer === 'git-cli') return new CliBackend(options.gitPath ?? 'git');
	if (!isAddonAvailable()) return new CliBackend(options.gitPath ?? 'git');
	if (!hasGit) return new NativeBackend();

	try {
		return createFallbackReader(new NativeBackend(), new CliBackend(options.gitPath ?? 'git'), options.onFallback);
	} catch {
		// Loading the addon can fail for reasons the availability probe cannot see (a mismatched
		// Node ABI, a missing system library). The extension still works; it is just not faster.
		return new CliBackend(options.gitPath ?? 'git');
	}
}

/** Which backend `createBackend` would pick, without building it. */
export function describeBackend(options: BackendOptions = {}): string {
	if (options.prefer === 'git-cli') return 'git-cli';
	if (!isAddonAvailable()) return 'git-cli';
	return options.gitPath === null ? 'rust (engine only; no git CLI found)' : 'rust';
}

/**
 * Which backend serves each area of the extension *on the platform this editor is running on*.
 *
 * The split differs per platform: everywhere the engine binary loads, the reads are served by
 * Rust (with the two documented hybrids), and the write path spawns `git`; on a platform without
 * a binary — an architecture the engine is not built for, or a package missing it — everything
 * runs over the `git` CLI. This report is what the Settings widget's backend section shows, so
 * a user can see at a glance what is fast and what is not, on their machine.
 */
export function describeCapabilities(options: { addonRoot?: string; gitCliAvailable?: boolean } = {}): BackendReport {
	const engineAvailable = isAddonAvailable(options.addonRoot);
	let engineVersion: string | null = null;
	if (engineAvailable) {
		try {
			engineVersion = (options.addonRoot === undefined ? loadAddon() : loadAddon(options.addonRoot)).engineVersion();
		} catch {
			// The availability probe succeeded but the version call failed: report without it.
		}
	}

	const onEngine: BackendCapability[] = [
		{ area: 'repoInfo', provider: 'rust' },
		{ area: 'commits', provider: 'rust' },
		{ area: 'details', provider: 'rust' },
		{ area: 'diffs', provider: 'rust' },
		{ area: 'onDemand', provider: 'rust' },
		{ area: 'metadata', provider: 'rust' },
		// Reflog tips and `--glob=` patterns are declined by the engine and answered by the CLI,
		// transparently, per call.
		{ area: 'counting', provider: 'rust', note: 'dynamic' },
		{ area: 'config', provider: 'rust' },
		{ area: 'writes', provider: 'git-cli', note: 'writesAlways' }
	];
	const onCli: BackendCapability[] = [
		'repoInfo', 'commits', 'details', 'diffs', 'onDemand', 'metadata', 'counting', 'config', 'writes'
	].map((area) => ({ area, provider: 'git-cli' as const }));

	return {
		platform: platformKey(),
		engineAvailable,
		engineVersion,
		gitCliAvailable: options.gitCliAvailable !== false,
		capabilities: engineAvailable ? onEngine : onCli
	};
}

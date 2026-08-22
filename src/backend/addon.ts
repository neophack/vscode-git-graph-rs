/**
 * Loading the native addon, and the raw calls into it.
 *
 * Nothing above this file knows that the engine is a `.node` binary, that its payloads are JSON,
 * or that its errors arrive as strings with a prefix. That is the whole job here.
 */

import * as fs from 'fs';
import * as path from 'path';

import { GitBackendError, GitErrorKind } from './types';

/** The exports of `native/node/src/lib.rs`, as N-API presents them. */
interface NativeAddon {
	openRepository(path: string): Promise<string>;
	closeRepository(path: string): void;
	closeAllRepositories(): void;
	openRepositoryCount(): number;
	loadRepoInfo(path: string, optionsJson: string): Promise<string>;
	loadCommits(path: string, optionsJson: string): Promise<string>;
	loadRefs(path: string, optionsJson: string): Promise<string>;
	loadCommitDetails(path: string, hash: string): Promise<string>;
	loadUncommittedDetails(path: string): Promise<string>;
	loadStashDetails(path: string, hash: string, stashJson: string): Promise<string>;
	compareCommits(path: string, from: string, to: string): Promise<string>;
	countUncommittedChanges(path: string, includeUntracked: boolean): Promise<number>;
	loadStashes(path: string): Promise<string>;
	loadConfig(path: string): Promise<string>;
	loadCommitFile(path: string, commitHash: string, file: string): Promise<string>;
	loadCommitFileDiff(path: string, commitHash: string, file: string): Promise<string>;
	engineVersion(): string;
}

/**
 * The directory name of the prebuilt binary for this platform, matching what the CI matrix
 * produces and what the VSIX ships.
 */
export function platformDirectory(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch
): string {
	const key = `${platform}-${arch}`;
	switch (key) {
		case 'win32-x64':
			return 'win32-x64-msvc';
		case 'win32-arm64':
			return 'win32-arm64-msvc';
		case 'linux-x64':
			return 'linux-x64-gnu';
		case 'linux-arm64':
			return 'linux-arm64-gnu';
		case 'darwin-x64':
			return 'darwin-x64';
		case 'darwin-arm64':
			return 'darwin-arm64';
		default:
			throw new GitBackendError('Unsupported', `No native engine is built for ${key}`);
	}
}

/** Where the addon might be: the shipped location first, then the local build outputs. */
function candidatePaths(root: string): string[] {
	const directory = platformDirectory();
	return [
		path.join(root, 'native', directory, 'git-graph.node'),
		path.join(root, 'target', 'release', libraryName()),
		path.join(root, 'target', 'debug', libraryName())
	];
}

function libraryName(): string {
	switch (process.platform) {
		case 'win32':
			return 'git_graph_node.dll';
		case 'darwin':
			return 'libgit_graph_node.dylib';
		default:
			return 'libgit_graph_node.so';
	}
}

let cached: NativeAddon | null = null;
let loadFailure: Error | null = null;

/**
 * Load the addon, or report why it could not be loaded.
 *
 * The failure is remembered: a missing binary will not start working on a retry, and the caller
 * (which falls back to the `git` CLI) would otherwise pay the filesystem probe on every request.
 */
export function loadAddon(root: string = path.join(__dirname, '..', '..')): NativeAddon {
	if (cached !== null) return cached;
	if (loadFailure !== null) throw loadFailure;

	const candidates = candidatePaths(root);
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			cached = require(candidate) as NativeAddon;
			return cached;
		} catch (error) {
			loadFailure = new GitBackendError(
				'Unsupported',
				`The native engine at ${candidate} could not be loaded: ${errorMessage(error)}`
			);
			throw loadFailure;
		}
	}

	loadFailure = new GitBackendError(
		'Unsupported',
		`No native engine was found for ${process.platform}-${process.arch}. Looked in:\n  ${candidates.join('\n  ')}`
	);
	throw loadFailure;
}

/** Is the native engine available at all? Used to decide which backend to build. */
export function isAddonAvailable(root?: string): boolean {
	try {
		loadAddon(root);
		return true;
	} catch {
		return false;
	}
}

/** Forget the cached addon. Only useful in tests. */
export function resetAddonCache(): void {
	cached = null;
	loadFailure = null;
}

/**
 * The engine prefixes its errors with the kind (`Git: ...`), so that the two sides can disagree
 * about everything else and still agree about whether a failure is worth falling back over.
 */
const ERROR_KINDS: ReadonlyArray<GitErrorKind> = [
	'NotARepository',
	'NotFound',
	'InvalidArgument',
	'Git',
	'Io',
	'Cancelled',
	'Unsupported'
];

export function toBackendError(error: unknown): GitBackendError {
	if (error instanceof GitBackendError) return error;

	const message = errorMessage(error);
	for (const kind of ERROR_KINDS) {
		const prefix = `${kind}: `;
		if (message.startsWith(prefix)) {
			return new GitBackendError(kind, message.slice(prefix.length));
		}
	}
	return new GitBackendError('Git', message);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Run an addon call, translating both its errors and its JSON response. */
export async function callJson<T>(work: () => Promise<string>): Promise<T> {
	let raw: string;
	try {
		raw = await work();
	} catch (error) {
		throw toBackendError(error);
	}
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new GitBackendError('Git', `The engine returned a malformed response: ${errorMessage(error)}`);
	}
}

/** Run an addon call that returns a plain value rather than JSON. */
export async function call<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		throw toBackendError(error);
	}
}

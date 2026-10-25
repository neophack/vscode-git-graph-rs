/**
 * Loading the native addon, and the one request seam into it.
 *
 * Nothing above this file knows that the engine is a `.node` binary or that its payloads are
 * JSON: `request` is typed against the generated protocol (`src/shared/engine/protocol.ts`), and
 * failures arrive as the structured `{ kind, message }` object the engine serialises — never as
 * a prefixed string to parse back apart. That is the whole job here.
 */

import * as fs from 'fs';
import * as path from 'path';

import { EngineError, EngineMethod, EngineMethods } from '../../../shared/engine/protocol';
import { GitBackendError, GitErrorKind } from './types';

/**
 * The exports of `native/node/src/lib.rs`, as N-API presents them: eight functions, no more.
 * Everything the engine answers goes through `request`; the method table lives in the Rust
 * protocol, and its TypeScript mirror regenerates from there.
 */
export interface NativeAddon {
	open(path: string): Promise<string>;
	close(path: string): void;
	closeAll(): void;
	openCount(): number;
	engineVersion(): string;
	/** One `{"method", "params"}` call; resolves to the `{"ok"|"error"}` envelope as JSON text. */
	request(repo: string, requestJson: string, requestId?: number): Promise<string>;
	/** A file's raw bytes at a revision, or why they could not be read. */
	requestBytes(repo: string, revision: string, filePath: string, requestId?: number): Promise<BytesAnswer>;
	/**
	 * Cancel the request registered under `requestId` (task 2.9): it answers the structured
	 * `cancelled` error at its next checkpoint. Unknown and already-finished ids are no-ops, but
	 * a cancellation ahead of a request that later runs under the same id is honored.
	 */
	cancel(requestId: number): void;
}

/** The answer of `requestBytes`: the file's bytes, or the structured failure. */
export interface BytesAnswer {
	ok: Buffer | null;
	error: EngineError | null;
}

/**
 * The prebuilt engines the extension can ship, keyed by `${platform}-${arch}` of the editor.
 */
const ENGINE_PLATFORMS: Readonly<Record<string, { directory: string; os: string; arch: string }>> = {
	'win32-x64': { directory: 'win32-x64-msvc', os: 'Windows', arch: 'x64' },
	'win32-arm64': { directory: 'win32-arm64-msvc', os: 'Windows', arch: 'ARM64' },
	'linux-x64': { directory: 'linux-x64-gnu', os: 'Linux', arch: 'x64' },
	'linux-arm64': { directory: 'linux-arm64-gnu', os: 'Linux', arch: 'ARM64' },
	'darwin-x64': { directory: 'darwin-x64', os: 'macOS', arch: 'x64' },
	'darwin-arm64': { directory: 'darwin-arm64', os: 'macOS', arch: 'ARM64' }
};

/** One row of the engine-platform table (diagnostics; see `enginePlatformTable`). */
export interface EnginePlatform {
	/** The `${platform}-${arch}` key of the editor this engine serves. */
	readonly key: string;
	/** The engine directory, matching what the CI matrix produces and what the VSIX ships. */
	readonly directory: string;
	/** Display name of the operating system. */
	readonly os: string;
	/** Display name of the architecture. */
	readonly arch: string;
	/** Shorthand display label (`os arch`). */
	readonly label: string;
	/** Is the binary actually present in this installation? */
	readonly present: boolean;
}

/**
 * Every platform a native engine exists for, with whether this installation actually contains the
 * binary — a diagnostics view of the package's contents. A missing binary is not an error: the
 * extension runs over the `git` CLI, and the Settings widget's backend section shows the split.
 */
export function enginePlatformTable(
	root: string = path.join(__dirname, '..', '..', '..', '..')
): ReadonlyArray<EnginePlatform> {
	return Object.keys(ENGINE_PLATFORMS).map((key) => {
		const platform = ENGINE_PLATFORMS[key];
		return {
			key,
			directory: platform.directory,
			os: platform.os,
			arch: platform.arch,
			label: `${platform.os} ${platform.arch}`,
			present: fs.existsSync(path.join(root, 'native', platform.directory, 'git-graph.node'))
		};
	});
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
	const engine = ENGINE_PLATFORMS[key];
	if (engine === undefined) {
		throw new GitBackendError('Unsupported', `No native engine is built for ${key}`);
	}
	return engine.directory;
}

/** The `${platform}-${arch}` of the editor, the key the engine directories are listed by. */
export function platformKey(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch
): string {
	return `${platform}-${arch}`;
}

/**
 * Is there a native engine binary for this editor — a platform a binary is built for, with the
 * binary actually present? An incomplete package (a known platform whose binary is missing, e.g.
 * a VSIX built without one of the six targets) is reported the same way as an unknown platform:
 * both simply run over the `git` CLI backend for everything.
 */
export function hasEngineForPlatform(root: string = path.join(__dirname, '..', '..', '..', '..')): boolean {
	try {
		platformDirectory();
	} catch {
		return false;
	}
	return candidatePaths(root).some((candidate) => fs.existsSync(candidate));
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
export function loadAddon(root: string = path.join(__dirname, '..', '..', '..', '..')): NativeAddon {
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
 * The engine's wire error kinds (camelCase, generated with the protocol) mapped to the backend's
 * PascalCase ones. `internal` — the engine caught one of its own panics at the protocol boundary
 * — is folded into `Unsupported`, the "let another backend try" kind, exactly as the engine's
 * error contract documents.
 */
const ERROR_KINDS: Readonly<Record<string, GitErrorKind>> = {
	notARepository: 'NotARepository',
	notFound: 'NotFound',
	invalidArgument: 'InvalidArgument',
	git: 'Git',
	io: 'Io',
	cancelled: 'Cancelled',
	unsupported: 'Unsupported',
	internal: 'Unsupported'
};

/**
 * Translate a failure into the backend's error contract. The engine answers in band, as the
 * structured `{kind, message}` object `EngineError` describes; a thrown value can only come from
 * the Node layer around it (a load failure, an aborted call) and is reported as a plain Git
 * failure — there is no `"Kind: "` prefix to parse any more.
 */
export function toBackendError(error: unknown): GitBackendError {
	if (error instanceof GitBackendError) return error;
	if (isEngineError(error)) {
		return new GitBackendError(ERROR_KINDS[error.kind] ?? 'Git', error.message);
	}
	return new GitBackendError('Git', errorMessage(error));
}

function isEngineError(error: unknown): error is EngineError {
	return (
		typeof error === 'object' &&
		error !== null &&
		typeof (error as EngineError).kind === 'string' &&
		typeof (error as EngineError).message === 'string'
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * How a call reaches the addon. `requestId` names the request for `cancel` (task 2.9);
 * `load` substitutes the binary loader, so tests can drive the adapter against a fake addon —
 * the seam is injectable rather than mocked at the `require` of the `.node` binary.
 */
export interface AddonCallOptions {
	/** Register the in-flight request under this id, cancellable via {@link cancel}. */
	requestId?: number;
	/** The loader that yields the addon; defaults to the binary loader of {@link loadAddon}. */
	load?: () => NativeAddon;
}

/**
 * Cancel the request registered under `requestId` (task 2.9): the engine's long-running loops
 * unwind with the structured `cancelled` error. Safe at any time — before the request reaches
 * the engine (the cancellation is remembered), while it runs, and after it finished (a no-op for
 * that request). Unknown ids affect no other request.
 */
export function cancel(requestId: number, root?: string, options?: AddonCallOptions): void {
	(options?.load !== undefined ? options.load() : loadAddon(root)).cancel(requestId);
}

/**
 * One engine request through the single seam: `request(repo, 'loadCommits', options)` answers
 * the method's typed result, or throws a `GitBackendError` built from the envelope's structured
 * error. The method name, its parameters and its result are all typed by the generated protocol,
 * so the two sides cannot quietly disagree.
 */
export async function request<M extends EngineMethod>(
	repo: string,
	method: M,
	params: EngineMethods[M]['params'],
	root?: string,
	options?: AddonCallOptions
): Promise<EngineMethods[M]['result']> {
	let raw: string;
	try {
		const addon = options?.load !== undefined ? options.load() : loadAddon(root);
		raw = await addon.request(repo, JSON.stringify({ method, params }), options?.requestId);
	} catch (error) {
		throw toBackendError(error);
	}
	let answer: unknown;
	try {
		answer = JSON.parse(raw);
	} catch (error) {
		throw new GitBackendError('Git', `The engine returned a malformed response: ${errorMessage(error)}`);
	}
	const failure = (answer as { error?: unknown }).error;
	if (isEngineError(failure)) {
		throw toBackendError(failure);
	}
	return (answer as { ok: EngineMethods[M]['result'] }).ok;
}

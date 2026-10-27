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
 * The exports of `native/node/src/lib.rs`, as N-API presents them: seven functions, no more.
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
	/**
	 * Cancel the request registered under `requestId` (task 2.9): it answers the structured
	 * `cancelled` error at its next checkpoint. Unknown and already-finished ids are no-ops, but
	 * a cancellation ahead of a request that later runs under the same id is honored.
	 */
	cancel(requestId: number): void;
}

/**
 * The prebuilt engines the extension can ship, keyed by the {@link platformKey} that selects
 * them. Linux is one key per libc (`linux-x64-gnu`, `linux-x64-musl`, ...) plus the armhf
 * engine (`linux-armhf`, gnueabihf-linked — no musl engine is built for armv7); win32 and
 * darwin keep the bare `${platform}-${arch}` keys they always had. The directory names are
 * what `scripts/build-addon.mjs` produces and what the CI matrix (`native-build.yml`) and the
 * VSIX ship.
 */
const ENGINE_PLATFORMS: Readonly<Record<string, { directory: string; os: string; arch: string; label?: string }>> = {
	'win32-x64': { directory: 'win32-x64-msvc', os: 'Windows', arch: 'x64' },
	'win32-arm64': { directory: 'win32-arm64-msvc', os: 'Windows', arch: 'ARM64' },
	'linux-x64-gnu': { directory: 'linux-x64-gnu', os: 'Linux', arch: 'x64', label: 'Linux x64 (glibc)' },
	'linux-x64-musl': { directory: 'linux-x64-musl', os: 'Linux', arch: 'x64', label: 'Linux x64 (musl)' },
	'linux-arm64-gnu': { directory: 'linux-arm64-gnu', os: 'Linux', arch: 'ARM64', label: 'Linux ARM64 (glibc)' },
	'linux-arm64-musl': { directory: 'linux-arm64-musl', os: 'Linux', arch: 'ARM64', label: 'Linux ARM64 (musl)' },
	'linux-armhf': { directory: 'linux-armhf', os: 'Linux', arch: 'ARMv7', label: 'Linux ARMv7 (gnueabihf)' },
	'darwin-x64': { directory: 'darwin-x64', os: 'macOS', arch: 'x64' },
	'darwin-arm64': { directory: 'darwin-arm64', os: 'macOS', arch: 'ARM64' }
};

/**
 * The glibc version the runtime reports for its own libc (`process.report`'s header), or null
 * when the runtime cannot say. Null covers three cases at once: a Node without diagnostic
 * reports (the VS Code 1.38 floor's Node 10.11 predates them, which offer the report from Node
 * 12.11 on), a musl host (musl builds leave `glibcVersion` out of the report header), and
 * every non-Linux platform, where the question does not apply. The header is read
 * structurally because the typings of the editor floor predate the field.
 *
 * Purely a property read — no spawn, no filesystem access: detection must stay free on the
 * activation path.
 */
export function reportedGlibcVersion(report: unknown = process.report): string | null {
	if (typeof report !== 'object' || report === null) return null;
	const header = (report as { header?: unknown }).header;
	if (typeof header !== 'object' || header === null) return null;
	const version = (header as { glibcVersion?: unknown }).glibcVersion;
	return typeof version === 'string' && version.length > 0 ? version : null;
}

/**
 * The engine directories that can serve this editor, best match first — the order
 * {@link loadAddon} tries them in, which is what makes the libc choice a *fallback order*
 * rather than a guess: when the better-matching binary is missing from the package or refuses
 * to load, the next one still gets its chance before the `git` CLI takes over.
 *
 * - A reported glibc version means a glibc host: the `-gnu` engine built for it (floor 2.17,
 *   ADR 0002) leads, and the libc-static `-musl` engine — which loads on a glibc host too —
 *   is the fallback.
 * - No report (the floor's old Node): musl leads. The musl builds carry their libc
 *   statically, so the musl binary loads on a glibc host as well as a musl one — the primary
 *   candidate is the one binary that cannot be wrong about a libc the runtime could not name.
 *   Leading with `-gnu` instead would hand the rarest host in the matrix (a musl one) a
 *   binary that cannot load there, for no gain on the common hosts.
 * - `arm` (armv7): only the gnueabihf engine exists — there is no musl twin to fall back to,
 *   so a failed load falls through to the local cargo build and then the CLI, as before.
 */
export function engineDirectories(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	glibcVersion: string | null = reportedGlibcVersion()
): string[] {
	if (platform !== 'linux') {
		const engine = ENGINE_PLATFORMS[`${platform}-${arch}`];
		return engine === undefined ? [] : [engine.directory];
	}
	if (arch === 'arm') return [ENGINE_PLATFORMS['linux-armhf'].directory];
	const preferred = glibcVersion !== null ? 'gnu' : 'musl';
	const fallback = preferred === 'gnu' ? 'musl' : 'gnu';
	return [`linux-${arch}-${preferred}`, `linux-${arch}-${fallback}`];
}

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
			label: platform.label ?? `${platform.os} ${platform.arch}`,
			present: fs.existsSync(path.join(root, 'native', platform.directory, 'git-graph.node'))
		};
	});
}

/**
 * The directory name of the prebuilt binary for this platform — the *first* entry of
 * {@link engineDirectories}, matching what the CI matrix produces and what the VSIX ships.
 */
export function platformDirectory(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	glibcVersion: string | null = reportedGlibcVersion()
): string {
	const key = platformKey(platform, arch, glibcVersion);
	const engine = ENGINE_PLATFORMS[key];
	if (engine === undefined) {
		throw new GitBackendError('Unsupported', `No native engine is built for ${key}`);
	}
	return engine.directory;
}

/**
 * The `${platform}-${arch}` of the editor, the key the engine directories are listed by —
 * suffixed with the libc on Linux (`linux-x64-gnu`), because the two Linux builds of one
 * architecture are different engines. It names the engine this editor would load first, so on
 * a runtime that cannot report its libc the musl key is returned on purpose: the same
 * preference {@link engineDirectories} orders its candidates by.
 */
export function platformKey(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	glibcVersion: string | null = reportedGlibcVersion()
): string {
	if (platform === 'linux') {
		if (arch === 'arm') return 'linux-armhf';
		return `linux-${arch}-${glibcVersion !== null ? 'gnu' : 'musl'}`;
	}
	return `${platform}-${arch}`;
}

/**
 * Is there a native engine binary for this editor — a platform a binary is built for, with at
 * least one matching binary actually present (either libc twin of a Linux engine counts, as
 * does a local cargo build)? An incomplete package (known platforms whose binaries are all
 * missing, e.g. a VSIX built without one of the targets) is reported the same way as an
 * unknown platform: both simply run over the `git` CLI backend for everything.
 */
export function hasEngineForPlatform(root: string = path.join(__dirname, '..', '..', '..', '..')): boolean {
	try {
		platformDirectory();
	} catch {
		return false;
	}
	return candidatePaths(root).some((candidate) => fs.existsSync(candidate));
}

/** Where the addon might be: every shipped engine that matches, then the local build outputs. */
function candidatePaths(root: string): string[] {
	return [
		...engineDirectories().map((directory) => path.join(root, 'native', directory, 'git-graph.node')),
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
 * The candidates of {@link engineDirectories} are tried in order, so a glibc host whose
 * `-gnu` binary is missing from the package (or refuses to load) still gets the libc-static
 * `-musl` one, and the local cargo builds stand in on a developer machine. The failure of the
 * whole search is remembered: a missing binary will not start working on a retry, and the
 * caller (which falls back to the `git` CLI) would otherwise pay the filesystem probe on
 * every request.
 */
export function loadAddon(root: string = path.join(__dirname, '..', '..', '..', '..')): NativeAddon {
	if (cached !== null) return cached;
	if (loadFailure !== null) throw loadFailure;

	const candidates = candidatePaths(root);
	let broken: GitBackendError | null = null;
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			cached = require(candidate) as NativeAddon;
			return cached;
		} catch (error) {
			// A binary that is present but will not load does not end the search: the next
			// candidate may be the twin that does (the gnu/musl pair, or a local cargo build).
			// The first candidate's failure is the diagnostic worth reporting — the primary
			// engine is the one built for this platform, so if nothing loads, it is its
			// failure the `git` CLI fallback should name.
			broken ??= new GitBackendError(
				'Unsupported',
				`The native engine at ${candidate} could not be loaded: ${errorMessage(error)}`
			);
		}
	}

	loadFailure = broken ?? new GitBackendError(
		'Unsupported',
		`No native engine was found for ${platformKey()}. Looked in:\n  ${candidates.join('\n  ')}`
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

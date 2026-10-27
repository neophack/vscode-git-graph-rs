/**
 * The Workspace Trust gate (the manifest declares `untrustedWorkspaces` supported
 * "limited"). While the workspace is untrusted ("Restricted Mode") the extension serves reads
 * from the Rust engine alone and disables everything that would run the `git` CLI — running Git
 * in an untrusted folder is a real code-execution vector (`core.fsmonitor`, `core.sshCommand`,
 * hooks, `diff.external`), while the in-process engine reads execute no repository-configured
 * programs.
 *
 * The trust surface itself is feature-detected through `vscodeCompat` (VS Code 1.56+); on older
 * editors the gate is permanently `trusted`, which is exactly those editors' behaviour.
 */

import { workspaceTrust } from './vscodeCompat';

/** The read side of the trust gate every restricted-mode decision goes through. */
export interface TrustGate {
	/** FALSE only while the workspace is untrusted on an editor that supports Workspace Trust. */
	isTrusted: boolean;
	/** Subscribe to trust transitions; the listener re-reads {@link TrustGate.isTrusted}. */
	onChange(listener: () => void): { dispose(): void };
}

/**
 * Build the Workspace Trust gate over the feature-detected API. Absent the API (VS Code < 1.56,
 * test stubs), the gate answers trusted and never fires — the pre-1.56 behaviour.
 */
export function createTrustGate(): TrustGate {
	const trust = workspaceTrust();
	if (trust === null) {
		return {
			isTrusted: true,
			onChange: () => ({ dispose(): void { /* no trust transitions without the API */ } })
		};
	}
	return {
		get isTrusted(): boolean {
			return trust.isTrusted;
		},
		onChange: (listener: () => void) => trust.onDidChangeWorkspaceTrust(listener)
	};
}

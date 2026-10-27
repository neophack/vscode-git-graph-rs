import { ConfigSnapshot } from './schema';
import { ObservableWorkspaceLike, onConfigChange, takeSnapshot } from './snapshot';

/**
 * The read side the long-lived consumers hold: the latest snapshot of the extension settings,
 * kept current by one subscription. Services constructed in the
 * composition root take this instead of re-reading `vscode.workspace.getConfiguration` per
 * operation; per-request consumers (the graph view handlers) receive the snapshot itself as a
 * parameter. The snapshot replaces itself wholesale on every relevant change, so a consumer
 * reading `.current` always sees one internally consistent reading.
 */
export interface ConfigProvider {
	/** The latest snapshot (replaced wholesale on every relevant configuration change). */
	readonly current: ConfigSnapshot;
}

export class ConfigService implements ConfigProvider {
	private snapshot: ConfigSnapshot;
	private readonly unsubscribe: () => void;

	/**
	 * Take the first snapshot and subscribe to the section's changes.
	 * @param workspace A workspace-like object that also reports configuration changes
	 * (`vscode.workspace` satisfies this structurally).
	 */
	constructor(workspace: ObservableWorkspaceLike) {
		this.snapshot = takeSnapshot(workspace);
		this.unsubscribe = onConfigChange(workspace, (snapshot) => { this.snapshot = snapshot; });
	}

	get current(): ConfigSnapshot {
		return this.snapshot;
	}

	/** Stop following the configuration changes (the composition root's disposal). */
	dispose(): void {
		this.unsubscribe();
	}
}

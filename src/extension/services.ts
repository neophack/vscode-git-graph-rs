import type * as vscode from 'vscode';
import type { GgEvent } from '../shared/util/event';
import type { ProductionGitRepository } from './git/gitRepository';
import type { GitBackend } from './git/read/backendIndex';
import type { GitResolutionHandle } from './git/executable/gitResolution';
import type { AuxiliaryViewsPort, GitRunnerPort } from './graphView/gitRunner';
import type { AvatarManager } from './integrations/avatars/avatarManager';
import type { GerritDataSource } from './integrations/gerrit/gerrit';
import type { ConfigService } from './platform/config';
import type { Logger } from './platform/logger';
import type { ExtensionState } from './platform/storage';
import type { RepoManager } from './repos/repoManager';

/**
 * The extension's services, composed exactly once in the composition root (`main.ts`) as one
 * frozen object (OPTIMIZATION-PLAN A2). Everything constructed downstream of the git layer —
 * the command manager, the panel registry and the Git Graph view, the prewarm controller —
 * takes this one parameter (plus its own immediate arguments), so no wiring position list can
 * drift out of order and no consumer can reach a collaborator it was not handed.
 *
 * The bag holds only what outlives construction. The members that are themselves bag members
 * (`avatars`, `repos`) are built BEFORE the freeze with their own explicit dependency lists —
 * a member cannot take the bag it belongs to — and everything built after the freeze takes the
 * whole bag. The bag is frozen: no service can swap a collaborator under another one.
 */
export interface ExtensionServices {
	/** The editor context the extension was activated with (subscriptions, paths, state). */
	readonly context: vscode.ExtensionContext;
	/** The extension's log (the session log file and its Output Channel). */
	readonly logger: Logger;
	/** The persisted state (global/workspace mementos, the avatar and repo caches). */
	readonly state: ExtensionState;
	/** The repository facade: reads on `.read`, writes through the GitWriter, operation state. */
	readonly repo: ProductionGitRepository;
	/** The read backend, following the current Git executable and trust state (the swappable). */
	readonly reader: GitBackend;
	/** The raw Git runner over the same process adapter the writer spawns through. */
	readonly git: GitRunnerPort;
	/** The avatar fetcher and cache. */
	readonly avatars: AvatarManager;
	/** The repository manager (discovery, the known-repo set, the recent list). */
	readonly repos: RepoManager;
	/** The two auxiliary webviews (the commit comparison and the binary compare view). */
	readonly auxViews: AuxiliaryViewsPort;
	/** The Gerrit integration the gerrit commands run over the shared runner. */
	readonly gerrit: GerritDataSource;
	/** The deferred Git resolution (V1): `current()`, `ready()` and `restricted()`. */
	readonly gitResolution: GitResolutionHandle;
	/** The configuration service: the latest settings snapshot, following setting changes. */
	readonly config: ConfigService;
	/** The configuration-change event of the `git-graph-rs.*` settings. */
	readonly onDidChangeConfiguration: GgEvent<vscode.ConfigurationChangeEvent>;
}

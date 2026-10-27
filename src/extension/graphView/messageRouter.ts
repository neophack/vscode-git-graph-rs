import { deliverAutomationShimResult } from '../automation/graphViewPort';
import { squashMessageFormatOf } from '../platform/config';
import type { ConfigProvider } from '../platform/config';
import { t } from '../platform/i18n';
import { TextMessageKey } from '../../shared/i18n';
import type { Logger } from '../platform/logger';
import type { ProductionGitRepository } from '../git/gitRepository';
import type { RequestCommand, WriteEffect } from '../../shared/protocol/graphView';
import { WRITE_EFFECTS } from '../../shared/protocol/graphView';
import type { RequestWebviewTraces, ResponseMessage } from '../../shared/protocol/messages';
import { mergeWebviewMarks, span } from '../../shared/perf/trace';
import { showErrorMessage } from '../platform/actions';
import type { CommitDataPort, CommitLoader } from './commitLoader';
import type { ImpactRefreshDeps } from './impactRefresh';
import { refreshAfterWrite } from './impactRefresh';
import { dispatchRequest, isMutatingCommand } from './handlers/index';
import type { HandlerContext, ViewPort } from './handlers/context';
import { hostScheduler } from './scheduler';
import type { GitRunnerPort } from './gitRunner';
import type { PanelPorts, PanelRefreshIds } from './panelContext';

/**
 * The MessageRouter of the Git Graph view (OPTIMIZATION-PLAN A5, extracted from GitGraphView):
 * everything one inbound webview message passes through — the pre-dispatch routing of the two
 * non-request page messages (automation shim results, the P1 trace report), the inbound
 * validation and dispatch through the exhaustive handler table (handlers/index.ts's
 * dispatchRequest rejects unknown `command`s; an unknown `repo` path reaches the genuine
 * handler, whose write chain refuses or fails it — the guarantee the fuzz suite pins), the
 * RepoFileWatcher mute window around a dispatch, the write-effect collection the GitWriter
 * reports into while a request runs, and the ONE impact-based refresh that follows a mutating
 * command (task 4.8). The panel (panel.ts) owns the webview panel this routes for.
 */

/** The write-path localizer: the ports speak plain string keys, the i18n table's own keys are what they carry. */
function localizeWriteKey(key: string, ...params: Array<string | number>): string {
	return t(key as TextMessageKey, ...params);
}

/**
 * The dispatched requests the P1 op spans measure (OPTIMIZATION-PLAN §7 P1, the "if cheap" row):
 * load-more (`loadCommits`), expand-details (`commitDetails`), and the refs/HEAD repo-info op
 * (`loadRepoInfo`). Every other dispatched request starts no span.
 */
const OP_TRACE_COMMANDS: ReadonlySet<string> = new Set(['loadCommits', 'commitDetails', 'loadRepoInfo']);

/** The collaborators the router dispatches against (everything the Panel owns, injected). */
export interface MessageRouterDeps {
	/** The repository facade: reads for the context, the writer's repository-changed events for the effect collection. */
	readonly repo: ProductionGitRepository;
	/** The raw Git runner over the same GitProcess the writer runs on. */
	readonly git: GitRunnerPort;
	/** The configuration service (the latest snapshot, taken once at the start of each request). */
	readonly config: ConfigProvider;
	/** The Panel's port implementations the assembled HandlerContext runs on. */
	readonly ports: PanelPorts;
	/** The Panel's view-state hooks (the context's `view` port). */
	readonly viewPort: ViewPort;
	/** The staged commit loader (the context's `loader` port). */
	readonly loader: CommitLoader;
	/** The loader's reads port, shared with the write-path impact refresh (task 4.8). */
	readonly loaderReads: CommitDataPort;
	/** The refresh ids the staged requests record and the regenerated page embeds. */
	readonly refreshIds: PanelRefreshIds;
	/** The repo file watcher: muted for the whole duration of every dispatched request. */
	readonly watcher: { mute(): void; unmute(): void };
	readonly logger: Logger;
	/** The repository the view currently shows (the impact refresh serves only it). */
	currentRepo(): string | null;
	/** The Panel's single exit point to the webview. */
	send(msg: ResponseMessage): void;
}

/** The router the panel keeps: the two message entries and the effect collection's subscription. */
export interface MessageRouter {
	/**
	 * The webview's `onDidReceiveMessage` entry: routes the automation shim's results and the
	 * P1 trace report to their own consumers, then dispatches everything else.
	 */
	onWebviewMessage(msg: unknown): void;
	/**
	 * Dispatch one request as if the webview had sent it (the dispatch path the automation
	 * hook injects into, bypassing the page-message routing above).
	 */
	dispatch(msg: unknown): Promise<void>;
	/**
	 * The GitWriter repository-changed subscription the effect collection listens on; the panel
	 * registers it among its disposables.
	 */
	readonly effectCollection: { dispose(): void };
}

/**
 * Assemble the router. Pure wiring over {@link deps}: the only state is the write-effect
 * collection and the dispatch depth it is keyed to.
 */
export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
	/**
	 * The write effects the GitWriter reported while a request is being dispatched (task 4.8):
	 * the per-op truth the impact refresh prefers over the protocol's per-command table. Keyed by
	 * repository, cleared as each dispatched request's finally block consumes it.
	 */
	const observedEffects: Map<string, Set<WriteEffect>> = new Map();
	/** > 0 while a webview request is being dispatched: the window the writer's effects collect in. */
	let dispatchDepth = 0;

	/**
	 * The write-path impact collection (task 4.8): the GitWriter reports the effects of
	 * every op that ran while a request was being dispatched — the per-op truth the
	 * impact refresh prefers over the protocol's per-command table.
	 */
	const effectCollection = deps.repo.write.onRepositoryChanged((repoPath, effects) => {
		if (dispatchDepth === 0) return; // a write outside a dispatched request: the repo file watcher reports it
		const observed = observedEffects.get(repoPath);
		if (observed === undefined) observedEffects.set(repoPath, new Set(effects));
		else for (const effect of effects) observed.add(effect);
	});

	/** The HandlerContext one request runs with: the collaborators' ports and the send function. */
	const buildContext = (): HandlerContext => {
		const snapshot = deps.config.current;
		return {
			repo: deps.repo,
			git: deps.git,
			repoConfig: deps.ports.repoConfig,
			gerrit: deps.ports.gerrit,
			t: localizeWriteKey,
			config: {
				gerrit: { remote: snapshot.gerritRemote },
				showRemoteHeads: snapshot.repositoryShowRemoteHeads,
				squashPullMessageFormat: squashMessageFormatOf(snapshot.dialogPullBranchSquashMessageFormat),
				squashMergeMessageFormat: squashMessageFormatOf(snapshot.dialogMergeSquashMessageFormat)
			},
			ui: deps.ports.ui,
			loader: deps.loader,
			avatars: deps.ports.avatars,
			storage: deps.ports.storage,
			repos: deps.ports.repos,
			userConfig: deps.ports.userConfig,
			settings: deps.ports.settings,
			pullRequests: deps.ports.pullRequests,
			view: deps.viewPort,
			send: (msg) => deps.send(msg)
		};
	};

	/**
	 * The `config`-class partial update (task 4.8): drop the cached repository configuration and
	 * push one fresh `loadConfig` response under the refresh id the view last used — never a
	 * rejection: a failed read is logged and simply not pushed (the settings widget keeps its
	 * previous data, exactly as an unrequested failed load would).
	 */
	const pushConfigAfterWrite = async (repo: string, remotes: ReadonlyArray<string>): Promise<void> => {
		try {
			deps.ports.repoConfig.invalidate(repo);
			const data = await deps.ports.repoConfig.load(repo, remotes);
			deps.send({ command: 'loadConfig', repo: repo, refreshId: deps.refreshIds.loadConfig, config: data.config, error: data.error });
		} catch (error) {
			deps.logger.logError('Failed to push the configuration of ' + repo + ' after a write: ' + (error instanceof Error ? error.message : String(error)));
		}
	};

	/**
	 * Push the impact-based refresh of one completed write (task 4.8): the effects the GitWriter
	 * reported for the dispatched repository — the per-op truth, e.g. a plain `createBranch` is
	 * `refs` only — or, when none arrived, the protocol's per-command fallback. The impact
	 * refresh itself (impactRefresh.ts) picks the minimal partial update per §3.8.3.
	 */
	const refreshAfterWriteOf = (command: string, msg: unknown): void => {
		const repo = typeof msg === 'object' && msg !== null ? (msg as { repo?: unknown }).repo : undefined;
		if (typeof repo !== 'string' || repo !== deps.currentRepo()) return; // the view shows another (or no) repository
		const table = Object.prototype.hasOwnProperty.call(WRITE_EFFECTS, command) ? WRITE_EFFECTS[command as RequestCommand] : undefined;
		const observed = observedEffects.get(repo);
		observedEffects.delete(repo);
		let effects: ReadonlyArray<WriteEffect> | null;
		if (observed === undefined || observed.size === 0) {
			// No writer event (a refused write, a flow that ran outside the writer) or an op that
			// declares nothing: the per-command table's conservative union decides.
			effects = table ?? null;
		} else {
			effects = [...observed];
		}
		if (effects === null || effects.length === 0) return;
		const refreshDeps: ImpactRefreshDeps = {
			reads: deps.loaderReads,
			view: deps.loader,
			getConfig: () => ({ showRemoteHeads: deps.config.current.repositoryShowRemoteHeads }),
			logger: deps.logger,
			refreshIds: () => ({ loadRepoInfo: deps.refreshIds.loadRepoInfo, loadCommits: deps.refreshIds.loadCommits }),
			send: (message) => deps.send(message),
			pushConfig: (repoPath, remotes) => { void pushConfigAfterWrite(repoPath, remotes); }
		};
		// The impact read is what the user just acted on: interactive, so background work yields.
		void hostScheduler.run('refresh:' + repo, 'interactive', () => refreshAfterWrite(refreshDeps, repo, effects as ReadonlyArray<WriteEffect>));
	};

	/**
	 * Respond to a message sent from the front-end: route it through the exhaustive handler
	 * table with the RepoFileWatcher muted. When the command's handler can mutate the
	 * repository, the ONE refresh that follows is the impact-based partial update of task 4.8
	 * (see {@link refreshAfterWrite}) — picked from the effects the GitWriter reported for the
	 * dispatched request (the per-op truth) with the protocol's per-command table as the
	 * fallback (a refused write, or a flow that bypassed the writer).
	 * @param msg The message that was received.
	 */
	const respondToMessage = async (msg: unknown): Promise<void> => {
		const command = typeof msg === 'object' && msg !== null ? (msg as { command?: unknown }).command : undefined;
		const mutates = typeof command === 'string' && isMutatingCommand(command);
		// The P1 op spans: load-more, expand-details, and the refs/HEAD repo-info op, timed as
		// one dispatch each (the span ends when the handler's promise settles).
		const opSpan = typeof command === 'string' && OP_TRACE_COMMANDS.has(command) ? 'op:' + command : null;
		deps.watcher.mute();
		dispatchDepth++;
		try {
			const context = buildContext();
			const result = await (opSpan !== null ? span(opSpan, () => dispatchRequest(msg, context)) : dispatchRequest(msg, context));
			if (result === 'unknown') {
				// No handler exists for the command: say so in exactly one log line and surface an
				// error, instead of silently dropping the message (task 4.2). The protocol has no
				// generic error response a host could answer an unknown command with, so the error
				// shows as the localized action-handling notification.
				deps.logger.logError('Received an unknown "' + String(command) + '" message from the Git Graph View.');
				void showErrorMessage(t('actionHandlingError'));
			}
		} catch (error) {
			deps.logger.logError('Failed to handle "' + command + '" message: ' + error);
			void showErrorMessage(t('actionHandlingError'));
		} finally {
			dispatchDepth--;
			deps.watcher.unmute();
			if (mutates && typeof command === 'string') {
				// The handler ran with the RepoFileWatcher muted, so any repository change it made
				// bypassed the watcher-based invalidation — the pushed refresh below is the one
				// refresh of this operation (the webview does not also refresh itself).
				refreshAfterWriteOf(command, msg);
			}
		}
	};

	const onWebviewMessage = (msg: unknown): void => {
		// Results from the in-page automation shim are not RequestMessages: route them to the
		// port (which forwards to the installed listener, if any) and keep them away from the
		// handler table's command guard.
		if (typeof msg === 'object' && msg !== null
			&& (msg as { __ggAutomationResult?: unknown }).__ggAutomationResult !== undefined) {
			deliverAutomationShimResult((msg as { __ggAutomationResult: unknown }).__ggAutomationResult);
			return;
		}
		// The P1 trace report (OPTIMIZATION-PLAN §7 P1): the webview's collected marks arrive
		// once, after T5 - append them to the open trace and record it. Deliberately not a
		// handler-table request: no handler exists (or may exist) for it.
		if (typeof msg === 'object' && msg !== null
			&& (msg as { command?: unknown }).command === 'webviewTraces') {
			mergeWebviewMarks((msg as RequestWebviewTraces).marks);
			return;
		}
		void respondToMessage(msg);
	};

	return {
		onWebviewMessage: onWebviewMessage,
		dispatch: respondToMessage,
		effectCollection: effectCollection
	};
}

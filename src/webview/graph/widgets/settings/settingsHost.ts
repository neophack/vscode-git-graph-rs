/* The seam between the Settings Widget's shell (settingsWidget.ts) and its section modules: the
   host surface the sections read their live state through and register their render's listeners
   on, plus the one save action two of them share (the commit author identities are managed as a
   Global Setting but rendered in both columns, so their save must not live in either column's
   module - it would pull the two into a dependency cycle). */

import { strings } from '../../../common/i18n/index';
import * as GG from '../../../common/protocol';
import { GraphContext } from '../../context';

/**
 * The Settings Widget as a section module sees it (the shell implements it): the live view state
 * the sections render and act on, and the widget's own surface their wiring registers through.
 * Listeners registered here die with the render that created them - the shell clears the surface
 * store at the top of every render and on close - and the DOM lookups run under the widget's
 * element, never the document.
 */
export interface SettingsHost {
	/** The view's context. */
	readonly ctx: () => GraphContext;
	/** The repository the Settings Widget is open on (NULL while it is closed). */
	readonly currentRepo: string | null;
	/** The persisted state of the current repository, as the widget last refreshed it (NULL while it is closed). */
	readonly repo: Readonly<GG.GitRepoState> | null;
	/** The current repository's Git configuration - the commit authors and remotes (NULL until it loads). */
	readonly config: Readonly<GG.GitRepoConfig> | null;
	/** The element with the given id under the widget's rendered content, or NULL. */
	byId(id: string): HTMLElement | null;
	/** Register a listener on the widget's current render: the next render or close removes it. */
	listenOnSurface(target: EventTarget, event: string, listener: EventListener): void;
	/** Register a listener on every element of the current render carrying the class name. */
	listenToClassOnSurface(className: string, event: string, listener: EventListener): void;
	/** Re-render the widget's content (a section persisted a change the user must see). */
	rerender(): void;
	/** Close the widget (a repository tool opened from it takes its place). */
	close(): void;
}

/**
 * Save a Global Setting, and display the "Saving Setting" action running state while it is saved.
 * @param ctx The view's context.
 * @param setting The key of the setting, relative to the `git-graph-rs` section.
 * @param value The new value of the setting.
 * @param previousValue What the widget last rendered for the setting, when the host needs
 * what the user saw rather than its own (possibly lagging) configuration read.
 */
export function saveGlobalSetting(ctx: GraphContext, setting: string, value: GG.GlobalSettingValue, previousValue?: GG.GlobalSettingValue) {
	ctx.actions.run({ command: 'setGlobalSetting', setting: setting, value: value, previousValue: previousValue }, strings.settingsSavingSetting);
}

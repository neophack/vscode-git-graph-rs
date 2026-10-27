/* The Repository Tools section of the Settings Widget's Repository column: the entries that
   open the Reflog and Worktrees overlays. They act on the repository open in the view, so they
   live in the Repository column and follow the same button style as the other section action
   buttons. (Statistics lives in the toolbar instead, between the path filter and the terminal
   buttons.) */

import { html, SafeHtml } from '../../../common/html';
import { strings } from '../../../common/i18n/index';
import { SVG_ICONS } from '../../../common/icons';
import type { SettingsHost } from './settingsHost';

/** Render the Repository Tools section: the entries of the Reflog / Worktrees overlays. */
export function renderToolsSection(): SafeHtml {
	return html`<div class="settingsSection"><h3>${strings.settingsSectionTools}</h3><div class="settingsSectionButtons"><div id="openReflogView" class="toolBtn">${SVG_ICONS.commit}${strings.settingsOpenReflog}</div><div id="openWorktreeDialog" class="toolBtn">${SVG_ICONS.package}${strings.settingsOpenWorktrees}</div></div></div>`;
}

/** Wire the Repository Tools entries of the Repository column. */
export function wireToolsSection(host: SettingsHost) {
	const ctx = host.ctx();

	// The Repository Tools open as overlays over the view: close the Settings Widget first,
	// so the tool slides down in its place instead of the two overlays stacking
	host.listenOnSurface(host.byId('openReflogView')!, 'click', () => openRepositoryTool(host, ctx.widgets.reflog));
	host.listenOnSurface(host.byId('openWorktreeDialog')!, 'click', () => openRepositoryTool(host, ctx.widgets.worktree));
}

/**
 * Open one of the Repository Tools (the Reflog or Worktrees overlay) from the Settings Widget:
 * the Settings Widget is closed first, so the tool takes its place instead of the two overlays
 * stacking on top of each other.
 */
function openRepositoryTool(host: SettingsHost, tool: { show(): void }) {
	if (host.currentRepo === null) return;
	host.close();
	tool.show();
}

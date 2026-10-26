/**
 * Applying a changed Extension Configuration to the running view (the `configChanged` message):
 * everything the generated HTML would have baked in is re-applied in place — the body classes
 * and CSS variables, the sticky header, the fetch button's title, the dropdowns whose options
 * derive from the configuration — followed by a soft reload of the commits under the new
 * settings, so the page keeps its rendered content, scroll position and open Commit Details View
 * instead of being regenerated (which flashed the whole view).
 */

import { alterClass } from '../../common/dom';
import { strings } from '../../common/i18n/index';
import * as GG from '../../common/protocol';
import { getRepoDropdownOptions } from '../controlBar/controlBar';
import { GraphContext } from '../context';

const CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH = 'branchLabelsAlignedToGraph';
const CLASS_TAG_LABELS_RIGHT_ALIGNED = 'tagLabelsRightAligned';

export class ConfigApplier {
	constructor(private readonly ctx: () => GraphContext, private readonly refresh: (hard: boolean) => void) { }

	/**
	 * Apply the new configuration, then reload the commits (the extension host dropped its commit
	 * cache for the change): a soft refresh, answered with the complete data in one response, so
	 * the view updates in place.
	 */
	public apply(config: GG.GitGraphViewConfig): void {
		const ctx = this.ctx(), store = ctx.store;
		const previousColours = store.config.graph.colours.length;
		store.setConfig(config);
		ctx.persistence.saveState();

		// What start-up applies from the configuration
		alterClass(document.body, CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH, config.referenceLabels.branchLabelsAlignedToGraph);
		alterClass(document.body, CLASS_TAG_LABELS_RIGHT_ALIGNED, config.referenceLabels.tagLabelsOnRight);
		document.body.style.setProperty('--git-graph-fontSize', config.graph.fontSize + 'px');
		// A fresh configuration carries the configured grid: re-apply the mobile row pitch over it
		if (ctx.layout.isMobileLayout()) ctx.layout.resetGraphRowGrid();
		document.body.style.setProperty('--git-graph-rowHeight', ctx.layout.getRowHeight() + 'px');
		for (let i = 0; i < config.graph.colours.length; i++) {
			document.body.style.setProperty('--git-graph-color' + i, config.graph.colours[i]);
		}
		for (let i = config.graph.colours.length; i < previousColours; i++) {
			document.body.style.removeProperty('--git-graph-color' + i);
		}
		alterClass(ctx.dom.headerRow, 'sticky', config.stickyHeader);
		document.getElementById('fetchBtn')!.title = config.fetchAndPrune ? strings.fetchAndPruneTitle : strings.fetchTitle;

		// The repo state defaults derive from the configuration, and the dropdowns carry
		// configuration-derived options (glob patterns, repository order)
		if (store.repoState !== undefined) {
			ctx.controls.syncShowRemoteBranches();
		}
		ctx.controls.repoDropdown.setOptions(getRepoDropdownOptions(store.repos, config.repoDropdownOrder), [store.currentRepo]);
		ctx.controls.branchDropdown.setOptions(store.getBranchOptions(true), store.currentBranches);
		ctx.widgets.settings.refresh();

		// Settings that shape the rendered output but not the commit data (graph style, date
		// format, column visibility, ...) would otherwise wait for the next render: run one now.
		// It reconciles, so unchanged rows keep their DOM nodes and the viewport its position -
		// and it coalesces onto the next frame with anything else this config change requested.
		store.invalidateRender();

		this.refresh(false);
	}
}

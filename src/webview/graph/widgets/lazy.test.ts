// @vitest-environment jsdom
/**
 * The lazy facades of the on-demand widgets (REFACTOR-PLAN task 5.9): before a widget's module
 * has loaded it simply does not exist - not open, nothing to close or refresh, no response to
 * deliver - and show() is what loads the module through dynamic import() and opens the real
 * widget. The Settings widget additionally stashes the state restored for it at boot, so the
 * persisted state survives until the module actually loads.
 */

import { describe, expect, it } from 'vitest';

import type * as GG from '../../common/protocol';
import type { GraphContext } from '../context';
import { LazySettingsWidget, LazyStatisticsView } from './lazy';

interface SentMessage {
	readonly command: string;
	readonly [field: string]: unknown;
}

/** The minimal context the Statistics widget touches on show(). */
function fakeContext(): { ctx: GraphContext; sent: SentMessage[] } {
	const sent: SentMessage[] = [];
	const ctx = {
		store: { currentRepo: '/repo' },
		bridge: { send: (message: SentMessage) => { sent.push(message); } }
	};
	return { ctx: ctx as unknown as GraphContext, sent: sent };
}

/** Await until the facade's dynamic import chain (module evaluation + construction + the show call) settled - a cold module transform can take a moment in the test environment. */
async function waitFor(ready: () => boolean) {
	for (let attempt = 0; attempt < 200 && !ready(); attempt++) {
		await new Promise((resolve) => { setTimeout(resolve, 5); });
	}
}

describe('lazy on-demand widgets (task 5.9)', () => {
	it('a not-yet-loaded widget answers the not-open semantics and drops its responses', () => {
		const { ctx } = fakeContext();
		const view = new LazyStatisticsView(() => ctx);

		expect(view.isVisible()).toBe(false);
		view.close(); // a no-op: nothing is open
		view.processResponse({} as GG.ResponseRepoStatistics); // dropped: never requested
		expect(view.isVisible()).toBe(false);
	});

	it('show() loads the on-demand module and opens the real widget', async () => {
		const { ctx, sent } = fakeContext();
		const view = new LazyStatisticsView(() => ctx);

		view.show();
		await waitFor(() => view.isVisible());

		expect(view.isVisible()).toBe(true);
		expect(sent.map((message) => message.command)).toContain('repoStatistics');
		view.close();
		expect(view.isVisible()).toBe(false);
	});

	it('the settings facade stashes its restored state before the module loads and reports it untouched', () => {
		const { ctx } = fakeContext();
		const settings = new LazySettingsWidget(() => ctx);
		const state = { currentRepo: '/repo', scrollTop: 5, repoColumnScrollTop: 1, globalColumnScrollTop: 2 };

		settings.restoreState(state);
		expect(settings.getState()).toEqual(state);
		expect(settings.isVisible()).toBe(false);
		settings.refresh();
		settings.close(); // no-ops: nothing constructed, nothing thrown
		expect(settings.getState()).toEqual(state);
	});

	it('reports the default settings state when nothing was restored', () => {
		const { ctx } = fakeContext();
		const settings = new LazySettingsWidget(() => ctx);
		expect(settings.getState()).toEqual({ currentRepo: null, scrollTop: 0, repoColumnScrollTop: 0, globalColumnScrollTop: 0 });
	});
});

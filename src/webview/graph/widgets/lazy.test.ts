// @vitest-environment jsdom
/**
 * The lazy facades of the on-demand widgets: before a widget's module
 * has loaded it simply does not exist - not open, nothing to close or refresh, no response to
 * deliver - and show() is what loads the module through dynamic import() and opens the real
 * widget. The Settings widget additionally stashes the state restored for it at boot, so the
 * persisted state survives until the module actually loads.
 */

import { describe, expect, it } from 'vitest';

import type * as GG from '../../common/protocol';
import type { CommitDetailsSurface } from '../commitDetails/detailsSurface';
import type { GraphContext } from '../context';
import type { SettingsWidgetState } from '../state/types';
import type { SettingsWidgetSurface, StatisticsViewSurface } from './surfaces';
import { LazyCommitDetails, LazySettingsWidget, LazyStatisticsView, LazyWidget } from './lazy';

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

describe('lazy on-demand widgets', () => {
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
		const state = { currentRepo: null, scrollTop: 5, repoColumnScrollTop: 1, globalColumnScrollTop: 2 };

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

	it('a restored state that left the settings widget OPEN reopens it through the module load', () => {
		const { ctx } = fakeContext();
		let reopen: ((widget: SettingsWidgetSurface) => void) | null = null;
		// The load seam stands in for the dynamic import: the captured call is what the module
		// would receive once it has settled, and a state that left the widget open must reach it.
		class ReopenProbe extends LazySettingsWidget {
			protected override ensureAndCall(call: (widget: SettingsWidgetSurface) => void): void {
				reopen = call;
			}
		}
		const settings = new ReopenProbe(() => ctx);

		settings.restoreState({ currentRepo: '/repo', scrollTop: 5, repoColumnScrollTop: 1, globalColumnScrollTop: 2 });
		expect(reopen).not.toBeNull(); // the reopen is the first use: it triggers the load

		const restored: Array<{ currentRepo: string | null }> = [];
		reopen!({ restoreState: (state: SettingsWidgetState) => restored.push(state) } as unknown as SettingsWidgetSurface);
		expect(restored[0].currentRepo).toBe('/repo');
	});
});

describe('the lazy Commit Details View', () => {
	/** A probe that captures the call the settled module would receive, without importing it. */
	class LoadProbe extends LazyCommitDetails {
		public settled: Array<(widget: CommitDetailsSurface) => void> = [];
		protected override ensureAndCall(call: (widget: CommitDetailsSurface) => void): void {
			this.settled.push(call);
		}
	}

	/** A row element as the commit table renders them (its `data-id` is the page index). */
	function rowElem(id: number): HTMLElement {
		const elem = document.createElement('tr');
		elem.dataset.id = String(id);
		return elem;
	}

	/**
	 * The context of the race the facade guards: the clicked row (`clicked`) resolves to the
	 * commit, a re-render rebuilt it as `rebuilt` (same index, NEW element - the clicked one is
	 * now detached), and the table resolves the live row for a commit by its hash.
	 */
	function raceParts(clicked: HTMLElement, rebuilt: HTMLElement) {
		const store: {
			getCommitOfElem: (elem: HTMLElement) => { hash: string } | null;
			getCommitId: (hash: string) => number | null;
		} = {
			getCommitOfElem: (elem: HTMLElement) => (elem === clicked ? { hash: 'abc' } : null),
			getCommitId: (hash: string) => (hash === 'abc' ? 5 : null)
		};
		const table: { findCommitElem: (id: number | null) => HTMLElement | null } = {
			findCommitElem: (id: number | null) => (id === 5 ? rebuilt : null)
		};
		return { store: store, table: table, context: { store: store, table: table } as unknown as GraphContext };
	}

	it('the first load re-resolves the clicked row after the module settles - a re-render in the window may have rebuilt it', () => {
		const clicked = rowElem(5), rebuilt = rowElem(5);
		const parts = raceParts(clicked, rebuilt);
		const view = new LoadProbe(() => parts.context);

		view.load(clicked);
		expect(view.settled.length).toBe(1);

		const opened: HTMLElement[] = [];
		view.settled[0]({ load: (elem: HTMLElement) => { opened.push(elem); } } as unknown as CommitDetailsSurface);
		expect(opened).toEqual([rebuilt]); // NOT the detached element the click captured
	});

	it('a comparison re-resolves both rows the same way', () => {
		const clicked = rowElem(5), rebuilt = rowElem(5), clickedCmp = rowElem(7), rebuiltCmp = rowElem(7);
		const parts = raceParts(clicked, rebuilt);
		parts.store.getCommitOfElem = (elem: HTMLElement) => (elem === clicked ? { hash: 'abc' } : elem === clickedCmp ? { hash: 'def' } : null);
		parts.store.getCommitId = (hash: string) => (hash === 'abc' ? 5 : hash === 'def' ? 7 : null);
		parts.table.findCommitElem = (id: number | null) => (id === 5 ? rebuilt : id === 7 ? rebuiltCmp : null);
		const view = new LoadProbe(() => parts.context);

		view.loadComparison(clicked, clickedCmp);
		expect(view.settled.length).toBe(1);

		const opened: Array<[HTMLElement, HTMLElement]> = [];
		view.settled[0]({ loadComparison: (elem: HTMLElement, cmpElem: HTMLElement) => { opened.push([elem, cmpElem]); } } as unknown as CommitDetailsSurface);
		expect(opened).toEqual([[rebuilt, rebuiltCmp]]);
	});

	it('a commit that fell off the page while the module loaded is dropped (not open)', () => {
		const clicked = rowElem(5);
		const parts = raceParts(clicked, rowElem(5));
		parts.store.getCommitId = () => null; // the re-render dropped it from the page
		const view = new LoadProbe(() => parts.context);

		view.load(clicked);
		expect(view.settled.length).toBe(1);

		const opened: HTMLElement[] = [];
		view.settled[0]({ load: (elem: HTMLElement) => { opened.push(elem); } } as unknown as CommitDetailsSurface);
		expect(opened).toEqual([]);
	});

	it('a click on a row that resolves to no commit never arms the load', () => {
		const stranger = rowElem(9);
		const parts = raceParts(rowElem(5), rowElem(5));
		const view = new LoadProbe(() => parts.context);

		view.load(stranger); // getCommitOfElem answers null
		expect(view.settled.length).toBe(0);
	});
});

describe('the lazy machinery across the in-flight window', () => {
	/** A widget surface whose calls are counted, standing in for a real on-demand module. */
	function fakeWidget() {
		const counts = { opens: 0, closes: 0, disposals: 0 };
		return {
			counts: counts,
			show: () => { counts.opens++; },
			close: () => { counts.closes++; },
			dispose: () => { counts.disposals++; }
		};
	}

	/** Let the facade's promise chains (import + the queued call) run to completion. */
	async function settle() {
		await new Promise((resolve) => { setTimeout(resolve, 0); });
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	}

	it('a close during the load window cancels the open queued behind it', async () => {
		const { ctx } = fakeContext();
		let release: ((widget: StatisticsViewSurface) => void) | null = null;
		// The seam stands in for the dynamic import: it settles only when the test releases it,
		// so the window between arming an open and the module arriving is under the test's hand.
		class WindowProbe extends LazyStatisticsView {
			protected override ensure(): Promise<StatisticsViewSurface> {
				return new Promise((resolve) => { release = resolve; });
			}
		}
		const view = new WindowProbe(() => ctx);
		const widget = fakeWidget();

		view.show(); // arms the open behind the pending load
		view.close(); // the user dismisses it / the view switches repositories — still loading
		release!(widget as unknown as StatisticsViewSurface);
		await settle();

		expect(widget.counts.opens).toBe(0); // the queued open was cancelled, not replayed
	});

	it('an open queued behind the load still runs when nothing closes it', async () => {
		const { ctx } = fakeContext();
		let release: ((widget: StatisticsViewSurface) => void) | null = null;
		class WindowProbe extends LazyStatisticsView {
			protected override ensure(): Promise<StatisticsViewSurface> {
				return new Promise((resolve) => { release = resolve; });
			}
		}
		const view = new WindowProbe(() => ctx);
		const widget = fakeWidget();

		view.show();
		release!(widget as unknown as StatisticsViewSurface);
		await settle();

		expect(widget.counts.opens).toBe(1); // the cancellation is opt-in: a close, nothing else
	});

	it('a widget constructed after dispose() is torn straight back down', async () => {
		let construct: ((widget: ReturnType<typeof fakeWidget>) => void) | null = null;
		const constructed = new Promise<ReturnType<typeof fakeWidget>>((resolve) => { construct = resolve; });
		class ManualFacade extends LazyWidget<ReturnType<typeof fakeWidget>> {
			public open(): void {
				this.ensureAndCall((widget) => widget.show());
			}
		}
		const facade = new ManualFacade(() => constructed);
		const widget = fakeWidget();

		facade.open(); // arms the load
		facade.dispose(); // the view goes away while the import is in flight
		construct!(widget); // the import settles anyway
		await settle();

		expect(widget.counts.disposals).toBe(1); // the late instance never outlives the view
		expect(widget.counts.opens).toBe(0); // and its queued call died with the dispose
	});
});

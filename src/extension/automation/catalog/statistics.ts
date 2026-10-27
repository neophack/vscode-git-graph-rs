/**
 * The statistics actions of the automation catalog: carved verbatim out of
 * the former single-file catalog.ts, each action carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';

export const STATISTICS_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Statistics widget ---------- */
	{
		id: 'statistics/close',
		title: 'Close Statistics',
		group: 'statistics',
		tags: ['statistics'],
		mutable: false,
		// The view is read-only and has no refresh control — opening it is
		// control-bar/statistics, so only the close interaction lives here.
		ui: [
			{ op: 'click', selector: '#statisticsBtn' },
			{ op: 'waitFor', selector: '#statisticsWidget.active' },
			{ op: 'click', selector: '#statisticsClose' },
			{ op: 'waitForGone', selector: '#statisticsWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	}
];

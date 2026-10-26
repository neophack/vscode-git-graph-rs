/**
 * The keyboard actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';

export const KEYBOARD_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Keyboard shortcuts ---------- */
	{
		id: 'keyboard/key-find',
		title: 'Ctrl+F (open find)',
		group: 'keyboard',
		tags: ['keyboard'],
		mutable: false,
		// Default keybinding: keyboardShortcut.find = 'f'.
		ui: [
			{ op: 'key', key: 'f', ctrlOrCmd: true },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'keyboard/key-refresh',
		title: 'Ctrl+R (refresh)',
		group: 'keyboard',
		tags: ['keyboard'],
		mutable: false,
		// Default keybinding: keyboardShortcut.refresh = 'r'; the handler refreshes hard with
		// config changes, i.e. loadRepoInfo followed by loadCommits.
		ui: [{ op: 'key', key: 'r', ctrlOrCmd: true }],
		expect: { responses: ['loadRepoInfo', 'loadCommits'] }
	},
	{
		id: 'keyboard/key-scroll-to-head',
		title: 'Ctrl+H (scroll to HEAD)',
		group: 'keyboard',
		tags: ['keyboard'],
		mutable: false,
		// Default keybinding: keyboardShortcut.scrollToHead = 'h'; pure scroll. The effect is
		// asserted: the HEAD row (the one carrying the commitHeadDot marker) is inside the
		// rendered window afterwards — windowed rendering keeps only viewport rows in the DOM.
		ui: [
			{ op: 'key', key: 'h', ctrlOrCmd: true },
			{ op: 'waitFor', selector: 'tr.commit:has(.commitHeadDot)' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	}
];

/**
 * The find actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';
import { bi } from './helpers';

export const FIND_ACTIONS: readonly AutomationAction[] = [
	/* ---------- Find widget ---------- */
	{
		id: 'find/close',
		title: 'Close Find',
		group: 'find',
		tags: ['find'],
		mutable: false,
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'find/find-next',
		title: 'Next Match',
		group: 'find',
		tags: ['find'],
		mutable: false,
		// Match navigation only scrolls and re-highlights — no host traffic. The navigation is
		// asserted: the position indicator ("N of M") must advance when there is another match to
		// move to (a single-match query stays put — the barrier tolerates exactly that).
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'eval', expr: '(function(){window.__ggFindPosBefore=document.getElementById("findPosition").textContent.trim();return window.__ggFindPosBefore;})()' },
			{ op: 'click', selector: '#findNext' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var m=now.match(/[0-9]+[^0-9]+([0-9]+)/);if(now!==was)return resolve(was+" -> "+now);if(m!==null&&parseInt(m[1],10)===1)return resolve("single match - navigation is a no-op ("+was+")");if(++n>100)return reject(new Error("the Next Match click did not advance the position indicator ("+was+")"));setTimeout(t,25);};t();});})()'
			},
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'find/find-prev',
		title: 'Previous Match',
		group: 'find',
		tags: ['find'],
		mutable: false,
		// The mirror of find-next: the position indicator must move back (or wrap) — the same
		// single-match tolerance applies.
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'eval', expr: '(function(){window.__ggFindPosBefore=document.getElementById("findPosition").textContent.trim();return window.__ggFindPosBefore;})()' },
			{ op: 'click', selector: '#findPrev' },
			{
				op: 'eval',
				expr: '(function(){return new Promise(function(resolve,reject){var n=0;var t=function(){var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var now=document.getElementById("findPosition").textContent.trim();var was=window.__ggFindPosBefore;var m=now.match(/[0-9]+[^0-9]+([0-9]+)/);if(now!==was)return resolve(was+" -> "+now);if(m!==null&&parseInt(m[1],10)===1)return resolve("single match - navigation is a no-op ("+was+")");if(++n>100)return reject(new Error("the Previous Match click did not move the position indicator ("+was+")"));setTimeout(t,25);};t();});})()'
			},
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	},
	{
		id: 'find/open-commit',
		title: 'Open Commit Details View for the current match',
		group: 'find',
		tags: ['find'],
		mutable: false,
		// The button toggles "open the Commit Details View for the current match" and applies it
		// immediately, requesting the commit details. Two states make a plain click unreliable:
		// the toggle persists across runs (a previous run may have left it on — then the click
		// turns it OFF), and an earlier entry may have left a Commit Details View open on the
		// match commit (then the view skips re-requesting the details). The flow closes a leaked
		// CDV first and only flips the toggle when it is off, restoring it afterwards.
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var c=document.getElementById("cdvClose");if(c!==null)c.click();return c!==null;})()' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'eval', expr: '(function(){var b=document.getElementById("findOpenCdv");if(b.className.split(/\\s+/).indexOf("active")===-1){b.click();return "enabled";}return "already active";})()' },
			{ op: 'waitFor', selector: '#cdv' },
			{ op: 'eval', expr: '(function(){var b=document.getElementById("findOpenCdv");if(b.className.split(/\\s+/).indexOf("active")!==-1){b.click();return "disabled";}return "already off";})()' },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' },
			{ op: 'click', selector: '#cdvClose' },
			{ op: 'waitForGone', selector: '#cdv' }
		],
		expect: { responses: ['commitDetails'] }
	},
	{
		id: 'find/type-query',
		title: 'Type a find query',
		group: 'find',
		tags: ['find'],
		mutable: false,
		// The widget matches on a keyup-driven 200 ms debounce, so the query is typed through an
		// eval (a plain `set` dispatches input/change, which the widget does not listen to).
		ui: [
			{ op: 'click', selector: '#findBtn' },
			{ op: 'waitFor', selector: '.findWidget.active' },
			{ op: 'eval', expr: '(function(){var i=document.getElementById("findInput");i.value="{{findQuery}}";i.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));})()' },
			{ op: 'waitFor', selector: '.findMatch' },
			{ op: 'expectText', selector: '#findPosition', contains: bi(' of ', '，共') },
			{ op: 'click', selector: '#findClose' },
			{ op: 'waitForGone', selector: '.findWidget.active' }
		],
		noHostTraffic: true,
		expect: { responses: [] }
	}
];

/**
 * The external actions of the automation catalog (task 6.2 split): carved verbatim out of
 * the former single-file catalog.ts, each action now carrying its tags (the group at minimum).
 * See catalog.ts for the assembled catalog and the fixture-stable facts the entries rely on.
 */

import { AutomationAction } from './types';

export const EXTERNAL_ACTIONS: readonly AutomationAction[] = [
	/* ---------- External changes (the watcher chain) ---------- */
	{
		id: 'external/commit-appears',
		title: 'A commit made outside VS Code appears without any view interaction',
		group: 'external',
		tags: ['external'],
		mutable: true,
		// The regression class of the dropped-watcher-event fix: the runner makes an empty commit
		// OUT OF BAND (PRE_ACTION_SETUP — a real `git commit`, the way a user's terminal would)
		// while the view sits on the repository, and the page steps do NOTHING but poll the
		// rendered table: no Refresh click, no view control. The row appearing is the whole
		// assertion — it proves the watcher chain end to end (fs event → RepoFileWatcher debounce
		// → muted-event deferral past the previous action's suppression window → the host's
		// 'refresh' push → the page's soft reload rendering the new commit at the top). No request
		// path: the change comes from outside the view; no response expectations either — the
		// watcher's own loadCommits response can precede the run's listening window (the commit
		// is made before the engine starts the run), so the run is gated on the rendered outcome.
		ui: [
			{
				op: 'eval',
				expr: '(function(){var want="External automation commit";'
					+ 'var attr=function(k){try{return document.body.getAttribute(k)||"-";}catch(e){return "-";}};'
					+ 'return new Promise(function(resolve,reject){var n=0;var t=function(){n++;try{'
					// A tick must never throw: the poll runs in a setTimeout callback, where an
					// exception (the view element rebuilt mid-poll, a transient DOM state) would
					// kill the re-arm below without settling the promise - and a batch whose
					// promise never settles wedges the shim for every later batch. Every read is
					// therefore guarded and a failed tick counts as one more empty poll.
					+ 'var rows=document.querySelectorAll("tr.commit .description span.text");'
					+ 'for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf(want)!==-1)return resolve("the externally committed row rendered without any view interaction");}'
					+ '}catch(e){}'
					+ 'if(n>160)return reject(new Error("the external commit never appeared in the view (watcher-driven refresh missing?)'
					// The page state at the moment the wait gave up. The load lifecycle history comes
					// FIRST (the runner truncates long messages): refreshCycles counts the refresh
					// pushes that reached the page, applied the commit responses that were applied,
					// and the history shows which cycle the external commit rode in on and what the
					// machine did with it - "the push never arrived" and "the response was dropped"
					// are different failures, and this is how to tell them apart (loadDiagnostics).
					// lastCommits carries the LAST APPLIED response's own truth (count, head, whether
					// the head is among its own commits, first hash): a stale-engine response applies
					// exactly as happily as a fresh one, and only the payload can tell them apart.
					+ ' [hist "+attr("data-gg-load-history").replace(/c:[^,]*/g,"R")'
					+ '+"] [lastCommits "+attr("data-gg-last-commits")'
					+ '+" [rows "+(function(){try{return document.querySelectorAll("tr.commit .description span.text").length;}catch(e){return -1;}})()'
					+ '+", cycles "+attr("data-gg-refresh-cycles")'
					+ '+", applied "+attr("data-gg-commits-applied")'
					+ '+", state "+attr("data-gg-load-state").replace(/c:[^,]*/g,"R")'
					+ '+", drops "+attr("data-gg-load-drops")'
					+ '+", first: "+(function(){try{return Array.prototype.slice.call(document.querySelectorAll("tr.commit .description span.text"),0,3).map(function(r){return r.textContent.slice(0,30);}).join(" | ");}catch(e){return "-";}})()+"]"));'
					+ 'setTimeout(t,125);};t();});})()'
			}
		],
		noHostTraffic: true,
		expect: { responses: [] },
		// The commit the runner made must really be HEAD — the watcher did not just re-render the
		// old graph.
		verify: { kind: 'headSubjectStartsWith', placeholder: 'External automation commit' }
	}
];

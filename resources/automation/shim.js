/*
 * The Git Graph automation shim — the in-page half of the remote automation interface.
 * Injected by the extension host (gitGraphView.ts, with the page's CSP nonce) before
 * out.min.js loads. It executes UI step batches received from the automation server as
 * { __automation: { runId, steps } } window messages and posts results back as
 * { __ggAutomationResult: { runId, ok, results, failedStep?, error? } }. The bundle itself
 * is untouched: steps drive the same DOM controls a user clicks, and every request the
 * steps trigger travels the bundle's own sendMessage path.
 *
 * Plain script, no dependencies, must stay ES2019-safe (it runs inside the webview).
 */
(function () {
	'use strict';
	if (window.__ggAutomation) return; // already installed (webview restored from cache)

var api = null; // acquired lazily: inline scripts run before the page's API object exists in test harnesses

function postToHost(message) {
	if (api === null) {
		// VS Code allows one acquireVsCodeApi() per webview and the bundle usually claims it at
		// boot: prefer the instance it published on window.__ggVscodeApi, and publish ours there
		// when we acquire first (a batch arriving before the bundle boots), so the bundle cannot
		// hit the once-only guard either way.
		try {
			api = window.__ggVscodeApi || (window.__ggVscodeApi = acquireVsCodeApi());
		} catch (e) {
			try { window.__ggAutomation.lastError = 'acquire: ' + (e instanceof Error ? e.message : String(e)); } catch (_) { }
			return;
		}
	}
	try {
		api.postMessage(message);
	} catch (e) {
		try { window.__ggAutomation.lastError = 'post: ' + (e instanceof Error ? e.message : String(e)); } catch (_) { }
	}
}

	var STEP_TIMEOUT_MS = 5000;

	/* ---------- step primitives ---------- */

	function find(selector) {
		var el = document.querySelector(selector);
		if (!el) throw new Error('no element matches "' + selector + '"');
		return el;
	}

	function sleep(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	function waitForImpl(selector, timeoutMs, gone) {
		var deadline = Date.now() + (timeoutMs || STEP_TIMEOUT_MS);
		return new Promise(function (resolve, reject) {
			(function poll() {
				var found = document.querySelector(selector) !== null;
				if (found === !gone) return resolve(null);
				if (Date.now() > deadline) return reject(new Error((gone ? 'element still present: "' : 'element never appeared: "') + selector + '"'));
				setTimeout(poll, 25);
			})();
		});
	}

	/* Marker result: a skipIfAbsent probe found nothing, so the batch ends as skipped (not failed). */
	var SKIP_SENTINEL = {};

	/** Wait for the element; resolve SKIP_SENTINEL-carrying info (ending the batch as skipped) when it never appears. */
	function waitForOrSkip(selector, timeoutMs) {
		var deadline = Date.now() + (timeoutMs || STEP_TIMEOUT_MS);
		return new Promise(function (resolve) {
			(function poll() {
				if (document.querySelector(selector) !== null) return resolve(null);
				if (Date.now() > deadline) return resolve({ sentinel: SKIP_SENTINEL, selector: selector });
				setTimeout(poll, 25);
			})();
		});
	}

	function isSkipResult(result) {
		return result !== null && typeof result === 'object' && result.sentinel === SKIP_SENTINEL;
	}

	// Sanitise a value for structured-clone transport: JSON-safe, everything else stringified.
	function sanitize(value) {
		if (value === undefined || value === null) return null;
		try {
			return JSON.parse(JSON.stringify(value));
		} catch (e) {
			return String(value);
		}
	}

	var AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;

	function runStep(step) {
		switch (step.op) {
			case 'click':
				find(step.selector).click();
				return Promise.resolve(null);
			case 'dblclick': {
				var el = find(step.selector);
				var rect = el.getBoundingClientRect();
				el.dispatchEvent(new MouseEvent('dblclick', {
					bubbles: true, cancelable: true,
					clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
				}));
				return Promise.resolve(null);
			}
			case 'contextmenu': {
				// `item` may carry one text per interface language (the catalog ships en + zh-CN);
				// whichever the rendered UI shows is the one clicked.
				var wanted = Array.isArray(step.item) ? step.item : [step.item];
				// The menu renders synchronously on the contextmenu event, but a concurrent
				// re-render — the background refresh a prior action's repository mutation
				// triggers — can close it again, or drop the right-clicked row's commit from the
				// view so the handler returns before showing anything (a zero-item menu). Re-find
				// the target and dispatch again, exactly what a user right-clicking into a
				// refreshing view does; only an attempt that showed items but no match (or the
				// last attempt) fails.
				var attempt = function (remaining) {
					var target = find(step.selector);
					var bounds = target.getBoundingClientRect();
					target.dispatchEvent(new MouseEvent('contextmenu', {
						bubbles: true, cancelable: true, button: 2,
						clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2
					}));
					return sleep(50).then(function () {
						var items = document.querySelectorAll('ul.contextMenu li.contextMenuItem');
						if (items.length === 0 && remaining > 0) {
							return sleep(200).then(function () { return attempt(remaining - 1); });
						}
						for (var i = 0; i < items.length; i++) {
							if (wanted.indexOf(items[i].textContent.trim()) !== -1) {
								items[i].click();
								return null;
							}
						}
						throw new Error('context menu item "' + wanted.join('" or "') + '" not found (' + items.length + ' items shown)');
					});
				};
				return attempt(4);
			}
			case 'key':
				document.dispatchEvent(new KeyboardEvent('keydown', {
					key: step.key, bubbles: true, cancelable: true,
					ctrlKey: !!step.ctrlOrCmd, metaKey: !!step.ctrlOrCmd, shiftKey: !!step.shift
				}));
				return Promise.resolve(null);
			case 'waitFor':
				return waitForImpl(step.selector, step.timeoutMs, false);
			case 'waitForGone':
				return waitForImpl(step.selector, step.timeoutMs, true);
			case 'skipIfAbsent':
				// A precondition probe: repositories without the control this action drives (the
				// Load More footer on a short history, the Uncommitted Changes row on a clean
				// tree) end the batch as skipped instead of failing the action.
				return waitForOrSkip(step.selector, step.timeoutMs);
			case 'set': {
				var input = find(step.selector);
				input.value = step.value;
				input.dispatchEvent(new Event(step.event, { bubbles: true }));
				return Promise.resolve(null);
			}
			case 'expectText': {
				var text = find(step.selector).textContent;
				// `contains` may list one substring per interface language; any match passes.
				var wanted = Array.isArray(step.contains) ? step.contains : [step.contains];
				for (var i = 0; i < wanted.length; i++) {
					if (text.indexOf(wanted[i]) !== -1) return Promise.resolve(text.trim().slice(0, 200));
				}
				throw new Error('"' + step.selector + '" does not contain "' + wanted.join('" or "') + '" (got: ' + text.trim().slice(0, 120) + ')');
			}
			case 'eval':
				return new AsyncFunction('"use strict"; return (' + step.expr + ');')().then(sanitize);
			default:
				return Promise.reject(new Error('unknown step op "' + step.op + '"'));
		}
	}

	/* ---------- batch execution ---------- */

	var currentRun = null;

	function executeBatch(runId, steps) {
		var results = [];
		var skipReason = null;
		var chain = Promise.resolve();
		steps.forEach(function (step, index) {
			chain = chain.then(function () {
				if (skipReason !== null) return null; // skipped: no further steps run
				return runStep(step).then(function (result) {
					if (isSkipResult(result)) {
						skipReason = 'element absent in the view: "' + result.selector + '"';
						results[index] = null;
						return null;
					}
					results[index] = result === undefined ? null : result;
				});
			});
		});
		return chain.then(
			function () {
				return skipReason === null
					? { runId: runId, ok: true, results: results }
					: { runId: runId, ok: true, skipped: true, skipReason: skipReason, results: results };
			},
			function (error) {
				return {
					runId: runId, ok: false, results: results,
					failedStep: results.length, error: error instanceof Error ? error.message : String(error)
				};
			}
		).then(function (result) {
			// Debug/inspection mirror (CDP probes, harnesses): the wire result travels the
			// vscode API channel, which page-side tooling cannot observe.
			try { window.__ggAutomation.lastResult = result; } catch (e) { }
			return result;
		});
	}

	window.addEventListener('message', function (event) {
		var data = event && event.data;
		if (!data || typeof data !== 'object' || data.__automation === undefined) return;
		var batch = data.__automation;
		if (currentRun !== null) {
			postToHost({ __ggAutomationResult: { runId: batch.runId, ok: false, results: [], error: 'a step batch is already running (runId ' + currentRun + ')' } });
			return;
		}
		currentRun = batch.runId;
		executeBatch(batch.runId, batch.steps || []).then(function (result) {
			currentRun = null;
			postToHost({ __ggAutomationResult: result });
		}, function (err) {
			currentRun = null;
			try { window.__ggAutomation.lastError = 'batch: ' + String(err && err.stack || err); } catch (_) { }
		});
	});

	// Marker for external tooling (the test driver protocol, CDP probes).
	window.__ggAutomation = { version: 1, ready: true };
})();

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
		if (api === null) api = acquireVsCodeApi();
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
				var target = find(step.selector);
				var bounds = target.getBoundingClientRect();
				target.dispatchEvent(new MouseEvent('contextmenu', {
					bubbles: true, cancelable: true, button: 2,
					clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2
				}));
				// The menu renders synchronously on the contextmenu event; give the event
				// loop a beat, then click the item whose visible text matches exactly.
				return sleep(50).then(function () {
					var items = document.querySelectorAll('ul.contextMenu li.contextMenuItem');
					for (var i = 0; i < items.length; i++) {
						if (items[i].textContent.trim() === step.item) {
							items[i].click();
							return null;
						}
					}
					throw new Error('context menu item "' + step.item + '" not found (' + items.length + ' items shown)');
				});
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
			case 'set': {
				var input = find(step.selector);
				input.value = step.value;
				input.dispatchEvent(new Event(step.event, { bubbles: true }));
				return Promise.resolve(null);
			}
			case 'expectText': {
				var text = find(step.selector).textContent;
				if (text.indexOf(step.contains) === -1) {
					throw new Error('"' + step.selector + '" does not contain "' + step.contains + '" (got: ' + text.trim().slice(0, 120) + ')');
				}
				return Promise.resolve(text.trim().slice(0, 200));
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
		var chain = Promise.resolve();
		steps.forEach(function (step, index) {
			chain = chain.then(function () {
				return runStep(step).then(function (result) {
					results[index] = result === undefined ? null : result;
				});
			});
		});
		return chain.then(
			function () { return { runId: runId, ok: true, results: results }; },
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

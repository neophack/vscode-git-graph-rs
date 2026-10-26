/**
 * Tests for the P1 trace API (src/shared/perf/trace.ts): the marks the timing budgets are (to
 * be) calibrated against must record what they claim - the right names, in order, on the right
 * side of the host/webview split - and stay free when disabled.
 *
 * The module holds state at the module level (a ring buffer and one open trace), so every test
 * resets it through the test seam; the fallback paths that need an environment without the
 * `performance` global re-import the module under `vi.resetModules` with the global stubbed.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import * as trace from './trace';

describe('the P1 trace API', () => {
	beforeEach(() => {
		trace.resetForTests();
	});

	afterEach(() => {
		trace.resetForTests();
	});

	it('is off by default: every call is a no-op', () => {
		assert.equal(trace.isEnabled(), false);

		trace.mark('T0');
		trace.begin('boot');
		trace.mark('T1');
		trace.end();
		const collected = trace.span('op', () => 'value');
		trace.mergeWebviewMarks([{ name: 'T2', t: 1 }]);

		assert.equal(collected, 'value');
		assert.equal(trace.hasOpenTrace(), false);
		assert.deepEqual(trace.collectMarks(), []);
		assert.deepEqual(trace.traces(), []);
	});

	it('records marks into an open trace in order', () => {
		trace.setEnabled(true);
		trace.begin('boot');

		assert.equal(trace.hasOpenTrace(), true);
		trace.mark('T0');
		trace.mark('T1');

		trace.end();
		const traces = trace.traces();
		assert.equal(traces.length, 1);
		assert.equal(traces[0]!.name, 'boot');
		assert.deepEqual(traces[0]!.marks.map((m) => m.name), ['T0', 'T1']);
		for (const m of traces[0]!.marks) {
			assert.equal(m.origin, 'host');
			assert.equal(typeof m.t, 'number');
		}
	});

	it('auto-opens a session trace when a mark arrives without a begin', () => {
		trace.setEnabled(true);
		trace.mark('T1');

		trace.end();
		const traces = trace.traces();
		assert.equal(traces.length, 1);
		assert.equal(traces[0]!.name, 'session');
		assert.deepEqual(traces[0]!.marks.map((m) => m.name), ['T1']);
	});

	it('the begin/end span wrapper records the span as a trace, sync and async', async () => {
		trace.setEnabled(true);

		const sync = trace.span('op:sync', () => 42);
		assert.equal(sync, 42);

		const async = await trace.span('op:async', () => Promise.resolve('done'));
		assert.equal(async, 'done');

		const traces = trace.traces();
		assert.deepEqual(traces.map((t) => t.name), ['op:sync', 'op:async']);
		// The span IS a duration: a `<name>:start` / `<name>` mark pair whose offset difference
		// the analyser aggregates.
		assert.deepEqual(traces[0]!.marks.map((m) => m.name), ['op:sync:start', 'op:sync']);
		assert.deepEqual(traces[1]!.marks.map((m) => m.name), ['op:async:start', 'op:async']);
		for (const t of traces) {
			assert.ok(t.marks[1]!.t >= t.marks[0]!.t);
		}
	});

	it('the span wrapper ends the span when the function throws or rejects', async () => {
		trace.setEnabled(true);

		assert.throws(() => trace.span('op:throws', () => { throw new Error('boom'); }), /boom/);
		await assert.rejects(() => trace.span('op:rejects', () => Promise.reject(new Error('bang'))), /bang/);

		const traces = trace.traces();
		assert.deepEqual(traces.map((t) => t.name), ['op:throws', 'op:rejects']);
		assert.deepEqual(traces[0]!.marks.map((m) => m.name), ['op:throws:start', 'op:throws:error']);
		assert.deepEqual(traces[1]!.marks.map((m) => m.name), ['op:rejects:start', 'op:rejects:error']);
		assert.equal(trace.hasOpenTrace(), false);
	});

	it('a begin supersedes an open trace (a boot whose report never arrived does not swallow the next)', () => {
		trace.setEnabled(true);
		trace.begin('boot');
		trace.mark('T0');
		trace.begin('op:loadCommits');

		const traces = trace.traces();
		assert.equal(traces.length, 1);
		assert.equal(traces[0]!.name, 'boot');
		assert.deepEqual(traces[0]!.marks.map((m) => m.name), ['T0']);
		assert.equal(trace.hasOpenTrace(), true);
	});

	it('a trace without marks is not recorded', () => {
		trace.setEnabled(true);
		trace.begin('empty');
		trace.end();

		assert.deepEqual(trace.traces(), []);
	});

	it('keeps a 20-trace ring buffer, oldest out', () => {
		trace.setEnabled(true);
		for (let i = 0; i < 25; i++) {
			trace.begin('trace-' + i);
			trace.mark('m' + i);
			trace.end();
		}

		const traces = trace.traces();
		assert.equal(traces.length, 20);
		assert.equal(traces[0]!.name, 'trace-5');
		assert.equal(traces[19]!.name, 'trace-24');
	});

	it('mergeWebviewMarks appends the webview batch and records the trace', () => {
		trace.setEnabled(true);
		trace.begin('boot');
		trace.mark('T0');

		trace.mergeWebviewMarks([
			{ name: 'T2', t: 100 },
			{ name: 'T4', t: 250 },
			{ name: 'T5', t: 300 }
		]);

		assert.equal(trace.hasOpenTrace(), false);
		const recorded = trace.traces();
		assert.equal(recorded.length, 1);
		assert.deepEqual(recorded[0]!.marks.map((m) => [m.name, m.origin]), [
			['T0', 'host'],
			['T2', 'webview'],
			['T4', 'webview'],
			['T5', 'webview']
		]);
	});

	it('mergeWebviewMarks opens a webview-only trace when the host half never opened one', () => {
		trace.setEnabled(true);
		trace.mergeWebviewMarks([{ name: 'T2', t: 5 }]);

		const traces = trace.traces();
		assert.equal(traces.length, 1);
		assert.equal(traces[0]!.name, 'webview');
		assert.equal(traces[0]!.marks[0]!.origin, 'webview');
	});

	it('collectMarks returns the open trace as the wire payload, clearMarks drops it', () => {
		trace.setEnabled(true);
		trace.mark('T2');
		trace.mark('T4');

		const collected = trace.collectMarks();
		assert.deepEqual(collected.map((m) => m.name), ['T2', 'T4']);
		// The wire payload carries no origin: the host stamps 'webview' when it merges.
		for (const m of collected) {
			assert.deepEqual(Object.keys(m), ['name', 't']);
		}

		assert.equal(trace.hasMark('T2'), true);
		assert.equal(trace.hasMark('T5'), false);
		assert.equal(trace.hasMark('T2'), trace.isEnabled());

		trace.clearMarks();
		assert.equal(trace.hasOpenTrace(), false);
		assert.equal(trace.hasMark('T2'), false);
		assert.deepEqual(trace.collectMarks(), []);
	});

	it('forwards recorded traces to the sink and detaches on null', () => {
		trace.setEnabled(true);
		const seen: string[] = [];
		trace.onTraceRecorded((t) => seen.push(t.name));

		trace.begin('boot');
		trace.mark('T0');
		trace.end();
		trace.onTraceRecorded(null);
		trace.begin('boot');
		trace.mark('T0');
		trace.end();

		assert.deepEqual(seen, ['boot']);
	});

	it('formatTrace renders the analyser-parseable one-liner, offsets relative per origin', () => {
		const rendered = trace.formatTrace({
			name: 'boot',
			marks: [
				{ name: 'T0', t: 1000.0, origin: 'host' },
				{ name: 'T1', t: 1008.25, origin: 'host' },
				{ name: 'T3', t: 1040.0, origin: 'host' },
				{ name: 'T2', t: 500.0, origin: 'webview' },
				{ name: 'T4', t: 680.5, origin: 'webview' }
			]
		});

		assert.equal(rendered, 'boot: T0 +0.0ms, T1 +8.3ms, T3 +40.0ms, T2 +0.0ms (webview), T4 +180.5ms (webview)');
	});

	it('falls back to Date.now when no performance timeline exists', async () => {
		vi.resetModules();
		vi.stubGlobal('performance', undefined);
		try {
			const fallback = await import('./trace');
			fallback.resetForTests();
			fallback.setEnabled(true);
			fallback.mark('T2');

			fallback.end();
			const mark = fallback.traces()[0]!.marks[0]!;
			assert.equal(mark.t, Math.floor(mark.t)); // Date.now(): integral milliseconds
			assert.ok(Math.abs(mark.t - Date.now()) < 60000);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('marks the runtime timeline when performance.mark exists, and survives when it does not', async () => {
		vi.resetModules();
		const marks: string[] = [];
		vi.stubGlobal('performance', { now: () => 1.5, mark: (name: string) => marks.push(name) });
		try {
			const withMark = await import('./trace');
			withMark.resetForTests();
			withMark.setEnabled(true);
			withMark.mark('T2');
			withMark.end();
			assert.deepEqual(marks, ['gg:T2']);
			assert.equal(withMark.traces()[0]!.marks[0]!.t, 1.5);
		} finally {
			vi.unstubAllGlobals();
		}

		vi.resetModules();
		// A timeline without mark(): the collected trace still records.
		vi.stubGlobal('performance', { now: () => 2.5 });
		try {
			const withoutMark = await import('./trace');
			withoutMark.resetForTests();
			withoutMark.setEnabled(true);
			withoutMark.mark('T2');
			withoutMark.end();
			assert.equal(withoutMark.traces()[0]!.marks[0]!.t, 2.5);
		} finally {
			vi.unstubAllGlobals();
		}
		vi.resetModules();
	});
});

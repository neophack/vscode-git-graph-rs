/**
 * `UncommittedCountStabiliser` gates the "Uncommitted Changes" count delivered to the webview
 * (see `sendUncommittedChangesFollowUp` in src/gitGraphView.ts). The row it renders must never
 * disappear and reappear on a momentary reading: a positive count is delivered immediately (the
 * row appears at once, a count change only updates its number), while a zero that would remove
 * the row is only delivered once re-reads have confirmed it across the 5 second window, and a
 * failed status read is never delivered at all.
 */

import assert from 'node:assert/strict';
import { Module } from 'node:module';
import { describe, it } from 'node:test';

/* The stand-in for the extension host (src/gitGraphView.ts only transitively requires 'vscode'). */
const vscodeStub = {
	Uri: { file: (p) => ({ fsPath: p, path: p }) },
	env: { language: 'en' },
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined
	},
	workspace: {
		getConfiguration: () => ({
			get: (_section, defaultValue) => defaultValue,
			has: () => false,
			inspect: () => undefined,
			update: () => Promise.resolve()
		})
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.apply(this, arguments);
};

const { UncommittedCountStabiliser } = await import('../out/gitGraphView.js');

const CONFIRM_WINDOW_MS = 5000;
const RECHECK_MS = 1000;

function makeStabiliser() {
	return new UncommittedCountStabiliser(CONFIRM_WINDOW_MS, RECHECK_MS);
}

describe('UncommittedCountStabiliser', () => {
	it('delivers a positive count immediately, before anything was ever rendered (the row appears at once)', () => {
		const s = makeStabiliser();
		assert.deepStrictEqual(s.observe(3, 1000), { send: 3 });
	});

	it('delivers a positive count immediately when it would only update the rendered number', () => {
		const s = makeStabiliser();
		s.observe(3, 1000);
		s.delivered(3);
		assert.deepStrictEqual(s.observe(4, 2000), { send: 4 });
	});

	it('delivers a zero immediately when no row is rendered (nothing is on screen to stabilise)', () => {
		const s = makeStabiliser();
		assert.deepStrictEqual(s.observe(0, 1000), { send: 0 });
	});

	it('holds a zero that would remove the rendered row until re-reads confirm it across the window', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		// The first zero starts the clock; re-reads within the window keep holding
		for (let elapsed = 0; elapsed < CONFIRM_WINDOW_MS; elapsed += RECHECK_MS) {
			assert.deepStrictEqual(s.observe(0, 1000 + elapsed), { recheckAfterMs: RECHECK_MS }, 'held at +' + elapsed + 'ms');
		}
		// The first reading at or after the window delivers the removal: the row disappears 5s
		// after the zero was first read
		assert.deepStrictEqual(s.observe(0, 1000 + CONFIRM_WINDOW_MS), { send: 0 });
	});

	it('delivers the count instead of the removal when a re-read inside the window sees changes again', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		assert.deepStrictEqual(s.observe(0, 2000), { recheckAfterMs: RECHECK_MS });
		assert.deepStrictEqual(s.observe(0, 3000), { recheckAfterMs: RECHECK_MS });
		// The user edited a file again while the zero was being confirmed
		assert.deepStrictEqual(s.observe(2, 4000), { send: 2 });
		// A later zero starts a fresh window (the removal was never delivered)
		assert.deepStrictEqual(s.observe(0, 4500), { recheckAfterMs: RECHECK_MS });
	});

	it('never delivers a failed reading: a failure neither confirms a zero nor updates the count', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		// Zeros are read and held across the whole window...
		for (let elapsed = 0; elapsed < CONFIRM_WINDOW_MS; elapsed += RECHECK_MS) {
			s.observe(0, 2000 + elapsed);
		}
		// ...then the status read starts failing exactly when the window would elapse: the failure
		// must deliver nothing
		assert.deepStrictEqual(s.observe(null, 2000 + CONFIRM_WINDOW_MS), { recheckAfterMs: RECHECK_MS });
		// The zeros read before the failure already confirmed the removal: the next successful
		// zero (still at or after the window) delivers it
		assert.deepStrictEqual(s.observe(0, 2000 + CONFIRM_WINDOW_MS + RECHECK_MS), { send: 0 });
	});

	it('a failed reading before any zero does not start the confirmation window', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);

		assert.deepStrictEqual(s.observe(null, 2000), { recheckAfterMs: RECHECK_MS });
		assert.deepStrictEqual(s.observe(null, 2000 + CONFIRM_WINDOW_MS), { recheckAfterMs: RECHECK_MS });
		// The first ACTUAL zero only arrives now: the window starts here, so the removal is held
		assert.deepStrictEqual(s.observe(0, 2000 + CONFIRM_WINDOW_MS + RECHECK_MS), { recheckAfterMs: RECHECK_MS });
	});

	it('a zero delivered right after a reset (repository switch) does not wait for a window', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);
		s.reset();
		assert.deepStrictEqual(s.observe(0, 2000), { send: 0 });
	});

	it('a removal followed by more zeros keeps delivering them directly (no second window)', () => {
		const s = makeStabiliser();
		s.observe(5, 1000);
		s.delivered(5);
		for (let elapsed = 0; elapsed < CONFIRM_WINDOW_MS; elapsed += RECHECK_MS) {
			s.observe(0, 1000 + elapsed);
		}
		assert.deepStrictEqual(s.observe(0, 1000 + CONFIRM_WINDOW_MS), { send: 0 });
		s.delivered(0);
		assert.deepStrictEqual(s.observe(0, 1000 + CONFIRM_WINDOW_MS + RECHECK_MS), { send: 0 });
	});
});

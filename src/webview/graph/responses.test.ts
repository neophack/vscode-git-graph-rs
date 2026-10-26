// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createResponseRouter } from './responses';
import type { GraphContext } from './context';

/**
 * The response router's channel hygiene: the window's message channel is SHARED — the automation
 * shim receives its step batches as window messages ({ __automation: ... }, no `command`), and the
 * editor may deliver other non-protocol events. A message that is not a protocol response must be
 * dropped silently; the former behavior dispatched it anyway (`handlers[undefined]`), threw, and
 * surfaced an error dialog that occluded the view for the rest of the session (the S1-family E2E
 * failure). Real responses still route.
 */
function fakeContext(): { ctx: GraphContext; errors: string[]; state: { softRefreshes: number } } {
	const errors: string[] = [];
	// A boxed counter: the closure below mutates the box, so the test reads live values
	// (a bare `let` returned by value would hand the test a frozen snapshot).
	const state = { softRefreshes: 0 };
	const ctx = {
		dialog: {
			showError: (_title: string, message: unknown) => { errors.push(String(message)); },
			closeActionRunning: () => undefined,
			isTargetDynamicSource: () => false,
			close: () => undefined,
			refresh: () => undefined
		},
		loader: {
			refresh: (hard: boolean) => { if (!hard) state.softRefreshes++; }
		}
	} as unknown as GraphContext;
	return { ctx, errors, state };
}

describe('createResponseRouter channel hygiene', () => {
	it('drops the automation shim\'s step-batch messages without an error dialog', () => {
		const { ctx, errors } = fakeContext();
		const router = createResponseRouter(ctx);
		router({ __automation: { runId: 1, steps: [{ op: 'eval', expr: 'document.title' }] } } as never);
		expect(errors).toEqual([]);
	});

	it('drops messages without a command and messages of unknown commands', () => {
		const { ctx, errors } = fakeContext();
		const router = createResponseRouter(ctx);
		expect(() => router(null as never)).not.toThrow();
		expect(() => router('refresh' as never)).not.toThrow();
		expect(() => router({ command: 'notAProtocolCommand' } as never)).not.toThrow();
		expect(errors).toEqual([]);
	});

	it('still routes real protocol responses', () => {
		const { ctx, state } = fakeContext();
		const router = createResponseRouter(ctx);
		router({ command: 'refresh' } as never);
		expect(state.softRefreshes).toBe(1);
	});
});

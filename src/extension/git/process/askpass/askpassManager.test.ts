/**
 * The askpass credential prompt: the
 * promptForCredential flow must keep its exact HTTP contract - a dismissed prompt answers ''
 * over 200 (git treats that as "no input given"), a typed answer is returned JSON-encoded, and
 * a failed prompt rejects with HTTP 500 so git surfaces the failure instead of hanging. The
 * input port is a fake adapter; the responder records what it would write to the socket.
 */

import { describe, expect, it, vi } from 'vitest';

// The module captures `vscode.window` at import time; a stub is enough for the extracted
// responder under test (the AskpassManager class itself starts an HTTP server and is not
// constructed here). ViewColumn satisfies the platform config module's module-scope enum map.
const vscodeMock = vi.hoisted(() => ({
	version: '1.90.0',
	ViewColumn: { Active: 1, Beside: 2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
	window: {
		showInputBox: () => Promise.resolve(undefined)
	}
}));

vi.mock('vscode', () => vscodeMock);

import { AskpassResponder, promptForCredential } from './askpassManager';

/** A fake native input port: records the options and answers a scripted value (an Error rejects). */
function fakeInput(answer: string | undefined | Error) {
	const calls: Array<{ options: Record<string, unknown> }> = [];
	return {
		calls: calls,
		port: {
			showInputBox: (options: Record<string, unknown>) => {
				calls.push({ options: options });
				return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
			}
		}
	};
}

/** A fake HTTP responder recording every written status / body chunk. */
function fakeResponder() {
	const written: Array<{ status?: number, body?: string }> = [];
	const res: AskpassResponder = {
		writeHead(status: number) {
			written.push({ status: status });
			return res;
		},
		end(body?: string) {
			written.push({ body: body });
		}
	};
	return { res: res, written: written };
}

describe('promptForCredential', () => {
	it('asks through the input port with the request as placeholder and the host as prompt', async () => {
		const input = fakeInput('secret');
		const { res, written } = fakeResponder();

		promptForCredential(input.port, 'Password for https://host', 'example.com', res);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(input.calls).toEqual([{
			options: {
				placeHolder: 'Password for https://host',
				prompt: 'Git Graph RS: example.com',
				password: true,
				ignoreFocusOut: true
			}
		}]);
		expect(written).toEqual([{ status: 200 }, { body: '"secret"' }]);
	});

	it('flags the prompt as a password entry only when the request names a password', async () => {
		const input = fakeInput('user');
		const { res } = fakeResponder();

		promptForCredential(input.port, 'Username', 'example.com', res);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(input.calls[0]!.options.password).toBe(false);
	});

	it('answers an empty or dismissed prompt with an empty JSON string over 200', async () => {
		for (const answer of ['', undefined]) {
			const input = fakeInput(answer);
			const { res, written } = fakeResponder();

			promptForCredential(input.port, 'Password', 'example.com', res);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(written).toEqual([{ status: 200 }, { body: '""' }]);
		}
	});

	it('rejects with HTTP 500 and no body when the prompt fails, so git surfaces the failure', async () => {
		const input = fakeInput(new Error('no ui'));
		const { res, written } = fakeResponder();

		promptForCredential(input.port, 'Password', 'example.com', res);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(written).toEqual([{ status: 500 }, { body: undefined }]);
	});
});

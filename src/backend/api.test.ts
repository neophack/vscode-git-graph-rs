import { describe, expect, it, vi } from 'vitest';
import { cancel, request } from './addon';
import { startCancellableRequest } from './api';

/**
 * The cancellation-capable call shape (task 2.9) that the host scheduler of task 4.8 consumes:
 * `startCancellableRequest` must wire its id through the same typed request seam, and its
 * `cancel()` must reach the addon's `cancel` under that id. The addon module is mocked - these
 * tests pin the wiring, not the engine.
 */

vi.mock('./addon', () => ({
	request: vi.fn(async () => 'ok-value'),
	cancel: vi.fn(),
	loadAddon: vi.fn(() => {
		throw new Error('the scheduler shape never loads the binary itself');
	})
}));

const requestMock = vi.mocked(request);
const cancelMock = vi.mocked(cancel);

describe('startCancellableRequest', () => {
	it('issues the request under its id and cancels through the same id', async () => {
		const call = startCancellableRequest('/repo', 'engineVersion', {}, 42);

		await expect(call.promise).resolves.toBe('ok-value');
		expect(requestMock).toHaveBeenCalledWith('/repo', 'engineVersion', {}, undefined, { requestId: 42 });
		expect(cancelMock).not.toHaveBeenCalled();

		call.cancel();
		expect(cancelMock).toHaveBeenCalledWith(42, undefined);
	});

	it('mints a fresh id per call when none is given', async () => {
		const first = startCancellableRequest('/repo', 'engineVersion', {});
		const second = startCancellableRequest('/repo', 'engineVersion', {});

		const firstId = requestMock.mock.calls[0][4]?.requestId;
		const secondId = requestMock.mock.calls[1][4]?.requestId;
		expect(typeof firstId).toBe('number');
		expect(secondId).not.toBe(firstId);

		first.cancel();
		second.cancel();
		expect(cancelMock).toHaveBeenCalledWith(firstId, undefined);
		expect(cancelMock).toHaveBeenCalledWith(secondId, undefined);
		await Promise.all([first.promise, second.promise]);
	});
});

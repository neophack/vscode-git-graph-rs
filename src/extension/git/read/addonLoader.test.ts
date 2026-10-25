import { describe, expect, it, vi } from 'vitest';
import { AddonCallOptions, cancel, NativeAddon, request } from './addonLoader';
import { GitBackendError } from './types';

/**
 * Cancellation paths of the engine adapter (REFACTOR-PLAN task 2.9): how `requestId` and
 * `cancel()` travel through the single request seam, and how the engine's structured
 * `cancelled` envelope surfaces as a `GitBackendError`. Everything runs against a fake addon
 * injected through the loader option - no `.node` binary is ever loaded, so these tests pass on
 * a machine with or without a built engine.
 */

/** The envelope the engine answers when a request was cancelled. */
const CANCELLED_ENVELOPE = '{"error":{"kind":"cancelled","message":"The operation was cancelled"}}';

/** A fake `native/node` addon: every function is a spy, every answer overridable. */
function fakeAddon(overrides: { request?: (repo: string, requestJson: string, requestId?: number) => Promise<string> } = {}) {
	const addon: NativeAddon = {
		open: vi.fn(async () => '{"ok":"/repo"}'),
		close: vi.fn(),
		closeAll: vi.fn(),
		openCount: vi.fn(() => 1),
		engineVersion: vi.fn(() => '1.0.27-test'),
		request: overrides.request ?? (vi.fn(async () => '{"ok":"1.0.27-test"}') as unknown as NativeAddon['request']),
		requestBytes: vi.fn(async () => ({ ok: null, error: null })),
		cancel: vi.fn()
	};
	const load = (): NativeAddon => addon;
	return { addon, load: load as () => NativeAddon };
}

/** Every call below reaches the addon through the injected loader, never the binary loader. */
const optionsOf = (load: () => NativeAddon, requestId?: number): AddonCallOptions => ({ load, requestId });

describe('cancellation across the adapter seam', () => {
	it('forwards the requestId with the request', async () => {
		const { addon, load } = fakeAddon();
		await request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 7));
		expect(addon.request).toHaveBeenCalledTimes(1);
		expect(addon.request).toHaveBeenCalledWith('/repo', expect.stringContaining('"engineVersion"'), 7);
		expect(addon.cancel).not.toHaveBeenCalled();
	});

	it('omitting the requestId sends exactly the pre-2.9 call', async () => {
		const { addon, load } = fakeAddon();
		await request('/repo', 'engineVersion', {}, undefined, { load });
		expect(addon.request).toHaveBeenCalledWith('/repo', expect.any(String), undefined);
	});

	it('a cancellation before the request starts still cancels it', async () => {
		// The engine remembers a cancellation that races ahead of its request (see cancel.rs);
		// the fake answers the way that registry makes the real engine answer.
		const { addon, load } = fakeAddon({ request: vi.fn(async () => CANCELLED_ENVELOPE) });
		cancel(7, undefined, { load });
		expect(addon.cancel).toHaveBeenCalledWith(7);

		await expect(request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 7))).rejects.toMatchObject({
			name: 'GitBackendError',
			kind: 'Cancelled',
			message: 'The operation was cancelled'
		});
		expect(addon.request).toHaveBeenCalledWith('/repo', expect.any(String), 7);
	});

	it('a cancellation mid-flight rejects the pending request with Cancelled', async () => {
		let answer!: (envelope: string) => void;
		const { addon, load } = fakeAddon({
			request: () => new Promise<string>((resolve) => {
				answer = resolve;
			})
		});
		const pending = request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 8));

		// The request is in flight when the cancellation arrives; the engine answers the
		// structured cancelled envelope at its next checkpoint, which is what we hand back.
		cancel(8, undefined, { load });
		expect(addon.cancel).toHaveBeenCalledWith(8);
		answer(CANCELLED_ENVELOPE);

		const failure = await pending.then(
			() => undefined,
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(GitBackendError);
		expect((failure as GitBackendError).kind).toBe('Cancelled');
		expect((failure as GitBackendError).isFallbackWorthy).toBe(false);
	});

	it('cancelling an unknown id is a no-op for other requests', async () => {
		const { addon, load } = fakeAddon();
		expect(() => cancel(424242, undefined, { load })).not.toThrow();
		expect(addon.cancel).toHaveBeenCalledWith(424242);

		// A request under a different id answers normally, after the stray cancellation.
		await expect(request('/repo', 'engineVersion', {}, undefined, optionsOf(load, 9))).resolves.toBe('1.0.27-test');
		expect(addon.cancel).toHaveBeenCalledTimes(1);
	});
});

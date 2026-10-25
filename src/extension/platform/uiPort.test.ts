import { describe, expect, it } from 'vitest';
import { Notifications } from './notifications';
import type { NotificationsPort } from './uiPort';

/**
 * uiPort.ts is interface-only, so its tests are type-level assertions that pin the two
 * compatibility claims of its JSDoc: the platform Notifications adapter already satisfies the
 * NotificationsPort subset, and it equally satisfies the narrower showErrorMessage member the
 * wave-1 handler table declares for ctx.ui (any UiPort implementation therefore drops into the
 * handler interface unchanged).
 */

describe('UiPort compatibility', () => {
	it('a Notifications instance satisfies NotificationsPort structurally', async () => {
		const notifications: Notifications = new Notifications(null);
		const asPort: NotificationsPort = notifications;

		await expect(asPort.showInformationMessage('msg', 'OK')).resolves.toBeUndefined();
		await expect(asPort.showWarningMessage('msg', 'OK')).resolves.toBeUndefined();
		await expect(asPort.showErrorMessage('msg', 'OK')).resolves.toBeUndefined();
	});

	it('satisfies the handler table\'s ctx.ui showErrorMessage member (fewer params, void return)', async () => {
		// Type-only import of the wave-1 handler interface; the assignability below is checked by
		// the compiler on every run of this suite - if either side drifts, tsc fails this file.
		type HandlerUiErrorMessage = import('../graphView/handlers/context').UiPort['showErrorMessage'];
		const notifications: Notifications = new Notifications(null);
		const asHandlerMember: HandlerUiErrorMessage = notifications.showErrorMessage.bind(notifications);

		await expect(asHandlerMember('msg')).resolves.toBeUndefined();
	});
});

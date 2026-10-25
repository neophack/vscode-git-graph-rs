import { describe, expect, it } from 'vitest';
import { MessageChoice, MessageItemLike, Notifications, NotificationsLike } from './notifications';

type Answer = MessageChoice | undefined | Promise<MessageChoice | undefined>;

/** A window fake recording every dialog and answering a programmable outcome. */
class FakeWindow implements NotificationsLike {
	public readonly calls: Array<{ kind: string; message: string; items: unknown[] }> = [];

	public showInformationMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.record('showInformationMessage', message, items);
	}

	public showWarningMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.record('showWarningMessage', message, items);
	}

	public showErrorMessage<T extends MessageChoice>(message: string, ...items: T[]): Promise<T | undefined> {
		return this.record('showErrorMessage', message, items);
	}

	public constructor(private readonly answer: () => Answer = () => undefined) {}

	private record<T extends MessageChoice>(kind: string, message: string, items: T[]): Promise<T | undefined> {
		this.calls.push({ kind, message, items });
		const answer: Answer = this.answer();
		const outcome = answer instanceof Promise ? answer : Promise.resolve(answer as MessageChoice | undefined);
		return outcome as Promise<T | undefined>;
	}
}

describe('Notifications', () => {
	it('shows an information message and resolves the chosen item', async () => {
		const window = new FakeWindow(() => 'Retry');
		const notifications = new Notifications(window);

		await expect(notifications.information('Something happened', 'Retry', 'Ignore')).resolves.toBe('Retry');
		expect(window.calls).toEqual([{ kind: 'showInformationMessage', message: 'Something happened', items: ['Retry', 'Ignore'] }]);
	});

	it('shows warning and error messages through their own kinds', async () => {
		const window = new FakeWindow(() => 'Overwrite');
		const notifications = new Notifications(window);

		await expect(notifications.warning('Careful', 'Overwrite')).resolves.toBe('Overwrite');
		await expect(notifications.error('It broke', 'Overwrite')).resolves.toBe('Overwrite');
		expect(window.calls.map((call) => call.kind)).toEqual(['showWarningMessage', 'showErrorMessage']);
	});

	it('resolves UNDEFINED when the message is dismissed (no item chosen)', async () => {
		const notifications = new Notifications(new FakeWindow(() => undefined));
		await expect(notifications.information('Dismiss me', 'OK')).resolves.toBeUndefined();
	});

	it('passes MessageItem-shaped choices through untouched', async () => {
		const choice: MessageItemLike = { title: 'Open Log', isCloseAffordance: false };
		const notifications = new Notifications(new FakeWindow(() => choice));

		await expect(notifications.error('Failed', choice)).resolves.toBe(choice);
	});

	it('resolves UNDEFINED when the API is missing entirely (null / undefined window)', async () => {
		const notifications = new Notifications(null);
		await expect(notifications.information('msg')).resolves.toBeUndefined();
		await expect(notifications.warning('msg')).resolves.toBeUndefined();
		await expect(notifications.error('msg')).resolves.toBeUndefined();

		const fromUndefined = new Notifications(undefined);
		await expect(fromUndefined.information('msg')).resolves.toBeUndefined();
	});

	it('resolves UNDEFINED for a window whose methods are absent', async () => {
		const notifications = new Notifications({} as NotificationsLike);
		await expect(notifications.information('msg', 'OK')).resolves.toBeUndefined();
	});

	it('swallows a rejected Thenable into UNDEFINED', async () => {
		const window = new FakeWindow(() => Promise.reject(new Error('window gone')));
		const notifications = new Notifications(window);

		await expect(notifications.information('msg', 'OK')).resolves.toBeUndefined();
	});
});

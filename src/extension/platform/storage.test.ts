import { describe, expect, it } from 'vitest';
import { MementoLike, Storage } from './storage';

/** A memento fake recording every update and answering from a plain map. */
class FakeMemento implements MementoLike {
	private readonly store: Map<string, unknown>;
	public readonly updates: Array<{ key: string; value: unknown }> = [];

	public constructor(values: Record<string, unknown> = {}, private readonly failUpdates = false) {
		this.store = new Map(Object.entries(values));
	}

	public get<T>(key: string, defaultValue?: T): T | undefined {
		return this.store.has(key) ? this.store.get(key) as T : defaultValue;
	}

	public update(key: string, value: unknown): Promise<void> {
		this.updates.push({ key, value });
		if (this.failUpdates) return Promise.reject(new Error('storage read-only'));
		this.store.set(key, value);
		return Promise.resolve();
	}
}

describe('Storage', () => {
	it('reads stored values and falls back to the given default', () => {
		const storage = new Storage(new FakeMemento({ 'lastActiveRepo': 'E:/repo', 'count': 3 }));

		expect(storage.get<string>('lastActiveRepo')).toBe('E:/repo');
		expect(storage.get<string>('lastActiveRepo', 'fallback')).toBe('E:/repo');
		expect(storage.get<string>('missing', 'fallback')).toBe('fallback');
		expect(storage.get<number>('count', 0)).toBe(3);
		expect(storage.get('missing')).toBeUndefined();
	});

	it('persists values and resolves TRUE', async () => {
		const memento = new FakeMemento();
		const storage = new Storage(memento);

		await expect(storage.set('lastActiveRepo', 'E:/other')).resolves.toBe(true);
		expect(storage.get<string>('lastActiveRepo')).toBe('E:/other');
		expect(memento.updates).toEqual([{ key: 'lastActiveRepo', value: 'E:/other' }]);
	});

	it('removes keys by updating them to undefined', async () => {
		const memento = new FakeMemento({ 'stale': true });
		const storage = new Storage(memento);

		await expect(storage.remove('stale')).resolves.toBe(true);
		expect(memento.updates).toEqual([{ key: 'stale', value: undefined }]);
	});

	it('is lenient without a store: get answers the default, writes resolve FALSE', async () => {
		const storage = new Storage(null);

		expect(storage.get('anything')).toBeUndefined();
		expect(storage.get('anything', 'default')).toBe('default');
		await expect(storage.set('anything', 1)).resolves.toBe(false);
		await expect(storage.remove('anything')).resolves.toBe(false);
		expect(new Storage(undefined).get('k', 7)).toBe(7);
	});

	it('resolves FALSE when the update rejects, instead of rejecting', async () => {
		const storage = new Storage(new FakeMemento({}, true));

		await expect(storage.set('key', 'value')).resolves.toBe(false);
		await expect(storage.remove('key')).resolves.toBe(false);
	});

	it('answers the default when a malformed store answers a throwing get', () => {
		const throwing: MementoLike = {
			get: () => { throw new Error('corrupt'); },
			update: () => Promise.resolve()
		};
		const storage = new Storage(throwing);

		expect(storage.get('key', 'safe')).toBe('safe');
		expect(storage.get('key')).toBeUndefined();
	});

	it('resolves FALSE when the store lacks update entirely', async () => {
		const storage = new Storage({} as MementoLike);
		await expect(storage.set('key', 'value')).resolves.toBe(false);
	});
});

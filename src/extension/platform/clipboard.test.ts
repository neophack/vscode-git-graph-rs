import { describe, expect, it } from 'vitest';
import { Clipboard, ClipboardLike } from './clipboard';

/** A clipboard fake recording every write and answering programmable outcomes. */
class FakeClipboard implements ClipboardLike {
	public readonly writes: string[] = [];

	public constructor(
		private readonly writeOutcome: () => void | Promise<void> = () => undefined,
		private readonly readOutcome: () => string = () => '')
	{}

	public writeText(value: string): Promise<void> {
		this.writes.push(value);
		return Promise.resolve(this.writeOutcome());
	}

	public readText(): Promise<string> {
		return Promise.resolve(this.readOutcome());
	}
}

describe('Clipboard', () => {
	it('writes text through the injected clipboard and resolves TRUE', async () => {
		const fake = new FakeClipboard();
		await expect(new Clipboard(fake).write('abc123')).resolves.toBe(true);
		expect(fake.writes).toEqual(['abc123']);
	});

	it('resolves FALSE when the clipboard is unavailable (null / undefined)', async () => {
		await expect(new Clipboard(null).write('abc123')).resolves.toBe(false);
		await expect(new Clipboard(undefined).write('abc123')).resolves.toBe(false);
	});

	it('resolves FALSE when the clipboard lacks writeText', async () => {
		await expect(new Clipboard({} as ClipboardLike).write('abc123')).resolves.toBe(false);
	});

	it('resolves FALSE when the write rejects', async () => {
		const failing: ClipboardLike = {
			writeText: () => Promise.reject(new Error('clipboard locked'))
		};
		await expect(new Clipboard(failing).write('abc123')).resolves.toBe(false);
	});

	it('reads text through the injected clipboard', async () => {
		const fake = new FakeClipboard(() => undefined, () => 'pasted');
		await expect(new Clipboard(fake).read()).resolves.toBe('pasted');
	});

	it('resolves NULL on read when the reader is unavailable or rejects', async () => {
		await expect(new Clipboard(null).read()).resolves.toBeNull();
		await expect(new Clipboard({} as ClipboardLike).read()).resolves.toBeNull();

		const failing: ClipboardLike = {
			writeText: () => Promise.resolve(),
			readText: () => Promise.reject(new Error('no read access'))
		};
		await expect(new Clipboard(failing).read()).resolves.toBeNull();
	});
});

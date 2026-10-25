import { describe, expect, it, vi } from 'vitest';
import { Logger, OutputChannelFactoryLike, OutputChannelLike } from './logger';

/** A channel fake recording appended lines and optional-member calls. */
class FakeChannel implements OutputChannelLike {
	public lines: string[] = [];
	public shown = 0;
	public cleared = 0;
	public disposed = 0;

	public appendLine(value: string): void {
		this.lines.push(value);
	}

	public show(): void {
		this.shown++;
	}

	public clear(): void {
		this.cleared++;
	}

	public dispose(): void {
		this.disposed++;
	}
}

function factoryFor(channel: OutputChannelLike | null | undefined): OutputChannelFactoryLike {
	return { createOutputChannel: () => channel as OutputChannelLike };
}

describe('Logger', () => {
	it('appends log lines to a channel created from the injected factory', () => {
		const channel = new FakeChannel();
		const logger = new Logger('Git Graph RS', factoryFor(channel));

		logger.log('Starting Git Graph ...');
		logger.log('Started Git Graph - Ready to use!');

		expect(channel.lines).toEqual(['Starting Git Graph ...', 'Started Git Graph - Ready to use!']);
	});

	it('flags error lines', () => {
		const channel = new FakeChannel();
		const logger = new Logger('Git Graph RS', factoryFor(channel));

		logger.error('boom');

		expect(channel.lines).toEqual(['[ERROR] boom']);
	});

	it('reveals, clears and disposes the channel', () => {
		const channel = new FakeChannel();
		const logger = new Logger('Git Graph RS', factoryFor(channel));

		logger.show();
		logger.clear();
		logger.dispose();

		expect(channel.shown).toBe(1);
		expect(channel.cleared).toBe(1);
		expect(channel.disposed).toBe(1);
	});

	it('tolerates a missing factory: every method is a no-op', () => {
		const logger = new Logger('Git Graph RS', null);

		expect(() => {
			logger.log('ignored');
			logger.error('ignored');
			logger.show();
			logger.clear();
			logger.dispose();
		}).not.toThrow();

		const fromUndefined = new Logger('Git Graph RS', undefined);
		fromUndefined.log('also ignored');
	});

	it('tolerates a factory without createOutputChannel, or one that throws', () => {
		const noMethod = new Logger('Git Graph RS', {} as OutputChannelFactoryLike);
		expect(() => noMethod.log('msg')).not.toThrow();

		const throwing: OutputChannelFactoryLike = {
			createOutputChannel: () => { throw new Error('no output channels here'); }
		};
		expect(() => new Logger('Git Graph RS', throwing).log('msg')).not.toThrow();
	});

	it('tolerates a factory answering an unusable channel', () => {
		const logger = new Logger('Git Graph RS', factoryFor(null));
		expect(() => logger.log('msg')).not.toThrow();

		const garbage = new Logger('Git Graph RS', factoryFor('channel?' as unknown as OutputChannelLike));
		expect(() => garbage.log('msg')).not.toThrow();
	});

	it('still logs through a minimal channel that only implements appendLine', () => {
		const appendLine = vi.fn();
		const minimal = { appendLine } as unknown as OutputChannelLike;
		const logger = new Logger('Git Graph RS', factoryFor(minimal));

		expect(() => {
			logger.log('one');
			logger.show();
			logger.clear();
			logger.dispose();
		}).not.toThrow();
		expect(appendLine).toHaveBeenCalledWith('one');
	});
});

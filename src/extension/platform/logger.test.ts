import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The unified Logger has a vscode-wired half (absorbed from the former flat src/logger.ts): the
 * host shape `new Logger(logFilePath?)` creates the 'Git Graph RS' channel through
 * `vscode.window` at construction, so these tests run against a fake 'vscode' module (the
 * structural half below keeps using the injected factory and needs no fake).
 */
const vscodeMock = vi.hoisted(() => ({
	window: {
		createOutputChannel: (_name: string): unknown => {
			throw new Error('unexpected createOutputChannel call');
		}
	}
}));

vi.mock('vscode', () => vscodeMock);

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

describe('Logger (host-wired mode, absorbed from src/logger.ts)', () => {
	let channel: FakeChannel;
	let created: string[];

	beforeEach(() => {
		channel = new FakeChannel();
		created = [];
		vscodeMock.window.createOutputChannel = (name: string) => {
			created.push(name);
			return channel;
		};
	});

	it('wires the channel from vscode.window and records nothing until enabled', () => {
		const logger = new Logger();

		expect(created).toEqual(['Git Graph RS']);
		expect(logger.isEnabled()).toBe(false);
		expect(logger.getLogFile()).toBeNull();

		logger.log('not recorded');
		logger.logError('not recorded either');

		expect(channel.lines).toEqual([]);
	});

	it('mirrors timestamped lines to the log file once enabled', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-logger-'));
		const logFile = path.join(directory, 'git-graph-rs.log');
		const logger = new Logger(logFile);

		logger.log('while disabled'); // dropped
		logger.setEnabled(true);

		expect(logger.isEnabled()).toBe(true);
		expect(logger.getLogFile()).toBe(logFile);
		// The fresh-file setup is asynchronous (the mirror queue): wait for it before reading.
		await vi.waitFor(() => expect(fs.existsSync(logFile)).toBe(true));

		logger.log('hello');
		logger.logError('boom');

		await vi.waitFor(() => {
			const contents = fs.readFileSync(logFile, 'utf8');
			expect(contents).toContain('hello');
			expect(contents).toContain('ERROR: boom');
			expect(contents).not.toContain('while disabled');
			// Every mirrored line is timestamped [YYYY-MM-DD HH:MM:SS.mmm]
			expect(contents.match(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] /gm)).toHaveLength(2);
		});
		expect(channel.lines).toHaveLength(2);
	});

	it('starts a fresh log file on every enable', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-logger-'));
		const logFile = path.join(directory, 'git-graph-rs.log');
		const logger = new Logger(logFile);

		logger.setEnabled(true);
		await vi.waitFor(() => expect(fs.existsSync(logFile)).toBe(true));
		logger.log('first session');
		await vi.waitFor(() => expect(fs.readFileSync(logFile, 'utf8')).toContain('first session'));
		logger.setEnabled(false);
		logger.log('while disabled');
		logger.setEnabled(true);
		// The truncation runs on the mirror queue: the previous session's line disappears then.
		await vi.waitFor(() => expect(fs.readFileSync(logFile, 'utf8')).not.toContain('first session'));
		expect(fs.readFileSync(logFile, 'utf8')).not.toContain('while disabled');
		logger.log('second session');
		await vi.waitFor(() => expect(fs.readFileSync(logFile, 'utf8')).toContain('second session'));
	});

	it('falls back to the channel alone when the log file location is unusable', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-logger-'));
		const blocker = path.join(directory, 'blocker');
		fs.writeFileSync(blocker, 'a file, not a directory');
		const logger = new Logger(path.join(blocker, 'nested', 'git-graph-rs.log'));

		logger.setEnabled(true);
		// The failed setup degrades the mirror asynchronously; the channel keeps working meanwhile.
		await vi.waitFor(() => expect(logger.getLogFile()).toBeNull());

		logger.log('still on the channel');
		expect(channel.lines.some((line) => line.indexOf('still on the channel') > -1)).toBe(true);
	});

	it('recovers the file mirror after a transient setup failure, without an enable-flag change', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-logger-'));
		const logFile = path.join(directory, 'git-graph-rs.log');
		// A directory squatting on the file path makes the first setup fail: the mirror degrades
		// (in production this shape is a transient failure such as an antivirus lock).
		fs.mkdirSync(logFile);
		const logger = new Logger(logFile);

		logger.setEnabled(true);
		await vi.waitFor(() => expect(logger.getLogFile()).toBeNull());

		// Recovery: re-enabling with an unchanged flag must still rebuild the mirror - the
		// equal-value guard must not pin the session to channel-only forever.
		fs.rmdirSync(logFile);
		logger.setEnabled(true);
		logger.log('recovered session');
		await vi.waitFor(() => expect(fs.readFileSync(logFile, 'utf8')).toContain('recovered session'));
	});

	it('formats spawned commands through logCmd', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-logger-'));
		const logger = new Logger(path.join(directory, 'git-graph-rs.log'));
		logger.setEnabled(true);

		logger.logCmd('git', ['log', '', '--format=%H%x00', 'spaced arg', '-n', '5'], 42);

		expect(channel.lines.some((line) => line.indexOf('> git log "" --format=... "spaced arg" -n 5 (42 ms)') > -1)).toBe(true);
	});

	it('disposes the vscode-wired channel', () => {
		const logger = new Logger();
		logger.dispose();

		expect(channel.disposed).toBe(1);
	});
});

import { describe, expect, it } from 'vitest';
import { TerminalLike, TerminalOptionsLike, Terminals, TerminalsLike } from './terminal';

/** A terminal fake recording what was sent and shown. */
class FakeTerminal implements TerminalLike {
	public sent: string[] = [];
	public shown = 0;
	public hidden = 0;
	public disposed = 0;

	public sendText(text: string): void {
		this.sent.push(text);
	}

	public show(): void {
		this.shown++;
	}

	public hide(): void {
		this.hidden++;
	}

	public dispose(): void {
		this.disposed++;
	}
}

/** A window fake recording the creation options and answering a programmable terminal. */
class FakeWindow implements TerminalsLike {
	public readonly created: TerminalOptionsLike[] = [];

	public constructor(private readonly answer: () => TerminalLike | null = () => new FakeTerminal()) {}

	public createTerminal(options: TerminalOptionsLike): TerminalLike {
		this.created.push(options);
		return this.answer() as TerminalLike;
	}
}

const OPTIONS: TerminalOptionsLike = { name: 'Git Graph: rebase', cwd: 'E:/repo', shellPath: 'C:/bin/bash.exe', env: { 'PATH': 'C:/git/bin' } };

describe('Terminals', () => {
	it('creates a terminal through the injected window without touching it further', () => {
		const window = new FakeWindow();
		const terminal = new Terminals(window).create(OPTIONS);

		expect(terminal).toBeInstanceOf(FakeTerminal);
		expect(window.created).toEqual([OPTIONS]);
		expect((terminal as FakeTerminal).sent).toEqual([]);
		expect((terminal as FakeTerminal).shown).toBe(0);
	});

	it('runs a command: create + sendText + show (openGitTerminal flow)', () => {
		const window = new FakeWindow();
		const terminal = new Terminals(window).run(OPTIONS, 'git rebase -i HEAD~3');

		expect(window.created).toEqual([OPTIONS]);
		expect((terminal as FakeTerminal).sent).toEqual(['git rebase -i HEAD~3']);
		expect((terminal as FakeTerminal).shown).toBe(1);
	});

	it('opens without a command (command NULL): nothing sent, still shown', () => {
		const window = new FakeWindow();
		const terminal = new Terminals(window).run(OPTIONS, null);

		expect((terminal as FakeTerminal).sent).toEqual([]);
		expect((terminal as FakeTerminal).shown).toBe(1);
	});

	it('answers NULL when no window is available', () => {
		const terminals = new Terminals(null);
		expect(terminals.create(OPTIONS)).toBeNull();
		expect(terminals.run(OPTIONS, 'git status')).toBeNull();
		expect(new Terminals(undefined).run(OPTIONS, null)).toBeNull();
	});

	it('answers NULL when createTerminal is not a function', () => {
		const terminals = new Terminals({} as TerminalsLike);
		expect(terminals.create(OPTIONS)).toBeNull();
	});

	it('answers NULL when the factory throws or answers unusably', () => {
		const throwing: TerminalsLike = {
			createTerminal: () => { throw new Error('no terminal support'); }
		};
		expect(new Terminals(throwing).create(OPTIONS)).toBeNull();

		const answeringNull: TerminalsLike = { createTerminal: () => null as unknown as TerminalLike };
		expect(new Terminals(answeringNull).create(OPTIONS)).toBeNull();

		const answeringGarbage: TerminalsLike = { createTerminal: () => 'terminal?' as unknown as TerminalLike };
		expect(new Terminals(answeringGarbage).run(OPTIONS, 'git status')).toBeNull();
	});

	it('still returns a partial terminal that lacks sendText/show', () => {
		const partial = {} as TerminalLike;
		const window = new FakeWindow(() => partial);
		const terminal = new Terminals(window).run(OPTIONS, 'git status');

		expect(terminal).toBe(partial);
	});
});

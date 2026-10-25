import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundChangePoller } from './poller';

/**
 * Background poller tests (REFACTOR-PLAN task 4.4): the signature comparison that detects
 * changes the file watcher missed, the baseline discipline across ticks and repository
 * switches, and the hostile-input paths (momentarily unreadable repository, throwing read).
 */

interface PollerHarness {
	deps: {
		currentRepo: ReturnType<typeof vi.fn>;
		getSignature: ReturnType<typeof vi.fn>;
		onRepoChanged: ReturnType<typeof vi.fn>;
		logger: { logs: string[]; log(message: string): void };
	};
	poller: BackgroundChangePoller;
}

function poller(repo: string | null = '/repo'): PollerHarness {
	const deps = {
		currentRepo: vi.fn(() => repo),
		getSignature: vi.fn(async () => 'sig-1'),
		onRepoChanged: vi.fn(),
		logger: { logs: [] as string[], log(message: string) { this.logs.push(message); } }
	};
	return { deps: deps, poller: new BackgroundChangePoller(deps, 100) };
}

async function tick(times = 1): Promise<void> {
	for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(100);
}

afterEach(() => {
	vi.useRealTimers();
});

describe('BackgroundChangePoller', () => {
	it('records a baseline on the first tick without refreshing', async () => {
		vi.useFakeTimers();
		const h = poller();
		h.poller.start();
		await tick();
		expect(h.deps.getSignature).toHaveBeenCalledWith('/repo');
		expect(h.deps.onRepoChanged).not.toHaveBeenCalled();
		h.poller.stop();
	});

	it('refreshes once when the signature changes between ticks, then re-baselines', async () => {
		vi.useFakeTimers();
		const h = poller();
		let signature = 'sig-1';
		h.deps.getSignature.mockImplementation(async () => signature);
		h.poller.start();
		await tick();
		signature = 'sig-2';
		await tick();
		expect(h.deps.onRepoChanged).toHaveBeenCalledTimes(1);
		expect(h.deps.logger.logs).toEqual(['Background poll detected a repository change in /repo']);
		await tick(); // sig-2 again: the change is not re-detected
		expect(h.deps.onRepoChanged).toHaveBeenCalledTimes(1);
		h.poller.stop();
	});

	it('keeps the previous baseline when the repository is momentarily unreadable', async () => {
		vi.useFakeTimers();
		const h = poller();
		let signature: string | null = 'sig-1';
		h.deps.getSignature.mockImplementation(async () => signature);
		h.poller.start();
		await tick();
		signature = null; // mid-rebase churn: try again next tick
		await tick();
		expect(h.deps.onRepoChanged).not.toHaveBeenCalled();
		signature = 'sig-2';
		await tick(); // the unreadable tick must NOT have recorded sig-null as the baseline
		expect(h.deps.onRepoChanged).toHaveBeenCalledTimes(1);
		h.poller.stop();
	});

	it('does nothing while the view shows no repository', async () => {
		vi.useFakeTimers();
		const h = poller(null);
		h.poller.start();
		await tick();
		expect(h.deps.getSignature).not.toHaveBeenCalled();
		expect(h.deps.onRepoChanged).not.toHaveBeenCalled();
		h.poller.stop();
	});

	it('ignores a reading the view moved on from (the repository switched mid-read)', async () => {
		vi.useFakeTimers();
		const h = poller();
		h.deps.currentRepo.mockReturnValue('/repo');
		h.deps.getSignature.mockImplementation(async () => {
			h.deps.currentRepo.mockReturnValue('/other'); // the switch happens while reading
			return 'sig-1';
		});
		h.poller.start();
		await tick();
		expect(h.deps.logger.logs).toEqual([]); // no baseline recorded for a repo the view left
		h.poller.stop();
	});

	it('survives a throwing signature read and keeps its baseline', async () => {
		vi.useFakeTimers();
		const h = poller();
		let signature: string | null | Error = 'sig-1';
		h.deps.getSignature.mockImplementation(async () => {
			if (signature instanceof Error) throw signature;
			return signature;
		});
		h.poller.start();
		await tick();
		signature = new Error('EBUSY');
		await tick();
		expect(h.deps.onRepoChanged).not.toHaveBeenCalled();
		signature = 'sig-2';
		await tick();
		expect(h.deps.onRepoChanged).toHaveBeenCalledTimes(1);
		h.poller.stop();
	});

	it('resetBaseline makes the next tick record without refreshing (a watcher-handled change)', async () => {
		vi.useFakeTimers();
		const h = poller();
		h.deps.getSignature.mockReturnValue(async () => 'sig-1');
		h.poller.start();
		await tick();
		h.poller.resetBaseline();
		await tick();
		expect(h.deps.onRepoChanged).not.toHaveBeenCalled(); // same signature, fresh baseline
		h.poller.stop();
	});

	it('stop ends the polling', async () => {
		vi.useFakeTimers();
		const h = poller();
		h.poller.start();
		h.poller.stop();
		await tick();
		expect(h.deps.getSignature).not.toHaveBeenCalled();
	});
});

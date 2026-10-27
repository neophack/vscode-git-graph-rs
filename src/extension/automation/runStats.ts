import { Logger } from '../platform/logger';
import { AutomationAction, AutomationMode } from './catalog';

/**
 * The automation engine's measurement bookkeeping: the outcome record of one action run and the
 * per-action statistics (timings, failure counts, last errors) aggregated across the engine's
 * lifetime. Extracted from the server so the run state machine (runTracker) and the run
 * orchestration (server) stay separate from the numbers a report reads.
 */

export interface ActionSample {
	readonly totalMs: number;
	readonly responses: readonly { readonly command: string; readonly atMs: number }[];
}

export interface ActionStats {
	readonly id: string;
	readonly mode: AutomationMode;
	readonly runs: number;
	readonly failures: number;
	readonly minMs: number;
	readonly p50Ms: number;
	readonly p90Ms: number;
	readonly maxMs: number;
	readonly lastError: string | null;
}

export interface RunOutcome {
	readonly ok: boolean;
	readonly skipped?: boolean;
	readonly reason?: string;
	readonly timings?: ActionSample;
	readonly response?: unknown;
	readonly error?: string;
	/** Native notifications the command raised (command mode only), captured by the dialog auto-answer. */
	readonly notifications?: readonly string[];
}

/** Samples are keyed by `actionId|mode`, so the same action measures separately per mode. */
export class RunStats {
	private readonly samples = new Map<string, number[]>();
	private readonly failureCounts = new Map<string, number>();
	private readonly lastErrors = new Map<string, string>();

	public constructor(private readonly logger: Logger) {}

	/** Fold one finished run into the bookkeeping, log it, and pass the outcome through. */
	public record(action: AutomationAction, mode: AutomationMode, outcome: RunOutcome): RunOutcome {
		const key = action.id + '|' + mode;
		if (outcome.timings !== undefined) {
			const list = this.samples.get(key) ?? [];
			list.push(outcome.timings.totalMs);
			this.samples.set(key, list);
		}
		if (!outcome.ok && !outcome.skipped) {
			this.failureCounts.set(key, (this.failureCounts.get(key) ?? 0) + 1);
			this.lastErrors.set(key, outcome.error ?? 'failed');
		} else if (outcome.ok) {
			this.lastErrors.delete(key);
		}
		this.logger.log('Automation ' + (outcome.ok ? 'ran' : outcome.skipped ? 'skipped' : 'FAILED') + ' ' + action.id + ' (' + mode + ')'
			+ (outcome.timings !== undefined ? ' in ' + outcome.timings.totalMs + ' ms' : '')
			+ (outcome.reason !== undefined ? ': ' + outcome.reason : '')
			+ (outcome.error !== undefined ? ': ' + outcome.error : ''));
		return outcome;
	}

	/** Aggregated per-action timings and failure counts across this engine's runs. */
	public report(): ActionStats[] {
		const stats: ActionStats[] = [];
		for (const [key, samples] of this.samples) {
			const sorted = [...samples].sort((a, b) => a - b);
			const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
			const [id, mode] = key.split('|') as [string, AutomationMode];
			stats.push({
				id, mode,
				runs: sorted.length,
				failures: this.failureCounts.get(key) ?? 0,
				minMs: sorted[0], p50Ms: percentile(0.5), p90Ms: percentile(0.9), maxMs: sorted[sorted.length - 1],
				lastError: this.lastErrors.get(key) ?? null
			});
		}
		return stats.sort((a, b) => a.id.localeCompare(b.id));
	}
}

/**
 * The statistics helpers of the performance gates (REFACTOR-PLAN §6.7): medians and P95 over
 * >= 20 samples, and the Mann-Whitney U test that must CONFIRM a median regression before the
 * gate calls it one — a > 5% median delta that is not statistically significant is machine
 * noise, not a regression, and must not fail a PR.
 *
 * Everything is deliberately small and dependency-free: the normal approximation of U is exact
 * enough at the sample sizes the gates use (>= 20 per side), with the tie correction ranked
 * data needs (equal medians on a discrete metric produce many ties).
 */

/** The median of the samples (the average of the two middle values for an even count). */
export function median(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The P95 of the samples (linear interpolation between the closest ranks, the 'linear' method
 * of numpy.percentile): stable for the 20-30 sample counts the gates take, where a
 * nearest-rank P95 would jump a whole sample slot.
 */
export function percentile(samples, p) {
	const sorted = [...samples].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0];
	const index = (p / 100) * (sorted.length - 1);
	const low = Math.floor(index);
	const high = Math.ceil(index);
	if (low === high) return sorted[low];
	return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** The summary every gate reports for one measured item. */
export function summarize(samples, unit) {
	const sorted = [...samples].sort((a, b) => a - b);
	const sum = samples.reduce((a, b) => a + b, 0);
	return {
		n: samples.length,
		unit: unit,
		median: median(samples),
		p95: percentile(samples, 95),
		mean: sum / samples.length,
		best: sorted[0],
		worst: sorted[sorted.length - 1]
	};
}

/**
 * The one-sided Mann-Whitney U test for the alternative "values of `b` tend to be LARGER than
 * values of `a`" — the question a regression check asks (a = baseline, b = the candidate).
 *
 * Returns the p-value in [0, 1]; small values mean b is significantly larger. Implemented as
 * the rank-sum statistic with the tie correction and the normal approximation (with the 0.5
 * continuity correction), which is what a stats library computes at these sample sizes.
 */
export function mannWhitneyPValueLarger(a, b) {
	if (a.length === 0 || b.length === 0) return 1;
	const n1 = a.length;
	const n2 = b.length;
	// Rank the pooled samples; ties get the average of the ranks they span (1-based).
	const pooled = [...a.map((v) => ({ v, side: 0 })), ...b.map((v) => ({ v, side: 1 }))];
	pooled.sort((x, y) => x.v - y.v);
	const ranks = new Array(pooled.length);
	const ranksSum = [0, 0];
	let i = 0;
	let tieTerm = 0; // sum of t^3 - t over the tie groups, for the variance correction
	while (i < pooled.length) {
		let j = i;
		while (j + 1 < pooled.length && pooled[j + 1].v === pooled[i].v) j++;
		const averageRank = (i + j + 2) / 2; // 1-based ranks i+1 .. j+1
		const size = j - i + 1;
		if (size > 1) tieTerm += size * size * size - size;
		for (let k = i; k <= j; k++) {
			ranks[k] = averageRank;
			ranksSum[pooled[k].side] += averageRank;
		}
		i = j + 1;
	}
	// U for side b: the number of (a, b) pairs where b > a, plus half the ties.
	const uB = ranksSum[1] - (n2 * (n2 + 1)) / 2;
	const meanU = (n1 * n2) / 2;
	const total = n1 + n2;
	const variance = (n1 * n2 * (total + 1 - tieTerm / (total * (total - 1)))) / 12;
	if (variance <= 0) {
		// Every pooled value is tied: no evidence of any difference.
		return 1;
	}
	const z = (uB - meanU - 0.5) / Math.sqrt(variance);
	// One-sided upper tail of the standard normal distribution.
	return 1 - normalCdf(z);
}

/** The standard normal cumulative distribution function (Abramowitz & Stegun 7.1.26 error bounds: 1.5e-7). */
function normalCdf(z) {
	// The Zelen & Severo polynomial approximation, factored through the symmetric halves.
	const t = 1 / (1 + 0.2316419 * Math.abs(z));
	const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
	const upperTail = Math.exp(-0.5 * z * z) * poly / Math.sqrt(2 * Math.PI);
	return z >= 0 ? 1 - upperTail : upperTail;
}

/** A monotonic millisecond clock with sub-ms resolution (the samples' timestamp source). */
export function nowMs() {
	return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Time one async run, in milliseconds.
 * @param run A function whose promise resolves once the measured operation finished.
 */
export async function timeMs(run) {
	const started = nowMs();
	await run();
	return nowMs() - started;
}

/**
 * Measure an item: an untimed warm-up (caches, the OS page cache), then `samples` timed runs.
 * The warm-up's result is checked by `validate` (when given) exactly like a timed run's, so a
 * scenario that stops answering fails the gate instead of producing fast garbage.
 */
export async function measure({ samples, warmups = 1, run, validate }) {
	for (let i = 0; i < warmups; i++) await run(true);
	const collected = [];
	for (let i = 0; i < samples; i++) {
		const value = await run(false);
		validate?.(value);
		collected.push(value);
	}
	return collected;
}

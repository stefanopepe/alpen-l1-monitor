import type { PublicationAverage, PublicationReport, Settlement } from '../types.js';
import { median, type Estimator } from './naive.js';

/** Complete wallet-funded commit/reveal packages; the latest decoded posting supplies the target. */
export function publicationReport(observations: readonly Settlement[], target: string | undefined, asOf: number,
  cfg: Estimator, complete: boolean): PublicationReport {
  const rows = observations.filter(s => s.blockTime <= asOf && s.blockTime > asOf - cfg.window_days * 86400);
  const published = rows.filter(s => s.complete && s.completedAt !== undefined && s.completedAt <= asOf &&
    s.feeSats !== null && s.weight !== null && s.weight > 0);
  const latest = published.find(s => s.txid === target);
  const rate = (s: Settlement) => 4 * s.feeSats! / s.weight!;
  const average = (days: number): PublicationAverage => {
    // Exclude publications completed after the target, including delayed reveals.
    const sample = latest ? published.filter(s => s.txid !== latest.txid && s.completedAt! < latest.completedAt! &&
      s.completedAt! >= latest.completedAt! - days * 86400) : [];
    // Only claim coverage when the whole comparison window lies inside the scan window.
    const covered = complete && !!latest && latest.completedAt! - days * 86400 >= asOf - cfg.window_days * 86400;
    return { averageSatVb: covered && sample.length ? sample.reduce((sum, s) => sum + rate(s), 0) / sample.length : null,
      sampleSize: sample.length, complete: covered };
  };
  const timed = [...rows].sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
  let clock = timed[0]?.blockTime ?? asOf;
  const intervals = timed.slice(1).map(s => { const next = Math.max(clock, s.blockTime), delta = next - clock; clock = next; return delta; });
  const interval = complete && intervals.length >= cfg.min_intervals ? median(intervals) : null;
  const intervalSeconds = interval && interval > 0 ? interval : null;
  return {
    latest: latest ? { commitTxid: latest.txid, feeSats: latest.feeSats!, feeRateSatVb: rate(latest), previous24h: average(1), previous7d: average(7) } : null,
    intervalSeconds, timingSampleSize: timed.length,
    nextExpectedAt: intervalSeconds !== null && timed.length ? clock + intervalSeconds : null,
  };
}

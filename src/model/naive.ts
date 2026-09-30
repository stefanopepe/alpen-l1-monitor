import type { NaiveRunway, Settlement } from '../types.js';
export interface Estimator { window_days: number; short_window_days: number; min_sample: number; min_sample_short: number; min_intervals: number; min_intervals_short: number }
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2;
}
function cadence(rows: readonly Settlement[], minimum: number): number | null {
  if (rows.length - 1 < minimum) return null;
  const sorted = [...rows].sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
  // Within one block all timestamps are equal, so position cannot change the intervals.
  let t = sorted[0]!.blockTime;
  const intervals = sorted.slice(1).map(s => { const next = Math.max(t, s.blockTime), interval = next - t; t = next; return interval; });
  const m = median(intervals);
  return m && m > 0 ? 86400 / m : null;
}
const maxAvailable = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
export function naiveRunway(spendable: number, balance: number, observations: readonly Settlement[], asOf: number, cfg: Estimator, historyComplete: boolean, discoveryComplete: boolean): NaiveRunway {
  const rows = observations.filter(s => s.blockTime > asOf - cfg.window_days * 86400);
  const short = rows.filter(s => s.blockTime > asOf - cfg.short_window_days * 86400);
  const sample = rows.filter(s => s.complete && s.drainSats !== null);
  const shortSample = short.filter(s => s.complete && s.drainSats !== null);
  const spd = maxAvailable(cadence(rows, cfg.min_intervals), cadence(short, cfg.min_intervals_short));
  const cost = maxAvailable(median(sample.map(s => s.drainSats!)), shortSample.length >= cfg.min_sample_short ? median(shortSample.map(s => s.drainSats!)) : null);
  const reason = !discoveryComplete ? 'discovery_incomplete' : spendable === 0 ? 'no_spendable_funds' : !historyComplete ? 'history_incomplete' : sample.length < cfg.min_sample ? 'insufficient_settlements' : spd === null || !cost ? 'cadence_unavailable' : 'available';
  const drain = reason === 'available' && cost !== null && spd !== null ? cost * spd : null;
  const times = sample.map(s => s.blockTime);
  return { method: 'spendable / (observed median settlement drain * median-interval cadence)',
    days: reason === 'no_spendable_funds' ? 0 : drain ? spendable / drain : null,
    aggregateDays: drain ? balance / drain : null, drainPerDaySats: drain,
    costPerSettlementSats: historyComplete ? cost : null, settlementsPerDay: historyComplete ? spd : null,
    sampleSize: sample.length, sampleSpanDays: times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 86400 : 0,
    historyComplete, reason };
}

import type { Snapshot, Settlement } from '../types.js';
import type { Estimator } from '../model/naive.js';
import type { OutcomeEvent } from './outcomes.js';
export const MODEL_IDS = ['current', 'mean7', 'mean30'] as const;
export type ModelId = typeof MODEL_IDS[number];
export interface Forecast { model: ModelId; dailySats: number | null; reason: string; sampleSize: number }
export interface ReplayRecord { snapshot: Snapshot; forecasts: Forecast[]; trainingRef: string; collected?: boolean }
export interface Evaluation {
  wallet: string; height: number; time: number; horizonDays: number; model: ModelId;
  predictedSats: number | null; actualSats: number | null; errorSats: number | null; reason: string | null;
  outcomeReason: string | null;
  clean: boolean; nonOverlapping: boolean;
}
export interface Score {
  wallet: string; horizonDays: number; model: ModelId; subset: 'all' | 'clean'; sampling: 'daily' | 'non_overlapping';
  origins: number; available: number; scorable: number; matched: number; maeSats: number | null; biasSats: number | null;
  underpredictionRate: number | null; optimisticP90Sats: number | null; skillVsMean7: number | null; skillVsMean30: number | null;
  unavailableReasons: Record<string, number>;
}
export function forecasts(snapshot: Snapshot, rows: readonly Settlement[], asOf: number, cfg: Estimator): Forecast[] {
  const current = snapshot.naiveRunway;
  const all: Forecast[] = [{ model: 'current', dailySats: current.drainPerDaySats, reason: current.reason, sampleSize: current.sampleSize }];
  for (const [model, days, minimum] of [['mean7', 7, cfg.min_sample_short], ['mean30', 30, cfg.min_sample]] as const) {
    const window = rows.filter(s => s.blockTime > asOf - days * 86400);
    const sample = window.filter(s => s.complete && s.drainSats !== null);
    const reason = snapshot.ceilingHit.receive || snapshot.ceilingHit.change ? 'discovery_incomplete' :
      !current.historyComplete ? 'history_incomplete' : sample.length !== window.length ? 'incomplete_reveal_package' :
      sample.length < minimum ? 'insufficient_settlements' : 'available';
    all.push({ model, dailySats: reason === 'available' ? sample.reduce((sum, s) => sum + s.drainSats!, 0) / days : null, reason, sampleSize: sample.length });
  }
  return all;
}
const quantile90 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), p = (sorted.length - 1) * 0.9, i = Math.floor(p);
  return sorted[i]! + (p - i) * ((sorted[i + 1] ?? sorted[i]!) - sorted[i]!);
};
export function evaluate(records: readonly ReplayRecord[], events: readonly OutcomeEvent[], endTime: number) {
  const daily: ReplayRecord[] = [], days = new Set<string>();
  for (const r of records) {
    const key = r.snapshot.wallet + ':' + r.snapshot.asOf.slice(0, 10);
    if (!days.has(key)) { days.add(key); daily.push(r); }
  }
  const evaluations: Evaluation[] = [], lastNonOverlap = new Map<string, number>();
  const exhaustion: { wallet: string; height: number; time: number; elapsedDays: number | null; predictedDays: number | null;
    observedThroughTime: number; followupDays: number; censored: boolean; reason: string }[] = [];
  for (const r of daily) {
    const s = r.snapshot, time = Date.parse(s.asOf) / 1000, future = events.filter(e => e.wallet === s.wallet && e.height > s.tip.height);
    for (const horizonDays of [1, 3, 5, 7]) {
      const end = time + horizonDays * 86400, period = future.filter(e => e.time <= end);
      const reason = end > endTime ? 'future_coverage_incomplete' : period.some(e => e.kind === 'ambiguous') ? 'ambiguous_transaction' :
        period.some(e => e.kind === 'unresolved') ? 'incomplete_reveal_package' : null;
      const actual = reason ? null : period.reduce((sum, e) => sum + (e.drainSats ?? 0), 0);
      const clean = period.every(e => e.kind === 'settlement' || e.kind === 'unresolved');
      const key = s.wallet + ':' + horizonDays, nonOverlapping = time >= (lastNonOverlap.get(key) ?? -Infinity) + horizonDays * 86400;
      if (nonOverlapping) lastNonOverlap.set(key, time);
      for (const f of r.forecasts) {
        const predicted = f.dailySats === null ? null : f.dailySats * horizonDays;
        evaluations.push({ wallet: s.wallet, height: s.tip.height, time, horizonDays, model: f.model, predictedSats: predicted,
          actualSats: actual, errorSats: actual !== null && predicted !== null ? predicted - actual : null,
          reason: f.dailySats === null ? f.reason : reason, outcomeReason: reason, clean, nonOverlapping });
      }
    }
    let sum = 0, elapsedDays: number | null = null, observedThroughTime = endTime, reason = 'archive_end';
    if (s.composition.spendableSats === 0) { reason = 'no_starting_spendable'; observedThroughTime = time; }
    else for (const e of future) {
      if (e.kind !== 'settlement') { reason = e.kind; observedThroughTime = e.time; break; }
      sum += e.drainSats!;
      if (sum >= s.composition.spendableSats) { elapsedDays = (e.time - time) / 86400; observedThroughTime = e.time; reason = 'consumption_crossing'; break; }
    }
    exhaustion.push({ wallet: s.wallet, height: s.tip.height, time, elapsedDays, predictedDays: s.naiveRunway.days,
      observedThroughTime, followupDays: (observedThroughTime - time) / 86400, censored: elapsedDays === null, reason });
  }
  const scores: Score[] = [];
  for (const wallet of [...new Set(records.map(r => r.snapshot.wallet))]) for (const horizonDays of [1, 3, 5, 7])
    for (const subset of ['all', 'clean'] as const) for (const sampling of ['daily', 'non_overlapping'] as const) {
      const rows = evaluations.filter(e => e.wallet === wallet && e.horizonDays === horizonDays && (subset === 'all' || e.clean) && (sampling === 'daily' || e.nonOverlapping));
      const matchedHeights = new Set(rows.filter(e => e.errorSats !== null).map(e => e.height).filter(h => MODEL_IDS.every(m => rows.some(e => e.height === h && e.model === m && e.errorSats !== null))));
      const maes = new Map<ModelId, number>();
      for (const model of MODEL_IDS) {
        const matched = rows.filter(e => e.model === model && matchedHeights.has(e.height));
        if (matched.length) maes.set(model, matched.reduce((sum, e) => sum + Math.abs(e.errorSats!), 0) / matched.length);
      }
      for (const model of MODEL_IDS) {
        const own = rows.filter(e => e.model === model), matched = own.filter(e => matchedHeights.has(e.height));
        const errors = matched.map(e => e.errorSats!), mae = maes.get(model) ?? null, reasons: Record<string, number> = {};
        for (const row of own) if (row.reason) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
        const skill = (baseline: ModelId) => mae === null || !maes.get(baseline) ? null : 1 - mae / maes.get(baseline)!;
        scores.push({ wallet, horizonDays, model, subset, sampling, origins: own.length, available: own.filter(e => e.predictedSats !== null).length,
          scorable: own.filter(e => e.errorSats !== null).length, matched: matched.length, maeSats: mae,
          biasSats: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
          underpredictionRate: errors.length ? errors.filter(e => e < 0).length / errors.length : null,
          optimisticP90Sats: errors.length ? quantile90(errors.map(e => Math.max(0, -e))) : null,
          skillVsMean7: skill('mean7'), skillVsMean30: skill('mean30'), unavailableReasons: reasons });
      }
    }
  return { evaluations, scores, exhaustion };
}

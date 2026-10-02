import type { ModelId, ReplayRecord } from '../evaluate.js';
export interface BalancePoint { x: number; y: number; height?: number }
export interface Burndown {
  origin: number; balance: number; dailySats: number | null; depletion: number | null;
  from: number; to: number; recordedThrough: number; actual: BalancePoint[]; projected: BalancePoint[];
}

// Chart-only projection. It never feeds reconstructed predictions or audit scores.
export function buildBurndown(rows: readonly ReplayRecord[], selected: ReplayRecord, model: ModelId): Burndown {
  const day = 86400000, origin = Date.parse(selected.snapshot.asOf), balance = selected.snapshot.composition.spendableSats;
  const estimate = selected.forecasts.find(f => f.model === model)?.dailySats ?? null;
  const dailySats = estimate !== null && Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
  const projectedTime = dailySats && dailySats > 0 ? origin + balance / dailySats * day : null;
  const depletion = balance === 0 ? origin : projectedTime !== null && Number.isFinite(projectedTime) && projectedTime < 8.64e15 ? projectedTime : null;
  const first = Date.parse(rows[0]!.snapshot.asOf), recordedThrough = Date.parse(rows.at(-1)!.snapshot.asOf);
  const from = Math.max(first, origin - 7 * day);
  const end = Math.max(origin + 7 * day, depletion ?? origin);
  const to = end + Math.max(day / 2, (end - from) * 0.06);
  const visible = rows.filter(r => Date.parse(r.snapshot.asOf) >= from && Date.parse(r.snapshot.asOf) <= to);
  // Preserve every balance change and both endpoints; a stepped line must not smear deposits across time.
  const actual = visible.flatMap((r, i) => i === 0 || i === visible.length - 1 ||
    r.snapshot.composition.spendableSats !== visible[i - 1]!.snapshot.composition.spendableSats ||
    r.snapshot.tip.height === selected.snapshot.tip.height ?
    [{ x: Date.parse(r.snapshot.asOf), y: r.snapshot.composition.spendableSats, height: r.snapshot.tip.height }] : []);
  const projected = depletion === null ? dailySats === 0 ? [{ x: origin, y: balance }, { x: to, y: balance }] : [] :
    [{ x: origin, y: balance }, { x: depletion, y: 0 }];
  return { origin, balance, dailySats, depletion, from, to, recordedThrough, actual, projected };
}

import type { ModelId, ReplayRecord } from '../evaluate.js';
import { fundingBalance } from '../../model/composition.js';
export interface BalancePoint { x: number; y: number | null; height?: number }
export interface Burndown {
  origin: number; balance: number; dailySats: number | null; depletion: number | null;
  from: number; to: number; recordedThrough: number; actual: BalancePoint[]; projected: BalancePoint[];
}

// Historical replay has no mempool archive; preserve its confirmed-chain evidence.
export function recordBalance(r: ReplayRecord): number {
  return r.collected ? fundingBalance(r.snapshot.composition) : r.snapshot.composition.spendableSats;
}

// Chart-only projection. It never feeds reconstructed predictions or audit scores.
export function buildBurndown(rows: readonly ReplayRecord[], selected: ReplayRecord, model: ModelId): Burndown {
  const day = 86400000, origin = Date.parse(selected.snapshot.asOf), balance = recordBalance(selected);
  const estimate = selected.forecasts.find(f => f.model === model)?.dailySats ?? null;
  const dailySats = estimate !== null && Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
  const projectedTime = dailySats && dailySats > 0 ? origin + balance / dailySats * day : null;
  const depletion = balance === 0 ? origin : projectedTime !== null && Number.isFinite(projectedTime) && projectedTime < 8.64e15 ? projectedTime : null;
  const first = Date.parse(rows[0]!.snapshot.asOf), recordedThrough = Date.parse(rows.at(-1)!.snapshot.asOf);
  const from = Math.max(first, origin - 7 * day);
  const end = Math.max(origin + 7 * day, depletion ?? origin);
  const to = end + Math.max(day / 2, (end - from) * 0.06);
  // Retain the whole history for zooming. Only gaps between raw collected samples
  // are missing evidence; an unchanged historical balance is still known.
  const actual: BalancePoint[] = [];
  const point = (r: ReplayRecord) => ({ x: Date.parse(r.snapshot.asOf), y: recordBalance(r), height: r.snapshot.tip.height });
  for (const [i, r] of rows.entries()) {
    const previous = rows[i - 1];
    const gap = previous && (r.collected || previous.collected) && Date.parse(r.snapshot.asOf) - Date.parse(previous.snapshot.asOf) > 2 * 3600000;
    if (gap) {
      if (actual.at(-1)?.x !== Date.parse(previous.snapshot.asOf)) actual.push(point(previous));
      actual.push({ x: Date.parse(previous.snapshot.asOf) + 1, y: null });
    }
    if (!previous || i === rows.length - 1 || gap || r.collected || previous.collected || recordBalance(r) !== recordBalance(previous) || r === selected)
      actual.push(point(r));
  }
  const projected = depletion === null ? dailySats === 0 ? [{ x: origin, y: balance }, { x: to, y: balance }] : [] :
    [{ x: origin, y: balance }, { x: depletion, y: 0 }];
  return { origin, balance, dailySats, depletion, from, to, recordedThrough, actual, projected };
}

import type { FeeEvaluation } from './schema.js';
import { DAY } from './model.js';

export const mean = (values: readonly number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export const pinball = (actual: number, predicted: number, q: number) => (actual - predicted) * (actual >= predicted ? q : q - 1);
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * q, i = Math.floor(pos);
  return sorted[i]! + (pos - i) * ((sorted[i + 1] ?? sorted[i]!) - sorted[i]!);
}
// Conservative overlap cap plus positive serial-correlation design effect. This is
// a diagnostic approximation, not independent Bernoulli trials or a guarantee.
export function effectiveSamples(rows: readonly FeeEvaluation[]): number {
  if (!rows.length) return 0;
  const ordered = [...rows].sort((a, b) => a.origin - b.origin);
  let lastEnd = -Infinity, disjoint = 0;
  for (const r of ordered) if (r.origin >= lastEnd) { disjoint++; lastEnd = r.end; }
  const errors = ordered.map(e => Math.log1p(e.actual!) - Math.log1p(e.central!));
  const center = mean(errors)!, variance = errors.reduce((s, e) => s + (e - center) ** 2, 0);
  let inflation = 1;
  for (let lag = 1; lag <= Math.min(14, Math.floor(errors.length / 4)); lag++) {
    const covariance = errors.slice(lag).reduce((s, e, i) => s + (e - center) * (errors[i]! - center), 0);
    const rho = variance > 0 ? covariance / variance : 0;
    if (rho <= 0) break;
    inflation += 2 * rho;
  }
  return Math.max(1, Math.min(disjoint, rows.length / inflation));
}
export function coverageInterval(coverage: number | null, effective: number): [number, number] | null {
  if (coverage === null || effective === 0) return null;
  const z = 1.96, denom = 1 + z * z / effective;
  const center = (coverage + z * z / (2 * effective)) / denom;
  const half = z * Math.sqrt(coverage * (1 - coverage) / effective + z * z / (4 * effective ** 2)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function diagnosticGroups(origin: number, regime: string): string[] {
  const date = new Date(origin * 1000);
  const offset = (zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')!.value;
  return ['regime:' + regime, 'year:' + date.getUTCFullYear(), 'Europe/London:' + offset('Europe/London'), 'America/New_York:' + offset('America/New_York')];
}
export const completedBefore = (e: FeeEvaluation, origin: number, days: number) =>
  e.end <= origin && (e.outcomeAvailableAt ?? e.end) <= origin && e.origin >= origin - days * DAY;

import type { FeeForecastSnapshot, FeeStudy } from '../schema.js';

export function currentFeeFresh(study: FeeStudy, now = Date.now() / 1000): boolean {
  return now >= study.asOf && now - study.asOf <= 2 * 3600 && now >= study.coverage.end && now - study.coverage.end <= 3 * 3600;
}

// Only saved, causal forecasts can be joined. Never show a later study's current
// curve under an earlier block label or recalibrate it using hindsight scores.
export function forecastAt(study: FeeStudy, time: number): FeeForecastSnapshot | null {
  return study.timeline?.filter(s => s.origin <= time).sort((a, b) => b.origin - a.origin)[0] ?? null;
}
export function forecastOutlook(forecasts: FeeStudy['forecasts']) {
  const seasonal = forecasts.find(f => f.model === 'seasonal'), baseline = forecasts.find(f => f.model === 'baseline');
  if (!seasonal?.points.length || !baseline?.points.length) return null;
  const periods = seasonal.points.slice(0, -5).map((p, i) => ({ time: p.time,
    central: seasonal.points.slice(i, i + 6).reduce((s, p) => s + p.central, 0) / 6 }));
  const sorted = [...periods].sort((a, b) => a.central - b.central);
  return { current: baseline.points[0]!.central, quiet: sorted[0]!, busy: sorted.at(-1)! };
}

import { expect, it } from 'vitest';
import { DAY, HOUR, dot, fitFeeModel, forecastCurve, intervalOutcome, latestPressure, seasonalFeatures, weekday } from '../src/fees/model.js';
import { calibrate, scoreFees } from '../src/fees/study.js';
import { feeModelConfigSchema, type FeeBucket, type FeeEvaluation, type FeePressure } from '../src/fees/schema.js';

const start = Date.parse('2024-01-01T00:00:00Z') / 1000;
const cfg = feeModelConfigSchema.parse({ seasonalRidge: 0.01 });
function history(days = 140): FeeBucket[] {
  return Array.from({ length: days * 24 }, (_, h) => {
    const time = start + h * HOUR;
    const level = 2 + Math.floor(h / (24 * 7)) * 0.015;
    const season = (weekday(time) < 5 ? 0.18 : -0.45) + 0.4 * Math.sin(2 * Math.PI * (h % 24 + 0.5) / 24);
    return { start: time, end: time + HOUR, rate: Math.expm1(level + season), source: 'synthetic' };
  });
}
function pressure(time: number, rate = 40): FeePressure {
  return { observedAt: new Date(time * 1000).toISOString(), status: 'available', blocks: [
    { blockVSize: 999000, medianFee: rate, feeRange: [rate / 2, rate] },
    { blockVSize: 30_000_000, medianFee: 0.1, feeRange: [0.1] },
  ], error: null };
}
it('learns a weekly/hourly shape despite changing weekly levels and improves unseen forecasts', () => {
  const buckets = history(), origin = start + 126 * DAY, fit = fitFeeModel(buckets, origin, cfg);
  const flat = forecastCurve(fit, 'baseline', null, cfg).points;
  const seasonal = forecastCurve(fit, 'seasonal', null, cfg).points;
  const actual = buckets.filter(b => b.start >= origin).slice(0, 168);
  const mae = (points: typeof flat) => points.reduce((sum, p, i) => sum + Math.abs(p.central - actual[i]!.rate), 0) / points.length;
  expect(mae(seasonal)).toBeLessThan(mae(flat) * 0.2);
  expect(Math.exp(dot(seasonalFeatures(origin, origin + HOUR), fit.coefficients))).toBeGreaterThan(1);
});
it('does not change an issued forecast when future fees or unfinished buckets change', () => {
  const buckets = history(), origin = start + 100 * DAY;
  const fit = fitFeeModel(buckets, origin, cfg);
  const poisoned = buckets.map(b => b.end <= origin ? b : { ...b, rate: 1e8 });
  expect(fitFeeModel(poisoned, origin, cfg)).toEqual(fit);
  expect(fitFeeModel(buckets.filter(b => b.end <= origin), origin, cfg)).toEqual(fit);
});
it('integrates coarse observations rather than assigning them to an arbitrary hour', () => {
  const broad = seasonalFeatures(start, start + 12 * HOUR);
  const fine = Array.from({ length: 12 }, (_, h) => seasonalFeatures(start + h * HOUR, start + (h + 1) * HOUR));
  broad.forEach((v, i) => expect(v).toBeCloseTo(fine.reduce((s, f) => s + f[i]!, 0) / 12, 12));
  const fullDay = seasonalFeatures(start, start + DAY);
  expect(fullDay.slice(6).every(x => Math.abs(x) < 1e-12)).toBe(true);
});
it('withholds a seasonal forecast during warmup and all forecasts when recent coverage is missing', () => {
  const buckets = history(20), fit = fitFeeModel(buckets, start + 20 * DAY, cfg);
  expect(forecastCurve(fit, 'baseline', null, cfg).points).toHaveLength(168);
  expect(forecastCurve(fit, 'seasonal', null, cfg).reason).toBe('seasonal_warmup');
  expect(fitFeeModel(buckets, start + 23 * DAY, cfg).baseline).toBeNull();
});
it('rejects future/stale/failed pressure, excludes overflow buckets and lets a shock decay', () => {
  const origin = start + 126 * DAY, fit = fitFeeModel(history(), origin, cfg), p = pressure(origin);
  expect(latestPressure([pressure(origin + 1)], origin, 1800)).toBeNull();
  expect(latestPressure([pressure(origin - 1801)], origin, 1800)).toBeNull();
  expect(latestPressure([pressure(origin - 10), { ...p, status: 'unavailable', blocks: null, error: 'E_PRESSURE_HTTP' }], origin, 1800)).toBeNull();
  expect(forecastCurve(fit, 'pressure', null, cfg).points).toEqual([]);
  const season = forecastCurve(fit, 'seasonal', null, cfg).points;
  const shock = forecastCurve(fit, 'pressure', p, cfg).points;
  expect(shock[0]!.central).toBeGreaterThan(season[0]!.central * 2);
  expect(shock.at(-1)!.central).toBeCloseTo(season.at(-1)!.central, 5);
  expect(forecastCurve(fit, 'pressure', { ...p, blocks: [p.blocks![0]!] }, cfg)).toEqual(forecastCurve(fit, 'pressure', p, cfg));
});
it('does not score partial buckets or fill missing outcomes with zero', () => {
  const buckets = history(2);
  expect(intervalOutcome(buckets, start + HOUR / 2, start + HOUR)).toEqual({ rate: null, coverage: 0 });
  expect(intervalOutcome(buckets.filter((_, i) => i >= 2), start, start + DAY).rate).toBeNull();
  expect(intervalOutcome(buckets, start, start + DAY).rate).not.toBeNull();
});
it('calibrates p50/p90 only from resolved earlier outcomes, without treating a block p90 as a forecast p90', () => {
  const origin = start + 100 * DAY;
  const rows: FeeEvaluation[] = Array.from({ length: 35 }, (_, i) => ({ origin: origin - (i + 2) * DAY, end: origin - (i + 1) * DAY,
    horizonDays: 1, model: 'seasonal', central: 2, p50: null, p90: null, actual: 4, actualCoverage: 1, calibrationSamples: 0, reason: null, nonOverlapping: true }));
  const future = { ...rows[0]!, end: origin + DAY, actual: 1000 };
  const result = calibrate([...rows, future], origin, 'seasonal', 1, 2, cfg);
  expect(result.calibrationSamples).toBe(35); expect(result.p50).toBeCloseTo(4); expect(result.p90).toBeCloseTo(4);
  expect(calibrate(rows.slice(0, 10), origin, 'seasonal', 1, 2, cfg).p90).toBeNull();
  expect(calibrate(rows, origin, 'pressure', 1, 2, cfg).p90).toBeNull();
});
it('compares pressure with baseline only on its own matched origins', () => {
  const base: FeeEvaluation = { origin: start, end: start + DAY, horizonDays: 1, model: 'baseline', central: 5, p50: null, p90: null,
    actual: 10, actualCoverage: 1, calibrationSamples: 0, reason: null, nonOverlapping: true };
  const scores = scoreFees([base, { ...base, origin: start + DAY, end: start + 2 * DAY, central: 500 }, { ...base, model: 'pressure', central: 9 }]);
  expect(scores.find(s => s.model === 'pressure' && s.sampling === 'daily' && s.horizonDays === 1)).toMatchObject({ matched: 1, mae: 1, skillVsBaseline: 0.8 });
});

import type { FeeBucket, FeeModelConfig, FeeModelId, FeePressure, FeeForecastPoint } from './schema.js';

export const DAY = 86400, HOUR = 3600, WEEK = 7 * DAY;
const DIMENSIONS = 14;
export const weekday = (time: number) => ((Math.floor(time / DAY) + 3) % 7 + 7) % 7;
export const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);
export const availableAt = (b: FeeBucket) => Math.max(b.end, b.availableAt ?? b.end);
export const knownBuckets = (buckets: readonly FeeBucket[], origin: number) => buckets.filter(b => availableAt(b) <= origin);
export const demandRegime = (rate: number | null) => rate === null ? 'unknown' : rate < 1 ? 'low' : rate < 10 ? 'normal' : 'high';
export function knownPressure(observations: readonly FeePressure[], origin: number): FeePressure[] {
  return observations.filter(p => Date.parse(p.observedAt) / 1000 <= origin).map(p => {
    if (!p.blockFullness || Date.parse(p.blockFullness.observedAt) / 1000 <= origin) return p;
    const copy = { ...p }; delete copy.blockFullness; return copy;
  });
}
export function pressureObservation(observations: readonly FeePressure[], origin: number): FeePressure | null {
  return knownPressure(observations, origin)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || Number(b.status === 'unavailable') - Number(a.status === 'unavailable'))[0] ?? null;
}
export function pressureState(observations: readonly FeePressure[], origin: number, freshness: number): string {
  const latest = pressureObservation(observations, origin);
  return !latest ? 'missing' : latest.status !== 'available' ? 'provider_failed' : origin - Date.parse(latest.observedAt) / 1000 > freshness ? 'stale' : 'available_unvalidated';
}

// Integrate the seasonal basis over each observed bucket. An old 12-hour average
// never becomes twelve independent hourly samples or one midnight observation.
export function seasonalFeatures(start: number, end: number): number[] {
  const result = Array<number>(DIMENSIONS).fill(0), duration = end - start;
  if (!(duration > 0)) throw new Error('E_FEE_MODEL_INTERVAL');
  for (let left = start; left < end;) {
    const right = Math.min(end, (Math.floor(left / DAY) + 1) * DAY), share = (right - left) / duration, dow = weekday(left);
    for (let d = 0; d < 6; d++) result[d]! += share * (dow === d ? 1 : dow === 6 ? -1 : 0);
    for (let k = 1; k <= 3; k++) {
      const omega = 2 * Math.PI * k / DAY;
      const a = (left % DAY) * omega, b = a + (right - left) * omega;
      const sin = (Math.cos(a) - Math.cos(b)) / omega / duration;
      const cos = (Math.sin(b) - Math.sin(a)) / omega / duration;
      result[6 + (k - 1) * 2]! += sin; result[7 + (k - 1) * 2]! += cos;
      if (k === 1) { result[12]! += sin * (dow < 5 ? 2 / 7 : -5 / 7); result[13]! += cos * (dow < 5 ? 2 / 7 : -5 / 7); }
    }
    left = right;
  }
  return result;
}
function solve(matrix: number[][], vector: number[]): number[] {
  const a = matrix.map((row, i) => [...row, vector[i]!]), n = vector.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j]![i]!) > Math.abs(a[pivot]![i]!)) pivot = j;
    [a[i], a[pivot]] = [a[pivot]!, a[i]!];
    if (Math.abs(a[i]![i]!) < 1e-12) throw new Error('E_FEE_MODEL_SINGULAR');
    const scale = a[i]![i]!;
    for (let k = i; k <= n; k++) a[i]![k]! /= scale;
    for (let j = 0; j < n; j++) if (j !== i) {
      const m = a[j]![i]!;
      for (let k = i; k <= n; k++) a[j]![k]! -= m * a[i]![k]!;
    }
  }
  return a.map(row => row[n]!);
}
export interface FittedFees {
  origin: number; baseline: number | null; seasonalLevel: number | null;
  coefficients: number[]; trainingBuckets: number; trainingDays: number;
  rolling: number | null; ewma: number | null; weekdayHour: (number | null)[];
  baselineReason: string | null; seasonalReason: string | null;
}
export function fitFeeModel(buckets: readonly FeeBucket[], origin: number, cfg: FeeModelConfig): FittedFees {
  const rows = buckets.filter(b => availableAt(b) <= origin && b.start >= origin - cfg.trainingDays * DAY);
  const recent = rows.filter(b => b.end > origin - cfg.baselineDays * DAY);
  const recentSeconds = recent.reduce((s, b) => s + b.end - Math.max(b.start, origin - cfg.baselineDays * DAY), 0);
  const trainingDays = rows.reduce((s, b) => s + b.end - b.start, 0) / DAY;
  const baselineReason = recentSeconds < cfg.baselineDays * DAY * 0.8 || !recent.length || origin - recent.at(-1)!.end > DAY ? 'recent_history_incomplete' : null;
  const seasonalReason = baselineReason ?? (trainingDays < cfg.minTrainingDays ? 'seasonal_warmup' : null);
  const weightedRecent = (coef: number[]) => recent.reduce((sum, b) => sum +
    (b.end - Math.max(b.start, origin - cfg.baselineDays * DAY)) * (Math.log1p(b.rate) - dot(seasonalFeatures(b.start, b.end), coef)), 0) / recentSeconds;
  let coefficients = Array<number>(DIMENSIONS).fill(0);
  const baseline = baselineReason ? null : weightedRecent(coefficients);
  if (!seasonalReason) {
    // Remove each observed week's level using ONLY buckets known at this origin.
    // Center the design as well as the response to avoid partial-week bias.
    const weeks = new Map<number, { seconds: number; log: number; features: number[] }>();
    const training = rows.map(b => {
      const key = Math.floor((b.start + 3 * DAY) / WEEK), seconds = b.end - b.start, features = seasonalFeatures(b.start, b.end);
      const week = weeks.get(key) ?? { seconds: 0, log: 0, features: Array<number>(DIMENSIONS).fill(0) };
      week.seconds += seconds; week.log += seconds * Math.log1p(b.rate);
      features.forEach((x, i) => { week.features[i]! += seconds * x; }); weeks.set(key, week);
      return { b, key, seconds, features };
    });
    const matrix = Array.from({ length: DIMENSIONS }, (_, i) => Array.from({ length: DIMENSIONS }, (_, j) => i === j ? cfg.seasonalRidge : 0));
    const vector = Array<number>(DIMENSIONS).fill(0);
    for (const { b, key, seconds, features } of training) {
      const week = weeks.get(key)!;
      if (week.seconds < 3 * DAY) continue;
      const y = Math.log1p(b.rate) - week.log / week.seconds;
      const x = features.map((v, i) => v - week.features[i]! / week.seconds);
      const weight = seconds / DAY * 2 ** (-(origin - b.end) / DAY / cfg.seasonalHalfLifeDays);
      for (let i = 0; i < DIMENSIONS; i++) {
        vector[i]! += weight * x[i]! * y;
        for (let j = 0; j < DIMENSIONS; j++) matrix[i]![j]! += weight * x[i]! * x[j]!;
      }
    }
    coefficients = solve(matrix, vector);
  }
  const rolling = baselineReason ? null : recent.reduce((s, b) => s + b.rate * (b.end - Math.max(b.start, origin - cfg.baselineDays * DAY)), 0) / recentSeconds;
  const weights = recent.map(b => (b.end - Math.max(b.start, origin - cfg.baselineDays * DAY)) * 2 ** (-(origin - b.end) / DAY / cfg.ewmaHalfLifeDays));
  const ewma = baselineReason ? null : recent.reduce((s, b, i) => s + weights[i]! * b.rate, 0) / weights.reduce((a, b) => a + b, 0);
  // Same UTC weekday/hour over the preceding four weeks. Integrate coarse buckets;
  // require three matching slots and never invent hourly observations from gaps.
  const matchingRows = rows.filter(b => b.end > origin - 4 * WEEK);
  const weekdayHour = Array.from({ length: 168 }, (_, hour) => {
    const slot = origin + (hour % 168) * HOUR;
    const rates: number[] = [];
    for (let week = 1; week <= 4; week++) {
      const from = slot - week * WEEK;
      if (from + HOUR > origin) continue;
      const sample = matchingRows.filter(b => b.start < from + HOUR && b.end > from);
      const seconds = sample.reduce((s, b) => s + Math.min(b.end, from + HOUR) - Math.max(b.start, from), 0);
      if (seconds >= HOUR) rates.push(sample.reduce((s, b) => s + b.rate * (Math.min(b.end, from + HOUR) - Math.max(b.start, from)), 0) / seconds);
    }
    return rates.length >= 3 ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  });
  return { origin, baseline, rolling, ewma, weekdayHour, seasonalLevel: seasonalReason ? null : weightedRecent(coefficients), coefficients,
    trainingBuckets: rows.length, trainingDays, baselineReason, seasonalReason };
}

export function latestPressure(observations: readonly FeePressure[], origin: number, freshness: number): FeePressure | null {
  // A failed newer observation supersedes an older successful observation.
  const observed = pressureObservation(observations, origin);
  const p = observed ? { ...observed, ...(observed.blockFullness && Date.parse(observed.blockFullness.observedAt) / 1000 > origin ? { blockFullness: undefined } : {}) } : null;
  return p?.status === 'available' && origin - Date.parse(p.observedAt) / 1000 <= freshness ? p : null;
}
export function forecastCurve(fit: FittedFees, model: FeeModelId, pressure: FeePressure | null, cfg: FeeModelConfig, hours = 168): { reason: string | null; points: FeeForecastPoint[] } {
  const reason = ['baseline', 'rolling', 'ewma', 'weekday_hour'].includes(model) ? fit.baselineReason ?? (model === 'weekday_hour' && fit.weekdayHour.some(v => v === null) ? 'weekday_hour_history_incomplete' : null) : fit.seasonalReason ?? (model === 'pressure' && !pressure ? 'pressure_history_unavailable' : null);
  if (reason) return { reason, points: [] };
  let correction = 0;
  if (model === 'pressure') {
    // The final projected bucket can contain many blocks; never treat it as one.
    const blocks = pressure!.blocks!.filter(b => b.blockVSize > 0 && b.blockVSize <= 1_000_000).slice(0, 3);
    if (!blocks.length) return { reason: 'pressure_projection_unavailable', points: [] };
    const total = blocks.reduce((s, b) => s + b.blockVSize, 0);
    const signal = blocks.reduce((s, b) => s + b.blockVSize * Math.log1p(b.medianFee), 0) / total;
    if (cfg.pressureFullnessWeight > 0 && (!pressure!.blockFullness || Date.parse(pressure!.blockFullness.observedAt) / 1000 > fit.origin || fit.origin - Date.parse(pressure!.blockFullness.observedAt) / 1000 > cfg.pressureFreshnessSeconds)) return { reason: 'pressure_fullness_unavailable', points: [] };
    const backlog = Math.log1p(pressure!.blocks!.reduce((s, b) => s + b.blockVSize, 0) / 1_000_000);
    correction = cfg.pressureBacklogWeight * backlog + cfg.pressureFullnessWeight * ((pressure!.blockFullness?.ratio ?? 0.95) - 0.95) + cfg.pressureStrength * (signal - (fit.seasonalLevel! + dot(seasonalFeatures(fit.origin, fit.origin + HOUR), fit.coefficients)));
  }
  const points = Array.from({ length: hours }, (_, hour) => {
    const time = fit.origin + hour * HOUR, season = dot(seasonalFeatures(time, time + HOUR), fit.coefficients);
    const log = model === 'baseline' ? fit.baseline! : fit.seasonalLevel! + season + correction * 2 ** (-(hour + 0.5) / cfg.pressureHalfLifeHours);
    const central = model === 'rolling' ? fit.rolling! : model === 'ewma' ? fit.ewma! : model === 'weekday_hour' ? fit.weekdayHour[hour % 168]! : Math.max(0, Math.expm1(log));
    if (!Number.isFinite(central)) throw new Error('E_FEE_MODEL_NONFINITE');
    return { time, central };
  });
  return { reason: null, points };
}

export function intervalOutcome(buckets: readonly FeeBucket[], start: number, end: number): { rate: number | null; coverage: number } {
  let seconds = 0, total = 0;
  for (const b of buckets) {
    if (b.start >= end) break;
    if (b.end <= start) continue;
    // No partial use of a bucket ending after the outcome window: that would
    // incorporate fees paid outside the period being scored.
    if (b.start < start || b.end > end) continue;
    const duration = b.end - b.start;
    seconds += duration; total += duration * b.rate;
  }
  const coverage = seconds / (end - start);
  return { rate: coverage >= 0.95 && seconds > 0 ? total / seconds : null, coverage };
}

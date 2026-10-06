import { implementationProvenance } from '../replay/provenance.js';
import { digest } from '../replay/archive.js';
import { validateBuckets } from './archive.js';
import { DAY, HOUR, dot, fitFeeModel, forecastCurve, intervalOutcome, latestPressure, seasonalFeatures, weekday, knownBuckets, knownPressure, demandRegime, pressureState, pressureObservation, availableAt } from './model.js';
import { MODEL_IDS, feeModelConfigSchema, feePressureSchema, type FeeArchive, type FeeEvaluation, type FeeModelConfig,
  type FeeBucket, type FeeModelId, type FeePressure, type FeeScore, type FeeStudy } from './schema.js';

import { mean as average, quantile, effectiveSamples, coverageInterval, pinball, diagnosticGroups } from './statistics.js';
export { quantile } from './statistics.js';
export const HORIZONS = [1, 3, 5, 7] as const;
export function calibrate(history: readonly FeeEvaluation[], origin: number, model: FeeModelId, horizonDays: number, central: number, cfg: FeeModelConfig, buckets?: readonly FeeBucket[], regime?: string) {
  const known = buckets ? knownBuckets(buckets, origin) : null;
  const resolved = history.filter(e => e.model === model && e.horizonDays === horizonDays && e.end <= origin &&
    e.origin >= origin - cfg.calibrationDays * DAY && e.central !== null)
    .map(e => known ? { ...e, actual: intervalOutcome(known, e.origin, e.end).rate } : e)
    .filter(e => e.actual !== null && (known || (e.outcomeAvailableAt ?? e.end) <= origin));
  const residuals = (rows: typeof resolved) => rows.map(e => Math.log1p(e.actual!) - Math.log1p(e.central!));
  const value = (rows: typeof resolved, q: number) => rows.length >= cfg.minCalibrationSamples
    ? Math.max(0, Math.expm1(Math.log1p(central) + quantile(residuals(rows), q)!)) : null;
  const sameRegime = resolved.filter(e => e.regime === regime);
  const effective = effectiveSamples(resolved);
  const preceding = resolved.filter(e => e.p50 !== null && e.p90 !== null);
  const priorP50Coverage = average(preceding.map(e => Number(e.actual! <= e.p50!))), priorP90Coverage = average(preceding.map(e => Number(e.actual! <= e.p90!)));
  return { p50: value(resolved, 0.5), p90: value(resolved, 0.9), calibrationSamples: resolved.length,
    effectiveCalibrationSamples: effective, calibrationState: resolved.length < cfg.minCalibrationSamples ? 'insufficient_calibration' : preceding.length >= 20 && priorP90Coverage! < 0.85 ? 'coverage_deteriorated' : 'experimental',
    priorP50Coverage, priorP90Coverage, priorCoverageSamples: preceding.length,
    regimeP50: value(sameRegime, 0.5), regimeP90: value(sameRegime, 0.9) };
}
export function scoreFees(evaluations: readonly FeeEvaluation[]): FeeScore[] {
  const scores: FeeScore[] = [];
  for (const horizonDays of HORIZONS) for (const sampling of ['daily', 'non_overlapping'] as const) {
    const rows = evaluations.filter(e => e.horizonDays === horizonDays && (sampling === 'daily' || e.nonOverlapping));
    for (const model of MODEL_IDS) {
      const own = rows.filter(e => e.model === model), available = own.filter(e => e.central !== null);
      const scored = available.filter(e => e.actual !== null);
      const matched = scored.filter(e => rows.some(b => b.model === 'baseline' && b.origin === e.origin && b.central !== null && b.actual !== null));
      const errors = matched.map(e => e.central! - e.actual!);
      const baselineErrors = matched.map(e => { const b = rows.find(b => b.model === 'baseline' && b.origin === e.origin)!; return Math.abs(b.central! - b.actual!); });
      const mae = average(errors.map(Math.abs)), baseMae = average(baselineErrors);
      const calibrated = matched.filter(e => e.p90 !== null), medians = matched.filter(e => e.p50 !== null);
      const effective = effectiveSamples(calibrated), regimes = matched.filter(e => e.regimeP90 != null && e.regimeP50 != null && e.p50 !== null && e.p90 !== null);
      const seasonalPairs = scored.flatMap(e => { const ref = rows.find(b => b.model === 'seasonal' && b.origin === e.origin && b.central !== null && b.actual !== null); return ref ? [{ own: e, ref }] : []; });
      const seasonalMae = average(seasonalPairs.map(p => Math.abs(p.ref.central! - p.ref.actual!)));
      const pressureMae = average(seasonalPairs.map(p => Math.abs(p.own.central! - p.own.actual!)));
      const p50Coverage = average(medians.map(e => Number(e.actual! <= e.p50!))), p90Coverage = average(calibrated.map(e => Number(e.actual! <= e.p90!)));
      scores.push({ model, horizonDays, sampling, origins: own.length, available: available.length, scored: scored.length, matched: matched.length,
        mae, bias: average(errors), skillVsBaseline: mae !== null && baseMae !== null && baseMae > 0 ? 1 - mae / baseMae : null,
        p50Samples: medians.length, p50Coverage: average(medians.map(e => Number(e.actual! <= e.p50!))),
        p90Samples: calibrated.length, p90Coverage: average(calibrated.map(e => Number(e.actual! <= e.p90!))),
        p90Pinball: average(calibrated.map(e => pinball(e.actual!, e.p90!, 0.9))),
        p50Pinball: average(medians.map(e => pinball(e.actual!, e.p50!, 0.5))), effectiveSamples: effective,
        p50Interval: coverageInterval(p50Coverage, effectiveSamples(medians)), p90Interval: coverageInterval(p90Coverage, effective),
        skillVsSeasonal: seasonalMae && pressureMae !== null ? 1 - pressureMae / seasonalMae : null, pressureMatched: seasonalPairs.length,
        regimeP50Coverage: average(regimes.map(e => Number(e.actual! <= e.regimeP50!))), regimeP90Coverage: average(regimes.map(e => Number(e.actual! <= e.regimeP90!))),
        regimeP50Pinball: average(regimes.map(e => pinball(e.actual!, e.regimeP50!, 0.5))), regimeP90Pinball: average(regimes.map(e => pinball(e.actual!, e.regimeP90!, 0.9))), regimeSamples: regimes.length,
        rollingP50OnRegime: average(regimes.map(e => pinball(e.actual!, e.p50!, 0.5))), rollingP90OnRegime: average(regimes.map(e => pinball(e.actual!, e.p90!, 0.9))),
        rollingP50CoverageOnRegime: average(regimes.map(e => Number(e.actual! <= e.p50!))), rollingP90CoverageOnRegime: average(regimes.map(e => Number(e.actual! <= e.p90!))),
        uncertaintyState: calibrated.length < 30 || effective < 20 ? 'insufficient_evidence' : p90Coverage! < 0.85 ? 'coverage_deteriorated' : 'experimental' });
    }
  }
  return scores;
}
export function runFeeStudy(archive: FeeArchive, observations: readonly FeePressure[], config: FeeModelConfig, asOf: number, progress?: (s: string) => void, evaluationStart?: number, sourceSha256?: string): FeeStudy {
  const cfg = feeModelConfigSchema.parse(config);
  validateBuckets(archive.buckets);
  if (!Number.isSafeInteger(asOf) || asOf <= archive.buckets[0]!.start) throw new Error('E_FEES_AS_OF');
  const buckets = knownBuckets(archive.buckets, asOf);
  if (!buckets.length) throw new Error('E_FEE_HISTORY_EMPTY');
  const pressure = knownPressure(observations.map(p => feePressureSchema.parse(p)), asOf);
  const scoreStart = evaluationStart ?? asOf - cfg.evaluationDays * DAY;
  const start = Math.ceil(Math.max(buckets[0]!.start + cfg.minTrainingDays * DAY,
    scoreStart - (2 * cfg.calibrationDays + 7) * DAY) / DAY) * DAY;
  const timeline: NonNullable<FeeStudy['timeline']> = [];
  const history: FeeEvaluation[] = [], lastNonOverlap = new Map<number, number>();
  let origins = 0;
  for (let origin = start; origin <= asOf; origin += DAY) {
    const fitted = fitFeeModel(buckets, origin, cfg), live = latestPressure(pressure, origin, cfg.pressureFreshnessSeconds);
    const curves = MODEL_IDS.map(model => ({ model, ...forecastCurve(fitted, model, live, cfg) }));
    const regime = demandRegime(fitted.baseline === null ? null : Math.expm1(fitted.baseline));
    const snapshot: NonNullable<FeeStudy['timeline']>[number] = { origin, inputDigest: digest({ buckets: knownBuckets(buckets, origin), pressure: knownPressure(pressure, origin), config: cfg }),
      historyThrough: knownBuckets(buckets, origin).at(-1)?.end ?? null, pressureObservedAt: pressureObservation(pressure, origin)?.observedAt ?? null,
      pressureState: pressureState(pressure, origin, cfg.pressureFreshnessSeconds), regime, forecasts: curves.map(c => ({ ...c, summaries: [] })) };
    if (origin >= scoreStart) timeline.push(snapshot);
    for (const horizonDays of HORIZONS) {
      const end = origin + horizonDays * DAY;
      const complete = end <= buckets.at(-1)!.end;
      const outcome = complete ? intervalOutcome(buckets, origin, end) : { rate: null, coverage: 0 };
      const nonOverlapping = origin >= scoreStart && origin >= (lastNonOverlap.get(horizonDays) ?? -Infinity) + horizonDays * DAY;
      if (nonOverlapping) lastNonOverlap.set(horizonDays, origin);
      for (const curve of curves) {
        const central = curve.reason ? null : average(curve.points.slice(0, horizonDays * 24).map(p => p.central));
        const calibration = central === null ? { p50: null, p90: null, calibrationSamples: 0 } : calibrate(history, origin, curve.model, horizonDays, central, cfg, buckets, regime);
        if (central !== null) snapshot.forecasts.find(f => f.model === curve.model)!.summaries.push({ horizonDays, central, ...calibration });
        history.push({ origin, end, regime,
          outcomeAvailableAt: Math.max(end, ...buckets.filter(b => b.start >= origin && b.end <= end).map(availableAt)), horizonDays, model: curve.model, central, ...calibration,
          actual: outcome.rate, actualCoverage: outcome.coverage, nonOverlapping,
          reason: curve.reason ?? (!complete ? 'future_coverage_incomplete' : outcome.rate === null ? 'outcome_coverage_incomplete' : null) });
      }
    }
    if (++origins % 60 === 0) progress?.(`Evaluated ${origins} historical daily origins`);
  }
  const fit = fitFeeModel(buckets, asOf, cfg), live = latestPressure(pressure, asOf, cfg.pressureFreshnessSeconds);
  const forecasts = MODEL_IDS.map(model => {
    const curve = forecastCurve(fit, model, live, cfg);
    return { model, ...curve, summaries: curve.reason ? [] : HORIZONS.map(horizonDays => {
      const central = average(curve.points.slice(0, horizonDays * 24).map(p => p.central))!;
      return { horizonDays, central, ...calibrate(history, asOf, model, horizonDays, central, cfg, buckets, demandRegime(fit.baseline === null ? null : Math.expm1(fit.baseline))) };
    }) };
  });
  const resolutions = [...new Set(buckets.map(b => b.end - b.start))].sort((a, b) => b - a).map(seconds => {
    const rows = buckets.filter(b => b.end - b.start === seconds);
    return { seconds, buckets: rows.length, start: rows[0]!.start, end: rows.at(-1)!.end };
  });
  const monday = Math.floor(asOf / DAY) * DAY - weekday(asOf) * DAY;
  const profile = fit.seasonalReason ? [] : Array.from({ length: 168 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24,
    factor: Math.exp(dot(seasonalFeatures(monday + i * HOUR, monday + (i + 1) * HOUR), fit.coefficients)) }));
  if (timeline.at(-1)?.origin === asOf) timeline.pop();
  timeline.push({ origin: asOf, inputDigest: digest({ buckets, pressure, config: cfg }), historyThrough: buckets.at(-1)?.end ?? null,
    pressureObservedAt: pressureObservation(pressure, asOf)?.observedAt ?? null, pressureState: pressureState(pressure, asOf, cfg.pressureFreshnessSeconds),
    regime: demandRegime(fit.baseline === null ? null : Math.expm1(fit.baseline)), forecasts });
  const evaluations = history.filter(e => e.origin >= scoreStart);
  const stability = [...new Set(buckets.map(b => new Date(b.start * 1000).getUTCFullYear()))].map(year => {
    const first = Date.UTC(year, 0, 1) / 1000, end = Math.min(asOf, Date.UTC(year + 1, 0, 1) / 1000);
    const sample = buckets.filter(b => b.start >= first && b.end <= end);
    const annual = fitFeeModel(sample, end, { ...cfg, trainingDays: 366 });
    const factors = Array.from({ length: 7 }, (_, day) => Math.exp(dot(seasonalFeatures(monday + day * DAY, monday + (day + 1) * DAY), annual.coefficients)));
    return { year, days: annual.trainingDays, finestHours: Math.min(...sample.map(b => (b.end - b.start) / HOUR)),
      coarsestHours: Math.max(...sample.map(b => (b.end - b.start) / HOUR)),
      weekdayWeekendRatio: annual.seasonalReason ? null : average(factors.slice(0, 5))! / average(factors.slice(5))! };
  });
  return { schemaVersion: 2, target: archive.target, network: archive.network, asOf, archiveDigest: archive.digest,
    pressureDigest: digest(pressure), sourceSha256: sourceSha256 ?? implementationProvenance().sourceSha256, config: cfg,
    coverage: { start: buckets[0]!.start, end: buckets.at(-1)!.end, buckets: buckets.length, integerQuantized: archive.integerQuantized,
      resolutions, pressureSnapshots: pressure.length, pressureStatus: forecasts.find(f => f.model === 'pressure')!.reason ?? 'available',
      seasonalTrainingBuckets: fit.trainingBuckets, seasonalTrainingDays: fit.trainingDays },
    inputDigest: digest({ buckets, pressure, config: cfg }), availabilityMode: buckets.every(b => b.availableAt !== undefined) ? 'recorded' : 'assumed_bucket_end',
    timeline, diagnostics: feeDiagnostics(evaluations), validation: { state: 'exploratory_unfrozen', checks: [] },
    profile, stability, forecasts, evaluations, scores: scoreFees(evaluations), warnings: [
      ...(buckets.some(b => b.availableAt === undefined) ? ['Legacy history assumes availability at bucket end. It cannot qualify as prospective held-out evidence.'] : []),
      'Uncertainty intervals use an overlap and autocorrelation adjusted effective sample count; they are approximate diagnostics, not independent-trial guarantees.',
      'Target is the time-weighted mean of bucket-average block-median fee rates. It is not an inclusion-price quote or Alpen fee prediction.',
      'Older coarse observations support broad daily/weekly patterns. Fine hourly structure is supported by the recent higher-resolution data.',
      ...(archive.integerQuantized ? ['The source rounds historical bucket fee rates to integer sat/vB. Sub-sat behavior cannot be recovered from these observations.'] : []),
      'Seasonality is fitted in log(1 + sat/vB); displayed factors multiply (1 + rate). UTC profiles do not yet model daylight-saving shifts.',
      'Pressure is an experimental correction from the first three single-block projections, with a configurable decay. Missing, failed, future or stale snapshots produce no pressure prediction.',
      'Period p50/p90 use only fully resolved earlier forecast errors. Calibration dates overlap; coverage is empirical, not a funding guarantee. Hourly curves are central estimates, not calibrated hourly quantiles.',
      'Outcomes require at least 95% observed duration and never include buckets crossing the outcome boundary. Missing duration is excluded, never filled with zero.',
    ] };
}

export function feeDiagnostics(evaluations: readonly FeeEvaluation[]): NonNullable<FeeStudy['diagnostics']> {
  const groups = new Map<string, FeeEvaluation[]>();
  for (const e of evaluations) {
    if (!e.nonOverlapping || e.central === null || e.actual === null) continue;
    for (const group of diagnosticGroups(e.origin, e.regime ?? 'unknown')) {
      const key = [group, e.model, e.horizonDays].join('|');
      groups.set(key, [...groups.get(key) ?? [], e]);
    }
  }
  return [...groups].map(([key, rows]) => ({ group: key.split('|')[0]!, model: rows[0]!.model, horizonDays: rows[0]!.horizonDays,
    samples: rows.length, mae: average(rows.map(e => Math.abs(e.central! - e.actual!))),
    p90Misses: rows.filter(e => e.p90 !== null && e.actual! > e.p90).length, quantileSamples: rows.filter(e => e.p90 !== null).length }));
}

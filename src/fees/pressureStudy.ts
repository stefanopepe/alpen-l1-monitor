import { digest } from '../replay/archive.js';
import { fitFeeModel, forecastCurve, HOUR, intervalOutcome, knownBuckets, knownPressure, latestPressure } from './model.js';
import type { FeeArchive, FeeModelConfig, FeePressure } from './schema.js';
import { mean } from './statistics.js';

// A proposal trained on an explicit closed window. It never mutates the active
// model; the resulting config must be frozen before a separate later evaluation.
export function tunePressure(archive: FeeArchive, observations: readonly FeePressure[], config: FeeModelConfig, through: number) {
  if (!Number.isSafeInteger(through) || through < 0) throw new Error('E_FEE_TRAINING_END');
  const buckets = knownBuckets(archive.buckets, through);
  const pressure = knownPressure(observations, through);
  const origins: number[] = [];
  for (const p of [...pressure].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))) {
    const origin = Math.ceil(Date.parse(p.observedAt) / 1000);
    if (origin + 24 * HOUR <= through && origin >= (origins.at(-1) ?? -Infinity) + 24 * HOUR) origins.push(origin);
  }
  const samples = origins.flatMap(origin => {
    const live = latestPressure(pressure, origin, config.pressureFreshnessSeconds), fit = fitFeeModel(buckets, origin, config);
    if (!live || fit.seasonalReason) return [];
    const outcome = intervalOutcome(buckets, origin, origin + 24 * HOUR);
    if (outcome.rate === null) return [];
    return [{ origin, live, fit, actual: outcome.rate, seasonal: mean(forecastCurve(fit, 'seasonal', null, config, 24).points.map(p => p.central))! }];
  });
  const variants = [
    { feature: 'projected_fees', pressureBacklogWeight: 0, pressureFullnessWeight: 0 },
    { feature: 'projected_fees_backlog', pressureBacklogWeight: 0.1, pressureFullnessWeight: 0 },
    { feature: 'projected_fees_fullness', pressureBacklogWeight: 0, pressureFullnessWeight: 0.5 },
  ];
  // All candidates and the seasonal reference use exactly the same dates. If
  // fullness is unavailable, compare projection-only candidates separately.
  const results = variants.flatMap(variant => [0.25, 0.5, 1].flatMap(pressureStrength => [1, 3, 6, 12].map(pressureHalfLifeHours => {
    const cfg = { ...config, pressureStrength, pressureHalfLifeHours, pressureBacklogWeight: variant.pressureBacklogWeight, pressureFullnessWeight: variant.pressureFullnessWeight };
    const rows = samples.flatMap(s => {
      const curve = forecastCurve(s.fit, 'pressure', s.live, cfg, 24);
      return curve.reason ? [] : [{ origin: s.origin, actual: s.actual, central: mean(curve.points.map(p => p.central))!, seasonal: s.seasonal }];
    });
    const mae = mean(rows.map(r => Math.abs(r.central - r.actual))), seasonalMae = mean(rows.map(r => Math.abs(r.seasonal - r.actual)));
    return { feature: variant.feature, config: cfg, samples: rows.length, origins: rows.map(r => r.origin), mae, seasonalMae,
      improvement: mae !== null && seasonalMae !== null && seasonalMae > 0 ? 1 - mae / seasonalMae : null };
  })));
  const common = samples.filter(s => s.live.blockFullness && s.origin - Date.parse(s.live.blockFullness.observedAt) / 1000 <= config.pressureFreshnessSeconds);
  const featureComparisons = results.map(r => {
    const matched = common.map(s => ({ actual: s.actual, seasonal: s.seasonal, central: mean(forecastCurve(s.fit, 'pressure', s.live, r.config, 24).points.map(p => p.central)) }));
    return { feature: r.feature, strength: r.config.pressureStrength, halfLifeHours: r.config.pressureHalfLifeHours, samples: matched.length,
      mae: mean(matched.filter(s => s.central !== null).map(s => Math.abs(s.central! - s.actual))), seasonalMae: mean(matched.map(s => Math.abs(s.seasonal - s.actual))) };
  });
  // Feature adoption is reserved for later held-out data. Propose only strength
  // and decay for the existing projection signal, with a fixed sample floor.
  const candidates = results.filter(r => r.feature === 'projected_fees' && r.samples >= 30 && r.improvement !== null && r.improvement > 0)
    .sort((a, b) => a.mae! - b.mae!);
  return { schemaVersion: 1, through, inputDigest: digest({ buckets, pressure, config }), config,
    state: candidates.length ? 'training_proposal_requires_later_holdout' : 'unvalidated_insufficient_or_no_gain',
    selectedConfig: candidates[0]?.config ?? null, results, featureComparisons,
    warnings: ['Daily non-overlapping 24-hour outcomes; incomplete fee coverage is excluded.', 'Tuning errors are in-sample. Backlog and fullness are challengers only; no feature is automatically adopted.'] };
}

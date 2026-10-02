import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { digest } from '../replay/archive.js';
import { implementationProvenance } from '../replay/provenance.js';
import { feeModelConfigSchema, MODEL_IDS, type FeeArchive, type FeeStudy } from './schema.js';
import { knownBuckets } from './model.js';
import { coverageInterval, effectiveSamples, mean, pinball } from './statistics.js';

export const evaluationPlanSchema = z.object({
  schemaVersion: z.literal(1), frozenAt: z.number().int(), start: z.number().int(), end: z.number().int(),
  archiveDigest: z.string().regex(/^[a-f0-9]{64}$/), trainingInputDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  config: feeModelConfigSchema, baseline: z.enum(['baseline', 'rolling', 'ewma', 'weekday_hour']),
  candidates: z.array(z.enum(MODEL_IDS)).min(1),
  thresholds: z.object({ minPeriods: z.number().int().min(20), minEffectiveSamples: z.number().int().min(20),
    minCentralImprovement: z.number().min(0).max(1), maxPinballRatio: z.number().positive().max(1),
    p50Tolerance: z.number().min(0).max(0.15), p90Tolerance: z.number().min(0).max(0.1) }).strict(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(p => p.frozenAt <= p.start && p.end > p.start, 'Plan must precede held-out period');
export type EvaluationPlan = z.infer<typeof evaluationPlanSchema>;
export function freezeEvaluation(path: string, archive: FeeArchive, config: FeeStudy['config'], start: number, end: number,
  baseline: EvaluationPlan['baseline'] = 'baseline', now = Math.ceil(Date.now() / 1000)) {
  if (existsSync(path)) throw new Error('E_FEE_PLAN_EXISTS');
  if (Date.parse(archive.capturedAt) / 1000 > start) throw new Error('E_FEE_PLAN_FUTURE_INPUT');
  const body = { schemaVersion: 1 as const, frozenAt: now, start, end, archiveDigest: archive.digest,
    trainingInputDigest: digest(knownBuckets(archive.buckets, now)),
    sourceSha256: implementationProvenance().sourceSha256, config, baseline, candidates: ['seasonal', 'pressure'] as const,
    thresholds: { minPeriods: 30, minEffectiveSamples: 20, minCentralImprovement: 0, maxPinballRatio: 1, p50Tolerance: 0.1, p90Tolerance: 0.05 } };
  const plan = evaluationPlanSchema.parse({ ...body, digest: digest(body) });
  writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return plan;
}
export function readEvaluationPlan(path: string): EvaluationPlan {
  const plan = evaluationPlanSchema.parse(JSON.parse(readFileSync(path, 'utf8'))), { digest: hash, ...body } = plan;
  if (digest(body) !== hash) throw new Error('E_FEE_PLAN_DIGEST');
  return plan;
}
export function validateHeldOut(study: FeeStudy, plan: EvaluationPlan, archive: FeeArchive): NonNullable<FeeStudy['validation']> {
  if (digest(study.config) !== digest(plan.config) || study.sourceSha256 !== plan.sourceSha256) throw new Error('E_FEE_PLAN_IMPLEMENTATION_CHANGED');
  if (digest(knownBuckets(archive.buckets, plan.frozenAt)) !== plan.trainingInputDigest) throw new Error('E_FEE_PLAN_TRAINING_INPUT_CHANGED');
  const checks: NonNullable<FeeStudy['validation']>['checks'] = [];
  for (const model of plan.candidates) for (const horizonDays of [1, 3, 5, 7]) {
    const reasons: string[] = [];
    // Anchor non-overlap selection to the frozen start, independent of data eligibility
    // and of how many later dates have been captured.
    const rows = study.evaluations.filter(e => e.horizonDays === horizonDays && e.origin >= plan.start && e.end <= plan.end &&
      (e.origin - Math.ceil(plan.start / 86400) * 86400) % (horizonDays * 86400) === 0);
    const references = model === 'pressure' ? [plan.baseline, 'seasonal'] : [plan.baseline];
    for (const reference of references) {
      const pairs = rows.filter(e => e.model === model && e.central !== null && e.actual !== null && e.p50 !== null && e.p90 !== null)
        .flatMap(e => { const b = rows.find(r => r.model === reference && r.origin === e.origin && r.central !== null && r.actual !== null && r.p50 !== null && r.p90 !== null); return b ? [{ e, b }] : []; });
      const own = pairs.map(p => p.e), effective = effectiveSamples(own), t = plan.thresholds;
      if (own.length < t.minPeriods || effective < t.minEffectiveSamples) reasons.push(reference + ':insufficient_matched_evidence');
      if (pairs.length) {
        const mae = mean(pairs.map(p => Math.abs(p.e.central! - p.e.actual!)))!, refMae = mean(pairs.map(p => Math.abs(p.b.central! - p.b.actual!)))!;
        if (!(mae < refMae * (1 - t.minCentralImprovement))) reasons.push(reference + ':central_accuracy');
        for (const q of [0.5, 0.9] as const) {
          const key = q === 0.5 ? 'p50' : 'p90', tolerance = q === 0.5 ? t.p50Tolerance : t.p90Tolerance;
          const loss = mean(pairs.map(p => pinball(p.e.actual!, p.e[key]!, q)))!;
          const refLoss = mean(pairs.map(p => pinball(p.b.actual!, p.b[key]!, q)))!;
          if (loss > refLoss * t.maxPinballRatio) reasons.push(reference + ':' + key + '_quantile_error');
          const coverage = mean(own.map(e => Number(e.actual! <= e[key]!)))!, interval = coverageInterval(coverage, effective)!;
          if (Math.abs(coverage - q) > tolerance || interval[0] > q || interval[1] < q) reasons.push(reference + ':' + key + '_coverage');
        }
      }
    }
    if (study.asOf < plan.end) reasons.push('held_out_period_incomplete');
    if (study.availabilityMode !== 'recorded') reasons.push('availability_assumed');
    checks.push({ model, horizonDays, state: reasons.length ? 'experimental' : 'eligible_for_review', reasons });
  }
  return { state: checks.every(c => c.state === 'eligible_for_review') ? 'eligible_for_review' : 'experimental', planDigest: plan.digest, checks };
}

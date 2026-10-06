import { z } from 'zod';

const time = z.number().int().nonnegative().max(8640000000000);
const rate = z.number().finite().nonnegative().max(1e9);
export const feeBucketSchema = z.object({
  start: time, end: time, rate, source: z.string().min(1),
  availableAt: time.optional(),
}).strict().refine(b => b.end > b.start && b.end - b.start <= 86400 && (b.availableAt === undefined || b.availableAt >= b.end), 'Invalid fee bucket duration');
export type FeeBucket = z.infer<typeof feeBucketSchema>;
export const feeArchiveSchema = z.object({
  schemaVersion: z.literal(1), network: z.literal('mainnet'),
  target: z.literal('bucket_mean_block_median_sat_vb'),
  capturedAt: z.iso.datetime(), source: z.string().min(1),
  integerQuantized: z.boolean(), buckets: z.array(feeBucketSchema).min(1),
  responses: z.record(z.string(), z.string()), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FeeArchive = z.infer<typeof feeArchiveSchema>;

export const projectedBlockSchema = z.object({
  blockVSize: z.number().finite().nonnegative().max(1e12), medianFee: rate,
  feeRange: z.array(rate).min(1).max(100),
});
export const feePressureSchema = z.object({
  observedAt: z.iso.datetime(), status: z.enum(['available', 'unavailable']),
  blocks: z.array(projectedBlockSchema).max(100).nullable(), error: z.string().nullable(),
  blockFullness: z.object({ observedAt: z.iso.datetime(), ratio: z.number().min(0).max(1) }).optional(),
}).refine(p => p.status === 'available' ? !!p.blocks?.length && p.error === null : p.blocks === null && p.error !== null);
export type FeePressure = z.infer<typeof feePressureSchema>;

export const MODEL_IDS = ['baseline', 'seasonal', 'pressure', 'rolling', 'ewma', 'weekday_hour'] as const;
export type FeeModelId = typeof MODEL_IDS[number];
export interface FeeForecastPoint { time: number; central: number }
export interface FeeForecastSummary { horizonDays: number; central: number; p50: number | null; p90: number | null; calibrationSamples: number; effectiveCalibrationSamples?: number; calibrationState?: string; priorP50Coverage?: number | null; priorP90Coverage?: number | null; priorCoverageSamples?: number }
export interface FeeEvaluation {
  origin: number; end: number; horizonDays: number; model: FeeModelId;
  outcomeAvailableAt?: number; regime?: string; regimeP50?: number | null; regimeP90?: number | null;
  effectiveCalibrationSamples?: number; calibrationState?: string;
  central: number | null; p50: number | null; p90: number | null;
  actual: number | null; actualCoverage: number; calibrationSamples: number; reason: string | null; nonOverlapping: boolean;
}
export interface FeeScore {
  model: FeeModelId; horizonDays: number; sampling: 'daily' | 'non_overlapping';
  origins: number; available: number; scored: number; matched: number;
  mae: number | null; bias: number | null; skillVsBaseline: number | null;
  p50Samples: number; p50Coverage: number | null; p90Samples: number; p90Coverage: number | null;
  p90Pinball: number | null;
  p50Pinball?: number | null; effectiveSamples?: number;
  p50Interval?: [number, number] | null; p90Interval?: [number, number] | null;
  skillVsSeasonal?: number | null; pressureMatched?: number;
  regimeP50Coverage?: number | null; regimeP90Coverage?: number | null;
  regimeP50Pinball?: number | null; regimeP90Pinball?: number | null;
  regimeSamples?: number; rollingP50OnRegime?: number | null; rollingP90OnRegime?: number | null; rollingP50CoverageOnRegime?: number | null; rollingP90CoverageOnRegime?: number | null; uncertaintyState?: string;
}
export interface FeeStudy {
  schemaVersion: 1 | 2; target: FeeArchive['target']; network: 'mainnet';
  asOf: number; archiveDigest: string; pressureDigest: string; sourceSha256: string;
  config: FeeModelConfig;
  inputDigest?: string; availabilityMode?: 'recorded' | 'assumed_bucket_end';
  timeline?: FeeForecastSnapshot[];
  diagnostics?: { group: string; model: FeeModelId; horizonDays: number; samples: number; mae: number | null; p90Misses: number; quantileSamples: number }[];
  validation?: { state: string; planDigest?: string; checks: { model: FeeModelId; horizonDays: number; state: string; reasons: string[] }[] };
  coverage: { start: number; end: number; buckets: number; integerQuantized: boolean;
    resolutions: { seconds: number; buckets: number; start: number; end: number }[];
    pressureSnapshots: number; pressureStatus: string; seasonalTrainingBuckets: number; seasonalTrainingDays: number };
  profile: { weekday: number; hour: number; factor: number }[];
  stability: { year: number; days: number; finestHours: number; coarsestHours: number; weekdayWeekendRatio: number | null }[];
  forecasts: { model: FeeModelId; reason: string | null; points: FeeForecastPoint[]; summaries: FeeForecastSummary[] }[];
  evaluations: FeeEvaluation[]; scores: FeeScore[];
  evaluationPeriods?: { horizonDays: number; sampling: string; from: number; to: number }[];
  warnings: string[];
}
export const feeModelConfigSchema = z.object({
  trainingDays: z.number().int().min(84).max(3650).default(1460),
  seasonalHalfLifeDays: z.number().positive().max(3650).default(365),
  baselineDays: z.number().int().min(2).max(30).default(7),
  minTrainingDays: z.number().int().min(28).max(365).default(84),
  seasonalRidge: z.number().positive().max(100).default(2),
  pressureBacklogWeight: z.number().min(0).max(1).default(0),
  pressureFullnessWeight: z.number().min(0).max(1).default(0),
  pressureStrength: z.number().min(0).max(2).default(1),
  ewmaHalfLifeDays: z.number().positive().max(30).default(2),
  pressureHalfLifeHours: z.number().positive().max(168).default(6),
  pressureFreshnessSeconds: z.number().int().min(60).max(3600).default(1800),
  calibrationDays: z.number().int().min(30).max(730).default(180),
  minCalibrationSamples: z.number().int().min(20).max(365).default(30),
  evaluationDays: z.number().int().min(7).max(730).default(180),
}).strict().refine(c => c.trainingDays >= c.minTrainingDays && c.calibrationDays >= c.minCalibrationSamples, 'Invalid model windows');
export type FeeModelConfig = z.infer<typeof feeModelConfigSchema>;
export const DEFAULT_FEE_CONFIG = feeModelConfigSchema.parse({});

export interface FeeForecastSnapshot {
  origin: number; inputDigest: string; historyThrough: number | null; pressureObservedAt: string | null;
  pressureState: string; regime: string; forecasts: FeeStudy['forecasts'];
}

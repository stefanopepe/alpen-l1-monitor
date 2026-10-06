import { afterAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/db/store.js';
import { exportObservations } from '../src/read/observations.js';
import { observeFees } from '../src/chain/fees.js';
import { feeModelConfigSchema, type FeeArchive, type FeeEvaluation } from '../src/fees/schema.js';
import { runFeeStudy, calibrate, scoreFees } from '../src/fees/study.js';
import { DAY, HOUR, fitFeeModel, forecastCurve, pressureState } from '../src/fees/model.js';
import { coverageInterval, effectiveSamples } from '../src/fees/statistics.js';
import { freezeEvaluation, readEvaluationPlan, validateHeldOut } from '../src/fees/validation.js';
import { tunePressure } from '../src/fees/pressureStudy.js';
import { forecastAt } from '../src/fees/report/state.js';
import { config } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'fee-evolution-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const start = Date.parse('2025-01-01T00:00:00Z') / 1000;
const cfg = feeModelConfigSchema.parse({ evaluationDays: 30, calibrationDays: 30, minCalibrationSamples: 20 });
const buckets = Array.from({ length: 180 * 2 }, (_, i) => ({ start: start + i * 12 * HOUR, end: start + (i + 1) * 12 * HOUR,
  availableAt: start + (i + 1) * 12 * HOUR, rate: 1.5 + (i % 7) / 10, source: 'recorded_fixture' }));
const archive: FeeArchive = { schemaVersion: 1, network: 'mainnet', target: 'bucket_mean_block_median_sat_vb', source: 'test',
  capturedAt: new Date((start + 180 * DAY) * 1000).toISOString(), integerQuantized: false, buckets, responses: {}, digest: 'a'.repeat(64) };

it('keeps causal forecasts, input digests and calibration stable after delayed observations arrive', () => {
  const boundary = start + 160 * DAY;
  const delayed = { ...archive, buckets: buckets.map((b, i) => i % 10 === 0 ? { ...b, rate: 500, availableAt: Math.max(b.end, boundary + DAY) } : b) };
  const before = runFeeStudy(delayed, [], cfg, boundary);
  const after = runFeeStudy(delayed, [], cfg, start + 180 * DAY);
  const common = before.timeline!.filter(t => after.timeline!.some(a => a.origin === t.origin));
  expect(common.length).toBeGreaterThan(5);
  for (const prediction of common) expect(after.timeline!.find(a => a.origin === prediction.origin)).toEqual(prediction);
  const poisoned = { ...delayed, buckets: delayed.buckets.map(b => b.availableAt > boundary ? { ...b, rate: 99999 } : b) };
  expect(runFeeStudy(poisoned, [], cfg, boundary).forecasts).toEqual(before.forecasts);
});

it('requires outcome availability, not merely period completion, for residual calibration', () => {
  const origin = start + 100 * DAY;
  const history: FeeEvaluation[] = Array.from({ length: 30 }, (_, i) => ({ model: 'seasonal', origin: origin - (i + 2) * DAY,
    end: origin - (i + 1) * DAY, outcomeAvailableAt: origin + DAY, horizonDays: 1, central: 1, actual: 100,
    actualCoverage: 1, p50: null, p90: null, calibrationSamples: 0, reason: null, nonOverlapping: true }));
  expect(calibrate(history, origin, 'seasonal', 1, 1, cfg)).toMatchObject({ p90: null, calibrationSamples: 0, calibrationState: 'insufficient_calibration' });
});

it('reports overlap-adjusted uncertainty and penalizes overly wide p90 bounds', () => {
  const rows: FeeEvaluation[] = Array.from({ length: 70 }, (_, i) => ({ model: 'baseline', origin: start + i * DAY, end: start + (i + 7) * DAY,
    horizonDays: 7, central: 2, actual: i % 2 ? 1 : 3, actualCoverage: 1, p50: 2, p90: 3,
    calibrationSamples: 30, reason: null, nonOverlapping: i % 7 === 0 }));
  expect(effectiveSamples(rows)).toBeLessThanOrEqual(10);
  const interval = coverageInterval(0.9, 10)!;
  expect(interval[0]).toBeLessThan(0.9); expect(interval[1]).toBeGreaterThan(0.9);
  const get = (r: FeeEvaluation[]) => scoreFees(r).find(s => s.model === 'baseline' && s.horizonDays === 7 && s.sampling === 'daily')!;
  expect(get(rows.map(r => ({ ...r, p90: 100 }))).p90Pinball!).toBeGreaterThan(get(rows).p90Pinball!);
});

it('compares pressure against seasonality on matching dates only', () => {
  const base: FeeEvaluation = { model: 'seasonal', origin: start, end: start + DAY, horizonDays: 1, central: 2, actual: 4,
    actualCoverage: 1, p50: null, p90: null, calibrationSamples: 0, reason: null, nonOverlapping: true };
  const scores = scoreFees([base, { ...base, origin: start + DAY, central: 900 }, { ...base, model: 'pressure', central: 3 }]);
  expect(scores.find(s => s.model === 'pressure' && s.horizonDays === 1 && s.sampling === 'daily')).toMatchObject({ skillVsSeasonal: 0.5, pressureMatched: 1 });
});

it('freezes immutable prospective rules and refuses altered configuration or implementation', () => {
  const file = join(dir, 'plan.json'), begin = start + 181 * DAY;
  const plan = freezeEvaluation(file, archive, cfg, begin, begin + 250 * DAY, 'rolling', begin - 1);
  expect(readEvaluationPlan(file)).toEqual(plan);
  expect(() => freezeEvaluation(file, archive, cfg, begin, begin + DAY, 'rolling', begin - 1)).toThrow('E_FEE_PLAN_EXISTS');
  expect(() => freezeEvaluation(join(dir, 'past.json'), archive, cfg, begin, begin + DAY, 'rolling', begin + 1)).toThrow();
  const study = runFeeStudy(archive, [], cfg, start + 180 * DAY);
  const validation = validateHeldOut(study, plan, archive);
  expect(validation.checks.every(c => c.state === 'experimental' && c.reasons.includes('held_out_period_incomplete'))).toBe(true);
  expect(() => validateHeldOut({ ...study, sourceSha256: 'b'.repeat(64) }, plan, archive)).toThrow('E_FEE_PLAN_IMPLEMENTATION_CHANGED');
  writeFileSync(file, JSON.stringify({ ...plan, baseline: 'ewma' }));
  expect(() => readEvaluationPlan(file)).toThrow('E_FEE_PLAN_DIGEST');
});

it('shows only saved earlier fee forecasts at a selected replay block, with stale fallbacks', () => {
  const study = runFeeStudy(archive, [], cfg, start + 180 * DAY);
  expect(forecastAt(study, start)).toBeNull();
  const time = start + 160 * DAY + HOUR;
  expect(forecastAt(study, time)?.origin).toBeLessThanOrEqual(time);
  expect(forecastAt(study, time)?.pressureState).toBe('missing');
  expect(forecastAt({ ...study, timeline: undefined }, time)).toBeNull();
  const stale = runFeeStudy(archive, [], cfg, start + 183 * DAY);
  expect(stale.forecasts.every(f => f.reason === 'recent_history_incomplete')).toBe(true);
  expect(stale.forecasts.every(f => f.summaries.length === 0)).toBe(true);
});

it('keeps challenger baselines causal and distinguishes pressure failure from staleness', () => {
  const origin = start + 170 * DAY, fit = fitFeeModel(buckets, origin, cfg);
  for (const model of ['rolling', 'ewma', 'weekday_hour'] as const) {
    const curve = forecastCurve(fit, model, null, cfg);
    expect(curve.reason).toBeNull(); expect(curve.points).toHaveLength(168);
    expect(forecastCurve(fitFeeModel(buckets.map(b => b.availableAt > origin ? { ...b, rate: 999 } : b), origin, cfg), model, null, cfg)).toEqual(curve);
  }
  const failed = { observedAt: new Date(origin * 1000).toISOString(), status: 'unavailable' as const, blocks: null, error: 'E_PRESSURE_HTTP' };
  expect(pressureState([failed], origin, 1800)).toBe('provider_failed');
  expect(pressureState([{ ...failed, status: 'available', error: null, blocks: [{ blockVSize: 900000, medianFee: 0.125, feeRange: [0.1] }] }], origin + 1801, 1800)).toBe('stale');
});

it('retains fractional completed blocks and provider failures after run cleanup; exports verified evidence once', async () => {
  const db = new PGlite();
  try {
    await db.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
    await db.exec(readFileSync('migrations/0002_fee_observations.sql', 'utf8'));
    await db.exec("INSERT INTO network_stamp(network) VALUES('mainnet')");
    const query = async (sql: string, args?: unknown[]) => { const r = await db.query(sql, args); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 }; };
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const store = new Store(pool), id = randomUUID(), now = () => new Date((start + DAY) * 1000);
    const context = await observeFees(async url => String(url).endsWith('/blocks') ? Response.json([{ id: 'a'.repeat(64), height: 900000, timestamp: start, weight: 3999999, tx_count: 2,
      extras: { medianFee: 0.125, feeRange: [0.1, 0.125, 1], totalFees: 25 } }]) : String(url).endsWith('/summary')
      ? Response.json([{ txid: 'b'.repeat(64), fee: 0, vsize: 200 }, { txid: 'c'.repeat(64), fee: 25, vsize: 200 }]) : new Response('', { status: 503 }), now);
    expect(context).toMatchObject({ status: 'unavailable', pressure: { status: 'unavailable' }, completed: { status: 'available', blocks: [{ extras: { medianFee: 0.125 } }] } });
    await store.beginRun('mainnet', id);
    expect(await store.preserveFees('mainnet', id, context)).toBe('durable');
    expect(await store.preserveFees('mainnet', id, context)).toBe('durable');
    expect(await store.preserveFees('mainnet', id, { ...context, error: 'changed' })).toBe('unavailable');
    await store.finishRun(id, 'ok', { schemaVersion: 1, feeContext: context, wallets: [] });
    await query("UPDATE runs SET started_at='2020-01-01'");
    const lease = (await store.acquire('mainnet', id, 100, 900, true))!;
    await store.maintenance(lease, config().config.retention);
    expect((await query('SELECT * FROM runs')).rows).toHaveLength(0);
    const exported = await exportObservations(pool, 'mainnet', '2020-01-01', '2030-01-01');
    expect(exported.observations).toHaveLength(1);
    expect(exported.observations[0]!.feeContext?.completed?.blocks?.[0]?.extras.medianFee).toBe(0.125);
    expect(exported.observations[0]!.feeContext?.completed?.blocks?.[0]?.transactionFees).toEqual({
      basis: 'median_transaction_fee_per_vbyte', transactionCount: 1, medianSatVb: 0.125,
    });
    await query("UPDATE fee_observations SET sha256=$1", ['f'.repeat(64)]);
    await expect(exportObservations(pool, 'mainnet', '2020-01-01', '2030-01-01')).rejects.toThrow('E_OBSERVATIONS_READ');
  } finally { await db.close(); }
});

it('keeps runtime fee evidence append-only and the reader read-only after repeat permission application', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE monitor_app; CREATE ROLE monitor_read;');
    await db.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
    await db.exec(readFileSync('migrations/0002_fee_observations.sql', 'utf8'));
    await db.exec(readFileSync('migrations/0003_fee_research.sql', 'utf8'));
    await db.exec("INSERT INTO network_stamp(network) VALUES('mainnet')");
    for (let i = 0; i < 2; i++) await db.exec(readFileSync('ops/roles.sql', 'utf8'));
    await db.exec('SET ROLE monitor_app');
    await db.query("INSERT INTO fee_observations VALUES('mainnet',$1,now(),1,$2,'{}')", [randomUUID(), 'a'.repeat(64)]);
    await expect(db.exec('UPDATE fee_observations SET data=\'{}\'')).rejects.toThrow(/permission denied/);
    await expect(db.exec('DELETE FROM fee_observations')).rejects.toThrow(/permission denied/);
    await expect(db.exec('DELETE FROM time_machine_samples')).rejects.toThrow(/permission denied/);
    await db.query("INSERT INTO runs(run_id,network,status) VALUES($1,'mainnet','running')", [randomUUID()]);
    await db.exec('RESET ROLE; SET ROLE monitor_read');
    expect((await db.query('SELECT * FROM fee_observations')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM fee_research')).rows).toHaveLength(0);
    await expect(db.exec("INSERT INTO fee_research(network) VALUES('mainnet')")).rejects.toThrow(/permission denied/);
    await expect(db.query("INSERT INTO fee_observations VALUES('mainnet',$1,now(),1,$2,'{}')", [randomUUID(), 'b'.repeat(64)])).rejects.toThrow(/permission denied/);
  } finally { await db.close(); }
});

it('tunes only on the explicit training cutoff and leaves insufficient pressure history unvalidated', () => {
  const through = start + 170 * DAY;
  const result = tunePressure(archive, [], cfg, through);
  expect(result.state).toBe('unvalidated_insufficient_or_no_gain'); expect(result.selectedConfig).toBeNull();
  const future = { observedAt: new Date((through + DAY) * 1000).toISOString(), status: 'available' as const,
    blocks: [{ blockVSize: 990000, medianFee: 200, feeRange: [100, 200] }], error: null };
  const changed = { ...archive, buckets: buckets.map(b => b.availableAt > through ? { ...b, rate: 1e5 } : b) };
  expect(tunePressure(changed, [future], cfg, through)).toEqual(result);
});
it('compares pressure feature challengers on recorded complete training periods without using later data', () => {
  const through = start + 165 * DAY;
  const observations = Array.from({ length: 60 }, (_, i) => ({ observedAt: new Date((start + (105 + i) * DAY) * 1000).toISOString(), status: 'available' as const,
    blocks: [{ blockVSize: 990000, medianFee: 2.1, feeRange: [1, 2.1] }, { blockVSize: 12000000, medianFee: 0.5, feeRange: [0.5] }], error: null,
    blockFullness: { observedAt: new Date((start + (105 + i) * DAY) * 1000).toISOString(), ratio: 0.99 } }));
  const result = tunePressure(archive, observations, cfg, through);
  expect(result.results.every(r => r.samples === 60)).toBe(true);
  expect(result.featureComparisons.every(r => r.samples === 60 && r.mae !== null)).toBe(true);
  const changed = { ...archive, buckets: buckets.map(b => b.availableAt > through ? { ...b, rate: 99999 } : b) };
  expect(tunePressure(changed, observations, cfg, through)).toEqual(result);
  expect(result.selectedConfig?.pressureBacklogWeight ?? 0).toBe(0);
  expect(result.selectedConfig?.pressureFullnessWeight ?? 0).toBe(0);
});

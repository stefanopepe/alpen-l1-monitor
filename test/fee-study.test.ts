import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { runFeeStudy } from '../src/fees/study.js';
import { feeModelConfigSchema, type FeeArchive, type FeePressure } from '../src/fees/schema.js';
import { DAY, HOUR } from '../src/fees/model.js';
import { buildFeeReport, readFeeStudy } from '../src/fees/report.js';
import { buildReport } from '../src/replay/report.js';
import { runReplay } from '../src/replay/run.js';
import { writeJson } from '../src/replay/archive.js';
import { replayFixture } from './replay-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'fee-study-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const start = Date.parse('2024-01-01T00:00:00Z') / 1000;
const buckets = Array.from({ length: 180 * 12 }, (_, h) => ({ start: start + h * 2 * HOUR, end: start + (h + 1) * 2 * HOUR,
  rate: 2 + Math.sin(h / 12 * 2 * Math.PI) * 0.8, source: 'synthetic' }));
const archive: FeeArchive = { schemaVersion: 1, network: 'mainnet', target: 'bucket_mean_block_median_sat_vb', capturedAt: new Date((start + 180 * DAY) * 1000).toISOString(),
  source: 'synthetic', integerQuantized: false, buckets, responses: {}, digest: 'f'.repeat(64) };
const cfg = feeModelConfigSchema.parse({ evaluationDays: 30, calibrationDays: 30, minCalibrationSamples: 20 });
it('keeps earlier forecasts and calibration unchanged when future history changes', () => {
  const asOf = start + 160 * DAY;
  const study = runFeeStudy(archive, [], cfg, asOf);
  const altered = { ...archive, buckets: buckets.map(b => b.end > asOf ? { ...b, rate: 9000 } : b) };
  expect(runFeeStudy(altered, [], cfg, asOf)).toEqual(study);
  expect(study.evaluations.filter(e => e.end > asOf).every(e => e.actual === null && e.reason !== null)).toBe(true);
  expect(study.forecasts.find(f => f.model === 'pressure')!.points).toEqual([]);
  expect(study.forecasts[1]!.summaries.every(s => s.p50 !== null && s.p90! >= s.p50)).toBe(true);
  for (const h of [1, 3, 5, 7]) {
    const origins = study.evaluations.filter(e => e.horizonDays === h && e.model === 'baseline' && e.nonOverlapping).map(e => e.origin);
    expect(origins.every((v, i) => !i || v - origins[i - 1]! >= h * DAY)).toBe(true);
  }
});
it('builds a portable report and attaches the study without changing wallet forecasts', async () => {
  const study = runFeeStudy(archive, [], cfg, start + 180 * DAY);
  const file = join(dir, 'study.json'); writeJson(file, study);
  expect(readFeeStudy(file)).toEqual(study);
  const html = readFileSync(buildFeeReport(dir), 'utf8');
  expect(html).toContain('Learned weekly pattern'); expect(html).not.toContain('src="https://');
  const payload = html.match(/<script type="application\/json" id="data">([^<]+)<\/script>/)![1]!;
  expect(JSON.parse(gunzipSync(Buffer.from(payload, 'base64')).toString())).toEqual(study);
  const replayDir = join(dir, 'wallet'), fixture = replayFixture();
  await runReplay(fixture.archive, replayDir, { from: '160', to: '165' });
  const before = readFileSync(join(replayDir, 'forecasts.jsonl'), 'utf8');
  expect(readFileSync(buildReport(replayDir, file), 'utf8')).toContain('Learned weekly pattern');
  expect(readFileSync(join(replayDir, 'forecasts.jsonl'), 'utf8')).toBe(before);
  expect(readFileSync(buildReport(replayDir), 'utf8')).toContain('Learned weekly pattern');
});
it('uses a live subsecond snapshot without inventing pressure calibration or accepting future observations', () => {
  const asOf = start + 180 * DAY + 1;
  const observation: FeePressure = { observedAt: new Date((asOf - 0.588) * 1000).toISOString(), status: 'available',
    blocks: [{ blockVSize: 900_000, medianFee: 15, feeRange: [2, 15, 30] }], error: null };
  const study = runFeeStudy(archive, [observation], cfg, asOf);
  const forecast = study.forecasts.find(f => f.model === 'pressure')!;
  expect(forecast.points).toHaveLength(168);
  expect(forecast.points[0]!.central).toBeGreaterThan(study.forecasts[1]!.points[0]!.central);
  expect(forecast.summaries.every(s => s.p50 === null && s.p90 === null && s.calibrationSamples === 0)).toBe(true);
  const future = { ...observation, observedAt: new Date((asOf + 1) * 1000).toISOString() };
  expect(runFeeStudy(archive, [observation, future], cfg, asOf)).toEqual(study);
  expect(runFeeStudy(archive, [], cfg, asOf).pressureDigest).not.toEqual(study.pressureDigest);
});

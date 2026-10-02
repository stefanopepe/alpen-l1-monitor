import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchFeeHistory, mergeResolutions, openFeeArchive, sealFeeArchive } from '../src/fees/archive.js';
import { DAY, HOUR } from '../src/fees/model.js';
import { observeFees, observePressure } from '../src/chain/fees.js';
import { decodeRunResults } from '../src/read/observations.js';
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'fee-archive-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const b = (start: number, end: number, rate = 1) => ({ start, end, rate, source: 'test' });
it('drops whole overlapping coarse buckets while preserving gaps and rejecting duplicates', () => {
  const fine = [b(13 * HOUR, 14 * HOUR), b(15 * HOUR, 16 * HOUR)];
  expect(mergeResolutions([[b(0, 12 * HOUR), b(12 * HOUR, DAY)], fine])).toEqual([b(0, 12 * HOUR), ...fine]);
  expect(() => mergeResolutions([[b(0, HOUR), b(0, HOUR)]])).toThrow('E_FEE_HISTORY_OVERLAP');
});
it('verifies the archive digest before using historical fees', () => {
  const dir = temp();
  sealFeeArchive(dir, { schemaVersion: 1, network: 'mainnet', target: 'bucket_mean_block_median_sat_vb', capturedAt: '2024-01-01T00:00:00Z',
    source: 'test', integerQuantized: false, buckets: [b(0, HOUR)], responses: {} });
  expect(openFeeArchive(dir).buckets).toHaveLength(1);
  const file = join(dir, 'archive.json'), bad = JSON.parse(readFileSync(file, 'utf8')); bad.buckets[0].rate = 30; writeFileSync(file, JSON.stringify(bad));
  expect(() => openFeeArchive(dir)).toThrow('E_FEE_ARCHIVE_DIGEST');
});
it('archives explicit source resolution, retries rate limits and excludes open buckets', async () => {
  const dir = temp(), now = new Date('2026-10-02T12:10:00Z'), end = Math.floor(now.getTime() / 1000 / DAY) * DAY;
  let calls = 0;
  const fetcher = vi.fn(async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : Response.json([
    { timestamp: end - 2 * DAY + 100, avgFee_50: 2 }, { timestamp: end - DAY + 100, avgFee_50: 1 },
    { timestamp: end + 12 * HOUR + 5 * 60, avgFee_50: 99 },
  ]));
  const a = await fetchFeeHistory(dir, { fetcher, now: () => now, pause: async () => {} });
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(a.buckets.every(b => b.end <= now.getTime() / 1000)).toBe(true);
  expect(a.buckets.every(b => b.rate !== 99)).toBe(true);
  expect(openFeeArchive(dir)).toEqual(a);
});
it('records a pressure failure independently of the fee recommendation and accepts old exports', async () => {
  const quote = await observeFees(async url => String(url).endsWith('mempool-blocks') ? new Response('', { status: 429 }) :
    Response.json({ fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 0.1 }));
  expect(quote).toMatchObject({ status: 'available', pressure: { status: 'unavailable', error: 'E_PRESSURE_RATE_LIMITED' } });
  expect(decodeRunResults({ schemaVersion: 1, feeContext: quote, wallets: [] }).feeContext?.pressure).toEqual(quote.pressure);
  const old = { ...quote }; delete old.pressure;
  expect(decodeRunResults({ schemaVersion: 1, feeContext: old, wallets: [] }).feeContext?.pressure).toBeUndefined();
});
it('captures valid projection metadata and rejects malformed or empty pressure snapshots', async () => {
  const block = { blockVSize: 900000, medianFee: 2.3, feeRange: [1, 2.3, 5] };
  expect(await observePressure(async () => Response.json([block]))).toMatchObject({ status: 'available', blocks: [block] });
  expect(await observePressure(async () => Response.json([]))).toMatchObject({ status: 'unavailable' });
  expect(await observePressure(async () => { throw new Error('secret URL'); })).toMatchObject({ error: 'E_PRESSURE_UNAVAILABLE' });
});
it('retains first-observed fees, request availability and raw versions when a later capture revises history', async () => {
  const dir = temp(), origin = Date.parse('2026-10-02T12:10:00Z') / 1000;
  const response = (rate: number) => Response.json([{ timestamp: origin - 3 * DAY, avgFee_50: rate }, { timestamp: origin - 2 * DAY, avgFee_50: rate }]);
  const first = await fetchFeeHistory(dir, { fetcher: async () => response(0.5), now: () => new Date(origin * 1000), pause: async () => {} });
  const next = await fetchFeeHistory(dir, { fetcher: async () => response(99), now: () => new Date((origin + DAY) * 1000), pause: async () => {} });
  expect(next.buckets).toEqual(first.buckets);
  expect(next.buckets.every(b => b.availableAt === origin)).toBe(true);
  expect(Object.keys(next.responses)).toHaveLength(10);
  expect(openFeeArchive(dir, first.digest)).toEqual(first);
  expect(openFeeArchive(dir)).toEqual(next);
});

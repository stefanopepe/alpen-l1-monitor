import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { BLOCK_FEE_SOURCE, captureBlockBackfill, importBlockBackfill, validateBlockBackfill } from '../src/fees/blockBackfill.js';
import { exportObservations } from '../src/read/observations.js';
import { hash } from './helpers.js';

const now = new Date('2026-10-08T12:00:00Z'), epoch = now.getTime() / 1000;
const source = (height: number, time = epoch - 10000) => ({ id: hash(height), previousblockhash: hash(height - 1), height,
  timestamp: time, weight: 1000, tx_count: 3, extras: { medianFee: 0, feeRange: [0, 1], totalFees: 50 } });
const page = [source(10), source(9), source(8)];
const transactions = [{ txid: hash(0), fee: 0, vsize: 100 }, { txid: hash(1), fee: 20, vsize: 100.25 }, { txid: hash(2), fee: 30, vsize: 100.75 }];
const fetcher = () => vi.fn<typeof fetch>(async url => {
  const path = String(url);
  if (path.endsWith('/blocks')) return Response.json(page);
  if (path.includes('/summary')) return Response.json(transactions);
  if (path.includes('/block-height/')) return new Response(hash(10));
  throw new Error('Unexpected URL');
});
const options = () => ({ fromTime: epoch - 1000, now: () => now, known: async () => new Set([hash(9)]) });
const db = new PGlite(), query = async (sql: string, args?: unknown[]) => {
  const r = await db.query(sql, args); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
};
const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
beforeAll(async () => {
  await db.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
  await db.exec(readFileSync('migrations/0002_fee_observations.sql', 'utf8'));
  await query("INSERT INTO network_stamp(network) VALUES('mainnet')");
});
afterAll(async () => { await db.close(); });

it('uses public summaries only for missing blocks, verifies transaction totals and preserves fractional medians', async () => {
  const fetch = fetcher(), capture = await captureBlockBackfill({ ...options(), fetcher: fetch });
  expect(capture.blocks.map(b => b.height)).toEqual([10, 8]);
  expect(capture.blocks[0]?.transactionFees?.medianSatVb).toBe(25 / 101);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${BLOCK_FEE_SOURCE}/v1/blocks`,
    `${BLOCK_FEE_SOURCE}/v1/block/${hash(10)}/summary`, `${BLOCK_FEE_SOURCE}/v1/block/${hash(8)}/summary`, `${BLOCK_FEE_SOURCE}/block-height/10`]);
});

it('rejects broken pagination, incomplete summaries and a changed canonical anchor', async () => {
  await expect(captureBlockBackfill({ ...options(), fetcher: async () => Response.json([page[0], page[2]]) })).rejects.toThrow('E_BACKFILL_CHAIN');
  const base = fetcher();
  await expect(captureBlockBackfill({ ...options(), fetcher: async (url, init) => String(url).includes('/summary')
    ? Response.json(transactions.slice(0, 2)) : base(url, init) })).rejects.toThrow('E_BLOCK_FEES_INCOMPLETE');
  await expect(captureBlockBackfill({ ...options(), fetcher: async (url, init) => String(url).includes('/block-height/')
    ? new Response(hash(11)) : base(url, init) })).rejects.toThrow('E_BACKFILL_REORG');
});

it('links pages across their boundary and walks beyond a single early header timestamp', async () => {
  const first = [source(10, epoch - 100), source(9, epoch - 20000), source(8, epoch - 200)];
  const second = [source(7), source(6), source(5)];
  const fetch = vi.fn<typeof globalThis.fetch>(async url => String(url).endsWith('/blocks') ? Response.json(first)
    : String(url).endsWith('/blocks/7') ? Response.json(second) : new Response(hash(10)));
  const capture = await captureBlockBackfill({ ...options(), fetcher: fetch, known: async blocks => new Set(blocks.map(b => b.id)) });
  expect(capture.chain).toHaveLength(6); expect(capture.blocks).toHaveLength(0);
});

it('retries a transient summary timeout but stops on an explicit rate limit', async () => {
  const base = fetcher(); let attempts = 0;
  const oneMissing = { ...options(), known: async () => new Set([hash(9), hash(8)]) };
  const capture = await captureBlockBackfill({ ...oneMissing, fetcher: async (url, init) => {
    if (String(url).includes('/summary') && ++attempts === 1) throw new Error('timeout');
    return base(url, init);
  } });
  expect(attempts).toBe(2); expect(capture.blocks).toHaveLength(1);
  attempts = 0;
  await expect(captureBlockBackfill({ ...oneMissing, fetcher: async (url, init) => {
    if (String(url).includes('/summary')) { attempts++; return new Response('', { status: 429 }); }
    return base(url, init);
  } })).rejects.toThrow('E_BLOCK_FEES_RATE_LIMITED');
  expect(attempts).toBe(1);
});

it('appends compact historical evidence once and round-trips provenance through verified exports', async () => {
  const capture = await captureBlockBackfill({ ...options(), fetcher: fetcher() });
  expect(await importBlockBackfill(pool, capture, fetcher())).toMatchObject({ inserted: 2, skipped: 0 });
  expect(await importBlockBackfill(pool, capture, fetcher())).toMatchObject({ inserted: 0, skipped: 2 });
  const exported = await exportObservations(pool, 'mainnet', '2026-10-08T00:00:00Z', '2026-10-09T00:00:00Z');
  expect(exported.observations).toHaveLength(2);
  for (const record of exported.observations) expect(record.feeContext).toMatchObject({ kind: 'historical_blocks', rates: null,
    observedAt: now.toISOString(), completed: { status: 'available' } });
  const changed = structuredClone(capture); changed.blocks[0]!.height++;
  expect(() => validateBlockBackfill(changed)).toThrow('E_BACKFILL_RECORD');
  await expect(importBlockBackfill(pool, capture, async () => new Response(hash(11)))).rejects.toThrow('E_BACKFILL_REORG');
});

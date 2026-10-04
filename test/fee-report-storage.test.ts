import { afterAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { readFeeReport } from '../src/read/fees.js';

const db = new PGlite();
const client = { query: (sql: string, args: unknown[]) => db.query(sql, args) } as unknown as PoolClient;
const now = new Date('2026-10-04T15:00:00Z');
const context = (rate: number) => ({ provider: 'mempool', observedAt: now.toISOString(), status: 'available', error: null,
  rates: { fastestFee: rate, halfHourFee: rate, hourFee: rate, economyFee: rate, minimumFee: rate } });
afterAll(async () => db.close());

it('reads old retained runs without requiring the durable-observation migration', async () => {
  await db.exec('CREATE TABLE runs(network text, started_at timestamptz, finished_at timestamptz, results jsonb)');
  for (const [network, fee] of [['mainnet', 2], ['signet', 999]] as const)
    await db.query('INSERT INTO runs VALUES($1,$2,$2,$3)', [network, now.toISOString(), JSON.stringify({ feeContext: context(fee) })]);
  expect((await readFeeReport(client, 'mainnet', now, 3300, [])).rates?.fastestFee).toBe(2);
});

it('reads durable observations within the requested network and time boundary', async () => {
  await db.exec('CREATE TABLE fee_observations(network text, observed_at timestamptz, data jsonb)');
  for (const [network, fee] of [['mainnet', 3], ['signet', 999]] as const)
    await db.query('INSERT INTO fee_observations VALUES($1,$2,$3)', [network, now.toISOString(), JSON.stringify(context(fee))]);
  await db.query('INSERT INTO fee_observations VALUES($1,$2,$3)', ['mainnet', '2026-10-04T16:00:00Z', JSON.stringify(context(888))]);
  expect((await readFeeReport(client, 'mainnet', now, 3300, [])).rates?.fastestFee).toBe(3);
});

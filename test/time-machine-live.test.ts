import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readTimeMachine } from '../src/read/timeMachine.js';
import { refreshFeeResearch } from '../src/fees/refresh.js';
import * as capture from '../src/fees/archive.js';
import { feeArchiveSchema, feeModelConfigSchema } from '../src/fees/schema.js';
import { runFeeStudy } from '../src/fees/study.js';
import { digest } from '../src/replay/archive.js';
import { mergeCollected, walletFresh } from '../src/replay/report/live.js';
import { currentFeeFresh, forecastAt } from '../src/fees/report/state.js';
import { buildBurndown } from '../src/replay/report/burndown.js';
import { replayAt } from '../src/replay/run.js';
import { ArchiveIndex } from '../src/replay/asOfView.js';
import { replayFixture } from './replay-fixture.js';
import type { ReplayRecord } from '../src/replay/evaluate.js';
import timeMachine from '../api/time-machine.js';
import researchRefresh from '../api/research-refresh.js';

const db = new PGlite();
const query = async (sql: string, args?: unknown[]) => { const r = await db.query(sql, args); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 }; };
const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
const now = new Date(), timestamp = now.toISOString();
let record: ReplayRecord;
beforeAll(async () => {
  await db.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
  await db.exec(readFileSync('migrations/0002_fee_observations.sql', 'utf8'));
  await db.exec("INSERT INTO network_stamp(network) VALUES('mainnet'); INSERT INTO settings VALUES('mainnet',3300,true)");
  const { archive, v } = replayFixture();
  record = (await replayAt(new ArchiveIndex(archive), v, 160, 'ee')).record;
  record.snapshot.asOf = timestamp; record.snapshot.finishedAt = timestamp;
  await query("INSERT INTO wallets VALUES('mainnet','ee','EE','test','test')");
  const id = randomUUID();
  await query("INSERT INTO runs(run_id,network,status) VALUES($1,'mainnet','ok')", [id]);
  await query("INSERT INTO snapshots(network,wallet,run_id,scan_started_at,data) VALUES('mainnet','ee',$1,$2,$3)", [id, timestamp, JSON.stringify(record.snapshot)]);
  await query("INSERT INTO wallet_state(network,wallet,latest_snapshot,addresses,history,utxos) VALUES('mainnet','ee',$1,'[]','{}','[]')", [JSON.stringify(record.snapshot)]);
  await query("INSERT INTO daily_samples(network,wallet,day,snapshot,utxos) VALUES('mainnet','ee',$1,$2,'[]')", [timestamp.slice(0, 10), JSON.stringify(record.snapshot)]);
});
afterAll(() => db.close());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('reads exactly the monitor observations without provider calls or requiring the new migration', async () => {
  const fetcher = vi.fn(() => { throw new Error('Reads cannot fetch providers'); }); vi.stubGlobal('fetch', fetcher);
  const data = await readTimeMachine(pool, 'mainnet', now);
  expect(data.study).toBeNull(); expect(data.records).toHaveLength(1);
  expect(data.records[0]!.snapshot.composition).toEqual(record.snapshot.composition);
  expect(data.records[0]!.forecasts[0]!.dailySats).toBe(record.snapshot.naiveRunway.drainPerDaySats);
  expect(data.records[0]!.forecasts.slice(1).every(f => f.dailySats === null && f.reason === 'not_recorded')).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(readTimeMachine(pool, 'signet')).rejects.toThrow();
});

it('serves redacted transaction details and exact same-block fee benchmarks from storage', async () => {
  const { archive } = replayFixture();
  const tx = Object.values(archive.transactions)[0]!;
  tx.status.block_time = Math.floor(now.getTime() / 1000) - 60;
  const history = { transactions: { [tx.txid]: tx }, reveals: {} };
  const addresses = archive.addresses.filter(a => a.wallet === 'ee');
  const block = { id: tx.status.block_hash, height: tx.status.block_height, timestamp: tx.status.block_time,
    weight: 1000000, extras: { medianFee: 99, feeRange: [99] },
    transactionFees: { basis: 'median_transaction_fee_per_vbyte', transactionCount: 100, medianSatVb: 2.75 } };
  const ids = [randomUUID(), randomUUID()];
  await query("UPDATE wallet_state SET addresses=$1,history=$2 WHERE network='mainnet' AND wallet='ee'", [JSON.stringify(addresses), JSON.stringify(history)]);
  for (const [i, blocks] of [[0, [block]], [1, null]] as const)
    await query("INSERT INTO fee_observations VALUES('mainnet',$1,$2,1,$3,$4)", [ids[i], timestamp, 'a'.repeat(64), JSON.stringify({ completed: { blocks } })]);
  try {
    const fetcher = vi.fn(() => { throw new Error('No provider calls on reads'); }); vi.stubGlobal('fetch', fetcher);
    const data = await readTimeMachine(pool, 'mainnet', now);
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]).toMatchObject({ txid: tx.txid, vsize: 100, feeSats: 1000, benchmark: { kind: 'block_median', rate: 2.75 } });
    expect(JSON.stringify(data.transactions)).not.toMatch(/witness|scriptpubkey|descriptor/);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await query("UPDATE wallet_state SET addresses='[]',history='{}' WHERE network='mainnet' AND wallet='ee'");
    for (const id of ids) await query('DELETE FROM fee_observations WHERE run_id=$1', [id]);
  }
});

it('uses an independent lease, preserves daily history and keeps the last good study after provider failure', async () => {
  await db.exec(readFileSync('migrations/0003_fee_research.sql', 'utf8'));
  const seed = feeArchiveSchema.parse(JSON.parse(readFileSync('config/fee-history-seed.json', 'utf8')));
  const end = Math.floor(Date.now() / 1000) - 30;
  const body = { ...seed, capturedAt: new Date(end * 1000).toISOString(), buckets: seed.buckets.map(b => ({ ...b, start: b.start + end - seed.buckets.at(-1)!.end, end: b.end + end - seed.buckets.at(-1)!.end, availableAt: Math.min(end, (b.availableAt ?? b.end) + end - seed.buckets.at(-1)!.end) })) };
  const unsigned = { schemaVersion: body.schemaVersion, network: body.network, target: body.target, source: body.source, capturedAt: body.capturedAt, integerQuantized: body.integerQuantized, buckets: body.buckets, responses: body.responses };
  const archive = { ...unsigned, digest: digest(unsigned) };
  const fetcher = vi.spyOn(capture, 'captureFeeHistory').mockResolvedValue({ archive, rawResponses: {} });
  const refreshed = await refreshFeeResearch(pool);
  expect(refreshed.status).toBe('ok'); expect(fetcher).toHaveBeenCalledTimes(1);
  const data = await readTimeMachine(pool, 'mainnet');
  expect(data.study?.forecasts.some(f => f.model === 'seasonal' && f.points.length)).toBe(true);
  expect(data.study?.evaluationPeriods?.length).toBeGreaterThan(0);
  expect(data.researchError).toBeNull();
  expect((await query('SELECT * FROM time_machine_samples')).rowCount).toBe(1);
  expect((await query('SELECT * FROM run_lease')).rowCount).toBe(0);
  await query("UPDATE fee_research SET holder=$1,expires_at=now()+interval '5 minutes'", [randomUUID()]);
  expect((await refreshFeeResearch(pool)).status).toBe('skipped_lease_held');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await query("UPDATE fee_research SET expires_at=now()-interval '1 second'");
  fetcher.mockRejectedValue(new Error('provider down'));
  await expect(refreshFeeResearch(pool)).rejects.toThrow('E_RESEARCH_REFRESH');
  const failed = await readTimeMachine(pool, 'mainnet');
  expect(failed.study).toEqual(data.study); expect(failed.researchError).toBe('refresh_failed');
  expect(failed.researchUpdatedAt).toBe(data.researchUpdatedAt);
});

it('merges new observations without changing the archived past and expires current estimates', () => {
  const old = structuredClone(record); old.snapshot.asOf = new Date(now.getTime() - 86400000).toISOString();
  const live = { ...record, collected: true };
  const merged = mergeCollected([old], [old, live, live]);
  expect(merged).toHaveLength(2); expect(merged[0]).toBe(old); expect(merged[1]).toBe(live);
  expect(walletFresh(old, 3300, now.getTime())).toBe(false);
  expect(walletFresh(live, 3300, now.getTime())).toBe(true);
  expect(walletFresh(live, 3300, now.getTime() + 3301000)).toBe(false);
  expect(walletFresh(live, 3300, now.getTime() - 1)).toBe(false);
  const chart = buildBurndown(merged, live, 'current');
  expect(chart.actual.some(p => p.y === null)).toBe(true);
});

it('expires the current study while retaining causal historical forecasts', () => {
  const seed = feeArchiveSchema.parse(JSON.parse(readFileSync('config/fee-history-seed.json', 'utf8')));
  const origin = Date.parse(seed.capturedAt) / 1000;
  const study = runFeeStudy(seed, [], feeModelConfigSchema.parse({}), origin, undefined, undefined, 'a'.repeat(64));
  expect(currentFeeFresh(study, origin)).toBe(true);
  expect(currentFeeFresh(study, origin + 7201)).toBe(false);
  expect(currentFeeFresh({ ...study, coverage: { ...study.coverage, end: origin - 10801 } }, origin)).toBe(false);
  expect(forecastAt(study, origin + 7201)?.origin).toBe(origin);
  expect(forecastAt(study, origin - 1)?.origin).toBeLessThan(origin);
});

it('protects scheduled writes, isolates Signet and fails closed on missing storage', async () => {
  const secret = 'a'.repeat(32);
  vi.stubEnv('CRON_SECRET', secret); vi.stubEnv('STAGING_PREVIEW', ''); vi.stubEnv('NETWORK', 'mainnet'); vi.stubEnv('DATABASE_URL_METRICS', '');
  const request = (token?: string) => new Request('https://test/api/research-refresh', { headers: token ? { authorization: 'Bearer ' + token } : {} });
  expect((await researchRefresh.fetch(request())).status).toBe(401);
  expect((await timeMachine.fetch(request())).status).toBe(503);
  vi.stubEnv('NETWORK', 'signet');
  expect(await (await researchRefresh.fetch(request(secret))).json()).toMatchObject({ status: 'not_applicable', network: 'signet' });
  expect((await timeMachine.fetch(request())).status).toBe(409);
  vi.stubEnv('STAGING_PREVIEW', 'demo');
  expect((await researchRefresh.fetch(request(secret))).status).toBe(403);
});

import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/db/store.js';
import { parseInt8 } from '../src/db/pool.js';
import { readModel } from '../src/read/model.js';
import { computeWalletSnapshot } from '../src/pipeline/snapshot.js';
import { emptyHistory } from '../src/extract/history.js';
import { latestEeDa } from '../src/extract/eeDa.js';
import { txSchema } from '../src/chain/schemas.js';
import { config, hash, utxo } from './helpers.js';
import { createReadCache } from '../src/read/cache.js';
import { createWalletIndexReader, type IndexMeasurement } from '../src/db/walletIndex.js';
const embedded = process.env.TEST_DATABASE_URL ? null : new PGlite();
const real = process.env.TEST_DATABASE_URL ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
const query = async (sql: string, args?: unknown[]) => {
  if (real) return real.query(sql, args);
  const r = await embedded!.query(sql, args); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
};
const pool = real ?? { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool;
const store = new Store(pool), v = config();
function snapshot() {
  const asOf = new Date().toISOString();
  return computeWalletSnapshot({ asOfEpoch: Date.now() / 1000, utxos: [utxo(1000), utxo(546)], settlements: [], estimator: v.config.estimator, historyComplete: false,
    meta: { network: 'mainnet', wallet: 'ee', asOf, finishedAt: asOf, provider: 'fake', tip: { hash: hash(100), height: 100, blockTime: 100000 },
      addressesScanned: 40, ceilingHit: { receive: false, change: false }, requestsUsed: 50, primaryIsPublic: true, networkTipOld: false,
      historyError: 'E_HISTORY_INCOMPLETE', monitorVersion: '2.0.0', selectorModelVersion: 1, upstreamRef: v.config.upstream.ref,
      deployedBuildConfirmed: false, configSha256: v.sha256 } });
}
beforeAll(async () => {
  // TEST_DATABASE_URL must point at the disposable CI database, never a deployed database.
  const sql = readFileSync('migrations/0001_init.sql', 'utf8');
  if (embedded) await embedded.exec(sql); else await real!.query(sql);
  await query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, sha256 text NOT NULL)');
  await query("INSERT INTO schema_migrations VALUES(1,'test')");
  await query("INSERT INTO network_stamp(network) VALUES('mainnet')");
  await query("INSERT INTO settings VALUES('mainnet',3300,true)");
  for (const w of v.config.wallets) await query('INSERT INTO wallets VALUES($1,$2,$3,$4,$5)', ['mainnet', w.id, w.display_name, v.wallets.get(w.id)!.keyIdentity, v.wallets.get(w.id)!.checksum]);
});
afterAll(async () => { if (embedded) await embedded.close(); if (real) await real.end(); });
it('applies the migration and enforces network binding and startup identity', async () => {
  await store.assertConfig(v);
  await expect(query("INSERT INTO wallets VALUES('signet','ee','EE','key','sum')")).rejects.toThrow();
  await expect(query("INSERT INTO network_stamp(network) VALUES('signet')")).rejects.toThrow();
  const wrong = config(); wrong.wallets.get('ee')!.keyIdentity = 'wrong';
  await expect(store.assertConfig(wrong)).rejects.toThrow('E_WALLET_IDENTITY_CHANGED');
});
it('concurrent lease contenders yield exactly one owner; force cannot bypass the lease', async () => {
  const [a, b] = await Promise.all([store.acquire('mainnet', randomUUID(), 830, 900, true), store.acquire('mainnet', randomUUID(), 830, 900, true)]);
  expect([a,b].filter(Boolean)).toHaveLength(1);
  const lease = (a ?? b)!;
  expect(await store.acquire('mainnet', randomUUID(), 830, 900, true)).toBeNull();
  await store.release(lease, false);
});
it('rejects stale writers with a fencing token and deduplicates only successful slots', async () => {
  const first = (await store.acquire('mainnet', randomUUID(), 830, 900, true))!;
  await query("UPDATE run_lease SET expires_at=now()-interval '1 second'");
  const second = (await store.acquire('mainnet', randomUUID(), 830, 900, true))!;
  await expect(store.fenced(first, async () => 'unsafe')).rejects.toThrow('E_LEASE_LOST');
  await store.release(first, true);
  expect(await store.acquire('mainnet', randomUUID(), 830, 900, true)).toBeNull();
  await store.release(second, false);
  const third = (await store.acquire('mainnet', randomUUID(), 830, 900, false))!;
  expect(third).not.toBeNull(); await store.release(third, true);
  expect(await store.acquire('mainnet', randomUUID(), 830, 900, false)).toBeNull();
});
it('atomically persists an exact partition and a daily sample, and rejects bad identities', async () => {
  const runId = randomUUID(); await store.beginRun('mainnet', runId);
  const lease = (await store.acquire('mainnet', runId, 830, 900, true))!;
  const s = snapshot();
  const history = emptyHistory(), captured = JSON.parse(readFileSync('test/fixtures/mainnet/ee-settlement.json', 'utf8'));
  const commit = txSchema.parse(captured.commit), reveal = txSchema.parse(captured.reveals[0]);
  history.transactions = { [commit.txid]: commit, [reveal.txid]: reveal };
  history.reveals[commit.txid] = [reveal];
  await store.save(lease, s, [], history, [utxo(1000), utxo(546)]);
  const saved = await store.state('mainnet', 'ee');
  expect(saved.snapshot?.tip).toEqual(s.tip);
  expect(saved.utxos).toHaveLength(2);
  expect(saved.history.transactions[reveal.txid]?.vin[0]).toMatchObject({ witnessItemCount: 3 });
  expect(saved.history.transactions[reveal.txid]?.vin[0]?.witness).toBeUndefined();
  expect(latestEeDa(saved.history.transactions, new Set(captured.wallet_scripts), captured.provenance.tip, true))
    .toEqual(latestEeDa(history.transactions, new Set(captured.wallet_scripts), captured.provenance.tip, true));
  const model = await readModel(pool, 'mainnet', new Date());
  expect(model.wallets.find(w => w.wallet === 'ee')?.snapshot?.composition.spendableSats).toBe(1000);
  expect(model.wallets.find(w => w.wallet === 'ol')).toMatchObject({ snapshot: null, stale: true });
  const bad = { ...s, wallet: 'ol', composition: { ...s.composition, balanceSats: 1 } };
  await expect(store.save(lease, bad, [], emptyHistory(), [])).rejects.toThrow();
  expect((await query("SELECT * FROM wallet_state WHERE wallet='ol'")).rows).toHaveLength(0);
  await store.release(lease, true);
});
it('retains stale latest data and makes maintenance idempotent', async () => {
  const runId = randomUUID(); await store.beginRun('mainnet', runId);
  const lease = (await store.acquire('mainnet', runId, 830, 900, true))!;
  await query("UPDATE snapshots SET scan_started_at=now()-interval '20 days'");
  expect((await store.maintenance(lease, v.config.retention)).snapshotsRemoved).toBe(1);
  expect((await store.maintenance(lease, v.config.retention)).snapshotsRemoved).toBe(0);
  expect((await query('SELECT * FROM daily_rollup')).rows).toHaveLength(1);
  const model = await readModel(pool, 'mainnet', new Date(Date.now() + 4000000));
  expect(model.wallets.find(w => w.wallet === 'ee')).toMatchObject({ stale: true, snapshot: { composition: { spendableSats: 1000 } } });
  await store.release(lease, false);
});
it('int8 parser never silently loses satoshis', () => {
  expect(parseInt8('2100000000000000')).toBe(2100000000000000);
  expect(() => parseInt8('9007199254740993')).toThrow('E_DB_INTEGER_RANGE');
});
it.skipIf(!real)('coalesces cache fills across read-only transactions through PgBouncer', async () => {
  const values = new Map<string, unknown>(), fills: string[] = [];
  const storage = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: unknown) => { values.set(key, value); } };
  const instance = () => createReadCache(storage, 'postgres-cache-integration', m => fills.push(m.dataset));
  const now = new Date();
  const [a, b] = await Promise.all([readModel(pool, 'mainnet', now, instance()), readModel(pool, 'mainnet', now, instance())]);
  expect(a).toEqual(b);
  expect(fills.filter(name => name === 'status-wallets')).toHaveLength(1);
  expect(fills.filter(name => name === 'fee-contexts')).toHaveLength(1);
});
it.skipIf(!real)('shares the incremental wallet index across transactions through PgBouncer', async () => {
  const values = new Map<string, unknown>(), reads: IndexMeasurement[] = [];
  const backend = { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: unknown) => { values.set(key, value); } };
  const instance = () => createWalletIndexReader(backend, 'postgres-wallet-index', m => reads.push(m));
  const [a, b] = await Promise.all([instance()(pool, 'mainnet', 'ee'), instance()(pool, 'mainnet', 'ee')]);
  expect(a).toEqual(b);
  expect(reads.filter(r => r.cold)).toHaveLength(1);
  expect(reads.find(r => !r.cold)).toMatchObject({ changed: 0, removed: 0 });
  expect(reads.find(r => !r.cold)!.resultBytes).toBeLessThan(100);
});

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { config, hash, status } from './helpers.js';
import { deriveAddress } from '../src/derive/address.js';
import { runCollect } from '../src/pipeline/collectRun.js';
import statusHandler from '../api/status.js';
import metricsHandler from '../api/metrics.js';
const embedded = new PGlite();
const query = async (sql: string, args?: unknown[]) => {
  const r = await embedded.query(sql, args); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
};
const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
vi.mock('../src/db/pool.js', () => ({ database: () => pool }));
vi.mock('../src/config/load.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/config/load.js')>();
  return { ...original, loadConfig: () => {
    const v = config();
    v.config.providers.forEach(p => { p.min_interval_ms = 0; });
    v.config.wallets.forEach(w => { w.gap_scan = { min_indices: 1, gap_limit: 1, ceiling: 3 }; });
    return v;
  } };
});
beforeAll(async () => {
  await embedded.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
  await embedded.exec("CREATE TABLE schema_migrations(version integer PRIMARY KEY); INSERT INTO schema_migrations VALUES(1); INSERT INTO network_stamp(network) VALUES('mainnet'); INSERT INTO settings VALUES('mainnet',3300,true)");
  const v = config();
  for (const w of v.config.wallets) await query('INSERT INTO wallets VALUES($1,$2,$3,$4,$5)', ['mainnet', w.id, w.display_name, v.wallets.get(w.id)!.keyIdentity, v.wallets.get(w.id)!.checksum]);
});
afterAll(async () => embedded.close());
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('one failed wallet cannot starve the other; successful HTTP reads use only persisted data', async () => {
  const v = config(), ee = deriveAddress(v.wallets.get('ee')!, 0, 0, 'bc').address, ol = deriveAddress(v.wallets.get('ol')!, 0, 0, 'bc').address;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (new URL(url).hostname === 'mempool.space') return new Response('private upstream error body', { status: 500 });
    const path = new URL(url).pathname.replace('/api', '');
    if (path.startsWith('/block-height/')) return new Response(v.config.chain.checkpoint.hash);
    if (path === '/blocks/tip/hash') return new Response(hash(200));
    if (path === `/block/${hash(200)}`) return Response.json({ id: hash(200), height: 200, timestamp: Math.floor(Date.now()/1000) });
    if (path.includes(ee)) return new Response('private upstream error body', { status: 500 });
    if (path.endsWith('/utxo')) return Response.json([{ txid: hash(5), vout: 0, value: 700, status: status() }]);
    if (path.includes('/txs/chain')) return Response.json([]);
    return Response.json({ chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: Number(path === `/address/${ol}`) } });
  }));
  vi.stubEnv('NETWORK', 'mainnet');
  const result = await runCollect(true);
  expect(result.wallets).toMatchObject([{ wallet: 'ee', status: 'failed', error: 'E_PROVIDER_SERVER_ERROR' }, { wallet: 'ol', status: 'ok' }]);
  expect(result.feeContext).toMatchObject({ status: 'unavailable', rates: null, persistence: 'unavailable', completed: { status: 'unavailable' } });
  const storedRun = (await query('SELECT results FROM runs WHERE finished_at IS NOT NULL')).rows[0] as { results: { schemaVersion: number; wallets: unknown[] } };
  expect(storedRun.results).toMatchObject({ schemaVersion: 1, feeContext: { status: 'unavailable' }, wallets: [{ wallet: 'ee' }, { wallet: 'ol', forecast: { tip: { height: 200 } } }] });
  expect((await query("SELECT * FROM wallet_state WHERE wallet='ee'")).rows).toHaveLength(0);
  expect((await query("SELECT * FROM wallet_state WHERE wallet='ol'")).rows).toHaveLength(1);
  vi.stubEnv('NETWORK', 'mainnet');
  const forbiddenFetch = vi.fn(() => { throw new Error('Read path touched upstream'); }); vi.stubGlobal('fetch', forbiddenFetch);
  const json = await statusHandler.fetch(new Request('https://example.test/api/status'));
  expect(json.status).toBe(200);
  const body = await json.json();
  expect(body.wallets[1].snapshot.composition.spendableSats).toBe(700);
  expect(body.wallets[1].snapshot.feeContext).toMatchObject({ status: 'unavailable', rates: null });
  expect(body.wallets[0].stale).toBe(true);
  const text = await statusHandler.fetch(new Request('https://example.test/api/status?format=text'));
  expect(text.status).toBe(200); expect(await text.text()).toContain('Spendable: 700 sats');
  const metrics = await metricsHandler.fetch(new Request('https://example.test/api/metrics'));
  expect(metrics.status).toBe(200); expect(await metrics.text()).toContain('bridge_wallet_spendable_sats{network="mainnet",wallet="ol"} 700');
  expect(forbiddenFetch).not.toHaveBeenCalled();
});

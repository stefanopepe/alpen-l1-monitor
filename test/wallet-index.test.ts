import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { createWalletIndexReader, type IndexMeasurement } from '../src/db/walletIndex.js';
import { compactHistory, emptyHistory, sampleHistory } from '../src/extract/history.js';
import { address, config, fakeView, hash, pair, utxo } from './helpers.js';

const db = new PGlite();
const query = async (sql: string, args?: unknown[]) => {
  const r = await db.query(sql, args); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
};
const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
const values = new Map<string, unknown>(), measurements: IndexMeasurement[] = [];
const backend = { get: async (key: string) => values.get(key) ?? null,
  set: async (key: string, value: unknown) => { values.set(key, value); } };
const reader = () => createWalletIndexReader(backend, 'test', m => measurements.push(m));
const snapshot = { network: 'mainnet', wallet: 'ee', provider: 'fake', tip: { hash: hash(100), height: 100, blockTime: 100000 }, feeContext: { unused: 'x'.repeat(50000) } };
async function save(history = emptyHistory(), wallet = 'ee') {
  await query(`INSERT INTO wallet_state VALUES('mainnet',$1,$2,$3,$4,$5) ON CONFLICT(network,wallet)
    DO UPDATE SET addresses=$2,history=$3,latest_snapshot=$4,utxos=$5`,
  [wallet, JSON.stringify([address]), JSON.stringify(history), JSON.stringify({ ...snapshot, wallet }), JSON.stringify([utxo(546)])]);
}
beforeAll(async () => {
  await db.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
  await query("INSERT INTO network_stamp(network) VALUES('mainnet')");
  for (const wallet of ['ee', 'ol']) await query("INSERT INTO wallets VALUES('mainnet',$1,$1,$1,$1)", [wallet]);
});
afterAll(async () => { await db.close(); });

it('reconstructs exact history and inventory, including ordering, while omitting unused snapshot evidence', async () => {
  const { commit, reveal } = pair(), history = emptyHistory();
  history.transactions = { [commit.txid]: commit, [reveal.txid]: reveal };
  history.reveals[commit.txid] = [reveal];
  history.addresses[address.address] = { txids: [reveal.txid, commit.txid], cursor: commit.txid, coveredSince: -1 };
  const compact = compactHistory(history); await save(compact);
  const restored = await reader()(pool, 'mainnet', 'ee');
  expect(restored).toEqual({ addresses: [address], history: compact, utxos: [utxo(546)], snapshot: { provider: snapshot.provider, tip: snapshot.tip } });
  const view = fakeView({ addressTxsChain: async () => [reveal, commit] });
  const expected = await sampleHistory(view, [address], compact, config().config, await view.tip(), 120000);
  const actual = await sampleHistory(view, [address], restored.history, config().config, await view.tip(), 120000);
  expect(actual).toEqual(expected);
  expect(measurements.at(-1)?.cold).toBe(true);
  // A separate function instance reuses the shared index.
  expect(await reader()(pool, 'mainnet', 'ee')).toEqual(restored);
  expect(measurements.at(-1)).toMatchObject({ cold: false, changed: 0, removed: 0 });
  expect(measurements.at(-1)!.resultBytes).toBeLessThan(100);
});

it('transfers only a new transaction and membership even with a thousand retained transactions', async () => {
  values.clear(); const history = emptyHistory(), { commit } = pair();
  for (let i = 0; i < 1000; i++) { const txid = hash(10000 + i); history.transactions[txid] = { ...commit, txid }; }
  history.addresses[address.address] = { txids: Object.keys(history.transactions), cursor: null, coveredSince: -1 };
  await save(history); await reader()(pool, 'mainnet', 'ee');
  const cold = measurements.at(-1)!.resultBytes;
  const txid = hash(11000); history.transactions[txid] = { ...commit, txid };
  history.addresses[address.address]!.txids.push(txid);
  await save(history);
  expect((await reader()(pool, 'mainnet', 'ee')).history).toEqual(history);
  const delta = measurements.at(-1)!;
  expect(delta).toMatchObject({ cold: false, changed: 2, removed: 0 });
  expect(delta.resultBytes).toBeLessThan(2500);
  expect(delta.resultBytes).toBeLessThan(cold / 100);
  await reader()(pool, 'mainnet', 'ee');
  expect(measurements.at(-1)!.resultBytes).toBeLessThan(100);
  if (process.env.MEASURE_READ_TRANSFER) console.log(JSON.stringify({ coldBytes: cold, addedTransactionBytes: delta.resultBytes, unchangedBytes: measurements.at(-1)!.resultBytes }));
});

it('reconciles reorg replacements, deletions, incomplete reveals, cursor changes and an older cache pointer', async () => {
  values.clear(); const { commit, reveal } = pair(), history = compactHistory({ ...emptyHistory(),
    transactions: { [commit.txid]: commit, [reveal.txid]: reveal }, reveals: { [commit.txid]: [reveal] },
    addresses: { [address.address]: { txids: [commit.txid, reveal.txid], cursor: reveal.txid, coveredSince: -1 } } });
  await save(history); await reader()(pool, 'mainnet', 'ee');
  const oldCache = new Map(values);
  history.transactions[commit.txid]!.status.block_hash = hash(8000);
  delete history.transactions[reveal.txid]; delete history.reveals[commit.txid];
  history.addresses[address.address] = { txids: [commit.txid], cursor: null, coveredSince: null };
  await save(history);
  expect((await reader()(pool, 'mainnet', 'ee')).history).toEqual(history);
  expect(measurements.at(-1)).toMatchObject({ changed: 2, removed: 3 });
  for (const [key, value] of oldCache) values.set(key, value);
  expect((await reader()(pool, 'mainnet', 'ee')).history).toEqual(history);
  await query("DELETE FROM wallet_state WHERE wallet='ee'");
  expect(await reader()(pool, 'mainnet', 'ee')).toEqual({ addresses: [], history: emptyHistory() });
});

it('isolates wallets and networks and recovers correctly after eviction', async () => {
  values.clear(); await save(); const other = emptyHistory(), { commit } = pair();
  other.transactions[commit.txid] = commit; await save(other, 'ol');
  expect((await reader()(pool, 'mainnet', 'ee')).history).toEqual(emptyHistory());
  expect((await reader()(pool, 'mainnet', 'ol')).history).toEqual(other);
  expect(await reader()(pool, 'signet', 'ee')).toEqual({ addresses: [], history: emptyHistory() });
  values.clear();
  expect((await reader()(pool, 'mainnet', 'ol')).history).toEqual(other);
  expect(measurements.at(-1)?.cold).toBe(true);
});

it('propagates cache errors instead of silently reverting to full-history reads', async () => {
  const broken = createWalletIndexReader({ ...backend, get: async () => { throw new Error('cache offline'); } });
  await expect(broken(pool, 'mainnet', 'ee')).rejects.toThrow('cache offline');
  const badFormat = createWalletIndexReader({ ...backend, get: async () => ({ unexpected: true }) });
  await expect(badFormat(pool, 'mainnet', 'ee')).rejects.toThrow('E_WALLET_INDEX_FORMAT');
});

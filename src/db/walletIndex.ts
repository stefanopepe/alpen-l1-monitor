import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getCache, type RuntimeCache } from '@vercel/functions';
import type { Pool } from 'pg';
import type { ChainTx } from '../chain/schemas.js';
import { emptyHistory, type AddressHistory, type HistoryState } from '../extract/history.js';
import type { AddressRecord, Snapshot, Utxo } from '../types.js';
import { MONITOR_VERSION } from '../version.js';

export interface WalletState {
  addresses: AddressRecord[]; history: HistoryState; utxos?: Utxo[];
  snapshot?: Pick<Snapshot, 'provider' | 'tip'>;
}
type Backend = Pick<RuntimeCache, 'get' | 'set'>;
interface Entry { revision: string; data: unknown }
interface Index { revision: string; entries: Record<string, Entry> }
export interface IndexMeasurement { wallet: string; cold: boolean; changed: number; removed: number; resultBytes: number }
export type WalletIndexReader = (pool: Pool, network: string, wallet: string) => Promise<WalletState>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

// Index the existing durable state inside Postgres. Only delta rows cross the
// network; no migration, duplicate database or second chain scanner is needed.
const deltaQuery = `WITH state AS MATERIALIZED (
  SELECT addresses,history,utxos,latest_snapshot FROM wallet_state WHERE network=$1 AND wallet=$2
), source AS (
  SELECT 'address:'||(a->>'address') AS key,jsonb_build_object('position',n,'value',a) AS data
    FROM state,jsonb_array_elements(addresses) WITH ORDINALITY AS a(a,n)
  UNION ALL SELECT 'utxo:'||(u->>'txid')||':'||(u->>'vout'),jsonb_build_object('position',n,'value',u)
    FROM state,jsonb_array_elements(utxos) WITH ORDINALITY AS u(u,n)
  UNION ALL SELECT 'snapshot',jsonb_build_object('provider',latest_snapshot->'provider','tip',latest_snapshot->'tip') FROM state
  UNION ALL SELECT 'tx:'||key,value FROM state,jsonb_each(history->'transactions')
  UNION ALL SELECT 'reveals:'||key,value FROM state,jsonb_each(history->'reveals')
  UNION ALL SELECT 'history:'||key,value-'txids' FROM state,jsonb_each(history->'addresses')
  UNION ALL SELECT 'member:'||key||':'||(txid #>> '{}'),to_jsonb(n)
    FROM state,jsonb_each(history->'addresses'),jsonb_array_elements(value->'txids') WITH ORDINALITY AS t(txid,n)
), current AS MATERIALIZED (SELECT key,md5(data::text) AS revision,data FROM source),
known AS MATERIALIZED (SELECT key,value AS revision FROM jsonb_each_text($3::jsonb))
SELECT c.key,c.revision,c.data FROM current c LEFT JOIN known k USING(key) WHERE c.revision IS DISTINCT FROM k.revision
UNION ALL SELECT k.key,NULL,NULL FROM known k WHERE NOT EXISTS (SELECT 1 FROM current c WHERE c.key=k.key)`;

function restore(entries: Index['entries']): WalletState {
  const history = emptyHistory(), addresses: { position: number; value: AddressRecord }[] = [], utxos: { position: number; value: Utxo }[] = [];
  const members = new Map<string, { txid: string; position: number }[]>();
  let snapshot: WalletState['snapshot'];
  for (const [key, { data }] of Object.entries(entries)) {
    if (key.startsWith('address:')) addresses.push(data as typeof addresses[number]);
    else if (key.startsWith('utxo:')) utxos.push(data as typeof utxos[number]);
    else if (key === 'snapshot') snapshot = data as WalletState['snapshot'];
    else if (key.startsWith('tx:')) history.transactions[key.slice(3)] = data as ChainTx;
    else if (key.startsWith('reveals:')) history.reveals[key.slice(8)] = data as ChainTx[];
    else if (key.startsWith('history:')) history.addresses[key.slice(8)] = { ...data as Omit<AddressHistory, 'txids'>, txids: [] };
    else if (key.startsWith('member:')) {
      const split = key.lastIndexOf(':'), address = key.slice(7, split);
      const list = members.get(address) ?? [];
      list.push({ txid: key.slice(split + 1), position: data as number }); members.set(address, list);
    } else throw new Error('E_WALLET_INDEX_KEY');
  }
  for (const [address, rows] of members) {
    if (!history.addresses[address]) throw new Error('E_WALLET_INDEX_MEMBERSHIP');
    history.addresses[address].txids = rows.sort((a, b) => a.position - b.position).map(r => r.txid);
  }
  return { addresses: addresses.sort((a, b) => a.position - b.position).map(r => r.value), history,
    ...(snapshot ? { snapshot, utxos: utxos.sort((a, b) => a.position - b.position).map(r => r.value) } : {}) };
}

export function createWalletIndexReader(backend?: Backend, scope = '', onRead?: (m: IndexMeasurement) => void): WalletIndexReader {
  return async (pool, network, wallet) => {
    const c = await pool.connect(), key = hash(JSON.stringify([scope, network, wallet]));
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Same-wallet cold starts coalesce. The DB remains authoritative even if an
      // older transaction replaces the cache pointer: the next read reconciles it.
      if (backend) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const head = await c.query(`SELECT md5(jsonb_build_array(addresses,history,utxos,
        latest_snapshot->'provider',latest_snapshot->'tip')::text) AS revision FROM wallet_state WHERE network=$1 AND wallet=$2`, [network, wallet]);
      const revision = head.rows[0]?.revision ?? 'absent';
      const packed = await backend?.get(key);
      if (packed !== undefined && packed !== null && typeof packed !== 'string') throw new Error('E_WALLET_INDEX_FORMAT');
      const prior: Index | undefined = packed ? JSON.parse(gunzipSync(Buffer.from(packed as string, 'base64'),
        { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8')) as Index : undefined;
      if (prior && (typeof prior.revision !== 'string' || !prior.entries || typeof prior.entries !== 'object')) throw new Error('E_WALLET_INDEX_FORMAT');
      const index: Index = prior ?? { revision: 'uninitialized', entries: {} };
      let changed = 0, removed = 0, resultBytes = Buffer.byteLength(JSON.stringify(head.rows));
      if (index.revision !== revision) {
        const known = Object.fromEntries(Object.entries(index.entries).map(([id, entry]) => [id, entry.revision]));
        const delta = await c.query(deltaQuery, [network, wallet, JSON.stringify(known)]);
        resultBytes += Buffer.byteLength(JSON.stringify(delta.rows));
        for (const row of delta.rows) {
          if (row.revision === null) { delete index.entries[row.key]; removed++; }
          else { index.entries[row.key] = { revision: row.revision, data: row.data }; changed++; }
        }
        index.revision = revision;
        if (backend) {
          const value = gzipSync(JSON.stringify(index)).toString('base64');
          if (Buffer.byteLength(value) > 1800000) throw new Error('E_WALLET_INDEX_SIZE');
          await backend.set(key, value, { ttl: 86400, name: 'wallet-index' });
        }
      }
      const state = restore(index.entries);
      await c.query('COMMIT');
      onRead?.({ wallet, cold: !prior, changed, removed, resultBytes });
      return state;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  };
}

export function walletIndexReader(): WalletIndexReader {
  if (!process.env.VERCEL) return createWalletIndexReader();
  const scope = JSON.stringify([MONITOR_VERSION, process.env.VERCEL_PROJECT_ID, process.env.VERCEL_ENV,
    process.env.VERCEL_URL, hash(process.env.DATABASE_URL ?? '')]);
  return createWalletIndexReader(getCache({ namespace: 'wallet-index-v1', keyHashFunction: key => key }), scope,
    m => console.info(JSON.stringify({ event: 'wallet_index_read', ...m })));
}

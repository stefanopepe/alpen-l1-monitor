import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getCache, type RuntimeCache } from '@vercel/functions';
import type { PoolClient } from 'pg';
import { MONITOR_VERSION } from '../version.js';

export type ReadCache = <T>(client: PoolClient, name: string, revision: unknown, load: () => Promise<T>) => Promise<T>;
export const uncachedRead: ReadCache = (_client, _name, _revision, load) => load();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Call inside a transaction. The transaction lock also coalesces misses across instances. */
export function createReadCache(backend: Pick<RuntimeCache, 'get' | 'set'>, scope: string,
  onFill?: (measurement: { dataset: string; resultBytes: number; cacheBytes: number }) => void): ReadCache {
  return async <T>(client: PoolClient, name: string, revision: unknown, load: () => Promise<T>): Promise<T> => {
    const key = hash(JSON.stringify([scope, name, revision]));
    const decode = (entry: unknown): T | undefined => {
      if (entry === null || entry === undefined) return undefined;
      if (typeof entry !== 'string') throw new Error('E_READ_CACHE_FORMAT');
      return JSON.parse(gunzipSync(Buffer.from(entry, 'base64'), { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8')) as T;
    };
    const cached = decode(await backend.get(key));
    if (cached !== undefined) return cached;
    // Transaction-scoped locks work with transaction-mode PgBouncer and read-only roles.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const filled = decode(await backend.get(key));
    if (filled !== undefined) return filled;
    const value = await load(), json = JSON.stringify(value), packed = gzipSync(json).toString('base64');
    // Vercel Runtime Cache has a 2 MB item limit. Never silently disable caching on overflow.
    if (Buffer.byteLength(packed) > 1800000) throw new Error('E_READ_CACHE_SIZE');
    await backend.set(key, packed, { ttl: 86400, name });
    onFill?.({ dataset: name, resultBytes: Buffer.byteLength(json), cacheBytes: Buffer.byteLength(packed) });
    return value;
  };
}

export function readCache(network: string): ReadCache {
  if (!process.env.VERCEL) return uncachedRead;
  // No raw connection string is exposed in cache keys, names or logs.
  const scope = JSON.stringify([MONITOR_VERSION, process.env.VERCEL_PROJECT_ID, process.env.VERCEL_ENV,
    process.env.VERCEL_URL, network, hash(process.env.DATABASE_URL_METRICS ?? '')]);
  return createReadCache(getCache({ namespace: 'monitor-read-v1', keyHashFunction: key => key }), scope,
    measurement => console.info(JSON.stringify({ event: 'read_cache_fill', ...measurement })));
}

/** Reuse immutable time groups; new evidence transfers only the groups it changes. */
export async function groupedRows<T>(client: PoolClient, cache: ReadCache, name: string, source: string, args: unknown[], versionSource = source): Promise<T[]> {
  const versions = await client.query(`SELECT bucket,md5(string_agg(revision,',' ORDER BY revision)) AS revision
    FROM (${versionSource}) AS source GROUP BY bucket ORDER BY bucket`, args);
  return cache(client, name, versions.rows, async () => {
    const rows: T[] = [];
    for (const { bucket, revision } of versions.rows) {
      const group = await cache(client, `${name}:${bucket}`, revision, async () => {
        const result = await client.query(`SELECT data FROM (${source}) AS source WHERE bucket=$${args.length + 1}`, [...args, bucket]);
        return result.rows.map(row => row.data as T);
      });
      rows.push(...group);
    }
    return rows;
  });
}

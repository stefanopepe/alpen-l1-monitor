import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
const { Pool, types } = pg;
export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('E_DB_INTEGER_RANGE');
  return n;
}
types.setTypeParser(20, parseInt8);
const pools = new Map<string, pg.Pool>();
export function database(mode: 'read' | 'write'): pg.Pool {
  const key = mode === 'read' ? 'DATABASE_URL_METRICS' : 'DATABASE_URL';
  const connectionString = process.env[key];
  if (!connectionString) throw new Error('E_DATABASE_NOT_CONFIGURED');
  let pool = pools.get(key);
  if (!pool) {
    pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, query_timeout: 15000 });
    pool.on('error', () => { /* Never emit connection strings or driver errors. Requests report E_DATABASE. */ });
    if (process.env.VERCEL) attachDatabasePool(pool);
    pools.set(key, pool);
  }
  return pool;
}

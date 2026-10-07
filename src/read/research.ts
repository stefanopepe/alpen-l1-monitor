import type { Pool } from 'pg';
import { feePressureSchema } from '../fees/schema.js';
import { groupedRows, readCache, type ReadCache } from './cache.js';

export async function readResearchPressure(pool: Pool, now: Date, cache: ReadCache = readCache('mainnet')) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = await groupedRows<unknown>(c, cache, 'research-pressure', `SELECT
      date_trunc('hour',observed_at AT TIME ZONE 'UTC')::text AS bucket,data->'pressure' AS data FROM fee_observations
      WHERE network='mainnet' AND observed_at >= $1::timestamptz-interval '30 days' AND observed_at <= $1 AND data ? 'pressure'`, [now.toISOString()],
    `SELECT date_trunc('hour',observed_at AT TIME ZONE 'UTC')::text AS bucket,run_id::text||':'||xmin::text AS revision FROM fee_observations
      WHERE network='mainnet' AND observed_at >= $1::timestamptz-interval '30 days' AND observed_at <= $1`);
    const pressure = rows.map(row => feePressureSchema.parse(row)).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    await c.query('COMMIT');
    return pressure;
  } catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}

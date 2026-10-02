import type { Pool } from 'pg';
import { z } from 'zod';
import { feeContextSchema } from '../observations/schema.js';
import { createHash } from 'node:crypto';
export const observationEnvelopeSchema = z.object({ schemaVersion: z.literal(1), feeContext: feeContextSchema,
  wallets: z.array(z.object({ wallet: z.string(), status: z.string(), asOf: z.string().optional(), forecast: z.unknown().optional() })) });
export function decodeRunResults(input: unknown) {
  if (Array.isArray(input)) return { legacy: true, feeContext: null, wallets: input };
  const parsed = observationEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw new Error('E_OBSERVATIONS_SCHEMA');
  return { legacy: false, feeContext: parsed.data.feeContext, wallets: parsed.data.wallets };
}
export async function exportObservations(pool: Pool, network: string, from: string, to: string) {
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) > Date.parse(to)) throw new Error('E_OBSERVATIONS_RANGE');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const stamp = await client.query('SELECT network FROM network_stamp');
    if (stamp.rows.length !== 1 || stamp.rows[0].network !== network) throw new Error('E_DB_NETWORK');
    const rows = await client.query('SELECT run_id,started_at,status,results FROM runs WHERE network=$1 AND started_at >= $2 AND started_at <= $3 AND finished_at IS NOT NULL ORDER BY started_at,run_id', [network, from, to]);
    const observations = rows.rows.map(row => ({ runId: row.run_id as string, startedAt: new Date(row.started_at).toISOString(),
      status: row.status as string, ...decodeRunResults(row.results) }));
    // Probe without querying an absent relation: pre-migration databases remain readable.
    const relation = await client.query("SELECT to_regclass('fee_observations') AS name");
    if (relation.rows[0]?.name) {
      const evidence = await client.query('SELECT run_id,observed_at,schema_version,sha256,data FROM fee_observations WHERE network=$1 AND observed_at >= $2 AND observed_at <= $3 ORDER BY observed_at,run_id', [network, from, to]);
      for (const row of evidence.rows) {
        const feeContext = feeContextSchema.parse(row.data);
        if (row.schema_version !== 1 || createHash('sha256').update(JSON.stringify(feeContext)).digest('hex') !== row.sha256) throw new Error('E_OBSERVATIONS_DIGEST');
        const run = observations.find(o => o.runId === row.run_id);
        if (run) run.feeContext = feeContext;
        else observations.push({ runId: row.run_id, startedAt: new Date(row.observed_at).toISOString(), status: 'retained_evidence', legacy: false, feeContext, wallets: [] });
      }
      observations.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
    }
    await client.query('COMMIT');
    return { schemaVersion: 1, network, from, to, observations };
  } catch { await client.query('ROLLBACK'); throw new Error('E_OBSERVATIONS_READ'); } finally { client.release(); }
}

import { z } from 'zod';
import type { Pool } from 'pg';
import type { Snapshot } from '../types.js';
import { feeContextSchema } from '../observations/schema.js';
const n = z.number().finite().nonnegative(), i = n.int().safe();
const snapshotSchema = z.object({
  feeContext: z.unknown().transform(v => feeContextSchema.safeParse(v).data).optional(),
  network: z.string(), wallet: z.string(), asOf: z.iso.datetime(), finishedAt: z.iso.datetime(), provider: z.string(),
  tip: z.object({ height: i, hash: z.string().regex(/^[0-9a-f]{64}$/), blockTime: i }),
  ceilingHit: z.object({ receive: z.boolean(), change: z.boolean() }), addressesScanned: i,
  composition: z.object({ balanceSats: i, spendableSats: i, strandedSats: i, unconfirmedGtDustSats: i, unsupportedGtDustSats: i, largestUtxoSats: i,
    counts: z.object({ total: i, dust: i, confirmedSpendable: i, unconfirmed: i, unsupported: i }) }),
  naiveRunway: z.object({ method: z.literal('spendable / (observed median settlement drain * median-interval cadence)'),
    days: n.nullable(), aggregateDays: n.nullable(), drainPerDaySats: n.nullable(), costPerSettlementSats: n.nullable(), settlementsPerDay: n.nullable(),
    sampleSize: i, sampleSpanDays: n, historyComplete: z.boolean(),
    reason: z.enum(['available', 'no_spendable_funds', 'discovery_incomplete', 'history_incomplete', 'insufficient_settlements', 'cadence_unavailable']) }),
  requestsUsed: i, primaryIsPublic: z.boolean(), networkTipOld: z.boolean(), historyError: z.string().nullable(),
  monitorVersion: z.string(), selectorModelVersion: i, upstreamRef: z.string(), deployedBuildConfirmed: z.boolean(), configSha256: z.string(),
});
export interface ReadModel {
  network: string; readAt: string; primaryIsPublic: boolean;
  wallets: { wallet: string; name: string; stale: boolean; ageSeconds: number | null; snapshot: Snapshot | null; feeContextStale?: boolean }[];
  providerErrors: { provider: string; total: number }[];
}
export async function readModel(pool: Pool, network: string, now: Date): Promise<ReadModel> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const settings = await c.query('SELECT stale_after_s,primary_is_public FROM settings WHERE network=$1', [network]);
    if (settings.rowCount !== 1) throw new Error('E_DB_NETWORK');
    const rows = await c.query(`SELECT w.wallet,w.display_name,s.latest_snapshot FROM wallets w LEFT JOIN wallet_state s USING(network,wallet) WHERE w.network=$1 ORDER BY w.wallet`, [network]);
    const errors = await c.query('SELECT provider,total FROM provider_errors WHERE network=$1 ORDER BY provider', [network]);
    const wallets = rows.rows.map(row => {
      const snapshot = row.latest_snapshot === null ? null : snapshotSchema.parse(row.latest_snapshot);
      if (snapshot && (snapshot.network !== network || snapshot.wallet !== row.wallet)) throw new Error('E_DB_NETWORK');
      const ageSeconds = snapshot ? Math.max(0, (now.getTime() - Date.parse(snapshot.asOf)) / 1000) : null;
      return { wallet: row.wallet as string, name: row.display_name as string, snapshot, ageSeconds,
        feeContextStale: !snapshot?.feeContext || snapshot.feeContext.status !== 'available' ||
          now.getTime() - Date.parse(snapshot.feeContext.observedAt) > settings.rows[0].stale_after_s * 1000,
        stale: ageSeconds === null || ageSeconds > settings.rows[0].stale_after_s };
    });
    if (!wallets.length) throw new Error('E_DB_WALLETS');
    await c.query('COMMIT');
    return { network, readAt: now.toISOString(), primaryIsPublic: settings.rows[0].primary_is_public, wallets,
      providerErrors: errors.rows as { provider: string; total: number }[] };
  } catch { await c.query('ROLLBACK'); throw new Error('E_DATABASE_READ'); } finally { c.release(); }
}

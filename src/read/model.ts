import { z } from 'zod';
import type { Pool } from 'pg';
import type { Snapshot } from '../types.js';
import { feeContextSchema } from '../observations/schema.js';
import { readFeeReport, type FeeReport } from './fees.js';
import { readCache, type ReadCache } from './cache.js';
const n = z.number().finite().nonnegative(), i = n.int().safe();
const average = z.object({ averageSatVb: n.nullable(), sampleSize: i, complete: z.boolean() });
export const snapshotSchema = z.object({
  publicationReport: z.object({ latest: z.object({ commitTxid: z.string().regex(/^[0-9a-f]{64}$/), feeSats: i, feeRateSatVb: n,
    previous24h: average, previous7d: average }).nullable(), nextExpectedAt: n.nullable(), intervalSeconds: n.nullable(), timingSampleSize: i }).optional(),
  eeDaContext: z.object({ sourceRef: z.string().regex(/^[0-9a-f]{40}$/), coverageComplete: z.boolean(), pendingPublications: i, undecodedPublications: i,
    pending: z.array(z.object({ commitTxid: z.string().regex(/^[0-9a-f]{64}$/), blockHeight: i, blockTime: i,
      chunkCount: i.positive(), confirmedChunks: i, observedPayloadBytes: i.nullable(), commitVsize: i.positive(), confirmedRevealVsize: i,
      estimatedPayloadBytes: i.nullable(), estimatedRemainingVsize: i.nullable(), estimatedTotalVsize: i.nullable(),
      expectedBlockHeight: i.nullable(), expectedAt: i.nullable(), sampleSize: i })).optional(),
    latest: z.object({ updateSeqNo: z.string().regex(/^(0|[1-9][0-9]*)$/), lastEvmBlock: z.string().regex(/^(0|[1-9][0-9]*)$/),
      evmTimestamp: z.string().regex(/^(0|[1-9][0-9]*)$/), version: z.literal(0), commitTxid: z.string().regex(/^[0-9a-f]{64}$/),
      revealTxids: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1), chunkCount: i.positive(), payloadBytes: i.positive(),
      blockHeight: i, blockHash: z.string().regex(/^[0-9a-f]{64}$/), blockTime: i }).nullable() }).optional(),
  epochContext: z.object({ sourceRef: z.string().regex(/^[0-9a-f]{40}$/), coverageComplete: z.boolean(), undecodedCheckpoints: i,
    latest: z.object({ epoch: i.max(0xffffffff), l1Height: i.max(0xffffffff), l2Slot: z.string().regex(/^(0|[1-9][0-9]*)$/),
      l2BlockId: z.string().regex(/^[0-9a-f]{64}$/), commitTxid: z.string().regex(/^[0-9a-f]{64}$/), txid: z.string().regex(/^[0-9a-f]{64}$/),
      blockHeight: i, blockHash: z.string().regex(/^[0-9a-f]{64}$/), blockTime: i }).nullable() }).optional(),
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
  fees?: FeeReport;
  preview?: { capturedAt: string; sample?: boolean };
  network: string; readAt: string; primaryIsPublic: boolean;
  wallets: { wallet: string; name: string; stale: boolean; ageSeconds: number | null; snapshot: Snapshot | null; feeContextStale?: boolean }[];
  providerErrors: { provider: string; total: number }[];
}
export async function readModel(pool: Pool, network: string, now: Date, cache: ReadCache = readCache(network)): Promise<ReadModel> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const settings = await c.query('SELECT stale_after_s,primary_is_public FROM settings WHERE network=$1', [network]);
    if (settings.rowCount !== 1) throw new Error('E_DB_NETWORK');
    const versions = await c.query(`SELECT w.wallet,w.display_name,md5(s.latest_snapshot::text) AS revision
      FROM wallets w LEFT JOIN wallet_state s USING(network,wallet) WHERE w.network=$1 ORDER BY w.wallet`, [network]);
    const rows = await cache(c, 'status-wallets', versions.rows, async () => (await c.query(`SELECT w.wallet,w.display_name,
      s.latest_snapshot #- '{feeContext,pressure}' AS latest_snapshot
      FROM wallets w LEFT JOIN wallet_state s USING(network,wallet) WHERE w.network=$1 ORDER BY w.wallet`, [network])).rows);
    const errors = await c.query('SELECT provider,total FROM provider_errors WHERE network=$1 ORDER BY provider', [network]);
    const wallets = rows.map(row => {
      const snapshot = row.latest_snapshot === null ? null : snapshotSchema.parse(row.latest_snapshot);
      if (snapshot && (snapshot.network !== network || snapshot.wallet !== row.wallet)) throw new Error('E_DB_NETWORK');
      const ageSeconds = snapshot ? Math.max(0, (now.getTime() - Date.parse(snapshot.asOf)) / 1000) : null;
      return { wallet: row.wallet as string, name: row.display_name as string, snapshot, ageSeconds,
        feeContextStale: !snapshot?.feeContext || snapshot.feeContext.status !== 'available' ||
          now.getTime() - Date.parse(snapshot.feeContext.observedAt) > settings.rows[0].stale_after_s * 1000,
        stale: ageSeconds === null || ageSeconds > settings.rows[0].stale_after_s };
    });
    if (!wallets.length) throw new Error('E_DB_WALLETS');
    const fees = await readFeeReport(c, network, now, settings.rows[0].stale_after_s, wallets.flatMap(w => w.snapshot?.feeContext ? [w.snapshot.feeContext] : []), cache);
    await c.query('COMMIT');
    return { network, readAt: now.toISOString(), primaryIsPublic: settings.rows[0].primary_is_public, wallets, fees,
      providerErrors: errors.rows as { provider: string; total: number }[] };
  } catch { await c.query('ROLLBACK'); throw new Error('E_DATABASE_READ'); } finally { c.release(); }
}

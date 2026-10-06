import type { Pool } from 'pg';
import type { FeeStudy } from '../fees/schema.js';
import type { ReplayRecord } from '../replay/evaluate.js';
import { snapshotSchema } from './model.js';
import { feeBucketSchema, type FeeBucket } from '../fees/schema.js';
import { completedBlockSchema } from '../observations/schema.js';
import { summarizeStoredTransactions, type FeeBenchmark } from '../transactions.js';

export async function readTimeMachine(pool: Pool, network: string, now = new Date()) {
  if (network !== 'mainnet') throw new Error('E_TIME_MACHINE_NETWORK');
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const stamp = await c.query('SELECT network FROM network_stamp');
    if (stamp.rows.length !== 1 || stamp.rows[0].network !== network) throw new Error('E_TIME_MACHINE_NETWORK');
    const settings = await c.query('SELECT stale_after_s FROM settings WHERE network=$1', [network]);
    if (!settings.rowCount) throw new Error('E_TIME_MACHINE_SETTINGS');
    const samples = await c.query(`WITH hourly AS (
      SELECT DISTINCT ON (wallet,date_trunc('hour',scan_started_at)) wallet,scan_started_at,data
      FROM snapshots WHERE network=$1 AND scan_started_at >= $2::timestamptz-interval '14 days' AND scan_started_at <= $2
      ORDER BY wallet,date_trunc('hour',scan_started_at),scan_started_at DESC
    ) SELECT data FROM hourly UNION ALL
      SELECT snapshot AS data FROM daily_samples WHERE network=$1 AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date-30 UNION ALL
      SELECT latest_snapshot AS data FROM wallet_state WHERE network=$1`, [network, now.toISOString()]);
    const relation = await c.query("SELECT to_regclass('fee_research') AS name");
    if (relation.rows[0]?.name) {
      const history = await c.query('SELECT snapshot AS data FROM time_machine_samples WHERE network=$1', [network]);
      samples.rows.push(...history.rows);
    }
    const records: ReplayRecord[] = samples.rows.flatMap(row => {
      const snapshot = snapshotSchema.parse(row.data);
      if (snapshot.network !== network) throw new Error('E_TIME_MACHINE_NETWORK');
      if (Date.parse(snapshot.asOf) > now.getTime()) return [];
      // Completed-block payloads are not needed for wallet replay; keep response bounded.
      delete snapshot.feeContext;
      return [{ snapshot, trainingRef: 'collected', collected: true,
        forecasts: [{ model: 'current', dailySats: snapshot.naiveRunway.drainPerDaySats, reason: snapshot.naiveRunway.reason, sampleSize: snapshot.naiveRunway.sampleSize },
          ...(['mean7', 'mean30'] as const).map(model => ({ model, dailySats: null, reason: 'not_recorded', sampleSize: 0 }))] }];
    });
    let study: FeeStudy | null = null, researchUpdatedAt: string | null = null, researchError: string | null = null;
    let buckets: FeeBucket[] = [];
    if (relation.rows[0]?.name) {
      const state = await c.query('SELECT study,archive,updated_at,last_error FROM fee_research WHERE network=$1', [network]);
      if (state.rows[0]?.archive?.buckets) buckets = feeBucketSchema.array().parse(state.rows[0].archive.buckets);
      if (state.rows[0]?.study) {
        const saved = state.rows[0].study as FeeStudy;
        // Scores are retained, but large per-origin evaluations stay in storage.
        const evaluationPeriods = [1, 3, 5, 7].flatMap(horizonDays => ['daily', 'non_overlapping'].flatMap(sampling => {
          const es = saved.evaluations.filter(e => e.horizonDays === horizonDays && (sampling === 'daily' || e.nonOverlapping));
          return es.length ? [{ horizonDays, sampling, from: es[0]!.origin, to: es.at(-1)!.origin }] : [];
        }));
        study = { ...saved, evaluationPeriods, evaluations: [], timeline: saved.timeline?.filter(t => t.origin >= saved.asOf - 7 * 86400) };
        researchUpdatedAt = new Date(state.rows[0].updated_at).toISOString();
      }
      researchError = state.rows[0]?.last_error ?? null;
    }
    const observations = await c.query(`SELECT DISTINCT ON (block->>'id') block FROM fee_observations,
      LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(data->'completed'->'blocks')='array' THEN data->'completed'->'blocks' ELSE '[]'::jsonb END) AS block
      WHERE network=$1 AND observed_at >= $2::timestamptz-interval '90 days' AND observed_at <= $2
        AND block->'transactionFees'->>'basis'='median_transaction_fee_per_vbyte'
      ORDER BY block->>'id',observed_at DESC`, [network, now.toISOString()]);
    const blockRates = new Map<string, FeeBenchmark>();
    for (const row of observations.rows) {
      const parsed = completedBlockSchema.safeParse(row.block);
      const b = parsed.success ? parsed.data : null, rate = b?.transactionFees?.medianSatVb;
      if (b && rate !== null && rate !== undefined && b.timestamp <= now.getTime() / 1000)
        blockRates.set(b.id, { kind: 'block_median', rate, start: b.timestamp, end: b.timestamp });
    }
    const wallets = await c.query('SELECT wallet,addresses,history FROM wallet_state WHERE network=$1', [network]);
    const transactions = wallets.rows.flatMap(w => summarizeStoredTransactions(w.wallet as string, w.addresses, w.history, buckets, blockRates))
      .filter(tx => tx.time <= now.getTime() / 1000 && tx.time >= now.getTime() / 1000 - 90 * 86400);
    await c.query('COMMIT');
    const unique = [...new Map(records.map(r => [r.snapshot.wallet + ':' + r.snapshot.asOf, r])).values()]
      .sort((a, b) => Date.parse(a.snapshot.asOf) - Date.parse(b.snapshot.asOf));
    return { network, readAt: now.toISOString(), staleAfterSeconds: settings.rows[0].stale_after_s as number,
      records: unique, transactions, study, researchUpdatedAt, researchError };
  } catch { await c.query('ROLLBACK'); throw new Error('E_TIME_MACHINE_READ'); }
  finally { c.release(); }
}

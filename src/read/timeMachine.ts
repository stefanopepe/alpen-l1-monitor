import type { Pool } from 'pg';
import type { FeeStudy } from '../fees/schema.js';
import type { ReplayRecord } from '../replay/evaluate.js';
import { snapshotSchema } from './model.js';
import { feeBucketSchema, type FeeBucket } from '../fees/schema.js';
import { completedBlockSchema } from '../observations/schema.js';
import { feeBenchmark, summarizeStoredTransactions, type FeeBenchmark } from '../transactions.js';
import { groupedRows, readCache, type ReadCache } from './cache.js';
import { transactionSource } from './transactionQuery.js';

export async function readTimeMachine(pool: Pool, network: string, now = new Date(), cache: ReadCache = readCache(network)) {
  if (network !== 'mainnet') throw new Error('E_TIME_MACHINE_NETWORK');
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const stamp = await c.query('SELECT network FROM network_stamp');
    if (stamp.rows.length !== 1 || stamp.rows[0].network !== network) throw new Error('E_TIME_MACHINE_NETWORK');
    const settings = await c.query('SELECT stale_after_s FROM settings WHERE network=$1', [network]);
    if (!settings.rowCount) throw new Error('E_TIME_MACHINE_SETTINGS');
    const samples = await groupedRows<unknown>(c, cache, 'wallet-samples', `WITH hourly AS (
      SELECT DISTINCT ON (wallet,date_trunc('hour',scan_started_at AT TIME ZONE 'UTC')) wallet,scan_started_at,data,run_id::text||':'||wallet||':'||xmin::text AS revision
      FROM snapshots WHERE network=$1 AND scan_started_at >= $2::timestamptz-interval '14 days' AND scan_started_at <= $2
      ORDER BY wallet,date_trunc('hour',scan_started_at AT TIME ZONE 'UTC'),scan_started_at DESC
    ) SELECT (scan_started_at AT TIME ZONE 'UTC')::date::text AS bucket,revision,data-'feeContext' AS data FROM hourly UNION ALL
      SELECT day::text AS bucket,'daily:'||wallet||':'||xmin::text AS revision,snapshot-'feeContext' AS data FROM daily_samples WHERE network=$1 AND day >= ($2::timestamptz AT TIME ZONE 'UTC')::date-30 UNION ALL
      SELECT 'latest' AS bucket,wallet||':'||xmin::text AS revision,latest_snapshot-'feeContext' AS data FROM wallet_state WHERE network=$1`, [network, now.toISOString()]);
    const relation = await c.query("SELECT to_regclass('fee_research') AS name");
    if (relation.rows[0]?.name) {
      const history = await groupedRows<unknown>(c, cache, 'daily-wallet-samples',
        "SELECT to_char(day,'YYYY-MM') AS bucket,day::text||':'||wallet||':'||xmin::text AS revision,snapshot-'feeContext' AS data FROM time_machine_samples WHERE network=$1", [network]);
      samples.push(...history);
    }
    const records: ReplayRecord[] = samples.flatMap(row => {
      const snapshot = snapshotSchema.parse(row);
      if (snapshot.network !== network) throw new Error('E_TIME_MACHINE_NETWORK');
      if (Date.parse(snapshot.asOf) > now.getTime()) return [];
      return [{ snapshot, trainingRef: 'collected', collected: true,
        forecasts: [{ model: 'current', dailySats: snapshot.naiveRunway.drainPerDaySats, reason: snapshot.naiveRunway.reason, sampleSize: snapshot.naiveRunway.sampleSize },
          ...(['mean7', 'mean30'] as const).map(model => ({ model, dailySats: null, reason: 'not_recorded', sampleSize: 0 }))] }];
    });
    let study: FeeStudy | null = null, researchUpdatedAt: string | null = null, researchError: string | null = null;
    let buckets: FeeBucket[] = [];
    if (relation.rows[0]?.name) {
      const version = await c.query('SELECT updated_at,last_error,xmin::text AS revision FROM fee_research WHERE network=$1', [network]);
      const state = await cache(c, 'research', [version.rows, now.toISOString().slice(0, 10)], async () => (await c.query(`SELECT
        (study-'evaluations'-'timeline') || jsonb_build_object('evaluations','[]'::jsonb,
          'evaluationPeriods',COALESCE((SELECT jsonb_agg(p ORDER BY p."horizonDays",p.sampling) FROM (
            SELECT (e->>'horizonDays')::int AS "horizonDays",sampling,min((e->>'origin')::bigint) AS "from",max((e->>'origin')::bigint) AS "to"
            FROM jsonb_array_elements(study->'evaluations') AS e CROSS JOIN (VALUES ('daily'),('non_overlapping')) AS s(sampling)
            WHERE sampling='daily' OR (e->>'nonOverlapping')::boolean GROUP BY 1,2) AS p),'[]'::jsonb),
          'timeline',COALESCE((SELECT jsonb_agg(t ORDER BY (t->>'origin')::bigint) FROM jsonb_array_elements(study->'timeline') AS t
            WHERE (t->>'origin')::bigint >= (study->>'asOf')::bigint-7*86400),'[]'::jsonb)) AS study,
        COALESCE((SELECT jsonb_agg(b ORDER BY (b->>'start')::bigint) FROM jsonb_array_elements(archive->'buckets') AS b
          WHERE (b->>'end')::bigint >= extract(epoch FROM $2::date::timestamp AT TIME ZONE 'UTC')-90*86400),'[]'::jsonb) AS buckets,
        updated_at,last_error FROM fee_research WHERE network=$1`, [network, now.toISOString().slice(0, 10)])).rows);
      if (state[0]?.buckets) buckets = feeBucketSchema.array().parse(state[0].buckets);
      if (state[0]?.study) {
        study = state[0].study as FeeStudy;
        researchUpdatedAt = new Date(state[0].updated_at).toISOString();
      }
      researchError = state[0]?.last_error ?? null;
    }
    const observations = await groupedRows<unknown>(c, cache, 'block-benchmarks', `SELECT DISTINCT ON ((observed_at AT TIME ZONE 'UTC')::date,block->>'id')
      (observed_at AT TIME ZONE 'UTC')::date::text AS bucket,block AS data FROM fee_observations,
      LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(data->'completed'->'blocks')='array' THEN data->'completed'->'blocks' ELSE '[]'::jsonb END) AS block
      WHERE network=$1 AND observed_at >= $2::timestamptz-interval '90 days' AND observed_at <= $2
        AND block->'transactionFees'->>'basis'='median_transaction_fee_per_vbyte'
      ORDER BY (observed_at AT TIME ZONE 'UTC')::date,block->>'id',observed_at DESC`, [network, now.toISOString()],
    `SELECT (observed_at AT TIME ZONE 'UTC')::date::text AS bucket,run_id::text||':'||xmin::text AS revision FROM fee_observations
      WHERE network=$1 AND observed_at >= $2::timestamptz-interval '90 days' AND observed_at <= $2`);
    const blockRates = new Map<string, FeeBenchmark>();
    for (const row of observations) {
      const parsed = completedBlockSchema.safeParse(row);
      const b = parsed.success ? parsed.data : null, rate = b?.transactionFees?.medianSatVb;
      if (b && rate !== null && rate !== undefined && b.timestamp <= now.getTime() / 1000)
        blockRates.set(b.id, { kind: 'block_median', rate, start: b.timestamp, end: b.timestamp });
    }
    const wallets = await c.query(`SELECT wallet,md5((history-'addresses')::text) AS revision,
      md5((SELECT jsonb_agg(a->'script') FROM jsonb_array_elements(addresses) AS a)::text) AS scripts FROM wallet_state WHERE network=$1 ORDER BY wallet`, [network]);
    const transactions = [];
    for (const w of wallets.rows) {
      const summaries = await cache(c, `transactions:${w.wallet}`, [w.revision, w.scripts], async () => {
        const result = await c.query(transactionSource, [network, w.wallet]);
        return result.rows.flatMap(row => summarizeStoredTransactions(row.wallet, row.addresses, row.history, [], new Map()));
      });
      transactions.push(...summaries.filter(tx => tx.time <= now.getTime() / 1000 && tx.time >= now.getTime() / 1000 - 90 * 86400)
        .map(tx => ({ ...tx, benchmark: feeBenchmark(tx.blockHash, tx.time, buckets, blockRates) })));
    }
    await c.query('COMMIT');
    const unique = [...new Map(records.map(r => [r.snapshot.wallet + ':' + r.snapshot.asOf, r])).values()]
      .sort((a, b) => Date.parse(a.snapshot.asOf) - Date.parse(b.snapshot.asOf));
    return { network, readAt: now.toISOString(), staleAfterSeconds: settings.rows[0].stale_after_s as number,
      records: unique, transactions, study, researchUpdatedAt, researchError };
  } catch { await c.query('ROLLBACK'); throw new Error('E_TIME_MACHINE_READ'); }
  finally { c.release(); }
}

import type { Pool, PoolClient } from 'pg';
import type { ValidatedConfig } from '../config/load.js';
import type { AddressRecord, Snapshot, Utxo } from '../types.js';
import { emptyHistory, type HistoryState } from '../extract/history.js';
export interface Lease { network: string; runId: string; fence: number; slot: number }
export interface WalletState { addresses: AddressRecord[]; history: HistoryState }
export class Store {
  constructor(readonly pool: Pool) {}
  async assertConfig(v: ValidatedConfig) {
    const stamp = await this.pool.query('SELECT network FROM network_stamp');
    if (stamp.rows.length !== 1 || stamp.rows[0].network !== v.config.network) throw new Error('E_DB_NETWORK');
    const schema = await this.pool.query('SELECT max(version) AS version FROM schema_migrations');
    if (schema.rows[0].version !== 1) throw new Error('E_DB_SCHEMA');
    const wallets = await this.pool.query('SELECT wallet, key_identity FROM wallets WHERE network=$1', [v.config.network]);
    if (wallets.rowCount !== v.wallets.size) throw new Error('E_DB_WALLETS');
    for (const [id, w] of v.wallets) if (!wallets.rows.some(row => row.wallet === id && row.key_identity === w.keyIdentity)) throw new Error('E_WALLET_IDENTITY_CHANGED');
  }
  async beginRun(network: string, runId: string) {
    await this.pool.query("INSERT INTO runs(run_id,network,status) VALUES($1,$2,'running')", [runId, network]);
  }
  async finishRun(runId: string, status: string, results: unknown) {
    await this.pool.query('UPDATE runs SET status=$2,results=$3,finished_at=now() WHERE run_id=$1', [runId, status, JSON.stringify(results)]);
  }
  async acquire(network: string, runId: string, ttl: number, interval: number, force: boolean): Promise<Lease | null> {
    const r = await this.pool.query(`INSERT INTO run_lease(network,holder,fence,expires_at)
      VALUES($1,$2,1,now()+make_interval(secs=>$3)) ON CONFLICT(network) DO UPDATE
      SET holder=$2, fence=run_lease.fence+1, expires_at=now()+make_interval(secs=>$3)
      WHERE run_lease.expires_at < now() AND ($5 OR run_lease.last_completed_slot < floor(extract(epoch FROM now())/$4))
      RETURNING fence, floor(extract(epoch FROM now())/$4)::bigint AS slot`, [network, runId, ttl, interval, force]);
    return r.rowCount ? { network, runId, fence: r.rows[0].fence, slot: r.rows[0].slot } : null;
  }
  async fenced<T>(lease: Lease, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT network FROM run_lease WHERE network=$1 AND holder=$2 AND fence=$3 AND expires_at>now() FOR SHARE', [lease.network, lease.runId, lease.fence]);
      if (!r.rowCount) throw new Error('E_LEASE_LOST');
      const result = await fn(c); await c.query('COMMIT'); return result;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async release(lease: Lease, success: boolean) {
    await this.pool.query(`UPDATE run_lease SET holder=NULL,expires_at='-infinity',last_completed_slot=CASE WHEN $4 THEN GREATEST(last_completed_slot,$5) ELSE last_completed_slot END
      WHERE network=$1 AND holder=$2 AND fence=$3 AND expires_at>now()`, [lease.network, lease.runId, lease.fence, success, lease.slot]);
  }
  async state(network: string, wallet: string): Promise<WalletState> {
    const r = await this.pool.query('SELECT addresses,history FROM wallet_state WHERE network=$1 AND wallet=$2', [network, wallet]);
    return r.rows[0] ?? { addresses: [], history: emptyHistory() };
  }
  async providerError(network: string, provider: string, kind: string) {
    await this.pool.query(`INSERT INTO provider_errors(network,provider,total,last_kind) VALUES($1,$2,1,$3)
      ON CONFLICT(network,provider) DO UPDATE SET total=provider_errors.total+1,last_kind=$3`, [network, provider, kind]);
  }
  async save(lease: Lease, snapshot: Snapshot, addresses: AddressRecord[], history: HistoryState, utxos: Utxo[]) {
    await this.fenced(lease, async c => {
      await c.query('INSERT INTO snapshots(network,wallet,run_id,scan_started_at,data) VALUES($1,$2,$3,$4,$5)',
        [lease.network, snapshot.wallet, lease.runId, snapshot.asOf, JSON.stringify(snapshot)]);
      await c.query(`INSERT INTO wallet_state(network,wallet,addresses,history,latest_snapshot,utxos) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(network,wallet) DO UPDATE SET addresses=$3,history=$4,latest_snapshot=$5,utxos=$6`,
      [lease.network, snapshot.wallet, JSON.stringify(addresses), JSON.stringify(history), JSON.stringify(snapshot), JSON.stringify(utxos)]);
      await c.query(`INSERT INTO daily_samples(network,wallet,day,snapshot,utxos) VALUES($1,$2,($3::timestamptz AT TIME ZONE 'UTC')::date,$4,$5) ON CONFLICT DO NOTHING`,
        [lease.network, snapshot.wallet, snapshot.asOf, JSON.stringify(snapshot), JSON.stringify(utxos)]);
    });
  }
  async maintenance(lease: Lease, retention: ValidatedConfig['config']['retention']) {
    return this.fenced(lease, async c => {
      await c.query(`INSERT INTO daily_rollup(network,wallet,day,samples,spendable_min,spendable_max,last_as_of)
        SELECT network,wallet,(scan_started_at AT TIME ZONE 'UTC')::date,count(*),min(spendable_sats),max(spendable_sats),max(scan_started_at)
        FROM snapshots WHERE network=$1 AND (scan_started_at AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date-$2::int
        GROUP BY network,wallet,(scan_started_at AT TIME ZONE 'UTC')::date
        ON CONFLICT(network,wallet,day) DO UPDATE SET samples=EXCLUDED.samples,spendable_min=EXCLUDED.spendable_min,spendable_max=EXCLUDED.spendable_max,last_as_of=EXCLUDED.last_as_of`, [lease.network, retention.snapshots_days]);
      const removed = await c.query(`DELETE FROM snapshots WHERE network=$1 AND (scan_started_at AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date-$2::int`, [lease.network, retention.snapshots_days]);
      await c.query("DELETE FROM daily_samples WHERE network=$1 AND day < (now() AT TIME ZONE 'UTC')::date-$2::int", [lease.network, retention.daily_samples_days]);
      await c.query("DELETE FROM daily_rollup WHERE network=$1 AND day < (now() AT TIME ZONE 'UTC')::date-730", [lease.network]);
      await c.query("DELETE FROM runs WHERE network=$1 AND started_at < now()-make_interval(days=>$2) AND NOT EXISTS(SELECT 1 FROM snapshots WHERE snapshots.run_id=runs.run_id)", [lease.network, retention.runs_days]);
      return { snapshotsRemoved: removed.rowCount };
    });
  }
}

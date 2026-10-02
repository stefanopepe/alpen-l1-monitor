import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../src/config/load.js';
import { safeError } from '../src/chain/errors.js';
const arg = process.argv.indexOf('--init-network');
if (arg < 0 || !process.argv[arg + 1]) throw new Error('E_INIT_NETWORK_REQUIRED');
const v = loadConfig(process.argv[arg + 1], false);
const url = process.env.MIGRATION_DATABASE_URL;
try { if (!url || new URL(url).hostname.includes('-pooler')) throw new Error(); }
catch { throw new Error('E_DIRECT_DATABASE_REQUIRED'); }
const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
try {
  await c.connect();
  await c.query("SELECT pg_advisory_lock(hashtext('bridge-wallet-monitor-migrations'))");
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of readdirSync('migrations').filter(f => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    const sql = readFileSync(`migrations/${file}`, 'utf8'), version = Number(file.slice(0, 4));
    const sha = createHash('sha256').update(sql).digest('hex');
    const existing = await c.query('SELECT sha256 FROM schema_migrations WHERE version=$1', [version]);
    if (existing.rowCount) { if (existing.rows[0].sha256 !== sha) throw new Error('E_MIGRATION_CHANGED'); continue; }
    await c.query('BEGIN');
    try { await c.query(sql); await c.query('INSERT INTO schema_migrations(version,sha256) VALUES($1,$2)', [version, sha]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    console.log(`Applied migration ${version}`);
  }
  await c.query('BEGIN');
  try {
    await c.query('INSERT INTO network_stamp(network) VALUES($1) ON CONFLICT DO NOTHING', [v.config.network]);
    const stamp = await c.query('SELECT network FROM network_stamp');
    if (stamp.rows[0]?.network !== v.config.network) throw new Error('E_DB_NETWORK');
    for (const wallet of v.config.wallets) {
      const p = v.wallets.get(wallet.id)!;
      const old = await c.query('SELECT key_identity FROM wallets WHERE network=$1 AND wallet=$2', [v.config.network, wallet.id]);
      if (old.rowCount && old.rows[0].key_identity !== p.keyIdentity) throw new Error('E_WALLET_IDENTITY_CHANGED');
      await c.query(`INSERT INTO wallets(network,wallet,display_name,key_identity,descriptor_checksum) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(network,wallet) DO UPDATE SET display_name=$3,descriptor_checksum=$5`, [v.config.network, wallet.id, wallet.display_name, p.keyIdentity, p.checksum]);
    }
    await c.query(`INSERT INTO settings(network,stale_after_s,primary_is_public) VALUES($1,$2,$3)
      ON CONFLICT(network) DO UPDATE SET stale_after_s=$2,primary_is_public=$3`, [v.config.network, v.config.collection.stale_after_s, v.config.providers[0]!.tier === 'public']);
    for (const p of v.config.providers) await c.query('INSERT INTO provider_errors(network,provider) VALUES($1,$2) ON CONFLICT DO NOTHING', [v.config.network, p.name]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  if (process.argv.includes('--apply-roles')) {
    await c.query('BEGIN');
    try {
      await c.query(readFileSync('ops/roles.sql', 'utf8'));
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    console.log('Runtime and read-only role permissions applied.');
  }
  console.log(`Database initialised for ${v.config.network}; no credentials emitted.`);
} catch (e) { console.error(safeError(e)); process.exitCode = 1; }
finally { await c.end(); }

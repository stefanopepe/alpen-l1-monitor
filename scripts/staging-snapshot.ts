import { writeFileSync } from 'node:fs';
import { database } from '../src/db/pool.js';
import { inventorySchema } from '../src/consolidation/inventory.js';
import { networkName } from '../src/http/respond.js';
const pool = database('read');
try {
  const network = networkName();
  const rows = await pool.query(`SELECT w.wallet,w.display_name AS name,s.latest_snapshot AS snapshot,s.utxos
    FROM wallets w JOIN wallet_state s USING(network,wallet) WHERE w.network=$1 ORDER BY w.wallet`, [network]);
  const wallets = rows.rows.map(r => inventorySchema.parse(r));
  if (wallets.length !== 2 || wallets.some(w => w.snapshot.network !== network || w.wallet !== w.snapshot.wallet)) throw new Error('E_STAGING_INVENTORY');
  writeFileSync('config/staging-snapshot.json', JSON.stringify({ network, capturedAt: new Date().toISOString(), wallets }), { mode: 0o600 });
  console.log('Saved staging wallet inventory. No database credentials or transaction history included.');
} finally { await pool.end(); }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { scanWallet } from '../src/pipeline/walletRun.js';
import { emptyHistory } from '../src/extract/history.js';
import { safeError } from '../src/chain/errors.js';
const v = loadConfig();
const resume = process.argv.includes('--resume');
if (resume) mkdirSync('.local/inspection', { recursive: true });
for (const wallet of v.config.wallets) {
  if (process.argv.includes('--wallet') && process.argv[process.argv.indexOf('--wallet') + 1] !== wallet.id) continue;
  try {
    const file = `.local/inspection/${v.config.network}-${wallet.id}.json`;
    const previous = resume && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { addresses: [], history: emptyHistory() };
    if (previous.configSha256 && previous.configSha256 !== v.sha256) throw new Error('E_INSPECTION_CONFIG_CHANGED');
    const r = await scanWallet(v, wallet, previous, Date.now() + 370000, 0,
      async (provider, kind) => { console.error(JSON.stringify({ provider, kind })); });
    if (resume) writeFileSync(file, JSON.stringify({ addresses: r.addresses, history: r.history, snapshot: r.snapshot, utxos: r.utxos, configSha256: v.sha256 }), { mode: 0o600 });
    console.log(JSON.stringify(r.snapshot));
  } catch (e) { console.error(JSON.stringify({ wallet: wallet.id, error: safeError(e) })); process.exitCode = 1; }
}

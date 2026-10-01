// Offline validation only. Aggregate sums are intentionally forbidden in the collector.
import { loadConfig } from '../src/config/load.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { safeError } from '../src/chain/errors.js';
import { z } from 'zod';
import { safeInt, utxosSchema } from '../src/chain/schemas.js';
import type { AddressRecord } from '../src/types.js';
import { providerRequest } from '../src/chain/request.js';
const { config: cfg } = loadConfig();
const p = cfg.providers[0]!;
let last = 0;
async function get(path: string, plain = false): Promise<unknown> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, last + p.min_interval_ms - Date.now()))); last = Date.now();
  const { url, headers } = providerRequest(p, path);
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(p.timeout_ms) });
  if (!response.ok) throw new Error('E_CONFORMANCE_HTTP');
  return plain ? (await response.text()).trim() : response.json();
}
const stat = z.object({ funded_txo_sum: safeInt, spent_txo_sum: safeInt });
const stats = z.object({ chain_stats: stat, mempool_stats: stat });
try {
  const results = [];
  for (const w of cfg.wallets) {
    const state = JSON.parse(readFileSync(`.local/inspection/${cfg.network}-${w.id}.json`, 'utf8')) as { addresses: AddressRecord[] };
    const start = await get('/blocks/tip/hash', true);
    let balance = 0, aggregate = 0, addresses = 0;
    for (const a of state.addresses.filter(a => a.used)) {
      const s = stats.parse(await get(`/address/${a.address}`));
      const u = utxosSchema.parse(await get(`/address/${a.address}/utxo`));
      const sum = u.reduce((total, item) => total + item.value, 0);
      const check = s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum + s.mempool_stats.funded_txo_sum - s.mempool_stats.spent_txo_sum;
      if (sum !== check) throw new Error('E_CONFORMANCE_IDENTITY');
      balance += sum; aggregate += check; addresses++;
    }
    if (start !== await get('/blocks/tip/hash', true)) throw new Error('E_CONFORMANCE_TIP_MOVED');
    results.push({ wallet: w.id, addresses, balanceSats: balance, aggregateCheckSats: aggregate, tipHash: start });
  }
  const report = { asOf: new Date().toISOString(), provider: p.name, network: cfg.network, results };
  writeFileSync('.local/inspection/conformance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (e) { console.error(safeError(e)); process.exitCode = 1; }

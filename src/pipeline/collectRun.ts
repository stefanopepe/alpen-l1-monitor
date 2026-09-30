import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/load.js';
import { database } from '../db/pool.js';
import { Store } from '../db/store.js';
import { scanWallet } from './walletRun.js';
import { safeError } from '../chain/errors.js';
export async function runCollect(force = false) {
  const started = Date.now();
  const network = process.env.NETWORK;
  if (!network || !/^[a-z0-9-]+$/.test(network)) throw new Error('E_NETWORK_REQUIRED');
  const store = new Store(database('write')), runId = randomUUID();
  await store.beginRun(network, runId);
  const v = await (async () => {
    try { const validated = loadConfig(); await store.assertConfig(validated); return validated; }
    catch (e) { await store.finishRun(runId, 'refused_startup_check', [{ error: safeError(e) }]); throw e; }
  })();
  const cfg = v.config;
  const lease = await store.acquire(cfg.network, runId, cfg.collection.lease_ttl_s, cfg.collection.interval_s, force);
  if (!lease) { await store.finishRun(runId, 'skipped_lease_or_slot', []); return { runId, skipped: true, wallets: [] }; }
  const results: { wallet: string; status: string; asOf?: string; provider?: string; error?: string; runwayAvailable?: boolean }[] = [];
  let success = false, provider = 0;
  try {
    const share = (cfg.collection.max_duration_s - cfg.collection.deadline_margin_s) * 1000 / cfg.wallets.length;
    for (const [index, wallet] of cfg.wallets.entries()) {
      try {
        const previous = await store.state(cfg.network, wallet.id);
        const result = await scanWallet(v, wallet, previous, started + share * (index + 1), provider,
          (p, kind) => store.providerError(cfg.network, p, kind));
        provider = result.providerIndex;
        await store.save(lease, result.snapshot, result.addresses, result.history, result.utxos);
        results.push({ wallet: wallet.id, status: 'ok', asOf: result.snapshot.asOf, provider: result.snapshot.provider,
          runwayAvailable: result.snapshot.naiveRunway.days !== null });
      } catch (e) { results.push({ wallet: wallet.id, status: 'failed', error: safeError(e) }); }
    }
    const maintenance = await store.maintenance(lease, cfg.retention);
    success = results.every(r => r.status === 'ok');
    await store.finishRun(runId, success ? 'ok' : 'partial_failure', results);
    return { runId, skipped: false, wallets: results, maintenance };
  } catch (e) { await store.finishRun(runId, 'failed', [{ error: safeError(e) }]); throw e; }
  finally { await store.release(lease, success); }
}

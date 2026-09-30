import { MONITOR_VERSION } from '../version.js';
import { Budget, Esplora } from '../chain/esplora.js';
import { ProviderError, safeError } from '../chain/errors.js';
import { discover, inventory } from '../discovery/scan.js';
import { sampleHistory } from '../extract/history.js';
import { computeWalletSnapshot } from './snapshot.js';
import type { ValidatedConfig } from '../config/load.js';
import type { WalletConfig } from '../config/schema.js';
import type { WalletState } from '../db/store.js';
export async function scanWallet(v: ValidatedConfig, wallet: WalletConfig, previous: WalletState, deadline: number, startProvider: number,
  onError: (provider: string, kind: string) => Promise<void>) {
  const cfg = v.config;
  let lastError = 'E_PROVIDERS_UNAVAILABLE';
  for (let offset = 0; offset < cfg.providers.length; offset++) {
    const providerIndex = (startProvider + offset) % cfg.providers.length;
    const provider = cfg.providers[providerIndex]!;
    const asOf = new Date(), asOfEpoch = asOf.getTime() / 1000;
    const budget = new Budget(deadline, cfg.collection.max_requests_inventory, provider.name);
    const view = new Esplora(provider, budget);
    try {
      if (await view.blockHashAt(cfg.chain.checkpoint.height) !== cfg.chain.checkpoint.hash) throw new ProviderError(provider.name, 'wrong_network');
      const scan = await discover(view, cfg, wallet, v.wallets.get(wallet.id)!, previous.addresses);
      const { utxos, tip } = await inventory(view, scan.addresses);
      const ref = cfg.providers[(providerIndex + 1) % cfg.providers.length];
      let reference = null;
      if (ref && ref.name !== provider.name) {
        const peer = new Esplora(ref, new Budget(Math.min(deadline, Date.now() + ref.timeout_ms * 3), 3, ref.name));
        try {
          if (await peer.blockHashAt(cfg.chain.checkpoint.height) === cfg.chain.checkpoint.hash) reference = await peer.tip();
        } catch { /* A failed reference never invents a fresher tip. */ }
      }
      if (reference && (reference.height - tip.height > provider.max_tip_lag_blocks ||
        (asOfEpoch - tip.blockTime > cfg.collection.max_tip_age_s && reference.blockTime > tip.blockTime))) throw new ProviderError(provider.name, 'stale_tip');
      const inventoryRequests = budget.used;
      view.budget = new Budget(deadline, cfg.collection.max_requests_history, provider.name);
      const history = await sampleHistory(view, scan.addresses, previous.history, cfg, tip, asOfEpoch);
      const snapshot = computeWalletSnapshot({
        asOfEpoch, utxos, settlements: history.settlements, estimator: cfg.estimator, historyComplete: history.complete,
        meta: { network: cfg.network, wallet: wallet.id, asOf: asOf.toISOString(), finishedAt: new Date().toISOString(), provider: provider.name,
          tip, ceilingHit: scan.ceilingHit, addressesScanned: scan.addresses.length, requestsUsed: inventoryRequests + view.budget.used,
          primaryIsPublic: cfg.providers[0]!.tier === 'public', networkTipOld: asOfEpoch - tip.blockTime > cfg.collection.max_tip_age_s,
          historyError: history.complete ? null : 'E_HISTORY_INCOMPLETE', monitorVersion: MONITOR_VERSION, selectorModelVersion: cfg.upstream.selector_model_version,
          upstreamRef: cfg.upstream.ref, deployedBuildConfirmed: cfg.upstream.deployed_build_confirmed, configSha256: v.sha256 },
      });
      return { snapshot, addresses: scan.addresses, history: history.state, utxos, providerIndex };
    } catch (e) {
      lastError = safeError(e);
      await onError(provider.name, e instanceof ProviderError ? e.kind : lastError);
      if (!(e instanceof ProviderError) || e.kind === 'bad_request' || Date.now() >= deadline) break;
    }
  }
  throw new Error(lastError);
}

import { loadConfig, type ValidatedConfig } from '../config/load.js';
import { Budget, Esplora } from '../chain/esplora.js';
import { observeQuote, feeApiBaseUrl } from '../chain/fees.js';
import { deriveAddress } from '../derive/address.js';
import type { ChainView } from '../chain/view.js';
import type { Utxo } from '../types.js';
import { readInventory, type Inventory } from './inventory.js';
import { buildConsolidation } from './transaction.js';
import { demoData } from './demo.js';

export async function verifyInputs(view: ChainView, inputs: readonly Utxo[]) {
  const available: Utxo[] = [];
  for (const address of new Set(inputs.map(u => u.address))) {
    const current = await view.addressUtxos(address);
    for (const u of inputs.filter(u => u.address === address)) {
      const live = current.find(c => c.txid === u.txid && c.vout === u.vout);
      if (!live?.status.confirmed) continue;
      if (live.value !== u.valueSats) throw new Error('E_INPUT_VALUE');
      available.push(u);
    }
  }
  return available;
}
export function candidateInputs(v: ValidatedConfig, inventory: Inventory) {
  if (inventory.snapshot.ceilingHit.receive || inventory.snapshot.ceilingHit.change) throw new Error('E_DISCOVERY');
  const wallet = v.wallets.get(inventory.wallet);
  if (!wallet) throw new Error('E_WALLET');
  const inputs = inventory.utxos.filter(u => u.confirmed && u.valueSats > 0 && u.valueSats <= 546 && u.scriptType === 'p2wpkh');
  if (inputs.length > 1000) throw new Error('E_TOO_MANY_OUTPUTS');
  for (const u of inputs) if (deriveAddress(wallet, u.chain, u.index, v.config.chain.bech32_hrp).address !== u.address) throw new Error('E_INPUT_OWNERSHIP');
  return inputs;
}
export async function consolidationQuote(network: string, walletId: string, requestedFeeRate?: number) {
  if (process.env.STAGING_PREVIEW === 'demo') {
    const data = demoData(), wallet = data.wallets.find(w => w.wallet === walletId);
    if (!wallet) throw new Error('E_WALLET');
    return { ...buildConsolidation(data.config, walletId, wallet.utxos, requestedFeeRate ?? 1), network: data.config.config.network, recommendedFeeRate: 1, wallet: walletId, inventoryAsOf: data.asOf,
      checkedAt: data.asOf, feeObservedAt: data.asOf, feeSource: 'Example fee', provider: 'sample', sample: true };
  }
  const v = loadConfig(network, false);
  if (!v.wallets.has(walletId)) throw new Error('E_WALLET');
  const inventory = await readInventory(network, walletId);
  const inputs = candidateInputs(v, inventory);
  if (!inputs.length) throw new Error('E_NO_OUTPUTS');
  const feeBase = feeApiBaseUrl(v.config);
  const fee = await observeQuote(undefined, undefined, feeBase);
  if (fee.status !== 'available' || !fee.rates) throw new Error('E_FEES');
  const recommendedFeeRate = Math.ceil(Math.max(0.1, fee.rates.economyFee, fee.rates.minimumFee) * 10) / 10;
  const feeRate = requestedFeeRate ?? recommendedFeeRate;
  const deadline = Date.now() + 22000;
  for (const provider of v.config.providers.filter(p => p.auth.scheme === 'none' || !!process.env[p.auth.secret_env])) {
    try {
      const view = new Esplora(provider, new Budget(deadline, 100, provider.name));
      if (await view.blockHashAt(v.config.chain.checkpoint.height) !== v.config.chain.checkpoint.hash) continue;
      const tip = await view.tip();
      if (Date.now() / 1000 - tip.blockTime > v.config.collection.max_tip_age_s) continue;
      const available = await verifyInputs(view, inputs);
      if (await view.tipHash() !== tip.hash) continue;
      const built = buildConsolidation(v, walletId, available, feeRate);
      return { ...built, network, recommendedFeeRate, wallet: walletId, inventoryAsOf: inventory.snapshot.asOf, checkedAt: new Date().toISOString(),
        feeObservedAt: fee.observedAt, feeSource: `${new URL(feeBase!).hostname} · ${network} economy`, provider: provider.name, sample: false };
    } catch (error) {
      if (error instanceof Error && ['E_NO_OUTPUTS', 'E_UNECONOMIC', 'E_INPUT_VALUE', 'E_INPUT_OWNERSHIP', 'E_INPUT'].includes(error.message)) throw error;
    }
  }
  throw new Error('E_VERIFICATION');
}

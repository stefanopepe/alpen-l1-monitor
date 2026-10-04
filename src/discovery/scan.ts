import type { NetworkConfig, WalletConfig } from '../config/schema.js';
import type { ParsedWallet } from '../descriptor/parse.js';
import { deriveAddress } from '../derive/address.js';
import type { ChainView } from '../chain/view.js';
import { ProviderError } from '../chain/errors.js';
import type { AddressRecord, Snapshot, Tip, Utxo } from '../types.js';
export type AddressDeriver = (...args: Parameters<typeof deriveAddress>) => { address: string; script: string };
export async function discover(view: ChainView, cfg: NetworkConfig, wallet: WalletConfig, parsed: ParsedWallet, previous: readonly AddressRecord[], derive: AddressDeriver = deriveAddress) {
  const addresses: AddressRecord[] = [], ceilingHit = { receive: false, change: false };
  for (const chain of [0, 1] as const) {
    let gap = 0;
    const oldMax = Math.max(-1, ...previous.filter(a => a.chain === chain && a.used).map(a => a.index));
    const { ceiling, gap_limit, min_indices } = wallet.gap_scan;
    if (oldMax >= ceiling) throw new Error('E_DISCOVERY_CONFIG_SHRINK');
    for (let index = 0; index < ceiling; index++) {
      const derived = derive(parsed, chain, index, cfg.chain.bech32_hrp);
      const old = previous.find(a => a.chain === chain && a.index === index);
      if (old && (old.address !== derived.address || old.script !== derived.script)) throw new Error('E_WALLET_IDENTITY_CHANGED');
      const stats = await view.addressStats(derived.address);
      const used = Boolean(old?.used) || stats.chain_stats.tx_count + stats.mempool_stats.tx_count > 0;
      gap = used ? 0 : gap + 1;
      addresses.push({ ...derived, chain, index, used, confirmedTxCount: stats.chain_stats.tx_count, mempoolTxCount: stats.mempool_stats.tx_count });
      if (index + 1 >= min_indices && index >= oldMax && gap >= gap_limit) break;
    }
    ceilingHit[chain === 0 ? 'receive' : 'change'] = gap < gap_limit;
  }
  // Keep all previously derived addresses in W even when a later scan stops sooner.
  const keys = new Set(addresses.map(a => a.address));
  for (const a of previous) if (!keys.has(a.address)) {
    const expected = derive(parsed, a.chain, a.index, cfg.chain.bech32_hrp);
    if (expected.address !== a.address || expected.script !== a.script) throw new Error('E_WALLET_IDENTITY_CHANGED');
    addresses.push(a);
  }
  return { addresses, ceilingHit };
}
export interface PreviousInventory { addresses: readonly AddressRecord[]; utxos?: readonly Utxo[]; snapshot?: Snapshot }
export async function inventory(view: ChainView, addresses: readonly AddressRecord[], previous?: PreviousInventory): Promise<{ utxos: Utxo[]; tip: Tip }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tip = await view.tip(), utxos: Utxo[] = [], seen = new Set<string>();
    for (const a of addresses.filter(a => a.used)) {
      let current;
      try { current = await view.addressUtxos(a.address); }
      catch (error) {
        const old = previous?.addresses.find(p => p.address === a.address), saved = previous?.snapshot;
        // A verified previous inventory remains exact when this address has had no
        // confirmed activity, no mempool activity and its old block is still canonical.
        // Never infer an inventory from funded-minus-spent address arithmetic.
        if (!(error instanceof ProviderError) || error.kind !== 'utxo_limit' || !old || !saved || !previous?.utxos ||
          saved.provider !== view.provider || saved.tip.height > tip.height || old.confirmedTxCount !== a.confirmedTxCount ||
          old.mempoolTxCount !== 0 || a.mempoolTxCount !== 0 || old.chain !== a.chain || old.index !== a.index || old.script !== a.script) throw error;
        const stats = await view.addressStats(a.address);
        if (stats.chain_stats.tx_count !== old.confirmedTxCount || stats.mempool_stats.tx_count !== 0 ||
          await view.blockHashAt(saved.tip.height) !== saved.tip.hash) throw new ProviderError(view.provider, 'inconsistent');
        const retained = previous.utxos.filter(u => u.address === a.address);
        if (retained.some(u => !u.confirmed || u.blockHeight === null || u.blockHeight > saved.tip.height)) throw new ProviderError(view.provider, 'inconsistent');
        current = retained.map(u => ({ txid: u.txid, vout: u.vout, value: u.valueSats,
          status: { confirmed: true, block_height: u.blockHeight } }));
      }
      for (const u of current) {
        const key = `${u.txid}:${u.vout}`;
        if (seen.has(key) || (u.status.confirmed && u.status.block_height! > tip.height)) throw new ProviderError(view.provider, 'inconsistent');
        seen.add(key);
        utxos.push({ txid: u.txid, vout: u.vout, valueSats: u.value, confirmed: u.status.confirmed,
          blockHeight: u.status.block_height ?? null, address: a.address, chain: a.chain, index: a.index, scriptType: 'p2wpkh' });
      }
    }
    if (await view.tipHash() === tip.hash) return { utxos, tip };
  }
  throw new ProviderError(view.provider, 'inconsistent');
}

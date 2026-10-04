import type { ChainTx } from '../chain/schemas.js';
import type { Utxo } from '../types.js';

export interface ExportAddress { address: string; script: string; chain: 0 | 1; index: number }
export interface HistoricalOutput extends Utxo { spentBy: string | null; spentHeight: number | null }

// Local export only: reconstruct explicit outpoints from complete confirmed history.
// Aggregate address arithmetic is used by the caller as an independent check.
export function historyInventory(addresses: readonly ExportAddress[], transactions: readonly ChainTx[], height: number) {
  const owned = new Map(addresses.map(a => [a.script, a]));
  const outputs = new Map<string, HistoricalOutput>(), ids = new Set<string>();
  for (const tx of transactions) {
    if (ids.has(tx.txid)) throw new Error('E_EXPORT_DUPLICATE_TX');
    ids.add(tx.txid);
    if (!tx.status.confirmed || tx.status.block_height! > height) continue;
    tx.vout.forEach((o, vout) => {
      const a = owned.get(o.scriptpubkey);
      if (a) outputs.set(`${tx.txid}:${vout}`, { txid: tx.txid, vout, valueSats: o.value,
        confirmed: true, blockHeight: tx.status.block_height!, address: a.address,
        chain: a.chain, index: a.index, scriptType: 'p2wpkh', spentBy: null, spentHeight: null });
    });
  }
  for (const tx of transactions) {
    if (!tx.status.confirmed || tx.status.block_height! > height) continue;
    for (const input of tx.vin) {
      if (input.is_coinbase || !input.prevout || !owned.has(input.prevout.scriptpubkey)) continue;
      const output = outputs.get(`${input.txid}:${input.vout}`);
      if (!output || output.valueSats !== input.prevout.value || output.address !== owned.get(input.prevout.scriptpubkey)!.address ||
        output.blockHeight! > tx.status.block_height!) throw new Error('E_EXPORT_MISSING_PARENT');
      if (output.spentBy) throw new Error('E_EXPORT_DOUBLE_SPEND');
      output.spentBy = tx.txid; output.spentHeight = tx.status.block_height!;
    }
  }
  const history = [...outputs.values()].sort((a, b) => a.blockHeight! - b.blockHeight! || a.txid.localeCompare(b.txid) || a.vout - b.vout);
  return { outputs: history, utxos: history.filter(o => !o.spentBy) };
}

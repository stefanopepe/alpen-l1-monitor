import { commitOutputs, revealShaped, settlementObservation } from '../extract/classify.js';
import type { ChainArchive } from './archive.js';
import { ArchiveIndex } from './asOfView.js';
export interface OutcomeEvent {
  wallet: string; txid: string; height: number; time: number;
  kind: 'settlement' | 'unresolved' | 'ambiguous' | 'deposit' | 'consolidation' | 'unrelated_spend';
  drainSats: number | null; reason: string | null; revealTxids: string[];
  fundingSats?: number;
}
// This is hindsight accounting, isolated from the prediction pipeline.
export function deriveOutcomes(archive: ChainArchive, index = new ArchiveIndex(archive)): OutcomeEvent[] {
  const result: OutcomeEvent[] = [], txs = Object.values(archive.transactions);
  for (const wallet of archive.config.wallets) {
    const scripts = new Set(archive.addresses.filter(a => a.wallet === wallet.id).map(a => a.script));
    const handled = new Set<string>();
    const event = (txid: string, kind: OutcomeEvent['kind'], drainSats: number | null, reason: string | null, revealTxids: string[] = []) => {
      const tx = archive.transactions[txid]!;
      const funding = kind === 'deposit' ? { fundingSats: tx.vout.reduce((sum, o) => sum + (scripts.has(o.scriptpubkey) && o.value > 546 ? o.value : 0), 0) } : {};
      result.push({ wallet: wallet.id, txid, height: tx.status.block_height!, time: index.clock(tx.status.block_height!), kind, drainSats, reason, revealTxids, ...funding });
    };
    for (const commit of txs) {
      const funding = commitOutputs(commit, scripts);
      if (!funding) continue;
      handled.add(commit.txid);
      const reveals = [];
      let ambiguous = false;
      for (const vout of funding) {
        const spend = index.spends.get(commit.txid + ':' + vout);
        if (!spend) continue;
        if (!revealShaped(commit, vout, spend.tx, scripts)) { ambiguous = true; continue; }
        reveals.push(spend.tx); handled.add(spend.tx.txid);
      }
      const ids = reveals.map(t => t.txid);
      if (ambiguous) { event(commit.txid, 'ambiguous', null, 'unrecognized_reveal', ids); continue; }
      if (reveals.length !== funding.length) { event(commit.txid, 'unresolved', null, 'incomplete_reveal_package', ids); continue; }
      // Independent of the production fee+dust formula: account for actual usable inputs/returns.
      const usableInputs = commit.vin.reduce((sum, i) => sum + (i.prevout && scripts.has(i.prevout.scriptpubkey) && i.prevout.value > 546 ? i.prevout.value : 0), 0);
      const usableReturns = [commit, ...reveals].flatMap(t => t.vout).reduce((sum, o) => sum + (scripts.has(o.scriptpubkey) && o.value > 546 ? o.value : 0), 0);
      const drain = usableInputs - usableReturns;
      try {
        const observed = settlementObservation(commit, reveals, funding.length, scripts);
        if (!Number.isSafeInteger(drain) || drain < 0 || drain !== observed.drainSats) throw new Error('accounting');
        event(commit.txid, 'settlement', drain, null, ids);
      } catch { event(commit.txid, 'ambiguous', null, 'package_accounting_discrepancy', ids); }
    }
    for (const tx of txs) {
      if (handled.has(tx.txid)) continue;
      const ownInputs = tx.vin.filter(i => i.prevout && scripts.has(i.prevout.scriptpubkey));
      const ownOutputs = tx.vout.filter(o => scripts.has(o.scriptpubkey) && o.value > 0);
      if (!ownInputs.length && !ownOutputs.length) continue;
      if (!ownInputs.length) event(tx.txid, 'deposit', null, null);
      else if (ownInputs.length !== tx.vin.length) event(tx.txid, 'ambiguous', null, 'mixed_ownership');
      else if (tx.vout.every(o => o.value === 0 || scripts.has(o.scriptpubkey))) event(tx.txid, 'consolidation', null, null);
      else event(tx.txid, 'unrelated_spend', null, null);
    }
  }
  return result.sort((a, b) => a.height - b.height || a.wallet.localeCompare(b.wallet) || a.txid.localeCompare(b.txid));
}

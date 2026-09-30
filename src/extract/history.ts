import type { ChainView } from '../chain/view.js';
import type { ChainTx } from '../chain/schemas.js';
import type { AddressRecord, Settlement, Tip } from '../types.js';
import type { NetworkConfig } from '../config/schema.js';
import { ProviderError } from '../chain/errors.js';
import { commitOutputs, revealShaped, settlementObservation, validFee } from './classify.js';
export interface AddressHistory { txids: string[]; cursor: string | null; coveredSince: number | null }
export interface HistoryState {
  addresses: Record<string, AddressHistory>; transactions: Record<string, ChainTx>; reveals: Record<string, ChainTx[]>;
}
export const emptyHistory = (): HistoryState => ({ addresses: {}, transactions: {}, reveals: {} });
export async function sampleHistory(view: ChainView, addresses: readonly AddressRecord[], previous: HistoryState, cfg: NetworkConfig, tip: Tip, asOf: number) {
  const state = structuredClone(previous), horizon = asOf - cfg.estimator.window_days * 86400;
  const scripts = new Set(addresses.map(a => a.script));
  const fail = (): never => { throw new ProviderError(view.provider, 'inconsistent'); };
  const frozen = (tx: ChainTx) => tx.status.confirmed && tip.height - tx.status.block_height! >= cfg.chain.finality_depth;
  let bounded = false;
  try {
    // Revalidate all unfrozen cached transactions; the confirmed history contains no mempool samples.
    for (const [id, tx] of Object.entries(state.transactions)) {
      if (!frozen(tx)) {
        const status = await view.txStatus(id);
        if (!status.confirmed) {
          delete state.transactions[id]; delete state.reveals[id];
          for (const h of Object.values(state.addresses)) {
            if (h.txids.includes(id)) { h.txids = h.txids.filter(t => t !== id); h.coveredSince = null; h.cursor = null; }
          }
        } else if (status.block_hash !== tx.status.block_hash) { state.transactions[id] = await view.tx(id); delete state.reveals[id]; }
      }
    }
    for (const address of addresses.filter(a => a.used)) {
      const a = address.address;
      const h = state.addresses[a] ??= { txids: [], cursor: null, coveredSince: null };
      const known = new Set(h.txids);
      let cursor: string | undefined, pages = 0, joined = false, done = false;
      const visited = new Set<string>();
      // Always refresh the head, then join only this address's known frozen history.
      while (!done && pages < cfg.collection.history_page_cap) {
        const page = await view.addressTxsChain(a, cursor); pages++;
        if (page.length === 0) {
          if (h.txids.length !== address.confirmedTxCount) fail();
          h.coveredSince = -1; h.cursor = null; done = true; break;
        }
        for (const tx of page) {
          if (!tx.status.confirmed || visited.has(tx.txid)) fail();
          visited.add(tx.txid);
          if (known.has(tx.txid) && frozen(tx)) joined = true;
          state.transactions[tx.txid] = tx;
          if (!h.txids.includes(tx.txid)) h.txids.push(tx.txid);
        }
        const oldest = page.reduce((m, tx) => Math.min(m, tx.status.block_time!), Infinity);
        cursor = page.at(-1)!.txid;
        if (h.txids.length > address.confirmedTxCount) fail();
        if (h.txids.length === address.confirmedTxCount) { h.coveredSince = -1; h.cursor = null; done = true; }
        else if (oldest < horizon) { h.coveredSince = horizon; h.cursor = null; done = true; }
        else if (page.length < 25) fail();
        else if (joined) { done = h.coveredSince !== null && (h.coveredSince === -1 || h.coveredSince <= horizon); break; }
        else h.cursor = cursor;
      }
      if (!done && joined && h.cursor) {
        // Continue an interrupted historical traversal after refreshing the head.
        cursor = h.cursor;
        const anchor = await view.txStatus(cursor);
        if (!anchor.confirmed || anchor.block_hash !== state.transactions[cursor]?.status.block_hash) fail();
        while (pages < cfg.collection.history_page_cap) {
          const page = await view.addressTxsChain(a, cursor); pages++;
          if (!page.length) { if (h.txids.length !== address.confirmedTxCount) fail(); h.coveredSince = -1; h.cursor = null; done = true; break; }
          for (const tx of page) {
            if (!tx.status.confirmed || h.txids.includes(tx.txid)) fail();
            state.transactions[tx.txid] = tx; h.txids.push(tx.txid);
          }
          cursor = page.at(-1)!.txid; h.cursor = cursor;
          if (h.txids.length > address.confirmedTxCount) fail();
          if (h.txids.length === address.confirmedTxCount) { h.coveredSince = -1; h.cursor = null; done = true; break; }
          if (page.some(tx => tx.status.block_time! < horizon)) { h.coveredSince = horizon; h.cursor = null; done = true; break; }
          if (page.length < 25) fail();
        }
      }
      if (!done) bounded = true;
    }
  } catch (e) {
    if (!(e instanceof ProviderError) || e.kind !== 'budget_exhausted') throw e;
    bounded = true;
  }
  const settlements: Settlement[] = [];
  let linkingComplete = true;
  const relevant = Object.values(state.transactions).filter(tx => tx.status.confirmed && tx.status.block_time! > horizon);
  for (const commit of relevant) {
    const funding = commitOutputs(commit, scripts);
    if (!funding) continue;
    if (!validFee(commit)) throw new ProviderError(view.provider, 'malformed');
    let reveals = state.reveals[commit.txid];
    try {
      if (!reveals || !reveals.every(frozen)) {
        reveals = [];
        let external = false;
        for (const index of funding) {
          const spend = await view.outspend(commit.txid, index);
          if (!spend.spent) continue;
          const reveal = await view.tx(spend.txid!);
          if (!revealShaped(commit, index, reveal, scripts)) { external = true; break; }
          if (!validFee(reveal)) throw new ProviderError(view.provider, 'malformed');
          reveals.push(reveal);
        }
        if (external) { delete state.reveals[commit.txid]; continue; }
        state.reveals[commit.txid] = reveals;
      }
      // Empty/pending reveals must be retried next run, never frozen as complete.
      if (reveals.length !== funding.length || !reveals.every(r => r.status.confirmed)) delete state.reveals[commit.txid];
      const observation = settlementObservation(commit, reveals, funding.length, scripts);
      if (observation.complete && reveals.some(r => !state.transactions[r.txid])) linkingComplete = false;
      settlements.push(observation);
    } catch (e) {
      if (!(e instanceof ProviderError) || e.kind !== 'budget_exhausted') throw e;
      linkingComplete = false;
    }
  }
  const covered = addresses.filter(a => a.used).every(a => {
    const since = state.addresses[a.address]?.coveredSince;
    return since !== undefined && since !== null && (since === -1 || since <= horizon);
  });
  // Raw state is bounded independently from the 30-day estimator window.
  const retentionHorizon = asOf - cfg.retention.history_days * 86400;
  for (const [id, tx] of Object.entries(state.transactions)) if (tx.status.block_time! < retentionHorizon) {
    delete state.transactions[id]; delete state.reveals[id];
    for (const h of Object.values(state.addresses)) {
      h.txids = h.txids.filter(t => t !== id);
      if (h.coveredSince === -1) h.coveredSince = retentionHorizon;
    }
  }
  return { state, settlements, complete: covered && !bounded && linkingComplete };
}

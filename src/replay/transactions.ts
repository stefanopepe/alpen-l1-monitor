import type { ChainArchive } from './archive.js';
import { deriveOutcomes } from './outcomes.js';
import type { FeeBucket } from '../fees/schema.js';
import { summarizeTransactions } from '../transactions.js';

export function archiveTransactions(archive: ChainArchive, buckets: readonly FeeBucket[] = []) {
  const events = deriveOutcomes(archive);
  return archive.config.wallets.flatMap(wallet => summarizeTransactions(wallet.id, Object.values(archive.transactions),
    archive.addresses.filter(a => a.wallet === wallet.id).map(a => a.script),
    events.filter(e => e.wallet === wallet.id && (e.kind === 'settlement' || e.kind === 'unresolved' || e.revealTxids.length))
      .map(e => ({ commitTxid: e.txid, revealTxids: e.revealTxids, complete: e.kind === 'settlement' })), buckets));
}
